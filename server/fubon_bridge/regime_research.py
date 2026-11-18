"""Frozen hybrid plus two diagnostic ablations; no optimizer or model reuse."""
from collections import defaultdict
import hashlib
import json
from pathlib import Path
import threading

from pydantic import BaseModel, ConfigDict, Field, model_validator

from .learning_data import quality
from .learning_features import chronological_split, simulate
from .mapping import now
from .regime_strategy import POLICY, VERSION, RegimeStream
from .research import RunConfig, canonical, digest
from .strategy_session import opening_date, schedule


class RegimeRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')
    dataset_id: str = Field(pattern=r'^[a-f0-9]{64}$')
    config: RunConfig

    @model_validator(mode='after')
    def bounded(self):
        c = self.config
        if c.quantity != 1 or c.stopPoints > 1000 or c.targetR > 20 or c.slippagePoints > 10 or c.feePerSide > 1000:
            raise ValueError('區間／順勢研究限微台單口與執行器可用的成本／風控設定')
        return self


class RegimeReports:
    def __init__(self, research):
        self.research, self.ready, self.lock = research, False, threading.Lock()

    def connect(self):
        with self.lock:
            if not self.ready:
                with self.research.connect() as db:
                    db.execute('CREATE TABLE IF NOT EXISTS research_regime_runs (id TEXT PRIMARY KEY, created_at TEXT, payload TEXT)')
                self.ready = True
        return self.research.connect()

    def save(self, report, fingerprint):
        report = dict(report, id=digest(fingerprint), createdAt=now().isoformat())
        with self.connect() as db:
            db.execute('INSERT OR IGNORE INTO research_regime_runs VALUES(?,?,?)', (report['id'], report['createdAt'], canonical(report)))
        return self.get(report['id'])

    def get(self, ident):
        with self.connect() as db:
            row = db.execute('SELECT payload FROM research_regime_runs WHERE id=?', (ident,)).fetchone()
        if not row:
            raise ValueError('找不到區間／順勢研究版本')
        return json.loads(row[0])

    def overview(self):
        with self.connect() as db:
            rows = db.execute('SELECT payload FROM research_regime_runs ORDER BY created_at DESC LIMIT 12').fetchall()
        return [{k: r[k] for k in ('id', 'createdAt', 'datasetId', 'strategySession', 'metricsPassed', 'source')} for r in (json.loads(row[0]) for row in rows)]


def build_events(data):
    session = data.get('strategySession', 'cash')
    if session not in {'regular', 'afterhours'}:
        raise ValueError('請選擇完整期貨日盤或夜盤資料版本')
    q = quality(data)
    complete = set(q['completeDates'])
    grouped = defaultdict(list)
    spec = schedule(session)
    for bar in data['futures']:
        day = opening_date(bar['time'], session)
        start = int(spec.window(day)[0].timestamp())
        if day in complete and start < bar['time'] <= start+spec.duration*60:
            grouped[day].append(bar)
    events, regime_counts = [], defaultdict(int)
    for day, bars in sorted(grouped.items()):
        start = int(spec.window(day)[0].timestamp())
        stream = RegimeStream(start, session)
        for i, bar in enumerate(bars):
            signal = stream.push(bar)
            if bar['time'] > start+spec.last_entry*60:
                continue
            regime_counts[signal['regime']] += 1
            if signal['side']:
                path = [r for r in bars[i+1:i+21] if r['time'] <= start+spec.exit_minute*60]
                if path:
                    events.append(dict(day=day, time=bar['time'], side=signal['side'], signal=signal,
                        x=signal['features'],
                        strategyVersion=VERSION, strategySession=session, month=bar['month'],
                        labelEnd=path[-1]['time'], path=path))
    return events, dict(q, events=len(events), regimeMinutes=dict(regime_counts))


def run(store, request, progress=lambda *_: None):
    data = store.dataset(request.dataset_id)
    config = request.config.model_dump(mode='json')
    config['taxRounding'] = 'per-contract-yuan'
    implementation = {name: hashlib.sha256(Path(__file__).with_name(name).read_bytes()).hexdigest()
        for name in ('regime_strategy.py', 'regime_research.py', 'intraday_strategy.py', 'learning_features.py', 'learning_data.py', 'strategy_session.py')}
    fingerprint = dict(dataset=request.dataset_id, config=config, policy=POLICY, implementation=implementation)
    reports = RegimeReports(store.research)
    try:
        return reports.get(digest(fingerprint))
    except ValueError:
        pass
    progress('逐分鐘重播已收盤1／3／15分K與盤勢判斷', .1)
    events, diagnostics = build_events(data)
    parts, split = chronological_split(events, diagnostics['completeDates'], data['strategySession'])
    comparisons = {}
    for i, (name, sequence) in enumerate(zip(('development', 'validation', 'test'), parts)):
        progress(f'計算{name}混合／僅順勢／僅區間與額外滑價', .25+i*.25)
        comparisons[name] = {}
        for variant, regimes in (('hybrid', {'range', 'trend'}), ('trend', {'trend'}), ('range', {'range'})):
            normal = simulate(sequence, config, regimes=regimes)
            stress = simulate(sequence, config, extra_slippage=2, regimes=regimes)
            normal['byRegime'] = {regime: dict(count=sum(t['regime']==regime for t in normal['trades']),
                net=sum(t['net'] for t in normal['trades'] if t['regime']==regime)) for regime in ('range', 'trend')}
            comparisons[name][variant] = dict(normal=normal, stress=stress)
    enough = diagnostics['completeDays'] >= 60
    passed = enough and all(comparisons[name]['hybrid']['normal']['count'] >= 20
        and comparisons[name]['hybrid']['normal']['net'] > 0 and comparisons[name]['hybrid']['stress']['net'] > 0
        for name in ('validation', 'test'))
    report = dict(datasetId=request.dataset_id, source=data['source'], strategySession=data['strategySession'],
        policy=POLICY, implementation=implementation, config=config, diagnostics=diagnostics,
        split=split, comparisons=comparisons, metricsPassed=passed, adoptionAllowed=False,
        executionEnabled=False, reasons=[
            '固定混合策略為主候選；僅順勢與僅區間只作拆解診斷，不用測試結果挑選贏家',
            '歷史數值門檻需至少60完整盤，驗證／測試各至少20筆且一般與每邊額外2點滑價均正淨額',
            '既有歷史期間已參與舊研究；此次為重用歷史的探索，仍須新的未見日期前測',
            '行情來源、休市日與個人費率尚需核對；歷史成交假設不包含排隊、未成交、延遲及市場衝擊',
            '盤勢分類與進出場參數是待驗證假設；通過數值門檻不代表未來獲利，也不核准正式交易'])
    return reports.save(report, fingerprint)
