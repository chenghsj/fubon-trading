"""Read-only market-wide queries. Never touches an order/accounting client."""
from copy import deepcopy
from datetime import date
import math
import threading
import time

from .mapping import now


def finite(value):
    if isinstance(value, bool):
        return None
    try:
        result = float(value)
    except (TypeError, ValueError):
        return None
    return result if math.isfinite(result) else None


class MarketData:
    def __init__(self, broker):
        self.broker = broker
        self.lock = threading.RLock()
        self.cache = {}

    def volumes(self, key):
        contract = self.broker.market_contract(key)
        if self.broker.config.mode == 'demo':
            quote = self.broker.quote(contract)
            payload = dict(date=now().date().isoformat(), data=[dict(price=quote['close'], volume=100, volumeAtAsk=40, volumeAtBid=50)])
        else:
            payload = self.broker._client(contract['security_type']).intraday.volumes(
                symbol=contract.get('target_code') or contract['code'], **self.broker._session_args(contract['security_type'], contract=contract))
        rows = []
        for row in payload['data']:
            price, volume = finite(row.get('price')), finite(row.get('volume'))
            if price is None or price <= 0 or volume is None or volume < 0:
                raise ValueError('富邦分價量資料含無效價量')
            buy, sell = finite(row.get('volumeAtAsk')), finite(row.get('volumeAtBid'))
            if buy is None or sell is None:
                buy = sell = None
            elif min(buy, sell) < 0 or buy + sell > volume + 1e-6:
                raise ValueError('富邦分價量內外盤總量不一致')
            rows.append(dict(price=price, volume=volume, buy_volume=buy, sell_volume=sell))
        return dict(code=contract['code'], date=date.fromisoformat(payload['date']).isoformat(),
                    source='demo' if self.broker.config.mode == 'demo' else 'fubon',
                    session=self.broker.session_for(contract), levels=sorted(rows, key=lambda row: row['price'], reverse=True))

    def _rank_source(self, scanner_type, descending):
        if scanner_type in {'ChangePercentRank', 'ChangePriceRank'}:
            return 'movers', dict(direction='up' if descending else 'down',
                                  change='percent' if scanner_type == 'ChangePercentRank' else 'value')
        if scanner_type in {'VolumeRank', 'AmountRank'}:
            return 'actives', dict(trade='volume' if scanner_type == 'VolumeRank' else 'value')
        return 'quotes', {}

    def scan(self, scanner_type, count, descending, requested_date):
        if requested_date != now().date():
            raise ValueError('排行榜只提供最新市場快照，不能查詢指定歷史日期')
        method, params = self._rank_source(scanner_type, descending)
        key = (method, tuple(sorted(params.items())), requested_date)
        with self.lock:
            cached = self.cache.get(key)
            if cached and time.monotonic() - cached[0] < 10:
                rows = deepcopy(cached[1])
            elif self.broker.config.mode == 'demo':
                rows = [dict(symbol=c['code'], name=c['name'], openPrice=c['reference'],
                             highPrice=c['reference'], lowPrice=c['reference'], closePrice=c['reference'],
                             lastPrice=c['reference'], change=0, changePercent=0, tradeVolume=0, tradeValue=0,
                             source_date=requested_date.isoformat())
                        for c in self.broker.catalog.values() if c['security_type'] == 'STK']
            else:
                rows = []
                client = self.broker._client('STK').snapshot
                source_dates = set()
                # Both markets must succeed: never present a partial universe as a complete ranking.
                for market in ('TSE', 'OTC'):
                    payload = getattr(client, method)(market=market, **params)
                    source_date = date.fromisoformat(payload['date']).isoformat()
                    source_dates.add(source_date)
                    if not isinstance(payload.get('data'), list):
                        raise ValueError('富邦排行資料格式不完整')
                    rows.extend(dict(row, market=market, source_date=source_date) for row in payload['data'])
                if len(source_dates) != 1:
                    raise ValueError('富邦上市與上櫃快照交易日不一致，請稍後重試')
                self.cache[key] = (time.monotonic(), deepcopy(rows))
        output = []
        for row in rows:
            close, change = finite(row.get('lastPrice')), finite(row.get('change'))
            high, low, opening = (finite(row.get(k)) for k in ('highPrice', 'lowPrice', 'openPrice'))
            volume, amount = finite(row.get('tradeVolume')), finite(row.get('tradeValue'))
            # Untraded or incomplete records are not zero-price trading candidates.
            if not row.get('symbol') or close is None or close <= 0 or change is None or None in (high, low, opening, volume, amount):
                continue
            reference = close - change
            pct = finite(row.get('changePercent'))
            if pct is None:
                pct = change / reference * 100 if reference > 0 else None
            day_range = (high - low) / reference * 100 if reference > 0 else None
            metric = {'ChangePercentRank': pct, 'ChangePriceRank': change, 'DayRangeRank': day_range,
                      'VolumeRank': volume, 'AmountRank': amount}.get(scanner_type)
            if metric is None:
                continue
            output.append(dict(code=row['symbol'], name=row.get('name', row['symbol']), date=row['source_date'],
                               close=close, open=opening, high=high, low=low, change_price=change,
                               change_type=2 if change > 0 else 4 if change < 0 else 3,
                               average_price=amount / (volume * 1000) if volume > 0 else None,
                               price_range=day_range, rank_value=metric, total_volume=volume, total_amount=amount,
                               volume_ratio=None, yesterday_volume=None, tick_type=None, buy_price=None, sell_price=None))
        output.sort(key=lambda row: (row['rank_value'] * (-1 if descending else 1), row['code']))
        return output[:count]
