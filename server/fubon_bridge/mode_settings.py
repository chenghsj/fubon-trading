"""Non-secret, per-checkout UI settings; broker replacement requires a restart."""
from dataclasses import replace
import json
import os
from pathlib import Path
import tempfile

from pydantic import BaseModel, ConfigDict, StrictBool, model_validator
from typing import Literal


class ModeSelection(BaseModel):
    model_config = ConfigDict(extra="forbid")
    mode: Literal["demo", "paper", "sandbox", "live"]
    live_enabled: StrictBool = False

    @model_validator(mode="after")
    def valid_permission(self):
        if self.live_enabled != (self.mode == "live"):
            raise ValueError("正式交易須另外確認允許正式下單；其他模式須關閉正式下單")
        return self


class ModeChange(ModeSelection):
    instance_id: str
    acknowledgement: str


class ModeSettings:
    def __init__(self, path):
        self.path = Path(path)

    def apply(self, config):
        if not self.path.exists():
            return config
        try:
            selected = ModeSelection.model_validate_json(self.path.read_text())
        except (OSError, ValueError):
            raise ValueError("本機模式設定無法讀取，請檢查設定檔；不會自動改用其他交易模式") from None
        return replace(config, mode=selected.mode, live_enabled=selected.live_enabled)

    def save(self, selection):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        fd, temporary = tempfile.mkstemp(prefix=".mode-", dir=self.path.parent)
        try:
            with os.fdopen(fd, "w") as stream:
                json.dump(dict(mode=selection.mode, live_enabled=selection.live_enabled), stream)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, self.path)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)


def ensure_idle(broker, automation, learning):
    """Caller holds learning → automation → broker locks throughout the transition."""
    state = automation.snapshot()
    if automation.load_error or state["monitoring"] or state["pending"] or state["position"] or state["status"] in {"running", "stopping", "attention"}:
        raise ValueError("請先停止策略、重新對帳並處理未確認委託與部位，再切換模式")
    if learning.busy() or (learning.current and learning.current["status"] == "running"):
        raise ValueError("研究工作執行中，請等待完成後再切換模式")
    broker.assert_mode_switch_idle()
