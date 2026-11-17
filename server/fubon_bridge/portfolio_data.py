"""Portfolio read models. Paper reports use the durable local fill ledger."""
from collections import defaultdict
from datetime import date

from .feature_errors import FeatureUnavailable
from .mapping import enum_name, field, stamp, unwrap
from .market_data import finite


def trading_date(value):
    text = str(value).replace('/', '-')
    if len(text) == 8 and text.isdigit():
        text = text[:4]+'-'+text[4:6]+'-'+text[6:]
    return date.fromisoformat(text)


class PortfolioData:
    def __init__(self, broker):
        self.broker = broker

    def profit_loss(self, account, start, end):
        first, last = trading_date(start), trading_date(end)
        if last < first or (last-first).days > 3660:
            raise ValueError('損益查詢日期區間不正確')
        if not self.broker.config.broker_orders:
            return self._paper(account, first, last)
        if account['account_type'] != 'S':
            raise FeatureUnavailable('富邦期貨平倉紀錄未提供配對開倉價／損益；不能轉成完整歷史損益明細')
        self.broker.ready()
        records = unwrap(self.broker.sdk.accounting.realized_gains_and_loses(self.broker.raw_account(account)))
        result = []
        for i, row in enumerate(records):
            at = trading_date(field(row, 'date'))
            if not first <= at <= last:
                continue
            gain, loss = finite(field(row, 'realized_profit')), finite(field(row, 'realized_loss'))
            qty, price = finite(field(row, 'filled_qty')), finite(field(row, 'filled_price'))
            code = field(row, 'stock_no')
            if not code or None in (gain, loss, qty, price) or qty <= 0 or price <= 0:
                raise ValueError('富邦已實現損益欄位不完整')
            result.append(dict(id=i, code=field(row, 'stock_no'), quantity=qty/1000, pnl=gain-loss,
                               date=at.strftime('%Y%m%d'), dseq='', price=price, pr_ratio=None,
                               cond=enum_name(field(row, 'order_type')), seqno='',
                               source='fubon', coverage='provider-returned-range-unknown'))
        return result

    def _paper(self, account, first, last):
        trades = self.broker.paper.order_rows(account)
        fills = sorted([(deal['ts'], trade, deal) for trade in trades for deal in trade['status'].get('deals', [])], key=lambda row: row[0])
        positions, result = {}, []
        for index, (ts, trade, deal) in enumerate(fills):
            contract, order, cost = trade['contract'], trade['order'], trade.get('paper', {}).get('cost', {})
            if contract.get('currency', 'TWD') != 'TWD':
                raise FeatureUnavailable('Paper 歷史損益尚未支援跨幣別換算')
            code, price = contract['code'], deal['price']
            units = deal['quantity'] * (1000 if contract['security_type'] == 'STK' and order.get('order_lot', 'Common') == 'Common' else 1)
            sign = 1 if order['action'] == 'Buy' else -1
            pos = positions.setdefault(code, dict(qty=0, price=0, fee=0, tax=0, configured=True))
            old = pos['qty']
            fee, tax = deal.get('fee', 0), deal.get('tax', 0)
            configured = cost.get('configured', False)
            if configured and any(finite(deal.get(key)) is None for key in ('fee', 'tax')):
                raise FeatureUnavailable('Paper 已設定成本但成交費稅資料不完整')
            if contract['security_type'] in {'FUT', 'OPT'} and (finite(contract.get('multiplier')) is None or contract['multiplier'] <= 0):
                raise FeatureUnavailable('Paper 期權成交缺少合約乘數，無法計算正確損益')
            if old * sign >= 0:
                pos['price'] = (abs(old)*pos['price'] + units*price)/(abs(old)+units)
                pos.update(qty=old+sign*units, fee=pos['fee']+fee, tax=pos['tax']+tax,
                           configured=pos['configured'] and configured)
                continue
            closed = min(abs(old), units)
            entry_fee, entry_tax = pos['fee']*closed/abs(old), pos['tax']*closed/abs(old)
            exit_fee, exit_tax = fee*closed/units, tax*closed/units
            multiplier = contract.get('multiplier', 1)
            gross = closed*(price-pos['price'])*(1 if old > 0 else -1)*multiplier
            total_fee, total_tax = entry_fee+exit_fee, entry_tax+exit_tax
            entry_amount, cover_amount = closed*pos['price']*multiplier, closed*price*multiplier
            pnl = gross-total_fee-total_tax
            at = stamp(ts*1_000_000).date()
            row = dict(id=index, code=code, quantity=closed/1000 if account['account_type']=='S' else closed,
                       pnl=pnl, date=at.strftime('%Y%m%d'), direction='Buy' if old > 0 else 'Sell',
                       entry_price=pos['price'], cover_price=price, fee=total_fee, tax=total_tax,
                       entry_amount=entry_amount, cover_amount=cover_amount,
                       buy_cost=entry_fee+entry_tax if old > 0 else exit_fee+exit_tax,
                       sell_cost=exit_fee+exit_tax if old > 0 else entry_fee+entry_tax,
                       pr_ratio=pnl/entry_amount*100 if entry_amount else None,
                       price=price, dseq=order['id'], seqno=order['seqno'], cond='Cash', currency='TWD',
                       source='paper', costs_complete=pos['configured'] and configured)
            if first <= at <= last:
                result.append(row)
            pos['qty'] += sign*units
            if units > abs(old):
                pos.update(price=price, fee=fee-exit_fee, tax=tax-exit_tax, configured=configured)
            else:
                pos.update(fee=pos['fee']-entry_fee, tax=pos['tax']-entry_tax)
                if not pos['qty']:
                    pos.update(price=0, fee=0, tax=0, configured=True)
        return result

    def summary(self, account, start, end):
        if self.broker.config.broker_orders:
            raise FeatureUnavailable('富邦彙總來源的日期涵蓋範圍不同；請參考已實現明細，未推造成本或配對資料')
        rows = self.profit_loss(account, start, end)
        grouped = defaultdict(list)
        for row in rows:
            grouped[(row['code'], row['direction'])].append(row)
        summaries = []
        for (code, direction), values in grouped.items():
            qty = sum(row['quantity'] for row in values)
            summaries.append(dict(code=code, direction=direction, quantity=qty,
                                  pnl=sum(row['pnl'] for row in values), fee=sum(row['fee'] for row in values),
                                  tax=sum(row['tax'] for row in values), currency='TWD', cond='Cash',
                                  entry_price=sum(row['entry_price']*row['quantity'] for row in values)/qty,
                                  cover_price=sum(row['cover_price']*row['quantity'] for row in values)/qty,
                                  pr_ratio=sum(row['pnl'] for row in values)/sum(row['entry_amount'] for row in values)*100,
                                  entry_cost=sum(row['entry_amount'] for row in values),
                                  cover_cost=sum(row['cover_amount'] for row in values),
                                  buy_cost=sum(row['buy_cost'] for row in values), sell_cost=sum(row['sell_cost'] for row in values)))
        total = dict(entry_amount=sum(row['entry_amount'] for row in rows), cover_amount=sum(row['cover_amount'] for row in rows),
                     quantity=sum(row['quantity'] for row in rows), buy_cost=sum(row['buy_cost'] for row in rows),
                     sell_cost=sum(row['sell_cost'] for row in rows), pnl=sum(row['pnl'] for row in rows), pr_ratio=0)
        if total['entry_amount']:
            total['pr_ratio'] = total['pnl']/total['entry_amount']*100
        return dict(profitloss_sum=summaries, total=total, source='paper',
                    costs_complete=all(row['costs_complete'] for row in rows))

    def settlements(self, account):
        if account['account_type'] != 'S':
            raise ValueError('交割查詢需選擇證券帳戶')
        if not self.broker.config.broker_orders:
            return []  # The UI explicitly describes Paper as having no bank settlement.
        raise FeatureUnavailable('富邦交割明細尚未轉接為銀行交割行事曆，請至券商查詢')
