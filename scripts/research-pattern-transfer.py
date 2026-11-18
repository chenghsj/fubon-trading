"""Offline two-stage stock/TMF candle transfer study. Never instantiates a broker."""
import argparse
from importlib import import_module
import hashlib
import json
from pathlib import Path
import sqlite3
import zlib

import lightgbm as lgb
import numpy as np

from fubon_bridge.candle_patterns import action_shapes, boundary, future_days, samples, stock_days
from fubon_bridge.mapping import now
from fubon_bridge.pattern_transfer import POLICY, VARIANTS, fit, partition, policies, predict, select
from fubon_bridge.research import digest
from fubon_bridge.structured_models import calibration_check, final_check
from fubon_bridge.structured_research import POLICY as SIGNAL_POLICY, build, compare

base=import_module('refine-regime')
ROOT=Path(__file__).resolve().parents[1]
ARTIFACTS=ROOT/'.fubon-dev/reports/stock-pattern-transfer-v1-corrected'
REFERENCE=ROOT/'.fubon-dev/reports/structured-expectation-v2'
STOCK_DATASET='73d177d6ca536905bec790b3e91ed290fbfcaee3d4774b0c69cbe61705ff23cc'


def hashes():
    paths=[Path(__file__),*(ROOT/'server/fubon_bridge'/name for name in (
        'candle_patterns.py','pattern_transfer.py','structured_models.py','structured_research.py',
        'opportunity_research.py','indicator_research.py')),
        ROOT/'docs/research/tmf-stock-pattern-transfer-protocol-v1.md']
    return base.hashes()|{p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in paths}


def stock_data(path):
    with sqlite3.connect(f'file:{path}?mode=ro',uri=True) as db:
        row=db.execute('SELECT payload FROM research_learning_datasets WHERE id=?',(STOCK_DATASET,)).fetchone()
    if row is None:
        raise ValueError('缺少固定股票資料快照')
    data=json.loads(zlib.decompress(row[0]))
    if (digest(data)!=STOCK_DATASET or data['source']!='fubon-paper' or data['strategySession']!='cash'
        or set(data['stocks'])!=set(POLICY['stockCodes'])):
        raise ValueError('股票資料來源／資產／雜湊不符')
    return data


def auxiliary_rows(stocks,sources):
    # Latest possible auxiliary cutoff, computed only from development dates.
    cutoff=max(boundary(partition(dates[:int(len(dates)*.6)])[1][0]) for _,_,dates in sources.values())
    rows=[];quality={}
    for code in POLICY['stockCodes']:
        found,diagnostics=samples(code,stock_days(stocks['stocks'][code]),cutoff)
        rows.extend(found);quality[code]=diagnostics
    for session,(_,data,dates) in sources.items():
        found,diagnostics=samples('TMF',future_days(data,dates[:int(len(dates)*.6)]),cutoff)
        rows.extend(found);quality['TMF-'+session]=diagnostics
    return rows,dict(cutoff=cutoff,byAssetSession=quality,
        maximumLabelEnd=max((r.label_end for r in rows),default=None))


def save(name,value):
    ARTIFACTS.mkdir(parents=True,exist_ok=True);path=ARTIFACTS/name
    if path.exists():
        raise ValueError(f'保留既有紀錄：{path}')
    path.write_text(json.dumps(value,ensure_ascii=False,indent=2,allow_nan=False))


def compact(result):
    return {s:{k:v for k,v in r.items() if k!='trades'} for s,r in result.items()}


def scores_for(model,events,shapes):
    return {a.key:1. for a in events} if model=='rule' else predict(model,events,shapes)


def calibrate(model,events,metadata,shapes):
    allowed=set(metadata['calibrationDates']);chosen=[a for a in events if a.day in allowed]
    return chosen,scores_for(model,chosen,shapes)


def develop(data,dates,session,auxiliary):
    cuts=[int(len(dates)*f) for f in POLICY['folds']]
    events,quality=build(data,dates[:cuts[-1]]);shapes=action_shapes(events)
    trials={p:dict(spec=s,folds=[]) for p,s in policies().items()};training={n:[] for n in VARIANTS}
    for a,b in zip(cuts,cuts[1:]):
        before=set(dates[:a]);held=set(dates[a:b])
        prior=[e for e in events if e.day in before];testing=[e for e in events if e.day in held]
        for name in ('rule',*VARIANTS):
            if name=='rule':
                model='rule';metadata=dict(calibrationDates=partition(dates[:a])[2])
            else:
                model,metadata=fit(prior,dates[:a],session,name,auxiliary,shapes)
                training[name].append(metadata)
            calibration,cal_scores=calibrate(model,prior,metadata,shapes)
            scores=scores_for(model,testing,shapes)
            for policy,spec in policies().items():
                if spec['model']!=name:
                    continue
                calibration_metrics=compare(calibration,cal_scores,metadata['calibrationDates'],spec['scope'],spec['threshold'])
                guard=calibration_check(calibration_metrics,spec['scope'])
                raw=compare(testing,scores,dates[a:b],spec['scope'],spec['threshold'])
                guarded=raw if guard['passed'] else compare(testing,scores,dates[a:b],spec['scope'],spec['threshold'],False)
                trials[policy]['folds'].append(dict(calibration=guard,calibrationMetrics=compact(calibration_metrics),
                    raw=compact(raw),guarded=compact(guarded)))
            print(json.dumps(dict(session=session,fold=[a,b],model=name,fitActions=metadata.get('fitActions'),
                auxSamples=metadata.get('pretraining',{}).get('samples'))),flush=True)
    selected=select(trials);models={};guards={}
    for name in ('rule',*VARIANTS):
        if name=='rule':
            model='rule';metadata=dict(calibrationDates=partition(dates[:cuts[-1]])[2])
        else:
            model,metadata=fit(events,dates[:cuts[-1]],session,name,auxiliary,shapes)
            save(f'{session}-{name}-model.json',model)
            models[name]=dict(metadata=metadata,hash=digest(model))
        calibration,scores=calibrate(model,events,metadata,shapes)
        for policy,spec in policies().items():
            if spec['model']==name:
                metrics=compare(calibration,scores,metadata['calibrationDates'],spec['scope'],spec['threshold'])
                guards[policy]=dict(check=calibration_check(metrics,spec['scope']),metrics=compact(metrics),
                    calibrationDates=metadata['calibrationDates'])
        print(json.dumps(dict(session=session,stage='final-fit',model=name,fitActions=metadata.get('fitActions'))),flush=True)
    return dict(quality=quality,trials=trials,selection=selected,training=training),models,guards


def main():
    global ARTIFACTS
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--stage',choices=['development','evaluation'],required=True)
    parser.add_argument('--database',type=Path,default=ROOT/'server/.research.sqlite3')
    parser.add_argument('--output',type=Path,default=ARTIFACTS)
    args=parser.parse_args();ARTIFACTS=args.output
    sources=base.datasets(args.database);stocks=stock_data(args.database);implementation=hashes()
    packages=dict(lightgbm=lgb.__version__,numpy=np.__version__)
    parent=json.loads((REFERENCE/'frozen.json').read_text())
    if digest({k:v for k,v in parent.items() if k!='id'})!=parent['id']:
        raise ValueError('既有比較凍結雜湊無效')
    if any(implementation.get(k)!=v for k,v in parent['implementation'].items()
        if k not in {'research-structured.py','tmf-structured-protocol-v1.md','tmf-execution-expectation-protocol-v2.md'}):
        raise ValueError('原訊號／成交／成本程式已變更，無法作固定比較')
    if args.stage=='development':
        auxiliary,quality=auxiliary_rows(stocks,sources)
        frozen=dict(createdAt=now().isoformat(),policy=POLICY,signalPolicy=SIGNAL_POLICY,
            implementation=implementation,packages=packages,parentFrozen=parent['id'],
            stockDatasetId=STOCK_DATASET,auxiliaryQuality=quality,sessions={})
        print(json.dumps(dict(stage='auxiliary',quality=quality)),flush=True)
        for session,(ident,data,dates) in sources.items():
            if parent['sessions'][session]['datasetId']!=ident:
                raise ValueError('微台快照已變更')
            report,models,guards=develop(data,dates,session,auxiliary)
            save(f'{session}-development.json',dict(datasetId=ident,**report))
            a=int(len(dates)*.6);b=int(len(dates)*.8)
            frozen['sessions'][session]=dict(datasetId=ident,models=models,guards=guards,selection=report['selection'],
                dateSplit=dict(development=dates[:a],validation=dates[a:b],historical_reused_test=dates[b:]))
        frozen['id']=digest(frozen);save('frozen.json',frozen)
        print(json.dumps(dict(stage='frozen',id=frozen['id'])),flush=True)
    else:
        frozen=json.loads((ARTIFACTS/'frozen.json').read_text())
        if (digest({k:v for k,v in frozen.items() if k!='id'})!=frozen['id'] or frozen['implementation']!=implementation
            or frozen['packages']!=packages or frozen['policy']!=json.loads(json.dumps(POLICY))
            or frozen['signalPolicy']!=SIGNAL_POLICY or frozen['parentFrozen']!=parent['id']
            or frozen['stockDatasetId']!=STOCK_DATASET):
            raise ValueError('資料、凍結程式、規格或套件已變更')
        for session,(ident,data,dates) in sources.items():
            spec=frozen['sessions'][session];a=int(len(dates)*.6);b=int(len(dates)*.8)
            split=dict(development=dates[:a],validation=dates[a:b],historical_reused_test=dates[b:])
            if spec['datasetId']!=ident or spec['dateSplit']!=split:
                raise ValueError('完整日期分割或微台資料不同')
            events,_=build(data,dates[a:]);shapes=action_shapes(events)
            results={p:dict(raw={},guarded={}) for p in policies()};baseline_checks={}
            previous=json.loads((REFERENCE/f'{session}-evaluation.json').read_text())
            for name in ('rule',*VARIANTS):
                model='rule' if name=='rule' else json.loads((ARTIFACTS/f'{session}-{name}-model.json').read_text())
                if name!='rule' and digest(model)!=spec['models'][name]['hash']:
                    raise ValueError('型態／金額模型雜湊不同')
                for phase,chosen in (('validation',dates[a:b]),('historical_reused_test',dates[b:])):
                    allowed=set(chosen);testing=[e for e in events if e.day in allowed]
                    scores=scores_for(model,testing,shapes)
                    for policy,settings in policies().items():
                        if settings['model']!=name:
                            continue
                        raw=compare(testing,scores,chosen,settings['scope'],settings['threshold'])
                        if name=='rule':
                            if raw!=previous['results'][policy]['raw'][phase]:
                                raise ValueError('原規則成交未完整重現')
                            baseline_checks.setdefault(policy,{})[phase]=True
                        passed=spec['guards'][policy]['check']['passed']
                        guarded=raw if passed else compare(testing,scores,chosen,settings['scope'],settings['threshold'],False)
                        results[policy]['raw'][phase]=raw;results[policy]['guarded'][phase]=guarded
                print(json.dumps(dict(session=session,stage='frozen-evaluation',model=name)),flush=True)
            checks={p:final_check(v['guarded'],policies()[p]['scope']) for p,v in results.items()}
            raw_checks={p:final_check(v['raw'],policies()[p]['scope']) for p,v in results.items()}
            selected=spec['selection']['selected']
            save(f'{session}-evaluation.json',dict(frozenId=frozen['id'],stockDatasetId=STOCK_DATASET,datasetId=ident,
                baselineReplayMatched=baseline_checks,selected=selected,results=results,checks=checks,
                rawDiagnosticChecks=raw_checks,qualified=selected is not None and checks[selected]['passed'],
                historyReused=True,executionEnabled=False,adoptionAllowed=False))


if __name__=='__main__':
    main()
