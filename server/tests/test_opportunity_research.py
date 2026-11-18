from copy import deepcopy
from dataclasses import replace
import hashlib
import importlib.util
from pathlib import Path

import pytest

from fubon_bridge.opportunity_models import (calibrate, final_checks, fit, policies,
    predict, select)
from fubon_bridge.opportunity_research import (FEATURES, POLICY, State, admission,
    build, compare, outcome, replay)
from fubon_bridge.strategy_session import schedule
from test_regime_strategy import candles, training_data


def one_action():
    return next(a for a in build(training_data(1))[0] if a.side==1 and a.plan=='scalp')


def test_minute_66_has_four_distinct_causal_actions_and_never_partial_context():
    data=training_data(1);actions,_=build(data);first=actions[:4]
    assert len({a.key for a in first})==4
    assert {a.time for a in first}=={data['futures'][65]['time']}
    assert all(len(a.x)==len(FEATURES) for a in first)
    assert len({tuple(a.x) for a in first})==4
    cutoff=first[0].time
    changed=deepcopy(data)
    for b in changed['futures']:
        if b['time']>cutoff:
            b.update(open=30000,close=30000,high=30001,low=29999,volume=9999)
    revised,_=build(changed)
    assert [(a.key,a.x,a.stop,a.target) for a in first]==[(a.key,a.x,a.stop,a.target) for a in revised[:4]]
    assert not POLICY['executionEnabled'] and not POLICY['adoptionAllowed']


def test_unclosed_three_and_fifteen_minute_candles_do_not_enter_features():
    bars=candles();start=bars[0]['time']-60
    original=State(start,'regular','2026-11-13')
    revised=State(start,'regular','2026-11-13')
    for i,b in enumerate(bars[:67]):
        left=original.push(b)
        right=revised.push(dict(b,high=b['high']+100,volume=10000) if i==66 else b)
    offset=FEATURES.index('m3Return')
    end=FEATURES.index('m15Trend')+1
    assert list(left[(1,'scalp')][0][offset:end])==list(right[(1,'scalp')][0][offset:end])
    assert left[(1,'scalp')][0]!=right[(1,'scalp')][0]


def test_costs_stop_first_gap_stop_and_original_deadline_on_delay():
    a=one_action();bars=deepcopy(a.bars);a=replace(a,bars=bars)
    previous=bars[a.index]['close']
    bars[a.index+1].update(open=previous,high=previous+100,low=previous-100,close=previous)
    trade=outcome(a)
    assert trade['reason']=='both_stop_first'
    assert trade['entry']==previous+2 and trade['exit']==trade['entry']-a.stop-2
    # Around 25,000: round-half-up tax is 5 per side; fees are 20 per side.
    assert trade['net']==-(a.stop+2)*10-50
    bars[a.index+1].update(high=previous+3,low=previous-2)
    bars[a.index+2].update(open=previous-70,high=previous-60,low=previous-80,close=previous-70)
    assert outcome(a)['reason']=='gap_stop'
    assert outcome(a)['exit']==previous-72
    for b in bars[a.index+1:a.end+1]:
        b.update(open=previous,close=previous,high=previous+1,low=previous-1)
    delayed=outcome(a,delay=1)
    assert delayed['exitTime']==a.label_end and delayed['reason']=='deadline'
    assert admission(replace(a,end=a.index+1),delay=1)[1]=='deadline'


def test_last_entry_and_realized_loss_budget_are_enforced_on_delayed_quotes():
    data=training_data(1);actions,_=build(data)
    last=next(a for a in reversed(actions) if a.side==1 and a.plan=='scalp')
    assert admission(last)[0] is not None
    assert admission(last,delay=1)[1]=='last_entry'
    assert admission(one_action(),realized=-900)[1]=='risk'


def test_replay_chooses_by_current_scores_and_cannot_pick_future_winner():
    actions=build(training_data(1))[0][:4];day=actions[0].day
    scores={a.key:(100 if a.side<0 else 10) for a in actions}
    result=replay(actions,scores,[day])
    assert result['count']==1 and result['trades'][0]['side']=='Sell'
    assert result['trades'][0]['plan']=='scalp'
    assert result['net']==outcome(next(a for a in actions if a.side<0 and a.plan=='scalp'))['net']
    assert result['byPlan']['scalp']['count']==1
    rejected=[replace(a,bars=deepcopy(a.bars)) for a in actions]
    top=next(a for a in rejected if a.side<0 and a.plan=='scalp')
    top.bars[top.index+1]['open']+=100
    assert replay(rejected,scores,[day])['count']==0
    assert replay(actions,{a.key:0 for a in actions},[day])['count']==0


def test_cluster_calibration_requires_days_and_rejects_missing_bin_without_fallback():
    a=one_action()
    rows=[(replace(a,day=f'2026-01-{i:02d}'),100+i) for i in range(1,11)]
    first=calibrate(rows,[50]*10)
    duplicated=calibrate(rows*5,[50]*50)
    assert next(iter(first.values()))['value']==pytest.approx(next(iter(duplicated.values()))['value'])
    short=calibrate(rows[:9],[50]*9)
    assert next(iter(short.values()))['days']==9
    assert next(iter(short.values()))['value'] is None
    class Model:
        def predict(self,x,**kwargs): return [500]*len(x)
    scores=predict(Model(),first,[a])
    assert scores['raw'][a.key]==500 and scores['calibrated'][a.key] is None
    with pytest.raises(ValueError,match='動作鍵重複'):
        predict(Model(),first,[a,a])


def test_native_model_has_purged_fit_calibration_boundaries_and_reloads():
    lgb=pytest.importorskip('lightgbm')
    data=training_data(20);actions,_=build(data);dates=sorted({a.day for a in actions})
    model,table,metadata=fit(actions,dates,'regular','small')
    assert metadata['maximumFitLabelEnd']<metadata['calibrationStart']
    assert metadata['maximumCalibrationLabelEnd']<metadata['calibrationEnd']
    assert not set(metadata['fitDates'])&set(metadata['calibrationDates'])
    assert metadata['splitCount']>0
    restored=lgb.Booster(model_str=model.model_to_string())
    first=predict(model,table,actions[:4]);second=predict(restored,table,actions[:4])
    assert first['raw']==pytest.approx(second['raw']) and first['calibrated']==second['calibrated']


def metric(count=0,net=0):
    return dict(count=count,net=net,maxDrawdown=0,withoutBestDay=net-1,
        byPlan={p:dict(count=count,net=net) for p in ('scalp','swing')})


def test_zero_trade_and_losing_candidates_cannot_become_selected():
    trials={name:dict(folds=[{s:metric() for s in ('normal','stress','delayed')} for _ in range(3)])
        for name in policies()}
    assert len(trials)==36
    assert select(trials)['selected'] is None
    name=next(iter(policies()))
    trials[name]['folds']=[{s:metric(40,100) for s in ('normal','stress','delayed')} for _ in range(3)]
    assert select(trials)['selected']==name
    trials[name]['folds'][0]['delayed']['net']=-1
    assert select(trials)['selected'] is None
    assert not final_checks({s:metric() for s in ('normal','stress','delayed')},
        {s:metric(3,500) for s in ('normal','stress','delayed')},'scalp')['passed']


def test_later_history_cannot_change_development_models_calibration_or_selection(monkeypatch):
    pytest.importorskip('lightgbm')
    path=Path(__file__).resolve().parents[2]/'scripts/research-opportunities.py'
    monkeypatch.syspath_prepend(str(path.parent))
    spec=importlib.util.spec_from_file_location('opportunity_runner_test',path)
    runner=importlib.util.module_from_spec(spec);spec.loader.exec_module(runner)
    data=training_data(50);dates=sorted({a.day for a in build(data)[0]})
    changed=deepcopy(data);cut=changed['futures'][30*300]['time']
    for b in changed['futures']:
        if b['time']>=cut:
            b.update(open=29000,close=30000,high=31000,low=28000,volume=9999)
    def develop(source):
        saved={};monkeypatch.setattr(runner,'save',lambda name,value:saved.update({name:value}))
        result,models=runner.develop(source,dates,'regular')
        # Full-source quality summary can differ; all actual development decisions cannot.
        return result['trials'],result['selection'],result['training'],models,saved
    assert develop(data)==develop(changed)
