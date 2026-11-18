"""Offline competing directions and evidence-based continuation. No order APIs."""
from array import array
from collections import defaultdict
from dataclasses import dataclass, fields
import math
from statistics import mean

from .candle_patterns import aggregate
from .confirmed_execution import (ConfirmedAction, SCOPES, build as parent_build,
    context, estimate, outcome as parent_outcome, prepare)
from .intraday_strategy import futures_tax
from .opportunity_research import COST, State
from .structured_research import KEEP
from .strategy_session import opening_date, schedule

VARIANTS=('confirmed-fixed','confirmed-evidence','paired-fixed','paired-evidence')
POLICY=dict(version='direction-continuation-v1',variants=VARIANTS,warmup=90,decisionMinutes=3,
    pairedStopBars1=5,pairedStopBufferAtr1=.25,minimumStop=30,minimumCostMultiple=3.,
    trendTargetR=2.,rangeTargetR=1.3,directionMarginNTD=30.,waitValue=0.,
    evidenceMinimumMinutes=6,evidenceLossR=.5,evidenceMeanBars3=8,
    trailActivationCloseR=1.5,trailBars3=2,trailBufferSignalAtr3=.25,forceBreakeven=False,
    exitsKnownAtClose='next open; trailing stop next bar only',cost=COST,
    maxEntries=2,oncePerSide=True,executionEnabled=False,adoptionAllowed=False)


@dataclass(slots=True)
class DirectionAction(ConfirmedAction):
    source: str
    exit_mode: str
    extras: tuple[float,...]


def clone(action,source,exit_mode,extras):
    return DirectionAction(**{f.name:getattr(action,f.name) for f in fields(ConfirmedAction)},
        source=source,exit_mode=exit_mode,extras=extras)


def build(data,dates):
    previous,quality=parent_build(data,dates);confirmed=previous['structure-fixed']
    session=data['strategySession'];spec=schedule(session);allowed=set(dates);grouped=defaultdict(list)
    for bar in data['futures']:
        day=opening_date(bar['time'],session)
        if day in allowed:
            start=int(spec.window(day)[0].timestamp())
            if start<bar['time']<=start+spec.duration*60:
                grouped[day].append(bar)
    output={v:[] for v in VARIANTS};extra_by_time={}
    for day,bars in sorted(grouped.items()):
        start=int(spec.window(day)[0].timestamp());stream=State(start,session,day)
        for i,bar in enumerate(bars):
            atr3=stream.atr3.value;vectors=stream.push(bar);minute=(bar['time']-start)//60
            if vectors is None or atr3 is None or minute<90 or minute%3:
                continue
            atr1=stream.atr1.value;prior=[b for b in stream.threes if b['time']<bar['time']]
            center=mean(b['close'] for b in prior[-20:])
            high=max(b['high'] for b in prior[-20:]);low=min(b['low'] for b in prior[-20:])
            volume=mean(b['volume'] for b in stream.minutes[-21:-1])
            raw_extra=(bar['volume']/volume if volume else 0.,
                (bar['close']-stream.vwaps[-1])/atr1,
                (bar['close']-stream.minutes[-6]['close'])/atr1,
                (bar['close']-(high+low)/2)/(high-low) if high>low else 0.)
            extra_by_time[bar['time']]=raw_extra
            for side in (1,-1):
                entry=bar['close']+side*2
                recent=stream.minutes[-5:]
                extreme=min(b['low'] for b in recent) if side>0 else max(b['high'] for b in recent)
                level=math.floor(min(extreme-.25*atr1,bar['close']-30)) if side>0 else math.ceil(max(extreme+.25*atr1,bar['close']+30))
                stop=int(side*(entry-level));risk=estimate(entry,level)
                if risk>1000:
                    continue
                break_level=max(b['high'] for b in prior[-4:]) if side>0 else min(b['low'] for b in prior[-4:])
                ctx=context(stream,bar,side,atr3,prior,break_level,True)
                extras=(raw_extra[0],*(side*v for v in raw_extra[1:]))
                friction=4+(40+2*futures_tax(entry,10,COST['taxRate']))/10
                for plan in ('range','trend'):
                    target_level=bar['close']+side*math.floor(side*(center-bar['close'])) if plan=='range' else None
                    target=int(side*(target_level-entry)) if plan=='range' else 2*stop
                    if target<max((1.3 if plan=='range' else 2)*stop,3*friction):
                        continue
                    horizon=30 if plan=='range' else 60;end=min(i+horizon,spec.exit_minute-1,len(bars)-1)
                    if end<=i:
                        continue
                    raw=list(vectors[(side,'scalp' if plan=='range' else 'swing')][0])
                    raw[:6]=[side,float(plan=='trend'),stop/atr1,target/atr1,horizon/spec.duration,friction/atr1]
                    x=array('f',[raw[k] for k in KEEP]+[0.,0.,(target-friction)/(stop+friction)])
                    for exit_mode in ('fixed','evidence'):
                        variant='paired-'+exit_mode
                        output[variant].append(DirectionAction(day,bar['time'],side,plan,x,stop,target,i,end,
                            start,session,bars,target_level,risk,'paired-fixed',level,atr3,ctx,
                            'paired',exit_mode,extras))
    for action in confirmed:
        raw_extra=extra_by_time[action.time]
        extras=(raw_extra[0],*(action.side*v for v in raw_extra[1:]))
        for exit_mode in ('fixed','evidence'):
            output['confirmed-'+exit_mode].append(clone(action,'confirmed',exit_mode,extras))
    return output,dict(quality,byVariant={v:dict(events=len(rows),range=sum(a.plan=='range' for a in rows),
        trend=sum(a.plan=='trend' for a in rows)) for v,rows in output.items()})


def closed_threes(action,index,count):
    elapsed=(action.bars[index]['time']-action.start)//60
    end=index-elapsed%3;start=end-count*3+1
    if start<0:
        raise ValueError('反向結構尚未暖身')
    return [aggregate(action.bars[k:k+3]) for k in range(start,end+1,3)]


def failed_structure(action,index,entry,initial_risk,first):
    at=action.bars[index]
    if (index-first+1<6 or (at['time']-action.start)//60%3
        or action.side*(at['close']-entry)>-.5*initial_risk):
        return False
    rows=closed_threes(action,index,9);previous,current=rows[-2:];center=mean(b['close'] for b in rows[:-1])
    side=action.side;line=previous['low' if side>0 else 'high']
    return (side*(previous['close']-center)<0 and side*(current['close']-center)<0
        and side*(current['close']-line)<=-1)


def trail(action,index):
    rows=closed_threes(action,index,2)
    extreme=min(b['low'] for b in rows) if action.side>0 else max(b['high'] for b in rows)
    return math.floor(extreme-.25*action.atr3) if action.side>0 else math.ceil(extreme+.25*action.atr3)


def outcome(action,extra=0,delay=0,realized=0,marks=False):
    if action.exit_mode=='fixed':
        return parent_outcome(action,extra,delay,realized,marks)
    changed,fill,_=prepare(action,extra,delay,realized)
    if fill is None:
        return None
    side=action.side;entry=fill['entry'];stop=fill['stop'];target=fill['target'];slip=fill['slip']
    initial_risk=changed.stop;best_close=0.;pending=False;values=[]
    fee=lambda price:20+futures_tax(price,10,COST['taxRate'])
    for i in range(fill['first'],action.end+1):
        bar=action.bars[i];price=None;reason=None;exit_at=bar['time']
        stop_hit=side*(bar['low' if side>0 else 'high']-stop)<=0
        target_hit=side*(bar['high' if side>0 else 'low']-target)>=0
        if pending:
            price,reason=bar['open'],'failed_structure';exit_at-=60
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
        pending=failed_structure(action,i,entry,initial_risk,fill['first'])
        best_close=max(best_close,side*(bar['close']-entry))
        if best_close>=1.5*initial_risk:
            level=trail(action,i)
            stop=max(stop,level) if side>0 else min(stop,level)
    raise ValueError('缺少原定期限退出')


def rule_scores(events):
    scores={}
    for a in events:
        if a.source=='confirmed':
            scores[a.key]=1.;continue
        efficiency,direction,relative,*_=a.context
        allowed=(a.plan=='trend' and efficiency>=.55 and direction>0 and relative>0
            or a.plan=='range' and efficiency<=.25)
        scores[a.key]=100. if allowed else 0.
    return scores


def choose(group,scores,scope,threshold,used):
    permitted=[a for a in group if a.plan in SCOPES[scope] and scores.get(a.key) is not None]
    if not permitted:
        return None,'noPositiveScore'
    paired=group[0].source=='paired'
    eligible=permitted if paired else [a for a in permitted if a.side not in used]
    if not eligible:
        return None,'usedDirection'
    selected=max(eligible,key=lambda a:(scores[a.key],a.plan=='range',a.side>0))
    if scores[selected.key]<=threshold:
        return None,'noPositiveScore'
    if paired:
        other=[scores[a.key] for a in permitted if a.side!=selected.side]
        if other and scores[selected.key]-max(other)<30.:
            return None,'ambiguousDirection'
        if selected.side in used:
            return None,'usedDirection'
    return selected,None


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
        selected,reason=choose(group,scores,scope,threshold,used)
        if selected is None:
            # Keep legacy accounting identical where its single direction is used.
            funnel['noPositiveScore' if group[0].source=='confirmed' else reason]+=1;continue
        _,fill,reason=prepare(selected,extra,delay,realized)
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
