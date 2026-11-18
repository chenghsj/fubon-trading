from array import array
from copy import deepcopy
from dataclasses import replace
from datetime import date, timedelta
from contextlib import redirect_stdout
import importlib.util
import io
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest

from fubon_bridge.candle_patterns import PatternRow, action_shapes, boundary
from fubon_bridge.confirmed_execution import outcome as old_outcome
from fubon_bridge.direction_execution import (VARIANTS, build, choose, clone, failed_structure,
    outcome, rule_scores)
from fubon_bridge.direction_models import (AuxiliaryBank, FEATURES, features, fit, policies,
    predict, select)
from fubon_bridge.learning_data import quality
from fubon_bridge.research import digest
from fubon_bridge.strategy_session import schedule
from test_confirmed_execution import action, oscillating_data
from test_regime_strategy import training_data


def revised(side=1,exit_mode='evidence',source='paired'):
    return clone(action(side=side,variant='structure-fixed'),source,exit_mode,(1.,0.,0.,0.))


def ridge(value,n):
    return dict(kind='ridge',center=[0.]*n,scale=[1.]*n,coefficients=[value]+[0.]*n)


def test_opposite_direction_can_win_and_ambiguous_positive_values_wait():
    buy,sell=revised(1),revised(-1)
    selected,_=choose([buy,sell],{buy.key:50.,sell.key:180.},'trend',0.,set())
    assert selected.side==-1
    assert choose([buy,sell],{buy.key:100.,sell.key:90.},'trend',0.,set())[1]=='ambiguousDirection'
    assert choose([buy,sell],{buy.key:-10.,sell.key:-20.},'trend',0.,set())[1]=='noPositiveScore'
    assert choose([buy,sell],{buy.key:50.,sell.key:180.},'trend',0.,{-1})[1]=='usedDirection'


def test_waiting_twelve_minutes_alone_does_not_trigger_exit():
    a=revised();trade=outcome(a)
    assert trade['reason']=='deadline' and trade['exitTime']==a.label_end
    blind=replace(a,variant='structure-managed')
    assert old_outcome(blind)['reason']=='no_progress'


def failure_path():
    a=revised()
    for i in range(93,96):
        a.bars[i].update(open=990.,high=992.,low=980.,close=984.)
    for i in range(96,99):
        a.bars[i].update(open=984.,high=986.,low=973.,close=974.)
    return a


def test_opposite_break_uses_previous_bar_and_waits_for_completed_three_minutes():
    a=failure_path()
    assert failed_structure(a,98,1002.,42.,90)
    assert not failed_structure(a,97,1002.,42.,90)
    assert not failed_structure(a,98,990.,42.,90)  # Still less than .5R adverse.
    # The current bar's low973 is below its close974; including it in the
    # breakout line would make this actual prior-low break impossible.
    assert a.bars[98]['close']>a.bars[98]['low']


def test_structural_exit_executes_next_open_including_adverse_gap():
    a=failure_path();a.bars[99].update(open=950.,high=952.,low=948.,close=950.)
    trade=outcome(a)
    assert trade['reason']=='failed_structure' and trade['exit']==948.
    assert trade['exitTime']==a.bars[98]['time']


def test_profit_trail_starts_next_bar_without_forced_break_even():
    a=revised();a.bars[90].update(open=1000.,high=1067.,low=990.,close=1065.)
    a.bars[91].update(open=1050.,high=1052.,low=992.,close=1040.)
    trade=outcome(a)
    assert trade['reason']=='stop' and trade['exit']==991. and trade['net']<0
    assert trade['exitTime']==a.bars[91]['time']  # Never retroactive to low990.


def test_new_trail_cannot_loosen_initial_stop_and_deadline_is_not_extended():
    a=revised();a.atr3=300.
    a.bars[90].update(open=1000.,high=1067.,low=990.,close=1065.)
    a.bars[91].update(open=1000.,high=1002.,low=950.,close=970.)
    assert outcome(a)['exit']==958.
    flat=revised()
    assert outcome(flat,delay=1)['exitTime']==flat.label_end
    flat.bars[149].update(open=975.,high=977.,low=973.,close=975.)
    assert outcome(flat)['reason']=='deadline'


def test_paired_universe_has_both_sides_unique_keys_and_causal_features():
    data=oscillating_data();dates=quality(data)['completeDates'];events,_=build(data,dates)
    assert len(events['paired-fixed'])>len(events['confirmed-fixed'])
    first=events['paired-fixed'][0];cutoff=first.time
    assert {a.side for a in events['paired-fixed'] if a.time==cutoff and a.plan=='trend'}=={1,-1}
    changed=deepcopy(data)
    for b in changed['futures']:
        if b['time']>cutoff:
            b.update(open=30000,close=30100,high=30200,low=29900,volume=9999)
    later,_=build(changed,dates)
    for variant in VARIANTS:
        assert len({a.key for a in events[variant]})==len(events[variant])
        projection=lambda rows:[(a.key,list(a.x),a.stop_level,a.context,a.extras) for a in rows if a.time<=cutoff]
        assert projection(events[variant])==projection(later[variant])
    shapes=action_shapes(events['paired-fixed'][:3])
    x=features(events['paired-fixed'][:3],shapes,{a.key:.25 for a in events['paired-fixed'][:3]})
    assert x.shape==(3,81) and np.isfinite(x).all()


def test_fixed_confirmed_execution_is_identical_to_parent():
    a=revised(exit_mode='fixed',source='confirmed')
    assert outcome(a)==old_outcome(a)
    assert rule_scores([a])[a.key]==1.


def test_auxiliary_cache_identity_and_strict_cutoff_exclude_future_changes(monkeypatch):
    import fubon_bridge.pattern_transfer as shared
    monkeypatch.setattr(shared,'tree',lambda x,y,w,n,p:ridge(float(np.average(y,weights=w)),63))
    cutoff=boundary('2024-09-01')
    rows=[PatternRow(asset,f'2024-08-{day:02}',cutoff-120,cutoff-1,[0.]*63,1.)
        for asset in ('TMF','2330','2454','2317','2881') for day in range(1,26) for _ in range(10)]
    rows += [PatternRow('TMF','2024-08-31',cutoff-60,cutoff,[999.]*63,999.)]
    a=AuxiliaryBank(rows,dict(dataset='a',implementation='v1'));key,record=a.get(cutoff)
    altered=deepcopy(rows);altered[-1].target=-999.;altered[-1].x=[-999.]*63
    b=AuxiliaryBank(altered,dict(dataset='b',implementation='v1'));other,after=b.get(cutoff)
    assert key!=other and record['hash']==after['hash']
    assert record['metadata']['maximumLabelEnd']==cutoff-1
    key2,_=a.get(cutoff+1)
    assert key2!=key and len(a.models)==2


def test_missing_auxiliary_block_is_not_valid_zero_direction():
    a=revised();shapes={a.key:([0.]*63,10.)}
    with pytest.raises(ValueError,match='不可用零'):
        features([a],shapes,{a.key:None})


def training_rows():
    dates=[(date(2024,7,29)+timedelta(days=i)).isoformat() for i in range(150)]
    rows=[];shapes={}
    for day in dates:
        start=int(schedule('regular').window(day)[0].timestamp())
        for minute in (90,100,110,120):
            x=array('f',[0.]*54);x[2]=3.;x[5]=.8
            a=SimpleNamespace(day=day,time=start+minute*60,start=start,session='regular',side=1,plan='trend',
                index=minute-1,end=minute+59,label_end=start+(minute+60)*60,key=(start+minute*60,1,'trend'),
                x=x,stop=30,target=60,planned_risk=400.,context=(0.,)*7,extras=(0.,)*4,marker=1.)
            rows.append(a);shapes[a.key]=([.1]*63,10.)
    return dates,rows,shapes


class FakeBank:
    def get(self,cutoff):
        model=ridge(1.,63)
        return str(cutoff),dict(model=model,hash=digest(model),metadata=dict(cutoff=cutoff,maximumLabelEnd=cutoff-1))

    def transform(self,events,shapes,cutoff):
        _,record=self.get(cutoff)
        assert all(boundary(a.day)>=cutoff for a in events)
        return {a.key:cutoff/1e9 for a in events},record


def test_crossfit_expands_fit_and_calibration_changes_cannot_change_model(monkeypatch):
    import fubon_bridge.direction_models as module
    captured=[]
    def tree(x,y,w,names,params):
        captured.append((x.copy(),y.copy()));return ridge(float(np.average(y,weights=w)),len(names))
    monkeypatch.setattr(module,'tree',tree)
    monkeypatch.setattr(module,'targets',lambda a:dict(normal=a.marker,stress=a.marker-1,delayed=a.marker-2))
    dates,rows,shapes=training_rows();bank=FakeBank()
    half,half_meta=fit(rows,dates,'regular','half-pooled',bank,shapes)
    full,meta=fit(rows,dates,'regular','crossfit-pooled',bank,shapes)
    assert half_meta['fitActions']==240 and meta['fitActions']==320
    assert [b['cutoff'] for b in meta['blocks']]==[boundary(dates[i]) for i in (40,60,80,100)]
    assert meta['auxiliaryFinal']['cutoff']==boundary(dates[120])
    assert meta['maximumLabelEnd']<meta['calibrationStart']
    changed=deepcopy(rows)
    for a in changed:
        if a.day>=dates[120]:
            a.marker=999.
    repeated,_=fit(changed,dates,'regular','crossfit-pooled',bank,shapes)
    assert repeated==full and all(np.max(y)<=1. for _,y in captured)
    assert full['features']==FEATURES and full['targetUnit']=='NTD'


def test_direction_model_uses_minimum_conditional_means_in_ntd():
    a=revised();a.x[2]=4.2;a.x[5]=.8;shapes={a.key:([.1]*63,10.)}
    model=dict(kind='direction_value',version=1,training='crossfit-pooled',features=FEATURES,targetUnit='NTD',auxiliary=ridge(1.,63),
        heads={s:ridge(v,len(FEATURES)) for s,v in (('normal',150.),('stress',130.),('delayed',150.))})
    assert predict(model,[a],shapes)[a.key]==130.
    invalid=deepcopy(model);invalid['targetUnit']='R'
    with pytest.raises(ValueError,match='NTD'):
        predict(invalid,[a],shapes)
    assert len(policies())==60 and select({})['selected'] is None


def test_insufficient_auxiliary_block_is_excluded_from_cash_fit(monkeypatch):
    import fubon_bridge.direction_models as module
    monkeypatch.setattr(module,'tree',lambda x,y,w,n,p:ridge(float(np.average(y,weights=w)),len(n)))
    monkeypatch.setattr(module,'targets',lambda a:dict(normal=1.,stress=0.,delayed=-1.))
    dates,rows,shapes=training_rows();missing=boundary(dates[40])
    class MissingBank(FakeBank):
        def transform(self,events,shapes,cutoff):
            values,record=super().transform(events,shapes,cutoff)
            if cutoff==missing:
                record['model']=None;record['metadata']['reason']='insufficient'
                values={a.key:None for a in events}
            return values,record
    model,meta=fit(rows,dates,'regular','crossfit-pooled',MissingBank(),shapes)
    assert model and meta['rawCandidates']==320 and meta['fitActions']==240 and meta['excludedMissingAux']==80


def test_entire_development_is_unchanged_by_later_price_and_volume(monkeypatch):
    import fubon_bridge.direction_models as module
    def small_tree(x,y,w,names,params):
        # Preserve feature statistics too: this catches future features as well
        # as future labels, while keeping the orchestration test inexpensive.
        return ridge(float(np.average(y,weights=w)),len(names))|dict(featureMean=np.average(x,axis=0,weights=w).tolist())
    monkeypatch.setattr(module,'tree',small_tree)
    path=Path(__file__).resolve().parents[2]/'scripts/research-direction-continuation.py'
    monkeypatch.syspath_prepend(str(path.parent))
    spec=importlib.util.spec_from_file_location('direction_runner_causality',path)
    runner=importlib.util.module_from_spec(spec);spec.loader.exec_module(runner)
    saved={};monkeypatch.setattr(runner,'save',lambda name,value:saved.update({name:digest(value)}))
    data=training_data(180);dates=quality(data)['completeDates']
    with redirect_stdout(io.StringIO()):
        first=runner.develop(data,dates,'regular',FakeBank())
    before=dict(saved);changed=deepcopy(data);last=dates[int(len(dates)*.6)-1]
    for b in changed['futures']:
        if b['time']>int(schedule('regular').window(last)[1].timestamp()):
            b.update(open=30000,high=31000,low=28000,close=30500,volume=99999)
    saved.clear()
    with redirect_stdout(io.StringIO()):
        repeated=runner.develop(changed,dates,'regular',FakeBank())
    assert first==repeated and before==saved
    assert any(m['hash']!=digest(None) for m in first[1].values())
