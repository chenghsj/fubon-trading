"""A bounded, recorded model selection protocol; held-out test never selects."""
import hashlib

from .learning_features import build_events, chronological_split, features_for, outcome, policy_for, simulate
from .research import digest
from .strategy_session import schedule

PROTOCOL = 'expanding-3fold-net-v1'
CANDIDATES = [('binary', .4), ('binary', .5), ('binary', .6),
              ('net_return', 0.), ('net_return', 50.), ('net_return', 100.)]


def parameters(kind, base):
    return dict(base, objective='regression_l2' if kind == 'net_return' else 'binary')


def model_policy(session, kind, threshold):
    if (kind, threshold) not in CANDIDATES:
        raise ValueError('研究候選或進場門檻不在固定比較規格內')
    return dict(policy_for(session), threshold=threshold, modelKind=kind, selectionProtocol=PROTOCOL)


def train_walkforward(store, request, progress=lambda *_: None):
    import lightgbm as lgb
    import numpy as np
    from .learning_train import PARAMETERS, implementation_hashes

    data = store.dataset(request.dataset_id)
    session = data.get('strategySession', 'cash')
    features = features_for(session)
    config = request.config.model_dump(mode='json') | dict(taxRounding='per-contract-yuan')
    implementation = implementation_hashes()
    fingerprint = dict(dataset=request.dataset_id, implementation=implementation, config=config,
        features=features, protocol=PROTOCOL, candidates=CANDIDATES, parameters=PARAMETERS,
        rounds=50, lightgbm=lgb.__version__, numpy=np.__version__)
    try:
        return store.run(digest(fingerprint))
    except ValueError:
        pass
    progress('建立整盤事件、成本後收益及日期切分', .05)
    raw, diagnostics = build_events(data)
    events = []
    for event in raw:
        result = outcome(event, config)
        if result is not None:
            events.append(event | dict(y=result['label'], net=result['net'], labelEnd=result['exitTime']))
    parts, split = chronological_split(events, diagnostics['completeDates'], session)
    base_report = dict(strategySession=session, researchMethod='walkforward', implementation=implementation,
        features=features, config=config, source=data['source'], diagnostics=dict(diagnostics,
            labeledEvents=len(events), riskRejectedEvents=len(raw)-len(events)), split=split,
        counts={name: len(p) for name,p in zip(['train','validation','test'], parts)},
        executionEnabled=False, adoptionAllowed=False, metricsPassed=False, status='insufficient',
        reasons=[], comparisons={}, predictions=[], model=None,
        packages=dict(lightgbm=lgb.__version__, numpy=np.__version__))
    dates = diagnostics['completeDates']
    cuts = [int(len(dates)*fraction) for fraction in (.4, .5333333333, .6666666667, .8)]
    if len(parts[0]) < 20 or len({e['y'] for e in parts[0]}) < 2 or len(set(cuts)) < 4:
        base_report.update(policy=policy_for(session), parameters=PARAMETERS, reasons=['滾動研究的訓練事件或完整盤不足'])
        return store.save_run(request.dataset_id, fingerprint, base_report)

    def fit(rows, kind):
        y = [e['net'] if kind == 'net_return' else e['y'] for e in rows]
        training = lgb.Dataset(np.asarray([e['x'] for e in rows],dtype=float), label=y, feature_name=features)
        return lgb.train(parameters(kind, PARAMETERS), training, num_boost_round=50)

    def predict(model, rows):
        return model.predict(np.asarray([e['x'] for e in rows],dtype=float),num_threads=2).tolist() if rows else []

    # Three causal validation folds lie entirely before the final 20% test.
    # Each model sees labels ending strictly before that fold's opening time.
    folds = []
    predictions = {candidate: {} for candidate in CANDIDATES}
    sequences = []
    fold_results = {candidate: [] for candidate in CANDIDATES}
    for index, (start,end) in enumerate(zip(cuts,cuts[1:])):
        held_dates = set(dates[start:end])
        boundary = schedule(session).window(dates[start])[0].timestamp()
        training = [e for e in events if e['day'] in set(dates[:start]) and e['labelEnd'] < boundary]
        sequence = [e for e in raw if e['day'] in held_dates]
        if len(training) < 20 or len({e['y'] for e in training}) < 2:
            raise ValueError('滾動分割內缺少足夠的雙類標籤，請補資料')
        sequences.extend(sequence)
        folds.append(dict(trainStart=dates[0], trainEnd=dates[start-1], validationStart=dates[start],
            validationEnd=dates[end-1], trainingEvents=len(training), validationEvents=len(sequence)))
        progress(f'滾動驗證 {index+1}/3：比較分類／淨收益模型', .15+index*.2)
        for kind in ('binary','net_return'):
            model = fit(training, kind)
            scores = dict(zip([e['time'] for e in sequence], predict(model,sequence)))
            for candidate in [c for c in CANDIDATES if c[0] == kind]:
                accepted = {time: float(score >= candidate[1]) for time,score in scores.items()}
                predictions[candidate].update(accepted)
                fold_results[candidate].append(dict(normal=simulate(sequence,config,accepted),
                    stress=simulate(sequence,config,accepted,2)))

    comparisons = []
    for kind,threshold in CANDIDATES:
        key = (kind,threshold)
        normal = simulate(sequences,config,predictions[key])
        stress = simulate(sequences,config,predictions[key],2)
        results = fold_results[key]
        passed = (normal['count'] >= 20 and normal['net'] > 0 and stress['net'] > 0
            and all(f['normal']['count'] >= 5 and f['normal']['net'] > 0 and f['stress']['net'] > 0 for f in results))
        comparisons.append(dict(kind=kind,threshold=threshold,normal=normal,stress=stress,
            folds=results,passed=passed))
    # The ranking and eligibility use rolling validation only. All attempts,
    # including failures, are retained; changing this protocol changes its hash.
    eligible = [c for c in comparisons if c['passed']]
    selection_pool = eligible or comparisons
    chosen = max(selection_pool,key=lambda c: c['stress']['net']-.5*c['normal']['maxDrawdown'])
    kind,threshold = chosen['kind'],chosen['threshold']
    progress('固定候選並僅用前60%資料建立最終模型', .8)
    model = fit(parts[0],kind)
    text = model.model_to_string()
    report = base_report | dict(policy=model_policy(session,kind,threshold),parameters=parameters(kind,PARAMETERS),
        modelKind=kind,entryThreshold=threshold,status='diagnostic',
        selection=dict(protocol=PROTOCOL, folds=folds, candidates=comparisons,
            selected=dict(kind=kind,threshold=threshold),passed=bool(eligible),
            ranking='rolling stress net - 0.5 * rolling normal drawdown; final test excluded'),
        model=dict(hash=hashlib.sha256(text.encode()).hexdigest(),bytes=len(text.encode()),
            splitCount=int(model.feature_importance(importance_type='split').sum()),
            importance=dict(zip(features,[float(v) for v in model.feature_importance(importance_type='gain')]))))
    gates = []
    for name,values in [('validation',parts[1]),('test',parts[2])]:
        held_dates = set(split[name+'Dates'])
        sequence = [e for e in raw if e['day'] in held_dates]
        scores = dict(zip([e['time'] for e in sequence],predict(model,sequence)))
        accepted = {time:float(score >= threshold) for time,score in scores.items()}
        base,filtered = simulate(sequence,config),simulate(sequence,config,accepted)
        stress_base,stress = simulate(sequence,config,extra_slippage=2),simulate(sequence,config,accepted,2)
        report['comparisons'][name] = dict(baseline=base,filtered=filtered,stressBaseline=stress_base,
            stressFiltered=stress,accuracy=None,brier=None,scoreCalibrated=False)
        report['predictions'] += [dict(time=e['time'],side=e['side'],score=scores[e['time']],label=e['y']) for e in values][-20:]
        gates.append(filtered['count'] >= 5 and filtered['net'] > 0 and stress['net'] > 0
            and filtered['net'] > base['net'] and filtered['maxDrawdown'] <= base['maxDrawdown'])
    report['metricsPassed'] = bool(eligible) and all(gates)
    report['reasons'] = ([] if eligible else ['6個固定候選沒有同時通過三段滾動淨利／壓力與最低成交數門檻；保留診斷版本'])
    if not all(gates):
        report['reasons'].append('最終固定模型的驗證或測試未通過成本後收益、回撤與成交數比較')
    report['reasons'] += ['候選門檻由滾動驗證選取；重複看過的歷史測試不再是全新樣本，仍須新日期Paper前測',
        '收益模型分數為預估成本後淨收益，分類模型分數未校準為勝率；均不核准正式交易']
    progress('保存全部候選、最終回測與原生模型',1)
    return store.save_run(request.dataset_id,fingerprint,report,text)
