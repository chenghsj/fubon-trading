from array import array
from copy import deepcopy
from dataclasses import replace
from datetime import date, timedelta
import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest

from fubon_bridge.candle_patterns import action_shapes, boundary
from fubon_bridge.position_value import ExitEngine as ParentEngine, FEATURES as BASE_FEATURES, states
from fubon_bridge.recovery_lock import (FEATURES, ExitBank, RecoveryEngine, cash, extend,
    fit_entry, fit_groups, policies, predict, replay, select)
from fubon_bridge.research import digest
from fubon_bridge.strategy_session import opening_date, schedule
from test_direction_continuation import ridge
from test_position_value import loss_path, model as parent_model, training_actions


def mean_model(value):
    return dict(kind='recovery_exit',version=1,family='mean',features=BASE_FEATURES,targetUnit='NTD',heads=dict(mean=ridge(value,76)))


def protected_model(p=.1,gain=1000.,loss=200.):
    return dict(kind='recovery_exit',version=1,family='protected',features=FEATURES,targetUnit='NTD',
        heads={k:ridge(v,83) for k,v in dict(probability=p,gain=gain,loss=loss).items()})


@pytest.mark.parametrize('side',[1,-1])
def test_two_closed_confirmations_execute_next_open_including_gap(side):
    a=loss_path(side);engine=RecoveryEngine(protected_model(),'protected')
    rows=states(a,cache=engine.cache);first,second=rows[:2]
    a.bars[second['index']+1].update(open=1000-side*60,high=1002-side*60,low=998-side*60,close=1000-side*60)
    t=engine.outcome(a,marks=True)
    assert t['reason']=='protected_continuation' and t['decisionTime']==second['time']
    assert t['exitTime']>first['time'] and t['exit']==1000-side*62
    assert t['recoveryProbability']==pytest.approx(.1) and t['continuationValue']==pytest.approx(-80)
    assert len(t['marks'])==second['index']-90+2


def test_recovery_probability_and_expected_upside_both_protect_temporary_losers():
    a=loss_path();a.bars[110].update(open=1085.,high=1090.,low=1080.,close=1086.)
    for m in (protected_model(.4,100,1000),protected_model(.2,1000,100)):
        e=RecoveryEngine(m,'protected');t=e.outcome(a)
        assert t['reason']=='target' and t['net']>0
    assert RecoveryEngine(protected_model(),'protected').outcome(a)['net']<0


def test_ineligible_completed_close_resets_confirmation_streak():
    a=loss_path();a.bars[98].update(open=1000.,high=1002.,low=978.,close=1000.)
    t=RecoveryEngine(protected_model(),'protected').outcome(a)
    assert t['decisionTime']==a.bars[104]['time']


def test_hard_stop_before_second_confirmation_and_shallow_loss_do_not_exit():
    a=loss_path();a.bars[98]['low']=950.
    assert RecoveryEngine(protected_model(),'protected').outcome(a)['reason']=='stop'
    a=loss_path()
    for b in a.bars[91:]:
        b.update(open=1005.,high=1007.,low=1003.,close=1005.)
    assert RecoveryEngine(protected_model(),'protected').outcome(a)['reason']=='deadline'


@pytest.mark.parametrize('value',[-100.,100.])
def test_mean_engine_exactly_replays_parent_same_model_and_marks(value):
    a=loss_path()
    a.bars[a.index+2].update(open=1000.,high=1002.,low=978.,close=980.)
    for extra,delay in ((0,0),(2,0),(0,1)):
        actual=RecoveryEngine(mean_model(value),'mean').outcome(a,extra,delay,marks=True)
        assert actual is not None
        assert actual==ParentEngine(parent_model(value)).outcome(a,extra,delay,marks=True)


def test_regime_features_and_first_decision_are_causal():
    a=loss_path();e=RecoveryEngine(protected_model(),'protected');row=states(a,cache=e.cache)[0]
    x=extend(a,row,0,0,e.cache);assert len(x)==83
    cutoff=a.bars[101]['time'];b=deepcopy(a)
    for bar in b.bars:
        if bar['time']>cutoff:
            bar.update(open=9000.,high=9002.,low=8998.,close=9000.,volume=9999.)
    f=RecoveryEngine(protected_model(),'protected');other=states(b,cache=f.cache)[0]
    assert extend(b,other,0,0,f.cache)==x
    assert e.outcome(a)==f.outcome(b)


def groups():
    result=[]
    for j in range(30):
        day=(date(2024,8,1)+timedelta(days=j)).isoformat()
        for k in range(4):
            a=SimpleNamespace(day=day,label_end=boundary(day)+3600)
            ss=[]
            for scenario in ('normal','stress') if k%2 else ('normal',):
                rows=[(array('d',[float(j),float(k)]+[0.]*81),100. if n%2 else -500.,boundary(day)+n*60) for n in range(10+k)]
                ss.append((scenario,rows))
            result.append((a,ss))
    return result


def test_component_targets_weighting_and_binary_schema(monkeypatch):
    import fubon_bridge.recovery_lock as module
    calls=[]
    def fake_tree(x,y,w,names,parameters):
        calls.append((x.copy(),y.copy(),w.copy(),list(names),dict(parameters)))
        return ridge(float(np.average(y,weights=w)),len(names))
    monkeypatch.setattr(module,'tree',fake_tree)
    rows=groups();dates=sorted({a.day for a,_ in rows});models,meta=fit_groups(rows,dates,boundary('2024-09-01'))
    assert models['protected'] is not None and len(calls)==4
    assert calls[1][4]['objective']=='binary' and set(calls[1][1])=={0,1}
    assert np.all(calls[2][1]>0) and np.all(calls[3][1]>=0)
    assert all(np.isclose(w.sum(),len(w)) for _,_,w,_,_ in calls)
    assert models['protected']['heads']['gain']['coefficients'][0]==pytest.approx(100.)
    assert models['protected']['heads']['loss']['coefficients'][0]==pytest.approx(500.)
    assert meta['positiveDays']==meta['nonpositiveDays']==30
    assert np.allclose(calls[0][0],calls[1][0][:,:76])


def test_missing_conditional_class_is_not_replaced_by_zero_or_mean(monkeypatch):
    import fubon_bridge.recovery_lock as module
    monkeypatch.setattr(module,'tree',lambda x,y,w,n,p:ridge(float(np.average(y,weights=w)),len(n)))
    rows=groups();rows=[(a,[(s,[(x,0.,t) for x,_,t in values]) for s,values in ss]) for a,ss in rows]
    models,meta=fit_groups(rows,sorted({a.day for a,_ in rows}),boundary('2024-09-01'))
    assert models['mean'] is not None and models['protected'] is None and meta['positiveStates']==0
    assert RecoveryEngine(None,'protected').outcome(loss_path()) is None


def test_exit_bank_recent_window_and_exact_midnight_label_are_strict(monkeypatch):
    import fubon_bridge.recovery_lock as module
    events=training_actions(130);cutoff=boundary('2024-12-09');dates=sorted({a.day for a in events})
    # Both quote and features may exist, but a label exactly at cutoff is forbidden.
    events[-1].bars[events[-1].end]['time']=cutoff
    observed=[]
    def group(a):
        observed.append(a);return []
    bank=ExitBank(events,dict(dataset='frozen'));monkeypatch.setattr(bank,'group',group)
    record=bank.get(cutoff)
    assert len(record['metadata']['fitDates'])==120 and record['metadata']['fitDates'][0]==dates[-120]
    assert all(a.label_end<cutoff for a in observed) and events[-1] not in observed
    bank.get(cutoff);assert len(bank.records)==1


def test_future_only_night_opening_date_cannot_shift_prior_120_day_window(monkeypatch):
    import fubon_bridge.recovery_lock as module
    monkeypatch.setattr(module,'tree',lambda x,y,w,n,p:ridge(float(np.average(y,weights=w)),len(n))|
        dict(featureMean=np.average(x,axis=0,weights=w).tolist()))
    events=training_actions(120);dates=sorted({a.day for a in events});cutoff=boundary(dates[-1])+2*86400
    future=deepcopy(events[-1]);shift=cutoff+60-future.time
    for b in future.bars:
        b['time']+=shift
    future.time+=shift;future.start+=shift
    future.day=(date.fromisoformat(dates[-1])+timedelta(days=1)).isoformat();future.session='afterhours'
    assert boundary(future.day)<cutoff<future.time<future.label_end
    def group(a):
        value=1000. if a.day==dates[0] else 0.
        return [('normal',[(array('d',[value]+[0.]*82),value,a.time) for _ in range(10)])]
    left=ExitBank(events,dict(dataset='before'));right=ExitBank(events+[future],dict(dataset='after'))
    monkeypatch.setattr(left,'group',group);monkeypatch.setattr(right,'group',group)
    original=left.get(cutoff);changed=right.get(cutoff)
    assert original['metadata']==changed['metadata'] and original['hashes']==changed['hashes']
    assert original['metadata']['fitDates']==dates and original['metadata']['actions']==480


def event_pair(second_net):
    a=loss_path();b=replace(a,index=119,time=a.bars[119]['time'],side=-1,stop_level=1020.,stop=42)
    class Engine:
        family='protected';model={'valid':True}
        def outcome(self,event,extra=0,delay=0,realized=0,marks=False):
            net=-200. if event.side==1 else second_net
            return dict(time=event.time,exitTime=event.time+60,day=event.day,plan=event.plan,
                side='Buy' if event.side==1 else 'Sell',entry=1000.,exit=1000.,net=net,
                reason='protected_continuation' if event.side==1 else 'deadline',risk=480.,marks=[])
    return a,b,Engine()


@pytest.mark.parametrize('second_net',[-300.,500.])
def test_session_lock_prevents_both_added_losses_and_profitable_opportunities(second_net):
    a,b,engine=event_pair(second_net);scores={a.key:100.,b.key:100.}
    free=replay([a,b],scores,[a.day],engine,'free');locked=replay([a,b],scores,[a.day],engine,'lock')
    assert free['count']==2 and locked['count']==1
    assert locked['net']-free['net']==-second_net and locked['funnel']['earlyExitLocked']==1


def test_lock_persists_across_midnight_and_resets_only_next_opening_day():
    a,b,engine=event_pair(-300.)
    for i in range(len(a.bars),220):
        a.bars.append(dict(a.bars[-1],time=a.bars[-1]['time']+60))
    for bar in a.bars:
        bar['time']+=13*3600
    a.time+=13*3600;a.session='afterhours';a.start=int(schedule('afterhours').window(a.day)[0].timestamp())
    b=replace(a,index=179,time=a.bars[179]['time'],side=-1,stop_level=1020.,stop=42,end=209)
    assert opening_date(a.time,'afterhours')==opening_date(b.time,'afterhours')==a.day
    assert a.time<boundary(a.day)+86400<b.time
    c=deepcopy(a);c.day=(date.fromisoformat(a.day)+timedelta(days=1)).isoformat()
    c.time+=86400;c.start+=86400
    for bar in c.bars:
        bar['time']+=86400
    result=replay([a,b,c],{e.key:100. for e in (a,b,c)},[a.day,c.day],engine,'lock')
    assert result['count']==2 and result['trades'][0]['day']!=result['trades'][1]['day']


def test_invalid_probability_and_nonfinite_models_fail_closed():
    for p in (-.1,1.1,float('nan')):
        with pytest.raises(ValueError):
            RecoveryEngine(protected_model(p),'protected').outcome(loss_path())
    with pytest.raises(ValueError):
        RecoveryEngine(protected_model()|dict(targetUnit='R'),'protected')
    assert len(policies())==24 and select({})['selected'] is None


def test_entry_labels_use_prior_block_exit_and_auxiliary_cutoffs(monkeypatch):
    import fubon_bridge.recovery_lock as module
    monkeypatch.setattr(module,'tree',lambda x,y,w,n,p:ridge(float(np.average(y,weights=w)),len(n)))
    events=training_actions(150);dates=sorted({a.day for a in events});shapes=action_shapes(events);seen=[]
    class Bank:
        def engine(self,cutoff,family):
            class Engine:
                model={'cutoff':cutoff}
                def outcome(self,a,extra,delay):
                    assert a.time>=cutoff
                    seen.append((a.day,cutoff));return None if delay else dict(net=200-extra*100)
            return Engine()
    class Aux:
        def transform(self,selected,shape,cutoff):
            assert all(a.time>=cutoff for a in selected)
            return {a.key:.25 for a in selected},dict(hash='aux',metadata=dict(cutoff=cutoff,maximumLabelEnd=cutoff-1))
        def get(self,cutoff):
            return 'key',dict(model=ridge(.25,63),hash='aux',metadata=dict(cutoff=cutoff,maximumLabelEnd=cutoff-1))
    model,meta=fit_entry(events,dates,'regular','paired-protected',Bank(),Aux(),shapes)
    assert model is not None and seen and meta['maximumLabelEnd']<meta['calibrationStart']
    assert len(meta['blocks'])==2 and [b['cutoff'] for b in meta['blocks']]==[boundary(dates[40]),boundary(dates[80])]
    assert model['heads']['delayed']['coefficients'][0]==0.
    assert all(abs(v)<1e-8 for v in predict(model,events[:2],shapes).values())
    after=deepcopy(events)
    for a in after:
        if a.day>=meta['calibrationDates'][0]:
            for b in a.bars:
                b.update(open=9000.,high=9002.,low=8998.,close=9000.,volume=9999.)
    changed,_=fit_entry(after,dates,'regular','paired-protected',Bank(),Aux(),action_shapes(after))
    assert digest(model)==digest(changed)


def summary_module(monkeypatch):
    scripts=Path(__file__).resolve().parents[2]/'scripts';monkeypatch.syspath_prepend(str(scripts))
    spec=importlib.util.spec_from_file_location('recovery_summary',scripts/'summarize-recovery-lock.py')
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
    return module


def test_delayed_holding_time_starts_at_actual_entry_open(monkeypatch):
    summary=summary_module(monkeypatch);a=loss_path()
    a.bars[a.index+2].update(open=1000.,high=1002.,low=978.,close=980.)
    for value,expected in ((-100.,8.),(100.,59.)):
        t=RecoveryEngine(mean_model(value),'mean').outcome(a,delay=1)
        assert summary.holding_minutes(t,1)==expected
        assert summary.holding_minutes(t)==expected+1


def test_summary_rejects_changed_bank_model_and_label_cutoff(tmp_path,monkeypatch):
    summary=summary_module(monkeypatch);study=summary.study
    monkeypatch.setattr(study,'ARTIFACTS',tmp_path)
    reference=tmp_path/'parent';reference.mkdir();parent=dict(version='parent');parent['id']=digest(parent)
    (reference/'frozen.json').write_text(json.dumps(parent));monkeypatch.setattr(study,'REFERENCE',reference)
    original=dict(mean=mean_model(100),protected=protected_model())
    path=tmp_path/'exits.json';path.write_text(json.dumps(original))
    record=dict(cutoff=100,metadata=dict(cutoff=100,maximumLabelEnd=99),file='exits.json',hashes={f:digest(m) for f,m in original.items()})
    frozen=dict(implementation=study.hashes(),parentFrozen=parent['id'],auxiliaryModels={},sessions=dict(regular=dict(exitBank={'100':record})))
    def save():
        frozen.pop('id',None);frozen['id']=digest(frozen);(tmp_path/'frozen.json').write_text(json.dumps(frozen))
    save();assert summary.load_frozen(tmp_path)[1]['regular']['100']==original
    path.write_text(json.dumps(dict(original,mean=mean_model(-999))))
    with pytest.raises(ValueError,match='bank'):
        summary.load_frozen(tmp_path)
    path.write_text(json.dumps(original));record['metadata']['maximumLabelEnd']=100;save()
    with pytest.raises(ValueError,match='截止'):
        summary.load_frozen(tmp_path)
