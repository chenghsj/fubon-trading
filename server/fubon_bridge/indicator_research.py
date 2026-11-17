"""Paired indicator ablations on an unchanged, research-only V3 event universe."""
from collections import defaultdict
import hashlib
import math
from statistics import mean, pstdev

from .learning_features import outcome
from .regime_refinement import BASELINE, CONFIG, accepted_events
from .regime_refinement_model import PARAMETERS, ROUNDS, THRESHOLDS
from .regime_strategy import FEATURES
from .strategy_session import opening_date, schedule

GROUPS = dict(macd=[f'm{minutes}Macd{name}Atr' for minutes in (1,3)
        for name in ('Line','Signal','Histogram','HistogramChange')],
    rsi=[f'm{minutes}Rsi{name}' for minutes in (1,3) for name in ('Level','Change')],
    kd=[f'm{minutes}Kd{name}' for minutes in (1,3) for name in ('Level','Spread','Change')],
    bands=['m3BollingerZ','m3BollingerWidthAtr','m3BollingerWidthChangeAtr'],
    adx=['m3Adx','m3DiAlignment','m3AdxChange'],
    vwap=['sessionVwapDistanceAtr','sessionVwapSlopeAtr'])
FEATURE_SETS = dict(base28=FEATURES, **{f'{name}{28+len(values)}':FEATURES+values for name,values in GROUPS.items()},
    rsi_kd38=FEATURES+GROUPS['rsi']+GROUPS['kd'],
    all54=FEATURES+[name for values in GROUPS.values() for name in values])
POLICY = dict(protocol='paired-indicator-ablation-v1', rule='original_v3',
    featureSets=FEATURE_SETS, parameters=PARAMETERS, rounds=ROUNDS,
    thresholds=list(THRESHOLDS), macd=dict(fast=12,slow=26,signal=9,
        seed='aligned 26-bar SMA slow / trailing 12-bar SMA fast; first 9 MACD lines seed signal',
        normalization='signal-time prior completed 3m Wilder ATR',completedOnly=True,
        sessionReset=True,histogramChangeMinimumCandles=35,timeframes=[1,3]),
    rsi=dict(period=14,method='wilder',flatValue=50,timeframes=[1,3]),
    kd=dict(rsvPeriod=9,kSmoothing=3,dSmoothing=3,method='recursive',
        initialK=50,initialD=50,flatRsv=50,timeframes=[1,3]),
    bands=dict(period=20,deviations=2,standardDeviation='population',timeframe=3),
    adx=dict(period=14,method='wilder',timeframe=3),
    vwap=dict(price='minute (high+low+close)/3',volume='minute volume',
        reset='session opening date',slopeMinutes=3,tradeLevelExact=False),
    folds=[.3,.4,.5,.6], selectionUsesFinalEvaluation=False,
    pairedUniverse=True, executionEnabled=False,adoptionAllowed=False)


class Macd:
    """12/26/9 EMA, aligned SMA initialization, complete candles only."""
    def __init__(self):
        self.initial=[]
        self.lines=[]
        self.fast=self.slow=self.signal=self.histogram=None

    def push(self, price):
        if not isinstance(price,(int,float)) or not math.isfinite(price) or price<=0:
            raise ValueError('MACD需要有效的已收盤價格')
        if self.slow is None:
            self.initial.append(price)
            if len(self.initial)<26:
                return None
            self.slow=sum(self.initial)/26
            self.fast=sum(self.initial[-12:])/12
        else:
            self.fast+=(price-self.fast)*2/13
            self.slow+=(price-self.slow)*2/27
        line=self.fast-self.slow
        if self.signal is None:
            self.lines.append(line)
            if len(self.lines)<9:
                return None
            self.signal=sum(self.lines)/9
        else:
            self.signal+=(line-self.signal)*2/10
        histogram=line-self.signal
        change=None if self.histogram is None else histogram-self.histogram
        self.histogram=histogram
        return line,self.signal,histogram,change


class Rsi:
    def __init__(self):
        self.previous=self.up=self.down=self.value=None
        self.moves=[]

    def push(self,price):
        if self.previous is None:
            self.previous=price
            return None
        move=price-self.previous
        self.previous=price
        gain,loss=max(0,move),max(0,-move)
        if self.up is None:
            self.moves.append((gain,loss))
            if len(self.moves)<14:
                return None
            self.up=sum(g for g,_ in self.moves)/14
            self.down=sum(l for _,l in self.moves)/14
        else:
            self.up=(13*self.up+gain)/14
            self.down=(13*self.down+loss)/14
        value=50. if self.up==self.down==0 else 100*self.up/(self.up+self.down)
        change=None if self.value is None else value-self.value
        self.value=value
        return value,change


class Adx:
    def __init__(self):
        self.previous=None
        self.seed=[]
        self.dx=[]
        self.tr=self.plus=self.minus=self.value=None

    def push(self,bar):
        previous=self.previous
        self.previous=bar
        if previous is None:
            return None
        up=bar['high']-previous['high'];down=previous['low']-bar['low']
        plus=up if up>down and up>0 else 0.
        minus=down if down>up and down>0 else 0.
        tr=max(bar['high']-bar['low'],abs(bar['high']-previous['close']),abs(bar['low']-previous['close']))
        if self.tr is None:
            self.seed.append((tr,plus,minus))
            if len(self.seed)<14:
                return None
            self.tr,self.plus,self.minus=(sum(r[i] for r in self.seed) for i in range(3))
        else:
            self.tr=self.tr-self.tr/14+tr
            self.plus=self.plus-self.plus/14+plus
            self.minus=self.minus-self.minus/14+minus
        di_plus=100*self.plus/self.tr if self.tr else 0.
        di_minus=100*self.minus/self.tr if self.tr else 0.
        dx=100*abs(di_plus-di_minus)/(di_plus+di_minus) if di_plus+di_minus else 0.
        if self.value is None:
            self.dx.append(dx)
            if len(self.dx)<14:
                return None
            value=mean(self.dx)
            change=None
        else:
            value=(13*self.value+dx)/14
            change=value-self.value
        self.value=value
        return value,di_plus-di_minus,change


class Kd:
    def __init__(self):
        self.bars=[]
        self.k=self.d=50.
        self.ready=False

    def push(self,bar):
        self.bars.append(bar)
        self.bars=self.bars[-9:]
        if len(self.bars)<9:
            return None
        high=max(b['high'] for b in self.bars)
        low=min(b['low'] for b in self.bars)
        rsv=100*(bar['close']-low)/(high-low) if high>low else 50.
        old=self.k
        self.k=(2*self.k+rsv)/3
        self.d=(2*self.d+self.k)/3
        change=self.k-old if self.ready else None
        self.ready=True
        return self.k,self.k-self.d,change


def augment(data,events,dates):
    """Append causal indicators; reject instead of changing either event sample."""
    wanted={e['time']:e for e in events}
    selected=set(dates)
    grouped=defaultdict(list)
    spec=schedule(data['strategySession'])
    for bar in data['futures']:
        day=opening_date(bar['time'],data['strategySession'])
        if day in selected:
            start=int(spec.window(day)[0].timestamp())
            if start<bar['time']<=start+spec.duration*60:
                grouped[day].append(bar)
    output={name:[] for name in FEATURE_SETS}
    for day, bars in sorted(grouped.items()):
        one,three=Macd(),Macd()
        rsi_one,rsi_three,adx=Rsi(),Rsi(),Adx()
        kd_one,kd_three=Kd(),Kd()
        context=None
        rsi_context=adx_context=bands_context=None
        kd_context=None
        closes=[];previous_width=None
        notional=volume=0.
        vwaps=[]
        for i,bar in enumerate(bars):
            current=one.push(bar['close'])
            rsi_current=rsi_one.push(bar['close'])
            kd_current=kd_one.push(bar)
            notional+=(bar['high']+bar['low']+bar['close'])/3*bar['volume']
            volume+=bar['volume']
            vwaps.append(notional/volume if volume else None)
            if (i+1)%3==0:
                context=three.push(bar['close'])
                rsi_context=rsi_three.push(bar['close'])
                rows=bars[i-2:i+1]
                candle=dict(high=max(b['high'] for b in rows),low=min(b['low'] for b in rows),close=bar['close'])
                adx_context=adx.push(candle)
                kd_context=kd_three.push(candle)
                closes.append(bar['close'])
                if len(closes)>=20:
                    center=mean(closes[-20:]);deviation=pstdev(closes[-20:])
                    width=4*deviation
                    bands_context=((bar['close']-center)/deviation if deviation else 0.,width,
                        None if previous_width is None else width-previous_width)
                    previous_width=width
            event=wanted.get(bar['time'])
            if event is None:
                continue
            values=(current,context,rsi_current,rsi_context,adx_context,bands_context,kd_current,kd_context)
            if any(value is None or value[-1] is None for value in values) or len(vwaps)<4 or vwaps[-1] is None or vwaps[-4] is None:
                raise ValueError('指標尚未暖身或缺量；拒絕改變配對比較的事件集合')
            side=1 if event['side']=='Buy' else -1
            atr=event['signal']['atr']
            groups=dict(macd=[side*v/atr for series in (current,context) for v in series],
                rsi=[v for level,change in (rsi_current,rsi_context) for v in (side*(level-50)/50,side*change/100)],
                kd=[v for level,spread,change in (kd_current,kd_context) for v in (side*(level-50)/50,side*spread/100,side*change/100)],
                bands=[side*bands_context[0],bands_context[1]/atr,bands_context[2]/atr],
                adx=[adx_context[0]/100,side*adx_context[1]/100,adx_context[2]/100],
                vwap=[side*(bar['close']-vwaps[-1])/atr,side*(vwaps[-1]-vwaps[-4])/atr])
            extra=[v for group in groups.values() for v in group]
            if not all(math.isfinite(value) for value in extra):
                raise ValueError('指標特徵數值無效')
            output['base28'].append(event)
            for name,group in groups.items():
                output[f'{name}{28+len(group)}'].append(event | dict(x=event['x']+group))
            output['rsi_kd38'].append(event | dict(x=event['x']+groups['rsi']+groups['kd']))
            output['all54'].append(event | dict(x=event['x']+extra))
    if any(len(rows)!=len(events) for rows in output.values()):
        raise ValueError('指標配對事件集合不一致')
    return output


def fit(events,feature_set):
    import lightgbm as lgb
    import numpy as np
    names=FEATURE_SETS[feature_set]
    rows=[(e,outcome(e,CONFIG)) for e in accepted_events(events,BASELINE)]
    rows=[(e,r) for e,r in rows if r is not None]
    if len(rows)<60:
        return None,len(rows)
    training=lgb.Dataset(np.asarray([e['x'] for e,_ in rows],dtype=float),
        label=[r['net'] for _,r in rows],feature_name=names)
    return lgb.train(PARAMETERS,training,num_boost_round=ROUNDS),len(rows)


def select(thresholds):
    rankings=[]
    for threshold in THRESHOLDS:
        folds=thresholds[str(threshold)]['folds']
        normal,stress=[f['normal'] for f in folds],[f['stress'] for f in folds]
        branches={regime:dict(count=sum(f['byRegime'][regime]['count'] for f in stress),
            net=sum(f['byRegime'][regime]['net'] for f in stress)) for regime in ('range','trend')}
        eligible=all(n['count']>=20 and n['net']>0 and s['net']>0 and f['delayed']['net']>0
            for n,s,f in zip(normal,stress,folds)) and all(b['count']>=15 and b['net']>0 for b in branches.values())
        rankings.append(dict(threshold=threshold,eligible=eligible,branches=branches,
            worstFoldStressNet=min(f['net'] for f in stress),
            score=sum(f['net'] for f in stress)-.5*max(f['maxDrawdown'] for f in normal)))
    chosen=max(rankings,key=lambda r:(r['eligible'],r['worstFoldStressNet'],r['score']))
    return dict(chosen=chosen,rankings=rankings,eligible=chosen['eligible'],
        executionEnabled=False,adoptionAllowed=False,evaluationUsed=False)


def model_info(model,feature_set):
    if model is None:
        return None
    text=model.model_to_string()
    return dict(hash=hashlib.sha256(text.encode()).hexdigest(),bytes=len(text.encode()),
        splitCount=int(model.feature_importance(importance_type='split').sum()),
        importance=dict(zip(FEATURE_SETS[feature_set],[float(v) for v in model.feature_importance(importance_type='gain')])))
