from copy import deepcopy
from datetime import date, datetime, timedelta
import json
import math
import re
import threading
import time
import uuid

from .config import Config, SANDBOX_URL
from .mapping import (TAIPEI, contract_from_ticker, enum_name, field, market_events, market_trades,
                      normalize_trade, now, number, snapshot, stamp, symbol_alias, unwrap)
from .paper import ACTIVE, PaperBook
from .option_catalog import OptionCatalog
from .market_session import MarketSessions


class Broker:
    def __init__(self, config: Config, emit=lambda *_: None, sdk_factory=None, *, paper_store=None):
        self.config = config
        self.emit = emit
        self.sdk_factory = sdk_factory
        self.sdk = None
        self.lock = threading.RLock()
        self.accounts_raw = {}
        self.catalog = {}
        self.catalog_loaded = set()
        self.catalog_full = set()
        self.future_product_catalog = None
        self.quotes = {}
        self.raw_orders = {}
        self.trades = {}
        self.cache_health = {}
        self.baseline_ids = {}
        self.subscriptions = {}
        self.sockets = {}
        self.connected_sockets = set()
        self.error = None
        self.transitioning = False
        self.paper = PaperBook(emit,paper_store,costs=config.mode=='paper')
        self.instance_id = uuid.uuid4().hex
        self.options = OptionCatalog(self)
        self.market_sessions = MarketSessions(lambda **params: self._client('FUT').intraday.ticker(**params), clock=lambda: now())
        self.session_error = None
        self.pending_session_changes = set()
        self.tick_history_cache = {}
        self.tick_history_lock = threading.RLock()
        if config.mode == "demo":
            self._demo_catalog()

    def connect(self):
        if self.config.mode == "demo":
            return
        try:
            cfg = self.config.with_credentials()
            self.config = cfg
            if cfg.mode != "sandbox" and not all((cfg.personal_id, cfg.api_key, cfg.cert_path, cfg.cert_password)):
                self.error = "尚未設定富邦連線資料；請開啟「富邦連線設定」儲存至 Keychain 並重新連線"
                return
            factory = self.sdk_factory
            if factory is None:
                from fubon_neo.sdk import FubonSDK
                factory = FubonSDK
            if cfg.mode == "sandbox":
                self.sdk = factory(30, 2, url=SANDBOX_URL)
                accounts = unwrap(self.sdk.login(cfg.personal_id, "12345678", cfg.cert_path, cfg.cert_password))
            else:
                self.sdk = factory()
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
            if cfg.mode=='paper':
                self.paper.refresh()
                for trade in list(self.paper.orders.values()):
                    if trade['status']['status'] in ACTIVE:
                        # Expire old ROD before allowing a fresh quote to reach it.
                        self.paper.tick(trade['contract']['code'],{})
                        if self.paper.orders[trade['order']['id']]['status']['status'] in ACTIVE:
                            self.subscribe(trade['contract'],'Tick')
                            self.subscribe(trade['contract'],'BidAsk')
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
        needed = {sub["kind"] for sub in list(self.subscriptions.values())} | getattr(self,'extra_socket_requirements',set())
        return not self.session_error and bool(needed) and needed.issubset(self.connected_sockets)

    def account_rows(self):
        if not self.config.broker_orders:
            rows = [dict(account_type=kind, broker_id="LOCAL", account_id=f"{self.config.mode.upper()}-{kind}",
                person_id="", username="展示模擬帳戶" if self.config.mode == "demo" else "富邦行情／本機模擬帳戶",
                signed=self.config.mode == "demo" or bool(self.sdk and not self.error)) for kind in ("F", "S")]
            if self.config.mode=='paper':
                rows.append(dict(rows[0],account_id='PAPER-AUTO-F',username='Paper 策略專用模擬帳戶'))
            return rows
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

    def session_for(self, contract):
        if contract['security_type'] == 'STK':
            return 'regular'
        if self.config.session != 'auto':
            return self.config.session
        return contract.get('market_session', 'regular')

    def _session_args(self, kind, listing=False, contract=None):
        if kind == "STK":
            return {}
        # Auto listings use the complete regular-session universe. Routing is
        # resolved separately for each concrete instrument, never globally.
        session = self.session_for(contract) if contract else self.config.session
        if listing:
            return {"session": "AFTERHOURS" if session == "afterhours" else "REGULAR"}
        return {"session": "afterhours"} if session == "afterhours" else {}

    def market_contract(self, key):
        with self.lock:
            contract = self.contract(key)
            if self.config.session != 'auto' or self.config.mode == 'demo' or contract['security_type'] == 'STK':
                return contract
            code = contract['code']
            row = self.market_sessions.resolve(symbol_alias(code))
            info = contract_from_ticker(row, contract['security_type'])
            info.update({k: row[k] for k in ('market_session', 'market_open', 'market_close')})
            if row.get('settleDate'):
                info['delivery_month'] = row['settleDate'].replace('-', '')
            if info['security_type'] == 'OPT':
                info = self.options.enrich(info)
            self.catalog[info['code']] = info
            self.catalog_full.add(info['code'])
            if info['code'] != code:
                info = dict(info, code=code, target_code=info['code'])
            self.catalog[code] = info
            return self._future_info(deepcopy(info))

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
            if kind == 'FUT':
                self._future_products()
            return [self._future_info(deepcopy(x)) for x in self.catalog.values() if x["security_type"] == kind and not x.get("target_code")]
        with self.lock:
            if kind == 'FUT':
                self._future_products()
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
            return [self._future_info(deepcopy(x)) for x in self.catalog.values() if x["security_type"] == kind and not x.get("target_code")]

    def _future_products(self):
        if self.future_product_catalog is None:
            if self.config.mode == 'demo':
                rows = [dict(symbol=row['root'], name=row['name'], contractSize=row.get('multiplier'),
                             underlyingSymbol=row.get('underlying_code', ''), tradingCurrency=row['currency'])
                        for row in self.catalog.values() if row['security_type'] == 'FUT' and not row.get('target_code')]
            else:
                rows = self._client('FUT').intraday.products(type='FUTURE', exchange='TAIFEX',
                                                          **self._session_args('FUT', True)).get('data', [])
            self.future_product_catalog = {row['symbol']: row for row in rows}
        return self.future_product_catalog

    def _future_info(self, row):
        if row['security_type'] != 'FUT':
            return row
        # Cached order reconciliation must not add a market REST dependency.
        product = (self.future_product_catalog or {}).get(row['root'])
        if product:
            # Products owns the stock relationship and contract specification;
            # Tickers owns the listed month. Never infer a stock from its name.
            underlying = product.get('underlyingSymbol') or ('IX0001' if row['root'] in {'TXF', 'MXF', 'TMF'} else None)
            row['underlying_code'] = underlying
            if product.get('contractType') in {'I', 'R', 'B', 'C', 'S', 'E'}:
                row['underlying_kind'] = product['contractType']
            if number(product.get('contractSize')) > 0:
                row['multiplier'] = number(product['contractSize'])
            if product.get('tradingCurrency'):
                row['currency'] = product['tradingCurrency']
        return row

    def future_roots(self):
        with self.lock:
            return [dict(root=root, name=product.get('name') or root)
                    for root, product in self._future_products().items()]

    def futures(self, root='', underlying_code='', delivery_month=''):
        with self.lock:
            self._future_products()
            return [row for row in self.contracts('FUT') if (not root or row['root'] == root)
                    and (not underlying_code or row.get('underlying_code') == underlying_code)
                    and (not delivery_month or row.get('delivery_month') == delivery_month)]

    def contract_info(self, key):
        """Public market lookup includes specifications even on a cold direct code."""
        with self.lock:
            row = self.market_contract(key)
            if row['security_type'] == 'FUT':
                self._future_products()
            if row['security_type'] == 'OPT':
                self.options._products()
                row = self.options.enrich(row)
                self.catalog[row['code']] = deepcopy(row)
                return row
            return self._future_info(row)

    def contract(self, key, *, refresh=False):
        code = key["code"].strip().upper()
        kind = key.get("security_type")
        if not re.fullmatch(r"[A-Z0-9!]{2,24}", code):
            raise ValueError("無效商品代碼")
        if kind is None:
            kind = self.catalog.get(code, {}).get('security_type') or (
                'STK' if code.isdigit() else 'OPT' if re.fullmatch(r'[A-Z0-9]{3}\d+[A-X]\d', code) else 'FUT')
        if kind not in {"STK", "FUT", "OPT"}:
            raise ValueError("此富邦轉接器支援股票、期貨與選擇權行情")
        with self.lock:
            cached = self.catalog.get(code)
            if cached and not refresh and not cached.get("target_code") and (self.config.mode == "demo" or code in self.catalog_full):
                if cached["security_type"] != kind:
                    raise ValueError("商品類型不符")
                return self._future_info(deepcopy(cached))
            if self.config.mode == "demo":
                if cached:
                    return self._future_info(deepcopy(cached))
                raise ValueError("展示模式僅提供自選清單中的展示商品")
            # Resolve aliases from Fubon, never trust a client-supplied target.
            row = (self.market_sessions.resolve(symbol_alias(code)) if self.config.session == 'auto' and kind != 'STK'
                   else self._client(kind).intraday.ticker(symbol=symbol_alias(code), **self._session_args(kind)))
            info = contract_from_ticker(row, kind)
            if row.get("settleDate"):
                info["delivery_month"] = row["settleDate"].replace("-", "")
            if kind == 'OPT':
                info = self.options.enrich(info)
            self.catalog[info["code"]] = info
            self.catalog_full.add(info["code"])
            if info["code"] != code:
                info = dict(info, code=code, target_code=info["code"])
            self.catalog[code] = info
            return self._future_info(deepcopy(info))

    def quote(self, contract, *, resolve_session=True):
        with self.lock:
            if resolve_session and self.config.session == 'auto':
                contract = self.market_contract(contract)
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
                symbol=contract.get("target_code") or contract["code"], **self._session_args(contract["security_type"], contract=contract))
            result = snapshot(row, contract["code"])
            self.quotes[contract["code"]] = result
            return result

    def kbars(self, key, start, end):
        contract = self.market_contract(key)
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
                                  **self._session_args(kind, contract=contract))
                try:
                    rows += client.historical.candles(**params).get("data", [])
                except Exception as error:
                    if getattr(error, "status_code", None) != 404:
                        raise
            if end_date >= now().date():
                rows += client.intraday.candles(symbol=contract.get("target_code") or contract["code"], timeframe="1", sort="asc", **self._session_args(kind, contract=contract)).get("data", [])
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

    def research_candles(self, kind, symbol, month, start, end):
        """Read explicit expired contract months without resolving a live ticker."""
        if self.config.mode == "demo":
            rows = []
            first, last = date.fromisoformat(start), date.fromisoformat(end)
            for day in range((last-first).days+1):
                current = first+timedelta(days=day)
                if current.weekday() >= 5:
                    continue
                base = 25000 if kind == "FUT" else 100 + int(symbol) % 400
                for minute in range(270):
                    at = datetime.combine(current, datetime.min.time(), TAIPEI)+timedelta(hours=9, minutes=minute)
                    # Synthetic correlated paths exercise both filter outcomes, never market performance.
                    x = minute / 12 + current.toordinal() % 7
                    scale = 1 if kind == "FUT" else base / 25000
                    o = base + scale * (30*math.sin(x)+minute*.15)
                    c = base + scale * (30*math.sin(x+.09)+minute*.15)
                    if kind == "FUT":
                        o, c = round(o), round(c)
                    rows.append(dict(date=at.isoformat(), open=o, high=max(o,c)+2*scale,
                        low=min(o,c)-2*scale, close=c, volume=10+minute%17))
            return rows
        with self.lock:
            client = self._client(kind)
            params = dict(timeframe="1", sort="asc", **{"from": start, "to": end})
            if kind == "STK":
                params["symbol"] = symbol
            else:
                params.update(product=symbol, contractMonth=month, session="regular")
            try:
                return client.historical.candles(**params).get("data", [])
            except Exception as error:
                if getattr(error, "status_code", None) == 404:
                    return []
                raise ValueError(f"{symbol} 歷史行情查詢失敗；請確認行情權限、連線與日期") from None

    def learning_candles(self, kind, symbol, start, end, *, session='regular'):
        """Read-only continuous history, preserving actual contract months per row."""
        if self.config.mode == 'demo':
            if kind == 'FUT':
                from .strategy_session import schedule
                profile = 'afterhours' if session == 'afterhours' else 'regular'
                spec = schedule(profile)
                rows = []
                first, last = date.fromisoformat(start), date.fromisoformat(end)
                for n in range((last-first).days+1):
                    trading_day = first+timedelta(days=n)
                    if trading_day.weekday() >= 5:
                        continue
                    opening_day = trading_day
                    if profile == 'afterhours':
                        opening_day -= timedelta(days=1)
                        while opening_day.weekday() >= 5:
                            opening_day -= timedelta(days=1)
                    begin = spec.window(opening_day)[0]
                    for minute in range(spec.duration):
                        x = minute/12+opening_day.toordinal()%7
                        o,c = round(25000+30*math.sin(x)+minute*.04),round(25000+30*math.sin(x+.09)+minute*.04)
                        rows.append(dict(date=(begin+timedelta(minutes=minute)).isoformat(),open=o,high=max(o,c)+2,low=min(o,c)-2,close=c,volume=10+minute%17,contractMonth=trading_day.strftime('%Y%m')))
                return rows
            rows = self.research_candles(kind,symbol,'',start,end)
            return [dict(row,contractMonth=row['date'][:7].replace('-','')) for row in rows] if kind=='FUT' else rows
        with self.lock:
            params = dict(timeframe='1',sort='asc',**{'from':start,'to':end})
            params.update(dict(symbol=symbol) if kind=='STK' else dict(product=symbol,contractMonth='1!',session=session))
            try:
                return self._client(kind).historical.candles(**params).get('data',[])
            except Exception as error:
                if getattr(error,'status_code',None)==404:
                    return []
                raise ValueError('跨月歷史下載失敗，請檢查行情權限、日期或稍後重試；已保存批次可續傳') from None

    def ticks(self, key, requested_date, count=500, *, all_day=False):
        contract = self.market_contract(key)
        result = dict(datetime=[], close=[], volume=[], bid_price=[], bid_volume=[], ask_price=[], ask_volume=[], tick_type=[])
        requested = date.fromisoformat(requested_date)
        if abs((requested - now().date()).days) > 4:
            raise ValueError("富邦此介接的逐筆查詢僅支援當日；歷史分析請使用分 K")
        if not isinstance(count, int) or isinstance(count, bool) or not 1 <= count <= 500:
            raise ValueError('最近逐筆筆數須為 1–500')
        cache_key = (contract['security_type'], contract['code'], requested_date, self.session_for(contract))
        if self.config.mode == "demo":
            if requested != now().date():
                raise ValueError('展示逐筆僅提供當日合成資料')
            q = self.quote(contract)
            rows = [dict(price=q["close"], size=1, bid=q["buy_price"], ask=q["sell_price"], time=int(now().timestamp()*1e6))]
            source_date, limited = now().date().isoformat(), False
        else:
            with self.tick_history_lock:
                cached = self.tick_history_cache.get(cache_key)
                if all_day and cached and time.monotonic() - cached[0] < 15:
                    return deepcopy(cached[1])
                params = dict(symbol=contract.get('target_code') or contract['code'], limit=500 if all_day else count,
                              sort='asc' if all_day else 'desc', **self._session_args(contract['security_type'], contract=contract))
                client = self._client(contract['security_type']).intraday
                rows, previous_end, source_date, limited = [], None, None, False
                while True:
                    payload = client.trades(**params, **({'offset': len(rows)} if all_day else {}))
                    current_date = date.fromisoformat(payload['date']).isoformat()
                    if current_date != requested_date:
                        raise ValueError(f'富邦逐筆目前僅提供 {current_date} 交易日，無法查詢指定歷史日')
                    if source_date is not None and source_date != current_date:
                        raise ValueError('逐筆來源已換日，請重新載入')
                    source_date = current_date
                    page = payload['data']
                    if not isinstance(page, list):
                        raise ValueError('富邦逐筆回傳格式不完整')
                    if page:
                        end = (page[-1].get('time'), page[-1].get('serial'))
                        if all_day and end == previous_end:
                            raise ValueError('逐筆分頁沒有前進，已停止以避免重複資料')
                        previous_end = end
                    rows.extend(page)
                    if not all_day or len(page) < 500:
                        break
                    if len(rows) >= 50_000:
                        limited = True
                        break
        seen = {}
        for row in sorted(rows, key=lambda item: (item['time'], str(item.get('serial', '')))):
            if row.get('isTrial'):
                continue
            if isinstance(row.get('price'), bool) or isinstance(row.get('size'), bool) or not isinstance(row.get('price'), (int, float)) or not math.isfinite(row['price']) or row['price'] <= 0 or not isinstance(row.get('size'), (int, float)) or not math.isfinite(row['size']) or row['size'] < 0:
                raise ValueError('富邦逐筆回傳缺少有效成交價量')
            if row.get('serial') is not None:
                identity = (row['time'], row['serial'])
                if identity in seen:
                    if seen[identity] != row:
                        raise ValueError('富邦逐筆分頁內容衝突，請重新載入')
                    continue
                seen[identity] = row
            result["datetime"].append(stamp(row["time"]).isoformat())
            for key_, value in [("close", row['price']), ("volume", row['size']),
                    ("bid_price", row.get("bid", 0)), ("ask_price", row.get("ask", 0)),
                    ("bid_volume", 0), ("ask_volume", 0), ("tick_type", 0)]:
                result[key_].append(value)
        result.update(source_date=source_date, limited=limited, complete=bool(all_day and not limited),
                      message=f'{source_date} 交易日逐筆；'+('已達 50,000 筆上限，未確認完整性' if limited else '僅提供目前交易日，非歷史逐筆服務'))
        if all_day:
            with self.tick_history_lock:
                if len(self.tick_history_cache) >= 12:
                    self.tick_history_cache.pop(next(iter(self.tick_history_cache)))
                self.tick_history_cache[cache_key] = (time.monotonic(), deepcopy(result))
        return result

    def _on_sdk_event(self, code, *args):
        if str(code) in {"300", "301", "302", "303", "304", "500"}:
            self.error = "富邦交易連線已中斷，請重啟服務並重新登入；委託結果請向券商核對"
            self.emit("fubon_reconcile_required", {"reason": "broker_disconnected"})
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
        contract = self.market_contract(key)
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
                                params["afterHours"] = self.session_for(sub['contract']) == "afterhours"
                            socket.subscribe(params)
                            replayed.add((sub["channel"], symbol))
                        self.connected_sockets.add(kind)
                return
            self.subscriptions[registry_key] = dict(contract=contract, channel=channel, kind=kind)
            if self.config.mode == "demo":
                return
            self.ready()
            if kind not in self.sockets:
                self.market_socket(kind, replay=False)
            args = dict(channel=channel, symbol=contract.get("target_code") or contract["code"])
            if kind == "futopt":
                args["afterHours"] = self.session_for(contract) == "afterhours"
            try:
                self.sockets[kind].subscribe(args)
            except Exception:
                self.subscriptions.pop(registry_key, None)
                raise

    def market_socket(self, kind, *, replay=True):
        """Shared native socket; panel leases add channels without resetting SDK."""
        self.ready()
        with self.lock:
            socket = self.sockets.get(kind)
            if socket is None:
                socket = getattr(self.sdk.marketdata.websocket_client,kind)
                self.sockets[kind] = socket
                socket.on('message',lambda raw,k=kind:self._on_market(k,raw))
                socket.on('disconnect',lambda *_,k=kind:self.connected_sockets.discard(k))
                socket.on('error',lambda *_,k=kind:self.connected_sockets.discard(k))
            if kind not in self.connected_sockets:
                socket.connect()
                self.connected_sockets.add(kind)
                for sub in self.subscriptions.values() if replay else []:
                    if sub['kind']==kind:
                        args = dict(channel=sub['channel'],symbol=sub['contract'].get('target_code') or sub['contract']['code'])
                        if kind=='futopt':
                            args['afterHours'] = self.session_for(sub['contract'])=='afterhours'
                        socket.subscribe(args)
            return socket

    def unsubscribe(self, key, quote_type):
        # Upstream panels share process-level subscriptions. Retain until the
        # bridge restarts so one panel/window cannot unsubscribe another's feed.
        pass

    @staticmethod
    def _session_identity(contract):
        return tuple(contract.get(k) for k in ('target_code', 'market_session', 'market_open', 'market_close'))

    def refresh_market_sessions(self):
        """Replay the futures socket at a per-instrument session boundary.

        The process, Passkey session, accounts and working orders survive.
        Failed schedule lookups suspend futures consumption until recovery.
        """
        if self.config.session != 'auto' or self.config.mode == 'demo' or not self.sdk or self.error:
            return
        with self.lock:
            if self.transitioning:
                return
            pending, changed = [], set()
            try:
                resolved = {}
                for sub in self.subscriptions.values():
                    if sub['kind'] != 'futopt':
                        continue
                    old = sub['contract']
                    code = old['code']
                    if code not in resolved:
                        resolved[code] = self.market_contract(old)
                    current = resolved[code]
                    pending.append((sub, current))
                    if self._session_identity(old) != self._session_identity(current):
                        changed.add(code)
                recovering = bool(self.session_error)
                if not changed and not recovering:
                    return
                for sub, current in pending:
                    sub['contract'] = current
                self.pending_session_changes.update(changed)
                for code in changed:
                    self.quotes.pop(code, None)
                self.tick_history_cache.clear()
                self.connected_sockets.discard('futopt')
                socket = self.sockets.get('futopt')
                if socket:
                    socket.disconnect()
                    self.market_socket('futopt')
                self.session_error = None
                if self.pending_session_changes:
                    self.emit('fubon_session_changed', dict(codes=sorted(self.pending_session_changes)))
                    self.pending_session_changes.clear()
            except Exception:
                self.session_error = '期權自動盤別更新失敗，正在重試；期權行情與新增委託暫停'
                self.connected_sockets.discard('futopt')

    def session_is_regular(self, key):
        with self.lock:
            return self.session_for(self.market_contract(key)) == 'regular'

    def _on_market(self, kind, raw):
        try:
            message = json.loads(raw) if isinstance(raw, str) else raw
            if message.get("event") not in {"data", "snapshot"}:
                return
            channel, data = message.get("channel"), message.get("data", {})
            with self.lock:
                if kind == 'futopt' and self.session_error:
                    return
                for subscription in list(self.subscriptions.values()):
                    contract = subscription["contract"]
                    if subscription["kind"] != kind or subscription["channel"] != channel or data.get("symbol") != (contract.get("target_code") or contract["code"]):
                        continue
                    if kind == 'futopt' and self.config.session == 'auto':
                        current = self.catalog.get(contract['code'], contract)
                        if self._session_identity(current) != self._session_identity(contract):
                            continue
                        at = stamp(data['time'])
                        if not stamp(contract['market_open']) <= at <= stamp(contract['market_close']):
                            continue
                    enriched = dict(data, type="EQUITY" if kind == "stock" else "FUTURE")
                    for event, payload in market_events(channel, enriched, contract["code"], self.quotes.get(contract["code"], contract)):
                        self.emit(event, payload)
                    trades = market_trades(data) if channel == "trades" else []
                    if trades and not data.get("isTrial"):
                        price = number(trades[-1].get("price"))
                        if price > 0:
                            self.quotes[contract["code"]] = dict(self.quotes.get(contract["code"], {}), close=price,
                                datetime=stamp(data["time"]).isoformat(), is_trial=False,
                                buy_price=number(trades[-1].get("bid")), sell_price=number(trades[-1].get("ask")))
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
        if not self.config.broker_orders:
            return self.paper.order_rows(account)
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

    def place(self, contract_key, order, account, *, client_tag=None, paper_cost=None, strategy_day=None):
        with self.lock:
            if self.transitioning:
                raise ValueError("交易模式正在切換，請重新解鎖後確認帳戶")
            if client_tag is not None and (self.config.mode not in {"sandbox","paper"} or not re.fullmatch(r"FA[a-f0-9]{8}", client_tag)):
                raise ValueError("策略委託識別碼僅供 sandbox 或 paper 使用")
            if paper_cost is not None and self.config.mode!='paper':
                raise ValueError('paper 成本設定僅供本機模擬')
            if self.config.mode=='paper' and (account.get('account_id')=='PAPER-AUTO-F') != (client_tag is not None):
                raise ValueError('策略專用模擬帳戶只接受策略委託；手動請選 PAPER-F')
            if client_tag is not None and (self.config.session=="afterhours" and self.config.mode!='paper' or account.get("account_type")!="F"
                or not re.fullmatch(r"TMF[A-L]\d",contract_key.get("code","")) or order.get("quantity")!=1
                or order.get("price_type")!="LMT" or order.get("order_type")!="IOC"
                or order.get("octype") not in {"New","Cover"} or not float(order.get("price",0)).is_integer() or order.get("price",0)<=0):
                raise ValueError("策略委託僅支援日盤微台單口限價 IOC")
            self.ready()
            self.refresh_market_sessions()
            contract = self.market_contract(contract_key)
            kind = contract["security_type"]
            session = self.session_for(contract)
            if kind != 'STK' and self.session_error:
                raise ValueError(self.session_error)
            if client_tag is not None and session != 'regular' and self.config.mode != 'paper':
                raise ValueError('策略委託僅支援 Sandbox 日盤或 Paper 日／夜盤微台單口限價 IOC')
            if self.config.session == 'auto' and kind != 'STK' and self.config.mode != 'demo' and not (
                stamp(contract['market_open']) <= now() <= stamp(contract['market_close'])
            ):
                raise ValueError('此商品目前不在交易時段，請等待開盤後重新確認委託')
            if kind == 'OPT':
                raise ValueError('富邦選擇權交易級距尚未完成；目前僅提供唯讀行情')
            if kind == 'FUT' and not contract.get('multiplier'):
                self._future_products()
                contract = self._future_info(contract)
                if not contract.get('multiplier'):
                    raise ValueError('合約乘數尚未確認，拒絕建立委託')
            if kind == "STK" and order.get("price_type") not in {"LMT", "MKT"}:
                raise ValueError("股票只支援限價（LMT）或市價（MKT），不支援範圍市價（MKP）")
            if account["account_type"] != ("S" if kind == "STK" else "F"):
                raise ValueError("商品與帳戶類型不符")
            # Never let an alias or browser-provided target choose a real order.
            if contract.get("target_code") or "!" in contract["code"] or re.search(r"R[123]$", contract["code"]):
                raise ValueError("請選擇具體月份合約下單，連續月代碼僅供看盤")
            if not self.config.broker_orders:
                local_order=dict(order,custom_field=client_tag) if client_tag else order
                quote = self.quote(contract, resolve_session=False) if self.config.session == 'auto' else self.quote(contract)
                return self.paper.place(contract,local_order,account,quote,cost=paper_cost,strategy_tag=client_tag,strategy_day=strategy_day,session=session)
            if self.config.mode == "live" and not self.config.live_enabled:
                raise ValueError("正式下單未啟用")
            socket_kind = "stock" if kind == "STK" else "futopt"
            if socket_kind not in self.connected_sockets:
                raise ValueError("富邦即時行情未連線，拒絕新增正式委託；既有委託仍可查詢與取消")
            from fubon_neo.sdk import FutOptOrder, Order
            from fubon_neo.constant import BSAction, TimeInForce, FutOptMarketType, FutOptPriceType, FutOptOrderType, MarketType, PriceType, OrderType
            shared = dict(buy_sell=getattr(BSAction, order["action"]), symbol=contract["code"],
                          time_in_force=getattr(TimeInForce, order["order_type"]), price=str(order["price"]),
                          user_def=client_tag or (("FW" + uuid.uuid4().hex[:8]) if self.config.mode == "sandbox" else "FubonWeb"))
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
                if session == "afterhours":
                    market += "Night"
                obj = FutOptOrder(**shared, lot=order["quantity"], market_type=getattr(FutOptMarketType, market),
                    price_type=getattr(FutOptPriceType, {"LMT": "Limit", "MKT": "Market", "MKP": "RangeMarket"}[order["price_type"]]),
                    order_type=getattr(FutOptOrderType, {"New": "New", "Cover": "Close", "Auto": "Auto", "DayTrade": "FdayTrade"}[order.get("octype", "Auto")]))
                row = unwrap(self.sdk.futopt.place_order(self.raw_account(account), obj))
            return self._remember(row, contract, account)

    def automation_orders(self, account):
        """Fresh authoritative rows only; absence from this response is never a cancellation."""
        if self.config.mode=='paper':
            return [dict(t,automation_day=(t['paper'].get('strategyDay') or t['paper']['day']).replace('-','')) for t in self.paper.order_rows(account)]
        if self.config.mode != "sandbox":
            raise ValueError("自動交易僅支援官方 sandbox")
        with self.lock:
            rows = unwrap(self.sdk.futopt.get_order_results(self.raw_account(account)))
            if not isinstance(rows,list):
                raise ValueError("委託查詢未回傳完整清單")
            fresh, ids = [],set()
            for row in rows:
                trade = self._remember(row,self._row_contract(row,account),account)
                ident = trade["order"]["id"]
                if ident in ids:
                    raise ValueError("本輪委託查詢出現重複識別")
                ids.add(ident)
                fresh.append(dict(trade,automation_day=re.sub(r"\D","",str(field(row,"date","")))))
            self.baseline_ids[(account["account_type"],account["broker_id"],account["account_id"])] = ids
            self.cache_health[account["account_id"]] = True
            return fresh

    def automation_fill_price(self, account, trade, day):
        """Use explicit execution prices, never infer them from order limits or filled_money."""
        if self.config.mode=='paper':
            rows=[t for t in self.paper.order_rows(account) if t['order']['id']==trade['order']['id']]
            if len(rows)!=1 or (rows[0].get('paper',{}).get('strategyDay') or rows[0].get('paper',{}).get('filledDay'))!=day or rows[0]['status']['deal_quantity']!=1:
                raise ValueError('paper 成交明細尚未對齊')
            deals=rows[0]['status']['deals']
            if len(deals)!=1 or deals[0]['quantity']!=1:
                raise ValueError('paper 成交明細數量不符')
            return deals[0]['price']
        if self.config.mode != "sandbox":
            raise ValueError("自動交易僅支援官方 sandbox")
        from fubon_neo.constant import FutOptMarketType
        with self.lock:
            rows = unwrap(self.sdk.futopt.filled_history(self.raw_account(account), FutOptMarketType.Future, day.replace("-", "")))
            if not isinstance(rows, list):
                raise ValueError("成交明細尚未取得")
            fills = {}
            for row in rows:
                if (str(field(row, "order_no", "")) != trade["order"]["ordno"]
                    or re.sub(r"\D", "", str(field(row, "date", ""))) != day.replace("-", "")
                    or str(field(row,"branch_no",""))!=str(account["broker_id"])
                    or str(field(row,"account",""))!=str(account["account_id"])
                    or enum_name(field(row, "buy_sell")) != trade["order"]["action"]):
                    continue
                if self._row_contract(row, account)["code"] != trade["contract"]["code"]:
                    continue
                ident = str(field(row, "filled_no", ""))
                price, qty = number(field(row, "filled_price")), number(field(row, "filled_lot"))
                if not ident or not math.isfinite(price) or price <= 0 or not float(qty).is_integer() or qty <= 0:
                    raise ValueError("成交明細無法確認")
                value = (price, int(qty))
                if ident in fills and fills[ident] != value:
                    raise ValueError("成交明細衝突")
                fills[ident] = value
            quantity = sum(q for _, q in fills.values())
            if quantity != trade["status"]["deal_quantity"] or quantity <= 0:
                raise ValueError("成交明細口數尚未對齊")
            return sum(p*q for p, q in fills.values()) / quantity

    def mutate(self, ident, action, value=None, *, client_tag=None):
        with self.lock:
            if self.transitioning:
                raise ValueError("交易模式正在切換，請重新解鎖後確認帳戶")
            if client_tag is not None and (self.config.mode not in {"sandbox","paper"} or not re.fullmatch(r"FA[a-f0-9]{8}",client_tag) or action!="cancel"):
                raise ValueError("策略改刪僅支援取消自有模擬委託")
            if not self.config.broker_orders:
                self.paper.refresh()
                trade = self.paper.orders.get(ident)
                if not trade:
                    raise ValueError("找不到本服務的委託")
                if self.config.mode=='paper' and trade['order']['account']['account_id']=='PAPER-AUTO-F' and (not client_tag or trade.get('paper',{}).get('strategyTag')!=client_tag):
                    raise ValueError('策略專用模擬帳戶請使用自動交易面板停止與退出')
                if action == "cancel":
                    return self.paper.cancel(ident)
                return self.paper.update(ident, "price" if action == "price" else "quantity", value, self.quote(trade["contract"]))
            self.ready()
            if self.config.mode == "live" and not self.config.live_enabled:
                raise ValueError("正式改刪單未啟用")
            trade = self.trades.get(ident)
            if not trade:
                raise ValueError("請先重新整理委託，無法辨識此委託")
            account = self.account(trade["order"]["account"])
            self.order_list(account, refresh=True)
            if ident not in self.baseline_ids.get((account["account_type"], account["broker_id"], account["account_id"]), set()):
                raise ValueError("最新券商委託查詢未包含此單，拒絕使用舊快取改刪單")
            current = self.trades[ident]
            if client_tag is not None and current["order"].get("custom_field")!=client_tag:
                raise ValueError("此委託不屬於本策略，不可取消")
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
                effective = current["status"]["order_quantity"] - current["status"]["cancel_quantity"]
                remaining = effective - current["status"]["deal_quantity"]
                if value <= 0 or value >= remaining:
                    raise ValueError("減少量須小於未成交量；全部取消請使用刪單")
                if account["account_type"] == "S":
                    raise ValueError("股票改量尚未驗證，請使用刪單後重新委託")
                obj = client.make_modify_lot_obj(raw, int(effective - value))
                row = unwrap(client.modify_lot(self.raw_account(account), obj))
            return self._remember(row, current["contract"], account)

    def assert_mode_switch_idle(self):
        if not self.config.broker_orders:
            book = self.paper.overview()
            if book['positions'] or any(t['status']['status'] in ACTIVE for t in book['orders']):
                raise ValueError("模擬帳簿仍有持倉或未完成委託，請先平倉與取消委託再切換")
            return
        if not self.accounts_raw and not self.trades:
            # Login never established an account in this process.
            return
        self.ready()
        for account in self.account_rows():
            raw = self.raw_account(account)
            client = self.sdk.futopt if account['account_type'] == 'F' else self.sdk.stock
            orders = unwrap(client.get_order_results(raw))
            inventory = unwrap(self.sdk.futopt_accounting.query_single_position(raw) if account['account_type'] == 'F' else self.sdk.accounting.inventories(raw))
            if not isinstance(orders, list) or not isinstance(inventory, list):
                raise ValueError("無法確認券商委託與庫存，請恢復連線並核對後再切換")
            if inventory or any(int(field(row, 'status', -1)) not in {30, 40, 50, 90} for row in orders):
                raise ValueError("券商帳戶仍有庫存或未完成委託，請先處理並核對後再切換")

    def positions(self, account):
        with self.lock:
            if not self.config.broker_orders:
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
        if not self.config.broker_orders:
            lifetime=self.paper.overview(account['account_id'])
            daily=self.paper.overview(account['account_id'],now().date().isoformat())
            cash=1_000_000+lifetime['realizedNet']
            unrealized=sum(p['pnl'] for p in self.positions(account))
            return dict(yesterday_balance=cash-daily['realizedNet'],today_balance=cash,equity=cash+unrealized,
                equity_amount=cash+unrealized,available_margin=cash+unrealized,initial_margin=0,maintenance_margin=0,
                fee=daily['fee'],tax=daily['tax'],future_open_position=unrealized,future_settle_profitloss=daily['realizedNet'])
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
        if not self.config.broker_orders:
            return dict(acc_balance=1_000_000+self.paper.overview(account['account_id'])['realizedNet'],date=now().date().isoformat(),errmsg="本機模擬資金，未模擬保證金占用")
        row = unwrap(self.sdk.accounting.bank_remain(self.raw_account(account)))
        return dict(acc_balance=number(field(row, "balance")), date=now().date().isoformat(), errmsg="")
