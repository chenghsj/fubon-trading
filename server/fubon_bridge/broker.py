from copy import deepcopy
from datetime import date, datetime, timedelta
import json
import math
import re
import threading
import uuid

from .config import Config
from .mapping import (TAIPEI, contract_from_ticker, enum_name, field, market_events,
                      normalize_trade, now, number, snapshot, stamp, symbol_alias, unwrap)
from .paper import ACTIVE, PaperBook


class Broker:
    def __init__(self, config: Config, emit=lambda *_: None, sdk_factory=None):
        self.config = config
        self.emit = emit
        self.sdk_factory = sdk_factory
        self.sdk = None
        self.lock = threading.RLock()
        self.accounts_raw = {}
        self.catalog = {}
        self.catalog_loaded = set()
        self.catalog_full = set()
        self.quotes = {}
        self.raw_orders = {}
        self.trades = {}
        self.cache_health = {}
        self.baseline_ids = {}
        self.subscriptions = {}
        self.sockets = {}
        self.connected_sockets = set()
        self.error = None
        self.paper = PaperBook(emit)
        self.instance_id = uuid.uuid4().hex
        if config.mode == "demo":
            self._demo_catalog()

    def connect(self):
        if self.config.mode == "demo":
            return
        try:
            cfg = self.config.with_credentials()
            self.config = cfg
            if not all((cfg.personal_id, cfg.api_key, cfg.cert_path, cfg.cert_password)):
                self.error = "尚未設定富邦登入資料；請執行 pnpm credentials set 儲存至 Keychain 後重啟服務"
                return
            if self.sdk_factory:
                self.sdk = self.sdk_factory()
            else:
                from fubon_neo.sdk import FubonSDK
                self.sdk = FubonSDK()
            accounts = unwrap(self.sdk.apikey_login(cfg.personal_id, cfg.api_key, cfg.cert_path, cfg.cert_password))
            for account in accounts:
                kind = "F" if field(account, "account_type") == "futopt" else "S"
                key = (kind, str(field(account, "branch_no")), str(field(account, "account")))
                self.accounts_raw[key] = account
            if not self.accounts_raw:
                raise ValueError("登入未回傳可用帳戶")
            self.sdk.init_realtime()
            # Fills invalidate the baseline even when a callback has too little
            # data to safely reconstruct a Trade. Never invent a Filled row.
            self.sdk.set_on_futopt_order(self._on_order)
            self.sdk.set_on_order(self._on_order)
            self.sdk.set_on_futopt_filled(self._on_fill)
            self.sdk.set_on_filled(self._on_fill)
            self.sdk.set_on_order_futopt_changed(self._on_order)
            self.sdk.set_on_order_changed(self._on_order)
            self.sdk.set_on_event(self._on_sdk_event)
        except Exception:
            # SDK errors can contain identity/certificate details. Keep them out
            # of browser responses and logs; diagnose login locally with the SDK.
            self.error = "富邦登入或行情初始化失敗；請檢查 SDK、API 權限及憑證設定"
            self.close()

    def close(self):
        for socket in self.sockets.values():
            try:
                socket.disconnect()
            except Exception:
                pass
        self.connected_sockets.clear()
        if self.sdk:
            self.sdk.shutdown()
        self.sdk = None

    def ready(self):
        if self.config.mode != "demo" and (self.error or not self.sdk):
            raise ValueError(self.error or "富邦尚未連線")

    def market_connected(self):
        if self.config.mode == "demo":
            return True
        needed = {sub["kind"] for sub in list(self.subscriptions.values())}
        return bool(needed) and needed.issubset(self.connected_sockets)

    def account_rows(self):
        if self.config.mode != "live":
            return [dict(account_type=kind, broker_id="LOCAL", account_id=f"{self.config.mode.upper()}-{kind}",
                person_id="", username="展示模擬帳戶" if self.config.mode == "demo" else "富邦行情／本機模擬帳戶",
                signed=self.config.mode == "demo" or bool(self.sdk and not self.error)) for kind in ("F", "S")]
        return [dict(account_type=kind, broker_id=branch, account_id=account_id,
                person_id="", username=field(raw, "name", "富邦帳戶"), signed=True)
                for (kind, branch, account_id), raw in self.accounts_raw.items()]

    def account(self, selector):
        keys = ("account_type", "broker_id", "account_id")
        selected = [a for a in self.account_rows() if all(str(selector.get(k, "")) == str(a[k]) for k in keys)]
        if len(selected) != 1:
            raise ValueError("請選擇本服務目前環境的明確帳戶")
        if not selected[0]["signed"]:
            raise ValueError("富邦尚未連線，帳戶不可交易")
        return selected[0]

    def raw_account(self, account):
        return self.accounts_raw[(account["account_type"], account["broker_id"], account["account_id"])]

    def _client(self, security_type):
        self.ready()
        return self.sdk.marketdata.rest_client.stock if security_type == "STK" else self.sdk.marketdata.rest_client.futopt

    def _session_args(self, kind, listing=False):
        if kind == "STK":
            return {}
        if listing:
            return {"session": "AFTERHOURS" if self.config.session == "afterhours" else "REGULAR"}
        return {"session": "afterhours"} if self.config.session == "afterhours" else {}

    def _demo_catalog(self):
        at = now()
        # Synthetic instruments use explicit DEMO names, never exchange quotes.
        month = at.month
        year = at.year
        for root, name, multiplier in [("TXF", "臺指期", 200), ("MXF", "小臺指", 50), ("TMF", "微型臺指", 10)]:
            code = f'{root}{"ABCDEFGHIJKL"[month-1]}{year%10}'
            row = contract_from_ticker(dict(symbol=code, name=f"{name}（展示資料）", referencePrice=25000,
                limitUpPrice=27500, limitDownPrice=22500,
                settlementDate=f"{year}-{month:02d}-28"), "FUT")
            row["multiplier"] = multiplier
            self.catalog[code] = row
            self.catalog[root+"R1"] = dict(row, code=root+"R1", target_code=code)
            self.catalog[root+"1!"] = dict(row, code=root+"1!", target_code=code)
        for code, name, price in [("2330", "台積電", 1000), ("2881", "富邦金", 80), ("0050", "元大台灣50", 50)]:
            self.catalog[code] = contract_from_ticker(dict(symbol=code, name=f"{name}（展示資料）",
                referencePrice=price, limitUpPrice=price*1.1, limitDownPrice=price*0.9), "STK")

    def contracts(self, kind):
        if kind not in {"STK", "FUT", "OPT"}:
            return []
        if self.config.mode == "demo":
            return [deepcopy(x) for x in self.catalog.values() if x["security_type"] == kind and not x.get("target_code")]
        with self.lock:
            if kind not in self.catalog_loaded:
                client = self._client(kind)
                if kind == "STK":
                    for market in ("TSE", "OTC"):
                        rows = client.intraday.tickers(type="EQUITY", market=market).get("data", [])
                        for row in rows:
                            self.catalog[row["symbol"]] = contract_from_ticker(dict(row, exchange=market), kind)
                else:
                    rows = client.intraday.tickers(type="FUTURE" if kind == "FUT" else "OPTION",
                        exchange="TAIFEX", **self._session_args(kind, True)).get("data", [])
                    for row in rows:
                        if not row.get("isSpread"):
                            self.catalog[row["symbol"]] = contract_from_ticker(row, kind)
                self.catalog_loaded.add(kind)
            return [deepcopy(x) for x in self.catalog.values() if x["security_type"] == kind and not x.get("target_code")]

    def contract(self, key):
        code = key["code"].strip().upper()
        kind = key.get("security_type")
        if not re.fullmatch(r"[A-Z0-9!]{2,24}", code):
            raise ValueError("無效商品代碼")
        if kind is None:
            kind = "STK" if code.isdigit() else "FUT"
        if kind not in {"STK", "FUT", "OPT"}:
            raise ValueError("此富邦轉接器支援股票、期貨與選擇權行情")
        with self.lock:
            cached = self.catalog.get(code)
            if cached and not cached.get("target_code") and (self.config.mode == "demo" or code in self.catalog_full):
                if cached["security_type"] != kind:
                    raise ValueError("商品類型不符")
                return deepcopy(cached)
            if self.config.mode == "demo":
                if cached:
                    return deepcopy(cached)
                raise ValueError("展示模式僅提供自選清單中的展示商品")
            # Resolve aliases from Fubon, never trust a client-supplied target.
            row = self._client(kind).intraday.ticker(symbol=symbol_alias(code), **self._session_args(kind))
            info = contract_from_ticker(row, kind)
            if row.get("settleDate"):
                info["delivery_month"] = row["settleDate"].replace("-", "")
            self.catalog[info["code"]] = info
            self.catalog_full.add(info["code"])
            if info["code"] != code:
                info = dict(info, code=code, target_code=info["code"])
            self.catalog[code] = info
            return deepcopy(info)

    def quote(self, contract):
        with self.lock:
            if self.config.mode == "demo":
                ref = contract["reference"]
                step = .01 if ref < 100 else .5 if contract["security_type"] == "STK" else 1
                value = round((ref + math.sin(now().timestamp()/15)*step*15)/step)*step
                return dict(code=contract["code"], exchange=contract["exchange"], datetime=now().isoformat(),
                    reference=ref,
                    open=ref, high=ref+step*20, low=ref-step*20, close=value, average_price=ref,
                    buy_price=value-step, sell_price=value+step, buy_volume=10, sell_volume=10,
                    volume=1, total_volume=1000, amount=0, total_amount=0, change_price=value-ref,
                    change_rate=(value-ref)/ref*100, change_type="", tick_type="0", volume_ratio=0, yesterday_volume=0)
            row = self._client(contract["security_type"]).intraday.quote(
                symbol=contract.get("target_code") or contract["code"], **self._session_args(contract["security_type"]))
            result = snapshot(row, contract["code"])
            self.quotes[contract["code"]] = result
            return result

    def kbars(self, key, start, end):
        contract = self.contract(key)
        start_date, end_date = date.fromisoformat(start), date.fromisoformat(end)
        if end_date < start_date or (end_date-start_date).days > 365:
            raise ValueError("歷史資料區間須為 0–365 天")
        result = dict(datetime=[], Open=[], High=[], Low=[], Close=[], Volume=[], Amount=[])
        if self.config.mode == "demo":
            # Synthetic one-minute candles. No real calendar/performance claims.
            for day in range((end_date-start_date).days+1):
                current = start_date+timedelta(days=day)
                if current.weekday() >= 5:
                    continue
                for minute in range(300):
                    at = datetime.combine(current, datetime.min.time(), TAIPEI)+timedelta(hours=8, minutes=45+minute)
                    if at > now():
                        break
                    price = contract["reference"] + round(math.sin(at.timestamp()/300)*10)
                    result["datetime"].append((at+timedelta(minutes=1)).isoformat())
                    for column, value in [("Open", price), ("High", price+2), ("Low", price-2), ("Close", price+1), ("Volume", 10), ("Amount", 0)]:
                        result[column].append(value)
            return result
        with self.lock:
            kind = contract["security_type"]
            client = self._client(kind)
            # Current day becomes available on the history endpoint only after
            # the broker's publishing time. Use intraday candles for today.
            history_end = min(end_date, now().date()-timedelta(days=1))
            rows = []
            if start_date <= history_end:
                if kind == "STK":
                    params = dict(symbol=contract["code"], **{"from": start, "to": history_end.isoformat()}, timeframe="1", sort="asc")
                else:
                    resolved = contract.get("target_code") or contract["code"]
                    match = re.fullmatch(r"([A-Z]+)([A-L])(\d)", resolved)
                    if not match:
                        raise ValueError("此商品尚未支援歷史分 K 轉換")
                    root, month, digit = match.groups()
                    # Derive decade from the authoritative expiry metadata.
                    expiry_year = contract.get("delivery_date", "")[:4]
                    year = int(expiry_year) if expiry_year.isdigit() else now().year//10*10+int(digit)
                    alias = symbol_alias(contract["code"])
                    continuous = re.fullmatch(r"([A-Z]+)([123]!)", alias)
                    if continuous:
                        root, contract_month = continuous.groups()
                    else:
                        contract_month = f'{year}{"ABCDEFGHIJKL".index(month)+1:02d}'
                    params = dict(product=root, contractMonth=contract_month,
                                  timeframe="1", **{"from": start, "to": history_end.isoformat()}, sort="asc",
                                  **self._session_args(kind))
                try:
                    rows += client.historical.candles(**params).get("data", [])
                except Exception as error:
                    if getattr(error, "status_code", None) != 404:
                        raise
            if end_date >= now().date():
                rows += client.intraday.candles(symbol=contract.get("target_code") or contract["code"], timeframe="1", sort="asc", **self._session_args(kind)).get("data", [])
            for row in sorted({r["date"]: r for r in rows}.values(), key=lambda r: r["date"]):
                if any(row.get(k) is None for k in ("open", "high", "low", "close")):
                    continue
                # Fubon labels the minute's start, while the terminal's
                # aggregation and tick path use the minute's close label.
                result["datetime"].append((stamp(row["date"])+timedelta(minutes=1)).isoformat())
                for column in ("Open", "High", "Low", "Close", "Volume"):
                    result[column].append(number(row.get(column.lower())))
                result["Amount"].append(0)
        return result

    def ticks(self, key, requested_date, count=500):
        contract = self.contract(key)
        result = dict(datetime=[], close=[], volume=[], bid_price=[], bid_volume=[], ask_price=[], ask_volume=[], tick_type=[])
        if requested_date != now().date().isoformat():
            raise ValueError("富邦此介接的逐筆查詢僅支援當日；歷史分析請使用分 K")
        if self.config.mode == "demo":
            q = self.quote(contract)
            rows = [dict(price=q["close"], size=1, bid=q["buy_price"], ask=q["sell_price"], time=int(now().timestamp()*1e6))]
        else:
            rows = self._client(contract["security_type"]).intraday.trades(symbol=contract.get("target_code") or contract["code"], limit=min(count, 500), **self._session_args(contract["security_type"])).get("data", [])
        for row in reversed(rows):
            result["datetime"].append(stamp(row["time"]).isoformat())
            for key_, value in [("close", row.get("price", 0)), ("volume", row.get("size", 0)),
                    ("bid_price", row.get("bid", 0)), ("ask_price", row.get("ask", 0)),
                    ("bid_volume", 0), ("ask_volume", 0), ("tick_type", 0)]:
                result[key_].append(value)
        return result

    def _on_sdk_event(self, *args):
        # Account connection events require manual re-establishment rather than
        # silently keeping a trading session marked healthy.
        for key in self.cache_health:
            self.cache_health[key] = False

    def _on_fill(self, *args):
        for key in self.cache_health:
            self.cache_health[key] = False
        # The terminal consumes this event to request authoritative reconciliation.
        self.emit("fubon_reconcile_required", {"reason": "broker_fill"})

    def _row_contract(self, row, account):
        if account["account_type"] == "S":
            return self.contract(dict(code=str(field(row, "stock_no", field(row, "symbol", ""))), security_type="STK"))
        symbol = self.sdk.futopt.convert_symbol(field(row, "symbol"), str(field(row, "expiry_date")),
            **({"strike_price": field(row, "strike_price"), "call_put": field(row, "call_put")} if field(row, "asset_type", field(row, "position_kind", 1)) == 2 else {}))
        return self.contract(dict(code=symbol, security_type="OPT" if field(row, "asset_type", field(row, "position_kind", 1)) == 2 else "FUT"))

    def _on_order(self, error, row):
        for key in self.cache_health:
            self.cache_health[key] = False
        self.emit("fubon_reconcile_required", {"reason": "broker_order"})

    def subscribe(self, key, quote_type):
        self.ready()
        contract = self.contract(key)
        if quote_type not in {"Tick", "BidAsk"}:
            raise ValueError("此介接僅支援 Tick 與 BidAsk 訂閱")
        channel = "trades" if quote_type == "Tick" else "books"
        with self.lock:
            registry_key = (contract["code"], quote_type)
            kind = "stock" if contract["security_type"] == "STK" else "futopt"
            if registry_key in self.subscriptions:
                if self.config.mode != "demo" and kind not in self.connected_sockets:
                    socket = self.sockets.get(kind)
                    if not socket:
                        self.subscriptions.pop(registry_key, None)
                    else:
                        socket.disconnect()
                        socket.connect()
                        replayed = set()
                        for sub in self.subscriptions.values():
                            if sub["kind"] != kind:
                                continue
                            symbol = sub["contract"].get("target_code") or sub["contract"]["code"]
                            if (sub["channel"], symbol) in replayed:
                                continue
                            params = dict(channel=sub["channel"], symbol=symbol)
                            if kind == "futopt":
                                params["afterHours"] = self.config.session == "afterhours"
                            socket.subscribe(params)
                            replayed.add((sub["channel"], symbol))
                        self.connected_sockets.add(kind)
                return
            self.subscriptions[registry_key] = dict(contract=contract, channel=channel, kind=kind)
            if self.config.mode == "demo":
                return
            self.ready()
            if kind not in self.sockets:
                socket = getattr(self.sdk.marketdata.websocket_client, kind)
                self.sockets[kind] = socket
                socket.on("message", lambda raw, k=kind: self._on_market(k, raw))
                socket.on("disconnect", lambda *_, k=kind: self.connected_sockets.discard(k))
                socket.on("error", lambda *_, k=kind: self.connected_sockets.discard(k))
                socket.connect()
                self.connected_sockets.add(kind)
            args = dict(channel=channel, symbol=contract.get("target_code") or contract["code"])
            if kind == "futopt":
                args["afterHours"] = self.config.session == "afterhours"
            try:
                self.sockets[kind].subscribe(args)
            except Exception:
                self.subscriptions.pop(registry_key, None)
                raise

    def unsubscribe(self, key, quote_type):
        # Upstream panels share process-level subscriptions. Retain until the
        # bridge restarts so one panel/window cannot unsubscribe another's feed.
        pass

    def _on_market(self, kind, raw):
        try:
            message = json.loads(raw) if isinstance(raw, str) else raw
            if message.get("event") not in {"data", "snapshot"}:
                return
            channel, data = message.get("channel"), message.get("data", {})
            with self.lock:
                for subscription in list(self.subscriptions.values()):
                    contract = subscription["contract"]
                    if subscription["kind"] != kind or subscription["channel"] != channel or data.get("symbol") != (contract.get("target_code") or contract["code"]):
                        continue
                    enriched = dict(data, type="EQUITY" if kind == "stock" else "FUTURE")
                    for event, payload in market_events(channel, enriched, contract["code"], self.quotes.get(contract["code"], contract)):
                        self.emit(event, payload)
                    if channel == "trades" and not data.get("isTrial") and data.get("trades"):
                        price = number(data["trades"][-1].get("price"))
                        if price > 0:
                            self.quotes[contract["code"]] = dict(self.quotes.get(contract["code"], {}), close=price,
                                datetime=stamp(data["time"]).isoformat(), is_trial=False,
                                buy_price=number(data["trades"][-1].get("bid")), sell_price=number(data["trades"][-1].get("ask")))
                            if self.config.mode == "paper":
                                self.paper.tick(contract["code"], self.quotes[contract["code"]])
                                if contract.get("target_code"):
                                    self.paper.tick(contract["target_code"], self.quotes[contract["code"]])
        except Exception:
            self.emit("fubon_reconcile_required", {"reason": "market_mapping_error"})

    def demo_events(self):
        if self.config.mode != "demo":
            return
        with self.lock:
            for sub in list(self.subscriptions.values()):
                contract = sub["contract"]
                q = self.quote(contract)
                data = dict(symbol=contract["code"], type="EQUITY" if contract["security_type"] == "STK" else "FUTURE",
                    time=int(now().timestamp()*1e6), trades=[dict(price=q["close"], size=1)], total=dict(tradeVolume=1000),
                    bids=[dict(price=q["buy_price"]-i, size=10+i) for i in range(5)],
                    asks=[dict(price=q["sell_price"]+i, size=10+i) for i in range(5)])
                for event, payload in market_events(sub["channel"], data, contract["code"], q):
                    self.emit(event, payload)
                self.paper.tick(contract["code"], q)
                if contract.get("target_code"):
                    self.paper.tick(contract["target_code"], q)

    def _remember(self, row, contract, account):
        trade = normalize_trade(row, contract, account)
        ident = trade["order"]["id"]
        self.raw_orders[ident] = row
        self.trades[ident] = trade
        return deepcopy(trade)

    def order_list(self, account, refresh=True):
        if self.config.mode != "live":
            return [deepcopy(t) for t in self.paper.orders.values() if t["order"]["account"] == account]
        with self.lock:
            if refresh:
                raw_account = self.raw_account(account)
                client = self.sdk.futopt if account["account_type"] == "F" else self.sdk.stock
                rows = unwrap(client.get_order_results(raw_account)) or []
                seen = set()
                # Rebuild one account only; a missing broker order is not a cancellation.
                for row in rows:
                    trade = self._remember(row, self._row_contract(row, account), account)
                    seen.add(trade["order"]["id"])
                self.baseline_ids[(account["account_type"], account["broker_id"], account["account_id"])] = seen
                self.cache_health[account["account_id"]] = True
            return [deepcopy(t) for t in self.trades.values() if t["order"]["account"] == account]

    def place(self, contract_key, order, account):
        with self.lock:
            self.ready()
            contract = self.contract(contract_key)
            kind = contract["security_type"]
            if account["account_type"] != ("S" if kind == "STK" else "F"):
                raise ValueError("商品與帳戶類型不符")
            # Never let an alias or browser-provided target choose a real order.
            if contract.get("target_code") or "!" in contract["code"] or re.search(r"R[123]$", contract["code"]):
                raise ValueError("請選擇具體月份合約下單，連續月代碼僅供看盤")
            if self.config.mode != "live":
                return self.paper.place(contract, order, account, self.quote(contract))
            if not self.config.live_enabled:
                raise ValueError("正式下單未啟用")
            socket_kind = "stock" if kind == "STK" else "futopt"
            if socket_kind not in self.connected_sockets:
                raise ValueError("富邦即時行情未連線，拒絕新增正式委託；既有委託仍可查詢與取消")
            from fubon_neo.sdk import FutOptOrder, Order
            from fubon_neo.constant import BSAction, TimeInForce, FutOptMarketType, FutOptPriceType, FutOptOrderType, MarketType, PriceType, OrderType
            shared = dict(buy_sell=getattr(BSAction, order["action"]), symbol=contract["code"],
                          time_in_force=getattr(TimeInForce, order["order_type"]), price=str(order["price"]), user_def="FubonWeb")
            if kind == "STK":
                lot = order.get("order_lot", "Common")
                if lot not in {"Common", "IntradayOdd", "Odd"} or order.get("order_cond", "Cash") != "Cash" or order.get("daytrade_short", False):
                    raise ValueError("目前股票下單只支援現股整股與零股，不支援信用或先賣當沖")
                obj = Order(**shared, quantity=order["quantity"]*(1000 if lot == "Common" else 1),
                    market_type=getattr(MarketType, {"Common": "Common", "IntradayOdd": "IntradayOdd", "Odd": "Odd"}[lot]),
                    price_type=getattr(PriceType, {"LMT": "Limit", "MKT": "Market"}[order["price_type"]]), order_type=OrderType.Stock)
                row = unwrap(self.sdk.stock.place_order(self.raw_account(account), obj))
            else:
                market = "Option" if kind == "OPT" else "Future"
                if self.config.session == "afterhours":
                    market += "Night"
                obj = FutOptOrder(**shared, lot=order["quantity"], market_type=getattr(FutOptMarketType, market),
                    price_type=getattr(FutOptPriceType, {"LMT": "Limit", "MKT": "Market", "MKP": "RangeMarket"}[order["price_type"]]),
                    order_type=getattr(FutOptOrderType, {"New": "New", "Cover": "Close", "Auto": "Auto", "DayTrade": "FdayTrade"}[order.get("octype", "Auto")]))
                row = unwrap(self.sdk.futopt.place_order(self.raw_account(account), obj))
            return self._remember(row, contract, account)

    def mutate(self, ident, action, value=None):
        with self.lock:
            if self.config.mode != "live":
                trade = self.paper.orders.get(ident)
                if not trade:
                    raise ValueError("找不到本服務的委託")
                if action == "cancel":
                    return self.paper.cancel(ident)
                return self.paper.update(ident, "price" if action == "price" else "quantity", value, self.quote(trade["contract"]))
            self.ready()
            if not self.config.live_enabled:
                raise ValueError("正式改刪單未啟用")
            trade = self.trades.get(ident)
            if not trade:
                raise ValueError("請先重新整理委託，無法辨識此委託")
            account = self.account(trade["order"]["account"])
            self.order_list(account, refresh=True)
            if ident not in self.baseline_ids.get((account["account_type"], account["broker_id"], account["account_id"]), set()):
                raise ValueError("最新券商委託查詢未包含此單，拒絕使用舊快取改刪單")
            current = self.trades[ident]
            if current["status"]["status"] not in ACTIVE:
                raise ValueError("此委託已無可改刪數量")
            raw = self.raw_orders[ident]
            client = self.sdk.futopt if account["account_type"] == "F" else self.sdk.stock
            if action == "cancel":
                row = unwrap(client.cancel_order(self.raw_account(account), raw))
            elif action == "price":
                obj = client.make_modify_price_obj(raw, str(value))
                row = unwrap(client.modify_price(self.raw_account(account), obj))
            else:
                if value > current["status"]["order_quantity"] - current["status"]["cancel_quantity"]:
                    raise ValueError("改量只支援減量")
                if account["account_type"] == "S":
                    raise ValueError("股票改量尚未驗證，請使用刪單後重新委託")
                obj = client.make_modify_lot_obj(raw, value)
                row = unwrap(client.modify_lot(self.raw_account(account), obj))
            return self._remember(row, current["contract"], account)

    def positions(self, account):
        with self.lock:
            if self.config.mode != "live":
                return self.paper.position_rows(account, self.quote)
            if account["account_type"] == "S":
                rows = unwrap(self.sdk.accounting.unrealized_gains_and_loses(self.raw_account(account))) or []
                inventories = unwrap(self.sdk.accounting.inventories(self.raw_account(account))) or []
                yesterday = {(str(field(row, "stock_no")), enum_name(field(row, "order_type"))):
                    int(field(row, "lastday_qty", 0)) + int(field(field(row, "odd", {}), "lastday_qty", 0))
                    for row in inventories}
                result = []
                for i, row in enumerate(rows):
                    qty = int(field(row, "today_qty", 0))
                    if not qty:
                        continue
                    contract = self.contract(dict(code=str(field(row, "stock_no")), security_type="STK"))
                    cond = {"Stock": "Cash", "Margin": "MarginTrading", "Short": "ShortSelling", "SBL": "SBLShort", "DayTrade": "Cash"}.get(enum_name(field(row, "order_type")))
                    if cond is None:
                        raise ValueError("不支援的股票部位類別")
                    result.append(dict(id=i, code=contract["code"], direction="Sell" if qty < 0 or enum_name(field(row, "buy_sell")) == "Sell" else "Buy",
                        quantity=abs(qty), price=number(field(row, "cost_price")), last_price=self.quote(contract)["close"],
                        pnl=number(field(row, "unrealized_profit"))-abs(number(field(row, "unrealized_loss"))),
                        yd_quantity=yesterday.get((contract["code"], "Stock" if enum_name(field(row, "order_type")) == "DayTrade" else enum_name(field(row, "order_type"))), 0), cond=cond))
                return result
            rows = unwrap(self.sdk.futopt_accounting.query_single_position(self.raw_account(account))) or []
            return [dict(id=i, code=self._row_contract(row, account)["code"], direction=enum_name(field(row, "buy_sell")),
                quantity=int(field(row, "tradable_lot", field(row, "orig_lots", 0))), price=number(field(row, "price")),
                last_price=number(field(row, "market_price")), pnl=number(field(row, "profit_or_loss"))) for i, row in enumerate(rows)]

    def margin(self, account):
        if self.config.mode != "live":
            return dict(yesterday_balance=1_000_000, today_balance=1_000_000, equity=1_000_000,
                equity_amount=1_000_000, available_margin=1_000_000, initial_margin=0, maintenance_margin=0,
                fee=0, tax=0, future_open_position=sum(p["pnl"] for p in self.positions(account)))
        rows = unwrap(self.sdk.futopt_accounting.query_margin_equity(self.raw_account(account))) or []
        row = next((x for x in rows if field(x, "currency") == "NTD"), None)
        if row is None:
            row = next((x for x in rows if field(x, "currency") == "TWD"), None)
        if row is None:
            raise ValueError("查無台幣權益資料")
        return {name: number(field(row, source)) for name, source in dict(
            yesterday_balance="yesterday_balance", today_balance="today_balance", equity="today_equity",
            equity_amount="today_equity", available_margin="available_margin", initial_margin="initial_margin",
            maintenance_margin="maintenance_margin", fee="today_trading_fee", tax="today_trading_tax",
            future_open_position="fut_unrealized_pnl", future_settle_profitloss="fut_realized_pnl",
            option_openbuy_market_value="opt_long_value", option_opensell_market_value="opt_short_value").items()}

    def balance(self, account):
        if self.config.mode != "live":
            return dict(acc_balance=1_000_000, date=now().date().isoformat(), errmsg="本機模擬資金")
        row = unwrap(self.sdk.accounting.bank_remain(self.raw_account(account)))
        return dict(acc_balance=number(field(row, "balance")), date=now().date().isoformat(), errmsg="")
