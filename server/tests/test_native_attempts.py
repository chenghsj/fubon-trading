"""Durable ambiguity/reconciliation QA: temporary SQLite and fake writes only."""
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
import threading

from fastapi import HTTPException
from fastapi.testclient import TestClient
from pydantic import ValidationError
import pytest

from fubon_bridge.app import create_app
from fubon_bridge.config import Config
from fubon_bridge.native_attempts import NativeAttempts
from fubon_bridge.native_models import NativeAccount, NativeReconcile
from fubon_bridge.native_panels import NativePanels
from fubon_bridge.passkeys import PasskeyStore
from fubon_bridge.research import ResearchStore
from test_native_panel_actions import (
    FUTURE, STOCK, action, fail, native, ok, prohibit_external_access, write_count,
)


@pytest.fixture
def ledger(tmp_path):
    return NativeAttempts(ResearchStore(tmp_path/'native-attempt-qa.sqlite3'))


@pytest.fixture
def durable(native, ledger):
    native.adapter.attempts = ledger
    return native


def acknowledge(native, request, selector=None, **values):
    return NativeReconcile.model_validate(dict(account=selector or STOCK,
        request_id=request.request_id, instance_id=native.broker.instance_id,
        acknowledgement='已於券商核對此請求') | values)


@pytest.mark.parametrize('state', ['pending', 'uncertain'])
def test_durable_unknown_blocks_new_identifiers_after_store_restart(ledger, state):
    ledger.begin('production', 'request-a', 'account-s', 'condition_create', 'fingerprint-a')
    if state == 'uncertain':
        ledger.uncertain('production', 'request-a')
    restarted = NativeAttempts(ResearchStore(ledger.research.path))
    assert restarted.pending('production', 'account-s')[0]['status'] == state
    for ident in ('request-a', 'request-new-id'):
        with pytest.raises(HTTPException) as error:
            restarted.begin('production', ident, 'account-s', 'condition_create', 'fingerprint-a')
        assert error.value.status_code == 409
    assert len(restarted.pending('production', 'account-s')) == 1


def test_pending_is_durable_before_fake_write_is_invoked(durable):
    request = action(durable)
    account_key = durable.adapter._account_key(request.account)

    def inspect_before_acceptance(*args):
        independent = NativeAttempts(ResearchStore(durable.adapter.attempts.research.path))
        pending = independent.pending('sandbox', account_key)
        assert len(pending) == 1 and pending[0]['request_id'] == request.request_id
        assert pending[0]['status'] == 'pending'
        return ok()

    durable.stock.multi_condition.side_effect = inspect_before_acceptance
    durable.adapter.action(request)
    assert durable.adapter.attempts.pending('sandbox', account_key) == []
    assert write_count(durable) == 1


def test_timeout_blocks_fresh_intent_id_after_adapter_and_instance_restart(durable):
    request = action(durable)
    durable.stock.multi_condition.side_effect = TimeoutError('fake acceptance then lost response')
    with pytest.raises(TimeoutError):
        durable.adapter.action(request)
    assert write_count(durable) == 1
    durable.broker.instance_id = 'restarted-service-instance'
    restarted = NativePanels(durable.broker, NativeAttempts(ResearchStore(durable.adapter.attempts.research.path)))
    restarted.dto_loader = durable.adapter.dto_loader
    fresh = action(durable, request_id='different-request-after-restart')
    with pytest.raises(HTTPException) as error:
        restarted.action(fresh)
    assert error.value.status_code == 409 and write_count(durable) == 1
    assert restarted.pending_attempts(request.account)[0]['request_id'] == request.request_id


def test_unknown_is_account_and_environment_scoped(ledger):
    ledger.begin('production', 'request-a', 'account-s', 'condition_create', 'a')
    ledger.uncertain('production', 'request-a')
    assert ledger.begin('production', 'request-b', 'account-f', 'condition_create', 'b') is None
    assert ledger.begin('sandbox', 'request-a', 'account-s', 'condition_create', 'a') is None
    assert len(ledger.pending('production', 'account-s')) == 1
    assert len(ledger.pending('production', 'account-f')) == 1
    assert len(ledger.pending('sandbox', 'account-s')) == 1


def test_durable_complete_replay_returns_saved_result_without_new_write(ledger):
    result = dict(rows=[dict(guid='accepted-guid', price=None)], submitted=True)
    ledger.begin('production', 'request-a', 'account-s', 'condition_create', 'a')
    ledger.complete('production', 'request-a', result)
    restarted = NativeAttempts(ResearchStore(ledger.research.path))
    assert restarted.begin('production', 'request-a', 'account-s', 'condition_create', 'a') == result
    assert restarted.pending('production', 'account-s') == []
    with pytest.raises(HTTPException):
        restarted.begin('production', 'request-a', 'account-s', 'condition_create', 'changed-fingerprint')


def test_two_independent_store_instances_cannot_begin_two_ids_for_one_account(ledger):
    second = NativeAttempts(ResearchStore(ledger.research.path))
    barrier = threading.Barrier(2)

    def begin(store, ident):
        barrier.wait(timeout=2)
        try:
            store.begin('production', ident, 'account-s', 'condition_create', ident)
            return 'began'
        except HTTPException as error:
            return error.status_code

    with ThreadPoolExecutor(max_workers=2) as pool:
        a = pool.submit(begin, ledger, 'request-a')
        b = pool.submit(begin, second, 'request-b')
        assert sorted([str(a.result(timeout=3)), str(b.result(timeout=3))]) == ['409', 'began']
    assert len(ledger.pending('production', 'account-s')) == 1


def test_reconcile_clears_account_lock_but_permanently_retires_old_id(ledger):
    ledger.begin('production', 'old-request', 'account-s', 'condition_create', 'old')
    ledger.uncertain('production', 'old-request')
    ledger.reconcile('production', 'account-s', 'old-request')
    assert ledger.pending('production', 'account-s') == []
    with pytest.raises(HTTPException):
        ledger.begin('production', 'old-request', 'account-s', 'condition_create', 'old')
    assert ledger.begin('production', 'new-request', 'account-s', 'condition_create', 'new') is None


def test_reconcile_before_delayed_submission_creates_restart_safe_tombstone(ledger):
    ledger.reconcile('production', 'account-s', 'late-request')
    restarted = NativeAttempts(ResearchStore(ledger.research.path))
    with pytest.raises(HTTPException) as error:
        restarted.begin('production', 'late-request', 'account-s', 'condition_create', 'late')
    assert error.value.status_code == 409
    assert restarted.pending('production', 'account-s') == []
    restarted.reconcile('production', 'account-s', 'late-request')  # repeat acknowledgement is harmless


@pytest.mark.parametrize('state', ['pending', 'complete', 'verified'])
def test_reconcile_cannot_claim_another_accounts_request(ledger, state):
    ledger.begin('production', 'owned-request', 'account-s', 'condition_create', 'owned')
    if state == 'complete':
        ledger.complete('production', 'owned-request', dict(submitted=True))
    elif state == 'verified':
        ledger.reconcile('production', 'account-s', 'owned-request')
    with pytest.raises(ValueError, match='不屬於'):
        ledger.reconcile('production', 'account-f', 'owned-request')


def test_failed_plan_validation_creates_no_unknown_lock_and_allows_corrected_same_id(durable):
    request = action(durable, 'dualleg_place', FUTURE,
        legs=[dict(symbol='TXFK6', side='Buy', quantity=1), dict(symbol='TXFK6', side='Sell', quantity=1)])
    with pytest.raises(ValueError, match='同一契約'):
        durable.adapter.action(request)
    assert write_count(durable) == 0
    assert durable.adapter.pending_attempts(request.account) == []
    assert durable.adapter.actions == {}
    valid = action(durable, 'dualleg_place', FUTURE, request_id=request.request_id)
    assert durable.adapter.action(valid)['submitted'] is True


def test_failed_dto_construction_creates_no_durable_pending_record(durable):
    request = action(durable)
    durable.adapter.dto_loader = lambda *args: (_ for _ in ()).throw(TypeError('fake DTO rejection'))
    with pytest.raises(TypeError):
        durable.adapter.action(request)
    assert write_count(durable) == 0
    assert durable.adapter.pending_attempts(request.account) == []


def test_reconcile_then_delayed_native_action_never_dispatches(durable):
    request = action(durable)
    assert durable.adapter.reconcile(acknowledge(durable, request)) == dict(reconciled=True, submitted=False)
    with pytest.raises(HTTPException) as error:
        durable.adapter.action(request)
    assert error.value.status_code == 409 and write_count(durable) == 0


def test_manual_reconcile_allows_new_request_without_retrying_old_one(durable):
    request = action(durable)
    durable.stock.multi_condition.side_effect = TimeoutError('fake uncertain')
    with pytest.raises(TimeoutError):
        durable.adapter.action(request)
    durable.adapter.reconcile(acknowledge(durable, request))
    with pytest.raises(HTTPException):
        durable.adapter.action(request)
    durable.stock.multi_condition.side_effect = None
    assert durable.adapter.action(action(durable, request_id='new-after-human-reconcile'))['submitted'] is True
    assert write_count(durable) == 2  # first unknown attempt plus genuinely new intent


@pytest.mark.parametrize('values', [dict(acknowledgement=''), dict(acknowledgement='unchecked'),
    dict(instance_id=''), dict(request_id='../unsafe')])
def test_reconcile_dto_requires_exact_explicit_acknowledgement(durable, values):
    with pytest.raises(ValidationError):
        acknowledge(durable, action(durable), **values)


def test_reconcile_rejects_stale_instance_and_foreign_account(durable):
    request = action(durable)
    with pytest.raises(HTTPException):
        durable.adapter.reconcile(acknowledge(durable, request, instance_id='stale-instance'))
    with pytest.raises(ValueError):
        durable.adapter.reconcile(acknowledge(durable, request, selector=dict(STOCK, account_id='foreign')))
    assert write_count(durable) == 0


def test_paper_can_inspect_and_ack_production_uncertainty_without_native_writes(durable):
    durable.broker.config = replace(durable.broker.config, mode='paper')
    request = action(durable)
    key = durable.adapter._account_key(request.account)
    durable.adapter.attempts.begin('production', request.request_id, key, 'condition_create', 'old')
    assert len(durable.adapter.pending_attempts(request.account)) == 1
    durable.adapter.reconcile(acknowledge(durable, request))
    assert durable.adapter.pending_attempts(request.account) == []
    with pytest.raises(HTTPException):
        durable.adapter.action(action(durable, request_id='paper-cannot-dispatch-new'))
    assert write_count(durable) == 0


def test_http_attempt_inspection_and_acknowledgement_require_authorization_and_account_ownership(durable, tmp_path):
    app = create_app(Config(mode='demo'), sdk_factory=fail,
        passkey_store=PasskeyStore(tmp_path/'passkeys.sqlite3'),
        research_store=ResearchStore(tmp_path/'http-attempts.sqlite3'))
    app.state.native_panels.broker = durable.broker
    app.state.native_panels.dto_loader = durable.adapter.dto_loader
    request = action(durable)
    payload = acknowledge(durable, request).model_dump(mode='json')
    with TestClient(app, raise_server_exceptions=False) as client:
        assert client.post('/api/v1/native/attempts', json=STOCK).status_code == 401
        assert client.post('/api/v1/native/reconcile', json=payload).status_code == 401
        client.headers['Authorization'] = 'Bearer '+app.state.session.issue()
        assert client.post('/api/v1/native/attempts', json=STOCK).json() == []
        assert client.post('/api/v1/native/reconcile', json=dict(payload, acknowledgement='unchecked')).status_code == 422
        assert client.post('/api/v1/native/reconcile', json=dict(payload, account=dict(STOCK, account_id='foreign'))).status_code == 400
        assert client.post('/api/v1/native/reconcile', json=payload).json() == dict(reconciled=True, submitted=False)
        delayed = client.post('/api/v1/native/action', json=request.model_dump(mode='json'))
        assert delayed.status_code == 409
    assert write_count(durable) == 0
