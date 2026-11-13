"""Process-local paper execution; deliberately never calls the broker order API."""
from copy import deepcopy
import uuid

from .mapping import now, stamp

ACTIVE = {"Submitted", "PartFilled", "PendingSubmit", "PreSubmitted"}


class PaperBook:
    def __init__(self, emit):
        self.orders = {}
        self.positions = {}
        self.emit = emit

    def _report(self, trade, op="New", deal=None):
        # The upstream's Shioaji order callbacks have different quantity and
        # timestamp semantics from REST Trade DTOs. Request a fresh snapshot
        # instead of feeding fabricated Shioaji callbacks into its projection.
        self.emit("fubon_reconcile_required", {"reason": "paper_deal" if deal else "paper_order"})

    def place(self, contract, order, account, quote):
        ident = "paper-" + uuid.uuid4().hex
        quantity = order["quantity"]
        if contract["security_type"] == "STK" and order.get("order_lot", "Common") == "Common":
            position_qty = quantity * 1000
        else:
            position_qty = quantity
        existing = self.positions.get((account["account_id"], contract["code"]))
        if order.get("octype") == "Cover":
            direction = 1 if order["action"] == "Buy" else -1
            if not existing or existing["signed_qty"] * direction >= 0 or abs(existing["signed_qty"]) < position_qty:
                raise ValueError("模擬平倉口數超過可平倉部位")
        trade = dict(contract=deepcopy(contract), order=dict(order, id=ident, seqno=ident,
            ordno=ident, account=account), status=dict(id=ident, status="Submitted", status_code="10",
            order_ts=now().timestamp(), order_quantity=quantity, deal_quantity=0,
            cancel_quantity=0, modified_price=order["price"], msg="本機模擬，非券商委託", deals=[]))
        self.orders[ident] = trade
        self._report(trade)
        self.match(trade, quote)
        if trade["status"]["status"] == "Submitted" and order["order_type"] in {"IOC", "FOK"}:
            self.cancel(ident)
        return deepcopy(trade)

    def match(self, trade, quote):
        if trade["status"]["status"] not in ACTIVE:
            return
        try:
            age = (now() - stamp(quote["datetime"])).total_seconds()
        except (KeyError, ValueError, TypeError):
            return
        if quote.get("is_trial") or age > 120 or age < -10:
            return
        order = trade["order"]
        buy = order["action"] == "Buy"
        price = quote.get("sell_price" if buy else "buy_price") or quote.get("close", 0)
        if price <= 0:
            return
        if order["price_type"] == "LMT" and (order["price"] < price if buy else order["price"] > price):
            return
        qty = order["quantity"] - trade["status"]["cancel_quantity"]
        position_units = qty * (1000 if trade["contract"]["security_type"] == "STK" and order.get("order_lot", "Common") == "Common" else 1)
        if order.get("octype") == "Cover":
            pos = self.positions.get((order["account"]["account_id"], trade["contract"]["code"]))
            direction = 1 if buy else -1
            if not pos or pos["signed_qty"] * direction >= 0 or abs(pos["signed_qty"]) < position_units:
                self.cancel(order["id"])
                trade["status"]["msg"] = "可平倉部位已變更，模擬平倉委託取消"
                return
        trade["status"].update(status="Filled", status_code="50", deal_quantity=qty)
        deal = dict(seq=uuid.uuid4().hex, price=price, quantity=qty, ts=now().timestamp())
        trade["status"]["deals"] = [deal]
        units = qty * (1000 if trade["contract"]["security_type"] == "STK" and order.get("order_lot", "Common") == "Common" else 1)
        key = (order["account"]["account_id"], trade["contract"]["code"])
        pos = self.positions.setdefault(key, dict(signed_qty=0, price=0, realized=0, contract=trade["contract"]))
        signed = units if buy else -units
        old = pos["signed_qty"]
        if old * signed >= 0:
            pos["price"] = (abs(old)*pos["price"] + units*price) / (abs(old)+units)
        else:
            pos["realized"] += min(abs(old), units)*(price-pos["price"])*(1 if old > 0 else -1)*trade["contract"].get("multiplier", 1)
            if units > abs(old):
                pos["price"] = price
        pos["signed_qty"] += signed
        self._report(trade, deal=deal)

    def tick(self, code, quote):
        for trade in list(self.orders.values()):
            if trade["contract"]["code"] == code:
                self.match(trade, quote)

    def cancel(self, ident):
        trade = self.orders[ident]
        if trade["status"]["status"] not in ACTIVE:
            raise ValueError("此委託已無可取消數量")
        trade["status"].update(status="Cancelled", status_code="30",
            cancel_quantity=trade["order"]["quantity"] - trade["status"]["deal_quantity"])
        self._report(trade, "Cancel")
        return deepcopy(trade)

    def update(self, ident, key, value, quote):
        trade = self.orders[ident]
        if trade["status"]["status"] not in ACTIVE:
            raise ValueError("此委託已無可修改數量")
        if key == "quantity" and value > trade["status"]["order_quantity"] - trade["status"]["cancel_quantity"]:
            raise ValueError("改量只支援減量")
        if key == "price":
            trade["order"][key] = value
            trade["status"]["modified_price"] = value
        else:
            trade["status"]["cancel_quantity"] = trade["status"]["order_quantity"] - value
        self._report(trade, "UpdatePrice" if key == "price" else "UpdateQty")
        self.match(trade, quote)
        return deepcopy(trade)

    def position_rows(self, account, quote):
        rows = []
        for (account_id, code), pos in list(self.positions.items()):
            if account_id != account["account_id"] or not pos["signed_qty"]:
                continue
            last = quote(pos["contract"])["close"]
            row = dict(id=len(rows), code=code, direction="Buy" if pos["signed_qty"] > 0 else "Sell",
                quantity=abs(pos["signed_qty"]), price=pos["price"], last_price=last,
                pnl=(last-pos["price"])*pos["signed_qty"]*pos["contract"].get("multiplier", 1))
            if pos["contract"]["security_type"] == "STK":
                row["yd_quantity"] = 0
            rows.append(row)
        return rows
