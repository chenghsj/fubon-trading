"""Single-owner WebAuthn ceremonies. Only public credential material is persisted."""
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import secrets
import sqlite3
import sys
import time

from webauthn import (generate_registration_options, verify_registration_response,
                      generate_authentication_options, verify_authentication_response, options_to_json)
from webauthn.helpers import base64url_to_bytes
from webauthn.helpers.structs import (AuthenticatorSelectionCriteria, ResidentKeyRequirement,
                                     UserVerificationRequirement, PublicKeyCredentialDescriptor)

RP_ID = "localhost"


def default_database():
    if sys.platform == "darwin":
        root = Path.home() / "Library/Application Support/Fubon Trading"
    elif sys.platform == "win32":
        root = Path(os.environ.get("LOCALAPPDATA", str(Path.home() / "AppData/Local"))) / "Fubon Trading"
    else:
        root = Path.home() / ".local/share/fubon-trading"
    return root / "passkeys.sqlite3"


class PasskeyError(ValueError):
    pass


class PasskeyStore:
    def __init__(self, path=None):
        self.path = Path(path) if path is not None else default_database()
        self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        descriptor = os.open(self.path, os.O_CREAT | os.O_RDWR | getattr(os, "O_NOFOLLOW", 0), 0o600)
        os.close(descriptor)
        with self.connection() as db:
            db.execute("CREATE TABLE IF NOT EXISTS owner (singleton INTEGER PRIMARY KEY CHECK(singleton=1), user_id BLOB NOT NULL)")
            db.execute("CREATE TABLE IF NOT EXISTS credential (singleton INTEGER PRIMARY KEY CHECK(singleton=1), id BLOB NOT NULL, public_key BLOB NOT NULL, sign_count INTEGER NOT NULL)")
            db.execute("INSERT OR IGNORE INTO owner VALUES (1, ?)", (secrets.token_bytes(32),))

    @contextmanager
    def connection(self):
        db = sqlite3.connect(self.path, timeout=5)
        try:
            with db:
                yield db
        finally:
            db.close()

    def owner(self):
        with self.connection() as db:
            return db.execute("SELECT user_id FROM owner WHERE singleton=1").fetchone()[0]

    def credential(self):
        with self.connection() as db:
            return db.execute("SELECT id, public_key, sign_count FROM credential WHERE singleton=1").fetchone()

    def register(self, verified):
        with self.connection() as db:
            # The primary key makes simultaneous first enrollments fail closed.
            db.execute("INSERT INTO credential VALUES (1, ?, ?, ?)",
                       (verified.credential_id, verified.credential_public_key, verified.sign_count))

    def advance(self, credential_id, previous, current):
        with self.connection() as db:
            changed = db.execute("UPDATE credential SET sign_count=? WHERE singleton=1 AND id=? AND sign_count=?",
                                 (current, credential_id, previous)).rowcount
            if changed != 1:
                raise PasskeyError("Passkey 狀態已更新，請重新驗證")

    def reset(self):
        with self.connection() as db:
            db.execute("DELETE FROM credential")
            db.execute("UPDATE owner SET user_id=? WHERE singleton=1", (secrets.token_bytes(32),))


class Passkeys:
    def __init__(self, store, origin):
        self.store, self.origin = store, origin
        self.pending = {}

    def enrolled(self):
        return self.store.credential() is not None

    def _challenge(self, kind, challenge, binding=""):
        now = time.monotonic()
        self.pending = {key: value for key, value in self.pending.items() if value[3] > now}
        if len(self.pending) >= 64:
            raise PasskeyError("驗證請求過多，請稍後重試")
        ident = secrets.token_urlsafe(32)
        self.pending[ident] = (kind, challenge, binding, now + 120)
        return ident

    def _consume(self, ident, kind, binding=""):
        if not isinstance(ident, str):
            raise PasskeyError("驗證請求格式不正確")
        entry = self.pending.pop(ident, None)
        if not entry or entry[0] != kind or entry[2] != binding or time.monotonic() > entry[3]:
            raise PasskeyError("驗證已過期或已使用，請重試")
        return entry[1]

    def _first_party(self, credential):
        raw = credential["response"]["clientDataJSON"]
        if not isinstance(raw, str) or len(raw) > 8192:
            raise PasskeyError("Invalid client data")
        client = json.loads(base64url_to_bytes(raw))
        if client.get("crossOrigin", False) is not False or client.get("topOrigin") not in (None, self.origin):
            raise PasskeyError("Cross-origin ceremonies are not allowed")

    def registration_options(self, enrollment):
        if self.enrolled():
            raise PasskeyError("Passkey 已設定，請使用既有 Passkey 登入")
        options = generate_registration_options(
            rp_id=RP_ID, rp_name="Fubon Trading", user_name="Fubon Trading 本機使用者",
            user_id=self.store.owner(), timeout=120000,
            authenticator_selection=AuthenticatorSelectionCriteria(
                resident_key=ResidentKeyRequirement.REQUIRED,
                require_resident_key=True, user_verification=UserVerificationRequirement.REQUIRED))
        binding = hashlib.sha256(enrollment.encode()).hexdigest()
        return dict(request_id=self._challenge("register", options.challenge, binding), public_key=json.loads(options_to_json(options)))

    def register(self, ident, credential, enrollment):
        challenge = self._consume(ident, "register", hashlib.sha256(enrollment.encode()).hexdigest())
        if self.enrolled():
            raise PasskeyError("Passkey 已設定，請使用既有 Passkey 登入")
        try:
            self._first_party(credential)
            verified = verify_registration_response(credential=credential, expected_challenge=challenge,
                expected_rp_id=RP_ID, expected_origin=self.origin, require_user_verification=True)
            self.store.register(verified)
        except Exception:
            raise PasskeyError("Passkey 註冊未通過驗證，請重試") from None

    def authentication_options(self):
        saved = self.store.credential()
        if saved is None:
            raise PasskeyError("尚未設定 Passkey，請從啟動視窗註冊")
        options = generate_authentication_options(rp_id=RP_ID, timeout=120000,
            allow_credentials=[PublicKeyCredentialDescriptor(id=saved[0])],
            user_verification=UserVerificationRequirement.REQUIRED)
        return dict(request_id=self._challenge("authenticate", options.challenge), public_key=json.loads(options_to_json(options)))

    def authenticate(self, ident, credential):
        challenge = self._consume(ident, "authenticate")
        saved = self.store.credential()
        try:
            self._first_party(credential)
            if saved is None or base64url_to_bytes(credential["id"]) != saved[0]:
                raise PasskeyError("Unknown credential")
            handle = credential.get("response", {}).get("userHandle")
            if handle is not None and base64url_to_bytes(handle) != self.store.owner():
                raise PasskeyError("Wrong owner")
            verified = verify_authentication_response(credential=credential, expected_challenge=challenge,
                expected_rp_id=RP_ID, expected_origin=self.origin, credential_public_key=saved[1],
                credential_current_sign_count=saved[2], require_user_verification=True)
            self.store.advance(saved[0], saved[2], verified.new_sign_count)
        except Exception:
            raise PasskeyError("Passkey 驗證失敗，請重新驗證") from None
