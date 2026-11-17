"""Per-instrument session routing from Fubon's dated trading windows.

Do not infer holidays, night eligibility, or FX/commodity hours from a clock.
Only a 404 establishes that a contract has no data in one session.
"""
from copy import deepcopy
from datetime import datetime
import time

from .mapping import now, stamp


class MarketSessions:
    def __init__(self, ticker, clock=None):
        self.ticker = ticker
        self.clock = clock or now
        self.cache = {}

    def resolve(self, symbol, *, refresh=False):
        at = self.clock()
        cached = self.cache.get(symbol)
        if refresh or not cached or time.monotonic() >= cached[0] or at >= cached[1]:
            rows = {}
            for session in ('regular', 'afterhours'):
                try:
                    row = self.ticker(symbol=symbol, **({'session': session} if session == 'afterhours' else {}))
                except Exception as error:
                    if getattr(error, 'status_code', None) == 404:
                        continue
                    raise
                try:
                    opening, closing = stamp(row['openDatetime']), stamp(row['closeDatetime'])
                    if opening >= closing or not row.get('symbol'):
                        raise ValueError()
                except (KeyError, ValueError, TypeError, OverflowError):
                    raise ValueError('富邦商品交易時段不完整，無法自動判斷盤別；請稍後重試或手動選盤別') from None
                rows[session] = dict(row, market_session=session,
                                     market_open=opening.isoformat(), market_close=closing.isoformat())
            if not rows:
                raise ValueError('富邦沒有此商品的日盤或夜盤資料')
            # Refresh regularly for holidays, new contracts and revised schedules,
            # and exactly at a known opening even if the TTL has not elapsed.
            boundary = min((stamp(r['market_open']) for r in rows.values() if stamp(r['market_open']) > at),
                           default=datetime.max.replace(tzinfo=at.tzinfo))
            cached = (time.monotonic() + 30, boundary, rows)
            self.cache[symbol] = cached
        rows = cached[2]
        started = [r for r in rows.values() if stamp(r['market_open']) <= at]
        # Outside trading hours retain the most recently opened session for
        # review. A dated future session never displaces an active one.
        selected = max(started, key=lambda r: stamp(r['market_open'])) if started else min(
            rows.values(), key=lambda r: stamp(r['market_open']))
        return deepcopy(selected)
