"""Independent completed-candle and one-minute execution acceptance checks."""
from copy import deepcopy
from datetime import date, datetime, timedelta

import numpy as np
import pytest

from fubon_bridge.auto_trading import AutoConfig
from fubon_bridge.learning_data import STOCKS, quality
from fubon_bridge.learning_features import build_events, features_for, policy_for, signal_features
from fubon_bridge.learning_inference import EntryFilter, model_settings
from fubon_bridge.learning_multiframe import closed_candles, multiframe_features
from fubon_bridge.learning_store import LearningStore
from fubon_bridge.learning_train import TrainingRequest, train
from fubon_bridge.mapping import TAIPEI
from fubon_bridge.research import ResearchStore
from fubon_bridge.strategy_session import schedule
from test_learning import CONFIG, fixture
from test_paper import AUTO, paper_trader
from test_strategy_sessions import data_for, local, session_bars

MTF = 'mtf_1_3_15'


def increasing_bars(start, length):
    return [dict(time=start+i*60, open=100+i*2, high=103+i*2,
        low=99+i*2, close=101+i*2, volume=i) for i in range(1, length+1)]


def test_three_and_fifteen_minute_candles_close_only_on_session_anchored_boundaries():
    start = int(local('2026-11-13', 8, 45).timestamp())
    bars = increasing_bars(start, 30)
    three = closed_candles(bars, start, start+20*60, 3)
    assert len(three) == 6
    assert three[0] == dict(time=start+3*60, open=102, high=109, low=101, close=107, volume=6)
    assert three[-1] == dict(time=start+18*60, open=132, high=139, low=131, close=137, volume=51)
    fifteen = closed_candles(bars, start, start+29*60, 15)
    assert fifteen == [dict(time=start+15*60, open=102, high=133, low=101, close=131, volume=120)]
    assert closed_candles(bars, start, start+30*60, 15)[-1] == dict(
        time=start+30*60, open=132, high=163, low=131, close=161, volume=345)


def test_multiframe_values_match_hand_calculation_for_closed_candles():
    start = int(local('2026-11-13', 8, 45).timestamp())
    bars = increasing_bars(start, 30)
    values = multiframe_features(bars, start, start+20*60, 1)
    # Latest complete candles end at minutes 20, 18 and 15, respectively.
    expected = [
        141/140-1, 4/141, 1/4, .0, 20/18, 141/136-1,
        137/132-1, 8/137, 5/8, .5, 51/33, 137/120-1,
        131/102-1, 32/131, 29/32, .875, 1., 131/102-1,
    ]
    np.testing.assert_allclose(values, expected, rtol=1e-12, atol=1e-12)
    short = multiframe_features(bars, start, start+20*60, -1)
    for index, (long_value, short_value) in enumerate(zip(values, short)):
        assert short_value == pytest.approx(long_value if index % 6 in {1, 4} else -long_value)


def test_partial_and_future_minutes_cannot_change_completed_three_or_fifteen_minute_values():
    bars = session_bars(session='regular', crossing=20)
    decision = int(local('2026-11-13', 9, 5).timestamp())
    original = signal_features(bars, decision, {}, 'regular', MTF)
    changed = deepcopy(bars)
    changed[18].update(open=25000, high=28000, low=24990, close=25005, volume=10000)
    changed[19].update(open=25010, high=29000, low=25000, close=25020, volume=50000)
    current = signal_features(changed, decision, {}, 'regular', MTF)
    assert original[0]['side'] == current[0]['side'] == 'Buy'
    # The first eight are legacy features, followed by six per timeframe.
    assert len(original[1]) == len(current[1]) == 26
    assert original[1][8:14] != current[1][8:14]
    assert original[1][14:] == current[1][14:]
    future = deepcopy(bars)
    for row in future:
        if row['time'] > decision:
            row.update(open=float('nan'), high=float('inf'), close=-1, volume=999999)
    assert signal_features(future, decision, {}, 'regular', MTF) == original


@pytest.mark.parametrize('problem', ['hole', 'duplicate'])
def test_missing_or_duplicate_required_minutes_are_rejected_by_aggregation(problem):
    start = int(local('2026-11-13', 8, 45).timestamp())
    bars = increasing_bars(start, 30)
    bars = bars[1:] if problem == 'hole' else bars + [dict(bars[0])]
    with pytest.raises(ValueError, match='缺漏|重複'):
        closed_candles(bars, start, start+20*60, 3)


def test_one_minute_decisions_find_breakout_before_the_next_five_minute_bar():
    data = data_for(session_bars(session='regular', crossing=21), 'regular')
    mtf_events, _ = build_events(data, feature_set=MTF)
    base_events, _ = build_events(data)
    assert mtf_events[0]['time'] == int(local('2026-11-13', 9, 6).timestamp())
    assert base_events[0]['time'] == int(local('2026-11-13', 9, 10).timestamp())
    assert mtf_events[0]['signal']['side'] == base_events[0]['signal']['side'] == 'Buy'
    with pytest.raises(ValueError):
        signal_features(data['futures'], mtf_events[0]['time'], {}, 'regular', 'base')


def test_night_aggregation_continues_through_midnight_but_resets_at_the_next_open():
    bars = session_bars(crossing=539)
    bars[539].update(open=25000, high=25010, low=24990, close=25000)
    data = data_for(bars, 'afterhours')
    events, _ = build_events(data, feature_set=MTF)
    wanted = {int(local('2026-11-13', 23, 59).timestamp()), int(local('2026-11-14', 0, 1).timestamp())}
    midnight_events = [event for event in events if event['time'] in wanted]
    assert {event['time'] for event in midnight_events} == wanted
    assert all(event['day'] == '2026-11-13' and event['signal']['high'] == 25010 for event in midnight_events)
    decision = int(local('2026-11-14', 0, 1).timestamp())
    start = int(local('2026-11-13', 15).timestamp())
    aggregated = closed_candles(bars, start, decision, 15)
    assert len(aggregated) == 36 and aggregated[-1]['time'] == int(local('2026-11-14', 0).timestamp())
    # Previous-session shocks must never become the new session's trend/volume.
    previous = session_bars(day='2026-11-12')
    for row in previous:
        row.update(open=100000, high=100010, low=99990, close=100000, volume=999999)
    assert signal_features(previous+bars, decision, {}, 'afterhours', MTF) == signal_features(bars, decision, {}, 'afterhours', MTF)


def test_legacy_base_features_and_five_minute_events_are_preserved():
    data = fixture(2)
    implicit, _ = build_events(data)
    explicit, _ = build_events(data, feature_set='base')
    assert implicit == explicit
    assert features_for('cash') == features_for('cash', 'base') and len(features_for('cash')) == 12
    assert policy_for('cash') == policy_for('cash', 'base')
    assert all(event['time'] % 300 == 0 for event in implicit)
    event = implicit[0]
    assert signal_features(data['futures'], event['time'], data['stocks']) == signal_features(
        data['futures'], event['time'], data['stocks'], feature_set='base')


def training_data(days=60):
    dates = []
    cursor = date(2026, 3, 2)
    while len(dates) < days:
        if cursor.weekday() < 5:
            dates.append(cursor)
        cursor += timedelta(days=1)
    futures = []
    for index, day in enumerate(dates):
        bars = session_bars(day.isoformat(), 'regular', crossing=21)
        for row in bars[21:]:
            close = 25070 if index % 2 else 24970
            row.update(open=close, high=close+2, low=close-2, close=close)
        bars[21].update(open=25020, high=25100 if index % 2 else 25022,
            low=25018 if index % 2 else 24900)
        futures.extend(bars)
    return dict(schema='fubon-learning-v2', source='fubon-paper', strategySession='regular',
        start=dates[0].isoformat(), end=dates[-1].isoformat(), product='TMF', contractQuery='1!',
        futures=futures, stocks={code: [] for code in STOCKS})


@pytest.fixture(scope='module', params=['fixed', 'walkforward'])
def trained(request, tmp_path_factory):
    pytest.importorskip('lightgbm')
    store = LearningStore(ResearchStore(tmp_path_factory.mktemp('multiframe-'+request.param) / 'research.db'))
    data = training_data()
    # Source substitution is confined to this synthetic isolated fixture.
    ident = store.save_dataset(data, quality(data))['id']
    specification = TrainingRequest(dataset_id=ident, config=CONFIG, method=request.param, feature_set=MTF)
    report = train(store, specification)
    assert report['model'] is not None
    return store, report, data


def config_for(report):
    return AutoConfig(account=AUTO, contract_code='TMFK6', trade_date='2026-11-13',
        model_run_id=report['id'], **model_settings(report)).model_dump(mode='json')


def test_real_training_native_load_and_inference_use_identical_multiframe_features(trained):
    store, report, data = trained
    assert report['featureSet'] == MTF
    assert report['policy']['decisionMinutes'] == 1 and report['policy']['timeframes'] == [1, 3, 15]
    assert report['features'] == features_for('regular', MTF) and len(report['features']) == 26
    config = config_for(report)
    assert config['decision_minutes'] == 1
    restored = EntryFilter(store, report['id'], config)
    assert restored.model.num_feature() == 26
    events, _ = build_events(data, feature_set=MTF)
    event = events[0]
    signal, values = signal_features(data['futures'], event['time'], {}, 'regular', MTF)
    result = restored.evaluate(data['futures'], event['time'], {})
    assert signal == event['signal'] and values == event['x'] == result['features']
    assert result['score'] == float(restored.model.predict(np.asarray([values]), num_threads=2)[0])
    assert result['accepted'] == (result['score'] >= result['threshold'])


def test_forged_frequency_cannot_load_a_one_minute_model_as_five_minute(trained):
    store, report, _ = trained
    with pytest.raises(ValueError, match='設定不符'):
        EntryFilter(store, report['id'], config_for(report) | dict(decision_minutes=5))


def one_minute_trader(tmp_path, trained):
    source, report, _ = trained
    trader, broker, clock, store, cfg = paper_trader(tmp_path)
    learning = LearningStore(store.research)
    with source.connect() as db, learning.connect() as target:
        row = db.execute('SELECT * FROM research_learning_runs WHERE id=?', (report['id'],)).fetchone()
        target.execute('INSERT INTO research_learning_runs VALUES(?,?,?,?,?)', row)
    bars = session_bars(session='regular', crossing=21)
    broker.kbars = lambda *_: dict(datetime=[datetime.fromtimestamp(b['time'], TAIPEI).isoformat() for b in bars],
        **{column: [b[key] for b in bars] for key, column in [('open','Open'),('high','High'),('low','Low'),('close','Close'),('volume','Volume')]})
    clock.at = local('2026-11-13', 9, 5)
    cfg = AutoConfig.model_validate(cfg.model_dump(mode='json') | config_for(report))
    trader.start(cfg, 'owner')
    forced = .9 if trader.entry_filter.kind == 'binary' else trader.entry_filter.threshold+1
    trader.entry_filter.model.predict = lambda *_args, **_kwargs: np.asarray([forced])
    return trader, broker, clock, cfg


def test_runtime_processes_0906_one_minute_signal_and_places_real_paper_order(tmp_path, trained):
    trader, broker, clock, cfg = one_minute_trader(tmp_path, trained)
    clock.at = local('2026-11-13', 9, 6) + timedelta(seconds=1)
    trader.tick(); trader.tick()
    state = trader.snapshot()
    assert cfg.decision_minutes == 1
    assert state['lastSignal']['time'] == int(local('2026-11-13', 9, 6).timestamp())
    assert state['entryCount'] == 1 and state['position']['quantity'] == 1
    assert len(state['lastSignal']['model']['features']) == 26
    assert len(broker.paper.overview()['orders']) == 1
    trader.shutdown()


def test_send_guard_rejects_previous_minutes_accepted_model_signal(tmp_path, trained):
    trader, broker, clock, _ = one_minute_trader(tmp_path, trained)
    clock.at = local('2026-11-13', 9, 6) + timedelta(seconds=1)
    clock.price = 25040  # Accepted model, but entry is rejected by price-drift risk.
    trader.tick()
    assert trader.snapshot()['lastSignal']['model']['accepted'] is True
    assert trader.snapshot()['entryCount'] == 0
    clock.at = local('2026-11-13', 9, 7) + timedelta(seconds=1)
    clock.price = 25020
    trader.state['quote'] = trader.gateway.quote(trader.state['contract'])
    with pytest.raises(ValueError, match='模型訊號'):
        trader._send('Buy', 'entry', 'stale accepted minute regression')
    assert broker.paper.overview()['orders'] == []
    trader.shutdown()


def test_one_minute_configuration_requires_a_model_and_invalid_intervals_are_rejected():
    with pytest.raises(ValueError):
        AutoConfig(account=AUTO, contract_code='TMFK6', trade_date='2026-11-13', decision_minutes=1)
    with pytest.raises(ValueError):
        AutoConfig(account=AUTO, contract_code='TMFK6', trade_date='2026-11-13', decision_minutes=3,
            strategy_version='orb_atr_v2', model_run_id='a'*64)


def test_training_feature_set_defaults_to_base_and_rejects_unknown_versions():
    assert TrainingRequest(dataset_id='a'*64, config=CONFIG).feature_set == 'base'
    with pytest.raises(ValueError):
        TrainingRequest(dataset_id='a'*64, config=CONFIG, feature_set='arbitrary')
