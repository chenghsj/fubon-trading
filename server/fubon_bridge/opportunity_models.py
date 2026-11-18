"""Time-ordered action-value models and day-cluster calibration. Research only."""
from bisect import bisect_right
from collections import Counter, defaultdict
import math
from statistics import mean, stdev

from .opportunity_research import FEATURES, SCOPES, outcome
from .strategy_session import schedule

PARAMETERS = dict(objective='regression',metric='l2',learning_rate=.03,
    verbosity=-1,seed=42,num_threads=2,deterministic=True,force_col_wise=True,
    max_bin=63,feature_fraction=1.,bagging_fraction=1.,bagging_freq=0)
MODELS = dict(small=dict(num_leaves=7,max_depth=3,min_data_in_leaf=100,lambda_l2=30.),
    flexible=dict(num_leaves=15,max_depth=4,min_data_in_leaf=200,lambda_l2=50.))
ROUNDS = 150
BINS = [-100.,-50.,0.,30.,60.,100.,200.]
THRESHOLDS = [0.,30.,60.]
POLICY = dict(version='action-value-selection-v1',models=MODELS,parameters=PARAMETERS,
    rounds=ROUNDS,fitFraction=.8,calibrationBins=BINS,calibrationMinimumDays=10,
    calibrationValue='mean of daily mean net minus one daily standard error',
    insufficientCalibration='reject; no raw-score fallback',scoreModes=['raw','calibrated'],
    thresholds=THRESHOLDS,scopes=list(SCOPES),policyCount=36,
    folds=[.3,.4,.5,.6],developmentMinimumTradesPerFold=30,
    developmentMinimumTradesPerPlan=20,finalMinimumTestTrades=100,
    finalMinimumTestTradesPerPlan=30,allScenariosMustProfit=True,
    trainingWeights='equal total weight per opening date',refitAfterCalibration=False,
    noQualifiedCandidate=None,selectionUsesFinalEvaluation=False,
    historyAlreadyReused=True,executionEnabled=False,adoptionAllowed=False)


def policies():
    return {f'{model}-{mode}-{int(threshold)}-{scope}':dict(model=model,mode=mode,
        threshold=threshold,scope=scope) for model in MODELS for mode in POLICY['scoreModes']
        for threshold in THRESHOLDS for scope in SCOPES}


def labels(actions):
    rows=[]
    for action in actions:
        result=outcome(action)
        if result is not None:
            rows.append((action,result['net']))
    return rows


def bin_key(action,score):
    return f'{action.plan}:{action.side}:{bisect_right(BINS,score)}'


def calibrate(rows,scores):
    clusters=defaultdict(lambda:defaultdict(list))
    for (action,net),score in zip(rows,scores,strict=True):
        if not math.isfinite(float(score)):
            raise ValueError('模型預測無效')
        clusters[bin_key(action,float(score))][action.day].append(net)
    table={}
    for key,days in clusters.items():
        values=[mean(v) for v in days.values()];n=len(values)
        standard_error=stdev(values)/math.sqrt(n) if n>1 else None
        lower=mean(values)-standard_error if n>=10 else None
        table[key]=dict(days=n,actions=sum(map(len,days.values())),meanDailyNet=mean(values),
            dailyStandardError=standard_error,value=lower)
    return table


def fit(actions,dates,session,model_name):
    """Fit on the prefix, calibrate its unchanged booster on the later prefix."""
    import lightgbm as lgb
    import numpy as np
    if len(dates)<15:
        raise ValueError('至少需要15個完整開盤日供訓練與獨立校準')
    cut=int(len(dates)*POLICY['fitFraction'])
    boundary=int(schedule(session).window(dates[cut])[0].timestamp())
    end=int(schedule(session).window(dates[-1])[1].timestamp())
    training_days=set(dates[:cut]);calibration_days=set(dates[cut:])
    training=labels(a for a in actions if a.day in training_days and a.label_end<boundary)
    calibration=labels(a for a in actions if a.day in calibration_days and a.label_end<end)
    if len(training)<100 or not calibration:
        raise ValueError('沒有足夠的可執行動作標籤')
    counts=Counter(a.day for a,_ in training)
    weights=[len(training)/(len(counts)*counts[a.day]) for a,_ in training]
    matrix=np.asarray([a.x for a,_ in training],dtype=np.float32)
    dataset=lgb.Dataset(matrix,label=[net for _,net in training],weight=weights,feature_name=FEATURES)
    model=lgb.train(PARAMETERS|MODELS[model_name],dataset,num_boost_round=ROUNDS)
    predictions=model.predict(np.asarray([a.x for a,_ in calibration],dtype=np.float32),num_threads=2)
    table=calibrate(calibration,predictions)
    metadata=dict(fitDates=dates[:cut],calibrationDates=dates[cut:],trainingActions=len(training),
        calibrationActions=len(calibration),maximumFitLabelEnd=max(a.label_end for a,_ in training),
        calibrationStart=boundary,maximumCalibrationLabelEnd=max(a.label_end for a,_ in calibration),
        calibrationEnd=end,splitCount=int(model.feature_importance(importance_type='split').sum()),
        featureImportance=dict(zip(FEATURES,map(float,model.feature_importance(importance_type='gain')))))
    return model,table,metadata


def predict(model,table,actions):
    import numpy as np
    if not actions:
        return dict(raw={},calibrated={})
    if len({a.key for a in actions})!=len(actions):
        raise ValueError('同分鐘的方向／退出方案動作鍵重複')
    values=model.predict(np.asarray([a.x for a in actions],dtype=np.float32),num_threads=2)
    if not all(math.isfinite(float(v)) for v in values):
        raise ValueError('模型預測無效')
    raw={a.key:float(v) for a,v in zip(actions,values,strict=True)}
    calibrated={a.key:table.get(bin_key(a,float(v)),{}).get('value')
        for a,v in zip(actions,values,strict=True)}
    return dict(raw=raw,calibrated=calibrated)


def select(trials):
    rankings=[]
    for name,spec in policies().items():
        folds=trials[name]['folds'];reasons=[]
        if len(folds)!=3:
            reasons.append('需要三個完整發展折')
        for i,fold in enumerate(folds,1):
            if fold['normal']['count']<30:
                reasons.append(f'fold{i}:成交少於30')
            for scenario,result in fold.items():
                if result['net']<=0:
                    reasons.append(f'fold{i}:{scenario}未獲利')
        branches={plan:dict(count=sum(f['stress']['byPlan'][plan]['count'] for f in folds),
            net=sum(f['stress']['byPlan'][plan]['net'] for f in folds)) for plan in SCOPES[spec['scope']]}
        if any(b['count']<20 or b['net']<=0 for b in branches.values()):
            reasons.append('啟用的退出方案在壓力情境缺樣本或未獲利')
        rankings.append(dict(name=name,eligible=not reasons,reasons=reasons,branches=branches,
            worstFoldStressNet=min((f['stress']['net'] for f in folds),default=0),
            stressNet=sum(f['stress']['net'] for f in folds)))
    rankings.sort(key=lambda r:(r['eligible'],r['worstFoldStressNet'],r['stressNet']),reverse=True)
    qualified=[r for r in rankings if r['eligible']]
    return dict(selected=qualified[0]['name'] if qualified else None,rankings=rankings,
        eligibleCount=len(qualified),evaluationUsed=False,executionEnabled=False,adoptionAllowed=False)


def final_checks(validation,test,scope):
    reasons=[]
    if validation['normal']['count']<30 or test['normal']['count']<100:
        reasons.append('驗證少於30筆或歷史測試少於100筆')
    for name,period in (('validation',validation),('historical_reused_test',test)):
        for scenario,result in period.items():
            if result['net']<=0 or result['withoutBestDay']<=0:
                reasons.append(f'{name}:{scenario}未獲利或依賴最佳單日')
            for plan in SCOPES[scope]:
                if result['byPlan'][plan]['net']<=0:
                    reasons.append(f'{name}:{scenario}:{plan}未獲利')
    if any(test['normal']['byPlan'][p]['count']<30 for p in SCOPES[scope]):
        reasons.append('歷史測試每個啟用退出方案少於30筆')
    return dict(passed=not reasons,reasons=reasons,adoptionAllowed=False,executionEnabled=False)
