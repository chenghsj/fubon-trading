"""Fubon 2.5 wire mappings. The browser retains the upstream terminal's DTOs."""
from datetime import datetime, timezone, timedelta
import math
import re

TAIPEI = timezone(timedelta(hours=8))


def now():
    return datetime.now(TAIPEI)


def field(obj, key, default=None):
    value = obj.get(key, default) if isinstance(obj, dict) else getattr(obj, key, default)
    return default if value is None else value


def number(value, default=0):
    try:
        result = float(value)
        return result if math.isfinite(result) else default
    except (ValueError, TypeError):
        return default


def enum_name(value):
    return str(value).rsplit(".", 1)[-1]


def unwrap(result):
    if not field(result, "is_success", False):
        raise ValueError(field(result, "message", "富邦 API 請求失敗"))
    return field(result, "data")


def stamp(value):
    if isinstance(value, (int, float)):
        # Fubon market-data timestamps are microseconds since the epoch.
        return datetime.fromtimestamp(value / 1_000_000, TAIPEI)
    return datetime.fromisoformat(str(value).replace("Z", "+00:00")).astimezone(TAIPEI)


def symbol_alias(code):
    match = re.fullmatch(r"([A-Z]+)R([123])", code)
    if match:
        root = {"MTX": "MXF"}.get(match[1], match[1])
        return f"{root}{match[2]}!"
    return code


def contract_from_ticker(row, security_type):
    code = row["symbol"]
    prefix = re.match(r"[A-Z]+", code)
    root = prefix.group() if prefix else code
    # Concrete futures end in a month letter and year digit.
    if security_type == "FUT" and re.fullmatch(r"[A-Z]+[A-L]\d", code):
        root = code[:-2]
    return dict(
        code=code, name=row.get("name", code), security_type=security_type,
        region="TW", exchange="TAIFEX" if security_type in {"FUT", "OPT"} else row.get("market", {"TWSE": "TSE", "TPEx": "OTC"}.get(row.get("exchange"), row.get("exchange", "TSE"))),
        target_code=None, currency="TWD", root=root,
        reference=number(row.get("referencePrice")),
        limit_up=number(row.get("limitUpPrice")), limit_down=number(row.get("limitDownPrice")),
        day_trade=("Yes" if row.get("canDayTrade") else "OnlyBuy" if row.get("canBuyDayTrade") else "No") if security_type == "STK" else "Yes",
        update_date=now().date().isoformat(), category="",
        margin_trading_balance=0, short_selling_balance=0,
        delivery_date=row.get("settlementDate", row.get("endDate", "")),
        delivery_month=str(row.get("settlementDate", ""))[:7].replace("-", ""),
        **({"multiplier": {"TXF": 200, "MXF": 50, "TMF": 10}.get(root, 1),
            "tick": 1, "tick_rule": "index"} if root in {"TXF", "MXF", "TMF"} else {}),
    )


def snapshot(quote, code):
    trade = quote.get("lastTrade", {})
    total = quote.get("total", {})
    value = number(quote.get("lastPrice", quote.get("closePrice", trade.get("price"))))
    return dict(
        code=code, exchange=quote.get("exchange", "TAIFEX"),
        datetime=stamp(trade.get("time", quote.get("lastUpdated", 0))).isoformat(),
        is_trial=bool(quote.get("isTrial", False)),
        reference=number(quote.get("previousClose")),
        open=number(quote.get("openPrice")), high=number(quote.get("highPrice")),
        low=number(quote.get("lowPrice")), close=value,
        average_price=number(quote.get("avgPrice", value)),
        buy_price=number(trade.get("bid")), sell_price=number(trade.get("ask")),
        buy_volume=0, sell_volume=0, volume=number(trade.get("size", quote.get("lastSize"))),
        total_volume=number(total.get("tradeVolume")), amount=0, total_amount=number(total.get("tradeValue")),
        change_price=number(quote.get("change")), change_rate=number(quote.get("changePercent")),
        change_type="", tick_type="0", volume_ratio=0, yesterday_volume=0,
    )


def market_events(channel, data, requested_code, previous=None):
    """Yield terminal SSE frames. Trial matching is marked, never treated as a fill."""
    at = stamp(data.get("time", int(now().timestamp()*1e6)))
    base = dict(code=requested_code, date=at.date().isoformat(), time=at.strftime("%H:%M:%S.%f"),
                simtrade=bool(data.get("isTrial", False)))
    suffix = "stk" if data.get("type") in {"EQUITY", "STOCK"} else "fop"
    if channel == "books":
        yield f"bidask_{suffix}", dict(base,
            bid_price=[str(x["price"]) for x in data.get("bids", [])],
            bid_volume=[int(x["size"]) for x in data.get("bids", [])],
            ask_price=[str(x["price"]) for x in data.get("asks", [])],
            ask_volume=[int(x["size"]) for x in data.get("asks", [])])
    elif channel == "trades":
        previous = previous or {}
        for trade in data.get("trades", []):
            price = trade.get("price", 0)
            if number(price) <= 0:
                continue
            yield f"tick_{suffix}", dict(base, close=str(price),
                open=str(previous.get("open", price)), high=str(max(number(previous.get("high", price)), number(price))),
                low=str(min(number(previous.get("low", price), number(price)) or number(price), number(price))),
                avg_price=str(price), volume=int(trade.get("size", 0)),
                total_volume=int(data.get("total", {}).get("tradeVolume", 0)), tick_type=0,
                price_chg=str(number(price)-number(previous.get("reference", price))), pct_chg="0")


def normalize_trade(row, contract, account, trade_id=None):
    futures = account["account_type"] == "F"
    qty = int(field(row, "lot" if futures else "quantity", 0))
    effective = int(field(row, "after_lot" if futures else "after_qty", qty))
    filled = int(field(row, "filled_lot" if futures else "filled_qty", 0))
    divisor = 1
    market_type = enum_name(field(row, "market_type", "Common"))
    lot_type = "Common" if market_type == "Common" else market_type
    if not futures and lot_type == "Common":
        divisor = 1000
    qty, effective, filled = qty/divisor, effective/divisor, filled/divisor
    status = int(field(row, "status", 0))
    active_status = "PartFilled" if filled else "Submitted"
    name = {0: "PreSubmitted", 4: "PendingSubmit", 8: "PendingSubmit", 9: "PendingSubmit",
            10: active_status, 19: active_status, 29: active_status, 39: active_status,
            30: "Cancelled", 40: "Cancelled", 50: "Filled", 90: "Failed"}.get(status, "PendingSubmit")
    order_no, seq = str(field(row, "order_no", "")), str(field(row, "seq_no", ""))
    date = str(field(row, "date", now().date().isoformat()))
    ident = trade_id or f'{account["broker_id"]}:{account["account_id"]}:{date}:{seq or order_no}'
    price_type = enum_name(field(row, "price_type", "Limit"))
    return dict(contract=contract, order=dict(
        id=ident, seqno=seq, ordno=order_no, action=enum_name(field(row, "buy_sell", "Buy")),
        price=number(field(row, "price", 0)), quantity=qty,
        order_type=enum_name(field(row, "time_in_force", "ROD")),
        price_type={"Limit": "LMT", "Market": "MKT", "RangeMarket": "MKP"}.get(price_type, price_type),
        octype={"Close": "Cover", "FdayTrade": "DayTrade", "New": "New", "Auto": "Auto"}.get(enum_name(field(row, "order_type", "Auto")), "Auto"),
        order_lot=lot_type if not futures else "Common", account=account, custom_field=str(field(row, "user_def", ""))),
        status=dict(id=ident, status=name, status_code=str(status), order_ts=now().timestamp(),
            order_quantity=qty, deal_quantity=filled, cancel_quantity=max(0, qty-filled) if status in {30, 40} else max(0, qty-max(effective, filled)),
            modified_price=number(field(row, "after_price", field(row, "price", 0))),
            msg=field(row, "error_message", ""), deals=[]))
