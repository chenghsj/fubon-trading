"""Offline SDK value QA: constants are real; sessions, responses and HTTP are fake."""
from datetime import date, datetime
from decimal import Decimal
from enum import Enum
import importlib
import json
import sys
from types import ModuleType, SimpleNamespace as NS
from unittest.mock import Mock

import pytest
from fastapi.testclient import TestClient

from fubon_bridge.app import create_app
from fubon_bridge.broker import Broker
from fubon_bridge.config import Config
from fubon_bridge.keychain import Keychain
from fubon_bridge.mapping import TAIPEI
from fubon_bridge.native_models import NativeQuery
from fubon_bridge.native_panels import NativePanels, native_json, result_view
from fubon_bridge.passkeys import PasskeyStore
from fubon_bridge.research import ResearchStore


try:
    constants = importlib.import_module('fubon_neo.constant')
except ImportError:
    constants = None


def constant_members():
    if constants is None:
        return [pytest.param(None, None, None, marks=pytest.mark.skip(reason='native SDK constants unavailable'))]
    rows = []
    for group_name, group in vars(constants).items():
        if group_name.startswith('_') or not isinstance(group, type):
            continue
        for member_name, member in vars(group).items():
            if not member_name.startswith('_') and type(member) is group:
                rows.append(pytest.param(group_name, member_name, member, id=group_name + '.' + member_name))
    assert rows, 'Installed constant module must expose native members'
    return rows


@pytest.fixture(autouse=True)
def forbid_connections(monkeypatch):
    # Importing constants does not import sdk. Any later lazy SDK constructor is a hard failure.
    constructor = Mock(side_effect=AssertionError('SDK construction forbidden in offline serializer QA'))
    sdk_module = ModuleType('fubon_neo.sdk')
    sdk_module.FubonSDK = constructor
    monkeypatch.setitem(sys.modules, 'fubon_neo.sdk', sdk_module)
    credentials = Mock(side_effect=AssertionError('Credentials forbidden in offline serializer QA'))
    monkeypatch.setattr(Config, 'with_credentials', credentials)
    methods = []
    for name in ('read', 'write', 'delete'):
        denied = Mock(side_effect=AssertionError('Keychain forbidden in offline serializer QA'))
        monkeypatch.setattr(Keychain, name, denied)
        methods.append(denied)
    yield
    constructor.assert_not_called()
    credentials.assert_not_called()
    for denied in methods:
        denied.assert_not_called()


@pytest.fixture
def sdk_constants():
    if constants is None:
        pytest.skip('native SDK constants unavailable')
    return constants


@pytest.mark.parametrize('group,member,value', constant_members())
def test_every_installed_native_constant_serializes_to_its_exact_public_member_name(group, member, value):
    assert native_json(value) == member
    assert native_json(NS(value=value)) == {'value': member}
    assert json.loads(json.dumps(native_json({'nested': [value]}), allow_nan=False)) == {'nested': [member]}


def test_regression_values_really_are_builtin_extension_objects_without_enum_name(sdk_constants):
    for value in (sdk_constants.BSAction.Buy, sdk_constants.TimeInForce.IOC,
                  sdk_constants.FutOptMarketType.FutureNight, sdk_constants.FutOptOrderType.Auto):
        assert not isinstance(value, Enum)
        assert not hasattr(value, 'name')
        assert native_json(value) in {'Buy', 'IOC', 'FutureNight', 'Auto'}


@pytest.mark.parametrize('text', [
    '0', '-0.00', '0.000000000000000000001', '12345678901234567890.123456789012345678901',
    '-12345678901234567890.123456789012345678901', '1E+1000', '1.2300',
])
def test_finite_decimal_is_an_exact_json_string_without_float_rounding(text):
    value = Decimal(text)
    assert native_json(value) == str(value)
    assert native_json(NS(price=value)) == {'price': str(value)}
    assert json.loads(json.dumps(result_view([NS(price=value)], 'order_history'), allow_nan=False))['rows'][0]['price'] == str(value)


@pytest.mark.parametrize('text', ['NaN', 'sNaN', 'Infinity', '-Infinity', 'NaN123'])
def test_nonfinite_decimal_is_rejected_before_json_output(text):
    with pytest.raises(ValueError, match='無效數值'):
        native_json({'details': [NS(price=Decimal(text))]})


@pytest.mark.parametrize('value', [float('nan'), float('inf'), float('-inf')])
def test_existing_nonfinite_float_rejection_remains(value):
    with pytest.raises(ValueError, match='無效數值'):
        native_json([NS(price=value)])


def test_python_enums_primitives_null_and_zero_keep_their_existing_meaning():
    class Action(Enum):
        Sell = 2
    value = dict(action=Action.Sell, zero=0, false=False, missing=None, empty='',
                 at=datetime(2026, 11, 17, 15, 0, tzinfo=TAIPEI), day=date(2026, 11, 17))
    assert native_json(value) == dict(action='Sell', zero=0, false=False, missing=None, empty='',
        at='2026-11-17T15:00:00+08:00', day='2026-11-17')


def test_arbitrary_equal_object_is_not_misclassified_as_a_whitelisted_sdk_constant(sdk_constants):
    class EqualToAnything:
        label = 'ordinary response field'
        def __eq__(self, other):
            return True
    value = EqualToAnything()
    assert value == sdk_constants.BSAction.Buy
    assert native_json(value) == {'label': 'ordinary response field'}


def test_nested_native_order_account_values_preserve_structure_and_remove_secrets(sdk_constants):
    payload = NS(account=NS(account='OFFLINE-F', branch_no='QA-F', person_id='synthetic-person'),
        order_result=NS(buy_sell=sdk_constants.BSAction.Sell, time_in_force=sdk_constants.TimeInForce.IOC,
            market_type=sdk_constants.FutOptMarketType.FutureNight, order_type=sdk_constants.FutOptOrderType.Auto,
            price=Decimal('25000.123456789012345678901'), filled_qty=0, error_message=None,
            details=[{'side': sdk_constants.BSAction.Buy, 'tax': Decimal('0.00'), 'TOKEN': 'synthetic-token'}]),
        API_KEY='synthetic-api-key', cert_password='synthetic-password')
    serialized = native_json(payload)
    assert serialized['account'] == dict(account='OFFLINE-F', branch_no='QA-F')
    assert serialized['order_result'] == dict(buy_sell='Sell', time_in_force='IOC', market_type='FutureNight',
        order_type='Auto', price='25000.123456789012345678901', filled_qty=0, error_message=None,
        details=[dict(side='Buy', tax='0.00')])
    encoded = json.dumps(serialized, allow_nan=False)
    assert 'synthetic-' not in encoded
    assert 'OFFLINE-F' in encoded


@pytest.mark.parametrize('kind', ['list', 'dict', 'object', 'deep'])
def test_cycles_and_excessively_deep_responses_still_fail_closed(kind):
    if kind == 'list':
        value = []
        value.append(value)
    elif kind == 'dict':
        value = {}
        value['self'] = value
    elif kind == 'object':
        value = NS()
        value.self = value
    else:
        value = 'leaf'
        for _ in range(20):
            value = {'next': value}
    with pytest.raises(ValueError, match='過深'):
        native_json(value)


@pytest.fixture
def history(sdk_constants, monkeypatch):
    import fubon_bridge.native_panels as module
    monkeypatch.setattr(module, 'now', lambda: datetime(2026, 11, 17, 20, 0, tzinfo=TAIPEI))
    broker = Broker(Config(mode='paper', session='afterhours'),
                    sdk_factory=Mock(side_effect=AssertionError('SDK construction forbidden')))
    raw_s = NS(branch_no='QA-S', account='OFFLINE-S', person_id='synthetic-person')
    raw_f = NS(branch_no='QA-F', account='OFFLINE-F', person_id='synthetic-person')
    broker.accounts_raw = {('S', 'QA-S', 'OFFLINE-S'): raw_s, ('F', 'QA-F', 'OFFLINE-F'): raw_f}
    def row(raw, future):
        return NS(account=raw, order_no='offline-order', buy_sell=sdk_constants.BSAction.Sell,
            time_in_force=sdk_constants.TimeInForce.IOC,
            market_type=sdk_constants.FutOptMarketType.FutureNight if future else sdk_constants.MarketType.Common,
            order_type=sdk_constants.FutOptOrderType.Auto if future else sdk_constants.OrderType.Stock,
            price=Decimal('25000.123456789012345678901'), filled_qty=0, quantity=1, error_message=None,
            details=[NS(buy_sell=sdk_constants.BSAction.Buy, price=Decimal('0.000000000000000000001'), token='synthetic-token')],
            api_key='synthetic-api-key')
    stock = Mock(return_value=NS(is_success=True, data=[row(raw_s, False)], message=None))
    future = Mock(return_value=NS(is_success=True, data=[row(raw_f, True)], message=None))
    write = Mock(side_effect=AssertionError('No trading writes in history QA'))
    broker.sdk = NS(stock=NS(order_history=stock, place_order=write),
                    futopt=NS(order_history=future, place_order=write), shutdown=Mock())
    broker.connect = Mock(side_effect=AssertionError('No broker connection in history QA'))
    broker.place = write
    broker.mutate = write
    yield NS(broker=broker, panel=NativePanels(broker), stock=stock, future=future, raw_s=raw_s, raw_f=raw_f)
    write.assert_not_called()
    broker.connect.assert_not_called()
    broker.sdk_factory.assert_not_called()


def history_query(kind):
    return NativeQuery(operation='order_history', account=dict(account_type=kind, broker_id='QA-' + kind,
        account_id='OFFLINE-' + kind), start='2026-11-17', end='2026-11-17')


def assert_history(view, kind):
    row = view['rows'][0]
    assert view['operation'] == 'order_history' and view['source'] == 'fubon'
    assert row['buy_sell'] == 'Sell'
    assert row['time_in_force'] == 'IOC'
    assert row['market_type'] == ('FutureNight' if kind == 'F' else 'Common')
    assert row['order_type'] == ('Auto' if kind == 'F' else 'Stock')
    assert row['price'] == '25000.123456789012345678901'
    assert row['filled_qty'] == 0 and row['error_message'] is None
    assert row['account.account'] == 'OFFLINE-' + kind
    assert row['details'] == [dict(buy_sell='Buy', price=str(Decimal('0.000000000000000000001')))]
    assert view['detail_keys'] == ['details']
    assert 'synthetic-' not in json.dumps(view, allow_nan=False)


@pytest.mark.parametrize('kind', ['S', 'F'])
def test_real_sdk_constants_flow_through_native_panels_order_history(history, kind):
    view = history.panel.query(history_query(kind))
    assert_history(view, kind)
    source, raw = (history.stock, history.raw_s) if kind == 'S' else (history.future, history.raw_f)
    source.assert_called_once_with(raw, '20261117', '20261117')


@pytest.mark.parametrize('kind', ['S', 'F'])
def test_real_sdk_constants_and_decimal_flow_through_authenticated_history_http(history, tmp_path, kind):
    app = create_app(Config(mode='demo'), research_store=ResearchStore(tmp_path / 'research.db'),
                     passkey_store=PasskeyStore(tmp_path / 'passkeys.db'),
                     sdk_factory=Mock(side_effect=AssertionError('SDK construction forbidden')))
    app.state.native_panels.broker = history.broker
    with TestClient(app) as client:
        body = history_query(kind).model_dump(mode='json')
        assert client.post('/api/v1/native/query', json=body).status_code == 401
        client.headers['Authorization'] = 'Bearer ' + app.state.session.issue()
        response = client.post('/api/v1/native/query', json=body)
        assert response.status_code == 200, response.text
        assert_history(response.json(), kind)
    assert app.state.broker.sdk is None


@pytest.mark.parametrize('secret', ['password', 'cert_password', 'api_key', 'secret', 'token', 'sdk_token', 'bearer_token', 'personal_id', 'person_id'])
def test_private_fields_are_removed_from_both_native_objects_and_nested_dicts(secret):
    payload = NS(public=0, **{secret.upper(): 'synthetic-private'}, details=[{secret: 'synthetic-private', 'price': Decimal('0.00')}])
    assert native_json(payload) == {'public': 0, 'details': [{'price': '0.00'}]}
