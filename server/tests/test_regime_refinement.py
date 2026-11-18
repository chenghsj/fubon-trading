from copy import deepcopy
from dataclasses import replace
import importlib.util
import json
from pathlib import Path

import pytest

from fubon_bridge.regime_refinement import (BASELINE, CANDIDATES, CONFIG,
    accepted_events, build_candidates, compare, select)
from fubon_bridge.regime_research import build_events
from fubon_bridge.strategy_session import schedule
from test_regime_strategy import training_data


def test_baseline_reproduces_existing_events_and_net_results():
    data = training_data(3)
    old, diagnostics = build_events(data)
    dates = diagnostics['completeDates']
    new = build_candidates(data, dates, (BASELINE,))[BASELINE.name]
    assert [(e['time'],e['side'],e['signal']['trigger']) for e in new] == [
        (e['time'],e['side'],e['signal']['trigger']) for e in old]
    from fubon_bridge.learning_features import simulate
    expected = simulate(old, CONFIG)
    actual = compare(new, BASELINE, dates, 'regular')['normal']
    assert actual['net'] == expected['net'] and actual['count'] == expected['count']


def test_unrequested_dates_and_future_prices_cannot_affect_development_events():
    data = training_data(3)
    day = data['start']
    original = build_candidates(data, [day])
    changed = deepcopy(data)
    start = int(schedule('regular').window(day)[0].timestamp())
    cutoff = start+145*60
    for bar in changed['futures']:
        if bar['time'] > cutoff:
            bar.update(open=1,high=99999,low=1,close=99999)
    revised = build_candidates(changed, [day])
    for name in original:
        a = [(e['time'],e['signal']) for e in original[name] if e['time']<=cutoff]
        b = [(e['time'],e['signal']) for e in revised[name] if e['time']<=cutoff]
        assert a == b
    assert all(e['day']==day for rows in original.values() for e in rows)


def test_late_entry_keeps_original_deadline_and_rechecks_price():
    data = training_data(3)
    rows = build_candidates(data, [data['end']], (BASELINE,))[BASELINE.name]
    event = next(e for e in rows if accepted_events([e], BASELINE, delay=1))
    delayed = accepted_events([event], BASELINE, delay=1)[0]
    assert delayed['path'][0] == event['path'][1]
    assert delayed['path'][-1]['time'] == event['path'][-1]['time']
    assert delayed['time'] == event['time']
    changed = deepcopy(event)
    changed['path'][1]['open'] += 100
    assert not accepted_events([changed], BASELINE, delay=1)


def test_latency_cannot_open_a_position_after_last_entry():
    data = training_data(3)
    event = build_candidates(data, [data['start']], (BASELINE,))[BASELINE.name][0]
    start = int(schedule('regular').window(event['day'])[0].timestamp())
    shift = start+schedule('regular').last_entry*60-event['time']
    event = deepcopy(event)
    event['time'] += shift
    event['signal']['time'] += shift
    for bar in event['path']:
        bar['time'] += shift
    assert accepted_events([event], BASELINE)
    assert not accepted_events([event], BASELINE, delay=1)


def test_range_net_reward_risk_gate_includes_costs_and_preserves_side():
    data = training_data(3)
    events = build_candidates(data, [data['start']], (BASELINE,))[BASELINE.name]
    range_events = [e for e in events if e['signal']['regime']=='range']
    assert accepted_events(range_events, BASELINE)
    assert not accepted_events(range_events, replace(BASELINE,minimum_net_rr=1000))
    assert {e['side'] for e in accepted_events(range_events,BASELINE)} == {'Buy','Sell'}


def test_selection_requires_both_branches_and_every_development_fold():
    def fold(net, count=20, trend=15, range_count=15):
        value = dict(net=net,count=count,maxDrawdown=100,
            byRegime=dict(trend=dict(count=trend,net=net/2),range=dict(count=range_count,net=net/2)))
        return dict(normal=value,stress=deepcopy(value),delayed=deepcopy(value))
    development = {c.name:[fold(100),fold(100),fold(100)] for c in CANDIDATES}
    # A huge aggregate cannot erase one losing contiguous validation block.
    development[CANDIDATES[0].name] = [fold(100000),fold(-1),fold(100000)]
    development[CANDIDATES[1].name] = [fold(200,trend=0)]*3
    result = select(development)
    assert result['eligible'] and result['chosen']['name'] == CANDIDATES[2].name
    assert not result['executionEnabled'] and not result['adoptionAllowed'] and not result['evaluationUsed']
    development = {c.name:[fold(-100)]*3 for c in CANDIDATES}
    assert not select(development)['eligible']


def test_frozen_evaluation_rejects_changed_quality_dates_before_reading_prices(tmp_path, monkeypatch):
    path=Path(__file__).resolve().parents[2]/'scripts/refine-regime.py'
    spec=importlib.util.spec_from_file_location('refinement_runner_test',path)
    runner=importlib.util.module_from_spec(spec)
    spec.loader.exec_module(runner)
    assert 'learning_data.py' in runner.hashes()
    assert 'learning_multiframe.py' in runner.hashes()
    dates=['2026-03-02','2026-03-03','2026-03-04']
    frozen=dict(policy=runner.POLICY,implementation=runner.hashes(),sessions=dict(regular=dict(
        datasetId='a'*64,candidate=dict(name=CANDIDATES[0].name),
        dateSplit=dict(development=dates[:1],validation=dates[1:2],historical_reused_test=dates[2:]))))
    frozen['id']=runner.digest(frozen)
    (tmp_path/'frozen.json').write_text(json.dumps(frozen))
    monkeypatch.setattr(runner,'ARTIFACTS',tmp_path)
    monkeypatch.setattr(runner,'datasets',lambda _:dict(regular=('a'*64,{},dates[:2])))
    monkeypatch.setattr(runner,'build_candidates',lambda *_:pytest.fail('不應開始讀取評估行情'))
    monkeypatch.setattr('sys.argv',['refine-regime.py','--stage','evaluation'])
    with pytest.raises(ValueError,match='日期或分割'):
        runner.main()


def test_learned_refinement_fits_real_native_model_and_replays_predictions():
    lgb=pytest.importorskip('lightgbm')
    from fubon_bridge.regime_refinement_model import fit, model_info, predict
    data=training_data(12)
    dates=sorted({e['time']//86400 for e in data['futures']})
    from fubon_bridge.learning_data import quality
    dates=quality(data)['completeDates']
    candidate=CANDIDATES[1]
    events=build_candidates(data,dates,(candidate,))[candidate.name]
    model,count=fit(events,candidate)
    assert model is not None and count>=60
    info=model_info(model)
    assert info['bytes']>1000
    loaded=lgb.Booster(model_str=model.model_to_string())
    assert predict(loaded,events[:10]) == pytest.approx(predict(model,events[:10]))


def test_changing_last_forty_percent_preserves_development_selection_and_final_model(monkeypatch):
    pytest.importorskip('lightgbm')
    from contextlib import redirect_stdout
    import io
    from fubon_bridge.learning_data import quality
    from fubon_bridge.strategy_session import opening_date

    path=Path(__file__).resolve().parents[2]/'scripts/refine-regime-model.py'
    monkeypatch.syspath_prepend(str(path.parent))
    spec=importlib.util.spec_from_file_location('refinement_model_runner_test',path)
    runner=importlib.util.module_from_spec(spec)
    spec.loader.exec_module(runner)
    data=training_data(60)
    dates=quality(data)['completeDates']
    changed=deepcopy(data)
    held=set(dates[int(len(dates)*.6):])
    for bar in changed['futures']:
        if opening_date(bar['time'],'regular') in held:
            bar.update(open=24000,high=26000,low=23000,close=25500,volume=9999)
    assert quality(changed)['completeDates']==dates

    def develop(source):
        saved={}
        monkeypatch.setattr(runner.base,'datasets',lambda _:dict(regular=(runner.digest(source),source,dates)))
        monkeypatch.setattr(runner,'save',lambda name,value:saved.update({name:deepcopy(value)}))
        monkeypatch.setattr('sys.argv',['refine-regime-model.py','--stage','development'])
        with redirect_stdout(io.StringIO()):
            runner.main()
        return saved

    original=develop(data)
    revised=develop(changed)
    original_development=original['regular-development.json']
    revised_development=revised['regular-development.json']
    assert original_development['datasetId']!=revised_development['datasetId']
    assert original_development['development']==revised_development['development']
    assert original_development['selection']==revised_development['selection']
    assert 'regular-model.txt' in original
    assert original['regular-model.txt']==revised['regular-model.txt']
    assert original['frozen.json']['sessions']['regular']['model']==revised['frozen.json']['sessions']['regular']['model']
