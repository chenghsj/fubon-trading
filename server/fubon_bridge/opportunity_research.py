"""Causal action opportunities and cost replay. Offline research only."""
from array import array
from collections import defaultdict
from dataclasses import dataclass
from datetime import date
import math
from statistics import mean, pstdev

from .indicator_research import Kd, Macd, Rsi
from .intraday_strategy import futures_tax
from .learning_data import quality
from .learning_multiframe import MTF_FEATURES, candle_features
from .strategy_session import opening_date, schedule

COST = dict(feePerSide=20.,slippagePoints=2.,taxRate=.00002,multiplier=10,lossLimit=1000.)
PLANS = dict(scalp=dict(stopAtr=1.,targetR=1.,horizon=15),swing=dict(stopAtr=1.5,targetR=2.,horizon=45))
SCOPES = dict(hybrid=('scalp','swing'),scalp=('scalp',),swing=('swing',))
FEATURES = ['actionSide','swingPlan','stopAtr','targetAtr','horizonFraction','estimatedCostAtr',
    'sessionTime','remainingTime','atrPrice','atr3Ratio','efficiency15','move15Atr','dayReturn',
    'clockSin','clockCos','weekdaySin','weekdayCos','monthSin','monthCos',*MTF_FEATURES,
    'macd1Atr','macdSignal1Atr','macdHist1Atr','macdChange1Atr',
    'rsi1','rsiChange1','rsi3','rsiChange3','kd1','kdSpread1','kdChange1','kd3','kdSpread3','kdChange3',
    'band3Z','band3WidthAtr','vwapDistanceAtr','vwapChangeAtr']
POLICY = dict(version='opportunity-actions-v1',decisionMinutes=1,warmupMinutes=66,
    plans=PLANS,cost=COST,maxEntries=2,oncePerSide=True,minimumStop=30,maximumEntryDrift=10,
    simultaneousActions=4,waitValue=0.,ties='scalp before swing, Buy before Sell',
    features=FEATURES,executionEnabled=False,adoptionAllowed=False)


def candle(rows):
    return dict(time=rows[-1]['time'],open=rows[0]['open'],high=max(b['high'] for b in rows),
        low=min(b['low'] for b in rows),close=rows[-1]['close'],volume=sum(b['volume'] for b in rows))


class Atr:
    def __init__(self):
        self.previous=None;self.seed=[];self.value=None

    def push(self,bar):
        tr=bar['high']-bar['low'] if self.previous is None else max(bar['high']-bar['low'],
            abs(bar['high']-self.previous),abs(bar['low']-self.previous))
        self.previous=bar['close']
        if self.value is None:
            self.seed.append(tr)
            if len(self.seed)==14:
                self.value=mean(self.seed)
        else:
            self.value=(13*self.value+tr)/14
        return self.value


class State:
    def __init__(self,start,session,day):
        self.start=start;self.spec=schedule(session)
        self.minutes=[];self.threes=[];self.fifteens=[]
        self.atr1=Atr();self.atr3=Atr();self.macd=Macd()
        self.rsi1=Rsi();self.rsi3=Rsi();self.kd1=Kd();self.kd3=Kd()
        self.r3=self.k3=None;self.notional=self.volume=0.;self.vwaps=[]
        opened=date.fromisoformat(day)
        self.calendar=[math.sin(2*math.pi*opened.weekday()/7),math.cos(2*math.pi*opened.weekday()/7),
            math.sin(2*math.pi*(opened.month-1)/12),math.cos(2*math.pi*(opened.month-1)/12)]

    def push(self,bar):
        if bar['time']!=self.start+(len(self.minutes)+1)*60:
            raise ValueError('動作研究分鐘資料缺漏、重複或順序錯誤')
        if (not all(isinstance(bar[k],(int,float)) and math.isfinite(bar[k]) for k in ('open','high','low','close','volume'))
            or min(bar[k] for k in ('open','high','low','close'))<=0 or bar['volume']<0
            or bar['high']<max(bar['open'],bar['close']) or bar['low']>min(bar['open'],bar['close'])):
            raise ValueError('動作研究行情無效')
        self.minutes.append(bar);minute=len(self.minutes)
        atr=self.atr1.push(bar);macd=self.macd.push(bar['close'])
        r1=self.rsi1.push(bar['close']);k1=self.kd1.push(bar)
        self.notional+=(bar['high']+bar['low']+bar['close'])/3*bar['volume'];self.volume+=bar['volume']
        self.vwaps.append(self.notional/self.volume if self.volume else None)
        if minute%3==0:
            three=candle(self.minutes[-3:]);self.threes.append(three)
            self.atr3.push(three);self.r3=self.rsi3.push(three['close']);self.k3=self.kd3.push(three)
        if minute%15==0:
            self.fifteens.append(candle(self.minutes[-15:]))
        if not 66<=minute<=self.spec.last_entry:
            return None
        if not atr or not self.atr3.value or self.vwaps[-4] is None:
            return None
        if any(v is None or v[-1] is None for v in (macd,r1,self.r3,k1,self.k3)):
            raise ValueError('動作特徵尚未暖身')
        closes=[b['close'] for b in self.fifteens[-4:]]
        move=closes[-1]-closes[0];path=sum(abs(b-a) for a,b in zip(closes,closes[1:]))
        band=[b['close'] for b in self.threes[-20:]];center=mean(band);std=pstdev(band)
        clock=2*math.pi*((self.spec.start_minute+minute)%1440)/1440
        vectors={}
        for side in (1,-1):
            common=[minute/self.spec.duration,(self.spec.exit_minute-minute)/self.spec.duration,
                atr/bar['close'],self.atr3.value/atr,abs(move)/path if path else 0.,side*move/atr,
                side*(bar['close']/self.minutes[0]['open']-1),math.sin(clock),math.cos(clock),*self.calendar]
            for rows in (self.minutes,self.threes,self.fifteens):
                common+=candle_features(rows,side)
            common += [side*v/atr for v in macd]
            common += [v for level,change in (r1,self.r3) for v in (side*(level-50)/50,side*change/100)]
            common += [v for level,spread,change in (k1,self.k3) for v in (side*(level-50)/50,side*spread/100,side*change/100)]
            common += [side*(self.threes[-1]['close']-center)/std if std else 0.,4*std/atr,
                side*(bar['close']-self.vwaps[-1])/atr,side*(self.vwaps[-1]-self.vwaps[-4])/atr]
            for plan,spec in PLANS.items():
                stop=max(30,math.ceil(atr*spec['stopAtr']));target=math.ceil(stop*spec['targetR'])
                friction=2*COST['slippagePoints']+(2*COST['feePerSide']+2*futures_tax(bar['close'],10,COST['taxRate']))/10
                values=[side,float(plan=='swing'),stop/atr,target/atr,spec['horizon']/self.spec.duration,friction/atr,*common]
                if len(values)!=len(FEATURES) or not all(math.isfinite(v) for v in values):
                    raise ValueError('動作特徵欄位或數值無效')
                vectors[(side,plan)]=(array('f',values),stop,target)
        return vectors


@dataclass(slots=True)
class Action:
    day: str
    time: int
    side: int
    plan: str
    x: array
    stop: int
    target: int
    index: int
    end: int
    start: int
    session: str
    bars: list

    @property
    def key(self):
        return self.time,self.side,self.plan

    @property
    def label_end(self):
        return self.bars[self.end]['time']


def build(data,dates=None):
    diagnostics=quality(data);selected=set(dates if dates is not None else diagnostics['completeDates'])
    session=data['strategySession'];spec=schedule(session)
    if session not in ('regular','afterhours'):
        raise ValueError('請使用完整日／夜盤')
    grouped=defaultdict(list)
    for bar in data['futures']:
        day=opening_date(bar['time'],session)
        if day in selected:
            start=int(spec.window(day)[0].timestamp())
            if start<bar['time']<=start+spec.duration*60:
                grouped[day].append(bar)
    actions=[]
    for day,bars in sorted(grouped.items()):
        start=int(spec.window(day)[0].timestamp());stream=State(start,session,day)
        for i,bar in enumerate(bars):
            vectors=stream.push(bar)
            if vectors is None:
                continue
            for (side,plan),(x,stop,target) in vectors.items():
                end=min(i+PLANS[plan]['horizon'],spec.exit_minute-1,len(bars)-1)
                if end>i:
                    actions.append(Action(day,bar['time'],side,plan,x,stop,target,i,end,start,session,bars))
    return actions,dict(diagnostics,opportunityTimes=len(actions)//4,rawActions=len(actions))


def admission(action,extra=0,delay=0,realized=0):
    first=action.index+1+delay
    if first>action.end:
        return None,'deadline'
    bar=action.bars[first];at=bar['time']-60
    if at>action.start+schedule(action.session).last_entry*60:
        return None,'last_entry'
    slip=COST['slippagePoints']+extra
    entry=bar['open']+action.side*slip
    if abs(entry-action.bars[action.index]['close'])>10:
        return None,'drift'
    stop=entry-action.side*action.stop;target=entry+action.side*action.target
    worst=stop-action.side*slip
    tax=lambda price:futures_tax(price,10,COST['taxRate'])
    if min(entry,stop,target,worst)<=0:
        return None,'price'
    risk=abs(entry-worst)*10+2*COST['feePerSide']+tax(entry)+tax(worst)
    if risk>min(COST['lossLimit'],COST['lossLimit']+realized):
        return None,'risk'
    return dict(first=first,entry=entry,stop=stop,target=target,risk=risk,slip=slip),None


def outcome(action,extra=0,delay=0,realized=0,marks=False):
    admitted,reason=admission(action,extra,delay,realized)
    if admitted is None:
        return None
    side=action.side;entry=admitted['entry'];stop=admitted['stop'];target=admitted['target'];slip=admitted['slip']
    fee=lambda price:COST['feePerSide']+futures_tax(price,10,COST['taxRate'])
    values=[]
    for i in range(admitted['first'],action.end+1):
        bar=action.bars[i]
        stop_hit=side*(bar['low' if side>0 else 'high']-stop)<=0
        target_hit=side*(bar['high' if side>0 else 'low']-target)>=0
        price=None
        if side*(bar['open']-stop)<=0:
            price,reason=bar['open'],'gap_stop'
        elif side*(bar['open']-target)>=0:
            price,reason=target,'target'
        elif stop_hit:
            price,reason=stop,'both_stop_first' if target_hit else 'stop'
        elif target_hit:
            price,reason=target,'target'
        elif i==action.end:
            price,reason=bar['close'],'deadline'
        marked=(bar['close']-entry)*side*10-fee(entry)-fee(bar['close'])
        if price is not None:
            exit_price=price-side*slip
            net=(exit_price-entry)*side*10-fee(entry)-fee(exit_price)
            if marks:
                values.append((bar['time'],net))
            return dict(time=action.time,exitTime=bar['time'],day=action.day,plan=action.plan,
                side='Buy' if side>0 else 'Sell',entry=entry,exit=exit_price,net=net,reason=reason,
                risk=admitted['risk'],marks=values)
        if marks:
            values.append((bar['time'],marked))


def replay(actions,scores,dates,threshold=0.,scope='hybrid',extra=0,delay=0):
    balance=peak=drawdown=0.;day=None;realized=0.;used=set();busy=0;entries=0
    trades=[];funnel=defaultdict(int);by_day=dict.fromkeys(dates,0.)
    grouped=defaultdict(list)
    for action in actions:
        grouped[action.time].append(action)
    for at,group in sorted(grouped.items()):
        if group[0].day!=day:
            day=group[0].day;realized=0.;used=set();busy=0;entries=0
        funnel['opportunityTimes']+=1
        if at<busy:
            funnel['inPosition']+=1;continue
        if entries>=2 or realized<=-1000:
            funnel['sessionBudgetOrCount']+=1;continue
        permitted=[a for a in group if a.plan in SCOPES[scope] and a.side not in used]
        eligible=[a for a in permitted if scores.get(a.key) is not None and scores[a.key]>threshold]
        funnel['aboveThresholdActions']+=len(eligible)
        if not eligible:
            funnel['wait']+=1;continue
        # Sorting reads only t-time scores. Admission uses the incoming quote;
        # a rejected top action skips this minute, never selects by future P&L.
        selected=max(eligible,key=lambda a:(scores[a.key],a.plan=='scalp',a.side>0))
        admitted,rejection=admission(selected,extra,delay,realized)
        if admitted is None:
            funnel['rejected_'+rejection]+=1;continue
        trade=outcome(selected,extra,delay,realized,marks=True)
        for _,value in trade.pop('marks'):
            peak=max(peak,balance+value);drawdown=max(drawdown,peak-balance-value)
        trades.append(trade);balance+=trade['net'];realized+=trade['net']
        by_day[day]+=trade['net'];busy=trade['exitTime'];used.add(selected.side);entries+=1
    won=sum(t['net'] for t in trades if t['net']>0);lost=-sum(t['net'] for t in trades if t['net']<0)
    return dict(count=len(trades),net=balance,maxDrawdown=drawdown,profitFactor=won/lost if lost else None,
        trades=trades,dates=by_day,funnel=dict(funnel),withoutBestDay=balance-max(by_day.values(),default=0),
        byPlan={plan:dict(count=sum(t['plan']==plan for t in trades),net=sum(t['net'] for t in trades if t['plan']==plan)) for plan in PLANS})


def compare(actions,scores,dates,threshold,scope):
    return {name:replay(actions,scores,dates,threshold,scope,extra,delay)
        for name,extra,delay in (('normal',0,0),('stress',2,0),('delayed',0,1))}
