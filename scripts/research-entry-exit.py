"""Predeclared signal/exit study. Reads immutable snapshots; no broker or orders."""
import argparse
from importlib import import_module
import hashlib
import json
from pathlib import Path

import lightgbm as lgb
import numpy as np

from fubon_bridge.candle_patterns import action_shapes, boundary
from fubon_bridge.confirmed_execution import POLICY as EXECUTION_POLICY, VARIANTS, build, compare
from fubon_bridge.confirmed_models import (POLICY as MODEL_POLICY, block_interval,
    fit, policies, predict, select)
from fubon_bridge.mapping import now
from fubon_bridge.pattern_transfer import partition, pretrain, predict as parent_predict
from fubon_bridge.research import digest
from fubon_bridge.structured_models import calibration_check, final_check

base=import_module('refine-regime');parent=import_module('research-pattern-transfer')
ROOT=Path(__file__).resolve().parents[1]
ARTIFACTS=ROOT/'.fubon-dev/reports/confirmed-entry-exit-v1'
REFERENCE=ROOT/'.fubon-dev/reports/stock-pattern-transfer-v1-corrected'


def hashes():
    paths=[Path(__file__),*(ROOT/'server/fubon_bridge'/name for name in
        ('confirmed_execution.py','confirmed_models.py')),
        ROOT/'docs/research/tmf-entry-exit-protocol-v1.md']
    return parent.hashes()|{p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in paths}


def save(name,value):
    ARTIFACTS.mkdir(parents=True,exist_ok=True)
    with (ARTIFACTS/name).open('x') as stream:
        json.dump(value,stream,ensure_ascii=False,indent=2,allow_nan=False)


def compact(comparison):
    return {s:{k:v for k,v in r.items() if k!='trades'} for s,r in comparison.items()}


def scored(model,events,shapes):
    return {a.key:1. for a in events} if model=='rule' else predict(model,events,shapes)


def calibrate(model,events,metadata,shapes):
    allowed=set(metadata['calibrationDates']);chosen=[a for a in events if a.day in allowed]
    return chosen,scored(model,chosen,shapes)


def development(data,dates,session,auxiliary):
    cuts=[int(len(dates)*f) for f in MODEL_POLICY['folds']]
    events,quality=build(data,dates[:cuts[-1]])
    shapes=action_shapes([a for rows in events.values() for a in rows])
    trials={p:dict(spec=s,folds=[]) for p,s in policies().items()};training={v:[] for v in VARIANTS}
    for a,b in zip(cuts,cuts[1:]):
        cutoff=boundary(partition(dates[:a])[1][0])
        aux,aux_meta=pretrain(auxiliary,'pooled-pretrain',cutoff)
        before=set(dates[:a]);held=set(dates[a:b])
        for variant in VARIANTS:
            prior=[e for e in events[variant] if e.day in before]
            testing=[e for e in events[variant] if e.day in held]
            model,metadata=fit(prior,dates[:a],session,aux,aux_meta,shapes)
            training[variant].append(metadata)
            for filter_name,filter_model in (('rule','rule'),('tree',model)):
                calibration,cal_scores=calibrate(filter_model,prior,metadata,shapes)
                scores=scored(filter_model,testing,shapes)
                for policy,spec in policies().items():
                    if spec['variant']!=variant or (spec['model']=='rule')!=(filter_name=='rule'):
                        continue
                    metrics=compare(calibration,cal_scores,metadata['calibrationDates'],spec['scope'],spec['threshold'])
                    guard=calibration_check(metrics,spec['scope'])
                    raw=compare(testing,scores,dates[a:b],spec['scope'],spec['threshold'])
                    guarded=raw if guard['passed'] else compare(testing,scores,dates[a:b],spec['scope'],spec['threshold'],False)
                    trials[policy]['folds'].append(dict(calibration=guard,calibrationMetrics=compact(metrics),
                        raw=compact(raw),guarded=compact(guarded)))
            print(json.dumps(dict(session=session,fold=[a,b],variant=variant,
                fitActions=metadata['fitActions'],events=len(testing))),flush=True)
    selection=select(trials);models={};guards={}
    cutoff=boundary(partition(dates[:cuts[-1]])[1][0]);aux,aux_meta=pretrain(auxiliary,'pooled-pretrain',cutoff)
    for variant in VARIANTS:
        model,metadata=fit(events[variant],dates[:cuts[-1]],session,aux,aux_meta,shapes)
        save(f'{session}-{variant}-model.json',model)
        models[variant]=dict(metadata=metadata,hash=digest(model))
        for filter_name,filter_model in (('rule','rule'),('tree',model)):
            calibration,scores=calibrate(filter_model,events[variant],metadata,shapes)
            for policy,spec in policies().items():
                if spec['variant']==variant and (spec['model']=='rule')==(filter_name=='rule'):
                    metrics=compare(calibration,scores,metadata['calibrationDates'],spec['scope'],spec['threshold'])
                    guards[policy]=dict(check=calibration_check(metrics,spec['scope']),metrics=compact(metrics),
                        calibrationDates=metadata['calibrationDates'])
        print(json.dumps(dict(session=session,stage='final-fit',variant=variant,fitActions=metadata['fitActions'])),flush=True)
    return dict(quality=quality,trials=trials,selection=selection,training=training),models,guards


def baseline(data,dates,session,reference,events,shapes):
    old=json.loads((REFERENCE/f'{session}-evaluation.json').read_text())
    spec=reference['sessions'][session]
    model=json.loads((REFERENCE/f'{session}-pooled-pretrain-model.json').read_text())
    if digest(model)!=spec['models']['pooled-pretrain']['hash']:
        raise ValueError('父版本原生模型雜湊不符')
    checks={}
    for phase,chosen in (('validation',dates[int(len(dates)*.6):int(len(dates)*.8)]),
        ('historical_reused_test',dates[int(len(dates)*.8):])):
        allowed=set(chosen);testing=[a for a in events if a.day in allowed]
        for name,old_model in (('rule','rule'),('pooled-pretrain',model)):
            scores={a.key:1. for a in testing} if name=='rule' else parent_predict(old_model,testing,shapes)
            for scope in ('hybrid','range','trend'):
                for threshold in ((0.,) if name=='rule' else (0.,30.)):
                    key=f'rule-{scope}' if name=='rule' else f'{name}-{int(threshold)}-{scope}'
                    result=compare(testing,scores,chosen,scope,threshold)
                    if result!=old['results'][key]['raw'][phase]:
                        raise ValueError(f'舊訊號／模型／成交未完整重現：{session}/{key}/{phase}')
                    checks.setdefault(key,{})[phase]=True
    return checks


def main():
    global ARTIFACTS
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--stage',choices=['development','evaluation'],required=True)
    parser.add_argument('--database',type=Path,default=ROOT/'server/.research.sqlite3')
    parser.add_argument('--output',type=Path,default=ARTIFACTS)
    args=parser.parse_args();ARTIFACTS=args.output
    sources=base.datasets(args.database);stocks=parent.stock_data(args.database);implementation=hashes()
    reference=json.loads((REFERENCE/'frozen.json').read_text());packages=dict(lightgbm=lgb.__version__,numpy=np.__version__)
    if digest({k:v for k,v in reference.items() if k!='id'})!=reference['id']:
        raise ValueError('父版本凍結無效')
    if any(implementation.get(k)!=v for k,v in reference['implementation'].items()):
        raise ValueError('父版本程式或規格已變更')
    if args.stage=='development':
        auxiliary,quality=parent.auxiliary_rows(stocks,sources)
        frozen=dict(createdAt=now().isoformat(),parentFrozen=reference['id'],implementation=implementation,
            packages=packages,executionPolicy=EXECUTION_POLICY,modelPolicy=MODEL_POLICY,
            stockDatasetId=parent.STOCK_DATASET,auxiliaryQuality=quality,sessions={})
        for session,(ident,data,dates) in sources.items():
            if reference['sessions'][session]['datasetId']!=ident:
                raise ValueError('固定微台快照已改變')
            report,models,guards=development(data,dates,session,auxiliary)
            save(f'{session}-development.json',dict(datasetId=ident,**report))
            a=int(len(dates)*.6);b=int(len(dates)*.8)
            frozen['sessions'][session]=dict(datasetId=ident,models=models,guards=guards,selection=report['selection'],
                dateSplit=dict(development=dates[:a],validation=dates[a:b],historical_reused_test=dates[b:]))
        frozen['id']=digest(frozen);save('frozen.json',frozen)
        print(json.dumps(dict(stage='frozen',id=frozen['id'])),flush=True)
    else:
        frozen=json.loads((ARTIFACTS/'frozen.json').read_text())
        if (digest({k:v for k,v in frozen.items() if k!='id'})!=frozen['id'] or frozen['implementation']!=implementation
            or frozen['packages']!=packages or frozen['parentFrozen']!=reference['id']
            or frozen['executionPolicy']!=json.loads(json.dumps(EXECUTION_POLICY)) or frozen['modelPolicy']!=MODEL_POLICY
            or frozen['stockDatasetId']!=parent.STOCK_DATASET):
            raise ValueError('凍結資料／程式／套件／規格已改變')
        for session,(ident,data,dates) in sources.items():
            spec=frozen['sessions'][session];a=int(len(dates)*.6);b=int(len(dates)*.8)
            split=dict(development=dates[:a],validation=dates[a:b],historical_reused_test=dates[b:])
            if spec['datasetId']!=ident or spec['dateSplit']!=split:
                raise ValueError('完整日期或快照不同')
            events,quality=build(data,dates[a:]);shapes=action_shapes([e for rows in events.values() for e in rows])
            matched=baseline(data,dates,session,reference,events['legacy'],shapes)
            results={p:dict(raw={},guarded={}) for p in policies()}
            for variant in VARIANTS:
                model=json.loads((ARTIFACTS/f'{session}-{variant}-model.json').read_text())
                if digest(model)!=spec['models'][variant]['hash']:
                    raise ValueError('模型雜湊不符')
                for phase,chosen in (('validation',dates[a:b]),('historical_reused_test',dates[b:])):
                    allowed=set(chosen);testing=[e for e in events[variant] if e.day in allowed]
                    for filter_name,filter_model in (('rule','rule'),('tree',model)):
                        scores=scored(filter_model,testing,shapes)
                        for policy,settings in policies().items():
                            if settings['variant']!=variant or (settings['model']=='rule')!=(filter_name=='rule'):
                                continue
                            raw=compare(testing,scores,chosen,settings['scope'],settings['threshold'])
                            passed=spec['guards'][policy]['check']['passed']
                            guarded=raw if passed else compare(testing,scores,chosen,settings['scope'],settings['threshold'],False)
                            results[policy]['raw'][phase]=raw;results[policy]['guarded'][phase]=guarded
                print(json.dumps(dict(session=session,stage='evaluation',variant=variant)),flush=True)
            checks={p:final_check(r['guarded'],policies()[p]['scope']) for p,r in results.items()}
            raw_checks={p:final_check(r['raw'],policies()[p]['scope']) for p,r in results.items()}
            selected=spec['selection']['selected'];diagnostics={}
            fixed=[f'{v}-tree-0-hybrid' for v in VARIANTS]
            for policy in dict.fromkeys(fixed+([selected] if selected else [])):
                diagnostics[policy]={phase:{s:block_interval(v['dates']) for s,v in comparison.items()}
                    for phase,comparison in results[policy]['raw'].items()}
            save(f'{session}-evaluation.json',dict(frozenId=frozen['id'],datasetId=ident,parentReplayMatched=matched,
                quality=quality,selected=selected,results=results,checks=checks,rawDiagnosticChecks=raw_checks,
                diagnosticIntervals=diagnostics,qualified=selected is not None and checks[selected]['passed'],
                executionEnabled=False,adoptionAllowed=False,historyReused=True))


if __name__=='__main__':
    main()
