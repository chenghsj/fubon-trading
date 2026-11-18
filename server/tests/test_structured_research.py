from copy import deepcopy
from dataclasses import replace
import importlib.util
import io
import json
import math
from contextlib import redirect_stdout
from pathlib import Path

import pytest

from fubon_bridge.learning_data import quality
from fubon_bridge.loss_diagnostics import decompose,matched_latency
from fubon_bridge.research import digest
from fubon_bridge.structured_models import (calibration_check,final_check,fit,policies,predict,
    select,targets_for,thin)
from fubon_bridge.structured_research import (FEATURES,build,compare,outcome,prepare,replay)
from test_regime_strategy import training_data


def events(days=3):
    data=training_data(days);dates=quality(data)['completeDates']
    return data,dates,build(data,dates)[0]


def test_fixed_fill_loss_accounting_and_matched_latency_do_not_mix_new_trades():
    trade=dict(time=1,side='Buy',plan='scalp',entry=25002,exit=25028,net=210,reason='target')
    result=decompose([trade])
    assert result['fixedPathGross']==300 and result['fees']==40
    assert result['taxes']==10 and result['slippage']==40 and result['net']==210
    assert result['fixedPathGross']-result['fees']-result['taxes']-result['slippage']==result['net']
    delayed=[dict(trade,net=-100),dict(trade,time=2,net=999)]
    paired=matched_latency([trade],delayed)
    assert paired['shared']==1 and paired['delayedOnly']==1
    assert paired['sharedDifference']==-310 and paired['flippedToLoss']==1
    with pytest.raises(ValueError,match='對帳'):
        decompose([dict(trade,net=0)])


def test_structured_features_and_frozen_target_are_causal_and_tick_valid():
    data,dates,original=events();assert original
    first=original[0];cutoff=first.time
    assert len(first.x)==len(FEATURES)==54
    assert 'monthSin' not in FEATURES and 'weekdaySin' not in FEATURES
    changed=deepcopy(data)
    for b in changed['futures']:
        if b['time']>cutoff:
            b.update(open=29000,close=30000,high=31000,low=28000,volume=9999)
    revised=build(changed,dates)[0]
    def projection(rows):
        return [(a.key,a.x,a.stop,a.target,a.target_level,a.planned_risk) for a in rows if a.time<=cutoff]
    assert projection(original)==projection(revised)
    assert all(a.target_level is None or float(a.target_level).is_integer() for a in original)
    assert len({a.key for a in original})==len(original)


def test_range_target_keeps_signal_level_under_quote_change_and_delay_keeps_deadline():
    _,_,sequence=events();a=next(a for a in sequence if a.side>0)
    bars=deepcopy(a.bars);a=replace(a,bars=bars)
    signal=bars[a.index]['close']
    for b in bars[a.index+1:a.end+1]:
        b.update(open=signal,close=signal,high=signal+1,low=signal-1)
    normal,_=prepare(a);late,_=prepare(a,extra=2,delay=1)
    assert normal and late
    first=outcome(a);delayed=outcome(a,delay=1)
    assert first['exitTime']==delayed['exitTime']==a.label_end
    bars[a.index+1].update(high=a.target_level+10,close=a.target_level)
    first=outcome(a)
    assert first['reason']=='target' and first['exit']==a.target_level-2
    bars[a.index+1]['open']=signal+8
    changed=outcome(a)
    assert changed['exit']==first['exit']
    far=replace(a,target_level=signal+10)
    assert prepare(far)[1]=='target_room'


def test_trend_pullback_is_available_without_chasing_or_future_structure():
    data=training_data(1);previous=25000
    for minute,b in enumerate(data['futures'],1):
        price=round(25000+.5*minute+12*math.sin(2*math.pi*minute/10))
        b.update(open=previous,close=price,high=max(previous,price)+1,low=min(previous,price)-1)
        previous=price
    sequence=build(data,quality(data)['completeDates'])[0]
    trend=[a for a in sequence if a.plan=='trend']
    assert trend and all(a.side==1 and a.target==2*a.stop and a.target_level is None for a in trend)
    assert all(a.label_end<=a.time+60*60 for a in trend)


def test_signal_minute_three_bar_cannot_redefine_structure_stop_or_recovery():
    data=training_data(1);previous=25000
    for minute,b in enumerate(data['futures'],1):
        phase=(minute+1)%30;price=round(24900+min(phase,30-phase)*200/15)
        b.update(open=previous,close=price,high=max(previous,price)+1,low=min(previous,price)-1)
        previous=price
    dates=quality(data)['completeDates'];original=build(data,dates)[0]
    selected=next(a for a in original if (a.time-a.start)//60%3==0)
    changed=deepcopy(data);changed['futures'][selected.index]['high']+=140
    revised=next(a for a in build(changed,dates)[0] if a.key==selected.key)
    assert revised.target_level==selected.target_level
    assert revised.stop==selected.stop and revised.planned_risk==selected.planned_risk
    assert revised.x[-3:-1]==selected.x[-3:-1]
    assert revised.x!=selected.x


def test_training_thinning_uses_earliest_causal_event_and_robust_target_keeps_no_fill(monkeypatch):
    _,_,sequence=events();a=sequence[0]
    later=replace(a,time=a.time+60)
    assert thin([later,a])==[a]
    import fubon_bridge.structured_models as module
    monkeypatch.setattr(module,'outcome',lambda action,extra=0,delay=0:None if delay else dict(net=100 if not extra else 50))
    assert targets_for(a,False)==dict(normal=100)
    assert targets_for(a,True)==dict(normal=100,stress=50,delayed=0)
    monkeypatch.setattr(module,'outcome',lambda action,extra=0,delay=0:None if not extra else dict(net=-200))
    assert targets_for(a,False)==dict(normal=0)
    assert targets_for(a,True)==dict(normal=0,stress=-200,delayed=0)


@pytest.mark.parametrize('name',['ridge-normal','tree-robust'])
def test_models_reload_and_only_fit_segment_can_change_model(name):
    pytest.importorskip('lightgbm')
    data,dates,sequence=events(90)
    model,meta=fit(sequence,dates,'regular',name)
    assert model is not None and meta['maximumLabelEnd']<meta['calibrationStart']
    scores=predict(model,sequence[:20])
    assert scores==pytest.approx(predict(json.loads(json.dumps(model)),sequence[:20]))
    changed=deepcopy(data);boundary=meta['calibrationStart']
    for b in changed['futures']:
        if b['time']>=boundary:
            b.update(open=29000,close=30000,high=31000,low=28000,volume=9999)
    revised,_=fit(build(changed,dates)[0],dates,'regular',name)
    assert digest(model)==digest(revised)


def test_calibration_uses_policy_trades_and_zero_trade_candidates_stay_unselected():
    _,dates,sequence=events(3)
    scores={a.key:1. for a in sequence}
    raw=compare(sequence,scores,dates,'range')
    assert not calibration_check(raw,'range')['passed']
    blocked=compare(sequence,scores,dates,'range',enabled=False)
    assert all(r['count']==0 for r in blocked.values())
    trials={p:dict(folds=[dict(calibration=dict(passed=False),raw=raw,guarded=blocked)]*3) for p in policies()}
    assert len(trials)==27 and select(trials)['selected'] is None
    assert replay(sequence,{a.key:None for a in sequence},dates)['count']==0


def test_calibration_and_selection_accept_sufficient_positive_evidence_only():
    def metrics(count):
        return dict(count=count,net=1000,withoutBestDay=900,
            byPlan=dict(range=dict(count=count,net=1000),trend=dict(count=0,net=0)))
    enough={s:metrics(30) for s in ('normal','stress','delayed')}
    assert calibration_check(enough,'range')['passed']
    blocked={s:metrics(0)|dict(net=0,withoutBestDay=0) for s in enough}
    trials={p:dict(folds=[dict(calibration=dict(passed=False),guarded=blocked)]*3) for p in policies()}
    trials['rule-range']=dict(folds=[dict(calibration=dict(passed=True),guarded=enough)]*3)
    assert select(trials)['selected']=='rule-range'
    positive_test={s:metrics(100) for s in enough}
    assert final_check(dict(validation=enough,historical_reused_test=positive_test),'range')['passed']
    positive_test['delayed']['count']=99
    assert not final_check(dict(validation=enough,historical_reused_test=positive_test),'range')['passed']


def test_development_artifacts_do_not_change_when_later_history_changes(monkeypatch):
    path=Path(__file__).resolve().parents[2]/'scripts/research-structured.py'
    monkeypatch.syspath_prepend(str(path.parent))
    spec=importlib.util.spec_from_file_location('structured_runner_test',path)
    runner=importlib.util.module_from_spec(spec);spec.loader.exec_module(runner)
    data,dates,_=events(130);changed=deepcopy(data)
    boundary=changed['futures'][int(len(dates)*.6)*300]['time']
    for b in changed['futures']:
        if b['time']>=boundary:
            b.update(open=29000,close=30000,high=31000,low=28000,volume=9999)
    def develop(source):
        saved={};monkeypatch.setattr(runner,'save',lambda name,value:saved.update({name:value}))
        with redirect_stdout(io.StringIO()):
            report,models,guards=runner.develop(source,dates,'regular')
        assert any(m is not None for m in saved.values())
        return report['trials'],report['selection'],report['training'],models,guards,saved
    assert develop(data)==develop(changed)
