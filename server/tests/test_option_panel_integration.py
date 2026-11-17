"""Replay public Fubon market payloads; no vendor SDK, Keychain or order calls.

Small wire excerpts captured 2026-11-17 by the parent's market-only probe:
/private/tmp/fubon-panel-market-probe-20261117.json. Weekly/stock option rows
below are labelled mutations for metadata/holiday/error boundaries, not live data.
"""
from copy import deepcopy
from datetime import date, datetime, timedelta
from types import SimpleNamespace as NS
from unittest.mock import Mock

import pytest
from fastapi.testclient import TestClient

from fubon_bridge.app import create_app
from fubon_bridge.broker import Broker
from fubon_bridge.config import Config
from fubon_bridge.mapping import TAIPEI
from fubon_bridge.market_data import MarketData
from fubon_bridge.passkeys import PasskeyStore
from fubon_bridge.research import ResearchStore


TODAY = date(2026, 11, 17)
STAMP = datetime(2026, 11, 17, 14, 0, tzinfo=TAIPEI)
# Exact selected fields from the public Products payload, including the blank
# index underlyingSymbol. An absent underlying must not become TSE001 or TXF.
PRODUCTS = [
    dict(symbol='TXO', type='OPTION', name='臺指選擇權', contractSize=50,
         contractType='I', expiryType='S', statusCode='N', tradingCurrency='TWD', underlyingSymbol=''),
    dict(symbol='TX4', type='OPTION', name='臺指選擇權W4', contractSize=50,
         contractType='I', expiryType='W', statusCode='N', tradingCurrency='TWD', underlyingSymbol=''),
    dict(symbol='TX1', type='OPTION', name='臺指選擇權W1', contractSize=50,
         contractType='I', expiryType='W', statusCode='U', tradingCurrency='TWD', underlyingSymbol=''),
    dict(symbol='DVO', type='OPTION', name='聯發科選擇權', contractSize=2000,
         contractType='S', expiryType='S', statusCode='N', tradingCurrency='TWD', underlyingSymbol='2454'),
]
MONTHLY = [
    dict(symbol='TXO25200L6', type='OPTION', name='臺指選擇權126;25200買權',
         referencePrice=15720, limitUpPrice=19820, limitDownPrice=11620,
         settlementDate='2026-12-16', endDate='2026-12-16'),
    dict(symbol='TXO25200X6', type='OPTION', name='臺指選擇權126;25200賣權',
         referencePrice=79, limitUpPrice=4180, limitDownPrice=0.1,
         settlementDate='2026-12-16', endDate='2026-12-16'),
]
STOCK_LEVELS = [
    dict(price=2270, volume=9, volumeAtBid=0, volumeAtAsk=9),
    dict(price=2265, volume=315, volumeAtBid=59, volumeAtAsk=256),
    # Native classified volume can be below the total; keep the remainder.
    dict(price=2195, volume=4042, volumeAtBid=914, volumeAtAsk=707),
]
FUTURE_LEVELS = [dict(price=41829, volume=1), dict(price=41826, volume=2), dict(price=41825, volume=4)]


@pytest.fixture
def option_market(monkeypatch):
    import fubon_bridge.option_catalog as options
    import fubon_bridge.market_data as market
    monkeypatch.setattr(options, 'now', lambda: STAMP)
    monkeypatch.setattr(market, 'now', lambda: STAMP)
    broker = Broker(Config(mode='paper'))
    products = Mock(side_effect=lambda **_: dict(date=TODAY.isoformat(), data=deepcopy(PRODUCTS)))
    tickers = Mock(side_effect=lambda **_: dict(date=TODAY.isoformat(), data=deepcopy(MONTHLY)))
    ticker = Mock(side_effect=lambda **_: deepcopy(MONTHLY[0]))
    client = NS(intraday=NS(products=products, tickers=tickers, ticker=ticker))
    broker._client = Mock(return_value=client)
    return broker, products, tickers, ticker


def test_public_monthly_metadata_filters_and_mutation_safe_hot_cache(option_market):
    broker, products, tickers, _ = option_market
    roots = {row['root'] for row in broker.options.roots()}
    assert roots == {'TXO', 'TX4', 'DVO'}
    rows = broker.options.contracts('TXO')
    assert [(r['code'], r['strike_price'], r['option_right']) for r in rows] == [
        ('TXO25200L6', 25200, 'C'), ('TXO25200X6', 25200, 'P')]
    for row in rows:
        assert row['security_type'] == 'OPT' and row['root'] == 'TXO'
        assert row['delivery_date'] == '2026-12-16' and row['delivery_month'] == '202612'
        assert row['multiplier'] == 50 and row['spec_kind'] == 'standard'
        assert row['underlying_kind'] == 'I' and not row.get('underlying_code')
        assert 'expiry_weekday' not in row and 'week_of_month' not in row
    rows[0]['strike_price'] = -1
    rows[0]['name'] = 'must not alter cache'
    filtered = broker.options.contracts('TXO', '202612', 'C', 25200, 25200)
    assert len(filtered) == 1 and filtered[0]['strike_price'] == 25200
    assert filtered[0]['name'] == MONTHLY[0]['name']
    assert broker.options.contracts('TXO', '202611') == []
    assert products.call_count == tickers.call_count == 1
    assert broker.sdk is None


def test_weekly_metadata_uses_actual_holiday_adjusted_expiry_without_guessing_weekday(option_market):
    broker, _, tickers, _ = option_market
    weekly = deepcopy(MONTHLY)
    for row in weekly:
        row['symbol'] = row['symbol'].replace('TXO', 'TX4')
        row['name'] = row['name'].replace('臺指選擇權', '臺指選擇權W4')
        # Deliberate holiday-adjustment mutation: actual Tuesday does not prove
        # the contract's scheduled expiry weekday or week-of-month.
        row['settlementDate'] = row['endDate'] = '2026-11-24'
    tickers.side_effect = None
    tickers.return_value = dict(data=weekly)
    rows = broker.options.contracts('TX4')
    assert rows and all(row['root'] == 'TX4' and row['spec_kind'] == 'weekly' for row in rows)
    assert all(row['delivery_date'] == '2026-11-24' and row['delivery_month'] == '202611' for row in rows)
    assert all(row['multiplier'] == 50 and 'expiry_weekday' not in row and 'week_of_month' not in row for row in rows)


def test_stock_option_keeps_explicit_name_strike_and_product_underlying(option_market):
    broker, _, tickers, _ = option_market
    row = dict(MONTHLY[0], symbol='DVO00850L6', name='聯發科選擇權126;850買權')
    tickers.side_effect = None
    tickers.return_value = dict(data=[row])
    result = broker.options.contracts('DVO')[0]
    assert result['strike_price'] == 850 and result['option_right'] == 'C'
    assert result['multiplier'] == 2000 and result['underlying_code'] == '2454'
    assert result['underlying_kind'] == 'S'


def test_stock_option_unknown_strike_scale_fails_without_publishing_cache(option_market):
    broker, _, tickers, _ = option_market
    row = dict(MONTHLY[0], symbol='DVO00850L6', name='聯發科選擇權')
    tickers.side_effect = None
    tickers.return_value = dict(data=[row])
    with pytest.raises(ValueError):
        broker.options.contracts('DVO')
    assert not broker.options.rows and not broker.catalog


def test_option_cache_invalidates_at_taiwan_date_rollover(option_market, monkeypatch):
    import fubon_bridge.option_catalog as options
    broker, products, tickers, _ = option_market
    broker.options.contracts('TXO')
    monkeypatch.setattr(options, 'now', lambda: STAMP + timedelta(days=1))
    broker.options.contracts('TXO')
    assert products.call_count == tickers.call_count == 2


def test_direct_option_info_leaves_complete_metadata_in_contract_cache(option_market):
    broker, _, _, _ = option_market
    key = dict(code=MONTHLY[0]['symbol'], security_type='OPT')
    info = broker.contract_info(key)
    assert info['multiplier'] == 50
    cached = broker.contract(key)
    assert cached['multiplier'] == info['multiplier']
    assert cached['root'] == info['root'] and cached['spec_kind'] == info['spec_kind']


@pytest.mark.parametrize('field', ['referencePrice', 'limitUpPrice', 'limitDownPrice', 'settlementDate'])
def test_missing_required_option_fields_fail_instead_of_publishing_zero(option_market, field):
    broker, _, tickers, _ = option_market
    row = deepcopy(MONTHLY[0])
    row.pop(field)
    if field == 'settlementDate':
        row.pop('endDate')
    tickers.side_effect = None
    tickers.return_value = dict(data=[row])
    with pytest.raises(ValueError):
        broker.options.contracts('TXO')
    assert not broker.options.rows and not broker.catalog


@pytest.fixture
def http_options(option_market, tmp_path):
    broker, products, tickers, ticker = option_market
    app = create_app(Config(mode='paper'), passkey_store=PasskeyStore(tmp_path/'passkeys.sqlite3'),
                     research_store=ResearchStore(tmp_path/'research.sqlite3'))
    app.state.broker._client = broker._client
    with TestClient(app, raise_server_exceptions=False) as client:
        client.headers['Authorization'] = 'Bearer ' + app.state.session.issue()
        yield client, app, products, tickers, ticker


def test_option_http_filter_contract_and_no_vendor_sdk(http_options):
    client, app, products, tickers, _ = http_options
    result = client.get('/api/v1/data/contracts/options', params=dict(root='TXO', delivery_month='202612', option_right='P', strike_min=25000, strike_max=25200))
    assert result.status_code == 200, result.text
    assert [r['code'] for r in result.json()] == ['TXO25200X6']
    assert app.state.broker.sdk is None
    assert products.call_count == tickers.call_count == 1
    client.headers.clear()
    assert client.get('/api/v1/data/contracts/options/roots').status_code == 401


@pytest.mark.parametrize('query', [
    dict(root='bad!'), dict(option_right='X'), dict(strike_min='NaN'), dict(strike_max='inf'),
    dict(strike_min='-inf'), dict(strike_min=-1), dict(strike_min=26000, strike_max=25000),
    dict(delivery_month='202613'), dict(delivery_month='202600'), dict(delivery_month='2026-12'),
    dict(expiry_weekday='Wed'),
])
def test_option_http_rejects_invalid_nonfinite_and_impossible_filters(http_options, query):
    client, _, _, _, _ = http_options
    response = client.get('/api/v1/data/contracts/options', params={'root': 'TXO', **query})
    assert response.status_code in {400, 422}, response.text


@pytest.fixture
def volume_market(option_market):
    broker, _, _, _ = option_market
    source = Mock(return_value=dict(date=TODAY.isoformat(), data=deepcopy(FUTURE_LEVELS)))
    broker._client.return_value.intraday.volumes = source
    broker.contract = Mock(side_effect=lambda key: dict(code=key['code'], security_type=key.get('security_type') or 'FUT'))
    return MarketData(broker), source


def test_native_future_volume_has_unknown_sides_and_preserves_total(volume_market):
    adapter, source = volume_market
    result = adapter.volumes(dict(code='TMFK6', security_type='FUT'))
    assert result['date'] == TODAY.isoformat() and result['source'] == 'fubon'
    assert [r['price'] for r in result['levels']] == [41829, 41826, 41825]
    assert [r['volume'] for r in result['levels']] == [1, 2, 4]
    assert all(row['buy_volume'] is None and row['sell_volume'] is None for row in result['levels'])
    source.assert_called_once_with(symbol='TMFK6')


def test_native_stock_volume_preserves_bid_ask_and_unclassified_remainder(volume_market):
    adapter, source = volume_market
    source.return_value = dict(date=TODAY.isoformat(), data=deepcopy(STOCK_LEVELS))
    result = adapter.volumes(dict(code='2330', security_type='STK'))
    assert result['levels'][-1] == dict(price=2195, volume=4042, buy_volume=707, sell_volume=914)
    assert result['levels'][0]['sell_volume'] == 0


@pytest.mark.parametrize('patch', [
    dict(price=None), dict(price='NaN'), dict(price=float('inf')), dict(price=0),
    dict(volume=None), dict(volume='NaN'), dict(volume=float('inf')), dict(volume=-1),
    dict(volumeAtAsk=-1, volumeAtBid=1), dict(volumeAtAsk=11, volumeAtBid=1),
])
def test_invalid_volume_levels_error_instead_of_zero(volume_market, patch):
    adapter, source = volume_market
    source.return_value = dict(date=TODAY.isoformat(), data=[{'price': 100, 'volume': 10, **patch}])
    with pytest.raises(ValueError):
        adapter.volumes(dict(code='TMFK6', security_type='FUT'))


def test_volume_http_missing_contract_is_client_error(http_options):
    client, _, _, _, _ = http_options
    assert client.post('/api/v1/data/volumes', json={}).status_code in {400, 422}


def ranking(code, change, volume):
    return dict(symbol=code, name=code, lastPrice=110, openPrice=100, highPrice=120,
                lowPrice=90, change=change, changePercent=change/(110-change)*100,
                tradeVolume=volume, tradeValue=volume*110_000)


@pytest.fixture
def scanner_market(option_market):
    broker, _, _, _ = option_market
    payloads = dict(TSE=dict(date=TODAY.isoformat(), data=[ranking('2330', 10, 10)]),
                    OTC=dict(date=TODAY.isoformat(), data=[ranking('3081', 20, 20)]))
    source = Mock(side_effect=lambda **kw: deepcopy(payloads[kw['market']]))
    broker._client.return_value.snapshot = NS(movers=source, actives=source, quotes=source)
    return MarketData(broker), source, payloads


def test_scanner_merges_both_markets_before_limit_and_keeps_cache_isolated(scanner_market):
    adapter, source, _ = scanner_market
    first = adapter.scan('VolumeRank', 1, True, TODAY)
    assert [r['code'] for r in first] == ['3081']
    first[0]['code'] = 'do not mutate cache'
    assert [r['code'] for r in adapter.scan('VolumeRank', 2, True, TODAY)] == ['3081', '2330']
    assert source.call_count == 2


@pytest.mark.parametrize('failure', ['exception', 'missing_data', 'invalid_date'])
def test_scanner_missing_market_never_publishes_or_caches_partial_universe(scanner_market, failure):
    adapter, source, payloads = scanner_market
    if failure == 'exception':
        source.side_effect = [deepcopy(payloads['TSE']), RuntimeError('OTC unavailable')]
    elif failure == 'missing_data':
        payloads['OTC'].pop('data')
    else:
        payloads['OTC']['date'] = 'not-a-date'
    with pytest.raises(Exception):
        adapter.scan('VolumeRank', 10, True, TODAY)
    assert not adapter.cache


def test_scanner_never_combines_different_trading_dates(scanner_market):
    adapter, _, payloads = scanner_market
    payloads['OTC']['date'] = (TODAY-timedelta(days=1)).isoformat()
    with pytest.raises(ValueError):
        adapter.scan('VolumeRank', 10, True, TODAY)
    assert not adapter.cache
