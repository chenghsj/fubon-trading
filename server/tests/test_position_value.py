from copy import deepcopy
from dataclasses import replace
from datetime import date, timedelta
import importlib.util
import json
from pathlib import Path

import numpy as np
import pytest

from fubon_bridge.candle_patterns import action_shapes, boundary
from fubon_bridge.direction_execution import outcome as fixed_outcome
from fubon_bridge.pattern_transfer import partition
from fubon_bridge.position_value import (FEATURES, ExitEngine, cash, fit_entry, fit_exit, policies,
    predict, replay, select, states)
from fubon_bridge.research import digest
from test_direction_continuation import revised, ridge


def model(value):
    return dict(kind='position_value',version=1,features=FEATURES,targetUnit='NTD',head=ridge(value,len(FEATURES)))


def loss_path(side=1):
    a=revised(side,exit_mode='fixed')
    for i in range(90,160):
        center=1000-side*20
        a.bars[i].update(open=center,high=center+2,low=center-2,close=center)
    # Entry quote is still near signal; drift admission cannot be bypassed.
    a.bars[90]['open']=1000.
    return a


@pytest.mark.parametrize('side',[1,-1])
def test_negative_continuation_exits_next_open_with_gap_and_both_sides(side):
    a=loss_path(side);rows=states(a);assert rows and len(rows[0]['x'])==76
    i=rows[0]['index'];quote=1000-side*60
    a.bars[i+1].update(open=quote,high=quote+2,low=quote-2,close=quote)
    t=ExitEngine(model(-100)).outcome(a)
    assert t['decisionTime']==a.bars[i]['time']==t['exitTime']
    assert t['exit']==quote-side*2 and t['reason']=='negative_continuation'
    assert t['net']==cash(t['entry'],quote,side,2)
    assert len(t['marks'])==0
    marked=ExitEngine(model(-100)).outcome(a,marks=True)
    # Baseline's next-open gap mark has the same timestamp as current close,
    # but may not leak into the pre-decision mark sequence.
    assert len(marked['marks'])==i-90+2
    assert marked['marks'][-2][1]!=marked['marks'][-1][1]


def test_positive_continuation_can_hold_temporary_loss_until_recovery():
    a=loss_path();a.bars[110].update(open=1085.,high=1090.,low=1080.,close=1086.)
    held=ExitEngine(model(100)).outcome(a)
    cut=ExitEngine(model(-100)).outcome(a)
    assert held==fixed_outcome(a) and held['net']>0 and cut['net']<0


def test_profitable_or_shallow_loss_has_no_new_exit_even_with_negative_forecast():
    for value in (1010.,997.):
        a=revised(exit_mode='fixed')
        for b in a.bars[91:]:
            b.update(open=value,high=value+2,low=value-2,close=value)
        assert not states(a)
        assert ExitEngine(model(-1000)).outcome(a)==fixed_outcome(a)


def test_hard_stop_precedes_close_decision_and_deadline_stays_fixed():
    a=loss_path();a.bars[95]['low']=950.
    assert not states(a)
    assert ExitEngine(model(-100)).outcome(a)==fixed_outcome(a)
    b=revised(exit_mode='fixed')
    assert ExitEngine(model(100)).outcome(b,delay=1)['exitTime']==b.label_end


def test_current_features_and_first_decision_unchanged_by_later_prices():
    a=loss_path();row=states(a)[0];b=deepcopy(a)
    for bar in b.bars[row['index']+2:]:
        bar.update(open=3000.,high=3002.,low=2998.,close=3000.,volume=9999.)
    assert states(b)[0]==row
    left=ExitEngine(model(-100)).outcome(a);right=ExitEngine(model(-100)).outcome(b)
    assert left==right


def test_cache_cannot_share_different_structural_stops_at_same_signal():
    a=loss_path();b=replace(a,source='confirmed',stop_level=950.,stop=52)
    engine=ExitEngine(model(-100));engine.outcome(a);engine.outcome(b)
    assert len(engine.results)==2
    assert len(engine.cache)>0


def test_missing_model_is_blocked_and_not_a_silent_fixed_fallback():
    a=loss_path();engine=ExitEngine(None)
    assert engine.outcome(a) is None
    result=replay([a],{a.key:100.},[a.day],engine,learned=True)
    assert result['count']==0 and result['funnel']['calibrationBlocked']==1
    assert not any(r['eligible'] for r in select({})['rankings'])
    assert len(policies())==36


def test_direction_gate_is_after_best_side_selection_without_fallback():
    buy=loss_path();sell=replace(buy,side=-1,stop_level=1040.,source='paired')
    engine=ExitEngine(model(100))
    result=replay([buy,sell],{buy.key:100.,sell.key:200.},[buy.day],engine,
        directions={buy.key:1.,sell.key:-1.})
    assert result['count']==0 and result['funnel']['directionRejected']==1
    result=replay([buy],{buy.key:-1.},[buy.day],engine,directions={buy.key:100.})
    assert result['count']==0


def training_actions(number=30):
    output=[]
    for j in range(number):
        day=(date(2024,8,1)+timedelta(days=j)).isoformat()
        for k in range(4):
            a=loss_path();shift=boundary(day)-boundary(a.day)+k*300
            for b in a.bars:
                b['time']+=shift
            a.day=day;a.time+=shift;a.start+=shift-k*300;a.x[2]=3.;a.x[5]=.8;output.append(a)
    return output


def test_training_cutoff_strictly_excludes_equal_and_future_labels(monkeypatch):
    import fubon_bridge.position_value as module
    monkeypatch.setattr(module,'tree',lambda x,y,w,n,p:ridge(float(np.average(y,weights=w)),len(n))|
        dict(xMean=np.average(x,axis=0,weights=w).tolist(),weightSum=float(sum(w))))
    events=training_actions();dates=sorted({a.day for a in events});cutoff=events[-1].label_end
    original,meta=fit_exit(events,dates,cutoff)
    assert original is not None and meta['maximumLabelEnd']<cutoff and meta['states']>=500
    after=deepcopy(events)
    for a in after:
        if a.label_end>=cutoff:
            for b in a.bars:
                b.update(open=99999.,high=100000.,low=99998.,close=99999.)
    changed,details=fit_exit(after,dates,cutoff)
    assert digest(original)==digest(changed) and meta==details
    assert fit_exit(events[:4],dates[:1],cutoff)[0] is None


def test_nonfinite_or_wrong_unit_model_is_rejected():
    with pytest.raises(ValueError):
        ExitEngine(model(-1)|dict(targetUnit='R'))
    bad=model(float('nan'))
    with pytest.raises(ValueError,match='預測無效'):
        ExitEngine(bad).outcome(loss_path())


def test_entry_targets_are_exit_specific_ntd_and_keep_nofill_zero(monkeypatch):
    import fubon_bridge.position_value as module
    monkeypatch.setattr(module,'tree',lambda x,y,w,n,p:ridge(float(np.average(y,weights=w)),len(n)))
    class Engine:
        model=model(100)
        def outcome(self,a,extra,delay,learned):
            return None if delay else dict(net=200.-extra*100 if learned else -200.-extra*100)
    events=training_actions(80);dates=sorted({a.day for a in events});_,fit_dates,cal=partition(dates)
    shapes=action_shapes(events);cutoff=boundary(fit_dates[0]);aux=ridge(.25,63)
    auxiliary_meta=dict(cutoff=cutoff,maximumLabelEnd=cutoff-1)
    fitted,metadata=fit_entry(events,dates,'regular',aux,auxiliary_meta,shapes,Engine(),True)
    assert fitted is not None and metadata['maximumLabelEnd']<metadata['calibrationStart']
    def value(head):
        return fitted['heads'][head]['coefficients'][0]
    assert value('normal')==pytest.approx(200.) and value('stress')==pytest.approx(0.) and value('delayed')==0.
    scores,directions=predict(fitted,events[:2],shapes)
    assert all(abs(v)<1e-8 for v in scores.values()) and all(v<0 for v in directions.values())
    changed=deepcopy(events)
    for a in changed:
        if a.day in cal:
            for b in a.bars:
                b.update(open=3000.,close=3000.,high=3002.,low=2998.,volume=9999.)
    after,_=fit_entry(changed,dates,'regular',aux,auxiliary_meta,action_shapes(changed),Engine(),True)
    assert digest(fitted)==digest(after)
    assert fit_entry(events,dates,'regular',aux,auxiliary_meta,shapes,ExitEngine(None),True)[0] is None
    with pytest.raises(ValueError,match='隔離截止'):
        fit_entry(events,dates,'regular',aux,dict(cutoff=cutoff,maximumLabelEnd=cutoff),shapes,Engine(),True)


def test_summary_rejects_changed_exit_model_before_counterfactual(tmp_path,monkeypatch):
    scripts=Path(__file__).resolve().parents[2]/'scripts'
    monkeypatch.syspath_prepend(str(scripts))
    spec=importlib.util.spec_from_file_location('position_summary',scripts/'summarize-position-value.py')
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
    monkeypatch.setattr(module,'SOURCE',tmp_path)
    original=model(100);frozen=dict(sessions=dict(regular=dict(exitHash=digest(original))))
    path=tmp_path/'regular-exit-model.json';path.write_text(json.dumps(original))
    assert module.load_exit(frozen,'regular')==original
    path.write_text(json.dumps(model(-999)))
    with pytest.raises(ValueError,match='凍結不符'):
        module.load_exit(frozen,'regular')
