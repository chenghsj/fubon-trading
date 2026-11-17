"""Independent acceptance cases for physical full-day and overnight sessions."""
from copy import deepcopy
from dataclasses import replace
from datetime import date, datetime, timedelta
from types import SimpleNamespace as NS

import pytest

from fubon_bridge.auto_gateway import PaperGateway, SandboxGateway
from fubon_bridge.auto_store import AutoStore
from fubon_bridge.auto_trading import AutoConfig, SandboxAutoTrader, empty_state
from fubon_bridge.learning_data import STOCKS, CollectionRequest, collect, futures_rows, quality
from fubon_bridge.learning_features import build_events, chronological_split, signal_features
from fubon_bridge.learning_inference import EntryFilter, model_settings
from fubon_bridge.learning_store import LearningStore
from fubon_bridge.learning_train import TrainingRequest, train
from fubon_bridge.mapping import TAIPEI
from fubon_bridge.research import ResearchStore
from fubon_bridge.strategy_session import entry_window, opening_date, schedule, window
from test_auto_gateway import sandbox_broker
from test_paper import AUTO, paper_trader


def local(day, hour, minute=0):
    return datetime.fromisoformat(day).replace(hour=hour, minute=minute, tzinfo=TAIPEI)


def session_bars(day='2026-11-13', session='afterhours', crossing=540):
    start, _ = schedule(session).window(day)
    rows = []
    for elapsed in range(1, schedule(session).duration + 1):
        close = 25020 if elapsed >= crossing else 25000
        rows.append(dict(time=int(start.timestamp()) + elapsed * 60,
            open=close, high=close + (2 if elapsed >= crossing else 10),
            low=close - (2 if elapsed >= crossing else 10), close=close,
            volume=10, month='202611'))
    return rows


def raw_bars(bars):
    return [dict(date=datetime.fromtimestamp(b['time'] - 60, TAIPEI).isoformat(),
        **{k: b[k] for k in ('open', 'high', 'low', 'close', 'volume')},
        contractMonth=b['month']) for b in bars]


def data_for(bars, session, start='2026-11-13', end='2026-11-16'):
    return dict(schema='fubon-learning-v2', source='synthetic', strategySession=session,
        start=start, end=end, product='TMF', contractQuery='1!', futures=bars,
        stocks={code: [] for code in STOCKS})


def test_full_regular_session_covers_0845_through_1345():
    start, end = schedule('regular').window('2026-11-13')
    assert (start, end) == (local('2026-11-13', 8, 45), local('2026-11-13', 13, 45))
    bars = session_bars(session='regular', crossing=20)
    assert len(bars) == 300
    assert bars[0]['time'] == int(local('2026-11-13', 8, 46).timestamp())
    assert bars[-1]['time'] == int(local('2026-11-13', 13, 45).timestamp())
    assert quality(data_for(bars, 'regular'))['completeDates'] == ['2026-11-13']
    events, _ = build_events(data_for(bars, 'regular'))
    assert events[0]['time'] == int(local('2026-11-13', 9, 5).timestamp())
    cfg = dict(trade_date='2026-11-13', strategy_session='regular')
    assert entry_window(cfg, local('2026-11-13', 9, 5))
    assert entry_window(cfg, local('2026-11-13', 13, 20))
    assert not entry_window(cfg, local('2026-11-13', 13, 21))


def test_monday_exchange_query_keeps_friday_and_saturday_physical_rows(tmp_path):
    bars = session_bars()
    rows = raw_bars(bars)
    monday = date(2026, 11, 16)
    normalized = futures_rows(rows, monday, monday, 'afterhours')
    assert normalized == bars
    assert normalized[0]['time'] == int(local('2026-11-13', 15, 1).timestamp())
    assert normalized[-1]['time'] == int(local('2026-11-14', 5).timestamp())
    calls = []
    def candles(kind, symbol, start, end, **kwargs):
        calls.append((kind, symbol, start, end, kwargs))
        return rows
    broker = NS(config=NS(mode='sandbox'), learning_candles=candles)
    store = LearningStore(ResearchStore(tmp_path / 'learning.db'))
    summary = collect(broker, store, CollectionRequest(start=monday, end=monday, session='afterhours'))
    assert calls == [('FUT', 'TMF', '2026-11-16', '2026-11-16', dict(session='afterhours'))]
    assert store.dataset(summary['id'])['futures'] == bars
    assert summary['completeDates'] == ['2026-11-13']


def test_840_minutes_stay_in_one_opening_day_and_a_missing_minute_excludes_night():
    bars = session_bars()
    assert len(bars) == 840
    assert opening_date(local('2026-11-14', 0).timestamp(), 'afterhours') == '2026-11-13'
    assert opening_date(local('2026-11-14', 5).timestamp(), 'afterhours') == '2026-11-13'
    q = quality(data_for(bars, 'afterhours'))
    assert q['completeDays'] == 1 and q['completeDates'] == ['2026-11-13']
    broken = bars[:539] + bars[540:]
    q = quality(data_for(broken, 'afterhours'))
    assert q['completeDays'] == 0 and q['excludedDays'] == ['2026-11-13']
    assert build_events(data_for(broken, 'afterhours'))[0] == []


def test_midnight_features_use_eight_futures_features_and_ignore_future():
    bars = session_bars(crossing=540)
    decision = int(local('2026-11-14', 0).timestamp())
    signal, values = signal_features(bars, decision, {}, 'afterhours')
    assert signal['side'] == 'Buy' and len(values) == 8
    changed = deepcopy(bars)
    changed[540].update(open=35000, high=35001, low=34999, close=35000)
    assert signal_features(changed, decision, {}, 'afterhours') == (signal, values)
    events, diagnostic = build_events(data_for(bars, 'afterhours'))
    assert diagnostic['missingStockEvents'] == 0
    assert events[0]['day'] == '2026-11-13' and events[0]['time'] == decision
    assert len(events[0]['path']) == 20
    with pytest.raises(ValueError, match='缺漏'):
        signal_features(bars[1:], decision, {}, 'afterhours')


def test_night_split_preserves_post_midnight_labels_before_next_open():
    dates = [(date(2026, 3, 2) + timedelta(days=i)).isoformat() for i in range(10)]
    events = []
    for day in dates:
        start, _ = schedule('afterhours').window(day)
        events.append(dict(day=day, time=int((start + timedelta(hours=8, minutes=55)).timestamp()),
            labelEnd=int((start + timedelta(hours=9, minutes=15)).timestamp())))
    # The last training night's 00:15 label belongs to that whole session.
    crossing = dict(events[5], labelEnd=int(schedule('afterhours').window(dates[6])[0].timestamp()))
    parts, split = chronological_split(events + [crossing], dates, 'afterhours')
    assert [len(p) for p in parts] == [6, 2, 2]
    assert events[5] in parts[0] and crossing not in parts[0]
    assert split['purged'] == [1, 0]


def test_same_account_and_opening_day_have_distinct_regular_and_night_plans(tmp_path):
    store = AutoStore(ResearchStore(tmp_path / 'plans.db'), 'paper')
    for session in ('regular', 'afterhours'):
        cfg = AutoConfig(account=AUTO, contract_code='TMFK6', trade_date='2026-11-13', strategy_session=session)
        state = dict(empty_state(), id='plan-' + session, config=cfg.model_dump(mode='json'), status='stopped')
        store.save(state)
    fresh = AutoStore(ResearchStore(tmp_path / 'plans.db'), 'paper')
    assert fresh.for_day(AUTO, '2026-11-13', 'regular')['id'] == 'plan-regular'
    assert fresh.for_day(AUTO, '2026-11-13', 'afterhours')['id'] == 'plan-afterhours'


def night_trader(tmp_path, crossing=535):
    trader, broker, clock, store, cfg = paper_trader(tmp_path)
    broker.config = replace(broker.config, session='afterhours')
    bars = session_bars(crossing=crossing)
    rows = raw_bars(bars)
    calls = []
    def candles(**kwargs):
        calls.append(kwargs)
        return dict(data=rows)
    broker._client = lambda kind: NS(intraday=NS(candles=candles))
    clock.at = local('2026-11-13', 23, 54)
    cfg = cfg.model_copy(update={'strategy_session': 'afterhours'})
    return trader, broker, clock, store, cfg, calls


def test_real_paper_book_enters_friday_and_stops_after_saturday_midnight(tmp_path):
    trader, broker, clock, store, cfg, calls = night_trader(tmp_path)
    trader.start(cfg, 'owner')
    clock.at = local('2026-11-13', 23, 55)
    trader.tick(); trader.tick()
    before = trader.snapshot()
    assert before['entryCount'] == 1 and before['position']['quantity'] == 1
    assert broker.paper.overview()['positions'][0]['signed_qty'] == 1
    assert calls and all(c['session'] == 'afterhours' for c in calls)
    clock.at = local('2026-11-14', 0, 1)
    clock.price = 24980
    trader.tick(); trader.tick()
    state = trader.snapshot()
    assert state['position'] is None and state['entryCount'] == 1
    assert state['realizedNet'] < 0 and state['usedSides'] == ['Buy']
    book = broker.paper.overview(AUTO['account_id'])
    assert not book['positions'] and len(book['orders']) == 2
    assert all(t['paper']['strategyDay'] == '2026-11-13' for t in book['orders'])
    assert book['orders'][-1]['paper']['filledDay'] == '2026-11-14'
    assert state['realizedNet'] == book['realizedNet']
    trader.shutdown()


def test_last_night_entry_exits_at_0455_before_the_session_closes(tmp_path):
    trader, broker, clock, store, cfg, _ = night_trader(tmp_path, crossing=815)
    trader.start(cfg, 'owner')
    clock.at = local('2026-11-14', 4, 35)
    trader.tick(); trader.tick()
    assert trader.snapshot()['position'] is not None
    clock.at = local('2026-11-14', 4, 54)
    trader.tick()
    assert len(broker.paper.overview()['orders']) == 1
    clock.at = local('2026-11-14', 4, 55)
    trader.tick(); trader.tick()
    assert trader.snapshot()['status'] == 'stopped'
    assert trader.snapshot()['position'] is None
    assert trader.snapshot()['exitReason'] == '盤別收盤前退出'
    assert len(broker.paper.overview()['orders']) == 2
    clock.at = local('2026-11-14', 5)
    trader.tick()
    assert len(broker.paper.overview()['orders']) == 2
    trader.shutdown()


def test_a_new_0440_signal_cannot_enter_after_the_night_cutoff(tmp_path):
    trader, broker, clock, store, cfg, _ = night_trader(tmp_path, crossing=820)
    trader.start(cfg, 'owner')
    clock.at = local('2026-11-14', 4, 40)
    trader.tick(); trader.tick()
    assert trader.snapshot()['entryCount'] == 0
    assert broker.paper.overview()['orders'] == []
    trader.shutdown()


def test_midnight_restart_requires_reconcile_then_exits_without_resetting_allowance(tmp_path):
    trader, broker, clock, store, cfg, _ = night_trader(tmp_path)
    trader.start(cfg, 'owner')
    clock.at = local('2026-11-13', 23, 55)
    trader.tick(); trader.tick()
    ident = trader.snapshot()['id']
    trader.shutdown()
    clock.at = local('2026-11-14', 0, 1)
    clock.price = 24980
    restored = SandboxAutoTrader(PaperGateway(broker), store, lambda h: h == 'owner',
        clock=lambda: clock.at, monotonic=lambda: clock.mono)
    assert restored.snapshot()['position'] is not None
    assert restored.snapshot()['entryCount'] == 1
    assert restored.snapshot()['monitoring'] is False
    restored.tick()
    assert len(broker.paper.overview()['orders']) == 1
    restored.control('reconcile', 'owner', ident, execution_allowed=True)
    restored.tick(); restored.tick()
    assert restored.snapshot()['position'] is None
    assert restored.snapshot()['entryCount'] == 1
    assert len(broker.paper.overview()['orders']) == 2
    restored.shutdown()


def training_nights(days=40):
    first = date(2026, 3, 2)
    futures = []
    dates = []
    cursor = first
    while len(dates) < days:
        if cursor.weekday() < 5:
            dates.append(cursor)
        cursor += timedelta(days=1)
    for i, day in enumerate(dates):
        bars = session_bars(day.isoformat(), crossing=20)
        # Both labels exist, with outcomes available strictly after the signal.
        for b in bars[20:]:
            b.update(open=25070 if i % 2 else 24970, high=25072 if i % 2 else 24972,
                low=25068 if i % 2 else 24968, close=25070 if i % 2 else 24970)
        bars[20].update(open=25020, high=25100 if i % 2 else 25022, low=25018 if i % 2 else 24900,
            close=25070 if i % 2 else 24970)
        futures.extend(bars)
    return dict(data_for(futures, 'afterhours', first.isoformat(), dates[-1].isoformat()), source='fubon-paper')


def test_trained_night_model_loads_and_deadline_exits_across_midnight(tmp_path):
    np = pytest.importorskip('numpy')
    pytest.importorskip('lightgbm')
    trader, broker, clock, auto_store, cfg, _ = night_trader(tmp_path)
    store = LearningStore(auto_store.research)
    data = training_nights()
    ident = store.save_dataset(data, quality(data))['id']
    report = train(store, TrainingRequest(dataset_id=ident, config=dict(stopPoints=30, targetR=2,
        quantity=1, feePerSide=12, feeSource='statement', slippagePoints=1, taxRate=.00002)))
    assert report['model'] and report['strategySession'] == 'afterhours' and len(report['features']) == 8
    cfg = AutoConfig.model_validate(dict(cfg.model_dump(mode='json'), **model_settings(report), model_run_id=report['id']))
    with pytest.raises(ValueError, match='設定不符'):
        EntryFilter(store, report['id'], dict(cfg.model_dump(mode='json'), strategy_session='regular'))
    trader.start(cfg, 'owner')
    # Isolate exit scheduling from model quality after a real fit/load/validation.
    trader.entry_filter.model.predict = lambda *_args, **_kwargs: np.array([.8])
    clock.at = local('2026-11-13', 23, 55)
    trader.tick(); trader.tick()
    state = trader.snapshot()
    assert state['position']['exitDeadline'] == int(local('2026-11-14', 0, 15).timestamp())
    assert state['lastSignal']['model']['accepted'] is True
    clock.at = local('2026-11-14', 0, 15)
    trader.tick(); trader.tick()
    assert trader.snapshot()['position'] is None
    assert len(broker.paper.overview()['orders']) == 2
    assert trader.snapshot()['entryCount'] == 1
    assert trader.snapshot()['exitReason'] == '模型20分鐘退出期限'
    trader.shutdown()


@pytest.mark.parametrize('mode', ['sandbox', 'live'])
def test_night_automation_never_reaches_broker_order_api(mode):
    broker, _, captures = sandbox_broker()
    broker.config = replace(broker.config, mode=mode, live_enabled=mode == 'live', session='afterhours')
    cfg = dict(account=broker.account_rows()[0], contract_code='TMFK6', trade_date='2026-11-13', strategy_session='afterhours')
    with pytest.raises(ValueError):
        SandboxGateway(broker).prepare(cfg)
    order = dict(action='Buy', price=25000, quantity=1, price_type='LMT', order_type='IOC', octype='New')
    with pytest.raises(ValueError):
        broker.place(dict(code='TMFK6', security_type='FUT'), order, cfg['account'], client_tag='FA1234abcd')
    assert captures == []


@pytest.mark.parametrize('session', ['regular', 'afterhours'])
def test_full_session_plans_reject_the_contracts_expiry_opening_day(tmp_path, session):
    trader, broker, clock, store, cfg = paper_trader(tmp_path)
    broker.config = replace(broker.config, session='afterhours' if session == 'afterhours' else 'regular')
    cfg = cfg.model_copy(update={'strategy_session': session, 'trade_date': date(2026, 11, 18)})
    with pytest.raises(ValueError, match='尚未到期'):
        PaperGateway(broker).prepare(cfg.model_dump(mode='json'))
    assert not broker.paper.overview()['orders']
