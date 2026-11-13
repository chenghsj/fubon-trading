"""Real ES256 signatures exercise the production WebAuthn verifier end to end."""
import hashlib
import json
import secrets
from unittest.mock import Mock

import cbor2
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec
from fastapi.testclient import TestClient
import pytest
from webauthn.helpers import bytes_to_base64url as b64

from fubon_bridge.app import create_app
from fubon_bridge.config import Config
from fubon_bridge.passkeys import PasskeyStore

ORIGIN = 'http://localhost:5179'


class Authenticator:
    def __init__(self):
        self.key = ec.generate_private_key(ec.SECP256R1())
        self.id = secrets.token_bytes(32)

    def credential(self, options, register=False, *, origin=ORIGIN, rp='localhost', uv=True, counter=1, user_handle=None, wrong_signature=False, cross_origin=False, top_origin=None):
        client = json.dumps(dict(type='webauthn.create' if register else 'webauthn.get',
                                 challenge=options['public_key']['challenge'], origin=origin, crossOrigin=cross_origin,
                                 **({'topOrigin': top_origin} if top_origin else {}))).encode()
        flags = 0x01 | (0x04 if uv else 0) | (0x40 if register else 0)
        data = hashlib.sha256(rp.encode()).digest() + bytes([flags]) + counter.to_bytes(4, 'big')
        if register:
            numbers = self.key.public_key().public_numbers()
            cose = cbor2.dumps({1: 2, 3: -7, -1: 1, -2: numbers.x.to_bytes(32, 'big'), -3: numbers.y.to_bytes(32, 'big')})
            data += bytes(16) + len(self.id).to_bytes(2, 'big') + self.id + cose
            response = dict(clientDataJSON=b64(client), attestationObject=b64(cbor2.dumps(dict(fmt='none', attStmt={}, authData=data))))
        else:
            signature = self.key.sign(data + hashlib.sha256(client).digest(), ec.ECDSA(hashes.SHA256()))
            response = dict(clientDataJSON=b64(client), authenticatorData=b64(data),
                            signature=b64(b'bad' if wrong_signature else signature), userHandle=user_handle)
        return dict(id=b64(self.id), rawId=b64(self.id), type='public-key', response=response)


@pytest.fixture
def setup(tmp_path):
    store = PasskeyStore(tmp_path / 'passkeys.sqlite3')
    app = create_app(Config(), launch_token='launch', passkey_store=store)
    with TestClient(app, base_url=ORIGIN) as client:
        yield client, app, store, Authenticator()


def enrollment(client):
    result = client.post('/api/v1/session', json={}, headers={'Authorization': 'Bearer launch'})
    assert 'access_token' not in result.json()
    return {'Authorization': 'Bearer ' + result.json()['enrollment_token'], 'Origin': ORIGIN}


def options(client, action, headers=None):
    result = client.post(f'/api/v1/passkeys/{action}/options', json={}, headers=headers or {'Origin': ORIGIN})
    assert result.status_code == 200, result.text
    return result.json()


def verify(client, action, opts, credential, headers=None):
    return client.post(f'/api/v1/passkeys/{action}/verify', json={'request_id': opts['request_id'], 'credential': credential},
                       headers=headers or {'Origin': ORIGIN})


def register(client, authenticator):
    headers = enrollment(client)
    opts = options(client, 'register', headers)
    result = verify(client, 'register', opts, authenticator.credential(opts, register=True), headers)
    assert result.status_code == 200, result.text
    return result.json()['access_token'], headers


def test_real_registration_authentication_logout_and_restart(setup):
    client, app, store, auth = setup
    status = client.get('/api/v1/passkeys/status')
    assert status.json()['enrolled'] is False
    assert status.headers['x-frame-options'] == 'DENY'
    assert status.headers['content-security-policy'] == "frame-ancestors 'none'"
    assert client.post('/api/v1/passkeys/register/options', json={}, headers={'Origin': ORIGIN}).status_code == 401
    token, headers = register(client, auth)
    assert client.get('/api/v1/info', headers={'Authorization': 'Bearer ' + token}).status_code == 200
    assert store.credential()[0] == auth.id
    assert client.get('/api/v1/passkeys/status').json()['enrolled'] is True
    assert client.post('/api/v1/passkeys/register/options', json={}, headers=headers).status_code == 401
    assert client.post('/api/v1/session/logout', json={}, headers={'Authorization': 'Bearer ' + token}).status_code == 200
    assert client.get('/api/v1/info', headers={'Authorization': 'Bearer ' + token}).status_code == 401
    opts = options(client, 'authenticate')
    assert opts['public_key']['userVerification'] == 'required'
    result = verify(client, 'authenticate', opts, auth.credential(opts, counter=2))
    assert result.status_code == 200
    assert verify(client, 'authenticate', opts, auth.credential(opts, counter=3)).status_code == 400
    app2 = create_app(Config(), launch_token='new-launch', passkey_store=PasskeyStore(store.path))
    with TestClient(app2, base_url=ORIGIN) as restarted:
        assert restarted.get('/api/v1/info', headers={'Authorization': 'Bearer ' + result.json()['access_token']}).status_code == 401
        # A valid startup link cannot bypass a configured Passkey.
        assert restarted.post('/api/v1/session', json={}, headers={'Authorization': 'Bearer new-launch'}).json() == {'passkey_required': True}
        opts = options(restarted, 'authenticate')
        assert verify(restarted, 'authenticate', opts, auth.credential(opts, counter=3)).status_code == 200


@pytest.mark.parametrize('changes', [dict(origin='https://evil.example'), dict(origin='http://localhost:9999'),
                                    dict(rp='evil.example'), dict(uv=False), dict(wrong_signature=True), dict(counter=1),
                                    dict(user_handle=b64(b'another-owner')), dict(cross_origin=True), dict(cross_origin=True, top_origin='https://untrusted.example'),
                                    dict(top_origin='https://untrusted.example')])
def test_authentication_rejects_invalid_crypto_identity_or_verification(setup, changes):
    client, app, store, auth = setup
    register(client, auth)
    opts = options(client, 'authenticate')
    result = verify(client, 'authenticate', opts, auth.credential(opts, **({'counter': 2} | changes)))
    assert result.status_code == 400
    assert 'access_token' not in result.json()
    assert store.credential()[2] == 1
    # Failed verification consumes the challenge; a corrected response cannot reuse it.
    assert verify(client, 'authenticate', opts, auth.credential(opts, counter=2)).status_code == 400


@pytest.mark.parametrize('changes', [dict(origin='https://evil.example'), dict(origin='http://localhost:9999'), dict(rp='evil.example'), dict(uv=False), dict(cross_origin=True), dict(cross_origin=True, top_origin='https://untrusted.example'), dict(top_origin='https://untrusted.example')])
def test_registration_rejects_wrong_origin_rp_or_missing_user_verification(setup, changes):
    client, app, store, auth = setup
    headers = enrollment(client)
    opts = options(client, 'register', headers)
    assert opts['public_key']['authenticatorSelection']['residentKey'] == 'required'
    assert opts['public_key']['authenticatorSelection']['userVerification'] == 'required'
    assert verify(client, 'register', opts, auth.credential(opts, register=True, **changes), headers).status_code == 400
    assert store.credential() is None


def test_challenge_expiry_unknown_credentials_and_origin_guard(setup):
    client, app, store, auth = setup
    assert client.post('/api/v1/passkeys/authenticate/options', json={}).status_code == 403
    assert client.post('/api/v1/passkeys/authenticate/options', json={}, headers={'Origin': 'http://127.0.0.1:5179'}).status_code == 403
    register(client, auth)
    opts = options(client, 'authenticate')
    stranger = Authenticator()
    assert verify(client, 'authenticate', opts, stranger.credential(opts, counter=2)).status_code == 400
    from fubon_bridge.passkeys import Passkeys, PasskeyError
    service = Passkeys(store, ORIGIN)
    opts = service.authentication_options()
    item = service.pending[opts['request_id']]
    service.pending[opts['request_id']] = item[:3] + (0,)
    with pytest.raises(PasskeyError):
        service.authenticate(opts['request_id'], auth.credential(opts, counter=2))
    assert client.post('/api/v1/passkeys/authenticate/verify', json={'request_id': [], 'credential': {}}, headers={'Origin': ORIGIN}).status_code == 400


def test_sync_passkey_zero_counter_is_supported(setup):
    client, app, store, auth = setup
    headers = enrollment(client)
    opts = options(client, 'register', headers)
    assert verify(client, 'register', opts, auth.credential(opts, register=True, counter=0), headers).status_code == 200
    for _ in range(2):
        opts = options(client, 'authenticate')
        assert verify(client, 'authenticate', opts, auth.credential(opts, counter=0)).status_code == 200


def test_broker_and_keychain_are_not_touched_before_passkey(setup, monkeypatch):
    client, app, store, auth = setup
    connect = Mock()
    monkeypatch.setattr(app.state.broker, 'connect', connect)
    enrollment_headers = enrollment(client)
    connect.assert_not_called()
    opts = options(client, 'register', enrollment_headers)
    assert verify(client, 'register', opts, auth.credential(opts, register=True), enrollment_headers).status_code == 200
    connect.assert_called_once()
    opts = options(client, 'authenticate')
    assert verify(client, 'authenticate', opts, auth.credential(opts, counter=2)).status_code == 200
    connect.assert_called_once()


def test_local_recovery_requires_interactive_confirmation_and_keeps_keychain(setup, monkeypatch, capsys):
    import fubon_bridge.passkey_cli as cli
    client, app, store, auth = setup
    register(client, auth)
    monkeypatch.setattr(cli, 'PasskeyStore', lambda: store)
    monkeypatch.setattr(cli.sys, 'argv', ['fubon-passkeys', 'reset'])
    monkeypatch.setattr(cli.sys.stdin, 'isatty', lambda: True)
    monkeypatch.setattr('builtins.input', lambda prompt: 'cancel')
    assert cli.main() == 1
    assert store.credential() is not None
    monkeypatch.setattr('builtins.input', lambda prompt: 'RESET PASSKEYS')
    assert cli.main() == 0
    assert store.credential() is None
    assert 'Keychain' in capsys.readouterr().out


def test_logout_stops_waiting_stream_before_next_event(tmp_path):
    import asyncio
    from types import SimpleNamespace
    from unittest.mock import AsyncMock

    async def scenario():
        app = create_app(Config(), passkey_store=PasskeyStore(tmp_path / 'passkeys.sqlite3'))
        token = app.state.session.issue()
        request = SimpleNamespace(headers={'authorization': 'Bearer ' + token}, is_disconnected=AsyncMock(return_value=False))
        endpoint = next(route.endpoint for route in app.routes if getattr(route, 'path', '') == '/api/v1/stream/data')
        async with app.router.lifespan_context(app):
            response = await endpoint(request)
            iterator = response.body_iterator
            assert 'retry:' in await anext(iterator)
            pending = asyncio.create_task(anext(iterator))
            await asyncio.sleep(0)  # wait inside queue.get before revocation
            app.state.session.revoke('Bearer ' + token)
            app.state.broker.emit('order_event', {'dummy': True})
            with pytest.raises(StopAsyncIteration):
                await asyncio.wait_for(pending, timeout=1)
    asyncio.run(scenario())
