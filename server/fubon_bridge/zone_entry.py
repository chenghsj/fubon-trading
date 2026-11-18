"""Offline price-zone rejection/retest hypotheses. Never constructs a broker."""
from array import array
from collections import Counter
from dataclasses import dataclass, fields
import math
from statistics import mean

from .candle_patterns import future_days
from .confirmed_execution import context, estimate
from .direction_execution import DirectionAction, build as parent_build, compare, rule_scores
from .intraday_strategy import futures_tax
from .learning_data import quality
from .opportunity_research import State
from .research import digest
from .structured_research import KEEP
from .strategy_session import schedule

SOURCES=('confirmed','wick-zone','wick-volume')
ZONE_FEATURES=['relativeVolume1','relativeVolume3','relativeVolume15','supportTouches','resistanceTouches',
    'widthATR3','position','lowerRejectATR3','upperRejectATR3','lowerWick','upperWick','distanceMidATR3']
POLICY=dict(version='wick-volume-zones-v1',sources=SOURCES,warmupMinutes=90,decisionMinutes=3,
    zoneBars3=20,zoneQuantiles=[.1,.9],toleranceATR3=.25,minimumWickFraction=.35,
    closeLocation=.65,minimumTouches=2,trendEfficiency=.55,rangeEfficiency=.25,
    breakoutRetestMinutes=12,volumeMultiple=1.5,minimumStop=30,stopBufferATR3=.25,
    trendTargetR=2.,rangeTargetR=1.3,minimumCostMultiple=3.,fixedExit=True,
    maximumEntries=2,oncePerSide=True,lossBudget=1000,executionAllowed=False,adoptionAllowed=False)


@dataclass(slots=True)
class ZoneAction(DirectionAction):
    zone: tuple[float,...]


def quantile(values,q):
    values=sorted(values);index=(len(values)-1)*q;i=int(index)
    return values[i]+(values[min(i+1,len(values)-1)]-values[i])*(index-i)


def episodes(values):
    """Adjacent touches are one visit, not independent confirmation."""
    return sum(value and (i==0 or not values[i-1]) for i,value in enumerate(values))


def zone_context(stream,atr):
    three=stream.threes[-1];prior=stream.threes[-21:-1]
    if len(prior)!=20 or len(stream.fifteens)<4 or atr<=0:raise ValueError('價位區間暖身不足')
    lower=quantile([b['low'] for b in prior],.1);upper=quantile([b['high'] for b in prior],.9)
    tolerance=max(1.,.25*atr);width=upper-lower
    span=three['high']-three['low'];mid=(lower+upper)/2
    volume=lambda bar,previous:bar['volume']/mean(b['volume'] for b in previous) if mean(b['volume'] for b in previous)>0 else None
    v1=volume(stream.minutes[-1],stream.minutes[-21:-1]);v3=volume(three,prior)
    v15=volume(stream.fifteens[-1],stream.fifteens[-4:-1])
    if width<=0 or any(v is None for v in (v1,v3,v15)):return None
    low_touches=episodes([abs(b['low']-lower)<=tolerance for b in prior])
    high_touches=episodes([abs(b['high']-upper)<=tolerance for b in prior])
    lower_wick=(min(three['open'],three['close'])-three['low'])/span if span else 0.
    upper_wick=(three['high']-max(three['open'],three['close']))/span if span else 0.
    x=(v1,v3,v15,low_touches,high_touches,width/atr,2*(three['close']-lower)/width-1,
        (three['close']-three['low'])/atr if three['low']<=lower+tolerance else 0.,
        (three['high']-three['close'])/atr if three['high']>=upper-tolerance else 0.,
        lower_wick,upper_wick,(three['close']-mid)/atr)
    return dict(lower=lower,upper=upper,mid=mid,tolerance=tolerance,x=x,
        lowerWick=lower_wick,upperWick=upper_wick,location=(three['close']-three['low'])/span if span else .5,
        lowerTouches=low_touches,upperTouches=high_touches,relativeVolume3=v3)


def orient_zone(values,side):
    x=list(values)
    if side==-1:
        for i,j in ((3,4),(7,8),(9,10)):x[i],x[j]=x[j],x[i]
        x[6]*=-1;x[11]*=-1
    if side not in (-1,1) or len(x)!=len(ZONE_FEATURES) or not all(math.isfinite(v) for v in x):
        raise ValueError('區間價量特徵無效')
    return [max(-10.,min(10.,v)) for v in x]


def intentions(stream,z,atr,pending,number):
    """Inspect only closed bars; a breakout freezes its level for later retest."""
    bar=stream.minutes[-1];three=stream.threes[-1];previous=stream.threes[-2]
    closes=[b['close'] for b in stream.fifteens[-6:]]
    move=closes[-1]-closes[0];path=sum(abs(b-a) for a,b in zip(closes,closes[1:]))
    efficiency=abs(move)/path if path else 0.;found=[]
    for side in (1,-1):
        level=z['lower'] if side>0 else z['upper'];wick=z['lowerWick'] if side>0 else z['upperWick']
        low=three['low'] if side>0 else three['high'];location=z['location'] if side>0 else 1-z['location']
        confirm=wick>=.35 and location>=.65 and side*(bar['close']-bar['open'])>=0
        if (efficiency<=.25 and confirm and (z['lowerTouches'] if side>0 else z['upperTouches'])>=2
            and side*(low-level)<=z['tolerance'] and side*(three['close']-level)>0
            and z['lower']<three['close']<z['upper']):
            found.append(dict(side=side,plan='range',level=level,target=z['mid'],
                volumePassed=z['relativeVolume3']>=1.5))
        old=pending.get(side)
        if old and number-old['number']>4:pending.pop(side);old=None
        if old and side*(three['close']-old['level'])< -max(1.,.25*old['atr']):
            pending.pop(side);old=None
        trend=efficiency>=.55 and side*move>0 and side*(closes[-1]-mean(closes))>0
        if old and number>old['number'] and trend and confirm:
            if side*(low-old['level'])<=max(1.,.25*old['atr']) and side*(three['close']-old['level'])>0:
                found.append(dict(side=side,plan='trend',level=old['level'],target=None,
                    volumePassed=old['relativeVolume']>=1.5 and three['volume']<=old['volume']))
        # New breakout is observable only now, and cannot be retested in this
        # same three-minute candle. New higher/lower levels replace old ones.
        extreme=max(b['high'] for b in stream.threes[-21:-1]) if side>0 else min(b['low'] for b in stream.threes[-21:-1])
        if (trend and side*(previous['close']-extreme)<=0 and side*(three['close']-extreme)>=1
            and (old is None or side*(extreme-old['level'])>=1)):
            pending[side]=dict(level=extreme,number=number,atr=atr,relativeVolume=z['relativeVolume3'],volume=three['volume'])
    return found


def build(data,dates):
    q=quality(data)
    if not set(dates)<=set(q['completeDates']):raise ValueError('僅使用完整單一月份開盤日')
    baseline,_=parent_build(data,dates);output={s:[] for s in SOURCES};by_time={};diagnostics=Counter()
    session=data['strategySession'];spec=schedule(session)
    for day,start,bars in future_days(data,dates):
        stream=State(start,session,day);pending={}
        for i,bar in enumerate(bars):
            atr=stream.atr3.value;vectors=stream.push(bar);minute=(bar['time']-start)//60
            if vectors is None or not atr or minute<90 or minute%3:continue
            z=zone_context(stream,atr)
            if z is None:diagnostics['missingZoneOrVolume']+=1;continue
            by_time[bar['time']]=z['x'];prior=stream.threes[-21:-1]
            for intent in intentions(stream,z,atr,pending,len(stream.threes)):
                side,plan=intent['side'],intent['plan'];diagnostics[plan+'Intentions']+=1
                entry=bar['close']+side*2
                stop_level=math.floor(min(stream.threes[-1]['low']-.25*atr,bar['close']-30)) if side>0 else math.ceil(max(stream.threes[-1]['high']+.25*atr,bar['close']+30))
                target_level=(math.floor(intent['target']) if side>0 else math.ceil(intent['target'])) if plan=='range' else None
                stop=side*(entry-stop_level);target=side*(target_level-entry) if plan=='range' else 2*stop
                friction=4+(40+2*futures_tax(entry,10,.00002))/10;risk=estimate(entry,stop_level)
                if risk>1000 or target<max((1.3 if plan=='range' else 2)*stop,3*friction):
                    diagnostics['riskOrTargetRoom']+=1;continue
                horizon=30 if plan=='range' else 60;end=min(i+horizon,spec.exit_minute-1,len(bars)-1)
                if end<=i:continue
                raw=list(vectors[(side,'scalp' if plan=='range' else 'swing')][0])
                raw[:6]=[side,float(plan=='trend'),stop/stream.atr1.value,target/stream.atr1.value,
                    horizon/spec.duration,friction/stream.atr1.value]
                x=array('f',[raw[k] for k in KEEP]+[0.,0.,(target-friction)/(stop+friction)])
                a=ZoneAction(day,bar['time'],side,plan,x,stop,target,i,end,start,session,bars,target_level,risk,
                    'structure-fixed',stop_level,atr,context(stream,bar,side,atr,prior,intent['level'],True),
                    'confirmed','fixed',(0.,0.,0.,0.),tuple(z['x']))
                output['wick-zone'].append(a)
                if intent['volumePassed']:output['wick-volume'].append(a)
    for a in baseline['confirmed-fixed']:
        if a.time not in by_time:continue
        output['confirmed'].append(ZoneAction(**{f.name:getattr(a,f.name) for f in fields(DirectionAction)},zone=tuple(by_time[a.time])))
    original=baseline['confirmed-fixed'];common=[a for a in original if a.time in by_time]
    parent_full=compare(original,rule_scores(original),dates,'hybrid')
    parent_common=compare(common,rule_scores(common),dates,'hybrid')
    repeated=compare(output['confirmed'],rule_scores(output['confirmed']),dates,'hybrid')
    if repeated!=parent_common:raise ValueError('共同可計算cohort的父fixed逐筆重播不符')
    control=dict(parentEvents=len(original),excludedParentEvents=len(original)-len(common),
        excludedParentKeys=[a.key for a in original if a.time not in by_time],commonReplayMatched=True,
        fullParentRule={s:{k:v for k,v in r.items() if k!='trades'}|dict(tradeHash=digest(r['trades'])) for s,r in parent_full.items()})
    return output,dict(q,diagnostics=dict(diagnostics),parentControl=control,bySource={s:dict(events=len(v),days=len({a.day for a in v}),
        range=sum(a.plan=='range' for a in v),trend=sum(a.plan=='trend' for a in v)) for s,v in output.items()})
