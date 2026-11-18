"""Frozen cross-asset pattern pretraining, then TMF-only cashflow filtering."""
from collections import Counter
import math

from .candle_patterns import FEATURES as SHAPES, boundary, oriented, weights
from .research import digest
from .structured_models import (PARAMETERS, _comparison_errors, _predict_head,
    targets_for, thin)
from .structured_research import SCOPES
from .strategy_session import schedule

VARIANTS=('shape-only','tmf-pretrain','stocks-pretrain','pooled-pretrain')
FEATURES=SHAPES+['auxDirection','trendPlan','stopAtr','targetAtr','frictionAtr','horizonFraction','plannedRiskNTD']
PRETRAIN_PARAMETERS=PARAMETERS|dict(num_leaves=15,max_depth=4,min_data_in_leaf=200)
POLICY=dict(version='stock-pattern-transfer-v1.1',variants=VARIANTS,features=FEATURES,
    pretrainParameters=PRETRAIN_PARAMETERS,metaParameters=PARAMETERS,rounds=150,
    fitFraction=.8,pretrainFractionOfFit=.5,auxTarget='15m gross move / contemporaneous ATR; clip +/-3',
    globalCutoff='Taipei midnight of first meta-training opening date; label_end strictly before cutoff',
    stockCodes=['2330','2454','2317','2881'],minimumAuxSamples=1000,minimumAuxDays=20,
    minimumMetaActions=100,minimumMetaDays=20,folds=[.3,.4,.5,.6],thresholds=[0.,30.],
    baseline='same confirmed signals and TMF execution as structured-confirmation-v1',
    executionEnabled=False,adoptionAllowed=False)


def policies():
    return {f'rule-{s}':dict(model='rule',scope=s,threshold=0.) for s in SCOPES}|{
        f'{name}-{int(t)}-{s}':dict(model=name,scope=s,threshold=t)
        for name in VARIANTS for t in POLICY['thresholds'] for s in SCOPES}


def partition(dates):
    cut=int(len(dates)*.8);middle=cut//2
    if middle<1 or cut>=len(dates):
        raise ValueError('預訓練／微台訓練／校準日期不足')
    return dates[:middle],dates[middle:cut],dates[cut:]


def pretrain(rows,name,cutoff):
    import numpy as np
    chosen=[r for r in rows if r.label_end<cutoff and (
        name=='pooled-pretrain' or (r.asset=='TMF' if name=='tmf-pretrain' else r.asset!='TMF'))]
    metadata=dict(cutoff=cutoff,samples=len(chosen),days=len({r.day for r in chosen}),
        byAsset=dict(Counter(r.asset for r in chosen)),
        maximumLabelEnd=max((r.label_end for r in chosen),default=None))
    required={'TMF'} if name=='tmf-pretrain' else set(POLICY['stockCodes'])
    if name=='pooled-pretrain':
        required.add('TMF')
    if (len(chosen)<1000 or len({r.day for r in chosen})<20
        or not required<=set(metadata['byAsset'])):
        return None,metadata|dict(reason='預訓練少於1000樣本／20日或缺少指定資產')
    sample_weights=weights(chosen,name=='pooled-pretrain')
    metadata['weightMass']={asset:sum(w for r,w in zip(chosen,sample_weights,strict=True) if r.asset==asset)/len(chosen)
        for asset in sorted(metadata['byAsset'])}
    model=tree(np.asarray([r.x for r in chosen]),np.asarray([r.target for r in chosen]),
        np.asarray(sample_weights),SHAPES,PRETRAIN_PARAMETERS)
    metadata['modelHash']=digest(model)
    return model,metadata


def tree(x,y,sample_weights,names,parameters):
    import lightgbm as lgb
    import numpy as np
    if not np.isfinite(x).all() or not np.isfinite(y).all() or not np.isfinite(sample_weights).all():
        raise ValueError('跨資產模型樣本無效')
    training=lgb.Dataset(x,label=y,weight=sample_weights,feature_name=names)
    booster=lgb.train(parameters,training,num_boost_round=150)
    return dict(kind='tree',text=booster.model_to_string())


def features(events,shapes,aux):
    import numpy as np
    values=np.asarray([shapes[a.key][0] for a in events],dtype=np.float64)
    directions=_predict_head(aux,values) if aux else np.zeros(len(events))
    result=[]
    for a,signal in zip(events,directions,strict=True):
        shape,atr=shapes[a.key]
        # Existing x[5] is friction/ATR1; reconstruct the known signal-time points.
        # The first x[2] is stop/ATR1, so their ratio removes the old ATR definition.
        friction=a.x[5]/a.x[2]*a.stop
        result.append(oriented(shape,a.side)+[float(signal)*a.side,float(a.plan=='trend'),
            a.stop/atr,a.target/atr,friction/atr,(a.end-a.index)/schedule(a.session).duration,a.planned_risk])
    return np.asarray(result,dtype=np.float64)


def fit(events,dates,session,name,auxiliary,shapes):
    import numpy as np
    early,meta_dates,calibration=partition(dates)
    cutoff=boundary(meta_dates[0]);calibration_start=int(schedule(session).window(calibration[0])[0].timestamp())
    allowed=set(meta_dates)
    selected=thin([a for a in events if a.day in allowed and a.label_end<calibration_start])
    metadata=dict(pretrainDates=early,fitDates=meta_dates,calibrationDates=calibration,
        globalPretrainCutoff=cutoff,calibrationStart=calibration_start,fitActions=len(selected),
        fitDays=len({a.day for a in selected}),maximumLabelEnd=max((a.label_end for a in selected),default=None))
    if name not in VARIANTS:
        raise ValueError('未知型態訓練組別')
    aux=None
    if name!='shape-only':
        aux,info=pretrain(auxiliary,name,cutoff);metadata['pretraining']=info
        if aux is None:
            return None,metadata|dict(reason='預訓練資料不足')
    if len(selected)<100 or len({a.day for a in selected})<20:
        return None,metadata|dict(reason='微台金額模型少於100動作或20日')
    x=features(selected,shapes,aux);counts=Counter(a.day for a in selected)
    sample_weights=np.asarray([len(selected)/len(counts)/counts[a.day] for a in selected])
    targets=[targets_for(a,True) for a in selected]
    heads={s:tree(x,np.asarray([v[s] for v in targets]),sample_weights,FEATURES,PARAMETERS)
        for s in ('normal','stress','delayed')}
    model=dict(kind='pattern_transfer',version=1,name=name,features=FEATURES,
        targetUnit='NTD',auxiliary=aux,heads=heads)
    metadata['modelHash']=digest(model)
    return model,metadata


def predict(model,events,shapes):
    import numpy as np
    if model is None:
        return {a.key:None for a in events}
    if not events:
        return {}
    if (model.get('kind')!='pattern_transfer' or model.get('features')!=FEATURES
        or model.get('targetUnit')!='NTD' or set(model['heads'])!={'normal','stress','delayed'}
        or len({a.key for a in events})!=len(events)):
        raise ValueError('跨資產金額模型或動作鍵無效')
    x=features(events,shapes,model['auxiliary'])
    values=np.min([_predict_head(model['heads'][s],x) for s in sorted(model['heads'])],axis=0)
    if not np.isfinite(values).all():
        raise ValueError('跨資產模型預測無效')
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
        stress=[f.get('guarded',{}).get('stress',{}) for f in folds]
        rankable=len(stress)==3 and all(not _comparison_errors(f.get('guarded'),spec['scope'],0,None) for f in folds)
        if rankable:
            for plan in SCOPES[spec['scope']]:
                if sum(s['byPlan'][plan]['count'] for s in stress)<20 or sum(s['byPlan'][plan]['net'] for s in stress)<=0:
                    reasons.append(f'{plan}:發展壓力情境不足20筆或未獲利')
        worst=min((s['net'] for s in stress),default=None) if rankable else None
        total=sum(s['net'] for s in stress) if rankable else None
        rankings.append(dict(name=name,eligible=not reasons,reasons=reasons,worstStress=worst,stressNet=total))
    rankings.sort(key=lambda r:(r['eligible'],r['worstStress'] if r['worstStress'] is not None else -math.inf,
        r['stressNet'] if r['stressNet'] is not None else -math.inf),reverse=True)
    eligible=[r for r in rankings if r['eligible']]
    return dict(selected=eligible[0]['name'] if eligible else None,eligibleCount=len(eligible),rankings=rankings,
        evaluationUsed=False,executionEnabled=False,adoptionAllowed=False)
