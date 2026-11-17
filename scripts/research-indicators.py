"""Read-only paired indicator study; development selection and frozen evaluation."""
import argparse
import hashlib
from importlib import import_module
import json
from pathlib import Path

import lightgbm as lgb
import numpy as np

from fubon_bridge.indicator_research import (FEATURE_SETS, POLICY, THRESHOLDS,
    augment, fit, model_info, select)
from fubon_bridge.mapping import now
from fubon_bridge.regime_refinement import BASELINE, build_candidates
from fubon_bridge.regime_refinement_model import compare, predict
from fubon_bridge.research import digest
from fubon_bridge.strategy_session import schedule

base=import_module('refine-regime')
ROOT=Path(__file__).resolve().parents[1]
ARTIFACTS=ROOT/'.fubon-dev/reports/indicator-paired-v1'


def hashes():
    paths=[Path(__file__),ROOT/'server/fubon_bridge/indicator_research.py',ROOT/'server/fubon_bridge/regime_refinement_model.py']
    return base.hashes() | {p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in paths}


def save(name,value):
    ARTIFACTS.mkdir(parents=True,exist_ok=True)
    path=ARTIFACTS/name
    if path.exists():
        raise ValueError(f'保留研究結果；請先檢查 {path}')
    path.write_text(value if isinstance(value,str) else json.dumps(value,ensure_ascii=False,indent=2))


def families(data,dates):
    events=build_candidates(data,dates,(BASELINE,))[BASELINE.name]
    return augment(data,events,dates)


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--stage',choices=['development','evaluation'],required=True)
    parser.add_argument('--database',type=Path,default=ROOT/'server/.research.sqlite3')
    args=parser.parse_args()
    sources=base.datasets(args.database)
    implementation=hashes()
    packages=dict(lightgbm=lgb.__version__,numpy=np.__version__)
    if args.stage=='development':
        frozen=dict(createdAt=now().isoformat(),policy=POLICY,implementation=implementation,packages=packages,sessions={})
        for session,(ident,data,dates) in sources.items():
            cuts=[int(len(dates)*f) for f in POLICY['folds']]
            variants=families(data,dates[:cuts[-1]])
            selected={};reports={}
            for name,events in variants.items():
                trials={str(t):dict(folds=[],trainingCounts=[]) for t in THRESHOLDS}
                for a,b in zip(cuts,cuts[1:]):
                    boundary=int(schedule(session).window(dates[a])[0].timestamp())
                    prior=set(dates[:a]);held=set(dates[a:b])
                    training=[e for e in events if e['day'] in prior and e['labelEnd']<boundary]
                    testing=[e for e in events if e['day'] in held]
                    model,count=fit(training,name)
                    scores=predict(model,testing)
                    for threshold in THRESHOLDS:
                        trials[str(threshold)]['folds'].append(compare(testing,BASELINE,dates[a:b],session,scores,threshold))
                        trials[str(threshold)]['trainingCounts'].append(count)
                selection=select(trials)
                model,count=fit(events,name)
                if model is not None:
                    save(f'{session}-{name}-model.txt',model.model_to_string())
                selected[name]=dict(selection=selection,trainingCount=count,model=model_info(model,name))
                reports[name]=dict(trials=trials,selection=selection)
                print(json.dumps(dict(session=session,family=name,selection=selection,model=model_info(model,name)),ensure_ascii=False),flush=True)
            save(f'{session}-development.json',dict(datasetId=ident,families=reports))
            frozen['sessions'][session]=dict(datasetId=ident,families=selected,
                dateSplit=dict(development=dates[:cuts[-1]],validation=dates[cuts[-1]:int(len(dates)*.8)],
                    historical_reused_test=dates[int(len(dates)*.8):]))
        frozen['id']=digest(frozen)
        save('frozen.json',frozen)
    else:
        frozen=json.loads((ARTIFACTS/'frozen.json').read_text())
        if (digest({k:v for k,v in frozen.items() if k!='id'})!=frozen['id'] or frozen['implementation']!=implementation
            or frozen['packages']!=packages or frozen['policy']!=POLICY):
            raise ValueError('凍結程式、套件或研究規格已改變')
        for session,(ident,data,dates) in sources.items():
            spec=frozen['sessions'][session];n=len(dates);a=int(n*.6);b=int(n*.8)
            if spec['datasetId']!=ident or spec['dateSplit']!=dict(development=dates[:a],validation=dates[a:b],historical_reused_test=dates[b:]):
                raise ValueError('資料或精確分割與凍結版本不同')
            variants=families(data,dates[a:]);results={}
            for name,events in variants.items():
                family=spec['families'][name]
                threshold=family['selection']['chosen']['threshold']
                text=(ARTIFACTS/f'{session}-{name}-model.txt').read_text() if family['model'] else None
                if text is not None and hashlib.sha256(text.encode()).hexdigest()!=family['model']['hash']:
                    raise ValueError('模型雜湊不符')
                model=lgb.Booster(model_str=text) if text is not None else None
                results[name]={}
                for period,selected in (('validation',dates[a:b]),('historical_reused_test',dates[b:])):
                    allowed=set(selected)
                    sequence=[e for e in events if e['day'] in allowed]
                    result=compare(sequence,BASELINE,selected,session,predict(model,sequence),threshold)
                    results[name][period]=result
                    print(json.dumps(dict(session=session,family=name,period=period,threshold=threshold,
                        result=base.compact(result)),ensure_ascii=False),flush=True)
            save(f'{session}-evaluation.json',dict(frozenId=frozen['id'],datasetId=ident,results=results,
                executionEnabled=False,adoptionAllowed=False))


if __name__=='__main__':
    main()
