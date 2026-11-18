"""Predeclared structured-signal ablations; read-only datasets, no broker."""
import argparse
import hashlib
from importlib import import_module
import json
from pathlib import Path

import lightgbm as lgb
import numpy as np

from fubon_bridge.mapping import now
from fubon_bridge.research import digest
from fubon_bridge.structured_models import (POLICY as MODEL_POLICY,VARIANTS,
    calibration_check,final_check,fit,policies,predict,select)
from fubon_bridge.structured_research import POLICY,build,compare

base=import_module('refine-regime')
ROOT=Path(__file__).resolve().parents[1]
ARTIFACTS=ROOT/'.fubon-dev/reports/structured-confirmation-v1-verified'


def hashes():
    paths=[Path(__file__),*(ROOT/'server/fubon_bridge'/name for name in
        ('structured_research.py','structured_models.py','opportunity_research.py','indicator_research.py')),
        ROOT/'docs/research/tmf-structured-protocol-v1.md']
    return base.hashes()|{p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in paths}


def save(name,value):
    ARTIFACTS.mkdir(parents=True,exist_ok=True);path=ARTIFACTS/name
    if path.exists():
        raise ValueError(f'保留既有結果：{path}')
    path.write_text(json.dumps(value,ensure_ascii=False,indent=2))


def compact(result):
    return {s:{k:v for k,v in r.items() if k!='trades'} for s,r in result.items()}


def groups(events,dates,metadata,model):
    allowed=set(metadata['calibrationDates'])
    calibration=[a for a in events if a.day in allowed]
    scores={a.key:1. for a in calibration} if model=='rule' else predict(model,calibration)
    return calibration,scores


def develop(data,dates,session):
    cuts=[int(len(dates)*f) for f in MODEL_POLICY['folds']]
    events,quality=build(data,dates[:cuts[-1]])
    trials={name:dict(spec=spec,folds=[]) for name,spec in policies().items()}
    training={name:[] for name in VARIANTS}
    for a,b in zip(cuts,cuts[1:]):
        previous=set(dates[:a]);held=set(dates[a:b])
        prior=[e for e in events if e.day in previous];testing=[e for e in events if e.day in held]
        for name in ('rule',*VARIANTS):
            if name=='rule':
                model='rule';metadata=dict(calibrationDates=dates[int(a*.8):a])
            else:
                model,metadata=fit(prior,dates[:a],session,name)
                training[name].append(metadata)
            calibration,cal_scores=groups(prior,dates[:a],metadata,model)
            scores={e.key:1. for e in testing} if name=='rule' else predict(model,testing)
            for policy,spec in policies().items():
                if spec['model']!=name:
                    continue
                check_result=compare(calibration,cal_scores,metadata['calibrationDates'],spec['scope'],spec['threshold'])
                guard=calibration_check(check_result,spec['scope'])
                raw=compare(testing,scores,dates[a:b],spec['scope'],spec['threshold'])
                guarded=raw if guard['passed'] else compare(testing,scores,dates[a:b],spec['scope'],spec['threshold'],False)
                trials[policy]['folds'].append(dict(calibration=guard,calibrationMetrics=compact(check_result),
                    raw=compact(raw),guarded=compact(guarded)))
            print(json.dumps(dict(session=session,fold=[a,b],model=name,
                fitActions=metadata.get('fitActions'),events=len(testing))),flush=True)
    selection=select(trials);models={};guards={}
    for name in ('rule',*VARIANTS):
        if name=='rule':
            model='rule';metadata=dict(calibrationDates=dates[int(cuts[-1]*.8):cuts[-1]])
        else:
            model,metadata=fit(events,dates[:cuts[-1]],session,name)
            save(f'{session}-{name}-model.json',model)
            models[name]=dict(metadata=metadata,hash=digest(model))
        calibration,scores=groups(events,dates[:cuts[-1]],metadata,model)
        for policy,spec in policies().items():
            if spec['model']==name:
                comparison=compare(calibration,scores,metadata['calibrationDates'],spec['scope'],spec['threshold'])
                guards[policy]=dict(check=calibration_check(comparison,spec['scope']),metrics=compact(comparison),
                    calibrationDates=metadata['calibrationDates'])
    return dict(quality=quality,trials=trials,selection=selection,training=training),models,guards


def main():
    global ARTIFACTS
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--stage',choices=['development','evaluation'],required=True)
    parser.add_argument('--database',type=Path,default=ROOT/'server/.research.sqlite3')
    parser.add_argument('--output',type=Path,default=ARTIFACTS)
    args=parser.parse_args();ARTIFACTS=args.output
    sources=base.datasets(args.database);implementation=hashes()
    packages=dict(lightgbm=lgb.__version__,numpy=np.__version__)
    if args.stage=='development':
        frozen=dict(createdAt=now().isoformat(),policy=POLICY,modelPolicy=MODEL_POLICY,
            implementation=implementation,packages=packages,sessions={})
        for session,(ident,data,dates) in sources.items():
            print(json.dumps(dict(session=session,stage='development')),flush=True)
            report,models,guards=develop(data,dates,session);n=len(dates);a=int(n*.6);b=int(n*.8)
            save(f'{session}-development.json',dict(datasetId=ident,**report))
            frozen['sessions'][session]=dict(datasetId=ident,models=models,guards=guards,selection=report['selection'],
                dateSplit=dict(development=dates[:a],validation=dates[a:b],historical_reused_test=dates[b:]))
            print(json.dumps(dict(session=session,selected=report['selection']['selected'],
                eligible=report['selection']['eligibleCount'],events=report['quality']['events'])),flush=True)
        frozen['id']=digest(frozen);save('frozen.json',frozen)
    else:
        frozen=json.loads((ARTIFACTS/'frozen.json').read_text())
        if (digest({k:v for k,v in frozen.items() if k!='id'})!=frozen['id'] or frozen['implementation']!=implementation
            or frozen['packages']!=packages or frozen['policy']!=POLICY or frozen['modelPolicy']!=MODEL_POLICY):
            raise ValueError('凍結程式／規格／套件已變更')
        for session,(ident,data,dates) in sources.items():
            spec=frozen['sessions'][session];n=len(dates);a=int(n*.6);b=int(n*.8)
            split=dict(development=dates[:a],validation=dates[a:b],historical_reused_test=dates[b:])
            if spec['datasetId']!=ident or spec['dateSplit']!=split:
                raise ValueError('資料或完整日期分割不符')
            events,_=build(data,dates[a:]);results={p:dict(raw={},guarded={}) for p in policies()}
            for name in ('rule',*VARIANTS):
                model='rule' if name=='rule' else json.loads((ARTIFACTS/f'{session}-{name}-model.json').read_text())
                if name!='rule' and digest(model)!=spec['models'][name]['hash']:
                    raise ValueError('模型雜湊不符')
                for phase,selected in (('validation',dates[a:b]),('historical_reused_test',dates[b:])):
                    allowed=set(selected);testing=[e for e in events if e.day in allowed]
                    scores={e.key:1. for e in testing} if name=='rule' else predict(model,testing)
                    for policy,settings in policies().items():
                        if settings['model']!=name:
                            continue
                        raw=compare(testing,scores,selected,settings['scope'],settings['threshold'])
                        passed=spec['guards'][policy]['check']['passed']
                        guarded=raw if passed else compare(testing,scores,selected,settings['scope'],settings['threshold'],False)
                        results[policy]['raw'][phase]=raw;results[policy]['guarded'][phase]=guarded
                print(json.dumps(dict(session=session,stage='frozen-evaluation',model=name)),flush=True)
            checks={p:final_check(r['guarded'],policies()[p]['scope']) for p,r in results.items()}
            raw_checks={p:final_check(r['raw'],policies()[p]['scope']) for p,r in results.items()}
            selected=spec['selection']['selected']
            save(f'{session}-evaluation.json',dict(frozenId=frozen['id'],datasetId=ident,
                selected=selected,results=results,checks=checks,rawDiagnosticChecks=raw_checks,
                qualified=selected is not None and checks[selected]['passed'],
                executionEnabled=False,adoptionAllowed=False,historyReused=True))


if __name__=='__main__':
    main()
