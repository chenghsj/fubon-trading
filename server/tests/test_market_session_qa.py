"""Independent session QA: dated market fixtures, no SDK login or broker writes."""
from copy import deepcopy
from datetime import datetime
from types import SimpleNamespace as NS
from unittest.mock import Mock

import pytest

from fubon_bridge.broker import Broker
from fubon_bridge.config import Config
from fubon_bridge.mapping import TAIPEI, contract_from_ticker
from fubon_bridge.market_session import MarketSessions


def instant(value):
    return datetime.fromisoformat(value).replace(tzinfo=TAIPEI)


def ticker_row(code, opening, closing):
    return dict(symbol=code, name=code, referencePrice=25000,
                settlementDate='2026-12-16', openDatetime=opening + '+08:00',
                closeDatetime=closing + '+08:00')


INDEX = {
    'regular': ticker_row('TMFL6', '2026-11-17T08:45:00', '2026-11-17T13:45:00'),
    'afterhours': ticker_row('TMFL6', '2026-11-17T15:00:00', '2026-11-18T05:00:00'),
}
FX = {
    'regular': ticker_row('RHFL6', '2026-11-17T08:45:00', '2026-11-17T16:15:00'),
    'afterhours': ticker_row('RHFL6', '2026-11-17T17:25:00', '2026-11-18T05:00:00'),
}


class NotFound(Exception):
    status_code = 404


@pytest.fixture
def market(monkeypatch):
    clock = [instant('2026-11-17T13:00:00')]
    monkeypatch.setattr('fubon_bridge.broker.now', lambda: clock[0])
    rows = deepcopy({'TMFL6': INDEX, 'RHFL6': FX})
    def ticker(symbol, session='regular'):
        row = rows[symbol].get(session)
        if row is None:
            raise NotFound()
        return deepcopy(row)
    events = []
    socket = NS(connect=Mock(), disconnect=Mock(), subscribe=Mock(), on=Mock())
    source = Mock(side_effect=ticker)
    broker = Broker(Config(mode='paper', session='auto'), lambda *args: events.append(args))
    broker.sdk = NS(marketdata=NS(rest_client=NS(futopt=NS(intraday=NS(ticker=source))),
                                 websocket_client=NS(futopt=socket)))
    for code, sessions in rows.items():
        broker.catalog[code] = contract_from_ticker(sessions['regular'], 'FUT')
        broker.catalog_full.add(code)
    return NS(broker=broker, socket=socket, rows=rows, clock=clock, events=events, source=source)


def test_each_instrument_uses_its_own_opening_instead_of_a_global_clock(market):
    market.clock[0] = instant('2026-11-17T15:01:00')
    index = market.broker.market_contract(dict(code='TMFL6', security_type='FUT'))
    fx = market.broker.market_contract(dict(code='RHFL6', security_type='FUT'))
    assert market.broker.session_for(index) == 'afterhours'
    assert market.broker.session_for(fx) == 'regular'
    market.clock[0] = instant('2026-11-17T17:25:00')
    assert market.broker.session_for(market.broker.market_contract(fx)) == 'afterhours'


def test_known_opening_switches_even_before_thirty_second_cache_expires(market):
    market.clock[0] = instant('2026-11-17T14:59:59')
    key = dict(code='TMFL6', security_type='FUT')
    assert market.broker.market_contract(key)['market_session'] == 'regular'
    market.clock[0] = instant('2026-11-17T15:00:00')
    assert market.broker.market_contract(key)['market_session'] == 'afterhours'


def test_404_no_night_stays_regular_while_transport_failure_is_not_no_night(market):
    market.rows['RHFL6'] = {'regular': FX['regular']}
    market.clock[0] = instant('2026-11-17T21:00:00')
    assert market.broker.market_contract(dict(code='RHFL6', security_type='FUT'))['market_session'] == 'regular'
    ticker = Mock(side_effect=[deepcopy(INDEX['regular']), RuntimeError('offline')])
    resolver = MarketSessions(ticker, clock=lambda: market.clock[0])
    with pytest.raises(RuntimeError, match='offline'):
        resolver.resolve('TMFL6')


def test_holiday_retains_latest_dated_session_without_inventing_weekday_hours():
    rows = {
        'regular': ticker_row('TMFL6', '2026-11-13T08:45:00', '2026-11-13T13:45:00'),
        'afterhours': ticker_row('TMFL6', '2026-11-13T15:00:00', '2026-11-14T05:00:00'),
    }
    resolver = MarketSessions(lambda symbol, session='regular': deepcopy(rows[session]),
                              clock=lambda: instant('2026-11-16T10:00:00'))
    assert resolver.resolve('TMFL6')['market_session'] == 'afterhours'


def test_cross_session_replays_books_and_trades_and_rejects_old_market_frames(market):
    broker = market.broker
    key = dict(code='TMFL6', security_type='FUT')
    broker.subscribe(key, 'Tick')
    broker.subscribe(key, 'BidAsk')
    broker.paper.tick = Mock()
    market.socket.subscribe.reset_mock()
    market.clock[0] = instant('2026-11-17T15:00:00')
    broker.refresh_market_sessions()
    assert broker.session_error is None
    assert len(market.socket.subscribe.call_args_list) == 2
    assert all(c.args[0]['afterHours'] is True for c in market.socket.subscribe.call_args_list)
    broker._on_market('futopt', dict(event='data', channel='trades', data=dict(
        symbol='TMFL6', time=int(instant('2026-11-17T13:40:00').timestamp() * 1e6),
        trades=[dict(price=26000, size=1)])))
    broker.paper.tick.assert_not_called()
    assert 'TMFL6' not in broker.quotes
    broker._on_market('futopt', dict(event='data', channel='trades', data=dict(
        symbol='TMFL6', time=int(instant('2026-11-17T15:00:00').timestamp() * 1e6),
        trades=[dict(price=26001, size=1)])))
    assert broker.quotes['TMFL6']['close'] == 26001
    broker.paper.tick.assert_called_once()


def test_reconnect_failure_recovery_still_notifies_browser_of_changed_session(market):
    broker = market.broker
    broker.subscribe(dict(code='TMFL6', security_type='FUT'), 'Tick')
    market.socket.connect.side_effect = [RuntimeError('socket down'), None]
    market.clock[0] = instant('2026-11-17T15:00:00')
    broker.refresh_market_sessions()
    assert broker.session_error
    broker.refresh_market_sessions()
    assert broker.session_error is None
    changes = [data for event, data in market.events if event == 'fubon_session_changed']
    assert changes == [dict(codes=['TMFL6'])]


def test_manual_session_never_requires_auto_metadata(market):
    from dataclasses import replace
    market.broker.config = replace(market.broker.config, session='afterhours')
    market.source.side_effect = AssertionError('manual mode must not query both sessions')
    contract = market.broker.market_contract(dict(code='TMFL6', security_type='FUT'))
    assert market.broker.session_for(contract) == 'afterhours'
    market.broker.refresh_market_sessions()
    market.source.assert_not_called()


def test_auto_retains_case_insensitive_trimmed_contract_resolution(market):
    contract = market.broker.market_contract(dict(code=' tmfl6 ', security_type='FUT'))
    assert contract['code'] == 'TMFL6'
    assert all(c.kwargs['symbol'] == 'TMFL6' for c in market.source.call_args_list)


def test_cold_night_only_contract_does_not_require_a_successful_day_ticker(market):
    market.clock[0] = instant('2026-11-17T21:00:00')
    del market.broker.catalog['TMFL6']
    market.broker.catalog_full.remove('TMFL6')
    del market.rows['TMFL6']['regular']
    contract = market.broker.market_contract(dict(code='TMFL6', security_type='FUT'))
    assert contract['market_session'] == 'afterhours'


def test_paper_quote_session_and_order_expiry_follow_the_same_resolved_window(market):
    broker = market.broker
    market.clock[0] = instant('2026-11-17T15:00:00')
    broker.paper.clock = lambda: market.clock[0]
    quote = Mock(return_value=dict(lastPrice=25001,
        lastTrade=dict(price=25001, bid=25000, ask=25002, time=int(market.clock[0].timestamp() * 1e6))))
    broker.sdk.marketdata.rest_client.futopt.intraday.quote = quote
    account = broker.account_rows()[0]
    trade = broker.place(dict(code='TMFL6', security_type='FUT'),
        dict(action='Buy', price=24000, quantity=1, price_type='LMT', order_type='ROD', octype='New'), account)
    assert trade['status']['status'] == 'Submitted'
    assert trade['contract']['market_session'] == 'afterhours'
    assert trade['paper']['expiresAt'] == instant('2026-11-18T05:00:00').timestamp()
    quote.assert_called_once_with(symbol='TMFL6', session='afterhours')


@pytest.mark.parametrize('time,expected', [('2026-11-17T13:00:00', 'Future'), ('2026-11-17T15:00:00', 'FutureNight')])
def test_native_order_constructor_gets_the_auto_resolved_market_without_login(market, time, expected):
    pytest.importorskip('fubon_neo')
    from dataclasses import replace
    market.clock[0] = instant(time)
    broker = market.broker
    broker.config = replace(broker.config, mode='live', live_enabled=True)
    broker.accounts_raw[('F', 'OFFLINE', 'ACCOUNT')] = NS(name='offline QA')
    captures = []
    raw = NS(lot=1, after_lot=1, filled_lot=0, status=10, seq_no='seq', order_no='N1',
             date='2026/11/17', symbol='FITX', expiry_date='202612', buy_sell='Buy', price=25000, order_type='New')
    broker.sdk.futopt = NS(place_order=lambda account, order: (captures.append(order) or NS(is_success=True, data=raw)))
    broker.connected_sockets.add('futopt')
    broker.place(dict(code='TMFL6', security_type='FUT'),
        dict(action='Buy', price=25000, quantity=1, price_type='LMT', order_type='IOC', octype='New'), broker.account_rows()[0])
    assert len(captures) == 1
    assert str(captures[0].market_type).endswith(expected)
