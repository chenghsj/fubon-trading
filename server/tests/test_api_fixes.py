from copy import deepcopy
import json
from pathlib import Path
from types import SimpleNamespace as NS
from unittest.mock import Mock

import pytest
from fastapi.testclient import TestClient

from fubon_bridge.app import create_app
from fubon_bridge.broker import Broker
from fubon_bridge.config import Config
from fubon_bridge.mapping import contract_from_ticker, market_events, stamp
from fubon_bridge.passkeys import PasskeyStore
from fubon_bridge.research import ResearchStore


@pytest.fixture
def watchlist_client(tmp_path):
    app = create_app(Config(mode='demo'), passkey_store=PasskeyStore(tmp_path / 'passkeys.db'))
    app.state.broker.contract = Mock(side_effect=lambda key: contract_from_ticker(
        dict(symbol=key['code'], name={'1802': '台玻', '2330': '台積電'}.get(key['code'], key['code'])),
        key.get('security_type', 'STK')))
    with TestClient(app) as client:
        client.headers['Authorization'] = 'Bearer ' + app.state.session.issue()
        yield client


def test_watchlist_add_1802_then_remove_preserves_other_members(watchlist_client):
    client = watchlist_client
    stock = dict(code='1802', security_type='STK', exchange='TSE', region='TW')
    original = dict(code='2330', security_type='STK', exchange='TSE')
    watch = client.post('/api/v1/watchlist', json=dict(name='glass', contracts=[original])).json()
    path = '/api/v1/watchlist/' + watch['id'] + '/contracts'
    for _ in range(2):
        response = client.post(path, json=dict(contracts=[stock, stock]))
        assert response.status_code == 200, response.text
        assert [c['code'] for c in response.json()['contracts']] == ['2330', '1802']
    saved = next(x for x in client.get('/api/v1/watchlist').json() if x['id'] == watch['id'])
    assert [c['code'] for c in saved['contracts']] == ['2330', '1802']
    client.app.state.broker.contract = Mock(side_effect=AssertionError('Removal must not require market data'))
    removed = client.request('DELETE', path, json=dict(contracts=[stock]))
    assert removed.status_code == 200, removed.text
    assert removed.json()['contracts'] == [original]
    assert client.request('DELETE', path, json=dict(contracts=[stock])).json()['contracts'] == [original]
    assert client.app.state.broker.sdk is None


def test_watchlist_membership_missing_list_and_invalid_input_do_not_mutate(watchlist_client):
    client = watchlist_client
    stock = dict(code='1802', security_type='STK', exchange='TSE')
    for method in ['POST', 'DELETE']:
        response = client.request(method, '/api/v1/watchlist/missing/contracts', json=dict(contracts=[stock]))
        assert response.status_code == 404
    watch = client.post('/api/v1/watchlist', json=dict(name='empty', contracts=[])).json()
    path = '/api/v1/watchlist/' + watch['id'] + '/contracts'
    for body in [{}, dict(contracts=[dict(code='x')]), dict(contracts=[dict(code='1802', security_type='WRONG')])]:
        assert client.post(path, json=body).status_code == 422
    def resolve(key):
        if key['code'] == 'NOTFOUND':
            raise ValueError('找不到商品')
        return contract_from_ticker(dict(symbol=key['code']), 'STK')
    client.app.state.broker.contract = Mock(side_effect=resolve)
    response = client.post(path, json=dict(contracts=[stock, dict(code='NOTFOUND', security_type='STK')]))
    assert response.status_code == 400
    assert next(x for x in client.get('/api/v1/watchlist').json() if x['id'] == watch['id'])['contracts'] == []


@pytest.fixture
def stock_frame():
    # Actual public stock WebSocket payload captured on 2026-11-17.
    return json.loads((Path(__file__).parent / 'fixtures/stock-trades-2026-11-17.json').read_text())


def test_flat_stock_trade_preserves_price_size_total_and_timestamp(stock_frame):
    data = stock_frame['data']
    events = list(market_events('trades', data, '2330', dict(reference=2190)))
    assert len(events) == 1
    event, payload = events[0]
    assert event == 'tick_stk'
    assert payload['code'] == '2330' and payload['close'] == str(data['price'])
    assert payload['volume'] == data['size']
    assert payload['total_volume'] == data['volume']
    assert payload['time'] == stamp(data['time']).strftime('%H:%M:%S.%f')
    assert not payload['simtrade']


@pytest.mark.parametrize('trial', [False, True])
def test_captured_stock_frame_reaches_sse_and_only_real_trade_fills_local_book(stock_frame, trial):
    frame = deepcopy(stock_frame)
    frame['data']['isTrial'] = trial
    data = frame['data']
    events = []
    broker = Broker(Config(mode='paper'), emit=lambda event, payload: events.append((event, payload)))
    broker.paper.clock = lambda: stamp(data['time'])
    contract = contract_from_ticker(dict(symbol='2330', referencePrice=2190), 'STK')
    broker.subscriptions[('2330', 'Tick')] = dict(kind='stock', channel='trades', contract=contract)
    limit = max(data['price'], data['ask'])
    initial = dict(close=limit+2, buy_price=limit+1, sell_price=limit+2,
                   datetime=stamp(data['time']).isoformat(), reference=2190)
    broker.quotes['2330'] = initial
    account = dict(account_type='S', broker_id='LOCAL', account_id='PAPER-S')
    trade = broker.paper.place(contract,
        dict(action='Buy', price=limit, quantity=1, price_type='LMT', order_type='ROD'), account, initial)
    assert trade['status']['status'] == 'Submitted'
    assert broker.paper.overview()['positions'] == []
    broker._on_market('stock', json.dumps(frame))
    tick_events = [payload for event, payload in events if event == 'tick_stk']
    assert len(tick_events) == 1 and tick_events[0]['simtrade'] is trial
    after = broker.paper.orders[trade['order']['id']]
    if trial:
        assert after['status']['status'] == 'Submitted'
        assert broker.paper.overview()['positions'] == []
    else:
        assert broker.quotes['2330']['close'] == data['price']
        assert broker.quotes['2330']['buy_price'] == data['bid']
        assert broker.quotes['2330']['sell_price'] == data['ask']
        assert after['status']['status'] == 'Filled'
        assert after['status']['deals'][0]['price'] == data['ask']
        assert broker.paper.overview()['positions'][0]['signed_qty'] == 1000
    assert broker.sdk is None


@pytest.mark.parametrize('mode', ['demo', 'paper', 'sandbox', 'live'])
def test_stock_mkp_rejected_by_http_model_before_account_or_broker(mode, tmp_path):
    app = create_app(Config(mode=mode, live_enabled=mode == 'live'),
                     passkey_store=PasskeyStore(tmp_path / 'passkeys.db'),
                     research_store=ResearchStore(tmp_path / 'research.db'))
    broker = app.state.broker
    broker.account = Mock(side_effect=AssertionError('Invalid order must not reach account lookup'))
    broker.place = Mock(side_effect=AssertionError('Invalid order must not reach execution'))
    with TestClient(app, raise_server_exceptions=False) as client:
        client.headers['Authorization'] = 'Bearer ' + app.state.session.issue()
        response = client.post('/api/v1/order/place_order', json=dict(
            contract=dict(code='2330', security_type='STK'),
            stock_order=dict(action='Buy', price=0, quantity=1, price_type='MKP', order_type='IOC',
                             account=dict(account_type='S', broker_id='LOCAL', account_id='PAPER-S'))))
        assert response.status_code == 422, response.text
        assert '股票' in response.text
        broker.account.assert_not_called()
        broker.place.assert_not_called()
        assert broker.sdk is None


@pytest.mark.parametrize('mode', ['paper', 'live'])
def test_direct_broker_stock_mkp_is_rejected_before_local_or_sdk_execution(mode):
    broker = Broker(Config(mode=mode, live_enabled=mode == 'live'))
    broker.sdk = NS(stock=NS(place_order=Mock()))
    broker.connected_sockets.add('stock')
    broker.contract = lambda _: contract_from_ticker(dict(symbol='2330'), 'STK')
    broker.paper.place = Mock(side_effect=AssertionError('MKP must not enter PaperBook'))
    with pytest.raises(ValueError, match='股票'):
        broker.place(dict(code='2330', security_type='STK'),
                     dict(action='Buy', price=0, quantity=1, price_type='MKP', order_type='IOC'),
                     dict(account_type='S', broker_id='LOCAL', account_id='PAPER-S'))
    broker.paper.place.assert_not_called()
    broker.sdk.stock.place_order.assert_not_called()
