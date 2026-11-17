"""Watchlists survive session restarts without SDK, Keychain, or broker writes."""
from contextlib import ExitStack
from copy import deepcopy
import json
from types import SimpleNamespace as NS
from unittest.mock import Mock

import pytest
from fastapi.testclient import TestClient

from fubon_bridge.app import create_app
from fubon_bridge.config import Config
from fubon_bridge.mode_settings import ModeSettings
from fubon_bridge.passkeys import PasskeyStore
from fubon_bridge.research import ResearchStore
from fubon_bridge.watchlist_store import WatchlistStore


@pytest.fixture
def runtime(tmp_path, monkeypatch):
    stack = ExitStack()
    apps = []
    path = tmp_path / 'watchlists.json'
    credentials = Mock(side_effect=AssertionError('No Keychain access in watchlist QA'))
    monkeypatch.setattr(Config, 'with_credentials', credentials)

    def factory(*, persist=True, session='regular'):
        directory = tmp_path / str(len(apps))
        directory.mkdir()
        sdk = Mock(side_effect=AssertionError('No SDK initialization in watchlist QA'))
        kwargs = {'watchlist_store': WatchlistStore(path)} if persist else {}
        app = create_app(Config(mode='paper', session=session), sdk_factory=sdk,
                         research_store=ResearchStore(directory / 'research.db'),
                         passkey_store=PasskeyStore(directory / 'passkeys.db'),
                         mode_store=ModeSettings(directory / 'mode.json'), **kwargs)
        broker = app.state.broker
        broker.contract = Mock(side_effect=lambda key: dict(
            code=key['code'].strip().upper(), security_type=key.get('security_type') or 'STK',
            exchange='TSE' if (key.get('security_type') or 'STK') == 'STK' else 'TAIFEX',
            name='offline:' + key['code']))
        broker.place = Mock(side_effect=AssertionError('Watchlists must never place orders'))
        broker.mutate = Mock(side_effect=AssertionError('Watchlists must never mutate orders'))
        broker.connect = Mock(side_effect=AssertionError('Watchlists must never connect SDK'))
        client = stack.enter_context(TestClient(app, raise_server_exceptions=False))
        client.headers['Authorization'] = 'Bearer ' + app.state.session.issue()
        client.headers['Content-Type'] = 'application/json'
        item = NS(app=app, client=client, sdk=sdk, broker=broker, path=path)
        apps.append(item)
        return item

    yield factory
    stack.close()
    credentials.assert_not_called()
    for item in apps:
        item.sdk.assert_not_called()
        item.broker.place.assert_not_called()
        item.broker.mutate.assert_not_called()
        item.broker.connect.assert_not_called()
        assert item.broker.sdk is None


def lists(item):
    response = item.client.get('/api/v1/watchlist')
    assert response.status_code == 200, response.text
    return response.json()


def key(code='1802', kind='STK'):
    return dict(code=code, security_type=kind, exchange='TSE' if kind == 'STK' else 'TAIFEX')


def test_five_products_and_name_only_rename_survive_a_second_night_session_app(runtime):
    first = runtime()
    original = lists(first)[0]
    response = first.client.post('/api/v1/watchlist/default/contracts', json={'contracts': [key()]})
    assert response.status_code == 200, response.text
    five = response.json()['contracts']
    assert [row['code'] for row in five] == ['TMFR1', 'TXFR1', 'MXFR1', '2330', '1802']
    renamed = first.client.put('/api/v1/watchlist/default', json={'name': '我的五個商品'})
    assert renamed.status_code == 200, renamed.text
    assert renamed.json()['contracts'] == five
    assert renamed.json()['id'] == original['id']
    assert renamed.json()['name'] == '我的五個商品'
    second = runtime(session='afterhours')
    second.broker.contract.reset_mock()
    assert lists(second) == [renamed.json()]
    second.broker.contract.assert_not_called()
    assert first.path.stat().st_mode & 0o777 == 0o600


def test_contract_removal_and_list_deletion_survive_reconstruction(runtime):
    first = runtime()
    baseline = lists(first)
    removable = first.client.post('/api/v1/watchlist', json={'name': 'remove this', 'contracts': [key()]}).json()
    response = first.client.request('DELETE', '/api/v1/watchlist/default/contracts', json={'contracts': [key('TMFR1', 'FUT')]})
    assert response.status_code == 200, response.text
    assert [row['code'] for row in response.json()['contracts']] == ['TXFR1', 'MXFR1', '2330']
    assert first.client.delete('/api/v1/watchlist/' + removable['id']).status_code == 200
    after = lists(first)
    assert len(after) == len(baseline)
    assert lists(runtime(session='afterhours')) == after


def test_explicit_empty_contract_list_is_not_replaced_by_defaults_after_restart(runtime):
    first = runtime()
    lists(first)
    response = first.client.put('/api/v1/watchlist/default', json={'name': '刻意留空', 'contracts': []})
    assert response.status_code == 200, response.text
    assert response.json()['contracts'] == []
    assert lists(runtime()) == [response.json()]


def test_deleting_every_list_persists_empty_collection_without_rebuilding_default(runtime):
    first = runtime()
    for row in lists(first):
        assert first.client.delete('/api/v1/watchlist/' + row['id']).status_code == 200
    assert lists(first) == []
    assert json.loads(first.path.read_text())['lists'] == []
    second = runtime(session='afterhours')
    second.broker.contract.reset_mock()
    assert lists(second) == []
    second.broker.contract.assert_not_called()


@pytest.mark.parametrize('operation', ['create', 'rename', 'replace', 'add', 'remove', 'delete'])
def test_failed_atomic_write_leaves_memory_and_previous_disk_checkpoint_unchanged(runtime, monkeypatch, operation):
    item = runtime()
    before = deepcopy(lists(item))
    disk = item.path.read_bytes()
    import fubon_bridge.watchlist_store as module
    with monkeypatch.context() as failing:
        replace = Mock(side_effect=OSError('offline disk failure'))
        failing.setattr(module.os, 'replace', replace)
        if operation == 'create':
            response = item.client.post('/api/v1/watchlist', json={'name': 'must not appear', 'contracts': []})
        elif operation == 'rename':
            response = item.client.put('/api/v1/watchlist/default', json={'name': 'must not replace original'})
        elif operation == 'replace':
            response = item.client.put('/api/v1/watchlist/default', json={'contracts': [key()]})
        elif operation == 'add':
            response = item.client.post('/api/v1/watchlist/default/contracts', json={'contracts': [key()]})
        elif operation == 'remove':
            response = item.client.request('DELETE', '/api/v1/watchlist/default/contracts', json={'contracts': [key('2330')]})
        else:
            response = item.client.delete('/api/v1/watchlist/default')
    replace.assert_called_once()
    assert response.status_code >= 400, response.text
    assert item.path.read_bytes() == disk
    assert lists(item) == before
    assert lists(runtime()) == before
    assert list(item.path.parent.glob('.watchlists-*')) == []


def test_failed_default_initialization_can_be_retried_without_a_half_initialized_memory_list(runtime, monkeypatch):
    item = runtime()
    import fubon_bridge.watchlist_store as module
    with monkeypatch.context() as failing:
        failing.setattr(module.os, 'replace', Mock(side_effect=OSError('offline disk failure')))
        assert item.client.get('/api/v1/watchlist').status_code >= 400
    assert not item.path.exists()
    assert [row['code'] for row in lists(item)[0]['contracts']] == ['TMFR1', 'TXFR1', 'MXFR1', '2330']
    assert item.path.exists()
    assert list(item.path.parent.glob('.watchlists-*')) == []


def test_default_create_app_keeps_legacy_volatile_memory_mode_available(runtime):
    first = runtime(persist=False)
    assert lists(first)[0]['id'] == 'default'
    saved = first.client.put('/api/v1/watchlist/default', json={'name': 'memory only', 'contracts': []})
    assert saved.status_code == 200
    assert lists(first) == [saved.json()]
    assert not first.path.exists()
    second = runtime(persist=False)
    fresh = lists(second)
    assert fresh[0]['name'] == '台指期與股票'
    assert len(fresh[0]['contracts']) == 4
    assert not second.path.exists()


@pytest.mark.parametrize('payload', [
    '{broken',
    json.dumps({'version': 2, 'lists': []}),
    json.dumps({'version': 1, 'lists': [{'id': 'x', 'name': 'bad', 'contracts': None}]}),
    json.dumps({'version': 1, 'lists': [{'id': 'x', 'name': 'bad', 'contracts': [{'code': ''}]}]}),
])
def test_unreadable_existing_file_is_preserved_instead_of_silently_defaulting(tmp_path, payload):
    path = tmp_path / 'watchlists.json'
    path.write_text(payload)
    with pytest.raises(ValueError, match='不會覆蓋'):
        WatchlistStore(path).load()
    assert path.read_text() == payload


def test_cli_injects_checkout_watchlist_file_without_starting_a_real_server(tmp_path, monkeypatch):
    import fubon_bridge.__main__ as cli
    monkeypatch.setattr(cli, 'ROOT', tmp_path)
    monkeypatch.setattr('sys.argv', ['bridge', '--no-browser'])
    monkeypatch.setattr(cli.Config, 'from_env', lambda: Config())
    factory = Mock(return_value=NS())
    monkeypatch.setattr(cli, 'create_app', factory)
    class Server:
        force_exit = False
        _captured_signals = []
        def __init__(self, config):
            self.config = config
        def run(self):
            pass
    monkeypatch.setattr(cli.uvicorn, 'Server', Server)
    cli.main()
    assert factory.call_args.kwargs['watchlist_store'].path == tmp_path / 'server' / '.watchlists.json'
    assert not (tmp_path / 'server' / '.watchlists.json').exists()


@pytest.mark.parametrize('method', ['POST', 'PUT'])
@pytest.mark.parametrize('contracts', [None, {'code': '2330'}, [{'symbol': '2330'}]])
def test_http_cannot_persist_structures_that_make_next_app_unreadable(runtime, method, contracts):
    item = runtime()
    before = lists(item)
    disk = item.path.read_bytes()
    endpoint = '/api/v1/watchlist' if method == 'POST' else '/api/v1/watchlist/default'
    response = item.client.request(method, endpoint, json={'name': 'invalid candidate', 'contracts': contracts})
    assert response.status_code in {400, 422}, response.text
    assert lists(item) == before
    assert item.path.read_bytes() == disk
    assert lists(runtime()) == before
