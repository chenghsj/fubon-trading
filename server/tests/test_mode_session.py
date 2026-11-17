"""Independent day/night settings QA. No SDK login, Keychain, or broker writes."""
from contextlib import ExitStack
import json
from types import SimpleNamespace as NS
from unittest.mock import Mock

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from fubon_bridge.app import create_app
from fubon_bridge.config import Config
from fubon_bridge.mode_settings import ModeSelection, ModeSettings
from fubon_bridge.passkeys import PasskeyStore
from fubon_bridge.research import ResearchStore


@pytest.fixture
def runtime(tmp_path, monkeypatch):
    stack = ExitStack()
    runtimes = []
    credentials = Mock(side_effect=AssertionError('QA must not read Keychain or connect'))
    monkeypatch.setattr(Config, 'with_credentials', credentials)

    def factory(mode='demo', session='regular'):
        path = tmp_path / str(len(runtimes))
        path.mkdir()
        cert = path / 'fixture-cert.pfx'
        cert.write_bytes(b'offline-fixture')
        config = Config(mode=mode, live_enabled=mode == 'live', session=session,
                        test_id='fixture', test_cert_path=str(cert))
        settings = ModeSettings(path / 'mode.json')
        restart = Mock()
        sdk = Mock(side_effect=AssertionError('QA must not initialize SDK'))
        app = create_app(config, sdk_factory=sdk, mode_store=settings, on_restart=restart,
                         passkey_store=PasskeyStore(path / 'passkeys.db'),
                         research_store=ResearchStore(path / 'research.db'))
        client = stack.enter_context(TestClient(app))
        client.headers['Authorization'] = 'Bearer ' + app.state.session.issue()
        item = NS(client=client, app=app, settings=settings, restart=restart, config=config, sdk=sdk)
        runtimes.append(item)
        return item

    yield factory
    stack.close()
    credentials.assert_not_called()
    for item in runtimes:
        item.sdk.assert_not_called()


def change(item, **changes):
    body = dict(mode=item.config.mode, live_enabled=item.config.live_enabled,
                instance_id=item.app.state.broker.instance_id,
                acknowledgement='確認啟用正式下單' if item.config.mode == 'live' else '確認切換交易環境')
    body.update(changes)
    return body


@pytest.mark.parametrize('session', ['regular', 'afterhours'])
def test_explicit_session_is_persisted_and_overrides_environment(tmp_path, session):
    settings = ModeSettings(tmp_path / 'mode.json')
    settings.save(ModeSelection(mode='paper', session=session))
    raw = json.loads(settings.path.read_text())
    assert raw['session'] == session
    assert raw['live_enabled'] is False
    loaded = settings.apply(Config(session='afterhours' if session == 'regular' else 'regular'))
    assert loaded.session == session
    assert loaded.mode == 'paper'
    assert not loaded.live_enabled
    assert settings.path.stat().st_mode & 0o777 == 0o600


@pytest.mark.parametrize('session', ['regular', 'afterhours'])
@pytest.mark.parametrize('legacy', [True, False])
def test_old_or_null_session_file_preserves_environment_session(tmp_path, session, legacy):
    settings = ModeSettings(tmp_path / 'mode.json')
    raw = dict(mode='paper', live_enabled=False)
    if not legacy:
        raw['session'] = None
    settings.path.write_text(json.dumps(raw))
    loaded = settings.apply(Config(session=session))
    assert loaded.session == session
    assert loaded.mode == 'paper'
    assert not loaded.live_enabled


@pytest.mark.parametrize('session', ['', 'night', 'AFTERHOURS', True, 1, [], {}])
def test_invalid_session_is_rejected_by_model_and_existing_file(tmp_path, session):
    with pytest.raises(ValidationError):
        ModeSelection(mode='paper', session=session)
    settings = ModeSettings(tmp_path / 'mode.json')
    settings.path.write_text(json.dumps(dict(mode='paper', live_enabled=False, session=session)))
    with pytest.raises(ValueError, match='不會自動'):
        settings.apply(Config())


@pytest.mark.parametrize('session', ['regular', 'afterhours'])
def test_get_mode_exposes_active_session_without_changing_permission(runtime, session):
    item = runtime(session=session)
    response = item.client.get('/api/v1/settings/mode')
    assert response.status_code == 200
    assert response.json()['session'] == session
    assert response.json()['mode'] == 'demo'
    assert response.json()['live_enabled'] is False
    assert not item.settings.path.exists()
    item.restart.assert_not_called()


@pytest.mark.parametrize('source,target', [('regular', 'afterhours'), ('afterhours', 'regular')])
def test_same_mode_different_session_saves_and_restarts_instead_of_hot_swap(runtime, source, target):
    item = runtime(session=source)
    response = item.client.post('/api/v1/settings/mode', json=change(item, session=target))
    assert response.status_code == 200, response.text
    assert response.json() == {'restarting': True}
    item.restart.assert_called_once()
    assert item.settings.apply(Config()).session == target
    assert json.loads(item.settings.path.read_text())['session'] == target
    assert item.app.state.broker.config.session == source
    assert item.app.state.broker.transitioning
    assert item.app.state.automation.closing.is_set()
    assert item.client.get('/api/v1/info').status_code == 503


@pytest.mark.parametrize('body_session', ['afterhours', None, 'omitted'])
def test_same_mode_unchanged_session_is_noop_for_new_and_old_clients(runtime, body_session):
    item = runtime(session='afterhours')
    body = change(item)
    if body_session != 'omitted':
        body['session'] = body_session
    response = item.client.post('/api/v1/settings/mode', json=body)
    assert response.status_code == 200, response.text
    assert response.json() == {'restarting': False}
    item.restart.assert_not_called()
    assert not item.settings.path.exists()
    assert not item.app.state.broker.transitioning


@pytest.mark.parametrize('body_session', [None, 'omitted'])
def test_old_client_mode_change_keeps_and_explicitly_saves_active_night_session(runtime, body_session):
    item = runtime(session='afterhours')
    body = change(item, mode='paper')
    if body_session != 'omitted':
        body['session'] = body_session
    response = item.client.post('/api/v1/settings/mode', json=body)
    assert response.status_code == 200, response.text
    assert json.loads(item.settings.path.read_text()) == dict(mode='paper', live_enabled=False, session='afterhours')
    item.restart.assert_called_once()


@pytest.mark.parametrize('kind', ['monitoring', 'pending', 'position', 'attention', 'research', 'worker', 'book'])
def test_same_mode_session_change_still_requires_idle(runtime, monkeypatch, kind):
    item = runtime()
    auto, learning, broker = item.app.state.automation, item.app.state.learning, item.app.state.broker
    if kind == 'monitoring':
        auto.monitoring = True
    elif kind in {'pending', 'position'}:
        auto.state[kind] = {'id': 'unresolved'}
    elif kind == 'attention':
        auto.state['status'] = 'attention'
    elif kind == 'research':
        learning.current = {'status': 'running'}
    elif kind == 'worker':
        monkeypatch.setattr(learning, 'busy', lambda: True)
    else:
        broker.paper.positions[('DEMO-F', 'TMFK6')] = {'signed_qty': 1}
    response = item.client.post('/api/v1/settings/mode', json=change(item, session='afterhours'))
    assert response.status_code == 400, response.text
    assert not item.settings.path.exists()
    item.restart.assert_not_called()
    assert not broker.transitioning
    assert broker.config.session == 'regular'
    assert not auto.closing.is_set()
    assert not learning.closing


@pytest.mark.parametrize('source', ['sandbox', 'live'])
def test_session_only_change_cannot_bypass_authoritative_broker_exposure_checks(runtime, source):
    item = runtime(mode=source)
    broker = item.app.state.broker
    broker.accounts_raw = {('S', 'TEST', 'OFFLINE'): NS(name='fixture')}
    inventory = Mock(return_value=NS(is_success=True, data=[NS(today_qty=1000)]))
    orders = Mock(return_value=NS(is_success=True, data=[]))
    broker.sdk = NS(stock=NS(get_order_results=orders), accounting=NS(inventories=inventory), shutdown=Mock())
    response = item.client.post('/api/v1/settings/mode', json=change(item, session='afterhours'))
    assert response.status_code == 400, response.text
    orders.assert_called_once()
    inventory.assert_called_once()
    item.restart.assert_not_called()
    assert not item.settings.path.exists()
    assert not broker.transitioning


@pytest.mark.parametrize('values', [
    dict(mode='live', live_enabled=False, acknowledgement='確認啟用正式下單'),
    dict(mode='paper', live_enabled=True),
    dict(mode='live', live_enabled='true', acknowledgement='確認啟用正式下單'),
    dict(mode='live', live_enabled=True, acknowledgement='確認切換交易環境'),
])
def test_night_selection_never_grants_live_permission_without_original_consent(runtime, values):
    item = runtime()
    response = item.client.post('/api/v1/settings/mode', json=change(item, session='afterhours', **values))
    assert response.status_code in {400, 422}, response.text
    item.restart.assert_not_called()
    assert not item.settings.path.exists()
    assert not item.app.state.broker.config.live_enabled


@pytest.mark.parametrize('ack,allowed', [('', False), ('確認切換交易環境', False), ('確認啟用正式下單', True)])
def test_live_session_change_retains_explicit_live_consent_requirement(runtime, ack, allowed):
    item = runtime(mode='live')
    response = item.client.post('/api/v1/settings/mode', json=change(item, session='afterhours', acknowledgement=ack))
    assert response.status_code == (200 if allowed else 400), response.text
    assert item.app.state.broker.config.live_enabled is True
    if allowed:
        assert json.loads(item.settings.path.read_text()) == dict(mode='live', live_enabled=True, session='afterhours')
        item.restart.assert_called_once()
    else:
        item.restart.assert_not_called()
        assert not item.settings.path.exists()


@pytest.mark.parametrize('session', ['', 'night', True, 1])
def test_invalid_http_session_never_saves_or_restarts(runtime, session):
    item = runtime()
    response = item.client.post('/api/v1/settings/mode', json=change(item, session=session))
    assert response.status_code == 422, response.text
    item.restart.assert_not_called()
    assert not item.settings.path.exists()
