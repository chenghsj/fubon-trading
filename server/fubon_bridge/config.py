from dataclasses import dataclass, field, replace
import os
from pathlib import Path

from dotenv import load_dotenv

from .keychain import Keychain, KeychainError, validate_credentials

ROOT = Path(__file__).resolve().parents[2]
SANDBOX_URL = "wss://neoapitest.fbs.com.tw/TASP/XCPXWS"


@dataclass(frozen=True)
class Config:
    mode: str = "demo"
    personal_id: str = field(default="", repr=False)
    api_key: str = field(default="", repr=False)
    cert_path: str = field(default="", repr=False)
    cert_password: str = field(default="", repr=False)
    live_enabled: bool = False
    session: str = "auto"
    max_quantity: int = 10
    port: int = 21323
    test_id: str = field(default="", repr=False)
    test_cert_path: str = field(default="", repr=False)

    def __post_init__(self):
        if self.mode not in {"demo", "paper", "sandbox", "live"}:
            raise ValueError("FUBON_MODE must be demo, paper, sandbox or live")
        if self.session not in {"auto", "regular", "afterhours"}:
            raise ValueError("FUBON_SESSION must be auto, regular or afterhours")
        if self.mode == "live" and not self.live_enabled:
            raise ValueError("Live mode requires FUBON_ENABLE_LIVE_TRADING=true")
        if not 1 <= self.max_quantity <= 10000:
            raise ValueError("FUBON_MAX_ORDER_QUANTITY must be 1–10000")

    @property
    def broker_orders(self):
        return self.mode in {"sandbox", "live"}

    @classmethod
    def from_env(cls):
        load_dotenv(ROOT / ".env")
        mode = os.getenv("FUBON_MODE", "demo")
        if mode != "demo":
            legacy = ("FUBON_PERSONAL_ID", "FUBON_API_KEY", "FUBON_CERT_PATH", "FUBON_CERT_PASSWORD")
            if any(os.getenv(key, "").strip() for key in legacy):
                raise KeychainError("明文登入設定已停用；請清除 .env 的登入欄位並執行 pnpm credentials set")
        return cls(
            mode=mode,
            live_enabled=os.getenv("FUBON_ENABLE_LIVE_TRADING", "false").lower() == "true",
            session=os.getenv("FUBON_SESSION", "auto"),
            max_quantity=int(os.getenv("FUBON_MAX_ORDER_QUANTITY", "10")),
            port=int(os.getenv("FUBON_PORT", "21323")),
            test_id=os.getenv("FUBON_TEST_ID", ""),
            test_cert_path=os.getenv("FUBON_TEST_CERT_PATH", ""),
        )

    def with_credentials(self):
        if self.mode == "sandbox":
            cert = Path(self.test_cert_path).expanduser()
            if not self.test_id or not self.test_cert_path or not cert.is_file():
                raise KeychainError("測試環境需設定官方測試包的 FUBON_TEST_ID 與 FUBON_TEST_CERT_PATH")
            return replace(self, personal_id=self.test_id, api_key="", cert_path=str(cert.resolve()), cert_password="12345678")
        if self.mode == "demo" or all((self.personal_id, self.api_key, self.cert_path, self.cert_password)):
            return self
        stored = Keychain().read()
        return replace(self, **validate_credentials(stored)) if stored is not None else self
