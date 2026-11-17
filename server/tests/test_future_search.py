import json
from pathlib import Path
from types import SimpleNamespace as NS
from unittest.mock import Mock

from fastapi.testclient import TestClient
import pytest

from fubon_bridge.app import create_app
from fubon_bridge.config import Config
from fubon_bridge.mapping import contract_from_ticker
from fubon_bridge.passkeys import PasskeyStore


@pytest.fixture
def market():
    data = json.loads((Path(__file__).parent / 'fixtures/future-search-2026-11-17.json').read_text())
    return NS(products=Mock(return_value={'data': data['products']}),
              tickers=Mock(return_value={'data': data['tickers']}),
              ticker=Mock(side_effect=lambda symbol, **_: next(r for r in data['tickers'] if r['symbol'] == symbol)))


@pytest.fixture
def client(tmp_path, market):
    app = create_app(Config(mode='paper'), passkey_store=PasskeyStore(tmp_path / 'passkeys.db'))
    app.state.broker.sdk = NS(marketdata=NS(rest_client=NS(futopt=NS(intraday=market))), shutdown=lambda: None)
    with TestClient(app) as client:
        client.headers['Authorization'] = 'Bearer ' + app.state.session.issue()
        yield client


def test_roots_include_official_searchable_names(client):
    response = client.get('/api/v1/data/contracts/futures/roots')
    assert response.status_code == 200
    roots = {r['root']: r['name'] for r in response.json()}
    assert roots['DVF'] == '聯發科期貨'
    assert roots['PUF'] == '小型聯發科期貨'
    assert roots['JZ1'] == '嘉聯益期貨'


def test_cold_direct_future_info_has_the_same_specification_before_and_after_search(client, market):
    assert client.app.state.broker.future_product_catalog is None
    cold = client.get('/api/v1/data/contracts/DVFK6/info?security_type=FUT')
    assert cold.status_code == 200
    assert cold.json()['underlying_code'] == '2454'
    assert cold.json()['multiplier'] == 2000
    client.get('/api/v1/data/contracts/futures/roots')
    warm = client.get('/api/v1/data/contracts/DVFK6/info?security_type=FUT')
    assert cold.json() == warm.json()
    assert market.products.call_count == 1


@pytest.mark.parametrize('stock,roots', [('2330', {'CDF', 'QFF'}), ('2454', {'DVF', 'PUF'}), ('IX0001', {'TXF', 'MXF', 'TMF'})])
def test_stock_code_filters_related_futures_without_leaking_other_stocks(client, stock, roots):
    response = client.get('/api/v1/data/contracts/futures', params={'underlying_code': stock})
    assert response.status_code == 200
    rows = response.json()
    assert rows and {r['root'] for r in rows} == roots
    assert all(r['underlying_code'] == stock and r['delivery_month'] for r in rows)
    for row in rows:
        info = client.get('/api/v1/data/contracts/' + row['code'] + '/info?security_type=FUT').json()
        assert info['underlying_code'] == stock
        assert info['multiplier'] == row['multiplier']
    if stock == '2330':
        assert {r['root']: r['multiplier'] for r in rows} == {'CDF': 2000, 'QFF': 100}


def test_futures_filters_combine_and_unmatched_stock_returns_empty(client, market):
    rows = client.get('/api/v1/data/contracts/futures?underlying_code=2330').json()
    month = rows[0]['delivery_month']
    filtered = client.get('/api/v1/data/contracts/futures', params={'underlying_code':'2330', 'root':'CDF', 'delivery_month':month}).json()
    assert filtered and all(r['root'] == 'CDF' and r['delivery_month'] == month for r in filtered)
    assert client.get('/api/v1/data/contracts/futures?underlying_code=9999').json() == []
    assert client.get('/api/v1/data/contracts/futures?underlying_code=2330&root=DVF').json() == []
    assert market.products.call_count == 1


def test_adjusted_contract_root_retains_digits():
    assert contract_from_ticker({'symbol':'JZ1K6','name':'嘉聯益期貨116'}, 'FUT')['root'] == 'JZ1'


def test_cached_order_refresh_and_cancel_work_when_products_are_unavailable():
    # This is a fake trading client only; no native SDK or login is created.
    from test_bridge import fake_live_broker
    broker, raw, captured = fake_live_broker()
    cached = dict(contract_from_ticker({'symbol':'CDFK6','name':'台積電期貨116'}, 'FUT'),
                  underlying_code='2330', multiplier=2000)
    broker.catalog['CDFK6'] = cached
    broker.catalog_full.add('CDFK6')
    broker.sdk.futopt.convert_symbol = lambda *args, **kwargs: 'CDFK6'
    broker._future_products = Mock(side_effect=AssertionError('Market catalog outage must not block cached cancellation'))
    account = broker.account_rows()[0]
    trade = broker._remember(raw, cached, account)
    refreshed = broker.order_list(account, refresh=True)
    assert refreshed[0]['contract']['code'] == 'CDFK6'
    cancelled = broker.mutate(trade['order']['id'], 'cancel')
    assert cancelled['status']['status'] == 'Cancelled'
    assert captured == [raw]
    broker._future_products.assert_not_called()
