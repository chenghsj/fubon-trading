"""No test may initialize the user's default research or paper ledger."""
import pytest
import fubon_bridge.app as app_module


@pytest.fixture(autouse=True)
def isolated_default_research_root(monkeypatch,tmp_path):
    monkeypatch.setattr(app_module,'ROOT',tmp_path)
