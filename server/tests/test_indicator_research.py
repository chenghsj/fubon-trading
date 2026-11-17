from copy import deepcopy
import importlib.util
import io
from contextlib import redirect_stdout
from pathlib import Path

import pytest

from fubon_bridge.indicator_research import (Adx, FEATURE_SETS, Kd, Macd,
    POLICY, Rsi, augment, fit)
from fubon_bridge.learning_data import quality
from fubon_bridge.regime_refinement import BASELINE, build_candidates
from fubon_bridge.strategy_session import opening_date
from test_regime_strategy import training_data


def test_macd_matches_independent_quadratic_ema_closed_form():
    indicator=Macd()
    def ema(period,n):
        start=27-period
        seed=sum(i*i for i in range(start,27))/period
        particular=lambda t:t*t-(period-1)*t+period*(period-1)/2
        return particular(n)+(seed-particular(26))*((period-1)/(period+1))**(n-26)
    line=lambda n:ema(12,n)-ema(26,n)
    seed=sum(line(i) for i in range(26,35))/9
    signal=lambda n:.8**(n-34)*seed+.2*sum(.8**(n-i)*line(i) for i in range(35,n+1))
    for n in range(1,61):
        actual=indicator.push(float(n*n))
        if n<34:
            assert actual is None
        elif n==34:
            assert actual[:3]==pytest.approx((line(n),signal(n),line(n)-signal(n)))
            assert actual[-1] is None
        else:
            expected=(line(n),signal(n),line(n)-signal(n),line(n)-signal(n)-line(n-1)+signal(n-1))
            assert actual==pytest.approx(expected,abs=1e-9)


def test_rsi_and_adx_warmup_neutral_and_directional_values():
    rsi=Rsi()
    for n in range(1,17):
        value=rsi.push(100+n)
        if n<15:
            assert value is None
        elif n==15:
            assert value==(100,None)
        else:
            assert value==(100,0)
    flat=Rsi()
    for _ in range(16):
        value=flat.push(100)
    assert value==(50,0)
    adx=Adx()
    for n in range(1,30):
        value=adx.push(dict(high=100+n+2,low=100+n,close=100+n+1))
        if n<28:
            assert value is None
        elif n==28:
            assert value[0]==100 and value[-1] is None
        else:
            assert value[0]==100 and value[1]>0 and value[-1]==0


def test_kd_uses_frozen_rsv_recursive_smoothing_and_neutral_flat_seed():
    kd=Kd()
    for n in range(1,9):
        assert kd.push(dict(high=110,low=90,close=100)) is None
    first=kd.push(dict(high=110,low=90,close=110))
    k=(2*50+100)/3
    d=(2*50+k)/3
    assert first[:2]==pytest.approx((k,k-d)) and first[-1] is None
    second=kd.push(dict(high=110,low=90,close=90))
    k2=(2*k+0)/3;d2=(2*d+k2)/3
    assert second==pytest.approx((k2,k2-d2,k2-k))
    flat=Kd()
    for _ in range(10):
        value=flat.push(dict(high=100,low=100,close=100))
    assert value==(50,0,0)


def test_all_nine_families_share_identical_events_and_base_features():
    data=training_data(3);dates=quality(data)['completeDates']
    raw=build_candidates(data,dates,(BASELINE,))[BASELINE.name]
    families=augment(data,raw,dates)
    assert len(families)==9
    assert families['base28']==raw
    for name,events in families.items():
        assert [e['time'] for e in events]==[e['time'] for e in raw]
        assert all(len(e['x'])==len(FEATURE_SETS[name]) for e in events)
        assert all(e['x'][:28]==source['x'] for e,source in zip(events,raw))
    assert not POLICY['executionEnabled'] and not POLICY['adoptionAllowed']


def test_future_prices_cannot_change_any_indicator_before_cutoff():
    data=training_data(3);dates=quality(data)['completeDates']
    cutoff=data['futures'][144]['time']
    def features(source):
        raw=build_candidates(source,dates,(BASELINE,))[BASELINE.name]
        return {name:[(e['time'],e['x']) for e in events if e['time']<=cutoff]
            for name,events in augment(source,raw,dates).items()}
    changed=deepcopy(data)
    for bar in changed['futures']:
        if bar['time']>cutoff:
            bar.update(open=24000,high=26000,low=23000,close=25500,volume=9999)
    assert features(data)==features(changed)


def test_baseline_model_is_identical_and_indicator_model_reloads():
    lgb=pytest.importorskip('lightgbm')
    from fubon_bridge.regime_refinement_model import fit as original_fit, predict
    data=training_data(12);dates=quality(data)['completeDates']
    raw=build_candidates(data,dates,(BASELINE,))[BASELINE.name]
    families=augment(data,raw,dates)
    original,count=original_fit(raw,BASELINE)
    baseline,new_count=fit(families['base28'],'base28')
    assert count==new_count and original.model_to_string()==baseline.model_to_string()
    combined,_=fit(families['all54'],'all54')
    assert combined.num_feature()==54
    restored=lgb.Booster(model_str=combined.model_to_string())
    assert predict(restored,families['all54'][:10])==pytest.approx(predict(combined,families['all54'][:10]))


def test_night_vwap_does_not_reset_at_midnight():
    from datetime import datetime
    from fubon_bridge.mapping import TAIPEI
    from test_regime_strategy import candles
    data=training_data(1)
    data.update(strategySession='afterhours',start='2026-11-13',end='2026-11-13',
        futures=candles(session='afterhours',kind='range'))
    dates=quality(data)['completeDates']
    raw=build_candidates(data,dates,(BASELINE,))[BASELINE.name]
    events=augment(data,raw,dates)['vwap30']
    after=next(e for e in events if datetime.fromtimestamp(e['time'],TAIPEI).hour<5)
    bars=[b for b in data['futures'] if b['time']<=after['time']]
    expected=sum((b['high']+b['low']+b['close'])/3*b['volume'] for b in bars)/sum(b['volume'] for b in bars)
    side=1 if after['side']=='Buy' else -1
    assert after['x'][-2]==pytest.approx(side*(after['signal']['close']-expected)/after['signal']['atr'])
    assert after['day']=='2026-11-13'


def test_held_out_data_cannot_change_any_development_result_or_native_model(monkeypatch):
    pytest.importorskip('lightgbm')
    path=Path(__file__).resolve().parents[2]/'scripts/research-indicators.py'
    monkeypatch.syspath_prepend(str(path.parent))
    spec=importlib.util.spec_from_file_location('indicator_runner_test',path)
    runner=importlib.util.module_from_spec(spec)
    spec.loader.exec_module(runner)
    data=training_data(60);dates=quality(data)['completeDates']
    changed=deepcopy(data);held=set(dates[int(len(dates)*.6):])
    for bar in changed['futures']:
        if opening_date(bar['time'],'regular') in held:
            bar.update(open=24000,high=26000,low=23000,close=25500,volume=9999)
    assert quality(changed)['completeDates']==dates
    def develop(source):
        saved={}
        monkeypatch.setattr(runner.base,'datasets',lambda _:dict(regular=(runner.digest(source),source,dates)))
        monkeypatch.setattr(runner,'save',lambda name,value:saved.update({name:deepcopy(value)}))
        monkeypatch.setattr('sys.argv',['research-indicators.py','--stage','development'])
        with redirect_stdout(io.StringIO()):
            runner.main()
        return saved
    original,revised=develop(data),develop(changed)
    assert original['regular-development.json']['families']==revised['regular-development.json']['families']
    for name in FEATURE_SETS:
        assert original[f'regular-{name}-model.txt']==revised[f'regular-{name}-model.txt']
