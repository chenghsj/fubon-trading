from copy import deepcopy
from types import SimpleNamespace as NS
from unittest.mock import Mock

import pytest
from fastapi.testclient import TestClient

from fubon_bridge.app import create_app
from fubon_bridge.broker import Broker
from fubon_bridge.config import Config
from fubon_bridge.mapping import now
from fubon_bridge.market_data import MarketData
from fubon_bridge.passkeys import PasskeyStore


def rank_row(code, close, change, volume, amount):
    return dict(symbol=code, name=code+' public fixture', lastPrice=close, closePrice=close,
                openPrice=close, highPrice=close+1, lowPrice=close-1, change=change,
                changePercent=change/(close-change)*100, tradeVolume=volume, tradeValue=amount)


@pytest.fixture
def market():
    broker = Broker(Config(mode='paper'))
    data = dict(TSE=[rank_row('2330', 110, 10, 50, 5_500_000), rank_row('0050', 90, -10, 400, 36_000_000)],
                OTC=[rank_row('3081', 130, 30, 100, 13_000_000)])
    source = Mock(side_effect=lambda **kw: dict(date=now().date().isoformat(), time='140000', data=deepcopy(data[kw['market']])))
    client = NS(snapshot=NS(movers=source, actives=source, quotes=source))
    broker._client = Mock(return_value=client)
    return MarketData(broker), source


@pytest.mark.parametrize('kind,descending,expected', [
    ('ChangePercentRank', True, ['3081', '2330', '0050']),
    ('ChangePercentRank', False, ['0050', '2330', '3081']),
    ('ChangePriceRank', True, ['3081', '2330', '0050']),
    ('VolumeRank', True, ['0050', '3081', '2330']),
    ('AmountRank', True, ['0050', '3081', '2330']),
    ('DayRangeRank', True, ['0050', '2330', '3081']),
])
def test_scanner_merges_markets_before_ranking_and_limiting(market, kind, descending, expected):
    adapter, source = market
    result = adapter.scan(kind, 2, descending, now().date())
    assert [row['code'] for row in result] == expected[:2]
    assert source.call_count == 2
    assert result[0]['date'] == now().date().isoformat()
    assert result[0]['buy_price'] is None and result[0]['volume_ratio'] is None
    assert adapter.broker.sdk is None


def test_scanner_cache_is_shared_for_count_changes_but_not_direction(market):
    adapter, source = market
    adapter.scan('ChangePercentRank', 1, True, now().date())
    adapter.scan('ChangePercentRank', 3, True, now().date())
    assert source.call_count == 2
    adapter.scan('ChangePercentRank', 1, False, now().date())
    assert source.call_count == 4


def test_scanner_does_not_cache_partial_market_failures_or_invent_untraded_prices(market):
    adapter, source = market
    source.side_effect = [dict(date=now().date().isoformat(), data=[rank_row('2330', 100, 1, 10, 1_000_000)]), RuntimeError('OTC unavailable')]
    with pytest.raises(RuntimeError):
        adapter.scan('VolumeRank', 10, True, now().date())
    assert not adapter.cache
    source.side_effect = lambda **kw: dict(date=now().date().isoformat(), data=[dict(symbol='ZERO', closePrice=99), rank_row('GOOD', 110, 10, 1, 110_000)])
    result = adapter.scan('VolumeRank', 10, True, now().date())
    assert {r['code'] for r in result} == {'GOOD'}
    assert result[0]['average_price'] == 110


def test_scanner_http_validation_and_no_sdk_access(tmp_path):
    app = create_app(Config(mode='demo'), passkey_store=PasskeyStore(tmp_path/'passkeys.sqlite3'))
    with TestClient(app) as client:
        body = dict(scanner_type='VolumeRank', date=now().date().isoformat(), ascending=True, count=20)
        assert client.post('/api/v1/data/scanner', json=body).status_code == 401
        client.headers['Authorization'] = 'Bearer '+app.state.session.issue()
        result = client.post('/api/v1/data/scanner', json=body)
        assert result.status_code == 200 and result.json()
        for values in [dict(count=0), dict(count=201), dict(count=True), dict(scanner_type='TickCountRank'), dict(date='not-a-date')]:
            assert client.post('/api/v1/data/scanner', json=dict(body, **values)).status_code == 422
        assert client.post('/api/v1/data/scanner', json=dict(body, date='2020-01-01')).status_code == 400
        assert app.state.broker.sdk is None
