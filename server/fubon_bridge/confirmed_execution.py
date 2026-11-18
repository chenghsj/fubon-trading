"""Offline structure confirmation and next-minute managed exits. No broker."""
from array import array
from collections import defaultdict
from dataclasses import dataclass, replace
import math
from statistics import mean, pstdev

from .intraday_strategy import futures_tax
from .learning_data import quality
from .opportunity_research import COST, State, admission
from .structured_research import (KEEP, SCOPES, StructuredAction, outcome as old_outcome,
    prepare as old_prepare, signals as old_signals)
from .strategy_session import opening_date, schedule

VARIANTS=('legacy','confirm-fixed','structure-fixed','structure-managed','pullback-managed')
POLICY=dict(version='confirmed-entry-exit-v1',variants=VARIANTS,warmup=90,decisionMinutes=3,
    trendEfficiency=.55,rangeEfficiency=.25,confirmBodyAtr3=.2,closeLocation=.65,
    breakoutBars=4,extensionAtr3=2.,rangeStd=1.5,stopBufferAtr3=.25,
    minimumStop=30,minimumCostMultiple=3.,rangeTargetR=1.3,trendTargetR=2.,
    noProgressMinutes=12,noProgressR=.5,trailActivationR=1.,trailBars3=2,
    exitsKnownAtClose='next minute open; new stop active next minute only',
    cost=COST,maxEntries=2,oncePerSide=True,executionEnabled=False,adoptionAllowed=False)


@dataclass(slots=True)
class ConfirmedAction(StructuredAction):
    variant: str
    stop_level: float | None
    atr3: float
    context: tuple[float,...]


def context(stream,bar,side,atr,prior,break_level,structural):
    closes=[b['close'] for b in stream.fifteens[-6:]]
    move=closes[-1]-closes[0];path=sum(abs(b-a) for a,b in zip(closes,closes[1:]))
    three=stream.threes[-1];std=pstdev(b['close'] for b in prior[-20:])
    return (abs(move)/path if path else 0.,side*move/atr,
        side*(closes[-1]-mean(closes))/atr,side*(bar['close']-break_level)/atr,
        side*(three['close']-three['open'])/atr,4*std/atr,float(structural))


def estimate(entry,stop,slip=2):
    worst=stop-(1 if entry>stop else -1)*slip
    return abs(entry-worst)*10+40+futures_tax(entry,10,COST['taxRate'])+futures_tax(worst,10,COST['taxRate'])


def candidates(stream,bar,prior,atr,variant):
    three=stream.threes[-1];closes=[b['close'] for b in stream.fifteens[-6:]]
    move=closes[-1]-closes[0];path=sum(abs(b-a) for a,b in zip(closes,closes[1:]))
    efficiency=abs(move)/path if path else 0.
    center=mean(b['close'] for b in prior[-20:]);std=pstdev(b['close'] for b in prior[-20:])
    near=mean(b['close'] for b in prior[-8:]);previous=prior[-1]
    span=three['high']-three['low'];found=[]
    if not span:
        return found
    for side in (1,-1):
        if side*(three['close']-three['open'])<.2*atr:
            continue
        location=(three['close']-three['low'])/span
        if (location if side>0 else 1-location)<.65:
            continue
        break_level=(max(b['high'] for b in prior[-4:]) if side>0 else min(b['low'] for b in prior[-4:]))
        trend=(efficiency>=.55 and side*move>0 and side*(closes[-1]-mean(closes))>0
            and side*(three['close']-break_level)>=1 and side*(previous['close']-break_level)<=0
            and abs(three['close']-near)<=2*atr)
        if variant=='pullback-managed':
            trend=trend and any(side*(b['low' if side>0 else 'high']-near)<=0 for b in prior[-3:])
        edge=center-side*1.5*std
        reversion=(efficiency<=.25 and std>0
            and side*(previous['low' if side>0 else 'high']-edge)<=0
            and side*(three['close']-edge)>0
            and side*(three['close']-previous['high' if side>0 else 'low'])>=1)
        plan='trend' if trend else 'range' if reversion else None
        if plan is None:
            continue
        if plan=='range':
            break_level=previous['high' if side>0 else 'low']
        structural=variant!='confirm-fixed';entry=bar['close']+side*2
        stop_level=None
        if structural:
            extreme=(min(b['low'] for b in (*prior[-3:],three)) if side>0
                else max(b['high'] for b in (*prior[-3:],three)))
            stop_level=math.floor(min(extreme-.25*atr,bar['close']-30)) if side>0 else math.ceil(max(extreme+.25*atr,bar['close']+30))
            stop=int(side*(entry-stop_level))
        else:
            stop=max(30,math.ceil(atr*(.75 if plan=='range' else 1.)))
        target_level=bar['close']+side*math.floor(side*(center-bar['close'])) if plan=='range' else None
        target=int(side*(target_level-entry)) if plan=='range' else 2*stop
        friction=4+(40+2*futures_tax(entry,10,COST['taxRate']))/10
        if target<max((1.3 if plan=='range' else 2)*stop,3*friction):
            continue
        risk=estimate(entry,stop_level if structural else entry-side*stop)
        if risk>1000:
            continue
        found.append((side,plan,stop,target,target_level,stop_level,risk,
            context(stream,bar,side,atr,prior,break_level,structural)))
    return found


def build(data,dates):
    diagnostics=quality(data);allowed=set(dates);session=data['strategySession'];spec=schedule(session)
    if not allowed<=set(diagnostics['completeDates']):
        raise ValueError('僅接受完整單一月份開盤日')
    grouped=defaultdict(list)
    for bar in data['futures']:
        day=opening_date(bar['time'],session)
        if day in allowed:
            start=int(spec.window(day)[0].timestamp())
            if start<bar['time']<=start+spec.duration*60:
                grouped[day].append(bar)
    output={v:[] for v in VARIANTS}
    for day,bars in sorted(grouped.items()):
        start=int(spec.window(day)[0].timestamp());stream=State(start,session,day)
        for i,bar in enumerate(bars):
            atr=stream.atr3.value;vectors=stream.push(bar)
            if vectors is None or not atr:
                continue
            prior=[b for b in stream.threes if b['time']<bar['time']]
            for side,plan,x,stop,target,level,risk,horizon in old_signals(stream,bar,vectors,atr):
                end=min(i+horizon,spec.exit_minute-1,len(bars)-1)
                break_level=max(b['high'] for b in prior[-4:]) if side>0 else min(b['low'] for b in prior[-4:])
                if end>i:
                    output['legacy'].append(ConfirmedAction(day,bar['time'],side,plan,x,stop,target,i,end,
                        start,session,bars,level,risk,'legacy',None,atr,
                        context(stream,bar,side,atr,prior,break_level,False)))
            minute=(bar['time']-start)//60
            if minute<90 or minute%3:
                continue
            for variant in VARIANTS[1:]:
                for side,plan,stop,target,level,stop_level,risk,ctx in candidates(stream,bar,prior,atr,variant):
                    horizon=30 if plan=='range' else 60
                    end=min(i+horizon,spec.exit_minute-1,len(bars)-1)
                    raw=list(vectors[(side,'scalp' if plan=='range' else 'swing')][0])
                    friction=4+(40+2*futures_tax(bar['close'],10,COST['taxRate']))/10
                    raw[:6]=[side,float(plan=='trend'),stop/stream.atr1.value,target/stream.atr1.value,
                        horizon/spec.duration,friction/stream.atr1.value]
                    x=array('f',[raw[k] for k in KEEP]+[0.,0.,(target-friction)/(stop+friction)])
                    if end>i:
                        output[variant].append(ConfirmedAction(day,bar['time'],side,plan,x,stop,target,i,end,
                            start,session,bars,level,risk,variant,stop_level,atr,ctx))
    return output,dict(diagnostics,byVariant={v:dict(events=len(rows),
        range=sum(a.plan=='range' for a in rows),trend=sum(a.plan=='trend' for a in rows)) for v,rows in output.items()})


def prepare(action,extra=0,delay=0,realized=0):
    changed=action
    if action.stop_level is not None:
        first=action.index+1+delay
        if first>action.end:
            return None,None,'deadline'
        entry=action.bars[first]['open']+action.side*(2+extra)
        distance=action.side*(entry-action.stop_level)
        if distance<30:
            return None,None,'structure_distance'
        changed=replace(action,stop=distance,target=2*distance if action.plan=='trend' else action.target)
    changed,reason=old_prepare(changed,extra,delay,realized)
    if changed is None:
        return None,None,reason
    filled,reason=admission(changed,extra,delay,realized)
    return changed,filled,reason


def breakeven(entry,side,slip):
    # Compute a tick that covers both actual taxes at that exit quote.
    costs=40+2*futures_tax(entry,10,COST['taxRate'])
    value=entry+side*(slip+math.ceil(costs/10))
    while (value-side*slip-entry)*side*10-40-futures_tax(entry,10,COST['taxRate'])-futures_tax(value-side*slip,10,COST['taxRate'])<0:
        value+=side
    return value


def trailing(action,index,entry,side,slip):
    elapsed=(action.bars[index]['time']-action.start)//60
    last=index-elapsed%3
    recent=action.bars[last-5:last+1]
    extreme=min(b['low'] for b in recent) if side>0 else max(b['high'] for b in recent)
    level=math.floor(extreme-.25*action.atr3) if side>0 else math.ceil(extreme+.25*action.atr3)
    return max(level,breakeven(entry,side,slip)) if side>0 else min(level,breakeven(entry,side,slip))


def outcome(action,extra=0,delay=0,realized=0,marks=False):
    if action.variant=='legacy':
        return old_outcome(action,extra,delay,realized,marks)
    changed,fill,_=prepare(action,extra,delay,realized)
    if fill is None:
        return None
    side=action.side;entry=fill['entry'];stop=fill['stop'];target=fill['target'];slip=fill['slip']
    initial_risk=changed.stop;best_close=0.;pending=None;values=[]
    managed=action.variant.endswith('managed')
    fee=lambda price:20+futures_tax(price,10,COST['taxRate'])
    for i in range(fill['first'],action.end+1):
        bar=action.bars[i];price=None;reason=None;exit_at=bar['time']
        stop_hit=side*(bar['low' if side>0 else 'high']-stop)<=0
        target_hit=side*(bar['high' if side>0 else 'low']-target)>=0
        if pending:
            price,reason=bar['open'],pending;exit_at-=60
        elif side*(bar['open']-stop)<=0:
            price,reason=bar['open'],'gap_stop';exit_at-=60
        elif side*(bar['open']-target)>=0:
            price,reason=target,'target';exit_at-=60
        elif stop_hit:
            price,reason=stop,'both_stop_first' if target_hit else 'stop'
        elif target_hit:
            price,reason=target,'target'
        elif i==action.end:
            price,reason=bar['close'],'deadline'
        if price is not None:
            exit_price=price-side*slip;net=(exit_price-entry)*side*10-fee(entry)-fee(exit_price)
            if marks:
                values.append((exit_at,net))
            return dict(time=action.time,exitTime=exit_at,day=action.day,plan=action.plan,
                side='Buy' if side>0 else 'Sell',entry=entry,exit=exit_price,net=net,reason=reason,
                risk=fill['risk'],marks=values)
        if marks:
            values.append((bar['time'],(bar['close']-entry)*side*10-fee(entry)-fee(bar['close'])))
        if managed:
            best_close=max(best_close,side*(bar['close']-entry))
            if i-fill['first']+1>=12 and best_close<.5*initial_risk:
                pending='no_progress'
            if best_close>=initial_risk:
                level=trailing(action,i,entry,side,slip)
                stop=max(stop,level) if side>0 else min(stop,level)
    raise ValueError('缺少預定退出棒')


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
        changed,fill,reason=prepare(selected,extra,delay,realized)
        if fill is None:
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
        byPlan={p:dict(count=sum(t['plan']==p for t in trades),net=sum(t['net'] for t in trades if t['plan']==p))
            for p in ('range','trend')})


def compare(events,scores,dates,scope,threshold=0.,enabled=True):
    return {name:replay(events,scores,dates,scope,threshold,extra,delay,enabled)
        for name,extra,delay in (('normal',0,0),('stress',2,0),('delayed',0,1))}
