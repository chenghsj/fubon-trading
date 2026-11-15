"""Local execution with atomic, durable fills and frozen order costs."""
from contextlib import contextmanager, nullcontext
from copy import deepcopy
from datetime import timedelta
from decimal import Decimal, ROUND_HALF_UP
import math
import threading
import uuid

from .intraday_strategy import futures_tax
from .mapping import now, stamp

ACTIVE = {"Submitted", "PartFilled", "PendingSubmit", "PreSubmitted"}
INDEX_FUTURES = {'TMF', 'MXF', 'TXF'}


def product(contract):
    code = contract['code']
    return code[:3] if contract['security_type'] == 'FUT' else code


class PaperBook:
    def __init__(self, emit, store=None, *, costs=False, clock=None):
        self.orders, self.positions = {}, {}
        self.emit, self.store, self.costs = emit, store, costs
        self.clock = clock or (lambda: now())
        self.lock = threading.RLock()
        self.events = []
        self.refresh()

    def _dump(self):
        return dict(schema=1, orders=deepcopy(self.orders), positions=[dict(p, account_id=a, code=c) for (a,c),p in self.positions.items()])

    def _load(self, state):
        self.orders = deepcopy(state['orders'])
        self.positions = {(p['account_id'],p['code']):{k:v for k,v in p.items() if k not in {'account_id','code'}} for p in state['positions']}

    def refresh(self):
        with self.lock:
            if self.store:
                self._load(self.store.read())

    @contextmanager
    def _write(self):
        with self.lock:
            previous = self._dump()
            self.events = []
            try:
                with self.store.transaction() if self.store else nullcontext(previous) as state:
                    self._load(state)
                    yield
                    state.update(self._dump())
            except Exception:
                self._load(previous)
                self.events = []
                raise
            events, self.events = self.events, []
        # No notification can precede the transaction containing its fill/position.
        for reason in (['paper_deal'] if 'paper_deal' in events else list(dict.fromkeys(events))):
            try:
                self.emit('fubon_reconcile_required', {'reason': reason})
            except Exception:
                pass  # A notification failure cannot turn a committed fill into a failed submission.

    def _report(self, deal=False):
        self.events.append('paper_deal' if deal else 'paper_order')

    def _policy(self, contract, supplied):
        configured = contract['security_type'] == 'FUT' and product(contract) in INDEX_FUTURES
        if not self.costs:
            return dict(fee_per_side=0, tax_rate=0, fee_source='assumed', configured=False)
        value = supplied or dict(fee_per_side=20 if configured else 0, tax_rate=.00002 if configured else 0, fee_source='assumed')
        return dict(value, configured=configured or supplied is not None)

    def place(self, contract, order, account, quote, *, cost=None, strategy_tag=None, strategy_day=None, session='regular'):
        with self._write():
            if strategy_tag:
                prior = next((t for t in self.orders.values() if t.get('paper',{}).get('strategyTag') == strategy_tag),None)
                if prior:
                    if prior['contract']['code'] != contract['code'] or prior['order']['account'] != account or any(prior['order'].get(k) != order.get(k) for k in ('action','price','quantity','price_type','order_type','octype')):
                        raise ValueError('paper 策略識別碼與原委託內容不符')
                    return deepcopy(prior)
            quantity = order['quantity']
            units = quantity * (1000 if contract['security_type']=='STK' and order.get('order_lot','Common')=='Common' else 1)
            existing = self.positions.get((account['account_id'],contract['code']))
            if order.get('octype') == 'Cover':
                direction = 1 if order['action']=='Buy' else -1
                if not existing or existing['signed_qty']*direction >= 0 or abs(existing['signed_qty']) < units:
                    raise ValueError('模擬平倉口數超過可平倉部位')
            at = self.clock()
            if session == 'afterhours' and contract['security_type'] in {'FUT','OPT'}:
                expiry = at.replace(hour=5,minute=0,second=0,microsecond=0)
                if at.hour >= 6:
                    expiry += timedelta(days=1)
            else:
                expiry = at.replace(hour=13,minute=45 if contract['security_type'] in {'FUT','OPT'} else 30,second=0,microsecond=0)
            ident = 'paper-'+uuid.uuid4().hex
            trade = dict(contract=deepcopy(contract),order=dict(order,id=ident,seqno=ident,ordno=ident,account=account),
                status=dict(id=ident,status='Submitted',status_code='10',order_ts=at.timestamp(),order_quantity=quantity,
                    deal_quantity=0,cancel_quantity=0,modified_price=order['price'],msg='本機模擬，非券商委託',deals=[]),
                paper=dict(cost=self._policy(contract,cost),strategyTag=strategy_tag,strategyDay=strategy_day,expiresAt=expiry.timestamp() if self.costs else None,
                    day=at.date().isoformat(),fee=0,tax=0,realizedGross=0))
            self.orders[ident] = trade
            self._report()
            self._match(trade,quote)
            if trade['status']['status']=='Submitted' and order['order_type'] in {'IOC','FOK'}:
                self._cancel(ident)
            return deepcopy(trade)

    def _match(self, trade, quote):
        if trade['status']['status'] not in ACTIVE:
            return
        expiry = trade.get('paper',{}).get('expiresAt')
        if expiry is not None and expiry <= self.clock().timestamp():
            self._cancel(trade['order']['id'])
            trade['status']['msg'] = '本機模擬委託已逾當次交易時段，未跨日撮合'
            return
        try:
            age = (self.clock()-stamp(quote['datetime'])).total_seconds()
        except (KeyError,ValueError,TypeError):
            return
        if quote.get('is_trial') or age>120 or age < -10:
            return
        order = trade['order']
        buy = order['action']=='Buy'
        price = quote.get('sell_price' if buy else 'buy_price') or quote.get('close',0)
        if not math.isfinite(price) or price<=0 or order['price_type']=='LMT' and (order['price']<price if buy else order['price']>price):
            return
        qty = order['quantity']-trade['status']['cancel_quantity']
        units = qty*(1000 if trade['contract']['security_type']=='STK' and order.get('order_lot','Common')=='Common' else 1)
        key = (order['account']['account_id'],trade['contract']['code'])
        existing = self.positions.get(key)
        if order.get('octype')=='Cover':
            direction = 1 if buy else -1
            if not existing or existing['signed_qty']*direction>=0 or abs(existing['signed_qty'])<units:
                self._cancel(order['id'])
                trade['status']['msg'] = '可平倉部位已變更，模擬平倉委託取消'
                return
        policy = trade.get('paper',{}).get('cost',dict(fee_per_side=0,tax_rate=0))
        multiplier = trade['contract'].get('multiplier',1)
        fee = float((Decimal(str(policy['fee_per_side']))*qty).quantize(Decimal('.01'),rounding=ROUND_HALF_UP))
        tax = qty*futures_tax(price,multiplier,policy['tax_rate'])
        pos = self.positions.setdefault(key,dict(signed_qty=0,price=0,realized=0,contract=trade['contract']))
        signed, old = units if buy else -units,pos['signed_qty']
        realized = 0
        if old*signed>=0:
            pos['price'] = (abs(old)*pos['price']+units*price)/(abs(old)+units)
        else:
            realized = min(abs(old),units)*(price-pos['price'])*(1 if old>0 else -1)*multiplier
            pos['realized'] += realized
            if units>abs(old):
                pos['price'] = price
        pos['signed_qty'] += signed
        trade['status'].update(status='Filled',status_code='50',deal_quantity=qty,
            deals=[dict(seq=uuid.uuid4().hex,price=price,quantity=qty,ts=self.clock().timestamp(),fee=fee,tax=tax)])
        if 'paper' in trade:
            trade['paper'].update(fee=fee,tax=tax,realizedGross=realized,filledDay=self.clock().date().isoformat())
        self._report(deal=True)

    def match(self, trade, quote):
        ident = trade['order']['id']
        with self._write():
            self._match(self.orders[ident],quote)

    def tick(self, code, quote):
        with self._write():
            for trade in self.orders.values():
                if trade['contract']['code']==code:
                    self._match(trade,quote)

    def _cancel(self, ident):
        trade = self.orders[ident]
        if trade['status']['status'] not in ACTIVE:
            raise ValueError('此委託已無可取消數量')
        trade['status'].update(status='Cancelled',status_code='30',cancel_quantity=trade['order']['quantity']-trade['status']['deal_quantity'])
        self._report()
        return deepcopy(trade)

    def cancel(self, ident):
        with self._write():
            return self._cancel(ident)

    def update(self, ident, key, value, quote):
        with self._write():
            trade = self.orders[ident]
            if trade['status']['status'] not in ACTIVE:
                raise ValueError('此委託已無可修改數量')
            remaining = trade['status']['order_quantity']-trade['status']['cancel_quantity']-trade['status']['deal_quantity']
            if key=='quantity' and (value<=0 or value>=remaining):
                raise ValueError('減少量須小於未成交量；全部取消請使用刪單')
            if key=='price':
                trade['order'][key]=value
                trade['status']['modified_price']=value
            else:
                trade['status']['cancel_quantity']+=value
            self._report()
            self._match(trade,quote)
            return deepcopy(trade)

    def order_rows(self, account):
        self.refresh()
        return [deepcopy(t) for t in self.orders.values() if t['order']['account']==account]

    def overview(self, account_id=None, day=None):
        self.refresh()
        trades=[t for t in self.orders.values() if account_id is None or t['order']['account']['account_id']==account_id]
        fills=[t.get('paper',{}) for t in trades if t['status']['deal_quantity'] and (day is None or t.get('paper',{}).get('filledDay')==day)]
        gross=sum(p.get('realizedGross',0) for p in fills)
        fee=sum(p.get('fee',0) for p in fills)
        tax=sum(p.get('tax',0) for p in fills)
        positions=[dict(p,account_id=a,code=c) for (a,c),p in self.positions.items() if p['signed_qty'] and (account_id is None or a==account_id)]
        complete=all(p.get('cost',{}).get('configured',False) for p in fills)
        return dict(persistent=bool(self.store),orders=deepcopy(trades),positions=positions,realizedGross=gross,fee=fee,tax=tax,realizedNet=gross-fee-tax,costsComplete=complete,
            day=day,dateBasis='Asia/Taipei calendar date',initialBalance=1_000_000)

    def position_rows(self, account, quote):
        self.refresh()
        rows=[]
        for (account_id,code),pos in list(self.positions.items()):
            if account_id!=account['account_id'] or not pos['signed_qty']:
                continue
            last=quote(pos['contract'])['close']
            row=dict(id=len(rows),code=code,direction='Buy' if pos['signed_qty']>0 else 'Sell',quantity=abs(pos['signed_qty']),price=pos['price'],last_price=last,
                pnl=(last-pos['price'])*pos['signed_qty']*pos['contract'].get('multiplier',1))
            if pos['contract']['security_type']=='STK':
                row['yd_quantity']=0
            rows.append(row)
        return rows
