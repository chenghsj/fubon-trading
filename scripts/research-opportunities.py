"""Frozen two-stage action-value research; never instantiates broker or orders."""
import argparse
import hashlib
from importlib import import_module
import json
from pathlib import Path

import lightgbm as lgb
import numpy as np

from fubon_bridge.mapping import now
from fubon_bridge.opportunity_models import (MODELS, POLICY as MODEL_POLICY,
    final_checks, fit, policies, predict, select)
from fubon_bridge.opportunity_research import POLICY, build, compare
from fubon_bridge.research import digest

base=import_module('refine-regime')
ROOT=Path(__file__).resolve().parents[1]
ARTIFACTS=ROOT/'.fubon-dev/reports/opportunity-actions-v1'


def hashes():
    files=[Path(__file__),*(ROOT/'server/fubon_bridge'/name for name in
        ('opportunity_research.py','opportunity_models.py','indicator_research.py')),
        ROOT/'docs/research/tmf-opportunity-protocol-v1.md']
    return base.hashes()|{p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in files}


def save(name,value):
    ARTIFACTS.mkdir(parents=True,exist_ok=True);path=ARTIFACTS/name
    if path.exists():
        raise ValueError(f'保留既有研究結果：{path}')
    path.write_text(value if isinstance(value,str) else json.dumps(value,ensure_ascii=False,indent=2))


def compact(comparison):
    return {scenario:{k:v for k,v in result.items() if k!='trades'} for scenario,result in comparison.items()}


def develop(data,dates,session):
    cuts=[int(len(dates)*f) for f in MODEL_POLICY['folds']]
    actions,quality=build(data,dates[:cuts[-1]])
    trials={name:dict(spec=spec,folds=[]) for name,spec in policies().items()}
    training={name:[] for name in MODELS}
    for a,b in zip(cuts,cuts[1:]):
        before=set(dates[:a]);held=set(dates[a:b])
        prior=[event for event in actions if event.day in before]
        testing=[event for event in actions if event.day in held]
        for model_name in MODELS:
            model,table,metadata=fit(prior,dates[:a],session,model_name)
            training[model_name].append(metadata)
            scores=predict(model,table,testing)
            for name,spec in policies().items():
                if spec['model']==model_name:
                    result=compare(testing,scores[spec['mode']],dates[a:b],spec['threshold'],spec['scope'])
                    trials[name]['folds'].append(compact(result))
            print(json.dumps(dict(session=session,fold=[a,b],model=model_name,
                fitActions=metadata['trainingActions'],calibrationActions=metadata['calibrationActions'])),flush=True)
    selection=select(trials);models={}
    for name in MODELS:
        model,table,metadata=fit(actions,dates[:cuts[-1]],session,name)
        text=model.model_to_string();save(f'{session}-{name}-model.txt',text)
        models[name]=dict(hash=hashlib.sha256(text.encode()).hexdigest(),calibration=table,metadata=metadata)
    return dict(trials=trials,selection=selection,training=training,quality=quality),models


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--stage',choices=['development','evaluation'],required=True)
    parser.add_argument('--database',type=Path,default=ROOT/'server/.research.sqlite3')
    args=parser.parse_args();sources=base.datasets(args.database)
    implementation=hashes();packages=dict(lightgbm=lgb.__version__,numpy=np.__version__)
    if args.stage=='development':
        frozen=dict(createdAt=now().isoformat(),policy=POLICY,modelPolicy=MODEL_POLICY,
            implementation=implementation,packages=packages,sessions={})
        for session,(ident,data,dates) in sources.items():
            print(json.dumps(dict(session=session,stage='building-development',completeDays=len(dates))),flush=True)
            report,models=develop(data,dates,session);n=len(dates);a=int(n*.6);b=int(n*.8)
            save(f'{session}-development.json',dict(datasetId=ident,**report))
            frozen['sessions'][session]=dict(datasetId=ident,models=models,selection=report['selection'],
                dateSplit=dict(development=dates[:a],validation=dates[a:b],historical_reused_test=dates[b:]))
            print(json.dumps(dict(session=session,selection=report['selection']),ensure_ascii=False),flush=True)
        frozen['id']=digest(frozen);save('frozen.json',frozen)
    else:
        frozen=json.loads((ARTIFACTS/'frozen.json').read_text())
        if (digest({k:v for k,v in frozen.items() if k!='id'})!=frozen['id'] or frozen['implementation']!=implementation
            or frozen['packages']!=packages or frozen['policy']!=POLICY or frozen['modelPolicy']!=MODEL_POLICY):
            raise ValueError('凍結程式、套件或研究規格已改變')
        for session,(ident,data,dates) in sources.items():
            spec=frozen['sessions'][session];n=len(dates);a=int(n*.6);b=int(n*.8)
            split=dict(development=dates[:a],validation=dates[a:b],historical_reused_test=dates[b:])
            if spec['datasetId']!=ident or spec['dateSplit']!=split:
                raise ValueError('資料或精確日期分割與凍結版本不符')
            print(json.dumps(dict(session=session,stage='building-frozen-evaluation')),flush=True)
            actions,_=build(data,dates[a:]);results={name:{} for name in policies()}
            for model_name in MODELS:
                stored=spec['models'][model_name];text=(ARTIFACTS/f'{session}-{model_name}-model.txt').read_text()
                if hashlib.sha256(text.encode()).hexdigest()!=stored['hash']:
                    raise ValueError('原生模型雜湊不符')
                model=lgb.Booster(model_str=text)
                for period,selected in (('validation',dates[a:b]),('historical_reused_test',dates[b:])):
                    allowed=set(selected);testing=[e for e in actions if e.day in allowed]
                    scores=predict(model,stored['calibration'],testing)
                    for name,policy in policies().items():
                        if policy['model']==model_name:
                            results[name][period]=compare(testing,scores[policy['mode']],selected,
                                policy['threshold'],policy['scope'])
                    print(json.dumps(dict(session=session,model=model_name,period=period)),flush=True)
            checks={name:final_checks(r['validation'],r['historical_reused_test'],policies()[name]['scope'])
                for name,r in results.items()}
            selected=spec['selection']['selected']
            save(f'{session}-evaluation.json',dict(frozenId=frozen['id'],datasetId=ident,
                selected=selected,results=results,checks=checks,
                qualified=selected is not None and checks[selected]['passed'],
                diagnosticOnly=selected is None,executionEnabled=False,adoptionAllowed=False,
                limitations=['已重用歷史，非全新樣本外證據','費率為假設，未核對實際帳單',
                    '分鐘OHLC成交近似；回撤以分鐘收盤估值','校準保守值為日群聚啟發式，非統計保證']))


if __name__=='__main__':
    main()
