"""Narrow paper and official sandbox gateways; production orders remain unavailable."""
from datetime import datetime
import math

from .mapping import stamp


class SandboxGateway:
    allowed_modes = {'sandbox'}
    def __init__(self, broker):
        self.broker = broker

    @property
    def mode(self):
        return self.broker.config.mode

    def prepare(self, config):
        if self.mode not in self.allowed_modes or self.broker.config.session != "regular":
            raise ValueError("策略自動交易僅支援 sandbox 或 paper 日盤")
        self.broker.ready()
        account = self.broker.account(config["account"])
        if account["account_type"] != "F":
            raise ValueError("請選擇期貨測試帳戶")
        key = dict(code=config["contract_code"], security_type="FUT")
        contract = self.broker.contract(key,refresh=True)
        if (contract.get("target_code") or contract.get("security_type") != "FUT"
            or not contract["code"].startswith("TMF") or contract.get("multiplier") != 10
            or not contract.get("delivery_date") or contract["delivery_date"] < config["trade_date"]):
            raise ValueError("請選擇交易日尚未到期的微台具體月份")
        self.broker.subscribe(key, "Tick")
        self.broker.subscribe(key, "BidAsk")
        return contract

    def quote(self, contract):
        value = self.broker.quote(contract)
        return dict(price=value.get("close", 0), bid=value.get("buy_price", 0), ask=value.get("sell_price", 0),
            time=stamp(value["datetime"]).timestamp(), trial=bool(value.get("is_trial")))

    def bars(self, code, day, kind="FUT"):
        raw = self.broker.kbars(dict(code=code, security_type=kind), day, day)
        result = {}
        for i, value in enumerate(raw["datetime"]):
            row = dict(time=int(datetime.fromisoformat(value).timestamp()),
                **{k:float(raw[column][i]) for k,column in (("open","Open"),("high","High"),("low","Low"),("close","Close"),("volume","Volume"))})
            if (not all(math.isfinite(v) for v in row.values()) or row["time"] % 60
                or min(row[k] for k in ("open","high","low","close")) <= 0 or row["volume"] < 0
                or row["high"] < max(row["open"],row["close"]) or row["low"] > min(row["open"],row["close"])):
                raise ValueError("即時分 K 資料無效")
            if row["time"] in result and result[row["time"]] != row:
                raise ValueError("即時分 K 時間衝突")
            result[row["time"]] = row
        return sorted(result.values(), key=lambda b:b["time"])

    def orders(self, config):
        return self.broker.automation_orders(self.broker.account(config["account"]))

    def fill_price(self, config, trade):
        return self.broker.automation_fill_price(self.broker.account(config["account"]), trade, config["trade_date"])

    def submit(self, config, action, limit, role, tag):
        return self.broker.place(dict(code=config["contract_code"], security_type="FUT"),
            dict(action=action, price=limit, quantity=1, price_type="LMT", order_type="IOC", octype="New" if role=="entry" else "Cover"),
            self.broker.account(config["account"]), client_tag=tag)

    def execution_ready(self):
        return self.mode in self.allowed_modes and self.broker.config.session=="regular" and not self.broker.error and "futopt" in self.broker.connected_sockets

    def cancel(self, trade_id, tag):
        return self.broker.mutate(trade_id, "cancel", client_tag=tag)


class PaperGateway(SandboxGateway):
    """Uses market reads only; every execution goes through the durable local book."""
    allowed_modes = {'paper'}

    def prepare(self, config):
        if config['account'] != dict(account_type='F',broker_id='LOCAL',account_id='PAPER-AUTO-F'):
            raise ValueError('paper 策略只能使用獨立的 PAPER-AUTO-F 模擬帳戶')
        self.assert_inventory(config)
        return super().prepare(config)

    def assert_inventory(self, config):
        book=self.broker.paper.overview('PAPER-AUTO-F')
        if any(t['status']['status'] in {'Submitted','PartFilled','PendingSubmit','PreSubmitted'} and
            ((t['paper'].get('strategyDay') or t['paper']['day'])!=config['trade_date'] or t['contract']['code']!=config['contract_code']) for t in book['orders']):
            raise ValueError('策略模擬帳戶仍有其他日期的活動委託，請先核對原策略')
        expected=sum(t['status']['deal_quantity']*(1 if t['order']['action']=='Buy' else -1) for t in book['orders']
            if (t['paper'].get('strategyDay') or t['paper']['day'])==config['trade_date'] and t['contract']['code']==config['contract_code'])
        if any(p['code']!=config['contract_code'] for p in book['positions']) or sum(p['signed_qty'] for p in book['positions'])!=expected:
            raise ValueError('策略模擬帳戶仍有其他日期或未歸屬持倉，請先退出原策略')

    def assert_flat(self, config):
        book=self.broker.paper.overview('PAPER-AUTO-F')
        if book['positions'] or any(t['status']['status'] in {'Submitted','PartFilled','PendingSubmit','PreSubmitted'} for t in book['orders']):
            raise ValueError('paper 策略帳簿仍有持倉或活動委託，不能封存')

    def submit(self, config, action, limit, role, tag):
        if self.mode != 'paper' or self.broker.config.broker_orders:
            raise ValueError('paper 執行環境不符')
        self.assert_inventory(config)
        return self.broker.place(dict(code=config['contract_code'],security_type='FUT'),
            dict(action=action,price=limit,quantity=1,price_type='LMT',order_type='IOC',octype='New' if role=='entry' else 'Cover'),
            self.broker.account(config['account']),client_tag=tag,strategy_day=config['trade_date'],
            paper_cost={k:config[k] for k in ('fee_per_side','tax_rate','fee_source')})
