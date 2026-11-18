"""Causal expanding auxiliary predictions and competing NTD action values."""
from collections import Counter
import math

from .candle_patterns import boundary
from .confirmed_models import features as parent_features
from .confirmed_models import FEATURES as PARENT_FEATURES
from .direction_execution import VARIANTS, SCOPES, outcome
from .pattern_transfer import partition, pretrain, tree
from .research import digest
from .structured_models import PARAMETERS, _comparison_errors, _predict_head, thin
from .strategy_session import schedule

FEATURES=PARENT_FEATURES+['relativeVolume1','signedVwapAtr1','signedMove5Atr1','signedChannelPosition60']
KINDS=('half-pooled','crossfit-pooled')
POLICY=dict(version='direction-value-v1',features=FEATURES,kinds=KINDS,parameters=PARAMETERS,
    rounds=150,folds=[.3,.4,.5,.6],thresholds=[0.,30.],crossfitWarmupDays=40,crossfitBlockDays=20,
    target='conditional expected normal/stress/delayed NTD attempt cashflow; unfilled=0',
    aggregation='min after conditional means',minimumFitActions=100,minimumFitDays=20,
    executionEnabled=False,adoptionAllowed=False)


class AuxiliaryBank:
    def __init__(self,rows,identity):
        self.rows=rows;self.identity=digest(identity);self.models={};self.predictions={}

    def get(self,cutoff):
        key=digest(dict(identity=self.identity,cutoff=cutoff))
        if key not in self.models:
            model,metadata=pretrain(self.rows,'pooled-pretrain',cutoff)
            self.models[key]=dict(cutoff=cutoff,model=model,metadata=metadata,hash=digest(model))
            self.predictions[key]={}
        return key,self.models[key]

    def transform(self,events,shapes,cutoff):
        import numpy as np
        key,record=self.get(cutoff)
        if record['model'] is None:
            return {a.key:None for a in events},record
        cached=self.predictions[key];unique={a.time:a for a in events if a.time not in cached}
        if unique:
            at=sorted(unique);x=np.asarray([shapes[unique[t].key][0] for t in at])
            values=_predict_head(record['model'],x)
            if not np.isfinite(values).all():
                raise ValueError('方向輔助預測無效')
            cached.update({t:float(v) for t,v in zip(at,values,strict=True)})
        return {a.key:cached[a.time] for a in events},record


def policies():
    return {f'{variant}-{model}-{scope}':dict(variant=variant,model=model,scope=scope,
        threshold=0. if model=='rule' else float(model.rsplit('-',1)[1]))
        for variant in VARIANTS for model in ('rule',*(f'{k}-{int(t)}' for k in KINDS for t in POLICY['thresholds']))
        for scope in SCOPES}


def features(events,shapes,auxiliary_values):
    import numpy as np
    if any(auxiliary_values.get(a.key) is None for a in events):
        raise ValueError('缺少有效的過去輔助方向，不可用零補值')
    x=parent_features(events,shapes,None)
    x[:,63]=[auxiliary_values[a.key]*a.side for a in events]
    result=np.column_stack((x,np.asarray([a.extras for a in events])))
    if result.shape[1]!=len(FEATURES) or not np.isfinite(result).all():
        raise ValueError('方向模型特徵或尺度無效')
    return result


def targets(action):
    values={}
    for name,extra,delay in (('normal',0,0),('stress',2,0),('delayed',0,1)):
        trade=outcome(action,extra=extra,delay=delay)
        value=trade['net'] if trade else 0.
        if not math.isfinite(value):
            raise ValueError('方向現金流標籤無效')
        values[name]=value
    return values


def fit(events,dates,session,kind,bank,shapes):
    import numpy as np
    if kind not in KINDS:
        raise ValueError('未知方向訓練方式')
    early,half_dates,calibration=partition(dates);fit_end=int(len(dates)*.8)
    fit_dates=half_dates if kind=='half-pooled' else dates[40:fit_end]
    calibration_start=int(schedule(session).window(calibration[0])[0].timestamp())
    allowed=set(fit_dates)
    candidates=thin([a for a in events if a.day in allowed and a.label_end<calibration_start])
    blocks=[];auxiliary_values={}
    if kind=='half-pooled':
        cutoff=boundary(half_dates[0]);auxiliary_values,record=bank.transform(candidates,shapes,cutoff)
        blocks.append(dict(dates=half_dates,cutoff=cutoff,hash=record['hash'],metadata=record['metadata']))
    else:
        for i in range(0,len(fit_dates),20):
            selected_dates=fit_dates[i:i+20];cutoff=boundary(selected_dates[0]);chosen=set(selected_dates)
            selected=[a for a in candidates if a.day in chosen]
            values,record=bank.transform(selected,shapes,cutoff);auxiliary_values.update(values)
            blocks.append(dict(dates=selected_dates,cutoff=cutoff,hash=record['hash'],metadata=record['metadata']))
        cutoff=boundary(calibration[0])
    _,final=bank.get(cutoff)
    selected=[a for a in candidates if auxiliary_values.get(a.key) is not None]
    metadata=dict(kind=kind,fitDates=fit_dates,calibrationDates=calibration,
        warmupDates=early if kind=='half-pooled' else dates[:40],blocks=blocks,
        auxiliaryFinal=dict(cutoff=cutoff,hash=final['hash'],metadata=final['metadata']),
        rawCandidates=len(candidates),excludedMissingAux=len(candidates)-len(selected),
        fitActions=len(selected),fitDays=len({a.day for a in selected}),calibrationStart=calibration_start,
        maximumLabelEnd=max((a.label_end for a in selected),default=None))
    for block in blocks+[metadata['auxiliaryFinal']]:
        if block['metadata'].get('cutoff')!=block['cutoff'] or (block['metadata'].get('maximumLabelEnd') is not None and block['metadata']['maximumLabelEnd']>=block['cutoff']):
            raise ValueError('跨資產輔助標籤越過截止')
    if final['model'] is None or len(selected)<100 or len({a.day for a in selected})<20:
        return None,metadata|dict(reason='有效預訓練不足或金額fit少於100動作／20日')
    x=features(selected,shapes,auxiliary_values);counts=Counter(a.day for a in selected)
    weights=np.asarray([len(selected)/len(counts)/counts[a.day] for a in selected])
    cashflows=[targets(a) for a in selected]
    heads={s:tree(x,np.asarray([v[s] for v in cashflows]),weights,FEATURES,PARAMETERS)
        for s in ('normal','stress','delayed')}
    model=dict(kind='direction_value',version=1,training=kind,features=FEATURES,targetUnit='NTD',
        auxiliary=final['model'],heads=heads)
    metadata['modelHash']=digest(model)
    return model,metadata


def predict(model,events,shapes):
    import numpy as np
    if model is None:
        return {a.key:None for a in events}
    if not events:
        return {}
    if (model.get('kind')!='direction_value' or model.get('version')!=1 or model.get('training') not in KINDS or model.get('features')!=FEATURES
        or model.get('targetUnit')!='NTD' or set(model['heads'])!={'normal','stress','delayed'}
        or not isinstance(model.get('auxiliary'),dict) or len({a.key for a in events})!=len(events)):
        raise ValueError('方向模型、特徵、NTD單位或輔助模型無效')
    raw=np.asarray([shapes[a.key][0] for a in events])
    aux=_predict_head(model['auxiliary'],raw)
    x=features(events,shapes,{a.key:float(v) for a,v in zip(events,aux,strict=True)})
    values=np.min([_predict_head(model['heads'][s],x) for s in sorted(model['heads'])],axis=0)
    if not np.isfinite(values).all():
        raise ValueError('方向模型預測無效')
    return {a.key:float(v) for a,v in zip(events,values,strict=True)}


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
            for plan in SCOPES[spec['scope']]:
                if sum(s['byPlan'][plan]['count'] for s in stress)<20 or sum(s['byPlan'][plan]['net'] for s in stress)<=0:
                    reasons.append(f'{plan}:分支壓力不足20筆或未獲利')
        rankings.append(dict(name=name,eligible=not reasons,reasons=reasons,
            worstStress=min((s['net'] for s in stress),default=None),stressNet=sum(s['net'] for s in stress) if stress else None))
    rankings.sort(key=lambda r:(r['eligible'],r['worstStress'] if r['worstStress'] is not None else -math.inf,
        r['stressNet'] if r['stressNet'] is not None else -math.inf),reverse=True)
    qualified=[r for r in rankings if r['eligible']]
    return dict(selected=qualified[0]['name'] if qualified else None,eligibleCount=len(qualified),rankings=rankings,
        evaluationUsed=False,executionEnabled=False,adoptionAllowed=False)
