from array import array
from copy import deepcopy
from datetime import date,timedelta
from types import SimpleNamespace

import pytest

from fubon_bridge.structured_models import calibration_check,final_check,fit,policies,predict,select
from fubon_bridge.structured_research import FEATURES
from fubon_bridge.strategy_session import schedule


def repeated_opportunities():
    dates=[(date(2026,1,1)+timedelta(days=i)).isoformat() for i in range(40)]
    rows=[]
    for day in dates:
        start=int(schedule('regular').window(day)[0].timestamp())
        for index in range(8):
            at=start+(90+10*index)*60
            rows.append(SimpleNamespace(day=day,time=at,start=start,index=index,
                side=1,plan='trend',planned_risk=1000.,label_end=at+3600,
                key=(at,1,'trend'),x=array('f',[0.]*len(FEATURES))))
    return rows,dates


def test_robust_model_estimates_worst_conditional_mean_not_mean_realized_minimum(monkeypatch):
    import fubon_bridge.structured_models as module
    rows,dates=repeated_opportunities()
    def result(action,extra=0,delay=0):
        normal=600. if action.index%2==0 else -300.
        return dict(net=(-300. if action.index%2==0 else 600.) if delay else normal-10*extra)
    monkeypatch.setattr(module,'outcome',result)
    model,_=fit(rows,dates,'regular','ridge-robust')
    score=predict(model,rows[:1])[rows[0].key]
    # Each execution scenario has positive conditional mean: 150 / 130 / 150.
    # A clairvoyant per-trade minimum wrongly targets -310 instead.
    assert score==pytest.approx(130.,abs=1e-6)


def test_unfilled_attempts_stay_in_normal_model_with_zero_cashflow(monkeypatch):
    import fubon_bridge.structured_models as module
    rows,dates=repeated_opportunities()
    monkeypatch.setattr(module,'outcome',lambda a,**kw:None if a.index%2==0 else dict(net=100.))
    model,meta=fit(rows,dates,'regular','ridge-normal')
    assert meta['fitActions']==meta['thinnedCandidates']==256
    assert predict(model,rows[:1])[rows[0].key]==pytest.approx(50.,abs=1e-6)


def complete_metrics():
    return {s:dict(count=100,net=1000.,withoutBestDay=900.,
        byPlan=dict(range=dict(count=100,net=1000.),trend=dict(count=0,net=0.)))
        for s in ('normal','stress','delayed')}


def test_empty_or_partial_evaluation_cannot_pass_model_screening():
    assert not calibration_check({},'range')['passed']
    assert not calibration_check(dict(normal=complete_metrics()['normal']),'range')['passed']
    assert not final_check({},'range')['passed']
    assert not final_check(dict(validation=complete_metrics()),'range')['passed']


@pytest.mark.parametrize('value',[float('nan'),float('inf'),-float('inf')])
def test_nonfinite_profit_cannot_pass_calibration_or_final_screening(value):
    calibration=complete_metrics();calibration['stress']['net']=value
    assert not calibration_check(calibration,'range')['passed']
    periods=dict(validation=complete_metrics(),historical_reused_test=complete_metrics())
    periods['historical_reused_test']['normal']['byPlan']['range']['net']=value
    assert not final_check(periods,'range')['passed']


def test_development_screen_rejects_partial_and_nonfinite_fold_metrics():
    trials={p:dict(folds=[dict(calibration=dict(passed=True),guarded=complete_metrics()) for _ in range(3)])
        for p in policies()}
    # Only range policies can qualify because the trend branch has no trades.
    assert select(trials)['selected'] is not None
    for trial in trials.values():
        trial['folds'][0]['guarded']['stress']['net']=float('nan')
    assert select(trials)['selected'] is None
    assert select({})['selected'] is None
    for trial in trials.values():
        trial['folds'][0]['guarded']={}
    assert select(trials)['selected'] is None
