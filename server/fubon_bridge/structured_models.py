"""Low-complexity and execution-aware model ablations, research only."""
from collections import Counter
import math

from .research import digest
from .structured_research import FEATURES,SCOPES,outcome
from .strategy_session import schedule

VARIANTS={
    'ridge-normal':dict(kind='ridge',robust=False,window=None),
    'ridge-robust':dict(kind='ridge',robust=True,window=None),
    'tree-robust':dict(kind='tree',robust=True,window=None),
    'tree-recent':dict(kind='tree',robust=True,window=120)}
PARAMETERS=dict(objective='regression',metric='l2',num_leaves=7,max_depth=3,
    min_data_in_leaf=40,lambda_l2=100.,learning_rate=.03,max_bin=63,
    verbosity=-1,seed=42,num_threads=2,deterministic=True,force_col_wise=True)
POLICY=dict(version='structured-models-v1',variants=VARIANTS,parameters=PARAMETERS,
    rounds=150,ridgeAlpha=100.,standardizedClip=5.,thinMinutes=5,
    target='net / planned signal-time risk',robustTarget='minimum of normal, stress, delayed; no fill=0',
    fitFraction=.8,minimumFitActions=100,calibrationMinimumTradesEachScenario=20,
    calibrationPositiveAfterRemovingBestDay=True,calibrationMinimumPerEnabledPlan=5,
    folds=[.3,.4,.5,.6],thresholds=[0.,30.],policies=27,
    developmentMinimumTradesEachFoldScenario=30,developmentMinimumPerEnabledPlan=20,
    validationMinimumEachScenario=30,testMinimumEachScenario=100,testMinimumEachEnabledPlan=30,
    noQualifiedCandidate=None,historyReused=True,executionEnabled=False,adoptionAllowed=False)


def policies():
    return {f'rule-{scope}':dict(model='rule',scope=scope,threshold=0.) for scope in SCOPES}|{
        f'{name}-{int(t)}-{scope}':dict(model=name,scope=scope,threshold=t)
        for name in VARIANTS for t in POLICY['thresholds'] for scope in SCOPES}


def thin(events):
    seen=set();selected=[]
    for a in sorted(events,key=lambda a:a.key):
        bucket=(a.day,a.side,a.plan,(a.time-a.start)//300)
        if bucket not in seen:
            seen.add(bucket);selected.append(a)
    return selected


def target_for(action,robust):
    scenarios=[outcome(action)]
    if robust:
        scenarios += [outcome(action,extra=2),outcome(action,delay=1)]
    if not robust and scenarios[0] is None:
        return None
    return min(r['net'] if r is not None else 0. for r in scenarios)/action.planned_risk


def fit(events,dates,session,name):
    import numpy as np
    spec=VARIANTS[name]
    selected=dates[-spec['window']:] if spec['window'] else dates
    cut=int(len(selected)*.8);boundary=int(schedule(session).window(selected[cut])[0].timestamp())
    fit_dates=selected[:cut];calibration_dates=selected[cut:];allowed=set(fit_dates)
    candidates=thin([a for a in events if a.day in allowed and a.label_end<boundary])
    rows=[]
    for a in candidates:
        label=target_for(a,spec['robust'])
        if label is None:
            continue
        rows.append((a,label))
    metadata=dict(fitDates=fit_dates,calibrationDates=calibration_dates,
        rawFitEvents=len([a for a in events if a.day in allowed]),thinnedCandidates=len(candidates),
        fitActions=len(rows),fitDays=len({a.day for a,_ in rows}),calibrationStart=boundary,
        maximumLabelEnd=max((a.label_end for a,_ in rows),default=None),
        expectedTarget='normal net/risk' if not spec['robust'] else 'worst-execution net/risk')
    if len(rows)<100 or len({a.day for a,_ in rows})<20:
        return None,metadata|dict(reason='訓練少於100動作或20個開盤日')
    counts=Counter(a.day for a,_ in rows);n=len(rows)
    weights=np.asarray([n/(len(counts)*counts[a.day]) for a,_ in rows])
    x=np.asarray([a.x for a,_ in rows],dtype=np.float64);y=np.asarray([v for _,v in rows])
    if spec['kind']=='ridge':
        center=np.average(x,axis=0,weights=weights)
        scale=np.sqrt(np.average(np.square(x-center),axis=0,weights=weights));scale[scale<1e-8]=1.
        z=np.clip((x-center)/scale,-5,5);design=np.column_stack([np.ones(n),z])
        regularizer=np.eye(design.shape[1])*100.;regularizer[0,0]=0.
        coefficients=np.linalg.solve(design.T@(weights[:,None]*design)+regularizer,design.T@(weights*y))
        model=dict(kind='ridge',center=center.tolist(),scale=scale.tolist(),coefficients=coefficients.tolist())
    else:
        import lightgbm as lgb
        dataset=lgb.Dataset(x,label=y,weight=weights,feature_name=FEATURES)
        booster=lgb.train(PARAMETERS,dataset,num_boost_round=150)
        model=dict(kind='tree',text=booster.model_to_string())
        metadata['featureImportance']=dict(zip(FEATURES,map(float,booster.feature_importance(importance_type='gain'))))
    metadata['modelHash']=digest(model)
    return model,metadata


def predict(model,events):
    import numpy as np
    if model is None:
        return {a.key:None for a in events}
    if not events:
        return {}
    if len({a.key for a in events})!=len(events):
        raise ValueError('動作鍵重複')
    x=np.asarray([a.x for a in events],dtype=np.float64)
    if model['kind']=='ridge':
        z=np.clip((x-np.asarray(model['center']))/np.asarray(model['scale']),-5,5)
        values=np.column_stack([np.ones(len(x)),z])@np.asarray(model['coefficients'])
    else:
        import lightgbm as lgb
        values=lgb.Booster(model_str=model['text']).predict(x,num_threads=2)
    scores={a.key:float(v*a.planned_risk) for a,v in zip(events,values,strict=True)}
    if not all(math.isfinite(v) for v in scores.values()):
        raise ValueError('模型分數無效')
    return scores


def calibration_check(comparison,scope):
    reasons=[]
    for scenario,r in comparison.items():
        if r['count']<20 or r['net']<=0 or r['withoutBestDay']<=0:
            reasons.append(f'{scenario}:成交少於20或淨額／去最佳日未正')
        for plan in SCOPES[scope]:
            if r['byPlan'][plan]['count']<5 or r['byPlan'][plan]['net']<=0:
                reasons.append(f'{scenario}:{plan}少於5筆或未獲利')
    return dict(passed=not reasons,reasons=reasons)


def select(trials):
    rankings=[]
    for name,spec in policies().items():
        folds=trials[name]['folds'];reasons=[]
        if len(folds)!=3:
            reasons.append('缺少三個發展折')
        for i,fold in enumerate(folds,1):
            if not fold['calibration']['passed']:
                reasons.append(f'fold{i}:校準未通過')
            for scenario,r in fold['guarded'].items():
                if r['count']<30 or r['net']<=0 or r['withoutBestDay']<=0:
                    reasons.append(f'fold{i}:{scenario}成交不足30或淨額／去最佳日未正')
        branches={p:dict(count=sum(f['guarded']['stress']['byPlan'][p]['count'] for f in folds),
            net=sum(f['guarded']['stress']['byPlan'][p]['net'] for f in folds)) for p in SCOPES[spec['scope']]}
        if any(b['count']<20 or b['net']<=0 for b in branches.values()):
            reasons.append('啟用方案樣本不足20或未獲利')
        rankings.append(dict(name=name,eligible=not reasons,reasons=reasons,
            worstStress=min((f['guarded']['stress']['net'] for f in folds),default=0),
            stressNet=sum(f['guarded']['stress']['net'] for f in folds)))
    rankings.sort(key=lambda r:(r['eligible'],r['worstStress'],r['stressNet']),reverse=True)
    qualified=[r for r in rankings if r['eligible']]
    return dict(selected=qualified[0]['name'] if qualified else None,eligibleCount=len(qualified),
        rankings=rankings,evaluationUsed=False,executionEnabled=False,adoptionAllowed=False)


def final_check(results,scope):
    reasons=[]
    for phase,comparison in results.items():
        minimum=30 if phase=='validation' else 100
        for scenario,r in comparison.items():
            if r['count']<minimum or r['net']<=0 or r['withoutBestDay']<=0:
                reasons.append(f'{phase}:{scenario}樣本不足{minimum}或收益不穩定')
            for plan in SCOPES[scope]:
                if r['byPlan'][plan]['net']<=0 or (phase!='validation' and r['byPlan'][plan]['count']<30):
                    reasons.append(f'{phase}:{scenario}:{plan}收益或樣本不足')
    return dict(passed=not reasons,reasons=reasons,adoptionAllowed=False,executionEnabled=False)
