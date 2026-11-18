"""Shared causal pretraining, execution-specific TMF labels and fixed screening."""
from collections import Counter
import math

from .candle_patterns import boundary
from .confirmed_execution import SCOPES, VARIANTS, outcome
from .pattern_transfer import FEATURES as BASE_FEATURES, features as base_features, partition, tree
from .research import digest
from .structured_models import PARAMETERS, _comparison_errors, _predict_head, thin
from .strategy_session import schedule

FEATURES=BASE_FEATURES+['efficiency15Context','direction15Atr3','distanceMean15Atr3',
    'breakDistanceAtr3','confirmationBodyAtr3','rangeWidthAtr3','structuralStop']
POLICY=dict(version='confirmed-cashflow-v1',features=FEATURES,parameters=PARAMETERS,
    rounds=150,thresholds=[0.,30.],folds=[.3,.4,.5,.6],minimumFitActions=100,
    minimumFitDays=20,pretrain='same pooled model per fold, prior first half only',
    target='three conditional expected NTD cashflows of this entry/exit version; no fill=0',
    aggregation='min after prediction',executionEnabled=False,adoptionAllowed=False)


def policies():
    return {f'{variant}-{model}-{scope}':dict(variant=variant,model=model,scope=scope,
        threshold=0. if model=='rule' else float(model.split('-')[-1]))
        for variant in VARIANTS for model in ('rule','tree-0','tree-30') for scope in SCOPES}


def features(events,shapes,auxiliary):
    import numpy as np
    return np.column_stack((base_features(events,shapes,auxiliary),np.asarray([a.context for a in events])))


def targets(action):
    result={}
    for scenario,extra,delay in (('normal',0,0),('stress',2,0),('delayed',0,1)):
        trade=outcome(action,extra=extra,delay=delay)
        value=trade['net'] if trade is not None else 0.
        if not math.isfinite(value):
            raise ValueError('進出場現金流無效')
        result[scenario]=value
    return result


def fit(events,dates,session,auxiliary,auxiliary_meta,shapes):
    import numpy as np
    early,fit_dates,calibration=partition(dates)
    cutoff=boundary(fit_dates[0]);calibration_start=int(schedule(session).window(calibration[0])[0].timestamp())
    if auxiliary_meta.get('cutoff')!=cutoff or (auxiliary_meta.get('maximumLabelEnd') is not None
        and auxiliary_meta['maximumLabelEnd']>=cutoff):
        raise ValueError('共同型態預訓練超過全資產時間截止')
    allowed=set(fit_dates);selected=thin([a for a in events if a.day in allowed and a.label_end<calibration_start])
    metadata=dict(pretrainDates=early,fitDates=fit_dates,calibrationDates=calibration,
        globalPretrainCutoff=cutoff,pretraining=auxiliary_meta,fitActions=len(selected),
        fitDays=len({a.day for a in selected}),maximumLabelEnd=max((a.label_end for a in selected),default=None))
    if auxiliary is None or len(selected)<100 or len({a.day for a in selected})<20:
        return None,metadata|dict(reason='預訓練不足或金額fit少於100動作／20日')
    x=features(selected,shapes,auxiliary);counts=Counter(a.day for a in selected)
    weights=np.asarray([len(selected)/len(counts)/counts[a.day] for a in selected])
    cashflows=[targets(a) for a in selected]
    heads={s:tree(x,np.asarray([v[s] for v in cashflows]),weights,FEATURES,PARAMETERS)
        for s in ('normal','stress','delayed')}
    model=dict(kind='confirmed_execution',version=1,features=FEATURES,targetUnit='NTD',
        auxiliary=auxiliary,heads=heads)
    metadata['modelHash']=digest(model)
    return model,metadata


def predict(model,events,shapes):
    import numpy as np
    if model is None:
        return {a.key:None for a in events}
    if not events:
        return {}
    if (model.get('kind')!='confirmed_execution' or model.get('features')!=FEATURES
        or model.get('targetUnit')!='NTD' or set(model['heads'])!={'normal','stress','delayed'}
        or len({a.key for a in events})!=len(events)):
        raise ValueError('進出場模型／特徵／金額單位無效')
    x=features(events,shapes,model['auxiliary'])
    values=np.min([_predict_head(model['heads'][s],x) for s in sorted(model['heads'])],axis=0)
    if not np.isfinite(values).all():
        raise ValueError('進出場預測無效')
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
                    reasons.append(f'{plan}:壓力分支不足20筆或未獲利')
        rankings.append(dict(name=name,eligible=not reasons,reasons=reasons,
            worstStress=min((s['net'] for s in stress),default=None),
            stressNet=sum(s['net'] for s in stress) if stress else None))
    rankings.sort(key=lambda r:(r['eligible'],r['worstStress'] if r['worstStress'] is not None else -math.inf,
        r['stressNet'] if r['stressNet'] is not None else -math.inf),reverse=True)
    eligible=[r for r in rankings if r['eligible']]
    return dict(selected=eligible[0]['name'] if eligible else None,eligibleCount=len(eligible),rankings=rankings,
        evaluationUsed=False,executionEnabled=False,adoptionAllowed=False)


def block_interval(days):
    """Diagnostic only: includes zero-trade days; not a multiple-testing remedy."""
    import numpy as np
    x=np.asarray(list(days.values()),dtype=np.float64)
    if not len(x) or not np.isfinite(x).all():
        return dict(days=len(x),mean=None,median=None,lower=None,upper=None)
    block=min(5,len(x));rng=np.random.default_rng(42)
    starts=rng.integers(0,len(x)-block+1,size=(2000,math.ceil(len(x)/block)))
    indices=(starts[:,:,None]+np.arange(block)).reshape(2000,-1)[:,:len(x)]
    means=x[indices].mean(axis=1);low,high=np.quantile(means,[.025,.975])
    return dict(days=len(x),mean=float(x.mean()),median=float(np.median(x)),
        lower=float(low),upper=float(high),blockDays=block,replicates=2000,seed=42)
