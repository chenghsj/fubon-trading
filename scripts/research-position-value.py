"""Frozen position-value training then reused-history evaluation; offline only."""
import argparse
import hashlib
from importlib import import_module
import json
from pathlib import Path

import lightgbm as lgb
import numpy as np

from fubon_bridge.candle_patterns import action_shapes, boundary
from fubon_bridge.confirmed_models import block_interval
from fubon_bridge.direction_execution import compare as parent_compare, rule_scores
from fubon_bridge.direction_models import AuxiliaryBank
from fubon_bridge.mapping import now
from fubon_bridge.pattern_transfer import partition
from fubon_bridge.position_value import (POLICY, VARIANTS, ExitEngine, build, compare,
    fit_entry, fit_exit, policies, predict, select)
from fubon_bridge.research import digest
from fubon_bridge.structured_models import calibration_check, final_check

parent=import_module('research-direction-continuation');base=parent.base
ROOT=Path(__file__).resolve().parents[1]
REFERENCE=ROOT/'.fubon-dev/reports/direction-continuation-v1-clarified'
ARTIFACTS=ROOT/'.fubon-dev/reports/position-value-v1'


def hashes():
    paths=[Path(__file__),ROOT/'server/fubon_bridge/position_value.py',ROOT/'docs/research/tmf-position-value-protocol-v1.md']
    return parent.hashes()|{p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in paths}


def save(name,value):
    ARTIFACTS.mkdir(parents=True,exist_ok=True)
    with (ARTIFACTS/name).open('x') as stream:
        json.dump(value,stream,ensure_ascii=False,indent=2,allow_nan=False)


def compact(value):
    return {s:{k:v for k,v in r.items() if k!='trades'} for s,r in value.items()}


def train(events,dates,session,bank,shapes):
    early,fit_dates,calibration=partition(dates);cutoff=boundary(fit_dates[0])
    exit_model,exit_meta=fit_exit(events['confirmed-fixed']+events['paired-fixed'],early,cutoff)
    _,aux=bank.get(cutoff);engine=ExitEngine(exit_model);models={};metadata={}
    for v in VARIANTS:
        model,meta=fit_entry(events[v],dates,session,aux['model'],aux['metadata'],shapes,engine,v.endswith('learned'))
        models[v]=model;metadata[v]=meta
    return models,dict(exit=exit_meta,entry=metadata,calibrationDates=calibration),engine


def evaluate_policies(events,dates,models,engine,shapes):
    result={};predictions={v:predict(models[v],events[v],shapes) for v in VARIANTS}
    for name,spec in policies().items():
        v=spec['variant'];kind=spec['model'];scores,direction=predictions[v]
        if kind=='rule':
            scores=rule_scores(events[v])
        result[name]=compare(events[v],scores,dates,engine,v,spec['scope'],direction if kind=='cash-direction' else None)
    return result


def develop(data,dates,session,bank):
    cuts=[int(len(dates)*f) for f in POLICY['folds']]
    events,quality=build(data,dates[:cuts[-1]]);shapes=action_shapes(events['confirmed-fixed']+events['paired-fixed'])
    trials={p:dict(spec=s,folds=[]) for p,s in policies().items()};training=[]
    for a,b in zip(cuts,cuts[1:]):
        before=set(dates[:a]);prior={v:[e for e in events[v] if e.day in before] for v in VARIANTS}
        models,metadata,engine=train(prior,dates[:a],session,bank,shapes)
        cal=set(metadata['calibrationDates']);held=set(dates[a:b])
        calibration=evaluate_policies({v:[e for e in prior[v] if e.day in cal] for v in VARIANTS},metadata['calibrationDates'],models,engine,shapes)
        results=evaluate_policies({v:[e for e in events[v] if e.day in held] for v in VARIANTS},dates[a:b],models,engine,shapes)
        training.append(metadata)
        save(f'{session}-fold-{a}-exit.json',engine.model)
        for v,m in models.items():
            save(f'{session}-fold-{a}-{v}.json',m)
        for p,s in policies().items():
            guard=calibration_check(calibration[p],s['scope']);raw=results[p]
            blocked=compare([],{},dates[a:b],engine,s['variant'],s['scope'],enabled=False)
            trials[p]['folds'].append(dict(calibration=guard,calibrationMetrics=compact(calibration[p]),raw=compact(raw),guarded=compact(raw if guard['passed'] else blocked)))
        print(json.dumps(dict(session=session,fold=[a,b],exitActions=metadata['exit']['actions'],exitStates=metadata['exit']['states'])),flush=True)
    selection=select(trials);models,metadata,engine=train(events,dates[:cuts[-1]],session,bank,shapes)
    save(f'{session}-exit-model.json',engine.model)
    hashes_={v:digest(m) for v,m in models.items()}
    for v,m in models.items():
        save(f'{session}-{v}-model.json',m)
    cal=set(metadata['calibrationDates'])
    calibration=evaluate_policies({v:[e for e in events[v] if e.day in cal] for v in VARIANTS},metadata['calibrationDates'],models,engine,shapes)
    guards={p:dict(check=calibration_check(r,policies()[p]['scope']),metrics=compact(r)) for p,r in calibration.items()}
    return dict(quality=quality,training=training,finalTraining=metadata,trials=trials,selection=selection),dict(
        models=hashes_,exitHash=digest(engine.model),training=metadata,guards=guards,selection=selection)


def verify_parent(events,dates,session,reference):
    old=json.loads((REFERENCE/f'{session}-evaluation.json').read_text());checks=0
    for v in ('confirmed-fixed','paired-fixed'):
        for phase,chosen in (('validation',dates[int(len(dates)*.6):int(len(dates)*.8)]),('historical_reused_test',dates[int(len(dates)*.8):])):
            allowed=set(chosen);rows=[a for a in events[v] if a.day in allowed]
            for scope in ('hybrid','range','trend'):
                expected=old['results'][f'{v}-rule-{scope}']['raw'][phase]
                actual=parent_compare(rows,rule_scores(rows),chosen,scope)
                if actual!=expected:
                    raise ValueError('父版fixed純規則完整重播不符')
                checks+=3
    return checks


def main():
    global ARTIFACTS
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--stage',choices=['development','evaluation'],required=True)
    parser.add_argument('--database',type=Path,default=ROOT/'server/.research.sqlite3');parser.add_argument('--output',type=Path,default=ARTIFACTS)
    args=parser.parse_args();ARTIFACTS=args.output
    sources=base.datasets(args.database);implementation=hashes();packages=dict(lightgbm=lgb.__version__,numpy=np.__version__)
    reference=json.loads((REFERENCE/'frozen.json').read_text())
    if digest({k:v for k,v in reference.items() if k!='id'})!=reference['id'] or any(implementation.get(k)!=v for k,v in reference['implementation'].items()):
        raise ValueError('父版凍結或實作變更')
    if args.stage=='development':
        stocks=parent.stock_parent.stock_data(args.database);rows,quality=parent.auxiliary_rows(stocks,sources)
        bank=AuxiliaryBank(rows,dict(implementation=digest(implementation),datasets={s:i for s,(i,_,_) in sources.items()}))
        frozen=dict(createdAt=now().isoformat(),parentFrozen=reference['id'],implementation=implementation,packages=packages,
            policy=POLICY,stockDatasetId=parent.stock_parent.STOCK_DATASET,auxiliaryQuality=quality,sessions={})
        for session,(ident,data,dates) in sources.items():
            if ident!=reference['sessions'][session]['datasetId']:
                raise ValueError('微台快照變更')
            report,record=develop(data,dates,session,bank);save(f'{session}-development.json',report)
            a=int(len(dates)*.6);b=int(len(dates)*.8)
            frozen['sessions'][session]=record|dict(datasetId=ident,dateSplit=dict(development=dates[:a],validation=dates[a:b],historical_reused_test=dates[b:]))
        frozen['auxiliaryModels']={}
        for key,record in bank.models.items():
            filename=f'aux-{record["cutoff"]}.json';save(filename,record['model'])
            frozen['auxiliaryModels'][key]=dict(file=filename,cutoff=record['cutoff'],metadata=record['metadata'],hash=record['hash'])
        frozen['id']=digest(frozen);save('frozen.json',frozen);print(json.dumps(dict(stage='frozen',id=frozen['id'])),flush=True)
    else:
        frozen=json.loads((ARTIFACTS/'frozen.json').read_text())
        if (digest({k:v for k,v in frozen.items() if k!='id'})!=frozen['id'] or implementation!=frozen['implementation']
            or packages!=frozen['packages'] or json.loads(json.dumps(POLICY))!=frozen['policy'] or reference['id']!=frozen['parentFrozen']):
            raise ValueError('凍結內容變更')
        for record in frozen['auxiliaryModels'].values():
            aux=json.loads((ARTIFACTS/record['file']).read_text());meta=record['metadata']
            if digest(aux)!=record['hash'] or meta['cutoff']!=record['cutoff'] or (meta['maximumLabelEnd'] is not None and meta['maximumLabelEnd']>=record['cutoff']):
                raise ValueError('凍結aux或截止變更')
        for session,(ident,data,dates) in sources.items():
            spec=frozen['sessions'][session];a=int(len(dates)*.6);b=int(len(dates)*.8)
            split=dict(development=dates[:a],validation=dates[a:b],historical_reused_test=dates[b:])
            if spec['datasetId']!=ident or split!=spec['dateSplit']:
                raise ValueError('資料或日期切分變更')
            model=json.loads((ARTIFACTS/f'{session}-exit-model.json').read_text());metadata=spec['training']['exit']
            if digest(model)!=spec['exitHash'] or (metadata['maximumLabelEnd'] is not None and metadata['maximumLabelEnd']>=metadata['cutoff']):
                raise ValueError('退出模型或截止變更')
            engine=ExitEngine(model);models={}
            for v in VARIANTS:
                m=json.loads((ARTIFACTS/f'{session}-{v}-model.json').read_text())
                if digest(m)!=spec['models'][v] or (m is not None and m['exitHash']!=(spec['exitHash'] if v.endswith('learned') else None)):
                    raise ValueError('進場模型或所用exit變更')
                models[v]=m
            events,quality=build(data,dates[a:]);shapes=action_shapes(events['confirmed-fixed']+events['paired-fixed'])
            parent_matches=verify_parent(events,dates,session,reference);results={p:dict(raw={},guarded={}) for p in policies()}
            for phase,chosen in (('validation',dates[a:b]),('historical_reused_test',dates[b:])):
                allowed=set(chosen);raw=evaluate_policies({v:[e for e in events[v] if e.day in allowed] for v in VARIANTS},chosen,models,engine,shapes)
                for p,s in policies().items():
                    results[p]['raw'][phase]=raw[p]
                    results[p]['guarded'][phase]=raw[p] if spec['guards'][p]['check']['passed'] else compare([],{},chosen,engine,s['variant'],s['scope'],enabled=False)
            checks={p:final_check(r['guarded'],policies()[p]['scope']) for p,r in results.items()}
            raw_checks={p:final_check(r['raw'],policies()[p]['scope']) for p,r in results.items()}
            selected=spec['selection']['selected']
            intervals={p:{phase:{s:block_interval(r['dates']) for s,r in scenarios.items()} for phase,scenarios in value['raw'].items()}
                for p,value in results.items() if p.endswith('hybrid')}
            save(f'{session}-evaluation.json',dict(frozenId=frozen['id'],datasetId=ident,quality=quality,results=results,
                selected=selected,parentReplayMatches=parent_matches,checks=checks,rawDiagnosticChecks=raw_checks,diagnosticIntervals=intervals,
                qualified=selected is not None and checks[selected]['passed'],historyReused=True,executionEnabled=False,adoptionAllowed=False))
            print(json.dumps(dict(stage='evaluation',session=session,selected=selected,qualified=False if selected is None else checks[selected]['passed'])),flush=True)


if __name__=='__main__':
    main()
