"""Offline confirmed reversion/pullback signals and anchored-target replay."""
from array import array
from collections import defaultdict
from dataclasses import dataclass,replace
import math
from statistics import mean,pstdev

from .intraday_strategy import futures_tax
from .learning_data import quality
from .opportunity_research import (Action, COST, FEATURES as ORIGINAL_FEATURES,
    State, admission as original_admission, outcome as original_outcome)
from .strategy_session import opening_date,schedule

SCOPES=dict(hybrid=('range','trend'),range=('range',),trend=('trend',))
KEEP=[i for i,n in enumerate(ORIGINAL_FEATURES) if n not in
    ('weekdaySin','weekdayCos','monthSin','monthCos')]
FEATURES=[ORIGINAL_FEATURES[i] for i in KEEP]+['recoveryAtr3','previousMoveAtr3','targetNetRiskRatio']
FEATURES[1]='trendPlan'
POLICY=dict(version='structured-confirmation-v1',warmup=66,rangeEfficiency=.35,
    trendEfficiency=.55,rangeDeviation=1.,rangeMinimumTargetR=1.3,
    minimumCostMultiple=3.,rangeStopAtr3=.75,trendStopAtr3=1.,trendTargetR=2.,
    rangeHorizon=30,trendHorizon=60,recoveryMaximumAtr3=.75,trendEmaProxy='8 closed 3m close mean',
    priorContextOnly=True,atr3Context='strictly before signal minute',
    rangeTarget='frozen prior 20x3m close mean',
    stopAnchoring='signal ATR3 distance from confirmed entry',rangeTargetAnchoring='signal level',
    cost=COST,thinMinutes=5,maxEntries=2,oncePerSide=True,
    executionEnabled=False,adoptionAllowed=False)


@dataclass(slots=True)
class StructuredAction(Action):
    target_level: float | None
    planned_risk: float


def signals(stream,bar,vectors,prior_atr3):
    if vectors is None or not prior_atr3:
        return []
    context=[b for b in stream.threes if b['time']<bar['time']]
    if len(context)<20:
        return []
    atr=prior_atr3
    fifteen=stream.fifteens[-4:]
    closes=[b['close'] for b in fifteen]
    movement=closes[-1]-closes[0]
    path=sum(abs(b-a) for a,b in zip(closes,closes[1:]))
    efficiency=abs(movement)/path if path else 0.
    band=[b['close'] for b in context[-20:]];center=mean(band);deviation=pstdev(band)
    friction=4+(40+2*futures_tax(bar['close'],10,COST['taxRate']))/10
    found=[]
    for side in (1,-1):
        recovery=side*(bar['close']-stream.minutes[-2]['close'])/atr
        previous=side*(stream.minutes[-2]['close']-stream.minutes[-3]['close'])/atr
        if not (0<recovery<=.75 and previous<=0):
            continue
        kind=None;target_level=None
        if efficiency<=.35 and deviation and side*(bar['close']-center)/deviation<=-1:
            kind='range';stop=max(30,math.ceil(.75*atr))
            target=math.floor(side*(center-bar['close']))
            target_level=bar['close']+side*target
            if target<max(1.3*stop,3*friction):
                continue
        elif efficiency>=.55 and side*movement>0 and abs(bar['close']-mean(b['close'] for b in context[-8:]))<=atr:
            kind='trend';stop=max(30,math.ceil(atr));target=2*stop
            if target<3*friction:
                continue
        if kind is None:
            continue
        risk=(stop+2)*10+40+2*futures_tax(bar['close'],10,COST['taxRate'])
        if risk>1000:
            continue
        horizon=30 if kind=='range' else 60
        original=list(vectors[(side,'scalp' if kind=='range' else 'swing')][0])
        atr1=stream.atr1.value
        original[:6]=[side,float(kind=='trend'),stop/atr1,target/atr1,
            horizon/stream.spec.duration,friction/atr1]
        values=[original[i] for i in KEEP]+[recovery,previous,(target-friction)/(stop+friction)]
        found.append((side,kind,array('f',values),stop,target,target_level,risk,horizon))
    return found


def build(data,dates):
    diagnostics=quality(data);allowed=set(dates);spec=schedule(data['strategySession'])
    if not allowed<=set(diagnostics['completeDates']):
        raise ValueError('僅接受完整、單一契約的開盤日')
    grouped=defaultdict(list)
    for bar in data['futures']:
        day=opening_date(bar['time'],data['strategySession'])
        if day in allowed:
            start=int(spec.window(day)[0].timestamp())
            if start<bar['time']<=start+spec.duration*60:
                grouped[day].append(bar)
    events=[]
    for day,bars in sorted(grouped.items()):
        start=int(spec.window(day)[0].timestamp());stream=State(start,data['strategySession'],day)
        for i,bar in enumerate(bars):
            prior_atr3=stream.atr3.value
            vectors=stream.push(bar)
            for side,kind,x,stop,target,target_level,risk,horizon in signals(stream,bar,vectors,prior_atr3):
                end=min(i+horizon,spec.exit_minute-1,len(bars)-1)
                if end>i:
                    events.append(StructuredAction(day,bar['time'],side,kind,x,stop,target,i,end,
                        start,data['strategySession'],bars,target_level,risk))
    return events,dict(diagnostics,events=len(events),byPlan={p:sum(a.plan==p for a in events) for p in ('range','trend')})


def prepare(action,extra=0,delay=0,realized=0):
    admitted,reason=original_admission(action,extra,delay,realized)
    if admitted is None:
        return None,reason
    changed=action
    if action.target_level is not None:
        distance=action.side*(action.target_level-admitted['entry'])
        # Check again at the simulated quote, without moving the frozen level.
        friction=2*admitted['slip']+(40+futures_tax(admitted['entry'],10,COST['taxRate'])+
            futures_tax(action.target_level,10,COST['taxRate']))/10
        if distance<max(1.3*action.stop,3*friction):
            return None,'target_room'
        changed=replace(action,target=distance)
    return changed,None


def outcome(action,extra=0,delay=0,realized=0,marks=False):
    changed,reason=prepare(action,extra,delay,realized)
    return None if changed is None else original_outcome(changed,extra,delay,realized,marks)


def replay(events,scores,dates,scope='hybrid',threshold=0.,extra=0,delay=0,enabled=True):
    balance=peak=dd=0.;trades=[];by_day=dict.fromkeys(dates,0.);funnel=defaultdict(int)
    grouped=defaultdict(list)
    for event in events:
        grouped[event.time].append(event)
    day=None;used=set();busy=entries=0;realized=0.
    for at,group in sorted(grouped.items()):
        if group[0].day!=day:
            day=group[0].day;used=set();busy=entries=0;realized=0.
        funnel['signalTimes']+=1
        if not enabled:
            funnel['calibrationBlocked']+=1;continue
        if at<busy or entries>=2 or realized<=-1000:
            funnel['positionOrBudget']+=1;continue
        eligible=[a for a in group if a.plan in SCOPES[scope] and a.side not in used
            and scores.get(a.key) is not None and scores[a.key]>threshold]
        if not eligible:
            funnel['noPositiveScore']+=1;continue
        selected=max(eligible,key=lambda a:(scores[a.key],a.plan=='range',a.side>0))
        admitted,reason=prepare(selected,extra,delay,realized)
        if admitted is None:
            funnel['rejected_'+reason]+=1;continue
        trade=outcome(selected,extra,delay,realized,marks=True)
        for _,value in trade.pop('marks'):
            peak=max(peak,balance+value);dd=max(dd,peak-balance-value)
        trade.update(score=scores[selected.key],plannedRisk=selected.planned_risk,
            signalClose=selected.bars[selected.index]['close'],targetLevel=selected.target_level)
        trades.append(trade);balance+=trade['net'];by_day[day]+=trade['net'];realized+=trade['net']
        busy=trade['exitTime'];entries+=1;used.add(selected.side)
    return dict(count=len(trades),net=balance,maxDrawdown=dd,trades=trades,dates=by_day,
        withoutBestDay=balance-max(by_day.values(),default=0),funnel=dict(funnel),
        byPlan={p:dict(count=sum(t['plan']==p for t in trades),
            net=sum(t['net'] for t in trades if t['plan']==p)) for p in ('range','trend')})


def compare(events,scores,dates,scope,threshold=0.,enabled=True):
    return {name:replay(events,scores,dates,scope,threshold,extra,delay,enabled)
        for name,extra,delay in (('normal',0,0),('stress',2,0),('delayed',0,1))}
