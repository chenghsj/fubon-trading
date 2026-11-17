from concurrent.futures import ThreadPoolExecutor
import json
import signal
import threading
from types import SimpleNamespace as NS
from unittest.mock import Mock

import pytest
from fastapi.testclient import TestClient

from fubon_bridge.app import create_app
from fubon_bridge.broker import Broker
from fubon_bridge.config import Config
from fubon_bridge.mode_settings import ModeSelection, ModeSettings
from fubon_bridge.passkeys import PasskeyStore
from fubon_bridge.research import ResearchStore


@pytest.fixture
def runtime(tmp_path):
    settings = ModeSettings(tmp_path / 'mode.json')
    restart = Mock()
    app = create_app(Config(), mode_store=settings, on_restart=restart,
                     passkey_store=PasskeyStore(tmp_path / 'passkeys.db'))
    with TestClient(app) as client:
        client.headers['Authorization'] = 'Bearer ' + app.state.session.issue()
        yield client, app, settings, restart


def change(app, **changes):
    return dict(mode='paper', live_enabled=False, instance_id=app.state.broker.instance_id,
                acknowledgement='確認切換交易環境', **changes)


def test_authenticated_settings_do_not_expose_credentials(runtime):
    client, app, settings, restart = runtime
    response = client.get('/api/v1/settings/mode')
    assert response.status_code == 200
    assert response.json() == dict(mode='demo', live_enabled=False, session='regular', instance_id=app.state.broker.instance_id,
                                   available=True, saved=False, sandbox_configured=False)
    client.headers.clear()
    assert client.get('/api/v1/settings/mode').status_code == 401
    assert client.post('/api/v1/settings/mode', json=change(app)).status_code == 401
    assert not settings.path.exists()


@pytest.mark.parametrize('values', [
    dict(mode='live', live_enabled=False, acknowledgement='確認啟用正式下單'),
    dict(mode='live', live_enabled=True, acknowledgement=''),
    dict(mode='live', live_enabled='true', acknowledgement='確認啟用正式下單'),
    dict(mode='paper', live_enabled=True),
    dict(instance_id='old-server'), dict(mode='sandbox'), dict(mode='unknown'),
])
def test_invalid_or_unconfirmed_switch_never_saves(runtime, values):
    client, app, settings, restart = runtime
    body = change(app)
    body.update(values)
    assert client.post('/api/v1/settings/mode', json=body).status_code in {400, 409, 422}
    assert not settings.path.exists()
    restart.assert_not_called()
    assert not app.state.broker.transitioning


@pytest.mark.parametrize('mode', ['paper', 'live'])
def test_confirmed_switch_persists_and_retires_old_app(runtime, mode):
    client, app, settings, restart = runtime
    body = change(app)
    body.update(mode=mode, live_enabled=mode == 'live', acknowledgement='確認啟用正式下單' if mode == 'live' else '確認切換交易環境')
    response = client.post('/api/v1/settings/mode', json=body)
    assert response.status_code == 200, response.text
    assert response.json() == {'restarting': True}
    restart.assert_called_once()
    assert json.loads(settings.path.read_text()) == dict(mode=mode, live_enabled=mode == 'live', session='regular')
    assert settings.path.stat().st_mode & 0o777 == 0o600
    assert settings.apply(Config()).mode == mode
    assert app.state.broker.config.mode == 'demo'  # No hot swapping a broker.
    assert app.state.broker.transitioning and app.state.automation.closing.is_set()
    assert client.post('/api/v1/order/place_order', json={}).status_code == 503
    assert client.post('/api/v1/settings/mode', json=body).status_code == 503
    with pytest.raises(ValueError, match='正在切換'):
        app.state.broker.place({}, {}, {})
    with pytest.raises(ValueError, match='正在切換'):
        app.state.broker.mutate('old', 'cancel')
    new_app = create_app(settings.apply(Config()), mode_store=settings,
                         passkey_store=PasskeyStore(settings.path.parent / 'new-passkeys.db'))
    with TestClient(new_app) as new_client:
        assert new_app.state.broker.instance_id != app.state.broker.instance_id
        assert new_client.get('/api/v1/info', headers=client.headers).status_code == 401


@pytest.mark.parametrize('kind', ['monitoring', 'pending', 'position', 'attention', 'research', 'order', 'holding'])
def test_unresolved_work_blocks_switch_without_stopping_it(runtime, kind):
    client, app, settings, restart = runtime
    auto, learning, broker = app.state.automation, app.state.learning, app.state.broker
    if kind == 'monitoring':
        auto.monitoring = True
    elif kind in {'pending', 'position'}:
        auto.state[kind] = {'id': 'unresolved'}
    elif kind == 'attention':
        auto.state['status'] = kind
    elif kind == 'research':
        learning.current = {'status': 'running'}
    elif kind == 'order':
        broker.paper.orders['pending'] = {'order': {'account': {'account_id': 'DEMO-F'}}, 'status': {'status': 'Submitted', 'deal_quantity': 0}}
    else:
        broker.paper.positions[('DEMO-F', 'TMFK6')] = {'signed_qty': 1}
    response = client.post('/api/v1/settings/mode', json=change(app))
    assert response.status_code == 400, response.text
    assert not settings.path.exists()
    restart.assert_not_called()
    assert not broker.transitioning and not auto.closing.is_set() and not learning.closing


def test_save_failure_leaves_current_service_usable(runtime, monkeypatch):
    client, app, settings, restart = runtime
    monkeypatch.setattr(settings, 'save', Mock(side_effect=ValueError('保存失敗')))
    assert client.post('/api/v1/settings/mode', json=change(app)).status_code == 400
    assert client.get('/api/v1/info').status_code == 200
    assert not app.state.broker.transitioning and not app.state.automation.closing.is_set()
    restart.assert_not_called()


def test_ordinary_slow_reads_do_not_block_other_requests(runtime):
    client, app, _, _ = runtime
    entered, release = threading.Event(), threading.Event()
    @app.get('/api/v1/test/slow')
    def slow():
        entered.set()
        assert release.wait(5)
        return {}
    # The app's final static '/' mount otherwise captures appended test routes.
    app.router.routes.insert(0, app.router.routes.pop())
    with ThreadPoolExecutor(max_workers=2) as pool:
        slow_result = pool.submit(client.get, '/api/v1/test/slow')
        try:
            assert entered.wait(3)
            fast_result = pool.submit(client.get, '/api/v1/info')
            assert fast_result.result(timeout=2).status_code == 200
            assert not slow_result.done()
        finally:
            release.set()
        assert slow_result.result(timeout=3).status_code == 200


@pytest.mark.parametrize('orders, inventory, allowed', [
    ([], [], True), (None, [], False), ([], None, False),
    ([NS(status=50)], [], True), ([NS(status=10)], [], False),
    ([NS(status=777)], [], False), ([], [NS(orig_lots=1)], False),
])
def test_official_switch_requires_authoritative_empty_exposure(orders, inventory, allowed):
    broker = Broker(Config(mode='sandbox'))
    broker.accounts_raw = {('F', 'TEST', 'OFFLINE'): NS(name='fixture')}
    broker.sdk = NS(futopt=NS(get_order_results=lambda _: NS(is_success=True, data=orders)),
                    futopt_accounting=NS(query_single_position=lambda _: NS(is_success=True, data=inventory)))
    if allowed:
        broker.assert_mode_switch_idle()
    else:
        with pytest.raises(ValueError):
            broker.assert_mode_switch_idle()



@pytest.fixture
def sandbox_runtime(tmp_path):
    settings = ModeSettings(tmp_path / 'mode.json')
    restart = Mock()
    app = create_app(Config(mode='sandbox'), mode_store=settings, on_restart=restart,
                     passkey_store=PasskeyStore(tmp_path / 'passkeys.db'),
                     research_store=ResearchStore(tmp_path / 'research.sqlite3'))
    broker = app.state.broker
    broker.accounts_raw = {('S', 'TEST', 'SHARED'): NS(name='shared sandbox')}
    broker.sdk = NS(stock=NS(get_order_results=Mock(return_value=NS(is_success=True, data=[]))),
                    accounting=NS(inventories=Mock(return_value=NS(is_success=False, data=None,
                        message='遠端XPC回傳代碼錯誤==>[sntaqrt6[<REDACTED>:80]]'))), shutdown=Mock())
    with TestClient(app) as client:
        client.headers['Authorization'] = 'Bearer ' + app.state.session.issue()
        yield client, app, settings, restart


@pytest.mark.parametrize('target', ['paper', 'demo'])
@pytest.mark.parametrize('remote_state', ['xpc_error', 'shared_exposure', 'disconnected'])
def test_leaving_shared_sandbox_for_local_mode_needs_no_remote_account_query(sandbox_runtime, target, remote_state):
    client, app, settings, restart = sandbox_runtime
    broker = app.state.broker
    orders = broker.sdk.stock.get_order_results
    inventory = broker.sdk.accounting.inventories
    if remote_state == 'shared_exposure':
        orders.return_value = NS(is_success=True, data=[NS(status=10)])
        inventory.return_value = NS(is_success=True, data=[NS(today_qty=1000)])
    elif remote_state == 'disconnected':
        broker.error = '富邦連線已中斷'
    body = change(app)
    body['mode'] = target
    response = client.post('/api/v1/settings/mode', json=body)
    assert response.status_code == 200, response.text
    assert response.json() == {'restarting': True}
    assert settings.apply(Config()).mode == target
    assert not settings.apply(Config()).live_enabled
    restart.assert_called_once()
    orders.assert_not_called()
    inventory.assert_not_called()
    assert broker.transitioning
    assert client.get('/api/v1/info').status_code == 503


@pytest.mark.parametrize('kind', ['load_error', 'monitoring', 'pending', 'position', 'running', 'stopping', 'attention', 'research', 'worker'])
def test_leaving_sandbox_still_blocks_unresolved_local_work(sandbox_runtime, monkeypatch, kind):
    client, app, settings, restart = sandbox_runtime
    auto, learning, broker = app.state.automation, app.state.learning, app.state.broker
    if kind == 'load_error':
        auto.load_error = 'unreadable strategy state'
    elif kind == 'monitoring':
        auto.monitoring = True
    elif kind in {'pending', 'position'}:
        auto.state[kind] = {'id': 'unresolved'}
    elif kind in {'running', 'stopping', 'attention'}:
        auto.state['status'] = kind
    elif kind == 'research':
        learning.current = {'status': 'running'}
    else:
        monkeypatch.setattr(learning, 'busy', lambda: True)
    response = client.post('/api/v1/settings/mode', json=change(app))
    assert response.status_code == 400, response.text
    assert 'XPC' not in response.text
    assert not settings.path.exists()
    restart.assert_not_called()
    assert not broker.transitioning and not auto.closing.is_set() and not learning.closing
    broker.sdk.stock.get_order_results.assert_not_called()
    broker.sdk.accounting.inventories.assert_not_called()


@pytest.mark.parametrize('source', ['sandbox', 'live'])
def test_live_transition_still_requires_remote_exposure_verification(sandbox_runtime, source):
    from dataclasses import replace
    client, app, settings, restart = sandbox_runtime
    broker = app.state.broker
    broker.config = replace(broker.config, mode=source, live_enabled=source == 'live')
    body = change(app)
    if source == 'sandbox':
        body.update(mode='live', live_enabled=True, acknowledgement='確認啟用正式下單')
    response = client.post('/api/v1/settings/mode', json=body)
    assert response.status_code == 400, response.text
    assert not settings.path.exists()
    restart.assert_not_called()
    broker.sdk.accounting.inventories.assert_called_once()

def test_settings_are_atomic_and_corruption_never_enables_fallback(tmp_path, monkeypatch):
    store = ModeSettings(tmp_path / 'mode.json')
    store.save(ModeSelection(mode='paper'))
    import fubon_bridge.mode_settings as module
    monkeypatch.setattr(module.os, 'replace', Mock(side_effect=OSError('disk unavailable')))
    with pytest.raises(OSError):
        store.save(ModeSelection(mode='live', live_enabled=True))
    assert store.apply(Config()).mode == 'paper'
    store.path.write_text('{broken')
    with pytest.raises(ValueError, match='不會自動'):
        store.apply(Config())


@pytest.mark.parametrize('signal_exit', [False, True])
def test_cli_rebuilds_only_for_mode_restart(monkeypatch, tmp_path, signal_exit):
    import fubon_bridge.__main__ as cli
    monkeypatch.setattr(cli, 'ROOT', tmp_path)
    monkeypatch.setattr('sys.argv', ['bridge', '--no-browser'])
    monkeypatch.setattr(cli.Config, 'from_env', lambda: Config())
    apps = []
    def factory(config, **kwargs):
        apps.append((config, kwargs))
        return NS()
    class Server:
        def __init__(self, config):
            self.force_exit = False
            self._captured_signals = []
        def run(self):
            if len(apps) == 1:
                store = apps[0][1]['mode_store']
                store.save(ModeSelection(mode='paper'))
                apps[0][1]['on_restart']()
                if signal_exit:
                    self._captured_signals.append(signal.SIGTERM)
    monkeypatch.setattr(cli, 'create_app', factory)
    monkeypatch.setattr(cli.uvicorn, 'Server', Server)
    cli.main()
    assert len(apps) == (1 if signal_exit else 2)
    if not signal_exit:
        assert apps[1][0].mode == 'paper'
        assert apps[1][1]['launch_token'] != apps[0][1]['launch_token']
