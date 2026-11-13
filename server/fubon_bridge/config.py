from dataclasses import dataclass, field
import os
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parents[2]


@dataclass(frozen=True)
class Config:
    mode: str = "demo"
    personal_id: str = field(default="", repr=False)
    api_key: str = field(default="", repr=False)
    cert_path: str = field(default="", repr=False)
    cert_password: str = field(default="", repr=False)
    live_enabled: bool = False
    session: str = "regular"
    max_quantity: int = 10
    port: int = 21323

    def __post_init__(self):
        if self.mode not in {"demo", "paper", "live"}:
            raise ValueError("FUBON_MODE must be demo, paper or live")
        if self.session not in {"regular", "afterhours"}:
            raise ValueError("FUBON_SESSION must be regular or afterhours")
        if self.mode == "live" and not self.live_enabled:
            raise ValueError("Live mode requires FUBON_ENABLE_LIVE_TRADING=true")
        if not 1 <= self.max_quantity <= 10000:
            raise ValueError("FUBON_MAX_ORDER_QUANTITY must be 1–10000")

    @classmethod
    def from_env(cls):
        load_dotenv(ROOT / ".env")
        return cls(
            mode=os.getenv("FUBON_MODE", "demo"),
            personal_id=os.getenv("FUBON_PERSONAL_ID", ""),
            api_key=os.getenv("FUBON_API_KEY", ""),
            cert_path=os.getenv("FUBON_CERT_PATH", ""),
            cert_password=os.getenv("FUBON_CERT_PASSWORD", ""),
            live_enabled=os.getenv("FUBON_ENABLE_LIVE_TRADING", "false").lower() == "true",
            session=os.getenv("FUBON_SESSION", "regular"),
            max_quantity=int(os.getenv("FUBON_MAX_ORDER_QUANTITY", "10")),
            port=int(os.getenv("FUBON_PORT", "21323")),
        )
