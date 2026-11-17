"""Independent mutation/lease acceptance. All broker methods and DTOs are fake.

Never initializes FubonSDK, loads host credentials, or permits outbound calls.
Native method signatures were checked against the official mapping supplied
for this task, not inferred from successful generic mock return values.
"""
from copy import deepcopy
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from datetime import date, datetime, timedelta
import json
import socket
import threading
from types import SimpleNamespace as NS
from unittest.mock import Mock

from fastapi import HTTPException
from fastapi.testclient import TestClient
from pydantic import ValidationError
import pytest

from fubon_bridge.app import create_app
from fubon_bridge.broker import Broker
from fubon_bridge.config import Config
from fubon_bridge.keychain import Keychain
from fubon_bridge.mapping import TAIPEI
from fubon_bridge.native_models import IndexLease, NativeAction
from fubon_bridge.native_panels import NativePanels
from fubon_bridge.passkeys import PasskeyStore
from fubon_bridge.research import ResearchStore


DAY = date(2026, 11, 17)
AT = datetime(2026, 11, 17, 10, 0, tzinfo=TAIPEI)
STOCK = dict(account_type='S', broker_id='QA-S', account_id='NATIVE-S')
FUTURE = dict(account_type='F', broker_id='QA-F', account_id='NATIVE-F')
OPERATIONS = ('condition_create', 'condition_tpsl', 'trail_create',
              'condition_cancel', 'batch_place', 'dualleg_place')
METHODS = ('multi_condition', 'trail_profit', 'cancel_condition_orders',
           'batch_place_order', 'place_order', 'get_condition_order_by_id')


def ok(value=None):
    return NS(is_success=True, data=deepcopy(value if value is not None else
        dict(guid='qa-condition-guid', status='accepted-not-filled')), message=None)


def fail(*args, **kwargs):
    raise AssertionError('Native QA forbids SDK construction, Keychain, and outbound access')


@pytest.fixture(autouse=True)
def prohibit_external_access(monkeypatch):
    import fubon_bridge.native_panels as module
    monkeypatch.setattr(Keychain, 'read', fail)
    monkeypatch.setattr(socket.socket, 'connect', fail)
    monkeypatch.setattr(socket.socket, 'connect_ex', fail)
    monkeypatch.setattr(module.httpx, 'get', fail)
    monkeypatch.setattr(module, 'now', lambda: AT)


class FakeSocket:
    def __init__(self):
        self.handlers = {}
        self.subscribe = Mock()
        self.unsubscribe = Mock()

    def on(self, event, callback):
        self.handlers.setdefault(event, []).append(callback)

    def emit(self, event, value=None):
        for callback in list(self.handlers.get(event, [])):
            callback(value)


@pytest.fixture
def native():
    broker = Broker(Config(mode='sandbox', max_quantity=2), sdk_factory=Mock(side_effect=fail))
    raw_s, raw_f = NS(marker='raw-stock'), NS(marker='raw-future')
    broker.accounts_raw = {('S', 'QA-S', 'NATIVE-S'): raw_s, ('F', 'QA-F', 'NATIVE-F'): raw_f}
    stock, futopt = (NS(**{method: Mock(return_value=ok()) for method in METHODS}) for _ in range(2))
    stock.get_condition_order_by_id.return_value = ok([dict(guid='qa-owned-guid')])
    futopt.get_condition_order_by_id.return_value = ok([dict(guid='qa-owned-guid')])
    broker.sdk = NS(stock=stock, futopt=futopt)
    broker.connected_sockets.update({'stock', 'futopt'})
    broker.contract = Mock(side_effect=lambda key: contract(key))
    broker.contract_info = Mock(side_effect=lambda key: contract(key))
    adapter, dto_calls = NativePanels(broker), []

    def dto(kind, group, value):
        dto_calls.append((kind, group, deepcopy(value)))
        return NS(dto=group, **value) if kind == 'dto' else f'{group}.{value}'

    adapter.dto_loader = dto
    emit = broker.emit = Mock()
    ws = FakeSocket()
    broker.sockets['stock'] = ws

    def market_socket(kind):
        assert kind == 'stock'
        broker.connected_sockets.add(kind)
        return broker.sockets[kind]

    broker.market_socket = Mock(side_effect=market_socket)
    ticker = Mock(side_effect=lambda **params: dict(type='INDEX', symbol=params['symbol'], date=DAY.isoformat()))
    quote = Mock(side_effect=lambda **params: dict(type='INDEX', symbol=params['symbol'], lastPrice=40000.25, date=DAY.isoformat()))
    broker._client = Mock(return_value=NS(intraday=NS(ticker=ticker, quote=quote)))
    return NS(adapter=adapter, broker=broker, stock=stock, futopt=futopt,
              raw_s=raw_s, raw_f=raw_f, dto_calls=dto_calls, ws=ws, emit=emit,
              ticker=ticker, quote=quote)


def contract(key):
    code, kind = key['code'], key['security_type']
    return dict(code=code, security_type=kind, root=code[:3] if kind != 'STK' else code,
        target_code='TXFK6' if code.endswith('R1') else None, multiplier=200)


def body(operation='condition_create', selector=None, **overrides):
    selector = selector or (FUTURE if operation == 'dualleg_place' else STOCK)
    future = selector['account_type'] == 'F'
    values = dict(operation=operation, account=selector, instance_id='replace-with-instance',
        request_id='qa-request-00000001', symbol='TXFK6' if future else '2330',
        quantity=1 if future else 1000, price=100, start=DAY, end=DAY+timedelta(days=1),
        triggers=[dict(value=100)], guid='qa-owned-guid', trail_percentage=2,
        trail_ticks=5, take_profit=110,
        legs=[dict(symbol='TXFK6', side='Buy', quantity=1), dict(symbol='TXFL6', side='Sell', quantity=1)]
            if operation == 'dualleg_place' else [dict(symbol='2330', quantity=1000, price=100)] if operation == 'batch_place' else [])
    return NativeAction.model_validate(values | overrides)


def action(native, operation='condition_create', selector=None, **values):
    return body(operation, selector, instance_id=native.broker.instance_id, **values)


def write_count(native):
    return sum(getattr(client, method).call_count for client in (native.stock, native.futopt)
               for method in METHODS if method != 'get_condition_order_by_id')


@pytest.mark.parametrize('operation', OPERATIONS)
@pytest.mark.parametrize('mode', ['paper', 'demo'])
def test_local_modes_reject_every_native_mutation_before_account_sdk_or_dto(native, operation, mode):
    native.broker.config = replace(native.broker.config, mode=mode)
    native.adapter.account = Mock(side_effect=fail)
    native.adapter.dto_loader = Mock(side_effect=fail)
    with pytest.raises(HTTPException) as error:
        native.adapter.action(action(native, operation))
    assert error.value.status_code == 409
    native.adapter.account.assert_not_called()
    native.adapter.dto_loader.assert_not_called()
    assert write_count(native) == 0 and native.adapter.actions == {}
    native.broker.sdk_factory.assert_not_called()


@pytest.mark.parametrize('operation', OPERATIONS)
@pytest.mark.parametrize('guard', ['stale-instance', 'transition', 'live-disabled', 'unreturned-account'])
def test_mutation_preconditions_never_dispatch(native, operation, guard):
    values = {}
    if guard == 'stale-instance':
        values['instance_id'] = 'old-instance'
    elif guard == 'transition':
        native.broker.transitioning = True
    elif guard == 'live-disabled':
        # Config already prevents this at startup; also exercise the runtime
        # guard against a disabled live flag without starting any live broker.
        native.broker.config = NS(mode='live', live_enabled=False)
    else:
        values['account'] = dict(STOCK, account_id='NOT-RETURNED') if operation != 'dualleg_place' else dict(FUTURE, account_id='NOT-RETURNED')
    request = body(operation, instance_id=native.broker.instance_id, **{})
    request = NativeAction.model_validate(request.model_dump() | values)
    with pytest.raises((HTTPException, ValueError)):
        native.adapter.action(request)
    assert write_count(native) == 0 and native.dto_calls == []


@pytest.mark.parametrize('operation', [op for op in OPERATIONS if op != 'condition_cancel'])
def test_disconnected_market_rejects_new_actions(native, operation):
    native.broker.connected_sockets.clear()
    with pytest.raises(HTTPException) as error:
        native.adapter.action(action(native, operation))
    assert error.value.status_code == 409 and write_count(native) == 0


@pytest.mark.parametrize('selector,quantity', [(STOCK, 999), (STOCK, 3000), (FUTURE, 3)])
def test_action_quantity_units_and_limits_fail_before_dto(native, selector, quantity):
    with pytest.raises(ValueError):
        native.adapter.action(action(native, selector=selector, quantity=quantity))
    assert write_count(native) == 0 and native.dto_calls == []


@pytest.mark.parametrize('operation', ['condition_create', 'condition_tpsl', 'trail_create'])
@pytest.mark.parametrize('selector', [STOCK, FUTURE])
def test_native_condition_and_trail_official_signatures(native, operation, selector):
    b = action(native, operation, selector)
    result = native.adapter.action(b)
    client, raw = (native.futopt, native.raw_f) if selector == FUTURE else (native.stock, native.raw_s)
    assert result['submitted'] is True and result['environment'] == 'sandbox'
    method = client.trail_profit if operation == 'trail_create' else client.multi_condition
    args = method.call_args.args
    assert args[:4] == (raw, '20261117', '20261118', 'StopSign.Full')
    if operation == 'trail_create':
        order = args[4]
        assert order.price == '100.0'
        if selector == FUTURE:
            assert order.tick_num == 5 and order.lot == 1 and not hasattr(order, 'percentage')
        else:
            assert order.percentage == 2 and order.quantity == 1000 and not hasattr(order, 'tick_num')
    else:
        trigger, order, child = args[4][0], args[5], args[6]
        assert trigger.market_type == 'TradingType.Reference'
        assert trigger.trigger == 'TriggerContent.MatchedPrice' and trigger.comparison == 'Operator.GreaterThanOrEqual'
        assert trigger.trigger_value == '100.0' and order.price == '100.0'
        assert child is None if operation == 'condition_create' else child.tp.target_price == '110.0'
    native.broker.sdk_factory.assert_not_called()


def test_batch_uses_stock_native_method_and_share_quantity(native):
    native.adapter.action(action(native, 'batch_place'))
    raw, orders = native.stock.batch_place_order.call_args.args
    assert raw is native.raw_s and len(orders) == 1
    assert orders[0].symbol == '2330' and orders[0].quantity == 1000
    assert orders[0].market_type == 'MarketType.Common' and orders[0].price == '100.0'


def test_dualleg_uses_one_native_order_with_both_symbols_and_common_lot(native):
    native.adapter.action(action(native, 'dualleg_place'))
    raw, order = native.futopt.place_order.call_args.args
    assert raw is native.raw_f
    assert (order.symbol, order.buy_sell, order.symbol2, order.buy_sell2, order.lot) == (
        'TXFK6', 'BSAction.Buy', 'TXFL6', 'BSAction.Sell', 1)
    assert write_count(native) == 1


@pytest.mark.parametrize('selector', [STOCK, FUTURE])
def test_cancel_checks_selected_account_guid_and_works_without_market_socket(native, selector):
    native.broker.connected_sockets.clear()
    native.adapter.action(action(native, 'condition_cancel', selector, session='afterhours'))
    client, raw = (native.stock, native.raw_s) if selector == STOCK else (native.futopt, native.raw_f)
    extra = {} if selector == STOCK else dict(market_type='FutOptConditionMarketType.FutureNight')
    client.get_condition_order_by_id.assert_called_once_with(raw, 'qa-owned-guid', **extra)
    client.cancel_condition_orders.assert_called_once_with(raw, 'qa-owned-guid', **extra)


def test_cancel_rejects_foreign_guid_before_cancel_method(native):
    native.stock.get_condition_order_by_id.return_value = ok([dict(guid='someone-else')])
    with pytest.raises(ValueError, match='此帳戶'):
        native.adapter.action(action(native, 'condition_cancel'))
    native.stock.cancel_condition_orders.assert_not_called()


def test_same_request_is_dispatched_once_and_changed_body_rejected(native):
    request = action(native)
    first = native.adapter.action(request)
    first['rows'][0]['guid'] = 'caller-edited-result'
    assert native.adapter.action(request)['rows'][0]['guid'] == 'qa-condition-guid'
    assert write_count(native) == 1
    with pytest.raises(HTTPException) as error:
        native.adapter.action(request.model_copy(update=dict(price=101)))
    assert error.value.status_code == 409 and write_count(native) == 1


def test_uncertain_native_submission_cannot_be_retried(native):
    request = action(native)
    native.stock.multi_condition.side_effect = TimeoutError('accepted-or-unknown')
    with pytest.raises(TimeoutError):
        native.adapter.action(request)
    with pytest.raises(HTTPException) as error:
        native.adapter.action(request)
    assert error.value.status_code == 409 and write_count(native) == 1


def test_full_request_registry_rejects_without_evicting_uncertain_records(native):
    native.adapter.actions = {f'old-{i}': dict(fingerprint='old', uncertain=True) for i in range(256)}
    before = deepcopy(native.adapter.actions)
    with pytest.raises(HTTPException):
        native.adapter.action(action(native))
    assert native.adapter.actions == before and write_count(native) == 0


def test_simultaneous_identical_requests_do_not_double_submit(native):
    entered, release, second_started = threading.Event(), threading.Event(), threading.Event()

    def respond(*args):
        entered.set()
        assert release.wait(2)
        return ok()

    native.stock.multi_condition.side_effect = respond
    request = action(native)
    with ThreadPoolExecutor(max_workers=2) as pool:
        first = pool.submit(native.adapter.action, request)
        assert entered.wait(2)

        def second():
            second_started.set()
            return native.adapter.action(request)

        retry = pool.submit(second)
        assert second_started.wait(2)
        release.set()
        assert first.result(timeout=2) == retry.result(timeout=2)
    assert write_count(native) == 1


@pytest.mark.parametrize('quantity', [999, 3000])
def test_each_batch_leg_enforces_share_units_and_per_order_limit(native, quantity):
    request = action(native, 'batch_place', legs=[dict(symbol='2330', quantity=1000, price=100),
        dict(symbol='2454', quantity=quantity, price=100)])
    with pytest.raises(ValueError):
        native.adapter.action(request)
    assert write_count(native) == 0 and native.dto_calls == []


@pytest.mark.parametrize('operation', OPERATIONS)
def test_paper_draft_validation_never_constructs_native_dtos_or_dispatches(native, operation):
    native.broker.config = replace(native.broker.config, mode='paper')
    result = native.adapter.validate_action(action(native, operation))
    assert result['valid'] is True and result['submitted'] is False
    assert write_count(native) == 0 and native.dto_calls == []


@pytest.mark.parametrize('values', [dict(quantity=True), dict(quantity=0), dict(quantity=1.5),
    dict(price=float('nan')), dict(price=float('inf')), dict(sdk_method='place_order'),
    dict(triggers=[dict(value=0)]), dict(symbol='../2330'), dict(request_id='too-short')])
def test_action_dto_rejects_invalid_values_and_method_injection(values):
    with pytest.raises(ValidationError):
        body(**values)


@pytest.fixture
def http(native, tmp_path):
    app = create_app(Config(mode='demo'), sdk_factory=fail,
        passkey_store=PasskeyStore(tmp_path/'passkeys.sqlite3'), research_store=ResearchStore(tmp_path/'research.sqlite3'))
    adapter = app.state.native_panels
    adapter.broker, adapter.dto_loader = native.broker, native.adapter.dto_loader
    with TestClient(app, raise_server_exceptions=False) as client:
        yield NS(client=client, adapter=adapter)


def authorize(http):
    http.client.headers['Authorization'] = 'Bearer '+http.client.app.state.session.issue()


@pytest.mark.parametrize('path', ['/api/v1/native/action', '/api/v1/native/draft/validate',
    '/api/v1/native/index/subscribe', '/api/v1/native/index/unsubscribe'])
def test_native_routes_require_current_authorized_session(http, native, path):
    payload = action(native).model_dump(mode='json') if 'index' not in path else dict(lease_id='qa-index-lease-0001', symbol='IX0001')
    assert http.client.post(path, json=payload).status_code == 401
    authorize(http)
    http.client.app.state.session.revoke(http.client.headers['Authorization'])
    assert http.client.post(path, json=payload).status_code == 401
    assert write_count(native) == 0 and native.ticker.call_count == 0


def test_native_http_guards_origin_content_type_and_dto_before_write(http, native):
    authorize(http)
    payload = action(native).model_dump(mode='json')
    assert http.client.post('/api/v1/native/action', json=payload, headers={'Origin':'https://foreign.example'}).status_code == 403
    assert http.client.post('/api/v1/native/action', content='not-json').status_code == 415
    assert http.client.post('/api/v1/native/action', json=payload | dict(sdk_method='place_order')).status_code == 422
    assert write_count(native) == 0


@pytest.mark.parametrize('operation', OPERATIONS)
@pytest.mark.parametrize('mode', ['sandbox', 'live'])
def test_authorized_http_actions_dispatch_once_only_to_the_fake_selected_environment(http, native, operation, mode):
    native.broker.config = replace(native.broker.config, mode=mode, live_enabled=mode == 'live')
    authorize(http)
    payload = action(native, operation).model_dump(mode='json')
    first = http.client.post('/api/v1/native/action', json=payload)
    second = http.client.post('/api/v1/native/action', json=payload)
    assert first.status_code == second.status_code == 200, (first.text, second.text)
    assert first.json() == second.json()
    assert first.json()['environment'] == mode and first.json()['submitted'] is True
    assert write_count(native) == 1
    native.broker.sdk_factory.assert_not_called()


@pytest.mark.parametrize('operation', OPERATIONS)
def test_http_paper_action_is_rejected_but_draft_remains_local(http, native, operation):
    native.broker.config = replace(native.broker.config, mode='paper')
    authorize(http)
    payload = action(native, operation).model_dump(mode='json')
    rejected = http.client.post('/api/v1/native/action', json=payload)
    checked = http.client.post('/api/v1/native/draft/validate', json=payload)
    assert rejected.status_code == 409
    assert checked.status_code == 200 and checked.json()['submitted'] is False
    assert write_count(native) == 0 and native.dto_calls == []


def lease(ident='qa-index-lease-0001', symbol='IX0001'):
    return IndexLease(lease_id=ident, symbol=symbol)


def ack(socket_, symbol='IX0001', ident='native-index-1'):
    socket_.emit('message', json.dumps(dict(event='subscribed', data=dict(channel='indices', symbol=symbol, id=ident))))


def test_index_shared_leases_deduplicate_and_only_last_owner_unsubscribes(native):
    native.adapter.subscribe_index(lease())
    native.adapter.subscribe_index(lease('qa-index-lease-0002'))
    native.ws.subscribe.assert_called_once_with(dict(channel='indices', symbol='IX0001'))
    ack(native.ws)
    native.adapter.unsubscribe_index('qa-index-lease-0001')
    native.ws.unsubscribe.assert_not_called()
    native.adapter.unsubscribe_index('qa-index-lease-0002')
    native.ws.unsubscribe.assert_called_once_with(dict(id='native-index-1'))
    assert native.adapter.leases == {} and native.adapter.index_ids == {}


def test_index_lease_expiry_keeps_other_owner_and_then_cleans_native_subscription(native, monkeypatch):
    import fubon_bridge.native_panels as module
    clock = [100.0]
    monkeypatch.setattr(module.time, 'monotonic', lambda: clock[0])
    native.adapter.subscribe_index(lease())
    ack(native.ws)
    clock[0] = 150
    native.adapter.subscribe_index(lease('qa-index-lease-0002'))
    clock[0] = 191
    native.adapter.expire_indices()
    assert set(native.adapter.leases) == {'qa-index-lease-0002'}
    native.ws.unsubscribe.assert_not_called()
    clock[0] = 241
    native.adapter.expire_indices()
    native.ws.unsubscribe.assert_called_once_with(dict(id='native-index-1'))
    assert not native.adapter.leases and not native.adapter.last_indices


def test_index_cancel_before_ack_unsubscribes_late_native_ack(native):
    native.adapter.subscribe_index(lease())
    native.adapter.unsubscribe_index('qa-index-lease-0001')
    ack(native.ws)
    native.ws.unsubscribe.assert_called_once_with(dict(id='native-index-1'))
    assert not native.adapter.leases and not native.adapter.index_pending and not native.adapter.index_ids


def test_index_disconnect_resubscribe_replays_one_channel(native):
    native.adapter.subscribe_index(lease())
    ack(native.ws)
    native.broker.connected_sockets.clear()
    native.ws.emit('disconnect')
    native.adapter.subscribe_index(lease())
    assert native.ws.subscribe.call_count == 2
    ack(native.ws, ident='native-index-reconnected')
    native.adapter.unsubscribe_index('qa-index-lease-0001')
    native.ws.unsubscribe.assert_called_once_with(dict(id='native-index-reconnected'))


def test_index_drops_unowned_data_and_preserves_native_values_for_owned_channel(native):
    native.adapter.subscribe_index(lease())
    native.ws.emit('message', dict(event='data', channel='indices', data=dict(symbol='IX0043', price=200)))
    native.emit.assert_not_called()
    payload = dict(symbol='IX0001', price=40000.25, amount=None)
    native.ws.emit('message', dict(event='data', channel='indices', data=payload))
    native.emit.assert_called_once_with('fubon_index', payload)
    assert native.adapter.last_indices['IX0001'] == payload


def test_index_rejects_non_index_identity_before_socket_subscribe(native):
    native.ticker.side_effect = None
    native.ticker.return_value = dict(type='EQUITY', symbol='2330')
    with pytest.raises(ValueError, match='指數'):
        native.adapter.subscribe_index(lease(symbol='2330'))
    native.ws.subscribe.assert_not_called()


def test_index_subscription_cap_does_not_evict_existing_owners(native):
    for i in range(24):
        native.adapter.subscribe_index(lease(f'qa-index-lease-{i:04d}', f'IX{i:04d}'))
    owners = deepcopy(native.adapter.leases)
    with pytest.raises(ValueError, match='上限'):
        native.adapter.subscribe_index(lease('qa-index-overflow-0025', 'IX9999'))
    assert native.adapter.leases == owners
    assert native.ws.subscribe.call_count == 24


def test_index_native_subscribe_failure_does_not_publish_a_lease(native):
    native.ws.subscribe.side_effect = RuntimeError('synthetic socket unavailable')
    with pytest.raises(RuntimeError):
        native.adapter.subscribe_index(lease())
    assert native.adapter.leases == {} and native.adapter.index_pending == set()


# Critical edge cases intentionally assert the intended safety contract, not
# today's implementation. Failures are reported to the implementation owner.
def test_dualleg_rejects_continuous_alias_before_any_native_write(native):
    with pytest.raises(ValueError, match='具體|連續'):
        native.adapter.action(action(native, 'dualleg_place',
            legs=[dict(symbol='TXFR1', quantity=1), dict(symbol='TXFL6', quantity=1)]))
    assert write_count(native) == 0


def test_dualleg_rejects_conflicting_leg_quantities_instead_of_silently_changing_intent(native):
    with pytest.raises((ValueError, ValidationError), match='數量|口數|兩腳'):
        native.adapter.action(action(native, 'dualleg_place', quantity=1,
            legs=[dict(symbol='TXFK6', quantity=1), dict(symbol='TXFL6', quantity=2)]))
    assert write_count(native) == 0


def test_index_old_socket_late_ack_cannot_claim_new_socket_subscription(native):
    old = native.ws
    native.adapter.subscribe_index(lease())
    old.emit('disconnect')
    native.broker.connected_sockets.clear()
    replacement = FakeSocket()
    native.broker.sockets['stock'] = replacement
    native.adapter.subscribe_index(lease())
    ack(old, ident='retired-native-id')
    assert native.adapter.index_ids.get('IX0001') != 'retired-native-id'
    ack(replacement, ident='current-native-id')
    native.adapter.unsubscribe_index('qa-index-lease-0001')
    replacement.unsubscribe.assert_called_once_with(dict(id='current-native-id'))


def test_index_expired_unacknowledged_lease_does_not_leave_pending_registry_leak(native, monkeypatch):
    import fubon_bridge.native_panels as module
    clock = [0.0]
    monkeypatch.setattr(module.time, 'monotonic', lambda: clock[0])
    native.adapter.subscribe_index(lease())
    clock[0] = 91
    native.adapter.expire_indices()
    assert native.adapter.leases == {} and native.adapter.index_pending == set()
    ack(native.ws)
    native.ws.unsubscribe.assert_called_once_with(dict(id='native-index-1'))


def test_index_subscribe_returns_real_quote_baseline_without_waiting_for_socket_frame(native):
    result = native.adapter.subscribe_index(lease())
    assert result['baseline'] is not None
    assert '40000.25' in str(result['baseline'])
