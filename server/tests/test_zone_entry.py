from copy import deepcopy
from datetime import date,timedelta
import math
from types import SimpleNamespace as NS

import numpy as np
import pytest

from fubon_bridge.candle_patterns import boundary
from fubon_bridge.zone_entry import episodes,intentions,orient_zone,zone_context,build
from fubon_bridge.zone_models import FEATURES,POLICIES,SCENARIOS,fit,select


def bar(opening,high,low,close,volume=100):
    return dict(open=opening,high=high,low=low,close=close,volume=volume)


def stream_range():
    prior=[bar(1060,1200,1000 if i%2==0 else 1015,1080) for i in range(20)]
    current=bar(1020,1040,995,1030,200)
    minutes=[bar(1025,1032,1020,1030,50) for _ in range(21)]
    return NS(threes=prior+[current],minutes=minutes,fifteens=[bar(1080,1200,1000,1080,500) for _ in range(4)])


def stream_trend():
    prior=[bar(1080,1100,1000,1095) for _ in range(20)]
    current=bar(1090,1110,1080,1105,200)
    return NS(threes=prior+[current],minutes=[bar(1101,1106,1100,1105,50) for _ in range(21)],
        fifteens=[bar(p,p+10,p-10,p,500) for p in (1000,1020,1040,1100)])


def test_zone_boundaries_and_volume_denominators_exclude_confirmation():
    a=stream_range();z=zone_context(a,40)
    assert z['lower']==1000 and z['upper']==1200 and z['relativeVolume3']==2
    assert z['lowerTouches']==10 and z['upperTouches']==1
    a.threes[-1]['low']=500;a.threes[-1]['high']=2000;a.threes[-1]['volume']=400
    other=zone_context(a,40)
    assert (other['lower'],other['upper'])==(z['lower'],z['upper'])
    assert other['relativeVolume3']==4


def test_range_rejection_and_outsize_volume_are_distinct_hypotheses():
    s=stream_range();z=zone_context(s,40);signals=intentions(s,z,40,{},30)
    assert len(signals)==1 and signals[0]['side']==1 and signals[0]['plan']=='range' and signals[0]['volumePassed']
    s.threes[-1]['volume']=100;z=zone_context(s,40)
    signals=intentions(s,z,40,{},30)
    assert signals and not signals[0]['volumePassed']
    s.threes[-1]=bar(1028,1040,1025,1030)
    assert not intentions(s,zone_context(s,40),40,{},30)


def test_adjacent_touches_do_not_manufacture_confirmations():
    assert episodes([True,True,False,True,True,False,True])==3


def test_trend_requires_a_later_candle_and_freezes_breakout_context():
    s=stream_trend();pending={}
    assert not intentions(s,zone_context(s,40),40,pending,30)
    assert pending[1]==dict(level=1100,number=30,atr=40,relativeVolume=2,volume=200)
    s.threes.append(bar(1105,1110,1098,1108,100));s.minutes[-1]=bar(1106,1109,1100,1108,50)
    signals=intentions(s,zone_context(s,40),40,pending,31)
    assert any(a['plan']=='trend' and a['side']==1 and a['volumePassed'] for a in signals)
    assert pending[1]['number']==30 # Unchanged level must not renew expiry.


@pytest.mark.parametrize('elapsed,expected',[(4,True),(5,False)])
def test_twelve_minute_retest_expiry_is_inclusive_and_finite(elapsed,expected):
    s=stream_trend();pending={};intentions(s,zone_context(s,40),40,pending,30)
    s.threes.append(bar(1105,1110,1098,1108,100));s.minutes[-1]=bar(1106,1109,1100,1108,50)
    signals=intentions(s,zone_context(s,40),40,pending,30+elapsed)
    assert bool([a for a in signals if a['plan']=='trend']) is expected


def test_retest_tolerance_cannot_expand_with_later_atr():
    s=stream_trend();pending={};intentions(s,zone_context(s,40),40,pending,30)
    s.threes.append(bar(1128,1132,1120,1130,100));s.minutes[-1]=bar(1129,1131,1120,1130,50)
    assert not intentions(s,zone_context(s,400),400,pending,31)


def test_failed_breakout_invalidates_pending():
    s=stream_trend();pending={};intentions(s,zone_context(s,40),40,pending,30)
    s.threes.append(bar(1100,1105,1080,1085));s.minutes[-1]=bar(1084,1090,1080,1085)
    assert not intentions(s,zone_context(s,40),40,pending,31)
    assert 1 not in pending


def test_zero_volume_and_zero_candle_range_do_not_make_reversals():
    s=stream_range()
    for b in s.threes[:-1]:b['volume']=0
    assert zone_context(s,40) is None
    s=stream_range();s.threes[-1]=bar(1030,1030,1030,1030)
    assert not intentions(s,zone_context(s,40),40,{},30)


def test_long_short_reflection_preserves_volume_and_swaps_zones():
    s=stream_range();z=zone_context(s,40)
    def mirror(b):return b|dict(open=3000-b['open'],high=3000-b['low'],low=3000-b['high'],close=3000-b['close'])
    reverse=NS(**{name:[mirror(b) for b in getattr(s,name)] for name in ('minutes','threes','fifteens')})
    q=zone_context(reverse,40)
    assert orient_zone(z['x'],1)==pytest.approx(orient_zone(q['x'],-1))
    left=intentions(s,z,40,{},30);right=intentions(reverse,q,40,{},30)
    assert left[0]['side']==-right[0]['side'] and left[0]['volumePassed']==right[0]['volumePassed']


def synthetic_data():
    start=boundary('2026-01-02')+8*3600+45*60;rows=[];rng=np.random.default_rng(42);close=40000
    for i in range(300):
        opening=close;close=round(40000+120*math.sin(i/18)+i*.3+rng.normal(0,5))
        close=40000+i%3
        opening=40000+(i-1)%3
        high=max(opening,close)+15;low=min(opening,close)-15
        if i==89:opening,high,low,close=40001,40043,39985,40042
        if i in (90,91,92):opening,high,low,close=40024,40026,40014,40023
        if i==92:opening=40022
        rows.append(dict(time=start+(i+1)*60,month='202601',open=opening,high=high,low=low,close=close,volume=100+i%17))
    return dict(source='fubon-paper',product='TMF',strategySession='regular',futures=rows,stocks={},start='2026-01-02',end='2026-01-02')


def test_future_candles_cannot_change_past_signals_stops_or_features():
    data=synthetic_data();events,_=build(data,['2026-01-02']);cut=data['futures'][179]['time']
    assert any(a.time<=cut for a in events['confirmed'])
    assert any(a.time<=cut for a in events['wick-zone'])
    changed=deepcopy(data)
    for b in changed['futures'][180:]:
        for name in ('open','high','low','close'):b[name]+=10000
        b['volume']*=100
    again,_=build(changed,['2026-01-02'])
    encode=lambda rows:[(a.key,a.stop_level,a.target_level,a.end,a.context,a.zone,list(a.x)) for a in rows if a.time<=cut]
    for source in events:assert encode(events[source])==encode(again[source])


def test_fit_has_no_future_label_or_window_influence(monkeypatch):
    from fubon_bridge import zone_models
    days=[(date(2026,1,1)+timedelta(days=i)).isoformat() for i in range(125)];rows=[];shapes={}
    for i,day in enumerate(days):
        for k in range(6):
            at=boundary(day)+10*3600+k*300;key=(at,1,'trend')
            a=NS(day=day,time=at,start=boundary(day)+8*3600+45*60,session='regular',label_end=at+3600,
                key=key,side=1,plan='trend',stop=30,target=60,x=[0,0,1,0,0,1],planned_risk=400,
                context=(.6,1.,1.,.1,.5,2.,1.),zone=(1.,1.,1.,2.,2.,3.,0.,.2,.2,.5,.2,0.))
            rows.append(a);shapes[key]=([float(k%3)]*63,10.)
    monkeypatch.setattr(zone_models,'_predict_head',lambda model,x:np.zeros(len(x)))
    monkeypatch.setattr(zone_models,'outcome',lambda a,extra,delay:None if a.time%1800==0 else dict(net=float(a.time%7)-extra-delay))
    aux=dict(kind='fixture');aux_meta=dict(cutoff=boundary(days[50]),metadata=dict(maximumLabelEnd=boundary(days[50])-1))
    cutoff=boundary(days[100]);rows[60*6].label_end=cutoff
    first,meta=fit(rows,days,shapes,aux,aux_meta)
    assert first and len(FEATURES)==90 and meta['fitDays']==40 and meta['fitActions']==239
    assert meta['maximumLabelEnd']<cutoff and all(n>0 for n in meta['noFillActions'].values())
    changed=deepcopy(rows)
    for a in changed:
        if a.day>=days[100]:a.zone=(999.,)*12;a.stop=9999
    second,other=fit(changed,days,shapes,aux,aux_meta)
    assert meta==other and first==second


def test_selection_cannot_promote_zero_trade_or_missing_model():
    from fubon_bridge.direction_execution import compare
    raw=compare([],{},['2026-01-02'],'hybrid')
    trials={name:[dict(calibration=dict(passed=False),guarded=raw)]*3 for name in POLICIES}
    assert select(trials)['selected'] is None
