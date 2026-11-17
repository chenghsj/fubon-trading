"""Native panel read models and explicitly guarded broker mutations.

Paper reads may use a separately selected broker account. They never change
the terminal's LOCAL trading account or grant permission to submit orders.
"""
from collections import defaultdict, deque
from copy import deepcopy
from datetime import date, datetime
from decimal import Decimal
from enum import Enum
from functools import lru_cache
import hashlib
import json
import math
import re
import threading
import time

import httpx
from fastapi import HTTPException

from .feature_errors import FeatureUnavailable
from .mapping import field, now, unwrap
from .native_models import NativeQuery


LABELS = {
    'date':'日期', 'time':'時間', 'symbol':'商品', 'name':'名稱', 'stock_no':'股票', 'market':'市場',
    'open':'開盤','high':'最高','low':'最低','close':'收盤','volume':'成交量',
    'openPrice':'開盤','highPrice':'最高','lowPrice':'最低','closePrice':'收盤','lastPrice':'最新值',
    'change':'漲跌','changePercent':'漲跌幅（%）','lastUpdated':'更新時間（微秒）',
    'contractMonth':'契約月份','strikePrice':'履約價','callPut':'買賣權','openInterest':'未平倉量（口）',
    'volumeSpread':'價差成交量（口）','settlementPrice':'結算價',
    'buy':'買進股數','sell':'賣出股數','net':'買賣超股數','total':'合計',
    'foreignInvestors':'外資','foreignInvestor':'外資','investmentTrust':'投信','investmentTrusts':'投信',
    'dealer':'自營商','dealers':'自營商','dealerProprietary':'自營商自行買賣','dealerHedging':'自營商避險',
    'quantity':'數量','weight':'權重（%）','quantityChange':'較前次股數變動','weightChange':'較前次權重變動（百分點）',
    'proportion':'占比（%）','shareholders':'股東人數','holdingShares':'持股股數','pledgeShares':'設質股數',
    'pledgeRatio':'設質比例（0–1）','level':'持股級距','position':'身分','title':'身分',
    'exDividendDate':'除權息日','cashDividend':'現金股利','stockDividendShares':'每千股無償配股（股）',
    'cashCapitalIncreaseShares':'每千股現金增資（股）','cashCapitalIncreasePrice':'現金增資認購價',
    'type':'類型','effectiveDate':'生效日','applicationDate':'申請日期','reviewCommitteeDate':'審議日期',
    'boardApprovalDate':'董事會通過日','contractFilingDate':'契約備查日','contractApprovalDate':'契約核准日','listedDate':'掛牌日',
    'capitalAtApplication':'申請時股本（依市場單位）','sma':'SMA','rsi':'RSI','k':'K','d':'D','j':'J',
    'macdLine':'MACD','signalLine':'信號線','upper':'上軌','middle':'中軌','lower':'下軌',
    'week52High':'52週最高','week52Low':'52週最低','tradeVolume':'來源成交量','tradeValue':'成交金額（元）',
    'settlement_date':'交割日期','buy_value':'買進成交金額','buy_fee':'買進手續費','buy_tax':'買進稅',
    'buy_settlement':'買進交割款','sell_value':'賣出成交金額','sell_fee':'賣出手續費','sell_tax':'賣出稅',
    'sell_settlement':'賣出交割款','total_bs_value':'買賣淨額','total_fee':'手續費合計','total_tax':'稅合計',
    'total_settlement_amount':'交割款合計','currency':'幣別','filled_qty':'成交股數','filled_price':'成交價',
    'realized_profit':'已實現獲利','realized_loss':'已實現虧損','buy_sell':'方向','price':'價格','orig_lots':'原始口數',
    'transaction_fee':'手續費','tax':'稅','expiry_date':'到期日','strike_price':'履約價','call_put':'買賣權',
    'margin_value':'融資市值','shortsell_value':'融券市值','shortsell_margin':'融券保證金','collateral':'擔保品',
    'margin_loan_amt':'融資借款','maintenance_ratio':'維持率','cost_price':'成本價',
    'margin_orig_quota':'融資原始配額','margin_tradable_quota':'融資可用配額',
    'shortsell_orig_quota':'融券原始配額','shortsell_tradable_quota':'融券可用配額',
    'margin_ratio':'融資成數','short_ratio':'融券成數','daytrade_orig_quota':'現沖原始配額',
    'daytrade_tradable_quota':'現沖可用配額','precollect_single':'預收單筆數量','precollect_accumulate':'預收累計數量',
    'disposition_status':'處置狀態','status':'狀態','guid':'條件單號','create_time':'建立時間','start_date':'開始日期',
    'end_date':'結束日期','condition_content':'觸發條件','condition_buy_sell':'買賣方向','condition_symbol':'委託商品',
    'condition_price':'委託價格／效期','condition_volume':'委託數量','condition_filled_volume':'成交數量',
    'error_message':'券商訊息','order_no':'委託單號','order_type':'委託類型','order_amount':'委託金額',
    'batch_no':'批號','batch_seq_no':'批次序號','advisory':'券商處理說明','function_type':'批次種類',
    'symbol_leg2':'第二腳商品','expiry_date_leg2':'第二腳到期日','strike_price_leg2':'第二腳履約價',
    'call_put_leg2':'第二腳買賣權','buy_sell_leg2':'第二腳方向',
}
PRIVATE = {'password','cert_password','api_key','secret','token','sdk_token','bearer_token','personal_id','person_id'}


@lru_cache(maxsize=1)
def sdk_enum_members():
    # PyO3 SDK constants report module="builtins" and expose enum members as
    # class attributes. Match exact SDK types rather than walking those cycles.
    try:
        from fubon_neo import constant
    except ImportError:
        return {}
    result = {}
    for candidate in vars(constant).values():
        if isinstance(candidate, type):
            members = tuple((name, member) for name, member in vars(candidate).items()
                            if not name.startswith('_') and isinstance(member, candidate))
            if members:
                result[candidate] = members
    return result


def native_json(value, depth=0):
    if depth > 12:
        raise ValueError('富邦回應結構過深')
    if value is None or isinstance(value, (str, bool, int)):
        return value
    if isinstance(value, float):
        if not math.isfinite(value):
            raise ValueError('富邦回應含無效數值')
        return value
    if isinstance(value, Decimal):
        if not value.is_finite():
            raise ValueError('富邦回應含無效數值')
        return str(value)
    if isinstance(value, (date, datetime)):
        return value.isoformat()
    if isinstance(value, Enum):
        return value.name
    if isinstance(value, (list, tuple)):
        return [native_json(row, depth+1) for row in value]
    if isinstance(value, dict):
        return {str(key): native_json(item, depth+1) for key, item in value.items() if str(key).lower() not in PRIVATE}
    members = sdk_enum_members().get(type(value))
    if members:
        for name, member in members:
            if value == member:
                return name
        raise ValueError('富邦回應含未知列舉值')
    result = {}
    for key in dir(value):
        if key.startswith('_') or key.lower() in PRIVATE:
            continue
        item = getattr(value, key)
        if not callable(item):
            result[key] = native_json(item, depth+1)
    if not result:
        raise ValueError('富邦回應格式無法辨識')
    return result


def flat(row, prefix=''):
    result = {}
    for key, value in row.items():
        name = prefix + key
        if isinstance(value, dict):
            result.update(flat(value, name+'.'))
        else:
            result[name] = value
    return result


def label(key):
    return ' · '.join(LABELS.get(part, part) for part in key.split('.'))


def result_view(payload, operation, *, note='', source_date=None):
    """Preserve None and native child records. Never coerce unknown to zero."""
    payload = native_json(payload)
    meta, summary = {}, {}
    if isinstance(payload, list):
        rows = payload
    elif isinstance(payload, dict):
        rows = next((payload[key] for key in ('data','details','maintenance_detail') if isinstance(payload.get(key), list)), [payload])
        meta = {key: value for key, value in payload.items() if key not in {'data','details','maintenance_detail','account','maintenance_summary'} and not isinstance(value, (dict,list))}
        summary = payload.get('maintenance_summary') or {}
    else:
        raise ValueError('富邦回應缺少資料物件')
    if any(not isinstance(row, dict) for row in rows):
        raise ValueError('富邦回應明細格式不完整')
    rows = [flat(row) for row in rows]
    keys = list(dict.fromkeys(key for row in rows for key in row if key not in {'account','branch_no'}))
    scalar = [key for key in keys if not any(isinstance(row.get(key), list) for row in rows)]
    details = [key for key in keys if key not in scalar]
    if source_date:
        meta['date'] = source_date
    return dict(operation=operation, source='fubon', fetched_at=now().isoformat(),
        columns=[dict(key=key, label=label(key)) for key in scalar], rows=rows,
        detail_keys=details, summary=flat(summary) if isinstance(summary, dict) else summary,
        metadata=meta, note=note)


class NativePanels:
    def __init__(self, broker, attempts=None):
        self.broker = broker
        self.lock = threading.RLock()
        self.cache = {}
        self.rate = defaultdict(deque)
        self.actions = {}
        self.leases = {}
        self.index_ids = {}
        self.index_pending = set()
        self.index_abandoned = set()
        self.last_indices = {}
        self.retiring_ids = set()
        self.broker.extra_socket_requirements = set()
        self.dto_loader = None  # Injection seam for offline tests; never a request argument.
        self.attempts = attempts

    def _environment(self):
        return 'sandbox' if self.broker.config.mode=='sandbox' else 'production'

    def _account_key(self, selector):
        return json.dumps([selector.account_type,selector.broker_id,selector.account_id],ensure_ascii=False)

    def pending_attempts(self, selector):
        self.account(selector)
        if self.attempts:
            return self.attempts.pending(self._environment(),self._account_key(selector))
        return [dict(request_id=ident,operation=row.get('operation'),status='uncertain') for ident,row in self.actions.items()
                if row.get('uncertain') and row.get('account_key')==self._account_key(selector)]

    def reconcile(self, body):
        if body.instance_id!=self.broker.instance_id or self.broker.transitioning:
            raise HTTPException(409,'服務或環境已變更，請重新核對')
        self.account(body.account)
        with self.broker.lock,self.lock:
            if self.attempts:
                self.attempts.reconcile(self._environment(),self._account_key(body.account),body.request_id)
            record=self.actions.get(body.request_id)
            if record and record.get('account_key')==self._account_key(body.account):
                record.update(uncertain=False,verified=True)
            return dict(reconciled=True,submitted=False)

    def accounts(self):
        self.broker.ready()
        if self.broker.config.mode == 'demo':
            return []
        return [dict(account_type=kind, broker_id=branch, account_id=ident,
                     label=f'{"證券" if kind == "S" else "期權"} {branch}-{ident}', source='fubon',
                     environment='sandbox' if self.broker.config.mode == 'sandbox' else 'production-readonly')
                for kind, branch, ident in self.broker.accounts_raw]

    def account(self, selector, kind=None):
        self.broker.ready()
        if selector is None:
            raise ValueError('請選擇券商查詢帳戶；本機 Paper 帳戶不能代替券商帳戶')
        key = (selector.account_type, selector.broker_id, selector.account_id)
        if key not in self.broker.accounts_raw or kind and selector.account_type != kind:
            raise ValueError('請選擇本次登入回傳且符合查詢市場的券商帳戶')
        return self.broker.accounts_raw[key]

    def _symbol(self, query):
        if not query.symbol:
            raise ValueError('請填寫商品代號')
        return query.symbol.upper()

    def _dates(self, query, required=False, yearly=True):
        if required and not query.start:
            raise ValueError('請填寫開始與結束日期')
        if query.start and yearly and (query.end-query.start).days >= 365:
            raise ValueError('此行情 API 日期區間須小於一年')
        return {'from': query.start.isoformat(), 'to': query.end.isoformat()} if query.start else {}

    def _month(self, value, *, daily=False):
        if daily and value in {'1!','2!','3!'}:
            return value
        if daily and '/' in value:
            parts = value.split('/')
            if len(parts)!=2 or any(not re.fullmatch(r'\d{6}',part) for part in parts):
                raise ValueError('價差月份須為 YYYYMM/YYYYMM')
            return '/'.join(self._month(part) for part in parts)
        match = re.fullmatch(r'(\d{4})(\d{2})(?:[WF][1-5])?', value)
        if not match:
            raise ValueError('契約月份須為 YYYYMM 或官方週契約格式')
        date(int(match[1]), int(match[2]), 1)
        return value

    def _request(self, config, path, params):
        # Bound only to a fresh SDK endpoint group, never monkeypatch global
        # requests or expose its authorization config to the browser/logs.
        headers = {header: config[key] for key, header in [('api_key','X-API-KEY'),('bearer_token','Authorization'),('sdk_token','X-SDK-TOKEN')] if config.get(key)}
        if 'Authorization' in headers:
            headers['Authorization'] = 'Bearer '+headers['Authorization']
        try:
            response = httpx.get(config['base_url'].rstrip('/')+'/'+path.lstrip('/'), params=params, headers=headers, timeout=20)
            if response.status_code >= 400:
                status = response.status_code
                raise HTTPException(status if status in {400,401,403,404,429} else 502,
                    '富邦行情權限不足' if status == 403 else '富邦行情查詢受限，請一分鐘後重試' if status == 429 else f'富邦行情來源回應 HTTP {status}')
            return response.json()
        except httpx.TimeoutException:
            raise HTTPException(504, '富邦行情查詢逾時，請稍後重試') from None
        except httpx.HTTPError:
            raise HTTPException(502, '富邦行情連線失敗，請稍後重試') from None

    def market(self, kind, namespace, method, params, budget='historical'):
        self.broker.ready()
        if self.broker.config.mode == 'demo':
            raise FeatureUnavailable('展示模式沒有富邦原生資料；請在 Paper 連接行情後查詢')
        key = (self.broker.instance_id, kind, namespace, method, json.dumps(params, sort_keys=True))
        with self.lock:
            cached = self.cache.get(key)
            if cached and time.monotonic()-cached[0] < 15:
                return deepcopy(cached[1])
            calls, at = self.rate[budget], time.monotonic()
            while calls and at-calls[0] >= 60:
                calls.popleft()
            if len(calls) >= (45 if budget == 'historical' else 120):
                raise HTTPException(429, '此面板行情查詢過密，請稍後重試', headers={'Retry-After':'60'})
            calls.append(at)
            group = getattr(self.broker._client(kind), namespace)
            # Real endpoint groups are fresh instances; test doubles keep their
            # own method implementations and never reach the transport seam.
            from fugle_marketdata.rest.base_rest import BaseRest
            if isinstance(group, BaseRest):
                config = group.config
                group.request = lambda path, **values: self._request(config, path, values)
            payload = getattr(group, method)(**params)
            payload = native_json(payload)
            if not isinstance(payload,dict):
                raise ValueError('富邦行情回應缺少資料物件')
            if method not in {'stats','quote','ticker'} and not isinstance(payload.get('data'),list):
                raise ValueError('富邦行情回應缺少資料清單')
            if kind=='STK' and namespace=='intraday' and method in {'ticker','quote'}:
                if payload.get('type')!='INDEX' or payload.get('symbol')!=params.get('symbol'):
                    raise ValueError('指數行情回傳商品身分不符')
            self.cache[key] = (time.monotonic(), deepcopy(payload))
            if len(self.cache) > 128:
                self.cache.pop(next(iter(self.cache)))
            return payload

    def query(self, q):
        op, note = q.operation, ''
        dates = self._dates(q)
        symbol_ops = {'institutional','director','etf','tdcc','sma','rsi','macd','kdj','bb','stats','index_quote'}
        symbol = self._symbol(q) if op in symbol_ops else q.symbol.upper()
        if op in {'institutional','director','etf','tdcc'}:
            method = dict(institutional='institutional_trades', director='director_holdings', etf='etf_holdings', tdcc='tdcc_distribution')[op]
            params = dict(symbol=symbol, sort='asc', **dates)
            if q.date:
                params.update({'from':q.date.isoformat(),'to':q.date.isoformat()})
            if op == 'director':
                params = {key: value[:7] if key in {'from','to'} else value for key,value in params.items()}
                note = '董監資料為月份；設質比例為 0–1，比率與百分比欄位分開呈現。'
            elif op == 'etf':
                note = '權重單位為 %；股數變動比較上一個有資料日，權重合計不保證100%。'
            else:
                note = '法人數量為股；集保 proportion 為百分比值，未把缺值補成零。'
            payload = self.market('STK','ownership',method,params)
        elif op in {'dividends','capital','listings'}:
            self._dates(q, required=True)
            params = dict(start_date=q.start.isoformat(),end_date=q.end.isoformat(),sort='asc')
            payload = self.market('STK','corporate_actions',dict(dividends='dividends',capital='capital_changes',listings='listing_applicants')[op],params)
            if isinstance(payload.get('data'), list):
                payload = dict(payload, data=[row for row in payload['data'] if (not symbol or row.get('symbol') == symbol)
                    and (not (row.get('exchange') or row.get('market')) or (row.get('exchange') or row.get('market')) in {q.market, 'TWSE' if q.market=='TSE' else 'TPEx'})])
            note = '上市申請股本：TWSE 為仟元、TPEx 為元。空白日期不推定已通過或未申請。'
        elif op in {'sma','rsi','macd','kdj','bb'}:
            params = dict(symbol=symbol,timeframe=q.timeframe)
            if q.timeframe in {'D','W','M'}:
                params.update(dates)
            if op == 'macd':
                if q.fast >= q.slow:
                    raise ValueError('MACD 快線週期須小於慢線週期')
                params.update(fast=q.fast,slow=q.slow,signal=q.signal)
            elif op == 'kdj':
                params.update(rPeriod=q.r_period,kPeriod=q.k_period,dPeriod=q.d_period)
            else:
                params['period'] = q.period
            payload = self.market('STK','technical',op,params)
            note = '富邦官方指標；分K固定近30日且不指定日期。MACD只呈現來源的MACD與信號線。'
        elif op == 'stats':
            payload = self.market('STK','historical','stats',dict(symbol=symbol))
            note = '近52週原生統計；未使用成交量推算均價。'
        elif op == 'daily':
            if not q.date:
                raise ValueError('歷史日行情需指定單一交易日')
            params = dict(product=self._symbol(q),date=q.date.isoformat(),session=q.session)
            if q.month:
                params['contractMonth'] = self._month(q.month,daily=True)
            payload = self.market('FUT','historical','daily',params)
            note = '成交量為口；價差成交量另列，夜盤結算價／未平倉量缺值維持未知。當日日行情約盤後17:30發布。'
        elif op == 'option_candles':
            self._dates(q, required=True)
            if q.timeframe=='3':
                raise ValueError('期權歷史K不支援3分K')
            if q.strike is None or not q.month:
                raise ValueError('選擇權歷史需指定月份、履約價與買賣權')
            params = dict(product=self._symbol(q),contractMonth=self._month(q.month),strikePrice=q.strike,
                          callPut='CALL' if q.right=='C' else 'PUT',timeframe=q.timeframe,session=q.session,sort='asc',**dates)
            payload = self.market('OPT','historical','candles',params)
            note = '選擇權成交量為口；沒有成交金額或任意連續選擇權替代。'
        elif op == 'indices':
            payload = self.market('STK','intraday','tickers',dict(type='INDEX',market=q.market),'intraday')
            if q.search.strip():
                term=q.search.strip().casefold()
                payload=dict(payload,data=[row for row in payload['data'] if term in str(row.get('symbol','')).casefold() or term in str(row.get('name','')).casefold()])
                note='名稱／代碼篩選在本機處理，商品身分使用富邦原生清單。'
        elif op == 'index_quote':
            ticker = self.market('STK','intraday','ticker',dict(symbol=symbol),'intraday')
            if ticker.get('type') != 'INDEX':
                raise ValueError('請從原生指數清單選擇指數商品')
            payload = self.market('STK','intraday','quote',dict(symbol=symbol),'intraday')
            note = '指數行情只供查閱，不可交易；訂閱期間的新值會經SSE更新。'
        else:
            payload, note = self.account_query(q)
        return result_view(payload, op, note=note)

    def account_query(self, q):
        op = q.operation
        account = self.account(q.account, 'F' if op=='close_records' else 'S' if op in {'credit_margin','credit_daytrade','settlements','realized','maintenance','batch_lists','batch_detail'} else None)
        sdk, note = self.broker.sdk, ''
        with self.broker.lock:
            if op in {'credit_margin','credit_daytrade'}:
                method = 'margin_quota' if op=='credit_margin' else 'daytrade_and_stock_info'
                payload = unwrap(getattr(sdk.stock,method)(account,self._symbol(q)))
                note = '券商查詢帳戶獨立於Paper交易帳戶。配額null表示無上限；成數null表示停資／停券。' if op=='credit_margin' else 'status為券商狀態位元；預收null表示不需預收，不是遺漏或零額度。'
            elif op == 'settlements':
                payload = unwrap(sdk.accounting.query_settlement(account,q.settlement_range))
                note = '原始交割明細：date與settlement_date分開；缺日期或金額不補零、不推算銀行扣款日。'
            elif op == 'realized':
                payload = native_json(unwrap(sdk.accounting.realized_gains_and_loses(account)))
                if q.start:
                    payload = [row for row in payload if q.start <= self._record_date(row.get('date')) <= q.end]
                note = '僅券商目前回傳紀錄；來源未保證涵蓋所選完整歷史區間，日期只過濾已回傳明細。'
            elif op == 'maintenance':
                payload = unwrap(sdk.accounting.maintenance(account))
            elif op == 'close_records':
                self._dates(q, required=True, yearly=False)
                payload = unwrap(sdk.futopt_accounting.close_position_record(account,q.start.strftime('%Y%m%d'),q.end.strftime('%Y%m%d')))
                note = '原始口數不是配對開倉成本；此紀錄未提供逐筆損益，不自行推造。'
            elif op in {'conditions','condition_history','trails','trail_history','condition_by_id'}:
                client = sdk.stock if q.account.account_type=='S' else sdk.futopt
                params = {'market_type':self._constant('FutOptConditionMarketType','FutureNight' if q.session=='afterhours' else 'Future')} if q.account.account_type=='F' else {}
                if op in {'condition_history','trail_history'}:
                    self._dates(q, required=True, yearly=False)
                    method = 'get_condition_history' if op=='condition_history' else 'get_trail_history'
                    payload = unwrap(getattr(client,method)(account,q.start.strftime('%Y%m%d'),q.end.strftime('%Y%m%d'),**params))
                elif op == 'condition_by_id':
                    if not q.guid:
                        raise ValueError('請填寫條件單號')
                    payload = unwrap(client.get_condition_order_by_id(account,q.guid,**params))
                else:
                    payload = unwrap(getattr(client,'get_trail_order' if op=='trails' else 'get_condition_order')(account,**params))
                note = '券商原始狀態與父子紀錄；查詢成功不代表條件已生效、已成交或已建立保護。'
            elif op == 'order_history':
                self._dates(q, required=True, yearly=False)
                if q.account.account_type == 'S':
                    if (q.end-q.start).days >= 30:
                        raise ValueError('股票委託歷史每次最多30日')
                    payload = unwrap(sdk.stock.order_history(account,q.start.strftime('%Y%m%d'),q.end.strftime('%Y%m%d')))
                else:
                    if q.start < now().date().fromordinal(now().date().toordinal()-1) or q.end > now().date():
                        raise ValueError('期權委託歷史僅支援最近兩日')
                    payload = unwrap(sdk.futopt.order_history(account,q.start.strftime('%Y%m%d'),q.end.strftime('%Y%m%d')))
                note = '券商歷史委託；股票最多30日，期權僅最近兩日。'
            elif op in {'batch_lists','batch_detail'}:
                batches = unwrap(sdk.stock.batch_order_lists(account))
                if op == 'batch_lists':
                    payload = batches
                else:
                    matching = [row for row in batches if str(field(row,'batch_seq_no')) == q.batch_id]
                    if len(matching) != 1:
                        raise ValueError('請選擇此帳戶目前回傳的批次序號')
                    payload = unwrap(sdk.stock.batch_order_detail(account,matching[0]))
                note = '批次執行結果不等於最新委託狀態，亦不保證全成全敗。'
            else:
                raise ValueError('未支援的原生查詢')
        return payload, note

    def _record_date(self, value):
        text = str(value).replace('/','-')
        if len(text)==8 and text.isdigit():
            text = text[:4]+'-'+text[4:6]+'-'+text[6:]
        return date.fromisoformat(text[:10])

    def _constant(self, group, name):
        if self.dto_loader:
            return self.dto_loader('constant',group,name)
        from fubon_neo import constant
        return getattr(getattr(constant,group),name)

    def _dto(self, name, **params):
        if self.dto_loader:
            return self.dto_loader('dto',name,params)
        from fubon_neo import sdk, constant
        factory = getattr(sdk,name,None) or getattr(constant,name)
        return factory(**params)

    def validate_action(self, body):
        """Local validation only, available in Paper; never dispatches a write."""
        if body.instance_id != self.broker.instance_id or self.broker.transitioning:
            raise HTTPException(409, '服務或交易環境已變更，請重新核對帳戶')
        self.account(body.account)
        if body.operation != 'condition_cancel':
            limit = self.broker.config.max_quantity * (1000 if body.account.account_type=='S' else 1)
            quantities = [row.quantity for row in body.legs] if body.operation=='batch_place' else [body.quantity]
            if any(qty > limit for qty in quantities):
                raise ValueError('委託數量超過本機單筆上限')
            if body.operation=='dualleg_place' and any(row.quantity!=body.quantity for row in body.legs):
                raise ValueError('兩腳口數須與共同口數一致')
            if body.account.account_type=='S' and any(qty % 1000 for qty in quantities):
                raise ValueError('此進階委託版面僅支援整股，股數須為1000的倍數')
            if body.start and body.start < now().date():
                raise ValueError('新條件單開始日期不可早於今日')
            if body.operation=='trail_create' and body.account.account_type=='S' and Decimal(str(body.price)).as_tuple().exponent < -2:
                raise ValueError('股票移動鎖利基準價最多兩位小數，不自動四捨五入')
        return dict(valid=True, submitted=False, mode=self.broker.config.mode,
                    message='格式與本機數量檢核通過，未送至券商；券商商品、額度與條件資格仍以送出時核定為準')

    def action(self, body):
        # Guards precede account access, DTO construction and every SDK write.
        with self.broker.lock, self.lock:
            if body.instance_id != self.broker.instance_id or self.broker.transitioning:
                raise HTTPException(409, '服務或交易環境已變更，請重新核對帳戶')
            cfg = self.broker.config
            if cfg.mode not in {'sandbox','live'} or cfg.mode=='live' and not cfg.live_enabled:
                raise HTTPException(409, 'Paper／展示模式不會送出或取消券商條件單、批次及複式委託；可先檢核草稿')
            fingerprint = hashlib.sha256(body.model_dump_json().encode()).hexdigest()
            if body.request_id in self.actions:
                old = self.actions[body.request_id]
                if old['fingerprint'] != fingerprint or old.get('uncertain') or old.get('verified'):
                    raise HTTPException(409, '此送出識別碼已有紀錄，請先至券商核對結果，勿重複送出')
                return deepcopy(old['result'])
            self.validate_action(body)
            account = self.account(body.account)
            future = body.account.account_type=='F'
            if body.operation != 'condition_cancel' and ('futopt' if future else 'stock') not in self.broker.connected_sockets:
                raise HTTPException(409, '對應市場行情尚未連線，拒絕新增券商委託')
            account_key=self._account_key(body.account)
            if any(row.get('uncertain') and row.get('account_key')==account_key for row in self.actions.values()):
                raise HTTPException(409,'此帳戶有送出結果待核對，請先核對券商紀錄')
            if len(self.actions)>=256:
                raise HTTPException(409,'本次服務送出紀錄已滿，請先完成券商核對再重新啟動服務')
            dispatch=self._prepare_action(body,account,future)
            if self.attempts:
                previous=self.attempts.begin(self._environment(),body.request_id,account_key,body.operation,fingerprint)
                if previous is not None:
                    return previous
            self.actions[body.request_id] = dict(fingerprint=fingerprint,uncertain=True,account_key=account_key,operation=body.operation)
            try:
                payload = dispatch()
                result = result_view(unwrap(payload),body.operation,
                    note='券商已回覆此請求；請再查詢狀態，不代表已成交或已生效保護。批次不保證全成全敗。')
                result.update(submitted=True,request_id=body.request_id,environment=cfg.mode)
                if self.attempts:
                    self.attempts.complete(self._environment(),body.request_id,result)
                self.actions[body.request_id] = dict(fingerprint=fingerprint,result=deepcopy(result),account_key=account_key)
                return result
            except Exception:
                if self.attempts:
                    self.attempts.uncertain(self._environment(),body.request_id)
                # A transport error can happen after acceptance. Retain the
                # attempt and forbid automatic resubmission under the same ID.
                raise

    def _prepare_action(self, b, account, future):
        c, dto, sdk = self._constant, self._dto, self.broker.sdk
        client = sdk.futopt if future else sdk.stock
        market = 'FutureNight' if b.session=='afterhours' else 'Future'
        if b.operation == 'condition_cancel':
            # Verify this account owns the GUID before requesting cancellation.
            params = dict(market_type=c('FutOptConditionMarketType',market)) if future else {}
            rows = native_json(unwrap(client.get_condition_order_by_id(account,b.guid,**params)))
            if not any(str(row.get('guid')) == b.guid for row in rows):
                raise ValueError('此帳戶沒有回傳指定條件單號')
            return lambda: client.cancel_condition_orders(account,b.guid,**params)
        if b.operation == 'batch_place':
            orders = []
            for row in b.legs:
                self.broker.contract(dict(code=row.symbol,security_type='STK'))
                orders.append(dto('Order',buy_sell=c('BSAction',row.side),symbol=row.symbol,quantity=row.quantity,
                    market_type=c('MarketType','Common'),price_type=c('PriceType','Limit'),
                    time_in_force=c('TimeInForce',b.time_in_force),order_type=c('OrderType','Stock'),price=str(row.price),user_def='NativeUI'))
            return lambda: sdk.stock.batch_place_order(account,orders)
        if b.operation == 'dualleg_place':
            contracts = [self.broker.contract_info(dict(code=row.symbol,
                security_type='OPT' if re.fullmatch(r'[A-Z0-9]{3}\d+[A-X]\d',row.symbol) else 'FUT')) for row in b.legs]
            if any(row.get('target_code') or re.search(r'R[123]$',row['code']) or '!' in row['code'] for row in contracts):
                raise ValueError('複式委託須使用具體月份，不能使用連續月代碼')
            if contracts[0]['security_type'] != contracts[1]['security_type'] or contracts[0].get('root') != contracts[1].get('root'):
                raise ValueError('此複式單僅支援同商品兩腳；不可混用期貨與選擇權')
            if b.legs[0].symbol == b.legs[1].symbol:
                raise ValueError('複式兩腳不可為同一契約')
            leg_market = ('OptionNight' if b.session=='afterhours' else 'Option') if contracts[0]['security_type']=='OPT' else market
            order = dto('FutOptOrder',market_type=c('FutOptMarketType',leg_market),price_type=c('FutOptPriceType','Limit'),
                time_in_force=c('TimeInForce',b.time_in_force),order_type=c('FutOptOrderType',b.order_type),
                buy_sell=c('BSAction',b.legs[0].side),symbol=b.legs[0].symbol,
                buy_sell2=c('BSAction',b.legs[1].side),symbol2=b.legs[1].symbol,lot=b.quantity,price=str(b.price),user_def='NativeUI')
            return lambda: sdk.futopt.place_order(account,order)
        contract = self.broker.contract_info(dict(code=b.symbol,security_type='FUT' if future else 'STK'))
        if contract.get('target_code'):
            raise ValueError('券商委託須使用具體契約，不能使用連續月代碼')
        order_kind = c('FutOptConditionOrderType',b.order_type) if future else c('ConditionOrderType','Stock')
        price_kind = c('FutOptConditionPriceType' if future else 'ConditionPriceType','Limit')
        if b.operation == 'trail_create':
            if future and (b.session!='regular' or contract['security_type']!='FUT'):
                raise ValueError('移動鎖利僅支援期貨日盤')
            params = dict(symbol=b.symbol,price=str(b.price),direction=c('Direction',b.direction),
                buy_sell=c('BSAction',b.side),price_type=c('FutOptConditionPriceType' if future else 'ConditionPriceType','MatchedPrice'),diff=b.price_diff,
                time_in_force=c('TimeInForce',b.time_in_force),order_type=order_kind)
            params.update(dict(tick_num=b.trail_ticks,lot=b.quantity) if future else dict(percentage=b.trail_percentage,quantity=b.quantity))
            order = dto('FutOptTrailOrder' if future else 'TrailOrder',**params)
            return lambda: client.trail_profit(account,b.start.strftime('%Y%m%d'),b.end.strftime('%Y%m%d'),c('StopSign','Full'),order)
        order = dto('FutOptConditionOrder' if future else 'ConditionOrder',
            buy_sell=c('BSAction',b.side),symbol=b.symbol,
            market_type=c('FutOptConditionMarketType',market) if future else c('ConditionMarketType','Common'),
            price_type=price_kind,time_in_force=c('TimeInForce',b.time_in_force),order_type=order_kind,price=str(b.price),
            **({'lot':b.quantity} if future else {'quantity':b.quantity}))
        triggers = [dto('Condition',market_type=c('TradingType','Reference'),symbol=b.symbol,
            trigger=c('TriggerContent',row.trigger),trigger_value=str(row.value),comparison=c('Operator',row.comparison)) for row in b.triggers]
        child = None
        if b.operation == 'condition_tpsl':
            def exit_order(price):
                return dto('FutOptTPSLOrder' if future else 'TPSLOrder',target_price=str(price),price=str(price),
                    time_in_force=c('TimeInForce',b.time_in_force),price_type=price_kind,
                    order_type=c('FutOptConditionOrderType','Close') if future else order_kind) if price is not None else None
            child = dto('FutOptTPSLWrapper' if future else 'TPSLWrapper',stop_sign=c('StopSign','Full'),end_date=b.end.strftime('%Y%m%d'),
                        tp=exit_order(b.take_profit),sl=exit_order(b.stop_loss))
        return lambda: client.multi_condition(account,b.start.strftime('%Y%m%d'),b.end.strftime('%Y%m%d'),c('StopSign','Full'),triggers,order,child)

    def _index_socket(self):
        if 'stock' not in self.broker.connected_sockets:
            self._index_disconnected()
        socket = self.broker.market_socket('stock')
        if getattr(self,'_attached_index_socket',None) is not socket:
            self._attached_index_socket = socket
            socket.on('message',lambda raw,owner=socket:self._index_message(raw) if self._attached_index_socket is owner else None)
            socket.on('disconnect',lambda *_,owner=socket:self._index_disconnected() if self._attached_index_socket is owner else None)
            socket.on('error',lambda *_,owner=socket:self._index_disconnected() if self._attached_index_socket is owner else None)
        return socket

    def _index_disconnected(self):
        with self.lock:
            self.index_ids.clear()
            self.index_pending.clear()
            self.index_abandoned.clear()
            self.retiring_ids.clear()

    def subscribe_index(self, lease):
        q = NativeQuery(operation='index_quote',symbol=lease.symbol)
        baseline = self.query(q)  # Verify native INDEX identity and provide a fresh baseline.
        with self.broker.lock, self.lock:
            self.expire_indices()
            old = self.leases.get(lease.lease_id)
            if old and old['symbol'] != lease.symbol:
                self.unsubscribe_index(lease.lease_id)
            self.leases[lease.lease_id] = dict(symbol=lease.symbol,expires=time.monotonic()+90)
            codes = {row['symbol'] for row in self.leases.values()}
            if lease.symbol in self.index_abandoned:
                self.leases.pop(lease.lease_id,None)
                raise HTTPException(409,'前次指數訂閱仍在釋放，請稍後重試')
            if len(codes)>24 or len(self.broker.subscriptions)+len(codes)>280:
                self.leases.pop(lease.lease_id,None)
                raise ValueError('指數訂閱已達本機保留上限，請先停止其他訂閱')
            socket = self._index_socket()
            self.broker.extra_socket_requirements.add('stock')
            for symbol in codes:
                if symbol not in self.index_ids and symbol not in self.index_pending:
                    self.index_pending.add(symbol)
                    try:
                        socket.subscribe(dict(channel='indices',symbol=symbol))
                    except Exception:
                        self.index_pending.discard(symbol)
                        self.leases.pop(lease.lease_id,None)
                        raise
            return dict(subscribed=True,symbol=lease.symbol,lease_id=lease.lease_id,baseline=baseline['rows'][0] if baseline['rows'] else None)

    def unsubscribe_index(self, ident, expected_symbol=None):
        with self.broker.lock, self.lock:
            if expected_symbol and self.leases.get(ident,{}).get('symbol') not in {None,expected_symbol}:
                return dict(subscribed=True,ignored_stale_release=True)
            lease = self.leases.pop(ident,None)
            if not lease:
                return dict(subscribed=False)
            symbol = lease['symbol']
            if not self.leases:
                self.broker.extra_socket_requirements.discard('stock')
            if not any(row['symbol']==symbol for row in self.leases.values()):
                native_id = self.index_ids.pop(symbol,None)
                if native_id is not None and self.broker.sockets.get('stock'):
                    self.retiring_ids.add(native_id)
                    self._drain_retiring()
                elif symbol in self.index_pending:
                    self.index_pending.discard(symbol)
                    self.index_abandoned.add(symbol)
                self.last_indices.pop(symbol,None)
            return dict(subscribed=False)

    def expire_indices(self):
        for ident,row in list(self.leases.items()):
            if row['expires'] <= time.monotonic():
                self.unsubscribe_index(ident)
        self._drain_retiring()

    def _drain_retiring(self):
        with self.broker.lock,self.lock:
            socket=self.broker.sockets.get('stock')
            if not socket:
                return
            for ident in list(self.retiring_ids):
                try:
                    socket.unsubscribe(dict(id=ident))
                    self.retiring_ids.discard(ident)
                except Exception:
                    self.broker.emit('fubon_index_error',dict(message='指數釋放暫時失敗，服務稍後會重試'))

    def _index_message(self, raw):
        try:
            message = json.loads(raw) if isinstance(raw,(str,bytes)) else raw
            event, data = message.get('event'), message.get('data',{})
            records = data if isinstance(data,list) else [data]
            with self.broker.lock, self.lock:
                for row in records:
                    if not isinstance(row,dict):
                        continue
                    symbol = row.get('symbol')
                    if event=='subscribed' and row.get('channel')=='indices' and symbol in self.index_pending|self.index_abandoned:
                        self.index_pending.discard(symbol)
                        self.index_abandoned.discard(symbol)
                        if any(lease['symbol']==symbol for lease in self.leases.values()):
                            self.index_ids[symbol] = row['id']
                        elif self.broker.sockets.get('stock'):
                            self.retiring_ids.add(row['id'])
                            self._drain_retiring()
                    elif event in {'data','snapshot'} and message.get('channel')=='indices' and any(lease['symbol']==symbol for lease in self.leases.values()):
                        payload = native_json(row)
                        self.last_indices[symbol] = payload
                        self.broker.emit('fubon_index',payload)
        except Exception:
            self.broker.emit('fubon_index_error',dict(message='指數資料或訂閱回應格式不完整，請停止後重新訂閱'))
