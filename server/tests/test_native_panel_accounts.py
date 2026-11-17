"""Native account-panel QA using documented fixtures, with no SDK imports or I/O."""
from copy import deepcopy
from datetime import date, datetime, timedelta
from enum import Enum
from types import SimpleNamespace as NS
from unittest.mock import Mock

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from fubon_bridge.app import create_app
from fubon_bridge.broker import Broker
from fubon_bridge.config import Config
from fubon_bridge.mapping import TAIPEI
from fubon_bridge.native_models import NativeQuery
from fubon_bridge.native_panels import NativePanels, native_json, result_view
from fubon_bridge.passkeys import PasskeyStore


TODAY = date(2026, 11, 17)
AT = datetime(2026, 11, 17, 14, 0, tzinfo=TAIPEI)
STOCK = dict(account_type='S', broker_id='QA-S', account_id='READ-S')
FUTURE = dict(account_type='F', broker_id='QA-F', account_id='READ-F')
SECOND = dict(account_type='S', broker_id='QA-S', account_id='OTHER-S')
LOCAL = dict(account_type='S', broker_id='LOCAL', account_id='PAPER-S')
ACCOUNT_OPS = ('credit_margin', 'credit_daytrade', 'settlements', 'realized',
               'close_records', 'maintenance', 'conditions', 'condition_history',
               'trails', 'trail_history', 'condition_by_id', 'order_history',
               'batch_lists', 'batch_detail')


def ok(payload):
    return NS(is_success=True, data=deepcopy(payload), message=None)


def condition_row():
    child = dict(guid='child-guid', condition_content='原生子條件',
                 condition_price='市價(IOC)', condition_volume='5張',
                 condition_filled_volume='0張', status='條件比對中(W)',
                 error_message=None)
    return NS(guid='parent-guid', parent_guid=None, condition_type='多條件',
              condition_content='成交價大於等於580元 全部成交為止',
              condition_price='580元(ROD)', condition_volume='5張',
              condition_filled_volume='0張', status='未生效(W)',
              detail_records_count='1', detail_records=[child],
              TPSLCount='1', TPSLRecord=[dict(child, guid='tpsl-guid')],
              error_message=None)


@pytest.fixture
def native(monkeypatch):
    import fubon_bridge.native_panels as module
    monkeypatch.setattr(module, 'now', lambda: AT)
    broker = Broker(Config(mode='paper'), sdk_factory=Mock(side_effect=AssertionError('SDK initialization forbidden')))
    raw_s, raw_f, raw_other = NS(marker='raw-s'), NS(marker='raw-f'), NS(marker='raw-other')
    broker.accounts_raw = {
        ('S', 'QA-S', 'READ-S'): raw_s,
        ('F', 'QA-F', 'READ-F'): raw_f,
        ('S', 'QA-S', 'OTHER-S'): raw_other,
    }
    rows = [condition_row()]
    batch = NS(function_type=0, date='2026/11/17', branch_no='QA-S',
               account='READ-S', batch_seq_no='batch-owned-by-read-s')
    stock = NS(
        margin_quota=Mock(return_value=ok(NS(stock_no='2330', date='2026/11/17',
            shortsell_orig_quota=0, shortsell_tradable_quota=0,
            margin_orig_quota=None, margin_tradable_quota=None,
            margin_ratio=60, short_ratio=None))),
        daytrade_and_stock_info=Mock(return_value=ok(NS(stock_no='2330', date='2026/11/17',
            daytrade_orig_quota=0, daytrade_tradable_quota=0, precollect_single=None,
            precollect_accumulate=None, status=15, disposition_status='{"MARK-W":1}'))),
        get_condition_order=Mock(return_value=ok(rows)),
        get_condition_history=Mock(return_value=ok(rows)),
        get_condition_order_by_id=Mock(return_value=ok(rows)),
        get_trail_order=Mock(return_value=ok(rows)),
        get_trail_history=Mock(return_value=ok(rows)),
        order_history=Mock(return_value=ok([NS(order_no='stock-order', price=100,
            quantity=1000, filled_qty=0, status=10,
            details=[NS(function_type=15, modified_time='13:00:00.001', before_qty=1000, after_qty=1000)])])),
        batch_order_lists=Mock(return_value=NS(is_success=True, data=[batch], message=None)),
        batch_order_detail=Mock(return_value=ok([NS(order_no='batch-order', status=90, error_message='原生逐筆拒絕')]))
    )
    futopt = NS(**{method: Mock(return_value=ok(rows)) for method in (
        'get_condition_order', 'get_condition_history', 'get_condition_order_by_id',
        'get_trail_order', 'get_trail_history')},
        order_history=Mock(return_value=ok([NS(order_no='spread-order', symbol='TXO',
            symbol_leg2='TXO', expiry_date_leg2='202611', strike_price_leg2=25000,
            call_put_leg2='Put', buy_sell_leg2='Buy', details=[])])))
    accounting = NS(
        query_settlement=Mock(return_value=ok(NS(account=NS(branch_no='QA-S', account='READ-S'), details=[
            NS(date='2026/11/17', settlement_date='2026/11/19', buy_settlement=-200,
               sell_settlement=100, total_settlement_amount=-100, currency='TWD'),
            NS(date='2026/11/18', settlement_date=None, buy_settlement=None,
               sell_settlement=None, total_settlement_amount=None, currency=None)]))),
        realized_gains_and_loses=Mock(return_value=ok([
            NS(date='2026/11/16', stock_no='OLD', filled_qty=1000, filled_price=100,
               realized_profit=0, realized_loss=20),
            NS(date='20261117', stock_no='2330', filled_qty=500, filled_price=100,
               realized_profit=30, realized_loss=0)])),
        maintenance=Mock(return_value=ok(NS(date='2026/11/17',
            maintenance_summary=NS(margin_value=1000, shortsell_value=0,
                shortsell_margin=0, collateral=None, margin_loan_amt=500, maintenance_ratio=200.0),
            maintenance_detail=[NS(stock_no='2330', quantity=1000, price=100,
                cost_price=95, maintenance_ratio=200.0, margin_interest=None)])))
    )
    fut_accounting = NS(close_position_record=Mock(return_value=ok([
        NS(date='2026/11/17', position_kind=1, symbol='FITX', expiry_date='202611',
           strike_price=None, call_put=None, buy_sell='Buy', price=25000,
           orig_lots=2, transaction_fee=40, tax=20)])))
    broker.sdk = NS(stock=stock, futopt=futopt, accounting=accounting,
                    futopt_accounting=fut_accounting)
    adapter = NativePanels(broker)
    adapter.dto_loader = lambda kind, group, name: f'{group}.{name}'
    return NS(adapter=adapter, broker=broker, stock=stock, futopt=futopt,
              accounting=accounting, fut_accounting=fut_accounting,
              raw_s=raw_s, raw_f=raw_f, raw_other=raw_other, batch=batch)


def query(operation, account=STOCK, **values):
    return NativeQuery(operation=operation, account=account, **values)


def read_calls(native):
    return sum(method.call_count for group in (native.stock, native.futopt,
        native.accounting, native.fut_accounting) for method in vars(group).values())


def test_native_read_accounts_are_explicit_and_do_not_replace_paper_trading_accounts(native):
    before = native.broker.account_rows()
    rows = native.adapter.accounts()
    assert {(r['account_type'], r['broker_id'], r['account_id']) for r in rows} == set(native.broker.accounts_raw)
    assert all(r['environment'] == 'production-readonly' for r in rows)
    assert all(r['source'] == 'fubon' for r in rows)
    assert native.broker.account_rows() == before
    assert all(row['broker_id'] == 'LOCAL' for row in before)
    assert read_calls(native) == 0
    native.broker.sdk_factory.assert_not_called()


@pytest.mark.parametrize('operation', ACCOUNT_OPS)
@pytest.mark.parametrize('selector', [None, LOCAL,
    dict(account_type='S', broker_id='FOREIGN', account_id='READ-S'),
    dict(account_type='S', broker_id='QA-S', account_id='MISSING')])
def test_native_account_queries_reject_missing_local_and_unreturned_selectors_before_dispatch(native, operation, selector):
    with pytest.raises(ValueError, match='帳戶'):
        native.adapter.query(query(operation, selector, symbol='2330'))
    assert read_calls(native) == 0


@pytest.mark.parametrize('operation', ['credit_margin', 'credit_daytrade', 'settlements', 'realized', 'maintenance', 'batch_lists', 'batch_detail'])
def test_stock_native_queries_reject_future_accounts(native, operation):
    with pytest.raises(ValueError, match='查詢市場'):
        native.adapter.query(query(operation, FUTURE, symbol='2330'))
    assert read_calls(native) == 0


def test_close_records_reject_stock_account(native):
    with pytest.raises(ValueError, match='查詢市場'):
        native.adapter.query(query('close_records', STOCK, start=TODAY, end=TODAY))
    assert read_calls(native) == 0


def test_credit_null_unlimited_suspended_and_zero_are_preserved(native):
    view = native.adapter.query(query('credit_margin', symbol='2330'))
    native.stock.margin_quota.assert_called_once_with(native.raw_s, '2330')
    row = view['rows'][0]
    assert row['margin_tradable_quota'] is None and row['shortsell_tradable_quota'] == 0
    assert row['short_ratio'] is None and row['margin_ratio'] == 60
    assert 'null' in view['note'] and view['source'] == 'fubon'
    assert {'margin_tradable_quota', 'shortsell_tradable_quota'} <= {c['key'] for c in view['columns']}


def test_daytrade_bitmask_and_json_string_are_not_fabricated_into_boolean_or_dates(native):
    row = native.adapter.query(query('credit_daytrade', symbol='2330'))['rows'][0]
    assert row['status'] == 15 and isinstance(row['status'], int)
    assert row['disposition_status'] == '{"MARK-W":1}'
    assert row['precollect_single'] is None and row['precollect_accumulate'] is None
    native.stock.daytrade_and_stock_info.assert_called_once_with(native.raw_s, '2330')


@pytest.mark.parametrize('operation', ['credit_margin', 'credit_daytrade'])
def test_credit_queries_require_symbol_before_native_call(native, operation):
    with pytest.raises(ValueError, match='商品代號'):
        native.adapter.query(query(operation))
    assert read_calls(native) == 0


@pytest.mark.parametrize('settlement_range', ['0d', '3d'])
def test_settlement_object_details_keep_lookup_and_actual_settlement_dates_distinct(native, settlement_range):
    view = native.adapter.query(query('settlements', settlement_range=settlement_range))
    native.accounting.query_settlement.assert_called_once_with(native.raw_s, settlement_range)
    assert len(view['rows']) == 2
    assert view['rows'][0]['date'] == '2026/11/17'
    assert view['rows'][0]['settlement_date'] == '2026/11/19'
    assert view['rows'][1]['total_settlement_amount'] is None
    assert view['rows'][1]['settlement_date'] is None
    assert not any(c['key'].startswith('account.') for c in view['columns'])


def test_maintenance_summary_object_and_detail_list_remain_separate(native):
    view = native.adapter.query(query('maintenance'))
    native.accounting.maintenance.assert_called_once_with(native.raw_s)
    assert view['summary']['maintenance_ratio'] == 200.0
    assert view['summary']['collateral'] is None
    assert view['rows'][0]['margin_interest'] is None
    assert view['metadata']['date'] == '2026/11/17'
    assert view['rows'][0]['stock_no'] == '2330'


def test_realized_dates_filter_only_returned_rows_without_pretending_provider_date_arguments(native):
    view = native.adapter.query(query('realized', start=TODAY, end=TODAY))
    native.accounting.realized_gains_and_loses.assert_called_once_with(native.raw_s)
    assert len(view['rows']) == 1 and view['rows'][0]['stock_no'] == '2330'
    assert view['rows'][0]['filled_qty'] == 500
    assert view['rows'][0]['realized_profit'] == 30
    assert '未保證' in view['note']


def test_realized_without_filter_preserves_all_provider_records(native):
    assert len(native.adapter.query(query('realized'))['rows']) == 2


def test_close_records_preserve_original_lots_and_do_not_invent_pnl(native):
    view = native.adapter.query(query('close_records', FUTURE, start=TODAY, end=TODAY))
    native.fut_accounting.close_position_record.assert_called_once_with(native.raw_f, '20261117', '20261117')
    row = view['rows'][0]
    assert row['orig_lots'] == 2 and row['strike_price'] is None
    assert 'pnl' not in row and 'entry_price' not in row
    assert '未提供逐筆損益' in view['note']


@pytest.mark.parametrize('operation,method,history', [
    ('conditions', 'get_condition_order', False),
    ('condition_history', 'get_condition_history', True),
    ('condition_by_id', 'get_condition_order_by_id', False),
    ('trails', 'get_trail_order', False),
    ('trail_history', 'get_trail_history', True),
])
@pytest.mark.parametrize('selector,session', [(STOCK, 'regular'), (FUTURE, 'regular'), (FUTURE, 'afterhours')])
def test_condition_reads_use_selected_raw_account_native_signatures_and_preserve_children(native, operation, method, history, selector, session):
    args = dict(session=session, guid='parent-guid')
    if history:
        args.update(start=TODAY-timedelta(days=1), end=TODAY)
    view = native.adapter.query(query(operation, selector, **args))
    client, raw = (native.stock, native.raw_s) if selector['account_type'] == 'S' else (native.futopt, native.raw_f)
    positional = (raw, '20261116', '20261117') if history else (raw, 'parent-guid') if operation == 'condition_by_id' else (raw,)
    kwargs = {} if selector['account_type'] == 'S' else dict(market_type='FutOptConditionMarketType.'+('FutureNight' if session == 'afterhours' else 'Future'))
    getattr(client, method).assert_called_once_with(*positional, **kwargs)
    assert len(view['rows']) == 1  # By-ID also returns a native list.
    row = view['rows'][0]
    assert row['condition_price'] == '580元(ROD)' and row['condition_volume'] == '5張'
    assert row['status'] == '未生效(W)' and row['parent_guid'] is None
    assert row['TPSLCount'] == '1' and row['TPSLRecord'][0]['guid'] == 'tpsl-guid'
    assert row['detail_records'][0]['condition_price'] == '市價(IOC)'
    assert set(view['detail_keys']) == {'detail_records', 'TPSLRecord'}
    assert not {'detail_records', 'TPSLRecord'} & {c['key'] for c in view['columns']}


@pytest.mark.parametrize('operation', ['close_records', 'condition_history', 'trail_history', 'order_history'])
def test_required_read_dates_are_rejected_before_native_method(native, operation):
    with pytest.raises(ValueError, match='日期'):
        native.adapter.query(query(operation, FUTURE))
    assert read_calls(native) == 0


def test_by_id_requires_guid(native):
    with pytest.raises(ValueError, match='條件單號'):
        native.adapter.query(query('condition_by_id'))
    assert read_calls(native) == 0


@pytest.mark.parametrize('selector', [STOCK, FUTURE])
def test_order_history_preserves_native_detail_and_second_leg(native, selector):
    view = native.adapter.query(query('order_history', selector, start=TODAY, end=TODAY))
    source, raw = (native.stock, native.raw_s) if selector['account_type'] == 'S' else (native.futopt, native.raw_f)
    source.order_history.assert_called_once_with(raw, '20261117', '20261117')
    if selector['account_type'] == 'S':
        assert view['rows'][0]['details'][0]['modified_time'] == '13:00:00.001'
    else:
        assert view['rows'][0]['symbol_leg2'] == 'TXO'
        assert view['rows'][0]['strike_price_leg2'] == 25000


@pytest.mark.parametrize('selector,start,end', [
    (STOCK, TODAY-timedelta(days=30), TODAY),
    (FUTURE, TODAY-timedelta(days=2), TODAY),
    (FUTURE, TODAY, TODAY+timedelta(days=1)),
])
def test_history_rejects_outside_official_ranges_before_dispatch(native, selector, start, end):
    with pytest.raises(ValueError, match='歷史'):
        native.adapter.query(query('order_history', selector, start=start, end=end))
    assert read_calls(native) == 0


def test_batch_detail_accepts_only_object_returned_for_selected_account(native):
    view = native.adapter.query(query('batch_detail', batch_id='batch-owned-by-read-s'))
    native.stock.batch_order_lists.assert_called_once_with(native.raw_s)
    native.stock.batch_order_detail.assert_called_once_with(native.raw_s, native.batch)
    assert view['rows'][0]['status'] == 90
    assert view['rows'][0]['error_message'] == '原生逐筆拒絕'
    assert '不等於最新委託狀態' in view['note']


@pytest.mark.parametrize('batch_id', ['', 'batch-owned-by-other-account'])
def test_batch_detail_rejects_unreturned_batch_id(native, batch_id):
    with pytest.raises(ValueError, match='此帳戶'):
        native.adapter.query(query('batch_detail', batch_id=batch_id))
    native.stock.batch_order_detail.assert_not_called()


def test_duplicate_batch_identifiers_are_not_ambiguously_selected(native):
    native.stock.batch_order_lists.return_value = ok([native.batch, native.batch])
    with pytest.raises(ValueError, match='此帳戶'):
        native.adapter.query(query('batch_detail', batch_id='batch-owned-by-read-s'))
    native.stock.batch_order_detail.assert_not_called()


def test_another_returned_account_is_passed_as_its_own_raw_identity(native):
    native.adapter.query(query('maintenance', SECOND))
    native.accounting.maintenance.assert_called_once_with(native.raw_other)


@pytest.mark.parametrize('values', [
    dict(start='2026-11-17'), dict(end='2026-11-17'),
    dict(start='2026-11-18', end='2026-11-17'),
    dict(start='2020-01-01', end='2026-11-17'),
    dict(start='not-date', end='2026-11-17'),
    dict(settlement_range='30d'), dict(symbol='../2330'),
    dict(guid='../../foreign'), dict(operation='__getattribute__'),
    dict(sdk_method='place_order'),
])
def test_read_dto_rejects_invalid_dates_ranges_and_method_injection(values):
    with pytest.raises(ValidationError):
        NativeQuery.model_validate(dict(operation='maintenance', account=STOCK) | values)


def test_empty_valid_native_lists_remain_empty_not_zero_rows(native):
    native.stock.get_condition_order.return_value = ok([])
    view = native.adapter.query(query('conditions'))
    assert view['rows'] == [] and view['columns'] == [] and view['summary'] == {}


def test_native_failures_are_not_converted_to_empty_success(native):
    native.accounting.maintenance.return_value = NS(is_success=False, data=None, message='synthetic permission denial')
    with pytest.raises(ValueError, match='synthetic permission denial'):
        native.adapter.query(query('maintenance'))


def test_serializer_preserves_null_non_numeric_status_and_native_enum_without_secrets():
    class Action(Enum):
        Sell = 2
    payload = NS(data=[NS(price=None, status='未生效(W)', side=Action.Sell,
                         detail_records=[dict(condition_volume='5張', token='synthetic-private')])],
                 api_key='synthetic-private', date=TODAY)
    view = result_view(payload, 'conditions')
    assert view['rows'][0]['price'] is None and view['rows'][0]['side'] == 'Sell'
    assert view['rows'][0]['status'] == '未生效(W)'
    assert view['metadata']['date'] == '2026-11-17'
    assert view['rows'][0]['detail_records'] == [dict(condition_volume='5張')]
    assert 'synthetic-private' not in str(view)


@pytest.mark.parametrize('bad', [float('nan'), float('inf'), float('-inf')])
def test_non_finite_native_data_is_rejected_instead_of_becoming_json_numbers(bad):
    with pytest.raises(ValueError, match='無效數值'):
        native_json(NS(price=bad))


@pytest.fixture
def http(native, tmp_path):
    # The app itself remains demo; only this route's account adapter receives
    # the fake connected Paper broker. No login, SDK import or network seam.
    app = create_app(Config(mode='demo'), passkey_store=PasskeyStore(tmp_path/'native-qa-passkeys.sqlite3'))
    app.state.native_panels.broker = native.broker
    app.state.native_panels.dto_loader = native.adapter.dto_loader
    with TestClient(app, raise_server_exceptions=False) as client:
        yield client


def authorize(client):
    client.headers['Authorization'] = 'Bearer '+client.app.state.session.issue()


def test_http_native_account_list_and_queries_require_session(http, native):
    assert http.get('/api/v1/native/accounts').status_code == 401
    assert http.post('/api/v1/native/query', json=dict(operation='maintenance', account=STOCK)).status_code == 401
    assert read_calls(native) == 0
    authorize(http)
    response = http.get('/api/v1/native/accounts')
    assert response.status_code == 200
    assert {r['account_id'] for r in response.json()} == {'READ-S', 'READ-F', 'OTHER-S'}
    assert 'marker' not in response.text


@pytest.mark.parametrize('operation', ACCOUNT_OPS)
def test_http_all_account_read_operations_preserve_the_documented_envelope(http, native, operation):
    authorize(http)
    selector = FUTURE if operation == 'close_records' else STOCK
    body = dict(operation=operation, account=selector, symbol='2330',
                start=TODAY.isoformat(), end=TODAY.isoformat(), guid='parent-guid',
                batch_id='batch-owned-by-read-s')
    response = http.post('/api/v1/native/query', json=body)
    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload['operation'] == operation and payload['source'] == 'fubon'
    assert isinstance(payload['rows'], list) and isinstance(payload['columns'], list)
    assert isinstance(payload['metadata'], dict) and isinstance(payload['note'], str)
    assert 'fetched_at' in payload and 'detail_keys' in payload and 'summary' in payload
    assert read_calls(native) >= 1
    native.broker.sdk_factory.assert_not_called()


@pytest.mark.parametrize('override,status', [
    (dict(account=None), 400), (dict(account=LOCAL), 400),
    (dict(account=dict(account_type='F', broker_id='QA-F', account_id='READ-F')), 400),
    (dict(start='2026-11-18', end='2026-11-17'), 422),
    (dict(operation='sdk.stock.place_order'), 422),
    (dict(account=dict(STOCK, raw_account='client-controlled')), 422),
    (dict(sdk_method='place_order'), 422),
])
def test_http_invalid_selectors_dates_and_method_injection_never_reach_native(http, native, override, status):
    authorize(http)
    body = dict(operation='maintenance', account=STOCK) | override
    response = http.post('/api/v1/native/query', json=body)
    assert response.status_code == status, response.text
    assert read_calls(native) == 0


def test_http_native_query_keeps_origin_and_content_type_guards(http, native):
    authorize(http)
    body = dict(operation='maintenance', account=STOCK)
    assert http.post('/api/v1/native/query', json=body, headers={'Origin':'https://foreign.example'}).status_code == 403
    assert http.post('/api/v1/native/query', content='operation=maintenance').status_code == 415
    assert read_calls(native) == 0


def test_http_native_sdk_failure_is_rejected_without_exposing_its_message(http, native):
    authorize(http)
    native.accounting.maintenance.side_effect = RuntimeError('synthetic-keychain-path-and-identity')
    response = http.post('/api/v1/native/query', json=dict(operation='maintenance', account=STOCK))
    assert response.status_code == 502
    assert 'synthetic-keychain-path-and-identity' not in response.text
