"""Indexed local research data. No order API, real-time clock, or PaperBook dependency."""
from datetime import date, datetime, timedelta
from contextlib import contextmanager
import hashlib
import json
import math
from pathlib import Path
import sqlite3
import threading
import time
from typing import Literal
import zlib

from pydantic import BaseModel, Field, model_validator

from .mapping import TAIPEI, now, stamp


class BasketMember(BaseModel):
    code: str = Field(pattern=r"^\d{4,6}$")
    weight: float = Field(gt=0, le=1, allow_inf_nan=False)


class HistoryRequest(BaseModel):
    product: str = Field(default="TMF", pattern=r"^(TMF|MXF|TXF)$")
    contract_month: str = Field(pattern=r"^20\d{2}(0[1-9]|1[0-2])$")
    start: date
    end: date
    basket: list[BasketMember] = Field(min_length=1, max_length=12)
    weight_date: date
    refresh: bool = False
    offline: bool = False

    @model_validator(mode="after")
    def valid_range(self):
        if not 0 <= (self.end - self.start).days <= 30:
            raise ValueError("每次下載範圍須為 1–31 天")
        if self.end >= now().date():
            raise ValueError("回測先使用已完成交易日；結束日期必須早於今天")
        if len({m.code for m in self.basket}) != len(self.basket) or sum(m.weight for m in self.basket) > 1.000001:
            raise ValueError("股票不可重複，權重合計不可超過 100%")
        if self.refresh and self.offline:
            raise ValueError("離線讀取不能同時重新下載")
        return self


Finite = Field(allow_inf_nan=False)


class RunConfig(BaseModel):
    stopPoints: int = Field(ge=1)
    targetR: float = Field(gt=0, allow_inf_nan=False)
    quantity: int = Field(ge=1, le=100)
    feePerSide: float = Field(ge=0, allow_inf_nan=False)
    slippagePoints: int = Field(ge=0)
    taxRate: float = Field(ge=0, le=.01, allow_inf_nan=False)


class RunContext(BaseModel):
    id: str = Field(pattern=r"^[a-f0-9]{64}$")
    source: str
    product: Literal["TMF", "MXF", "TXF"]
    contractMonth: str
    start: date
    end: date
    weightDate: date


class RunTrade(BaseModel):
    side: Literal["long", "short"]
    entryTime: int
    exitTime: int
    entry: float = Finite
    exit: float = Finite
    gross: float = Finite
    costs: float = Field(ge=0, allow_inf_nan=False)
    net: float = Finite
    reason: str = Field(max_length=100)
    ambiguous: bool


class RunPoint(BaseModel):
    time: int
    value: float = Finite


class RunSummary(BaseModel):
    trades: list[RunTrade] = Field(max_length=1000)
    equity: list[RunPoint] = Field(max_length=10000)
    net: float = Finite
    gross: float = Finite
    costs: float = Field(ge=0, allow_inf_nan=False)
    maxDrawdown: float = Field(ge=0, allow_inf_nan=False)
    winRate: float | None = Field(ge=0, le=1, allow_inf_nan=False)


class RunDiagnostics(BaseModel):
    completeDays: int = Field(ge=0)
    excludedDays: list[str]
    missingBasketTimes: int = Field(ge=0)
    filterRejected: int = Field(ge=0)


class ComparisonRecord(BaseModel):
    config: RunConfig
    context: RunContext
    baseline: RunSummary
    filtered: RunSummary
    diagnostics: RunDiagnostics
    warnings: list[str]


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def digest(value):
    return hashlib.sha256(canonical(value).encode()).hexdigest()


def normalize(rows, start, end):
    """Fubon uses minute starts; expose UTC minute-close availability times."""
    result = {}
    for row in rows:
        raw = row["date"]
        dt = datetime.fromisoformat(raw.replace("Z", "+00:00")) if isinstance(raw, str) else stamp(raw)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=TAIPEI)
        local = dt.astimezone(TAIPEI)
        if not start <= local.date() <= end:
            continue
        if local.second or local.microsecond:
            raise ValueError("歷史分 K 時間不是完整分鐘")
        # The official futures feed emits null OHLC / zero volume for no-trade minutes.
        # Keep these as gaps rather than inventing a tradable price or failing the whole query.
        if all(row.get(k) is None for k in ("open", "high", "low", "close")) and row.get("volume") == 0:
            continue
        try:
            values = [float(row[k]) for k in ("open", "high", "low", "close", "volume")]
        except (TypeError, ValueError, KeyError):
            raise ValueError("歷史分 K 含無效 OHLCV") from None
        o, h, l, c, v = values
        if not all(math.isfinite(x) for x in values) or min(o, h, l, c) <= 0 or v < 0 or h < max(o, c) or l > min(o, c) or h < l:
            raise ValueError("歷史分 K 含無效 OHLCV")
        bar = dict(time=int(dt.timestamp()) + 60, open=o, high=h, low=l, close=c, volume=v)
        if bar["time"] in result and result[bar["time"]] != bar:
            raise ValueError("歷史分 K 有同時間衝突資料")
        result[bar["time"]] = bar
    return sorted(result.values(), key=lambda b: b["time"])


class ResearchStore:
    def __init__(self, path):
        self.path = Path(path)
        self._schema_lock = threading.Lock()
        self._initialized = False

    @contextmanager
    def connect(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        db = sqlite3.connect(self.path, timeout=20)
        try:
            # Concurrent first panel requests must not race the journal-mode transition.
            # Initialize once; regular reads need neither DDL nor another WAL transition.
            with self._schema_lock:
                if not self._initialized:
                    db.execute("PRAGMA journal_mode=WAL")
                    db.executescript("""
            CREATE TABLE IF NOT EXISTS research_bars (
                source TEXT, kind TEXT, symbol TEXT, month TEXT, session TEXT, time INTEGER,
                open REAL, high REAL, low REAL, close REAL, volume REAL,
                PRIMARY KEY(source,kind,symbol,month,session,time));
            CREATE TABLE IF NOT EXISTS research_ranges (
                source TEXT, kind TEXT, symbol TEXT, month TEXT, session TEXT,
                start TEXT, end TEXT, fetched_at TEXT,
                PRIMARY KEY(source,kind,symbol,month,session,start,end));
            CREATE TABLE IF NOT EXISTS research_weights (
                id TEXT PRIMARY KEY, as_of TEXT, captured_at TEXT, payload TEXT);
            CREATE TABLE IF NOT EXISTS research_datasets (
                id TEXT PRIMARY KEY, created_at TEXT, payload BLOB);
            CREATE TABLE IF NOT EXISTS research_runs (
                id TEXT PRIMARY KEY, created_at TEXT, dataset_id TEXT, payload TEXT);
            CREATE TABLE IF NOT EXISTS research_signals (
                dataset_id TEXT, time INTEGER, source TEXT, price REAL, weighted_return REAL, missing TEXT,
                PRIMARY KEY(dataset_id,time));
                    """)
                    self._initialized = True
            with db:
                yield db
        finally:
            db.close()

    def bars(self, key, start, end):
        with self.connect() as db:
            coverage = db.execute("""SELECT 1 FROM research_ranges WHERE source=? AND kind=? AND symbol=?
                AND month=? AND session=? AND start<=? AND end>=?""", (*key, start, end)).fetchone()
            if not coverage:
                return None
            lo = int(datetime.fromisoformat(start).replace(tzinfo=TAIPEI).timestamp()) + 60
            hi = int((datetime.fromisoformat(end).replace(tzinfo=TAIPEI) + timedelta(days=1)).timestamp())
            rows = db.execute("""SELECT time,open,high,low,close,volume FROM research_bars
                WHERE source=? AND kind=? AND symbol=? AND month=? AND session=? AND time>=? AND time<=? ORDER BY time""", (*key, lo, hi))
            return [dict(zip(("time", "open", "high", "low", "close", "volume"), row)) for row in rows]

    def put_bars(self, key, start, end, bars):
        lo = int(datetime.fromisoformat(start).replace(tzinfo=TAIPEI).timestamp()) + 60
        hi = int((datetime.fromisoformat(end).replace(tzinfo=TAIPEI) + timedelta(days=1)).timestamp())
        with self.connect() as db:
            # Replace the requested range atomically, including rows removed by a provider correction.
            db.execute("DELETE FROM research_bars WHERE source=? AND kind=? AND symbol=? AND month=? AND session=? AND time>=? AND time<=?", (*key, lo, hi))
            db.execute("DELETE FROM research_ranges WHERE source=? AND kind=? AND symbol=? AND month=? AND session=? AND NOT(end<? OR start>?)", (*key, start, end))
            db.executemany("INSERT INTO research_bars VALUES(?,?,?,?,?,?,?,?,?,?,?)", [(*key, b["time"], b["open"], b["high"], b["low"], b["close"], b["volume"]) for b in bars])
            db.execute("INSERT INTO research_ranges VALUES(?,?,?,?,?,?,?,?)", (*key, start, end, now().isoformat()))

    def dataset(self, payload):
        ident = digest(payload)
        indexes = {code: {b["time"]: b for b in bars} for code, bars in payload["stocks"].items()}
        decisions = []
        for bar in payload["futures"]:
            t = bar["time"]
            if not (560 <= ((t+28800) % 86400)//60 <= 790 and t % 300 == 0):
                continue
            score, missing = 0, []
            for member in payload["basket"]:
                series = indexes[member["code"]]
                if t not in series or t-300 not in series:
                    missing.append(member["code"])
                else:
                    score += member["weight"] * (series[t]["close"] / series[t-300]["close"]-1)
            decisions.append((ident, t, payload["source"], bar["close"], None if missing else score, canonical(missing)))
        with self.connect() as db:
            db.execute("INSERT OR IGNORE INTO research_datasets VALUES(?,?,?)", (ident, now().isoformat(), zlib.compress(canonical(payload).encode())))
            db.executemany("INSERT OR IGNORE INTO research_signals VALUES(?,?,?,?,?,?)", decisions)
            weights = dict(as_of=payload["weightDate"], basket=payload["basket"], classification="fixed-assumption")
            db.execute("INSERT OR IGNORE INTO research_weights VALUES(?,?,?,?)", (digest(weights), payload["weightDate"], now().isoformat(), canonical(weights)))
        return dict(payload, id=ident)

    def save_run(self, dataset_id, payload):
        payload = ComparisonRecord.model_validate(payload).model_dump(mode="json")
        if payload["context"]["id"] != dataset_id:
            raise ValueError("回測結果與資料版本不符")
        if len(canonical(payload)) > 2_000_000:
            raise ValueError("回測紀錄過大")
        ident = digest(dict(dataset_id=dataset_id, payload=payload))
        with self.connect() as db:
            row = db.execute("SELECT payload FROM research_datasets WHERE id=?", (dataset_id,)).fetchone()
            if not row:
                raise ValueError("找不到回測資料版本")
            data = json.loads(zlib.decompress(row[0]))
            if payload["context"] != {key:data[key] for key in RunContext.model_fields if key != "id"} | {"id":dataset_id}:
                raise ValueError("回測結果來源與保存資料不符")
            db.execute("INSERT OR IGNORE INTO research_runs VALUES(?,?,?,?)", (ident, now().isoformat(), dataset_id, canonical(payload)))
        return dict(id=ident)

    def runs(self):
        with self.connect() as db:
            records = []
            for i, t, d, p in db.execute("SELECT id,created_at,dataset_id,payload FROM research_runs ORDER BY created_at DESC LIMIT 10"):
                try:
                    result = ComparisonRecord.model_validate_json(p).model_dump(mode="json")
                    if result["context"]["id"] == d:
                        records.append(dict(id=i, createdAt=t, datasetId=d, result=result))
                except ValueError:
                    continue  # An invalid older row must never crash the research panel.
            return records

    def stats(self):
        with self.connect() as db:
            return {name: db.execute(f"SELECT COUNT(*) FROM research_{name}").fetchone()[0] for name in ("bars", "datasets", "weights", "runs", "signals")}

    def latest(self, dataset_id):
        started = time.perf_counter()
        with self.connect() as db:
            row = db.execute("SELECT time,source,price,weighted_return,missing FROM research_signals WHERE dataset_id=? ORDER BY time DESC LIMIT 1", (dataset_id,)).fetchone()
            if not row:
                raise ValueError("沒有 09:20–13:10 的已完成共同決策時點")
        t, source, price, score, missing = row
        return dict(time=t, source=source, price=price, weightedReturn=score,
            missing=json.loads(missing), historical=True, elapsedMs=round((time.perf_counter()-started)*1000, 2))


def load_history(broker, store, request):
    start, end = request.start.isoformat(), request.end.isoformat()
    source = "synthetic" if broker.config.mode == "demo" else "fubon-" + broker.config.mode
    assets = [("FUT", request.product, request.contract_month)] + [("STK", m.code, "") for m in request.basket]
    loaded, cache_hits = {}, 0
    for kind, symbol, month in assets:
        key = (source, kind, symbol, month, "regular")
        bars = None if request.refresh else store.bars(key, start, end)
        if bars is not None:
            cache_hits += 1
        elif request.offline:
            raise ValueError(f"本地資料庫缺少 {symbol} {start}–{end}，請先下載")
        else:
            bars = normalize(broker.research_candles(kind, symbol, month, start, end), request.start, request.end)
            store.put_bars(key, start, end, bars)
        if not bars:
            raise ValueError(f"{symbol} 在指定期間沒有分 K；請確認交易日、合約及行情權限")
        loaded[symbol] = bars
    payload = dict(schema="fubon-intraday-v1", source=source, product=request.product,
        contractMonth=request.contract_month, multiplier={"TMF": 10, "MXF": 50, "TXF": 200}[request.product],
        start=start, end=end, weightDate=request.weight_date.isoformat(),
        basket=[m.model_dump() for m in request.basket], futures=loaded.pop(request.product), stocks=loaded)
    return dict(store.dataset(payload), cacheHits=cache_hits, assetCount=len(assets))
