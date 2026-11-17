"""Frozen learned scorer for the same seven research-only rule candidates."""
import hashlib

from .learning_features import outcome, simulate
from .regime_refinement import (CANDIDATES, CONFIG, POLICY as RULE_POLICY,
    accepted_events, summarize)
from .regime_strategy import FEATURES

THRESHOLDS = (0.,50.,100.)
PARAMETERS = dict(objective='regression_l2', num_leaves=7, max_depth=3,
    learning_rate=.03, min_data_in_leaf=30, lambda_l2=10., verbosity=-1,
    seed=42, num_threads=2, deterministic=True, force_col_wise=True)
ROUNDS = 100
POLICY = dict(protocol='refinement-net-scorer-development-only-v1', rulePolicy=RULE_POLICY,
    thresholds=list(THRESHOLDS), parameters=PARAMETERS, rounds=ROUNDS,
    features=FEATURES, minimumTrainingEvents=60,
    selection='eligible first; worst-fold stress net; stress net minus half normal close-mark drawdown',
    additionalEligibility='every delayed fold positive',
    executionEnabled=False,adoptionAllowed=False)


def fit(events, candidate):
    import lightgbm as lgb
    import numpy as np
    eligible=accepted_events(events,candidate)
    rows=[(e,outcome(e,CONFIG)) for e in eligible]
    rows=[(e,r) for e,r in rows if r is not None]
    if len(rows)<60:
        return None, len(rows)
    training=lgb.Dataset(np.asarray([e['x'] for e,_ in rows],dtype=float),
        label=[r['net'] for _,r in rows], feature_name=FEATURES)
    return lgb.train(PARAMETERS,training,num_boost_round=ROUNDS),len(rows)


def predict(model, events):
    import numpy as np
    if model is None:
        return dict.fromkeys([e['time'] for e in events], float('-inf'))
    if not events:
        return {}
    values=model.predict(np.asarray([e['x'] for e in events],dtype=float),num_threads=2)
    return {e['time']:float(value) for e,value in zip(events,values)}


def compare(events,candidate,dates,session,scores,threshold):
    result={}
    selected=[e for e in events if scores[e['time']]>=threshold]
    for name,extra,delay in (('normal',0,0),('stress',2,0),('delayed',0,1)):
        eligible=accepted_events(selected,candidate,extra,delay)
        value=simulate(eligible,CONFIG,extra_slippage=extra)
        for trade in value['trades']:
            if trade['reason']=='20分鐘／日內期限':
                trade['reason']=f'{candidate.horizon}分鐘／日內期限'
        result[name]=summarize(dict(value,strategySession=session),dates)
    return result


def select(development):
    from .regime_refinement import select as select_rules
    rankings=[]
    for threshold in THRESHOLDS:
        groups={c.name:development[c.name][str(threshold)]['folds'] for c in CANDIDATES}
        for result in select_rules(groups)['rankings']:
            delayed_ok=all(f['delayed']['net']>0 for f in groups[result['name']])
            rankings.append(dict(result,threshold=threshold,eligible=result['eligible'] and delayed_ok))
    chosen=max(rankings,key=lambda r:(r['eligible'],r['worstFoldStressNet'],r['score']))
    return dict(chosen=chosen,rankings=rankings,eligible=chosen['eligible'],
        executionEnabled=False,adoptionAllowed=False,evaluationUsed=False)


def model_info(model):
    if model is None:
        return None
    text=model.model_to_string()
    return dict(hash=hashlib.sha256(text.encode()).hexdigest(),
        bytes=len(text.encode()),splitCount=int(model.feature_importance(importance_type='split').sum()),
        importance=dict(zip(FEATURES,[float(v) for v in model.feature_importance(importance_type='gain')])))
