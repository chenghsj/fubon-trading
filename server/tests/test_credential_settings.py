"""Credential updates use synthetic secrets, a memory store and real WebAuthn signatures."""
from copy import deepcopy
from unittest.mock import Mock

import pytest
from fastapi.testclient import TestClient

from fubon_bridge.app import create_app
from fubon_bridge.config import Config
from fubon_bridge.credential_settings import CredentialSettings
from fubon_bridge.passkeys import PasskeyStore
from test_passkeys import Authenticator, ORIGIN, options, register

SECRET = 'fixture-new-api-key-never-echo'


@pytest.fixture
def runtime(tmp_path):
    cert = tmp_path / 'test.pfx'
    cert.write_text('synthetic certificate')
    cert.chmod(0o600)
    old = dict(personal_id='fixture-id', api_key='fixture-old-key', cert_path=str(cert), cert_password='fixture-password')
    store = Mock()
    store.read.return_value = old
    def write(value):
        store.read.return_value = deepcopy(value)
    store.write.side_effect = write
    service = CredentialSettings(lambda: store)
    service.available = lambda: True
    restart = Mock()
    app = create_app(Config(), launch_token='launch', passkey_store=PasskeyStore(tmp_path / 'passkeys.db'),
                     credential_store=service, on_restart=restart)
    with TestClient(app, base_url=ORIGIN) as client:
        auth = Authenticator()
        token, _ = register(client, auth)
        client.headers.update({'Authorization': 'Bearer ' + token, 'Origin': ORIGIN})
        store.reset_mock()
        yield client, app, auth, store, service, restart, old


def change(runtime, **values):
    client, app, auth, *_ = runtime
    opts = client.post('/api/v1/settings/credentials/options', json={}).json()
    auth.counter = getattr(auth, 'counter', 1) + 1
    return dict(instance_id=app.state.broker.instance_id, api_key=SECRET, request_id=opts['request_id'],
                credential=auth.credential(opts, counter=auth.counter), **values)


def test_status_never_returns_saved_fields_and_requires_session(runtime):
    client, app, _, store, _, _, old = runtime
    response = client.get('/api/v1/settings/credentials')
    assert response.json() == dict(available=True, configured=True, storage='macOS Keychain', instance_id=app.state.broker.instance_id)
    assert response.headers['cache-control'] == 'no-store'
    for value in old.values():
        assert value not in response.text
    store.reset_mock()
    client.headers.pop('Authorization')
    for endpoint in ('/api/v1/settings/credentials', '/api/v1/settings/credentials/options'):
        assert client.post(endpoint, json={}).status_code == 401
    assert client.get('/api/v1/settings/credentials').status_code == 401
    store.read.assert_not_called()
    store.write.assert_not_called()


@pytest.mark.parametrize('origin', ['', 'http://127.0.0.1:5179', 'http://localhost:21323', 'https://evil.example'])
def test_update_requires_exact_frontend_origin(runtime, origin):
    client, _, _, store, *_ = runtime
    for endpoint in ('/api/v1/settings/credentials', '/api/v1/settings/credentials/options'):
        assert client.post(endpoint, json={}, headers={'Origin': origin}).status_code == 403
    store.read.assert_not_called()


def test_key_only_update_keeps_other_credentials_and_restarts(runtime):
    client, app, _, store, _, restart, old = runtime
    body = change(runtime)
    response = client.post('/api/v1/settings/credentials', json=body)
    assert response.status_code == 200, response.text
    assert response.json() == {'restarting': True}
    assert response.headers['cache-control'] == 'no-store'
    assert store.read.return_value == old | {'api_key': SECRET}
    store.write.assert_called_once()
    restart.assert_called_once()
    assert app.state.broker.transitioning
    assert client.get('/api/v1/info').status_code == 503


def test_initial_setup_requires_all_fields_before_any_write(runtime):
    client, _, _, store, _, restart, old = runtime
    store.read.return_value = None
    assert client.post('/api/v1/settings/credentials', json=change(runtime)).status_code == 400
    store.write.assert_not_called()
    body = change(runtime, personal_id=old['personal_id'], cert_path=old['cert_path'], cert_password=old['cert_password'])
    assert client.post('/api/v1/settings/credentials', json=body).status_code == 200
    restart.assert_called_once()


def test_plain_session_and_login_assertion_cannot_update_key(runtime):
    client, app, auth, store, *_ = runtime
    opts = options(client, 'authenticate', dict(client.headers))
    body = dict(instance_id=app.state.broker.instance_id, api_key=SECRET, request_id=opts['request_id'], credential=auth.credential(opts, counter=0))
    assert client.post('/api/v1/settings/credentials', json=body).status_code == 400
    store.read.assert_not_called()
    store.write.assert_not_called()


def test_update_assertion_is_bound_to_session_and_single_use(runtime):
    client, app, _, store, *_ = runtime
    body = change(runtime)
    second = 'Bearer ' + app.state.session.issue()
    assert client.post('/api/v1/settings/credentials', json=body, headers={'Authorization': second}).status_code == 400
    assert client.post('/api/v1/settings/credentials', json=body).status_code == 400
    store.write.assert_not_called()


@pytest.mark.parametrize('value', [None, [], {'unexpected': SECRET}, '', ' ' * 4, SECRET * 300])
def test_invalid_input_never_echoes_secrets(runtime, value):
    client, _, _, store, *_ = runtime
    body = change(runtime)
    body['api_key'] = value
    response = client.post('/api/v1/settings/credentials', json=body)
    assert response.status_code == 400
    assert SECRET not in response.text
    store.write.assert_not_called()


def test_malformed_json_and_large_body_never_echo_secrets(runtime):
    client, _, _, store, *_ = runtime
    for body, status in [(f'{{"api_key":"{SECRET}"', 400), (SECRET * 2000, 413)]:
        response = client.post('/api/v1/settings/credentials', content=body, headers={'Content-Type': 'application/json'})
        assert response.status_code == status
        assert SECRET not in response.text
    store.write.assert_not_called()


@pytest.mark.parametrize('kind', ['monitoring', 'pending', 'position', 'research', 'order', 'holding'])
def test_active_work_blocks_update_and_keeps_service_usable(runtime, kind):
    client, app, _, store, _, restart, _ = runtime
    auto, broker = app.state.automation, app.state.broker
    if kind == 'monitoring':
        auto.monitoring = True
    elif kind in {'pending', 'position'}:
        auto.state[kind] = {'id': 'fixture'}
    elif kind == 'research':
        app.state.learning.current = {'status': 'running'}
    elif kind == 'order':
        broker.paper.orders['pending'] = {'order': {'account': {'account_id': 'DEMO-F'}}, 'status': {'status': 'Submitted', 'deal_quantity': 0}}
    else:
        broker.paper.positions[('DEMO-F', 'TMFK6')] = {'signed_qty': 1}
    response = client.post('/api/v1/settings/credentials', json=change(runtime))
    assert response.status_code == 409, response.text
    store.write.assert_not_called()
    restart.assert_not_called()
    assert not broker.transitioning
    assert client.get('/api/v1/info').status_code == 200


def test_keychain_failure_never_exposes_exception_or_restarts(runtime):
    client, app, _, store, _, restart, _ = runtime
    store.write.side_effect = RuntimeError(SECRET)
    response = client.post('/api/v1/settings/credentials', json=change(runtime))
    assert response.status_code == 503
    assert SECRET not in response.text
    assert client.get('/api/v1/info').status_code == 200
    assert not app.state.broker.transitioning
    restart.assert_not_called()


def test_certificate_permissions_are_checked_before_keychain_write(runtime):
    client, _, _, store, _, restart, old = runtime
    from pathlib import Path
    Path(old['cert_path']).chmod(0o644)
    response = client.post('/api/v1/settings/credentials', json=change(runtime))
    assert response.status_code == 400
    assert '600' in response.text
    assert old['cert_path'] not in response.text
    store.write.assert_not_called()
    restart.assert_not_called()


def test_unsupported_storage_and_stale_instances_fail_closed(runtime):
    client, _, _, store, service, restart, _ = runtime
    body = change(runtime)
    body['instance_id'] = 'stale'
    assert client.post('/api/v1/settings/credentials', json=body).status_code == 409
    service.available = lambda: False
    assert client.get('/api/v1/settings/credentials').json()['available'] is False
    assert client.post('/api/v1/settings/credentials/options', json={}).status_code == 409
    assert client.post('/api/v1/settings/credentials', json=body).status_code == 409
    store.read.assert_not_called()
    store.write.assert_not_called()
    restart.assert_not_called()


def test_revoked_broker_key_has_actionable_recovery_without_skipping_exposure_checks(runtime):
    from dataclasses import replace
    from types import SimpleNamespace
    client, app, _, store, _, restart, _ = runtime
    broker = app.state.broker
    # Mirrors a previously connected official account after SDK event 304.
    broker.config = replace(broker.config, mode='live', live_enabled=True)
    broker.accounts_raw = {('F', 'fixture', 'fixture-account'): SimpleNamespace()}
    broker.error = 'API Key 異動，已強制登出'
    # The runtime config is demo in this fixture; mode-independent broker state
    # is used by the editor to recognize a disconnected official account.
    response = client.post('/api/v1/settings/credentials', json=change(runtime))
    assert response.status_code == 409
    assert 'pnpm credentials set' in response.text
    assert '不會取消券商委託或平倉' in response.text
    store.write.assert_not_called()
    restart.assert_not_called()
