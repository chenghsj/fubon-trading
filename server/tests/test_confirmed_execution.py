from array import array
from copy import deepcopy
from dataclasses import replace
import importlib.util
import json
import math
from pathlib import Path

import pytest

from fubon_bridge.candle_patterns import boundary
from fubon_bridge.confirmed_execution import ConfirmedAction, VARIANTS, breakeven, build, outcome, prepare
from fubon_bridge.confirmed_models import block_interval, fit, policies, select, targets
from fubon_bridge.intraday_strategy import futures_tax
from fubon_bridge.learning_data import quality
from fubon_bridge.research import digest
from fubon_bridge.structured_research import build as old_build, outcome as old_outcome
from fubon_bridge.strategy_session import schedule
from test_regime_strategy import training_data


def action(side=1,variant='structure-managed'):
    day='2026-01-05';start=int(schedule('regular').window(day)[0].timestamp())
    bars=[dict(time=start+(i+1)*60,open=1000.,high=1002.,low=998.,close=1000.,volume=10.,month='202601')
        for i in range(160)]
    return ConfirmedAction(day,bars[89]['time'],side,'trend',array('f',[0.]*54),42,84,89,149,
        start,'regular',bars,None,480.,variant,1000-side*40,20.,(0.,)*7)


@pytest.mark.parametrize('delay,offset',[(0,12),(1,13)])
def test_no_progress_uses_next_open_at_known_time_not_deciding_close(delay,offset):
    a=action();next_index=a.index+1+offset
    a.bars[next_index].update(open=1010.,high=1012.,low=1008.,close=1010.)
    trade=outcome(a,delay=delay)
    assert trade['reason']=='no_progress'
    assert trade['exitTime']==a.time+offset*60
    assert trade['exit']==1008.  # Deciding close was1000, not this quote.


def test_new_trailing_stop_cannot_apply_to_low_of_the_deciding_candle():
    a=action();a.bars[90].update(open=1000.,high=1046.,low=990.,close=1044.)
    a.bars[91].update(open=1050.,high=1052.,low=1000.,close=1040.)
    trade=outcome(a)
    assert trade['exitTime']==a.bars[91]['time']
    assert trade['reason']=='stop' and trade['net']==0.


@pytest.mark.parametrize('side',[1,-1])
@pytest.mark.parametrize('slip',[2,4])
def test_break_even_covers_real_tax_and_fees_in_both_directions(side,slip):
    entry=45000.;stop=breakeven(entry,side,slip);exit_price=stop-side*slip
    net=(exit_price-entry)*side*10-40-futures_tax(entry,10,.00002)-futures_tax(exit_price,10,.00002)
    assert net>=0 and float(stop).is_integer()


def test_structural_stop_stays_absolute_and_quote_risk_is_rechecked():
    a=action();_,fill,_=prepare(a)
    a.bars[90].update(open=1005.,high=1007.,low=1003.,close=1005.)
    _,changed,_=prepare(a)
    assert fill['stop']==changed['stop']==960.
    assert changed['risk']>fill['risk']
    assert prepare(a,realized=-900)[2]=='risk'
    a.bars[90]['open']=995.
    a=replace(a,stop_level=980.)
    assert prepare(a)[2]=='structure_distance'


def test_managed_exits_keep_original_signal_deadline_under_delay():
    a=action(variant='structure-fixed')
    assert outcome(a)['exitTime']==outcome(a,delay=1)['exitTime']==a.label_end
    both=action(variant='structure-fixed');both.bars[90].update(high=1100.,low=900.)
    assert outcome(both)['reason']=='both_stop_first'


def test_scheduled_market_exit_precedes_unknown_intrabar_path():
    a=action();a.bars[102].update(open=1000.,high=1200.,low=800.,close=1000.)
    trade=outcome(a)
    assert trade['reason']=='no_progress' and trade['exit']==998.


def oscillating_data():
    data=training_data(1);previous=25000
    for minute,b in enumerate(data['futures'],1):
        price=round(25000+.5*minute+12*math.sin(2*math.pi*minute/10))
        b.update(open=previous,close=price,high=max(previous,price)+1,low=min(previous,price)-1)
        previous=price
    return data


def test_legacy_is_identical_and_new_signals_are_closed_three_minute_causal():
    data=oscillating_data();dates=quality(data)['completeDates'];events,_=build(data,dates)
    original,_=old_build(data,dates)
    assert [(a.key,list(a.x),a.stop,a.target,a.target_level) for a in events['legacy']]==[
        (a.key,list(a.x),a.stop,a.target,a.target_level) for a in original]
    assert all(outcome(a)==old_outcome(a) for a in events['legacy'])
    assert events['confirm-fixed']
    cutoff=events['confirm-fixed'][0].time;changed=deepcopy(data)
    for b in changed['futures']:
        if b['time']>cutoff:
            b.update(open=29000,close=30000,high=31000,low=28000,volume=9999)
    revised,_=build(changed,dates)
    for variant in VARIANTS:
        project=lambda rows:[(a.key,list(a.x),a.stop,a.target,a.stop_level,a.context) for a in rows if a.time<=cutoff]
        assert project(events[variant])==project(revised[variant])
        if variant!='legacy':
            assert all((a.time-a.start)//60>=90 and (a.time-a.start)//60%3==0 for a in events[variant])


def test_cash_targets_use_each_new_exit_and_keep_unfilled_zero(monkeypatch):
    import fubon_bridge.confirmed_models as module
    monkeypatch.setattr(module,'outcome',lambda a,extra,delay: None if extra else dict(net=20. if delay else 100.))
    assert targets(action())==dict(normal=100.,stress=0.,delayed=20.)


def test_model_fit_rejects_pretrain_label_at_global_meta_boundary():
    dates=[f'2026-01-{i:02}' for i in range(1,31)]
    cut=boundary(dates[12])
    with pytest.raises(ValueError,match='截止'):
        fit([],dates,'regular',None,dict(cutoff=cut,maximumLabelEnd=cut),{})


def test_empty_and_nonfinite_development_cannot_be_selected():
    assert len(policies())==45 and select({})['selected'] is None
    metrics={s:dict(count=100,net=1000.,withoutBestDay=900.,
        byPlan=dict(range=dict(count=50,net=500.),trend=dict(count=50,net=500.))) for s in ('normal','stress','delayed')}
    trials={p:dict(folds=[dict(calibration=dict(passed=True),guarded=deepcopy(metrics)) for _ in range(3)]) for p in policies()}
    assert select(trials)['selected']
    for v in trials.values():
        v['folds'][0]['guarded']['normal']['net']=float('nan')
    assert select(trials)['selected'] is None


def test_daily_block_interval_includes_inactive_days_and_is_reproducible():
    days={str(i):100. if i==0 else 0. for i in range(20)}
    first=block_interval(days)
    assert first==block_interval(days) and first['mean']==5. and first['median']==0.
    assert block_interval({})['mean'] is None


def test_evaluation_rejects_changed_freeze_before_new_replay(tmp_path,monkeypatch):
    path=Path(__file__).resolve().parents[2]/'scripts/research-entry-exit.py'
    import sys
    monkeypatch.syspath_prepend(str(path.parent))
    spec=importlib.util.spec_from_file_location('entry_exit_runner_test',path)
    runner=importlib.util.module_from_spec(spec);spec.loader.exec_module(runner)
    reference=tmp_path/'reference';reference.mkdir();frozen=dict(implementation={})
    frozen['id']=digest(frozen);(reference/'frozen.json').write_text(json.dumps(frozen))
    output=tmp_path/'output';output.mkdir();(output/'frozen.json').write_text(json.dumps(dict(id='tampered')))
    monkeypatch.setattr(runner,'REFERENCE',reference)
    monkeypatch.setattr(runner.base,'datasets',lambda _: {})
    monkeypatch.setattr(runner.parent,'stock_data',lambda _: {})
    monkeypatch.setattr(runner,'hashes',lambda: {})
    monkeypatch.setattr(sys,'argv',['research-entry-exit.py','--stage','evaluation','--output',str(output)])
    with pytest.raises(ValueError,match='凍結'):
        runner.main()
