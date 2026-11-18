"""Fit and freeze scorers using development data only; evaluate separately."""
import argparse
import hashlib
from importlib import import_module
import json
from pathlib import Path

import lightgbm as lgb
import numpy as np

from fubon_bridge.mapping import now
from fubon_bridge.regime_refinement import BASELINE, CANDIDATES, build_candidates
from fubon_bridge.regime_refinement_model import (POLICY, THRESHOLDS, compare,
    fit, model_info, predict, select)
from fubon_bridge.research import digest
from fubon_bridge.strategy_session import schedule

base=import_module('refine-regime')
ROOT=Path(__file__).resolve().parents[1]
ARTIFACTS=ROOT/'.fubon-dev/reports/refinement-model-v1'


def hashes():
    paths=[Path(__file__), ROOT/'server/fubon_bridge/regime_refinement_model.py']
    return base.hashes() | {p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in paths}


def save(name,value):
    ARTIFACTS.mkdir(parents=True,exist_ok=True)
    path=ARTIFACTS/name
    if path.exists():
        raise ValueError(f'保留既有研究紀錄；請先檢查 {path}')
    path.write_text(value if isinstance(value,str) else json.dumps(value,ensure_ascii=False,indent=2))


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
            cuts=[int(len(dates)*f) for f in (.3,.4,.5,.6)]
            raw=build_candidates(data,dates[:cuts[-1]],CANDIDATES)
            development={}
            for candidate in CANDIDATES:
                development[candidate.name]={str(t):dict(folds=[],trainingCounts=[]) for t in THRESHOLDS}
                for a,b in zip(cuts,cuts[1:]):
                    boundary=int(schedule(session).window(dates[a])[0].timestamp())
                    prior=set(dates[:a]);held=set(dates[a:b])
                    training=[e for e in raw[candidate.name] if e['day'] in prior and e['labelEnd']<boundary]
                    testing=[e for e in raw[candidate.name] if e['day'] in held]
                    model,count=fit(training,candidate)
                    scores=predict(model,testing)
                    for threshold in THRESHOLDS:
                        row=development[candidate.name][str(threshold)]
                        row['folds'].append(compare(testing,candidate,dates[a:b],session,scores,threshold))
                        row['trainingCounts'].append(count)
                print(json.dumps(dict(session=session,candidate=candidate.name,
                    thresholds={t:[base.compact(f) for f in row['folds']] for t,row in development[candidate.name].items()}),ensure_ascii=False),flush=True)
            selection=select(development)
            save(f'{session}-development.json',dict(datasetId=ident,development=development,selection=selection))
            chosen=next(c for c in CANDIDATES if c.name==selection['chosen']['name'])
            model,count=fit(raw[chosen.name],chosen)
            if model is not None:
                save(f'{session}-model.txt',model.model_to_string())
            frozen['sessions'][session]=dict(datasetId=ident,selection=selection,trainingCount=count,model=model_info(model),
                dateSplit=dict(development=dates[:cuts[-1]],validation=dates[cuts[-1]:int(len(dates)*.8)],
                    historical_reused_test=dates[int(len(dates)*.8):]))
            print(json.dumps(dict(session=session,selection=selection,model=model_info(model)),ensure_ascii=False),flush=True)
        frozen['id']=digest(frozen)
        save('frozen.json',frozen)
    else:
        frozen=json.loads((ARTIFACTS/'frozen.json').read_text())
        if (digest({k:v for k,v in frozen.items() if k!='id'})!=frozen['id'] or frozen['implementation']!=implementation
            or frozen['packages']!=packages or frozen['policy']!=POLICY):
            raise ValueError('凍結候選、套件、程式或規格已改變')
        for session,(ident,data,dates) in sources.items():
            spec=frozen['sessions'][session];n=len(dates);a=int(n*.6);b=int(n*.8)
            if spec['datasetId']!=ident or spec['dateSplit']!=dict(development=dates[:a],validation=dates[a:b],historical_reused_test=dates[b:]):
                raise ValueError('資料版本或精確日期分割已改變')
            candidate=next(c for c in CANDIDATES if c.name==spec['selection']['chosen']['name'])
            threshold=spec['selection']['chosen']['threshold']
            text=(ARTIFACTS/f'{session}-model.txt').read_text() if spec['model'] else None
            if text is not None and hashlib.sha256(text.encode()).hexdigest()!=spec['model']['hash']:
                raise ValueError('模型檔雜湊不符')
            model=lgb.Booster(model_str=text) if text is not None else None
            raw=build_candidates(data,dates[a:],(candidate,BASELINE));results={}
            for period,selected in (('validation',dates[a:b]),('historical_reused_test',dates[b:])):
                allowed=set(selected)
                events=[e for e in raw[candidate.name] if e['day'] in allowed]
                result=compare(events,candidate,selected,session,predict(model,events),threshold)
                original=[e for e in raw[BASELINE.name] if e['day'] in allowed]
                reference=base.compare(original,BASELINE,selected,session)
                results[period]=dict(filtered=result,original=reference)
                print(json.dumps(dict(session=session,period=period,candidate=candidate.name,threshold=threshold,
                    filtered=base.compact(result)),ensure_ascii=False),flush=True)
            save(f'{session}-evaluation.json',dict(frozenId=frozen['id'],datasetId=ident,selection=spec,results=results,
                executionEnabled=False,adoptionAllowed=False))


if __name__=='__main__':
    main()
