from dataclasses import replace
from types import SimpleNamespace as NS

import pytest
from fubon_bridge.broker import Broker
from fubon_bridge.config import Config, SANDBOX_URL
from fubon_bridge.keychain import Keychain
from test_bridge import fake_live_broker, request_order, client


def test_sandbox_login_pins_test_host_and_never_reads_keychain(tmp_path, monkeypatch):
    cert = tmp_path / 'test.pfx'
    cert.write_bytes(b'public-test-certificate')
    monkeypatch.setattr(Keychain, 'read', lambda _: pytest.fail('sandbox must not read production Keychain'))
    calls = []
    account = NS(account_type='futopt', branch_no='TEST', account='TEST-F', name='test')
    sdk = NS(login=lambda *args: (calls.append(('login', args)) or NS(is_success=True, data=[account])),
             init_realtime=lambda: None)
    for name in ['set_on_futopt_order','set_on_order','set_on_futopt_filled','set_on_filled','set_on_order_futopt_changed','set_on_order_changed','set_on_event']:
        setattr(sdk, name, lambda _: None)
    def factory(*args, **kwargs):
        calls.append(('factory', args, kwargs))
        return sdk
    broker = Broker(Config(mode='sandbox', test_id='TEST-ID', test_cert_path=str(cert)), sdk_factory=factory)
    broker.connect()
    assert broker.error is None
    assert calls[0] == ('factory', (30, 2), {'url': SANDBOX_URL})
    assert calls[1] == ('login', ('TEST-ID', '12345678', str(cert), '12345678'))
    assert broker.account_rows()[0]['account_id'] == 'TEST-F'
    assert broker.config.broker_orders and not broker.config.live_enabled


def test_missing_test_credentials_do_not_use_production_keychain(monkeypatch):
    monkeypatch.setattr(Keychain, 'read', lambda _: pytest.fail('must not read production Keychain'))
    broker = Broker(Config(mode='sandbox'))
    broker.connect()
    assert broker.error and broker.sdk is None


@pytest.mark.parametrize('mode', ['live', 'sandbox'])
def test_broker_quantity_is_reduction_but_sdk_receives_new_total(mode):
    broker, row, captures = fake_live_broker()
    broker.config = replace(broker.config, mode=mode, live_enabled=mode == 'live')
    row.lot, row.after_lot, row.filled_lot = 10, 10, 3
    broker.sdk.futopt.make_modify_lot_obj = lambda native, qty: (captures.append(qty) or qty)
    broker.sdk.futopt.modify_lot = lambda account, qty: NS(is_success=True, data=NS(**{**vars(row), 'after_lot': qty}))
    trade = broker._remember(row, broker.catalog['TXFK6'], broker.account_rows()[0])
    updated = broker.mutate(trade['order']['id'], 'quantity', 2)
    assert captures == [8]  # 3 filled + 5 still working
    assert type(captures[0]) is int
    assert updated['status']['cancel_quantity'] == 2
    assert updated['status']['deal_quantity'] == 3


def test_broker_disconnect_blocks_new_orders():
    broker, _, captures = fake_live_broker()
    broker._on_sdk_event('300', 'disconnected')
    assert broker.error
    with pytest.raises(ValueError, match='中斷'):
        broker.place({'code':'TXFK6','security_type':'FUT'},
                     {'action':'Buy','price':25000,'quantity':1,'price_type':'LMT','order_type':'ROD'}, broker.account_rows()[0])
    assert not captures


def test_paper_reduction_matches_frontend_payload(client):
    trade = client.post('/api/v1/order/place_order', json=request_order(client, quantity=10)).json()
    changed = client.post('/api/v1/order/update_qty', json={'trade_id':trade['order']['id'],'quantity':2}).json()
    assert changed['status']['cancel_quantity'] == 2
    assert changed['order']['quantity'] - changed['status']['cancel_quantity'] == 8
