"""Low-complexity and execution-aware model ablations, research only."""
from collections import Counter
import math

from .research import digest
from .structured_research import FEATURES,SCOPES,outcome
from .strategy_session import schedule

MODEL_FEATURES=FEATURES+['plannedRiskNTD']
VARIANTS={
    'ridge-normal':dict(kind='ridge',robust=False,window=None),
    'ridge-robust':dict(kind='ridge',robust=True,window=None),
    'tree-robust':dict(kind='tree',robust=True,window=None),
    'tree-recent':dict(kind='tree',robust=True,window=120)}
PARAMETERS=dict(objective='regression',metric='l2',num_leaves=7,max_depth=3,
    min_data_in_leaf=40,lambda_l2=100.,learning_rate=.03,max_bin=63,
    verbosity=-1,seed=42,num_threads=2,deterministic=True,force_col_wise=True)
POLICY=dict(version='structured-models-v2',variants=VARIANTS,parameters=PARAMETERS,
    rounds=150,ridgeAlpha=100.,standardizedClip=5.,thinMinutes=5,
    target='attempt cashflow in NTD; no fill=0 in every head; signal-time risk is a feature',
    features=MODEL_FEATURES,
    robustTarget='minimum of separately fitted conditional expected normal, stress, delayed returns',
    scenarioHeads=['normal','stress','delayed'],aggregation='min after conditional-mean prediction',
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


def targets_for(action,robust):
    scenarios=[('normal',0,0)]
    if robust:
        scenarios += [('stress',2,0),('delayed',0,1)]
    values={}
    for name,extra,delay in scenarios:
        result=outcome(action,extra=extra,delay=delay)
        value=0. if result is None else float(result['net'])
        if not math.isfinite(value):
            raise ValueError('執行情境的訓練現金流無效')
        values[name]=value
    return values


def _fit_head(x,y,weights,kind):
    import numpy as np
    if kind=='ridge':
        center=np.average(x,axis=0,weights=weights)
        scale=np.sqrt(np.average(np.square(x-center),axis=0,weights=weights));scale[scale<1e-8]=1.
        z=np.clip((x-center)/scale,-5,5);design=np.column_stack([np.ones(len(x)),z])
        regularizer=np.eye(design.shape[1])*100.;regularizer[0,0]=0.
        coefficients=np.linalg.solve(design.T@(weights[:,None]*design)+regularizer,design.T@(weights*y))
        return dict(kind='ridge',center=center.tolist(),scale=scale.tolist(),coefficients=coefficients.tolist())
    import lightgbm as lgb
    dataset=lgb.Dataset(x,label=y,weight=weights,feature_name=MODEL_FEATURES)
    booster=lgb.train(PARAMETERS,dataset,num_boost_round=150)
    return dict(kind='tree',text=booster.model_to_string())


def fit(events,dates,session,name):
    import numpy as np
    spec=VARIANTS[name]
    selected=dates[-spec['window']:] if spec['window'] else dates
    cut=int(len(selected)*.8);boundary=int(schedule(session).window(selected[cut])[0].timestamp())
    fit_dates=selected[:cut];calibration_dates=selected[cut:];allowed=set(fit_dates)
    candidates=thin([a for a in events if a.day in allowed and a.label_end<boundary])
    rows=[(a,targets_for(a,spec['robust'])) for a in candidates]
    metadata=dict(fitDates=fit_dates,calibrationDates=calibration_dates,
        rawFitEvents=len([a for a in events if a.day in allowed]),thinnedCandidates=len(candidates),
        fitActions=len(rows),fitDays=len({a.day for a,_ in rows}),calibrationStart=boundary,
        maximumLabelEnd=max((a.label_end for a,_ in rows),default=None),
        expectedTarget='conditional mean attempt cashflow NTD',
        aggregation='normal' if not spec['robust'] else 'minimum of conditional means',
        heads=['normal','stress','delayed'] if spec['robust'] else ['normal'])
    if len(rows)<100 or len({a.day for a,_ in rows})<20:
        return None,metadata|dict(reason='訓練少於100動作或20個開盤日')
    counts=Counter(a.day for a,_ in rows);n=len(rows)
    weights=np.asarray([n/(len(counts)*counts[a.day]) for a,_ in rows])
    x=np.asarray([list(a.x)+[a.planned_risk] for a,_ in rows],dtype=np.float64)
    if not np.isfinite(x).all():
        raise ValueError('模型訓練特徵無效')
    heads={name:_fit_head(x,np.asarray([v[name] for _,v in rows]),weights,spec['kind'])
        for name in metadata['heads']}
    model=dict(kind='execution_expectation',version=2,features=MODEL_FEATURES,
        targetUnit='NTD',robust=spec['robust'],heads=heads)
    metadata['modelHash']=digest(model)
    return model,metadata


def _predict_head(model,x):
    import numpy as np
    if model['kind']=='ridge':
        z=np.clip((x-np.asarray(model['center']))/np.asarray(model['scale']),-5,5)
        return np.column_stack([np.ones(len(x)),z])@np.asarray(model['coefficients'])
    if model['kind']!='tree':
        raise ValueError('未知模型格式')
    import lightgbm as lgb
    return lgb.Booster(model_str=model['text']).predict(x,num_threads=2)


def predict(model,events):
    import numpy as np
    if model is None:
        return {a.key:None for a in events}
    if not events:
        return {}
    if len({a.key for a in events})!=len(events):
        raise ValueError('動作鍵重複')
    if model['kind']=='execution_expectation':
        if model.get('features')!=MODEL_FEATURES or model.get('targetUnit')!='NTD':
            raise ValueError('執行期望模型特徵或金額單位不符')
        x=np.asarray([list(a.x)+[a.planned_risk] for a in events],dtype=np.float64)
        expected={'normal','stress','delayed'} if model['robust'] else {'normal'}
        if set(model['heads'])!=expected:
            raise ValueError('模型缺少完整執行情境')
        # Minimize estimated conditional means, never realized future outcomes.
        values=np.min([_predict_head(model['heads'][s],x) for s in sorted(expected)],axis=0)
    else:
        # Previously frozen one-head models remain readable for paired audits.
        x=np.asarray([a.x for a in events],dtype=np.float64)
        values=_predict_head(model,x)*np.asarray([a.planned_risk for a in events])
    scores={a.key:float(v) for a,v in zip(events,values,strict=True)}
    if not all(math.isfinite(v) for v in scores.values()):
        raise ValueError('模型分數無效')
    return scores


def _finite(value):
    return isinstance(value,(int,float)) and not isinstance(value,bool) and math.isfinite(value)


def _comparison_errors(comparison,scope,minimum,branch_minimum):
    if not isinstance(comparison,dict) or set(comparison)!={'normal','stress','delayed'}:
        return ['缺少完整正常／壓力／延遲情境']
    reasons=[]
    for scenario,r in comparison.items():
        valid=(isinstance(r,dict) and all(_finite(r.get(k)) for k in ('count','net','withoutBestDay'))
            and r['count']>=0 and int(r['count'])==r['count']
            and isinstance(r.get('byPlan'),dict) and set(r['byPlan'])=={'range','trend'})
        if not valid:
            reasons.append(f'{scenario}:指標缺漏或含非有限數字');continue
        invalid_branch=any(not isinstance(b,dict) or not all(_finite(b.get(k)) for k in ('count','net'))
            or b['count']<0 or int(b['count'])!=b['count'] for b in r['byPlan'].values())
        if invalid_branch:
            reasons.append(f'{scenario}:分支指標缺漏或無效');continue
        if r['count']<minimum or r['net']<=0 or r['withoutBestDay']<=0:
            reasons.append(f'{scenario}:成交不足{minimum}或淨額／去最佳日未正')
        for plan in SCOPES[scope]:
            if branch_minimum is not None and (r['byPlan'][plan]['count']<branch_minimum or r['byPlan'][plan]['net']<=0):
                reasons.append(f'{scenario}:{plan}樣本不足{branch_minimum}或未獲利')
    return reasons


def calibration_check(comparison,scope):
    reasons=_comparison_errors(comparison,scope,20,5)
    return dict(passed=not reasons,reasons=reasons)


def select(trials):
    rankings=[]
    for name,spec in policies().items():
        trial=trials.get(name,{})
        folds=trial.get('folds',[]) if isinstance(trial,dict) else []
        folds=folds if isinstance(folds,list) else []
        reasons=[]
        if len(folds)!=3:
            reasons.append('缺少三個發展折')
        for i,fold in enumerate(folds,1):
            calibration=fold.get('calibration') if isinstance(fold,dict) else None
            if not isinstance(calibration,dict) or calibration.get('passed') is not True:
                reasons.append(f'fold{i}:校準未通過')
            guarded=fold.get('guarded') if isinstance(fold,dict) else None
            reasons += [f'fold{i}:{r}' for r in _comparison_errors(guarded,spec['scope'],30,None)]
        stress=[f.get('guarded',{}).get('stress',{}) for f in folds if isinstance(f,dict)
            and isinstance(f.get('guarded'),dict)]
        rankable=bool(stress) and len(stress)==len(folds) and all(isinstance(r,dict)
            and _finite(r.get('net')) and isinstance(r.get('byPlan'),dict)
            and all(isinstance(r['byPlan'].get(p),dict) and all(_finite(r['byPlan'][p].get(k))
                for k in ('count','net')) for p in SCOPES[spec['scope']]) for r in stress)
        branches={p:dict(count=sum(r['byPlan'][p]['count'] for r in stress),
            net=sum(r['byPlan'][p]['net'] for r in stress)) for p in SCOPES[spec['scope']]} if rankable else {}
        if not rankable or any(b['count']<20 or b['net']<=0 for b in branches.values()):
            reasons.append('啟用方案樣本不足20或未獲利')
        worst=min((r['net'] for r in stress),default=0) if rankable else None
        total=sum(r['net'] for r in stress) if rankable else None
        if rankable and not all(_finite(v) for v in (worst,total)):
            reasons.append('彙總分數無效');worst=total=None
        rankings.append(dict(name=name,eligible=not reasons,reasons=reasons,
            worstStress=worst,stressNet=total))
    rankings.sort(key=lambda r:(r['eligible'],r['worstStress'] if r['worstStress'] is not None else -math.inf,
        r['stressNet'] if r['stressNet'] is not None else -math.inf),reverse=True)
    qualified=[r for r in rankings if r['eligible']]
    return dict(selected=qualified[0]['name'] if qualified else None,eligibleCount=len(qualified),
        rankings=rankings,evaluationUsed=False,executionEnabled=False,adoptionAllowed=False)


def final_check(results,scope):
    if not isinstance(results,dict) or set(results)!={'validation','historical_reused_test'}:
        return dict(passed=False,reasons=['缺少完整驗證／歷史測試期'],adoptionAllowed=False,executionEnabled=False)
    reasons=[]
    for phase,comparison in results.items():
        minimum=30 if phase=='validation' else 100
        reasons += [f'{phase}:{r}' for r in _comparison_errors(comparison,scope,minimum,0 if phase=='validation' else 30)]
    return dict(passed=not reasons,reasons=reasons,adoptionAllowed=False,executionEnabled=False)
