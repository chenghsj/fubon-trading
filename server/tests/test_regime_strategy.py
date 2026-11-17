from copy import deepcopy
from dataclasses import replace
from datetime import date, timedelta
import math

import pytest

from fubon_bridge.auto_trading import AutoConfig
from fubon_bridge.learning_data import STOCKS
from fubon_bridge.learning_features import build_events, features_for, outcome, signal_features
from fubon_bridge.learning_inference import EntryFilter, model_settings, validate_report
from fubon_bridge.learning_store import LearningStore
from fubon_bridge.learning_train import TrainingRequest, train
from fubon_bridge.regime_research import RegimeReports, RegimeRequest, run
from fubon_bridge.regime_strategy import POLICY, VERSION, RegimeStream, entry_plan, regime_signal
from fubon_bridge.research import ResearchStore
from fubon_bridge.strategy_session import schedule
from test_paper import AUTO, paper_trader
from test_strategy_sessions import data_for

FEATURE_SET = 'regime_1_3_15'
CONFIG = dict(stopPoints=30, targetR=2, quantity=1, feePerSide=20,
    feeSource='assumed', slippagePoints=2, taxRate=.00002)
LIVE = dict(strategy_version=VERSION, stop_points=30, target_points=60,
    slippage_points=2, fee_per_side=20, tax_rate=.00002, loss_limit=1000)


def candles(day='2026-11-13', session='regular', kind='trend', losing=False):
    start = int(schedule(session).window(day)[0].timestamp())
    result, previous = [], 25000
    for minute in range(1, schedule(session).duration+1):
        if kind == 'range':
            phase = minute % 30
            price = round(24900+min(phase,30-phase)*200/15)
        else:
            price = 25000+2*minute
            if losing and minute > 137:
                price = 25274-min(40,(minute-137)*10)
        result.append(dict(time=start+minute*60, open=previous, high=max(previous,price)+1,
            low=min(previous,price)-1, close=price, volume=10, month='202611'))
        previous = price
    return result


def candidate(**changes):
    return AutoConfig(account=AUTO, contract_code='TMFK6', trade_date='2026-11-13',
        strategy_version=VERSION, strategy_session='regular', decision_minutes=1, **changes)


def training_data(days=60):
    dates, cursor = [], date(2026,3,2)
    while len(dates) < days:
        if cursor.weekday() < 5:
            dates.append(cursor.isoformat())
        cursor += timedelta(days=1)
    rows = [b for i, day in enumerate(dates) for b in candles(day,kind='range' if i%3==0 else 'trend',losing=i%2==0)]
    return dict(schema='fubon-learning-v2', source='fubon-paper', strategySession='regular',
        start=dates[0], end=dates[-1], product='TMF', contractQuery='1!', futures=rows,
        stocks={c: [] for c in STOCKS})


def first_signal(rows, session='regular', regime=None):
    start = int(schedule(session).window('2026-11-13')[0].timestamp())
    stream = RegimeStream(start,session)
    return next(signal for b in rows if (signal:=stream.push(b))['side'] and (regime is None or signal['regime']==regime))


def test_nine_closed_fifteen_minute_bars_are_required_and_trend_uses_rolling_channel():
    rows = candles()
    start = rows[0]['time']-60
    assert regime_signal(rows,start+134*60,'regular')['regime']=='warming'
    signal = first_signal(rows)
    assert signal['time']==start+136*60
    assert signal['regime']=='trend' and signal['side']=='Buy'
    assert signal['regimeTime']==start+135*60 and signal['contextTime']==start+135*60
    assert signal['efficiency']==1
    # The price has been above its opening range for two hours; it can still
    # generate a NEW rolling structure entry, independently of the old ORB.
    assert signal['trigger']>max(b['high'] for b in rows[:15])


def test_range_buys_lower_edge_reentry_and_sells_upper_edge_reentry():
    rows = candles(kind='range')
    stream = RegimeStream(rows[0]['time']-60,'regular')
    signals = [s for b in rows if (s:=stream.push(b))['side']]
    assert {s['side'] for s in signals}=={'Buy','Sell'}
    assert all(s['regime']=='range' and s['low']<s['targetLevel']<s['high'] for s in signals)
    assert all((s['targetLevel']-s['close'])*(1 if s['side']=='Buy' else -1)>0 for s in signals)


def test_partial_three_minute_and_future_candles_cannot_redefine_the_trigger():
    rows = candles()
    decision = rows[135]['time']
    original = regime_signal(rows,decision,'regular')
    changed = deepcopy(rows)
    changed[135]['high'] = 99999
    for b in changed[136:]:
        b.update(open=-1,close=float('nan'),high=float('inf'))
    revised = regime_signal(changed,decision,'regular')
    assert revised['side']==original['side']=='Buy'
    assert revised['trigger']==original['trigger'] and revised['regimeTime']==original['regimeTime']
    assert revised['features'][10:16]!=original['features'][10:16]
    assert revised['features'][16:]==original['features'][16:]


def test_uncertain_efficiency_is_no_entry():
    rows = candles()
    targets = [25000,25020,25010,25030,25020,25040,25030,25050,25040]
    previous = 25000
    for i,b in enumerate(rows[:135]):
        end=targets[i//15]; left=targets[i//15-1] if i>=15 else 25000
        price=left+(end-left)*(i%15+1)/15
        b.update(open=previous,high=max(previous,price)+1,low=min(previous,price)-1,close=price)
        previous=price
    signal = regime_signal(rows,rows[134]['time'],'regular')
    assert .25 < signal['efficiency'] < .55
    assert signal['regime']=='uncertain' and signal['side'] is None


@pytest.mark.parametrize('problem',['missing','duplicate','nan'])
def test_missing_or_invalid_minutes_block_entries(problem):
    rows = candles()
    if problem=='missing': del rows[20]
    elif problem=='duplicate': rows.insert(20,dict(rows[20]))
    else: rows[20]['volume']=float('nan')
    result = regime_signal(rows,rows[140]['time'],'regular')
    assert result['side'] is None and '資料' in result['reason'] or result['side'] is None and '行情' in result['reason']


def test_night_keeps_one_session_across_midnight_and_new_session_resets():
    rows = candles(session='afterhours')
    signal=regime_signal(rows,rows[540]['time'],'afterhours')
    assert signal['regime']=='trend' and signal['regimeTime']>=rows[539]['time']
    next_rows=candles('2026-11-16',session='afterhours')
    assert regime_signal(rows+next_rows,next_rows[19]['time'],'afterhours')['regime']=='warming'


def test_range_plan_accepts_inside_range_and_rejects_cost_room_drift_and_risk():
    signal=dict(time=123,side='Buy',strategyVersion=VERSION,regime='range',close=24950,
        atr=40,trigger=24940,high=25100,low=24900,stopLevel=24890,targetLevel=25000)
    plan,reason=entry_plan(LIVE,signal,'Buy',24952,24950,0)
    assert reason is None and plan['stopPoints']==62 and plan['targetPoints']==48
    assert plan['estimatedRisk']<=1000
    assert entry_plan(LIVE,dict(signal,targetLevel=24960),'Buy',24952,24950,0)[1]
    assert entry_plan(LIVE,signal,'Buy',24975,24950,0)[1]
    assert entry_plan(LIVE,signal,'Buy',24952,24950,-500)[1]
    assert entry_plan(LIVE,signal,'Buy',24952,24939,0)[1]


def test_historical_events_and_online_features_are_identical_and_causal():
    rows=candles(kind='range')
    events,_=build_events(data_for(rows,'regular'),FEATURE_SET)
    assert events and len(events[0]['x'])==len(features_for('regular',FEATURE_SET))==28
    event=events[0]
    signal,values=signal_features(rows,event['time'],{},'regular',FEATURE_SET)
    assert values==event['x'] and signal==event['signal']
    changed=deepcopy(rows)
    for b in changed:
        if b['time']>event['time']: b.update(open=1,close=1,low=1,high=1)
    assert signal_features(changed,event['time'],{},'regular',FEATURE_SET)==(signal,values)
    trade=outcome(event,CONFIG)
    assert trade and trade['entry'] == event['path'][0]['open']+(2 if event['side']=='Buy' else -2)
    assert trade['exitTime'] <= event['time']+20*60 and trade['regime']=='range'


def test_paper_range_signal_fills_local_book_and_exits_at_confirmed_fill_target(tmp_path):
    trader,broker,clock,store,_=paper_trader(tmp_path)
    rows=candles(kind='range'); signal=first_signal(rows,regime='range')
    trader.gateway.bars=lambda *_:deepcopy(rows)
    clock.at=schedule('regular').window('2026-11-13')[0]+timedelta(seconds=signal['time']-(rows[0]['time']-60)-30)
    clock.price=signal['close']
    cfg=candidate()
    trader.start(cfg,'owner')
    clock.at+=timedelta(seconds=31)
    trader.tick(); trader.tick()
    state=trader.snapshot('owner')
    assert state['position'] and state['position']['quantity']==1
    assert state['orders'][0]['regime']=='range' and state['orders'][0]['filled']==1
    assert state['orders'][0]['fillPrice']!=state['orders'][0]['limit']
    assert state['position']['target']==(math.floor(signal['targetLevel']) if signal['side']=='Buy' else math.ceil(signal['targetLevel']))
    if signal['side']=='Sell':
        assert state['position']['stop']==max(math.ceil(signal['stopLevel']),state['position']['entryPrice']+30)
    else:
        assert state['position']['stop']==min(math.floor(signal['stopLevel']),state['position']['entryPrice']-30)
    assert state['position']['exitDeadline']==signal['time']+20*60
    assert broker.config.broker_orders is False
    clock.price=state['position']['target']+(1 if state['position']['side']=='Buy' else -1)
    trader.tick(); trader.tick()
    assert trader.snapshot()['position'] is None and len(broker.paper.overview()['orders'])==2
    assert store.latest()['realizedNet'] is not None


def test_unfiltered_v3_requests_exit_at_twenty_minute_deadline(tmp_path):
    trader,broker,clock,store,_=paper_trader(tmp_path)
    rows=candles(kind='range'); signal=first_signal(rows,regime='range')
    trader.gateway.bars=lambda *_:deepcopy(rows)
    clock.at=schedule('regular').window('2026-11-13')[0]+timedelta(seconds=signal['time']-(rows[0]['time']-60)-30)
    clock.price=signal['close']
    trader.start(candidate(),'owner'); clock.at+=timedelta(seconds=31)
    trader.tick(); trader.tick()
    assert trader.snapshot()['position'] is not None
    clock.at+=timedelta(seconds=20*60)
    trader.heartbeat('owner',trader.state['id'],True)
    trader.tick(); trader.tick()
    assert trader.snapshot()['position'] is None
    assert trader.snapshot()['exitReason']=='訊號20分鐘退出期限'


def test_confirmed_fill_outside_frozen_risk_estimate_requests_exit(tmp_path):
    trader,broker,clock,store,_=paper_trader(tmp_path)
    rows=candles(kind='range'); signal=first_signal(rows,regime='range')
    trader.gateway.bars=lambda *_:deepcopy(rows)
    clock.at=schedule('regular').window('2026-11-13')[0]+timedelta(seconds=signal['time']-(rows[0]['time']-60)-30)
    clock.price=signal['close']
    trader.start(candidate(),'owner'); clock.at+=timedelta(seconds=31)
    trader.tick()
    # Deliberately worse authoritative detail tests the post-fill guard;
    # ordinary local IOC fills cannot exceed the submitted limit.
    trader.gateway.fill_price=lambda *_:signal['close']-150
    trader._reconcile(); trader._rebuild()
    assert trader.snapshot()['position'] is not None
    assert trader.snapshot()['status']=='stopping' and trader.snapshot()['exitRequested']
    assert trader.snapshot()['exitReason']=='成交後風險超過凍結預算'


def test_exact_three_minute_close_is_features_only_not_trigger_context():
    rows=candles(); decision=rows[137]['time']
    original=regime_signal(rows,decision,'regular')
    changed=deepcopy(rows); changed[137]['high']=99999
    revised=regime_signal(changed,decision,'regular')
    assert original['contextTime']==decision-3*60
    assert revised['high']==original['high'] and revised['low']==original['low']


def test_wilder_three_minute_atr_matches_independent_hand_calculation():
    rows=candles(kind='range'); decision=rows[139]['time']
    completed=[rows[i:i+3] for i in range(0,138,3)]
    previous=None; trs=[]
    for block in completed:
        high=max(b['high'] for b in block); low=min(b['low'] for b in block)
        trs.append(high-low if previous is None else max(high-low,abs(high-previous),abs(low-previous)))
        previous=block[-1]['close']
    expected=sum(trs[:14])/14
    for tr in trs[14:]: expected=(expected*13+tr)/14
    assert regime_signal(rows,decision,'regular')['atr']==pytest.approx(expected)


def test_config_and_gateway_reject_cross_family_or_wrong_environment(tmp_path):
    for changes in ({'decision_minutes':5},{'strategy_session':'cash'},{'loss_limit':1001}):
        values=dict(account=AUTO,contract_code='TMFK6',trade_date='2026-11-13',strategy_version=VERSION,strategy_session='regular',decision_minutes=1)
        with pytest.raises(ValueError): AutoConfig(**(values|changes))
    trader,broker,clock,store,_=paper_trader(tmp_path)
    broker.config=replace(broker.config,mode='sandbox')
    with pytest.raises(ValueError,match='Paper'): trader.start(candidate(),'owner')
    assert not broker.paper.overview()['orders']


def test_fixed_comparison_preserves_all_ablations_and_never_enables_execution(tmp_path):
    store=LearningStore(ResearchStore(tmp_path/'research.db'))
    data=training_data(15)
    saved=store.save_dataset(data,dict(source=data['source']))
    report=run(store,RegimeRequest(dataset_id=saved['id'],config=CONFIG))
    assert report['policy']==POLICY and not report['adoptionAllowed'] and not report['executionEnabled']
    assert not report['metricsPassed']
    assert set(report['comparisons'])=={'development','validation','test'}
    assert all(set(values)=={'hybrid','range','trend'} for values in report['comparisons'].values())
    assert RegimeReports(store.research).get(report['id'])==report
    assert run(store,RegimeRequest(dataset_id=saved['id'],config=CONFIG))==report


def test_new_regime_model_really_trains_loads_and_cannot_use_orb_configuration(tmp_path):
    store=LearningStore(ResearchStore(tmp_path/'research.db'))
    data=training_data()
    saved=store.save_dataset(data,dict(source=data['source']))
    report=train(store,TrainingRequest(dataset_id=saved['id'],config=CONFIG,feature_set=FEATURE_SET))
    assert report['model'] and report['features']==features_for('regular',FEATURE_SET)
    settings=model_settings(report)
    assert settings['strategy_version']==VERSION and settings['decision_minutes']==1
    cfg=dict(candidate().model_dump(mode='json'),**settings,trade_date='2026-11-16',model_run_id=report['id'])
    model=EntryFilter(store,report['id'],cfg)
    events,_=build_events(data,FEATURE_SET)
    event=events[-1]
    bars=[b for b in data['futures'] if b['time'] <= event['time']]
    result=model.evaluate(bars,event['time'],{})
    assert len(result['features'])==28 and math.isfinite(result['score'])
    with pytest.raises(ValueError,match='不符'):
        validate_report(report,dict(cfg,strategy_version='orb_atr_v2'))
