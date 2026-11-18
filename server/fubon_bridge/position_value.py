"""Offline, causally trained continuation values. No order interfaces."""
from collections import Counter, defaultdict
from copy import deepcopy
import math

from .candle_patterns import FEATURES as SHAPES, boundary, oriented, shape
from .confirmed_execution import prepare
from .direction_execution import build as parent_build, choose, outcome as fixed_outcome, rule_scores
from .direction_models import FEATURES as ENTRY_FEATURES, features as entry_features
from .intraday_strategy import futures_tax
from .opportunity_research import COST
from .pattern_transfer import partition, tree
from .research import digest
from .structured_models import PARAMETERS, _comparison_errors, _predict_head, thin
from .strategy_session import schedule

FEATURES=SHAPES+['side','trendPlan','ageMinutes','remainingMinutes','unrealizedR',
    'bestCloseR','worstCloseR','drawdownR','initialRiskAtr','stopDistanceR',
    'targetDistanceR','relativeVolume1','slipPoints']
VARIANTS=('confirmed-fixed','confirmed-learned','paired-fixed','paired-learned')
SCOPES=('hybrid','range','trend')
SCENARIOS=(('normal',0,0),('stress',2,0),('delayed',0,1))
POLICY=dict(version='position-value-v1',features=FEATURES,entryFeatures=ENTRY_FEATURES,
    variants=VARIANTS,filters=['rule','cash','cash-direction'],scopes=SCOPES,
    folds=[.3,.4,.5,.6],parameters=PARAMETERS,rounds=150,minimumAge=6,lossGateR=.25,
    exitBelowNTD=-30.,minimumExitActions=100,minimumExitDays=20,minimumExitStates=500,
    minimumEntryActions=100,minimumEntryDays=20,directionHorizon=5,
    exitUnionDuplicatePriority='paired',directionUnit='signal shape ATR14 simple mean TR',
    target='fixed-baseline net minus next-open close net; one-step policy improvement',
    executionEnabled=False,adoptionAllowed=False)


def policies():
    return {f'{v}-{f}-{s}':dict(variant=v,model=f,scope=s,threshold=0.)
        for v in VARIANTS for f in POLICY['filters'] for s in SCOPES}


def build(data,dates):
    previous,quality=parent_build(data,dates)
    return {v:previous[v.replace('learned','fixed')] for v in VARIANTS},quality


def cash(entry,price,side,slip):
    exit_price=price-side*slip
    return ((exit_price-entry)*side*10-40-futures_tax(entry,10,COST['taxRate'])
        -futures_tax(exit_price,10,COST['taxRate']))


def states(action,extra=0,delay=0,cache=None):
    """Visit only surviving closes. Future cash labels are attached elsewhere."""
    changed,fill,_=prepare(action,extra,delay)
    if fill is None:
        return []
    cache={} if cache is None else cache
    side=action.side;entry=fill['entry'];risk=changed.stop;best=worst=0.;rows=[]
    for i in range(fill['first'],action.end+1):
        b=action.bars[i]
        if (side*(b['open']-fill['stop'])<=0 or side*(b['open']-fill['target'])>=0
            or side*(b['low' if side>0 else 'high']-fill['stop'])<=0
            or side*(b['high' if side>0 else 'low']-fill['target'])>=0 or i==action.end):
            break
        progress=side*(b['close']-entry)/risk;best=max(best,progress);worst=min(worst,progress)
        age=i-fill['first']+1
        if age<6 or (b['time']-action.start)//60%3 or progress>-.25:
            continue
        key=(action.session,b['time'])
        if key not in cache:
            cache[key]=shape(action.bars,i,action.start)
        shaped=cache[key]
        if shaped is None:
            raise ValueError('持倉缺少連續且已完成型態')
        geometry,atr=shaped;history=action.bars[i-20:i]
        volume=sum(r['volume'] for r in history)/20
        x=oriented(geometry,side)+[side,float(action.plan=='trend'),age,action.end-i,
            progress,best,worst,best-progress,risk/atr,
            side*(b['close']-fill['stop'])/risk,side*(fill['target']-b['close'])/risk,
            b['volume']/volume if volume else 0.,fill['slip']]
        if len(x)!=len(FEATURES) or not all(math.isfinite(v) for v in x):
            raise ValueError('持倉特徵不完整或含非有限值')
        rows.append(dict(index=i,time=b['time'],x=x))
    return rows


def fit_exit(events,dates,cutoff):
    import numpy as np
    allowed=set(dates);selected=thin([a for a in {a.key:a for a in events}.values()
        if a.day in allowed and a.label_end<cutoff])
    groups=[];cache={}
    for a in selected:
        scenarios=[]
        for name,extra,delay in SCENARIOS:
            rows=states(a,extra,delay,cache)
            if not rows:
                continue
            baseline=fixed_outcome(a,extra,delay);_,fill,_=prepare(a,extra,delay)
            for row in rows:
                row['target']=baseline['net']-cash(fill['entry'],a.bars[row['index']+1]['open'],a.side,fill['slip'])
            scenarios.append((name,rows))
        if scenarios:
            groups.append((a,scenarios))
    counts=Counter(a.day for a,_ in groups);n=sum(len(rows) for _,ss in groups for _,rows in ss)
    metadata=dict(fitDates=dates,cutoff=cutoff,actions=len(groups),days=len(counts),states=n,
        maximumLabelEnd=max((a.label_end for a,_ in groups),default=None),
        maximumStateTime=max((r['time'] for _,ss in groups for _,rows in ss for r in rows),default=None),
        scenarioCounts={name:sum(len(rows) for _,ss in groups for s,rows in ss if s==name) for name,_,_ in SCENARIOS})
    if len(groups)<100 or len(counts)<20 or n<500:
        return None,metadata|dict(reason='退出訓練少於100動作／20日／500狀態')
    x=[];y=[];w=[]
    for a,ss in groups:
        for _,rows in ss:
            for r in rows:
                x.append(r['x']);y.append(r['target']);w.append(n/len(counts)/counts[a.day]/len(ss)/len(rows))
    model=dict(kind='position_value',version=1,features=FEATURES,targetUnit='NTD',
        head=tree(np.asarray(x),np.asarray(y),np.asarray(w),FEATURES,PARAMETERS))
    metadata['modelHash']=digest(model)
    return model,metadata


class ExitEngine:
    def __init__(self,model):
        self.model=model;self.cache={};self.results={}
        if model is not None and (model.get('kind')!='position_value' or model.get('version')!=1
            or model.get('features')!=FEATURES or model.get('targetUnit')!='NTD'):
            raise ValueError('持倉模型或單位無效')
        self.booster=None
        if model is not None and model['head']['kind']=='tree':
            import lightgbm as lgb
            self.booster=lgb.Booster(model_str=model['head']['text'])

    def outcome(self,a,extra=0,delay=0,realized=0,marks=False,learned=True):
        if not learned:
            return fixed_outcome(a,extra,delay,realized,marks)
        if self.model is None:
            return None
        _,fill,_=prepare(a,extra,delay,realized)
        if fill is None:
            return None
        key=(a.session,a.source,a.key,a.stop_level,a.target_level,a.end,extra,delay)
        if key not in self.results:
            import numpy as np
            baseline=fixed_outcome(a,extra,delay,marks=True);rows=states(a,extra,delay,self.cache)
            x=np.asarray([r['x'] for r in rows])
            values=(self.booster.predict(x,num_threads=2) if self.booster is not None else _predict_head(self.model['head'],x)) if rows else []
            if not np.isfinite(values).all():
                raise ValueError('持倉預測無效')
            selected=next(((r,float(v)) for r,v in zip(rows,values,strict=True) if v<-30.),None)
            result=baseline
            if selected:
                row,value=selected;price=a.bars[row['index']+1]['open'];at=row['time']
                net=cash(fill['entry'],price,a.side,fill['slip'])
                result=baseline|dict(exitTime=at,exit=price-a.side*fill['slip'],net=net,reason='negative_continuation',
                    continuationValue=value,decisionTime=at,
                    marks=baseline['marks'][:row['index']-fill['first']+1]+[(at,net)])
            self.results[key]=result
        result=deepcopy(self.results[key])
        if not marks:
            result['marks']=[]
        return result


def fit_entry(events,dates,session,auxiliary,aux_meta,shapes,engine,learned):
    import numpy as np
    early,fit_dates,calibration=partition(dates);cutoff=boundary(fit_dates[0])
    cal_start=int(schedule(session).window(calibration[0])[0].timestamp())
    if aux_meta['cutoff']!=cutoff or (aux_meta.get('maximumLabelEnd') is not None and aux_meta['maximumLabelEnd']>=cutoff):
        raise ValueError('輔助標籤越過退出／進場隔離截止')
    allowed=set(fit_dates);selected=thin([a for a in events if a.day in allowed and a.label_end<cal_start
        and a.end>=a.index+5])
    metadata=dict(exitDates=early,fitDates=fit_dates,calibrationDates=calibration,auxiliary=aux_meta,
        globalCutoff=cutoff,calibrationStart=cal_start,fitActions=len(selected),fitDays=len({a.day for a in selected}),
        maximumLabelEnd=max((a.label_end for a in selected),default=None),learnedExit=learned)
    if auxiliary is None or (learned and engine.model is None) or len(selected)<100 or len({a.day for a in selected})<20:
        return None,metadata|dict(reason='缺少有效aux／exit模型或入場fit少於100動作／20日')
    raw=np.asarray([shapes[a.key][0] for a in selected]);aux=_predict_head(auxiliary,raw)
    x=entry_features(selected,shapes,{a.key:float(v) for a,v in zip(selected,aux,strict=True)})
    counts=Counter(a.day for a in selected);w=np.asarray([len(selected)/len(counts)/counts[a.day] for a in selected])
    heads={}
    for name,extra,delay in SCENARIOS:
        trades=[engine.outcome(a,extra,delay,learned=learned) for a in selected]
        y=np.asarray([t['net'] if t else 0. for t in trades])
        heads[name]=tree(x,y,w,ENTRY_FEATURES,PARAMETERS)
    directions=np.asarray([a.side*(a.bars[a.index+5]['close']-a.bars[a.index+1]['open'])/shapes[a.key][1] for a in selected])
    heads['direction5']=tree(x,directions,w,ENTRY_FEATURES,PARAMETERS)
    model=dict(kind='position_entry',version=1,features=ENTRY_FEATURES,targetUnit='NTD',directionUnit='ATR1',
        auxiliary=auxiliary,heads=heads,learnedExit=learned,exitHash=digest(engine.model) if learned else None)
    return model,metadata|dict(modelHash=digest(model))


def predict(model,events,shapes):
    import numpy as np
    if model is None:
        return {a.key:None for a in events},{a.key:None for a in events}
    if (model.get('kind')!='position_entry' or model.get('version')!=1 or model.get('features')!=ENTRY_FEATURES
        or model.get('targetUnit')!='NTD' or model.get('directionUnit')!='ATR1'
        or set(model['heads'])!={'normal','stress','delayed','direction5'} or len({a.key for a in events})!=len(events)):
        raise ValueError('持倉版進場模型或單位無效')
    if not events:
        return {},{}
    aux=_predict_head(model['auxiliary'],np.asarray([shapes[a.key][0] for a in events]))
    x=entry_features(events,shapes,{a.key:float(v) for a,v in zip(events,aux,strict=True)})
    values=np.min([_predict_head(model['heads'][s],x) for s,_,_ in SCENARIOS],axis=0)
    direction=_predict_head(model['heads']['direction5'],x)
    if not np.isfinite(values).all() or not np.isfinite(direction).all():
        raise ValueError('進場金額或方向預測無效')
    return ({a.key:float(v) for a,v in zip(events,values,strict=True)},
        {a.key:float(v) for a,v in zip(events,direction,strict=True)})


def replay(events,scores,dates,engine,learned=False,scope='hybrid',directions=None,extra=0,delay=0,enabled=True):
    balance=peak=dd=0.;trades=[];by_day=dict.fromkeys(dates,0.);funnel=defaultdict(int);groups=defaultdict(list)
    for a in events:
        groups[a.time].append(a)
    day=None;used=set();busy=entries=0;realized=0.
    for at,group in sorted(groups.items()):
        if group[0].day!=day:
            day=group[0].day;used=set();busy=entries=0;realized=0.
        funnel['signalTimes']+=1
        if not enabled or (learned and engine.model is None):
            funnel['calibrationBlocked']+=1;continue
        if at<busy or entries>=2 or realized<=-1000:
            funnel['positionOrBudget']+=1;continue
        selected,reason=choose(group,scores,scope,0.,used)
        if selected is None:
            funnel['noPositiveScore' if group[0].source=='confirmed' else reason]+=1;continue
        if directions is not None and (directions.get(selected.key) is None or not math.isfinite(directions[selected.key]) or directions[selected.key]<=0):
            funnel['directionRejected']+=1;continue
        _,fill,reason=prepare(selected,extra,delay,realized)
        if fill is None:
            funnel['rejected_'+reason]+=1;continue
        t=engine.outcome(selected,extra,delay,realized,marks=True,learned=learned)
        for _,value in t.pop('marks'):
            peak=max(peak,balance+value);dd=max(dd,peak-balance-value)
        t.update(score=scores[selected.key],direction5=directions[selected.key] if directions is not None else None,
            plannedRisk=selected.planned_risk,signalClose=selected.bars[selected.index]['close'],targetLevel=selected.target_level)
        trades.append(t);balance+=t['net'];by_day[day]+=t['net'];realized+=t['net'];busy=t['exitTime'];entries+=1;used.add(selected.side)
    return dict(count=len(trades),net=balance,maxDrawdown=dd,trades=trades,dates=by_day,
        withoutBestDay=balance-max(by_day.values(),default=0),funnel=dict(funnel),
        byPlan={p:dict(count=sum(t['plan']==p for t in trades),net=sum(t['net'] for t in trades if t['plan']==p)) for p in ('range','trend')})


def compare(events,scores,dates,engine,variant,scope,directions=None,enabled=True):
    return {name:replay(events,scores,dates,engine,variant.endswith('learned'),scope,directions,extra,delay,enabled)
        for name,extra,delay in SCENARIOS}


def select(trials):
    rankings=[]
    for name,spec in policies().items():
        folds=trials.get(name,{}).get('folds',[]);reasons=[]
        if len(folds)!=3:
            reasons.append('缺少三個發展折')
        for i,fold in enumerate(folds,1):
            if fold.get('calibration',{}).get('passed') is not True:
                reasons.append(f'fold{i}:校準未通過')
            reasons += [f'fold{i}:{r}' for r in _comparison_errors(fold.get('guarded'),spec['scope'],30,None)]
        rankable=len(folds)==3 and all(not _comparison_errors(f.get('guarded'),spec['scope'],0,None) for f in folds)
        stress=[f['guarded']['stress'] for f in folds] if rankable else []
        if rankable:
            plans=('range','trend') if spec['scope']=='hybrid' else (spec['scope'],)
            for plan in plans:
                if sum(s['byPlan'][plan]['count'] for s in stress)<20 or sum(s['byPlan'][plan]['net'] for s in stress)<=0:
                    reasons.append(f'{plan}:壓力分支不足20筆或未獲利')
        rankings.append(dict(name=name,eligible=not reasons,reasons=reasons,
            worstStress=min((s['net'] for s in stress),default=None),stressNet=sum(s['net'] for s in stress) if stress else None))
    rankings.sort(key=lambda r:(r['eligible'],r['worstStress'] if r['worstStress'] is not None else -math.inf,
        r['stressNet'] if r['stressNet'] is not None else -math.inf),reverse=True)
    qualified=[r for r in rankings if r['eligible']]
    return dict(selected=qualified[0]['name'] if qualified else None,eligibleCount=len(qualified),rankings=rankings,
        evaluationUsed=False,executionEnabled=False,adoptionAllowed=False)
