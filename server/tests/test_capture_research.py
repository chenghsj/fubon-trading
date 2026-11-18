"""Independent temporal, source-quality and execution invariants; no SDK calls."""
from copy import deepcopy
from datetime import date, datetime, timedelta
import json
from types import SimpleNamespace as NS
from unittest.mock import Mock

import numpy as np
import pytest

from fubon_bridge.capture_models import comparison, fit, reconciled, select
from fubon_bridge.capture_replay import QuoteTape, SCENARIOS
from fubon_bridge.capture_study import eligible_groups, inspect_capture, run
from fubon_bridge.capture_worker import CaptureResearchWorker
from fubon_bridge.mapping import TAIPEI
from fubon_bridge.market_capture import CaptureStore


def stamp(day,hour=0):
    return int(datetime.fromisoformat(day).replace(tzinfo=TAIPEI,hour=hour).timestamp())


def quote(second,bid=39999,ask=40001,source=None):
    return [second*1e6,(second if source is None else source)*1e6,bid,ask,3,4,20,30]


def action(side=1,end=105,key='a'):
    return NS(time=100,side=side,stop=30,target=30,stop_level=None,target_level=None,
        bars=[dict(time=100,close=40000),dict(time=end,close=40000)],index=0,end=1,
        key=key,day='2026-11-18',plan='trend',source='paired',start=0,session='regular')


def test_quote_availability_and_feature_causality():
    seconds=[(s,40000+s%3,39999,40003,2,1) for s in range(60,100)]
    past=[quote(s) for s in range(60,102)]
    a=QuoteTape(past,seconds,'202612')
    b=QuoteTape(past+[quote(102,40090,40091)],seconds+[(102,40500,40500,40500,1000,1)],'202612')
    assert a.features(100,10)==b.features(100,10)
    assert len(a.features(100,10))==24
    assert a.at(59e6) is None and a.at(104e6) is None
    assert a.at(100.5e6)==40
    late=QuoteTape([quote(102,source=100)],[],'202612')
    assert late.at(101e6) is None and late.at(102e6) is None and late.fill(100e6) is None


@pytest.mark.parametrize('side',[1,-1])
def test_full_cost_reconciles_both_directions_and_stress(side):
    winning=quote(102,40070,40072) if side>0 else quote(102,39928,39930)
    exit_quote=quote(103,40075,40077) if side>0 else quote(103,39923,39925)
    tape=QuoteTape([quote(100.5),winning,exit_quote],[],'202612')
    normal=tape.outcome(action(side),marks=True);stress=tape.outcome(action(side),extra=2,marks=True)
    assert normal['status']==stress['status']=='filled'
    assert normal['entryTime']==101 and normal['exitTime']==103
    for r in (normal,stress):
        assert r['net']==pytest.approx(r['gross']-r['fees']-r['taxes'])
        assert r['net']==pytest.approx(r['midGross']-r['spreadCost']-r['slippageCost']-r['fees']-r['taxes'])
        assert r['internalDrawdown']>=0 and r['minimumNet']<=r['net']<=r['maximumNet']
    assert stress['net']==pytest.approx(normal['net']-40)


def test_unknown_exit_is_censored_and_never_zero_profit():
    tape=QuoteTape([quote(101),quote(102,39960,39962,source=101.5)],[],'202612')
    assert tape.outcome(action())==dict(status='censored',reason='missing_exit_quote')
    assert QuoteTape([],[],'202612').outcome(action())==dict(status='not_sent',reason='missing_entry_quote',net=0.)


def test_delay_cannot_extend_original_exit_deadline():
    tape=QuoteTape([quote(101),quote(161),quote(162)],[],'202612')
    assert tape.outcome(action(),delay=60)['reason']=='expired'
    r=tape.outcome(action(end=162),delay=60)
    assert r['status']=='filled' and r['entryTime']==161 and r['exitTime']==163


def test_already_breached_structure_is_not_an_entry():
    a=action();a.stop_level=40000
    assert QuoteTape([quote(101)],[],'202612').outcome(a)['reason']=='drift_structure_or_budget'


def test_stale_book_cannot_trigger_or_mark_executable_drawdown():
    quotes=[quote(101),quote(104),quote(106,40020,40022)]
    a=QuoteTape(quotes,[],'202612').outcome(action(),marks=True)
    b=QuoteTape([quotes[0],quote(103,39960,39962,source=101),*quotes[1:]],[],'202612').outcome(action(),marks=True)
    assert a==b and a['reason']=='deadline'


def test_fill_rechecks_minimum_structure_range_room_and_trend_two_r():
    a=action();a.bars[0]['close']=1000;a.stop_level=970;a.stop=32;a.target=64
    assert QuoteTape([quote(101,988,990)],[],'202612').outcome(a)['status']=='not_sent'
    a.plan='range';a.target_level=1044
    assert QuoteTape([quote(101,1006,1008)],[],'202612').outcome(a)['status']=='not_sent'
    a.plan='trend';a.target_level=None
    tape=QuoteTape([quote(101,999,1001),quote(102,1067,1069),quote(103,1067,1069),quote(106,1067,1069)],[],'202612')
    # Actual stop distance33 means66 point target1069;1067 is not a target hit.
    result=tape.outcome(a)
    assert result['status']=='filled' and result['reason']=='deadline' and result['exitTime']==106


@pytest.mark.parametrize('bad',[quote(101,40002,40001),quote(101,source=102),quote(101,ask=float('nan'))])
def test_invalid_quote_not_used(bad):
    with pytest.raises(ValueError):QuoteTape([bad],[],'202612')


def test_paired_direction_margin_includes_negative_opposite(monkeypatch,tmp_path):
    tape=NS(outcome=Mock(return_value=dict(status='censored',reason='missing_exit_quote')))
    monkeypatch.setattr('fubon_bridge.capture_models.load_tape',lambda *_:(tape,{}))
    rows=[dict(action=action(side,key=str(side)),day='2026-11-18',time=100,group={}) for side in (1,-1)]
    blocked=comparison(None,rows,{'1':10,'-1':-1},['2026-11-18'],'micro',tmp_path)
    assert all(r['funnel']=={'directionMargin':1} and r['net']==0 for r in blocked.values())
    tape.outcome.assert_not_called()
    unknown=comparison(None,rows,{'1':50,'-1':-1},['2026-11-18'],'micro',tmp_path)
    assert all(not r['complete'] and r['net'] is None and r['maxDrawdown'] is None for r in unknown.values())
    assert select({'paired-micro':[dict(calibration=dict(passed=True),guarded=unknown)]*3})['selected'] is None


def test_fit_purges_labels_and_whole_window_and_ignores_future_changes(tmp_path):
    days=[(date(2026,1,1)+timedelta(days=i)).isoformat() for i in range(40)]
    cutoff=stamp(days[32]);rows=[]
    for i,day in enumerate(days):
        for k in range(6):
            at=stamp(day,10)+k*300
            labels={s:dict(status='filled',net=float((i+k)%9-4)) for s in SCENARIOS}
            rows.append(dict(day=day,time=at,labelEnd=at+120,action=NS(side=1,plan='trend'),
                group=dict(endUs=stamp(day,14)*1_000_000),coarse=[i%5,k],labels=labels))
    # Last fit day's whole-source quality is future to the calibration cutoff.
    for r in rows:
        if r['day']==days[31]:r['group']['endUs']=cutoff*1_000_000+1
    rows[0]['labels']={s:dict(status='not_sent',net=0.) for s in SCENARIOS}
    rows[1]['labels']['stress']=dict(status='censored')
    rows[2]['labelEnd']=cutoff
    models,meta=fit(rows,days,'coarse',tmp_path,'a')
    assert models and meta['days']==31 and meta['actions']==31*6-2
    assert meta['maximumLabelEnd']<cutoff and meta['calibrationDates']==days[32:]
    changed=deepcopy(rows)
    for r in changed:
        if r['day']>=days[32]:
            r['coarse']=[9999,-9999]
            for value in r['labels'].values():value['net']=-999999
    again,second=fit(changed,days,'coarse',tmp_path,'b')
    assert second['actions']==meta['actions']
    assert all(models[s].model_to_string()==again[s].model_to_string() for s in SCENARIOS)


def test_reconciliation_checks_actual_month_and_exact_quantity():
    g=dict(startUs=0,endUs=96*60*1_000_000,month='202612')
    bars=[dict(time=m*60,month='202612',low=40000,high=40002,volume=7) for m in (90,91)]
    meta=dict(minutes={str(b['time']):[40000,40002,7] for b in bars},ambiguousMinutes=[],counts={})
    assert reconciled(g,bars,meta)['passed']
    changed=deepcopy(bars);changed[0]['month']='202611'
    assert not reconciled(g,changed,meta)['passed']
    meta['minutes'][str(bars[0]['time'])][-1]=14
    assert not reconciled(g,bars,meta)['passed'] # Native size must never be divided as public B+S.


def test_eligibility_rejects_ambiguous_contract_days():
    day='2026-11-18';at=stamp(day,9)
    group=dict(session='regular',day=day,month='202612',researchCoveragePassed=True)
    minutes={s:dict(data=None,completeDates=[]) for s in ('regular','afterhours')}
    minutes['regular']=dict(completeDates=[day],data=dict(strategySession='regular',futures=[dict(time=at,month='202612')]))
    assert eligible_groups(dict(groups=[group]),minutes)==[group]
    assert not eligible_groups(dict(groups=[group,group|dict(month='202611')]),minutes)
    minutes['regular']['data']['futures'][0]['month']='202611'
    assert not eligible_groups(dict(groups=[group]),minutes)


def seed_window(path):
    store=CaptureStore(path);start=stamp('2026-11-18',15)*1_000_000;end=start+14*3600*1_000_000
    with store.connect() as db:
        db.execute('INSERT INTO capture_runs VALUES(?,?,?)',('run',start,end+1))
        for at,channel in [(start+89*60*1_000_000,'books'),(end-297*1_000_000,'books'),(start+90*60*1_000_000,'trades')]:
            db.execute('''INSERT INTO capture_frames(run_id,epoch,received_us,monotonic_ns,event_us,symbol,month,session,opening_day,
                window_start_us,window_end_us,channel,event_type,is_trial,serial,valid,duplicate,issues,sha256,raw_json)
                VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)''',
                ('run',0,at,1,at,'TMFL6','202612','afterhours','2026-11-18',start,end,channel,'data',0,'1',1,0,'[]','x','{}'))
    return store,start,end


def test_inspection_needs_completed_window_and_blocks_loss(tmp_path):
    store,start,end=seed_window(tmp_path/'capture.sqlite3')
    assert not inspect_capture(store.path,end+30_000_000)['groups'][0]['researchCoveragePassed']
    assert inspect_capture(store.path,end+61_000_000)['groups'][0]['researchCoveragePassed']
    with store.connect() as db:db.execute('INSERT INTO capture_audit(run_id,at_us,kind,detail) VALUES(?,?,?,?)',
        ('run',start+90*60*1_000_000,'capture_loss','{}'))
    group=inspect_capture(store.path,end+61_000_000)['groups'][0]
    assert not group['researchCoveragePassed'] and group['day']=='2026-11-18'


def test_inspection_reconstructs_crash_gap_before_restart(tmp_path):
    store,start,end=seed_window(tmp_path/'capture.sqlite3')
    with store.connect() as db:
        db.execute('UPDATE capture_runs SET ended_us=NULL')
        db.execute('DELETE FROM capture_frames WHERE received_us>?',(start+90*60*1_000_000,))
        db.execute('INSERT INTO capture_runs VALUES(?,?,?)',('next',end+1,end+2))
    assert any('未知缺口' in r for r in inspect_capture(store.path,end+61_000_000)['groups'][0]['reasons'])


@pytest.mark.parametrize('kind',['capture_loss','capture_hook_error'])
def test_delayed_loss_audit_cannot_hide_a_gap_past_research_boundary(tmp_path,kind):
    store,start,end=seed_window(tmp_path/'capture.sqlite3')
    assert inspect_capture(store.path,end+61_000_000)['groups'][0]['researchCoveragePassed']
    # The real loss may have happened in the last research second; its batched
    # marker appears only after the entire official window. Do not infer onset.
    with store.connect() as db:db.execute('INSERT INTO capture_audit(run_id,at_us,kind,detail) VALUES(?,?,?,?)',
        ('run',end+61_000_000,kind,'{}'))
    group=inspect_capture(store.path,end+120_000_000)['groups'][0]
    assert not group['researchCoveragePassed']
    assert group['knownGaps'][0]['possibleStartUs']==start


def test_insufficient_study_preserves_immutable_run_and_never_enables_execution(tmp_path):
    store,_,_=seed_window(tmp_path/'capture.sqlite3');out=tmp_path/'study'
    result=run(store.path,out)
    assert result['state']=='insufficient' and not result['executionAllowed'] and not result['adoptionAllowed']
    files=list((out/'runs').glob('*/frozen.json'));old=files[0].read_bytes()
    run(store.path,out)
    assert files[0].read_bytes()==old and len(list((out/'runs').glob('*')))==2


def test_minute_worker_only_fetches_after_publication_and_preserves_daily_cache(tmp_path,monkeypatch):
    clock=[datetime(2026,11,18,17,59,tzinfo=TAIPEI)]
    monkeypatch.setattr('fubon_bridge.capture_worker.now',lambda:clock[0])
    broker=NS(learning_candles=Mock(return_value=[]),connect=Mock())
    worker=CaptureResearchWorker(NS(broker=broker),tmp_path)
    worker._minutes();broker.learning_candles.assert_not_called()
    clock[0]=clock[0].replace(hour=18);worker._minutes();worker._minutes()
    assert broker.learning_candles.call_count==2
    assert {c.kwargs['session'] for c in broker.learning_candles.call_args_list}=={'regular','afterhours'}
    CaptureResearchWorker(NS(broker=broker),tmp_path)._minutes()
    assert broker.learning_candles.call_count==2
    broker.connect.assert_not_called()
