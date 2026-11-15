"""Narrow gateway for the official sandbox. It does not enable upstream automation."""
from datetime import datetime
import math

from .mapping import stamp


class SandboxGateway:
    def __init__(self, broker):
        self.broker = broker

    @property
    def mode(self):
        return self.broker.config.mode

    def prepare(self, config):
        if self.mode != "sandbox" or self.broker.config.session != "regular":
            raise ValueError("策略自動交易僅支援官方 sandbox 日盤")
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
        return self.mode=="sandbox" and self.broker.config.session=="regular" and not self.broker.error and "futopt" in self.broker.connected_sockets

    def cancel(self, trade_id, tag):
        return self.broker.mutate(trade_id, "cancel", client_tag=tag)
