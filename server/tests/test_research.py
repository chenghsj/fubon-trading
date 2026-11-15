from datetime import date
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from types import SimpleNamespace

from fastapi.testclient import TestClient
import pytest

from fubon_bridge.app import create_app
from fubon_bridge.broker import Broker
from fubon_bridge.config import Config
from fubon_bridge.passkeys import PasskeyStore
from fubon_bridge.research import HistoryRequest, ResearchStore, load_history, normalize


def request(**values):
    return HistoryRequest(product="TMF", contract_month="202611", start="2026-11-10", end="2026-11-10",
        basket=[dict(code="2330", weight=.4)], weight_date="2026-11-01", **values)


def record(dataset):
    summary = dict(trades=[], equity=[], net=0, gross=0, costs=0, maxDrawdown=0, winRate=None)
    return dict(config=dict(stopPoints=30, targetR=2, quantity=1, feePerSide=20, slippagePoints=1, taxRate=.00002),
        context={key:dataset[key] for key in ("id", "source", "product", "contractMonth", "start", "end", "weightDate")},
        baseline=summary, filtered=summary,
        diagnostics=dict(completeDays=1, excludedDays=[], missingBasketTimes=0, filterRejected=0), warnings=[])


def test_first_concurrent_requests_initialize_sqlite_once(tmp_path):
    store = ResearchStore(tmp_path / "new-research.db")
    barrier = Barrier(8)
    def first_read(index):
        barrier.wait(timeout=10)
        return store.stats() if index % 2 else store.runs()
    with ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(first_read, range(8)))
    assert results == [[] if i % 2 == 0 else dict(bars=0, datasets=0, weights=0, runs=0, signals=0) for i in range(8)]


def test_database_reuses_download_without_network_and_preserves_exact_dataset(tmp_path):
    store = ResearchStore(tmp_path / "research.db")
    broker = Broker(Config())
    first = load_history(broker, store, request())
    assert first["cacheHits"] == 0
    assert store.stats() == dict(bars=540, datasets=1, weights=1, runs=0, signals=47)
    broker.research_candles = lambda *_: pytest.fail("cache/offline must never call SDK")
    second = load_history(broker, store, request(offline=True))
    assert second["id"] == first["id"]
    assert second["cacheHits"] == 2
    assert second["futures"] == first["futures"]
    latest = store.latest(first["id"])
    assert latest["historical"] and latest["weightedReturn"] is not None
    saved = store.save_run(first["id"], record(first))
    assert store.runs()[0]["id"] == saved["id"]
    with pytest.raises(ValueError):
        store.save_run(first["id"], {})
    wrong = record(first); wrong["context"]["source"] = "fubon-live"
    with pytest.raises(ValueError, match="來源"):
        store.save_run(first["id"], wrong)
    with store.connect() as db:
        db.execute("INSERT INTO research_runs VALUES(?,?,?,?)", ("bad", "2099", first["id"], '{}'))
    assert len(store.runs()) == 1


def test_minute_labels_timezone_and_conflicting_or_invalid_bars():
    row = dict(date="2026-11-10T09:00:00+08:00", open=100, high=102, low=99, close=101, volume=3)
    bars = normalize([row, row], date(2026, 11, 10), date(2026, 11, 10))
    assert len(bars) == 1 and bars[0]["time"] == 1794272460
    with pytest.raises(ValueError, match="衝突"):
        normalize([row, dict(row, close=102)], date(2026, 11, 10), date(2026, 11, 10))
    with pytest.raises(ValueError, match="無效"):
        normalize([dict(row, low=103)], date(2026, 11, 10), date(2026, 11, 10))


def test_official_no_trade_null_bars_remain_gaps_and_other_nulls_have_clear_error():
    row = dict(date="2026-11-10T09:00:00+08:00", open=None, high=None, low=None, close=None, volume=0)
    assert normalize([row], date(2026,11,10), date(2026,11,10)) == []
    with pytest.raises(ValueError, match="無效 OHLCV"):
        normalize([dict(row, volume=1)], date(2026,11,10), date(2026,11,10))
    with pytest.raises(ValueError, match="無效 OHLCV"):
        normalize([dict(row, open=100, high=102, low=None, close=101)], date(2026,11,10), date(2026,11,10))


def test_cache_source_isolation_and_refresh_removes_provider_corrections(tmp_path):
    store = ResearchStore(tmp_path / "research.db")
    key = ("fubon-sandbox", "FUT", "TMF", "202611", "regular")
    bars = normalize([dict(date="2026-11-10T09:00:00+08:00", open=100, high=102, low=99, close=101, volume=3)], date(2026,11,10), date(2026,11,10))
    store.put_bars(key, "2026-11-10", "2026-11-10", bars)
    assert store.bars(("synthetic", *key[1:]), "2026-11-10", "2026-11-10") is None
    store.put_bars(key, "2026-11-10", "2026-11-10", [])
    assert store.bars(key, "2026-11-10", "2026-11-10") == []
    with pytest.raises(ValueError, match="本地資料庫缺少"):
        load_history(Broker(Config()), store, request(offline=True))


def test_real_history_uses_expired_month_directly_and_never_resolves_live_contract():
    calls = []
    broker = Broker(Config(mode="sandbox"))
    broker.contract = lambda *_: pytest.fail("must not resolve expired month via live ticker")
    broker._client = lambda kind: SimpleNamespace(historical=SimpleNamespace(candles=lambda **params: calls.append((kind, params)) or {"data": []}))
    broker.research_candles("FUT", "TMF", "202408", "2024-08-01", "2024-08-02")
    assert calls[0][1] == dict(product="TMF", contractMonth="202408", timeframe="1", sort="asc", session="regular", **{"from":"2024-08-01", "to":"2024-08-02"})


def test_research_endpoints_require_session_and_save_local_only(tmp_path):
    store = ResearchStore(tmp_path / "research.db")
    app = create_app(Config(), passkey_store=PasskeyStore(tmp_path / "passkeys.db"), research_store=store)
    with TestClient(app) as client:
        assert client.get("/api/v1/research/database").status_code == 401
        client.headers["Authorization"] = "Bearer " + app.state.session.issue()
        payload = request().model_dump(mode="json")
        response = client.post("/api/v1/research/history", json=payload)
        assert response.status_code == 200, response.text
        ident = response.json()["id"]
        assert client.post("/api/v1/research/latest", json=dict(datasetId=ident)).json()["historical"]
        assert client.post("/api/v1/research/runs", json=dict(datasetId=ident, result={})).status_code == 400
        assert client.post("/api/v1/research/runs", json=dict(datasetId=ident, result=record(response.json()))).status_code == 200
        assert not app.state.broker.paper.orders
        assert client.get("/api/v1/research/database").json()["runs"] == 1
        assert client.post("/api/v1/research/history", json=dict(payload, basket=[dict(code="2330", weight=1.5)])).status_code == 422


def test_latest_uses_common_cash_decision_time_not_futures_1345(tmp_path):
    store = ResearchStore(tmp_path / "research.db")
    data = load_history(Broker(Config()), store, request())
    latest_bar = dict(data["futures"][-1], time=data["futures"][-1]["time"]+15*60)
    data["futures"].append(latest_bar)
    data.pop("id"); data.pop("cacheHits"); data.pop("assetCount")
    saved = store.dataset(data)
    latest = store.latest(saved["id"])
    assert ((latest["time"]+28800) % 86400)//60 == 790
    assert latest["weightedReturn"] is not None
