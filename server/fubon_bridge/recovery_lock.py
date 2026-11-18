"""Offline recovery-distribution estimates, chronological stacking and entry locks."""
from array import array
from collections import Counter, defaultdict
import math

from .candle_patterns import boundary
from .confirmed_execution import prepare
from .direction_execution import choose, outcome as fixed_outcome, rule_scores
from .direction_models import FEATURES as ENTRY_FEATURES, features as entry_features
from .pattern_transfer import tree
from .position_value import FEATURES as BASE_FEATURES, SCENARIOS, cash, states
from .research import digest
from .structured_models import PARAMETERS, _comparison_errors, _predict_head, thin
from .strategy_session import schedule

FEATURES=BASE_FEATURES+['sessionFraction','efficiency15','signedMove15Atr','signedMean15Atr',
    'signedClosedMove3Atr','signedMove3R','relativeVolume3']
FAMILIES=('fixed','mean','protected')
VARIANTS=tuple(f'{s}-{f}' for s in ('confirmed','paired') for f in FAMILIES)
PROTECTED_PARAMETERS=PARAMETERS|dict(num_leaves=15,max_depth=4,min_data_in_leaf=100)
POLICY=dict(version='recovery-lock-v1',features=FEATURES,entryFeatures=ENTRY_FEATURES,
    warmupDays=40,blockDays=40,recentExitDays=120,fitFraction=.8,folds=[.3,.4,.5,.6],
    families=FAMILIES,variants=VARIANTS,entryFilters=['rule','cash'],reentry=['free','lock'],scope='hybrid',
    exitBelowNTD=-30.,maximumRecoveryProbability=.25,protectedConsecutiveCloses=2,
    meanParameters=PARAMETERS,protectedParameters=PROTECTED_PARAMETERS,rounds=150,
    minimumActions=100,minimumDays=20,minimumStates=500,minimumConditionalStates=200,
    auxiliaryWindow='expanding label_end before cutoff; only exit uses recent 120 completed candidate days',
    duplicatePriority='paired',probabilityCalibrated=False,executionEnabled=False,adoptionAllowed=False)


def policies():
    return {f'{v}-{e}-{r}':dict(variant=v,model=e,reentry=r,scope='hybrid')
        for v in VARIANTS for e in POLICY['entryFilters'] for r in POLICY['reentry']}


def extend(a,row,extra,delay,cache):
    i=row['index'];b=a.bars[i];elapsed=(b['time']-a.start)//60
    last15=i-elapsed%15
    if last15-75<0:
        raise ValueError('回升模型15m暖身不足')
    closes=[a.bars[last15-j*15]['close'] for j in range(5,-1,-1)]
    path=sum(abs(v-u) for u,v in zip(closes,closes[1:]));move=closes[-1]-closes[0]
    atr=cache[a.session,b['time']][1];last3=i-elapsed%3
    changed,_,_=prepare(a,extra,delay)
    prior=sum(t['volume'] for t in a.bars[i-22:i-2])/20
    current=sum(t['volume'] for t in a.bars[i-2:i+1])/3
    x=list(row['x'])+[elapsed/schedule(a.session).duration,abs(move)/path if path else 0.,
        a.side*move/atr,a.side*(closes[-1]-sum(closes)/6)/atr,
        a.side*(a.bars[last3]['close']-a.bars[last3-3]['close'])/atr,
        a.side*(b['close']-a.bars[i-3]['close'])/changed.stop,current/prior if prior else 0.]
    if len(x)!=83 or not all(math.isfinite(v) for v in x):
        raise ValueError('回升狀態特徵無效')
    return x


class ExitBank:
    def __init__(self,events,identity):
        self.events=list({a.key:a for a in events}.values());self.identity=digest(identity)
        self.records={};self.groups={};self.shapes={};self.engines={}

    def group(self,a):
        key=(a.source,a.key,a.stop_level,a.target_level,a.end)
        if key not in self.groups:
            ss=[]
            for name,extra,delay in SCENARIOS:
                rows=states(a,extra,delay,self.shapes)
                if not rows:
                    continue
                baseline=fixed_outcome(a,extra,delay);_,fill,_=prepare(a,extra,delay)
                ss.append((name,[(array('d',extend(a,r,extra,delay,self.shapes)),
                    baseline['net']-cash(fill['entry'],a.bars[r['index']+1]['open'],a.side,fill['slip']),r['time']) for r in rows]))
            self.groups[key]=ss
        return self.groups[key]

    def get(self,cutoff):
        if cutoff not in self.records:
            known=[a for a in self.events if a.label_end<cutoff]
            dates=sorted({a.day for a in known})[-120:];allowed=set(dates)
            selected=thin([a for a in known if a.day in allowed])
            groups=[(a,self.group(a)) for a in selected];groups=[(a,ss) for a,ss in groups if ss]
            models,metadata=fit_groups(groups,dates,cutoff)
            self.records[cutoff]=dict(cutoff=cutoff,identity=self.identity,models=models,metadata=metadata,
                hashes={f:digest(m) for f,m in models.items()})
        return self.records[cutoff]

    def engine(self,cutoff,family):
        if family=='fixed':
            return RecoveryEngine(None,'fixed')
        key=(cutoff,family)
        if key not in self.engines:
            self.engines[key]=RecoveryEngine(self.get(cutoff)['models'][family],family)
        return self.engines[key]


def fit_groups(groups,dates,cutoff):
    import numpy as np
    allowed=set(dates)
    if any(a.day not in allowed or a.label_end>=cutoff or any(r[2]>=cutoff for _,rows in ss for r in rows) for a,ss in groups):
        raise ValueError('退出訓練標籤或狀態越過截止')
    counts=Counter(a.day for a,_ in groups);n=sum(len(rows) for _,ss in groups for _,rows in ss)
    meta=dict(fitDates=dates,cutoff=cutoff,actions=len(groups),days=len(counts),states=n,
        maximumLabelEnd=max((a.label_end for a,_ in groups),default=None),
        maximumStateTime=max((r[2] for _,ss in groups for _,rows in ss for r in rows),default=None),
        scenarioCounts={s:sum(len(rows) for _,ss in groups for name,rows in ss if name==s) for s,_,_ in SCENARIOS})
    if len(groups)<100 or len(counts)<20 or n<500:
        return dict(mean=None,protected=None),meta|dict(reason='退出fit少於100動作／20日／500狀態')
    x=[];y=[];weights=[];day_labels=[]
    for a,ss in groups:
        for _,rows in ss:
            for features,value,_ in rows:
                x.append(features);y.append(value);day_labels.append(a.day)
                weights.append(n/len(counts)/counts[a.day]/len(ss)/len(rows))
    x=np.asarray(x);y=np.asarray(y);w=np.asarray(weights);positive=y>0
    meta['positiveStates']=int(positive.sum());meta['nonpositiveStates']=int((~positive).sum())
    meta['positiveDays']=len({d for d,p in zip(day_labels,positive,strict=True) if p})
    meta['nonpositiveDays']=len({d for d,p in zip(day_labels,positive,strict=True) if not p})
    mean_model=dict(kind='recovery_exit',version=1,family='mean',features=BASE_FEATURES,targetUnit='NTD',
        heads=dict(mean=tree(x[:,:76],y,w,BASE_FEATURES,PARAMETERS)))
    protected=None
    if min(meta['positiveStates'],meta['nonpositiveStates'])>=200 and min(meta['positiveDays'],meta['nonpositiveDays'])>=20:
        heads=dict(probability=tree(x,positive.astype(float),w,FEATURES,
            PROTECTED_PARAMETERS|dict(objective='binary',metric='binary_logloss')))
        for name,mask,sign in (('gain',positive,1),('loss',~positive,-1)):
            conditional=w[mask];conditional=conditional*int(mask.sum())/conditional.sum()
            heads[name]=tree(x[mask],sign*y[mask],conditional,FEATURES,PROTECTED_PARAMETERS)
        protected=dict(kind='recovery_exit',version=1,family='protected',features=FEATURES,targetUnit='NTD',heads=heads)
    else:
        meta['protectedMissingReason']='正／非正條件子集少於200狀態或20日'
    return dict(mean=mean_model,protected=protected),meta


class RecoveryEngine:
    def __init__(self,model,family):
        if family not in FAMILIES:
            raise ValueError('未知回升退出方式')
        self.model=model;self.family=family;self.cache={};self.results={};self.boosters={}
        if model is not None:
            names=BASE_FEATURES if family=='mean' else FEATURES
            expected={'mean'} if family=='mean' else {'probability','gain','loss'}
            if (family=='fixed' or model.get('kind')!='recovery_exit' or model.get('version')!=1
                or model.get('family')!=family or model.get('features')!=names or model.get('targetUnit')!='NTD'
                or set(model['heads'])!=expected):
                raise ValueError('回升退出模型、特徵或單位無效')
            import lightgbm as lgb
            self.boosters={k:lgb.Booster(model_str=h['text']) for k,h in model['heads'].items() if h['kind']=='tree'}

    def values(self,a,rows,extra=0,delay=0):
        import numpy as np
        if not rows:
            return [],[]
        if self.model is None:
            raise ValueError('缺少回升模型')
        x=np.asarray([r['x'] if self.family=='mean' else extend(a,r,extra,delay,self.cache) for r in rows])
        values={k:(self.boosters[k].predict(x,num_threads=2) if k in self.boosters else _predict_head(h,x))
            for k,h in self.model['heads'].items()}
        if any(not np.isfinite(v).all() for v in values.values()):
            raise ValueError('回升預測無效')
        if self.family=='mean':
            return values['mean'],[None]*len(rows)
        probability=values['probability']
        if np.any((probability<0)|(probability>1)):
            raise ValueError('回升機率越界')
        advantage=probability*np.maximum(0,values['gain'])-(1-probability)*np.maximum(0,values['loss'])
        return advantage,probability

    def decision(self,a,extra=0,delay=0):
        rows=states(a,extra,delay,self.cache);values,probability=self.values(a,rows,extra,delay)
        previous=None;streak=0
        for r,v,p in zip(rows,values,probability,strict=True):
            allowed=v<-30 and (self.family=='mean' or p<=.25)
            streak=(streak+1 if previous is not None and r['time']-previous==180 else 1) if allowed else 0
            previous=r['time']
            if streak>=(1 if self.family=='mean' else 2):
                return r,float(v),None if p is None else float(p)
        return None

    def outcome(self,a,extra=0,delay=0,realized=0,marks=False):
        if self.family=='fixed':
            return fixed_outcome(a,extra,delay,realized,marks)
        if self.model is None:
            return None
        _,fill,_=prepare(a,extra,delay,realized)
        if fill is None:
            return None
        key=(a.session,a.source,a.key,a.stop_level,a.target_level,a.end,extra,delay)
        if key not in self.results:
            baseline=fixed_outcome(a,extra,delay);selected=self.decision(a,extra,delay)
            if selected:
                r,v,p=selected;price=a.bars[r['index']+1]['open'];net=cash(fill['entry'],price,a.side,fill['slip'])
                baseline=baseline|dict(exitTime=r['time'],exit=price-a.side*fill['slip'],net=net,
                    reason='negative_continuation' if self.family=='mean' else 'protected_continuation',
                    continuationValue=v,decisionTime=r['time'])
                if self.family=='protected':
                    baseline['recoveryProbability']=p
            self.results[key]=(baseline,selected[0]['index'] if selected else None)
        stored,index=self.results[key];result=stored|dict(marks=[])
        if marks:
            original=fixed_outcome(a,extra,delay,marks=True)
            result['marks']=original['marks'] if index is None else original['marks'][:index-fill['first']+1]+[(result['exitTime'],result['net'])]
        return result


def fit_entry(events,dates,session,variant,exit_bank,aux_bank,shapes):
    import numpy as np
    end=int(len(dates)*.8);fit_dates=dates[40:end];calibration=dates[end:]
    if not fit_dates or not calibration:
        raise ValueError('滾動訓練日期不足')
    family=variant.split('-')[1];cal_start=int(schedule(session).window(calibration[0])[0].timestamp())
    allowed_dates=set(fit_dates)
    selected=thin([a for a in events if a.day in allowed_dates and a.label_end<cal_start])
    values={};engines={};blocks=[]
    for i in range(0,len(fit_dates),40):
        days=fit_dates[i:i+40];cutoff=boundary(days[0]);allowed=set(days);chosen=[a for a in selected if a.day in allowed]
        aux,record=aux_bank.transform(chosen,shapes,cutoff);engine=exit_bank.engine(cutoff,family)
        info=record['metadata']
        if info['cutoff']!=cutoff or (info.get('maximumLabelEnd') is not None and info['maximumLabelEnd']>=cutoff):
            raise ValueError('進場塊的輔助標籤越過截止')
        valid=family=='fixed' or engine.model is not None
        for a in chosen:
            if valid and aux.get(a.key) is not None:
                values[a.key]=aux[a.key];engines[a.key]=engine
        blocks.append(dict(dates=days,cutoff=cutoff,auxHash=record['hash'],exitHash=digest(engine.model),validExit=valid))
    cutoff=boundary(calibration[0]);_,aux=aux_bank.get(cutoff);final_engine=exit_bank.engine(cutoff,family)
    info=aux['metadata']
    if info['cutoff']!=cutoff or (info.get('maximumLabelEnd') is not None and info['maximumLabelEnd']>=cutoff):
        raise ValueError('最終輔助標籤越過截止')
    chosen=[a for a in selected if a.key in values];metadata=dict(fitDates=fit_dates,calibrationDates=calibration,
        calibrationStart=cal_start,finalCutoff=cutoff,blocks=blocks,rawCandidates=len(selected),fitActions=len(chosen),
        fitDays=len({a.day for a in chosen}),maximumLabelEnd=max((a.label_end for a in chosen),default=None),
        auxiliaryFinal=dict(hash=aux['hash'],metadata=aux['metadata']),exitHash=digest(final_engine.model))
    if (aux['model'] is None or (family!='fixed' and final_engine.model is None) or len(chosen)<100 or metadata['fitDays']<20):
        return None,metadata|dict(reason='有效過去exit／aux不足或金額fit少於100動作／20日')
    x=entry_features(chosen,shapes,values);counts=Counter(a.day for a in chosen)
    w=np.asarray([len(chosen)/len(counts)/counts[a.day] for a in chosen]);heads={}
    for name,extra,delay in SCENARIOS:
        trades=[engines[a.key].outcome(a,extra,delay) for a in chosen]
        heads[name]=tree(x,np.asarray([t['net'] if t else 0. for t in trades]),w,ENTRY_FEATURES,PARAMETERS)
    model=dict(kind='recovery_entry',version=1,variant=variant,features=ENTRY_FEATURES,targetUnit='NTD',
        auxiliary=aux['model'],exitHash=digest(final_engine.model),heads=heads)
    return model,metadata|dict(modelHash=digest(model))


def predict(model,events,shapes):
    import numpy as np
    if model is None:
        return {a.key:None for a in events}
    if (model.get('kind')!='recovery_entry' or model.get('version')!=1 or model.get('variant') not in VARIANTS
        or model.get('features')!=ENTRY_FEATURES or model.get('targetUnit')!='NTD'
        or set(model['heads'])!={'normal','stress','delayed'} or len({a.key for a in events})!=len(events)):
        raise ValueError('回升進場模型無效')
    if not events:
        return {}
    aux=_predict_head(model['auxiliary'],np.asarray([shapes[a.key][0] for a in events]))
    x=entry_features(events,shapes,{a.key:float(v) for a,v in zip(events,aux,strict=True)})
    values=np.min([_predict_head(model['heads'][s],x) for s,_,_ in SCENARIOS],axis=0)
    if not np.isfinite(values).all():
        raise ValueError('回升進場分數無效')
    return {a.key:float(v) for a,v in zip(events,values,strict=True)}


def replay(events,scores,dates,engine,reentry='free',extra=0,delay=0,enabled=True):
    if reentry not in ('free','lock'):
        raise ValueError('未知退出後進場方式')
    balance=peak=dd=0.;trades=[];by_day=dict.fromkeys(dates,0.);funnel=defaultdict(int);groups=defaultdict(list)
    for a in events:
        groups[a.time].append(a)
    day=None;used=set();busy=entries=0;realized=0.;locked=False
    for at,group in sorted(groups.items()):
        if group[0].day!=day:
            day=group[0].day;used=set();busy=entries=0;realized=0.;locked=False
        funnel['signalTimes']+=1
        if not enabled or (engine.family!='fixed' and engine.model is None):
            funnel['calibrationBlocked']+=1;continue
        if locked and at>=busy:
            funnel['earlyExitLocked']+=1;continue
        if at<busy or entries>=2 or realized<=-1000:
            funnel['positionOrBudget']+=1;continue
        a,reason=choose(group,scores,'hybrid',0.,used)
        if a is None:
            funnel['noPositiveScore' if group[0].source=='confirmed' else reason]+=1;continue
        _,fill,reason=prepare(a,extra,delay,realized)
        if fill is None:
            funnel['rejected_'+reason]+=1;continue
        t=engine.outcome(a,extra,delay,realized,marks=True)
        for _,value in t.pop('marks'):
            peak=max(peak,balance+value);dd=max(dd,peak-balance-value)
        t.update(score=scores[a.key],plannedRisk=a.planned_risk,signalClose=a.bars[a.index]['close'],targetLevel=a.target_level)
        trades.append(t);balance+=t['net'];by_day[day]+=t['net'];realized+=t['net'];busy=t['exitTime'];entries+=1;used.add(a.side)
        locked=reentry=='lock' and t['reason'] in ('negative_continuation','protected_continuation')
    return dict(count=len(trades),net=balance,maxDrawdown=dd,trades=trades,dates=by_day,
        withoutBestDay=balance-max(by_day.values(),default=0),funnel=dict(funnel),
        byPlan={p:dict(count=sum(t['plan']==p for t in trades),net=sum(t['net'] for t in trades if t['plan']==p)) for p in ('range','trend')})


def compare(events,scores,dates,engine,reentry='free',enabled=True):
    return {name:replay(events,scores,dates,engine,reentry,extra,delay,enabled) for name,extra,delay in SCENARIOS}


def select(trials):
    rankings=[]
    for name in policies():
        folds=trials.get(name,{}).get('folds',[]);reasons=[]
        if len(folds)!=3:
            reasons.append('缺少三個發展折')
        for i,f in enumerate(folds,1):
            if f.get('calibration',{}).get('passed') is not True:
                reasons.append(f'fold{i}:校準未通過')
            reasons += [f'fold{i}:{r}' for r in _comparison_errors(f.get('guarded'),'hybrid',30,None)]
        rankable=len(folds)==3 and all(not _comparison_errors(f.get('guarded'),'hybrid',0,None) for f in folds)
        stress=[f['guarded']['stress'] for f in folds] if rankable else []
        if rankable:
            for p in ('range','trend'):
                if sum(s['byPlan'][p]['count'] for s in stress)<20 or sum(s['byPlan'][p]['net'] for s in stress)<=0:
                    reasons.append(f'{p}:壓力分支不足20筆或未獲利')
        rankings.append(dict(name=name,eligible=not reasons,reasons=reasons,
            worstStress=min((s['net'] for s in stress),default=None),stressNet=sum(s['net'] for s in stress) if stress else None))
    rankings.sort(key=lambda r:(r['eligible'],r['worstStress'] if r['worstStress'] is not None else -math.inf,
        r['stressNet'] if r['stressNet'] is not None else -math.inf),reverse=True)
    qualified=[r for r in rankings if r['eligible']]
    return dict(selected=qualified[0]['name'] if qualified else None,eligibleCount=len(qualified),rankings=rankings,
        evaluationUsed=False,executionEnabled=False,adoptionAllowed=False)
