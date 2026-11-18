"""Causal, scale-free intraday candle shapes. No broker or order interfaces."""
from collections import Counter, defaultdict
from dataclasses import dataclass
from datetime import datetime
import math

from .mapping import TAIPEI
from .strategy_session import opening_date, schedule

FRAMES=(1,3,15)
FEATURES=[f'{frame}m_{name}' for frame in FRAMES for name in (
    *(f'lag{lag}_{value}' for lag in (2,1,0) for value in
      ('body','upper','lower','location','rangeAtr')),
    'gapAtr','engulf','inside','outside','move3Atr','compression')]


@dataclass(slots=True)
class PatternRow:
    asset: str
    day: str
    time: int
    label_end: int
    x: list[float]
    target: float


def boundary(day):
    return int(datetime.fromisoformat(day).replace(tzinfo=TAIPEI).timestamp())


def aggregate(bars):
    return dict(open=bars[0]['open'],high=max(b['high'] for b in bars),
        low=min(b['low'] for b in bars),close=bars[-1]['close'])


def shape(bars,index,start):
    """Only past 60 consecutive minutes, all higher frames closed at index."""
    if index<59:
        return None
    history=bars[index-59:index+1]
    if any(b['time']!=history[0]['time']+i*60 for i,b in enumerate(history)):
        return None
    elapsed=(bars[index]['time']-start)//60
    if elapsed<60 or bars[index]['time']!=start+elapsed*60:
        return None
    recent=history[-15:]
    atr=sum(max(b['high']-b['low'],abs(b['high']-a['close']),abs(b['low']-a['close']))
        for a,b in zip(recent,recent[1:]))/14
    if not math.isfinite(atr) or atr<=0:
        return None
    values=[]
    for frame in FRAMES:
        # index is a closing minute; ignore the still-forming frame suffix.
        last=index-elapsed%frame
        candles=[aggregate(bars[last-(3-lag)*frame+1:last-(2-lag)*frame+1]) for lag in range(3)]
        unit=atr*math.sqrt(frame)
        for b in candles:
            span=b['high']-b['low']
            values.extend(((b['close']-b['open'])/span if span else 0.,
                (b['high']-max(b['open'],b['close']))/span if span else 0.,
                (min(b['open'],b['close'])-b['low'])/span if span else 0.,
                2*(b['close']-b['low'])/span-1 if span else 0.,span/unit))
        old,previous,current=candles
        engulf=(1. if current['close']>current['open'] and previous['close']<previous['open']
            and current['open']<=previous['close'] and current['close']>=previous['open'] else
            -1. if current['close']<current['open'] and previous['close']>previous['open']
            and current['open']>=previous['close'] and current['close']<=previous['open'] else 0.)
        earlier_range=((old['high']-old['low'])+(previous['high']-previous['low']))/2
        values.extend(((current['open']-previous['close'])/unit,engulf,
            float(current['high']<=previous['high'] and current['low']>=previous['low']),
            float(current['high']>=previous['high'] and current['low']<=previous['low']),
            (current['close']-old['open'])/unit,
            (current['high']-current['low'])/earlier_range if earlier_range else
                10. if current['high']>current['low'] else 0.))
    if not all(math.isfinite(v) for v in values):
        raise ValueError('K 棒型態含無效數字')
    return [max(-10.,min(10.,v)) for v in values],atr


def oriented(values,side):
    """Reflect price geometry for a sell without changing candle chronology."""
    if side not in (1,-1) or len(values)!=len(FEATURES):
        raise ValueError('K 棒方向或特徵數量錯誤')
    result=list(values)
    for offset in (0,21,42):
        for lag in (0,5,10):
            result[offset+lag]*=side
            result[offset+lag+3]*=side
            if side<0:
                result[offset+lag+1],result[offset+lag+2]=result[offset+lag+2],result[offset+lag+1]
        for i in (15,16,19):
            result[offset+i]*=side
    return result


def stock_days(bars):
    grouped=defaultdict(list)
    for bar in bars:
        day=opening_date(bar['time'],'cash');start=boundary(day)+9*3600
        if start<bar['time']<=start+265*60:
            grouped[day].append(bar)
    return [(day,boundary(day)+9*3600,sorted(rows,key=lambda b:b['time'])) for day,rows in sorted(grouped.items())]


def future_days(data,dates):
    allowed=set(dates);grouped=defaultdict(list);session=data['strategySession'];spec=schedule(session)
    for bar in data['futures']:
        day=opening_date(bar['time'],session)
        if day in allowed:
            start=int(spec.window(day)[0].timestamp())
            if start<bar['time']<=start+spec.duration*60:
                grouped[day].append(bar)
    return [(day,int(spec.window(day)[0].timestamp()),sorted(rows,key=lambda b:b['time']))
        for day,rows in sorted(grouped.items())]


def samples(asset,days,cutoff):
    """15-minute gross movement is an auxiliary pattern label, not net P&L."""
    rows=[];diagnostics=Counter()
    for day,start,bars in days:
        if start>=cutoff:
            continue
        diagnostics['days']+=1
        for i,bar in enumerate(bars):
            if (bar['time']-start)//60%5 or i+15>=len(bars):
                continue
            end=bars[i+15]['time']
            if end>=cutoff:
                diagnostics['cutoffExcluded']+=1;continue
            if any(bars[i+j]['time']!=bar['time']+j*60 for j in range(1,16)):
                diagnostics['futureGapExcluded']+=1;continue
            result=shape(bars,i,start)
            if result is None:
                diagnostics['historyExcluded']+=1;continue
            x,atr=result
            target=max(-3.,min(3.,(bars[i+15]['close']-bars[i+1]['open'])/atr))
            rows.append(PatternRow(asset,day,bar['time'],end,x,target))
    return rows,dict(diagnostics,samples=len(rows),sampleDays=len({r.day for r in rows}))


def weights(rows,pooled=False):
    """Equal asset/day; pooled TMF and the stock group each have half mass."""
    if not rows:
        raise ValueError('沒有預訓練樣本')
    counts=Counter((r.asset,r.day) for r in rows)
    days=Counter(asset for asset,_ in counts)
    assets=set(days);stocks=assets-{'TMF'}
    if pooled and ('TMF' not in assets or not stocks):
        raise ValueError('共同預訓練缺少股票或微台')
    mass={a:(.5 if a=='TMF' else .5/len(stocks)) if pooled else 1/len(assets) for a in assets}
    return [len(rows)*mass[r.asset]/days[r.asset]/counts[(r.asset,r.day)] for r in rows]


def action_shapes(events):
    cache={};result={}
    for action in events:
        identity=(action.session,action.time)
        if identity not in cache:
            cache[identity]=shape(action.bars,action.index,action.start)
        found=cache[identity]
        if found is None:
            raise ValueError('完整微台訊號缺少足夠連續的型態歷史')
        result[action.key]=found
    return result
