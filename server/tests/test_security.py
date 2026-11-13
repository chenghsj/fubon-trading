from unittest.mock import Mock

from fastapi.testclient import TestClient
import pytest

from fubon_bridge.app import create_app
from fubon_bridge.config import Config
from fubon_bridge.keychain import KeychainError, validate_credentials
from fubon_bridge.session import Session
from fubon_bridge.passkeys import PasskeyStore


def exchange(client, launch="launch"):
    return client.post("/api/v1/session", json={}, headers={"Authorization": "Bearer " + launch})


def test_untrusted_local_client_cannot_read_trade_or_stream(tmp_path):
    app = create_app(Config(), launch_token="launch", passkey_store=PasskeyStore(tmp_path / "passkeys.db"))
    with TestClient(app) as client:
        for path in ("/api/v1/info", "/api/v1/auth/accounts", "/api/v1/stream/data"):
            assert client.get(path).status_code == 401
        assert client.post("/api/v1/order/place_order", json={}).status_code == 401
        assert client.post("/api/v1/watchlist", json={}).status_code == 401
        assert client.get("/api/v1/info?token=launch").status_code == 401
        assert client.get("/api/v1/info", headers={"Cookie": "fubon-session=launch"}).status_code == 401
        assert exchange(client, "wrong").status_code == 401
        session = exchange(client)
        assert session.status_code == 200
        assert "set-cookie" not in session.headers
        assert session.headers["cache-control"] == "no-store"
        enrollment = session.json()["enrollment_token"]
        assert "access_token" not in session.json()
        assert client.get("/api/v1/info", headers={"Authorization": "Bearer " + enrollment}).status_code == 401
        token = app.state.session.issue()
        assert token != "launch" and len(token) == 43
        assert exchange(client).status_code == 401
        assert client.get("/api/v1/info", headers={"Authorization": "Bearer launch"}).status_code == 401
        authorized = {"Authorization": "Bearer " + token}
        assert client.get("/api/v1/info", headers=authorized).status_code == 200
        assert client.get("/api/v1/info", headers=authorized | {"Origin": "http://127.0.0.1:9999"}).status_code == 403
        assert token not in client.get("/api/v1/info", headers=authorized).text
        with TestClient(create_app(Config(), launch_token="launch-2", passkey_store=PasskeyStore(tmp_path / "passkeys.db"))) as restarted:
            assert restarted.get("/api/v1/info", headers=authorized).status_code == 401


def test_expired_launch_never_creates_session():
    session = Session("launch")
    session.deadline = 0
    assert session.exchange("Bearer launch") is None
    assert not session.authorize("Bearer launch")


def test_keychain_only_non_demo_loading(monkeypatch, tmp_path):
    import fubon_bridge.config as config_module
    monkeypatch.setattr(config_module, "ROOT", tmp_path)
    for name in ("FUBON_PERSONAL_ID", "FUBON_API_KEY", "FUBON_CERT_PATH", "FUBON_CERT_PASSWORD", "FUBON_MODE", "FUBON_ENABLE_LIVE_TRADING"):
        monkeypatch.delenv(name, raising=False)
    credentials = dict(personal_id="dummy-id", api_key="dummy-key", cert_path="/dummy/cert", cert_password="dummy-password")
    store = Mock()
    store.read.return_value = credentials
    factory = Mock(return_value=store)
    monkeypatch.setattr(config_module, "Keychain", factory)
    assert Config.from_env().mode == "demo"
    factory.assert_not_called()
    monkeypatch.setenv("FUBON_MODE", "paper")
    deferred = Config.from_env()
    factory.assert_not_called()
    loaded = deferred.with_credentials()
    assert loaded.api_key == credentials["api_key"]
    assert "dummy" not in repr(loaded)
    monkeypatch.setenv("FUBON_API_KEY", "legacy-secret")
    with pytest.raises(KeychainError, match="明文登入設定") as error:
        Config.from_env()
    assert "legacy-secret" not in str(error.value)
    monkeypatch.delenv("FUBON_API_KEY")
    store.read.side_effect = KeychainError("locked")
    with pytest.raises(KeychainError):
        Config.from_env().with_credentials()


@pytest.mark.parametrize("value", [None, {}, {"api_key": "secret"}, {"personal_id": "a", "api_key": "b", "cert_path": "c", "cert_password": ""}])
def test_malformed_keychain_data_has_safe_error(value):
    with pytest.raises(KeychainError) as error:
        validate_credentials(value)
    assert "secret" not in str(error.value)


def test_credentials_set_hides_input_and_never_outputs_secrets(monkeypatch, tmp_path, capsys):
    import fubon_bridge.credentials as cli
    cert = tmp_path / "fixture.pfx"
    cert.write_bytes(b"dummy")
    cert.chmod(0o600)
    values = iter(["dummy-id", "dummy-key", "dummy-password"])
    monkeypatch.setattr(cli, "getpass", lambda prompt: next(values))
    monkeypatch.setattr("builtins.input", lambda prompt: str(cert))
    monkeypatch.setattr(cli.sys.stdin, "isatty", lambda: True)
    monkeypatch.setattr(cli.sys, "argv", ["fubon-credentials", "set"])
    store = Mock()
    monkeypatch.setattr(cli, "Keychain", lambda: store)
    assert cli.main() == 0
    assert store.write.call_args.args[0] == dict(personal_id="dummy-id", api_key="dummy-key", cert_password="dummy-password", cert_path=str(cert))
    assert "dummy" not in capsys.readouterr().out


def test_keychain_unsupported_platform_fails_closed(monkeypatch):
    import fubon_bridge.keychain as keychain
    monkeypatch.setattr(keychain.sys, "platform", "linux")
    with pytest.raises(KeychainError, match="不會改存明文"):
        keychain.Keychain()


def test_getpass_echo_fallback_aborts_without_storing(monkeypatch):
    import warnings
    import fubon_bridge.credentials as cli
    monkeypatch.setattr(cli.sys.stdin, "isatty", lambda: True)
    monkeypatch.setattr(cli.sys, "argv", ["fubon-credentials", "set"])
    store = Mock()
    monkeypatch.setattr(cli, "Keychain", lambda: store)
    def echo_fallback(prompt):
        warnings.warn("Cannot control echo", cli.GetPassWarning)
        pytest.fail("must abort before echoed input")
    monkeypatch.setattr(cli, "getpass", echo_fallback)
    assert cli.main() == 1
    store.write.assert_not_called()
