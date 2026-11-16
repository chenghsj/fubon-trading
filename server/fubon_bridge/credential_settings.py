"""Write-only browser credential settings backed exclusively by macOS Keychain."""
from pathlib import Path
import sys

from pydantic import BaseModel, ConfigDict, Field, SecretStr

from .keychain import Keychain, KeychainError, validate_credentials


class CredentialChange(BaseModel):
    model_config = ConfigDict(extra="forbid", hide_input_in_errors=True)
    instance_id: str = Field(max_length=64)
    request_id: str = Field(max_length=128)
    credential: dict
    api_key: SecretStr = Field(min_length=1, max_length=4096)
    personal_id: SecretStr | None = Field(default=None, max_length=128)
    cert_path: SecretStr | None = Field(default=None, max_length=4096)
    cert_password: SecretStr | None = Field(default=None, max_length=4096)


class CredentialSettings:
    def __init__(self, factory=Keychain):
        self.factory = factory

    def available(self):
        return sys.platform == "darwin"

    def configured(self):
        stored = self.factory().read()
        if stored is not None:
            validate_credentials(stored)
        return stored is not None

    def save(self, body):
        store = self.factory()
        stored = store.read()
        if stored is not None:
            validate_credentials(stored)
        values = dict(stored or {})
        for name in ("personal_id", "api_key", "cert_path", "cert_password"):
            secret = getattr(body, name)
            if secret is not None and secret.get_secret_value():
                value = secret.get_secret_value()
                values[name] = value if name == "cert_password" else value.strip()
        validate_credentials(values)
        cert = Path(values["cert_path"]).expanduser()
        if not cert.is_file():
            raise KeychainError("找不到憑證檔案；請確認本機完整路徑，原設定未變更")
        if cert.stat().st_mode & 0o077:
            raise KeychainError("憑證檔案權限過寬；請先設為僅擁有者可讀寫（chmod 600），原設定未變更")
        values["cert_path"] = str(cert.resolve())
        store.write(values)
