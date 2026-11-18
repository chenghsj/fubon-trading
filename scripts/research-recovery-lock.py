"""Freeze chronological recovery models and entry locks, then evaluate reused history."""
import argparse
import hashlib
from importlib import import_module
import json
from pathlib import Path

import lightgbm as lgb
import numpy as np

from fubon_bridge.candle_patterns import action_shapes, boundary
from fubon_bridge.confirmed_models import block_interval
from fubon_bridge.direction_execution import rule_scores
from fubon_bridge.direction_models import AuxiliaryBank
from fubon_bridge.mapping import now
from fubon_bridge.position_value import build as parent_build
from fubon_bridge.recovery_lock import (POLICY, VARIANTS, ExitBank, RecoveryEngine, compare,
    fit_entry, policies, predict, select)
from fubon_bridge.research import digest
from fubon_bridge.structured_models import calibration_check, final_check

parent=import_module('research-position-value');base=parent.base
ROOT=Path(__file__).resolve().parents[1]
REFERENCE=ROOT/'.fubon-dev/reports/position-value-v1'
ARTIFACTS=ROOT/'.fubon-dev/reports/recovery-lock-v1'


def hashes():
    paths=[Path(__file__),ROOT/'server/fubon_bridge/recovery_lock.py',ROOT/'docs/research/tmf-recovery-lock-protocol-v1.md']
    return parent.hashes()|{p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in paths}


def save(name,value):
    ARTIFACTS.mkdir(parents=True,exist_ok=True)
    with (ARTIFACTS/name).open('x') as stream:
        json.dump(value,stream,ensure_ascii=False,indent=2,allow_nan=False)


def compact(value):
    return {s:{k:v for k,v in r.items() if k!='trades'} for s,r in value.items()}


def build(data,dates):
    rows,quality=parent_build(data,dates)
    return {v:rows[v.split('-')[0]+'-fixed'] for v in VARIANTS},quality


def train(events,dates,session,bank,aux_bank,shapes):
    models={};metadata={};engines={}
    for variant in VARIANTS:
        model,meta=fit_entry(events[variant],dates,session,variant,bank,aux_bank,shapes)
        models[variant]=model;metadata[variant]=meta
        engines[variant]=bank.engine(meta['finalCutoff'],variant.split('-')[1])
        print(json.dumps(dict(session=session,prefixDays=len(dates),variant=variant,fitActions=meta['fitActions'])),flush=True)
    return models,metadata,engines


def evaluate_policies(events,dates,models,engines,shapes):
    result={};scores={v:predict(models[v],events[v],shapes) for v in VARIANTS}
    for name,spec in policies().items():
        v=spec['variant'];values=rule_scores(events[v]) if spec['model']=='rule' else scores[v]
        result[name]=compare(events[v],values,dates,engines[v],spec['reentry'])
    return result


def develop(data,dates,session,aux_bank,identity):
    cuts=[int(len(dates)*f) for f in POLICY['folds']]
    events,quality=build(data,dates[:cuts[-1]]);shapes=action_shapes(events['confirmed-fixed']+events['paired-fixed'])
    bank=ExitBank(events['confirmed-fixed']+events['paired-fixed'],identity)
    trials={p:dict(spec=s,folds=[]) for p,s in policies().items()};training=[]
    for a,b in zip(cuts,cuts[1:]):
        prior={v:[e for e in events[v] if e.day in set(dates[:a])] for v in VARIANTS}
        models,metadata,engines=train(prior,dates[:a],session,bank,aux_bank,shapes)
        cal_dates=next(iter(metadata.values()))['calibrationDates'];cal=set(cal_dates);held=set(dates[a:b])
        calibration=evaluate_policies({v:[e for e in prior[v] if e.day in cal] for v in VARIANTS},cal_dates,models,engines,shapes)
        result=evaluate_policies({v:[e for e in events[v] if e.day in held] for v in VARIANTS},dates[a:b],models,engines,shapes)
        training.append(metadata)
        for v,m in models.items():
            save(f'{session}-fold-{a}-{v}.json',m)
        for p,s in policies().items():
            guard=calibration_check(calibration[p],'hybrid');raw=result[p]
            blocked=compare([],{},dates[a:b],engines[s['variant']],s['reentry'],False)
            trials[p]['folds'].append(dict(calibration=guard,calibrationMetrics=compact(calibration[p]),raw=compact(raw),guarded=compact(raw if guard['passed'] else blocked)))
    selection=select(trials);models,metadata,engines=train(events,dates[:cuts[-1]],session,bank,aux_bank,shapes)
    cal_dates=next(iter(metadata.values()))['calibrationDates'];cal=set(cal_dates)
    calibration=evaluate_policies({v:[e for e in events[v] if e.day in cal] for v in VARIANTS},cal_dates,models,engines,shapes)
    guards={p:dict(check=calibration_check(r,'hybrid'),metrics=compact(r)) for p,r in calibration.items()}
    for v,m in models.items():
        save(f'{session}-{v}-model.json',m)
    records={}
    for cutoff,record in bank.records.items():
        filename=f'{session}-exits-{cutoff}.json';save(filename,record['models'])
        records[str(cutoff)]={k:v for k,v in record.items() if k!='models'}|dict(file=filename)
    report=dict(quality=quality,training=training,finalTraining=metadata,trials=trials,selection=selection)
    return report,dict(models={v:digest(m) for v,m in models.items()},training=metadata,exitBank=records,guards=guards,selection=selection)


def verify_parent(results,session):
    old=json.loads((REFERENCE/f'{session}-evaluation.json').read_text());count=0
    for source in ('confirmed','paired'):
        for mode in ('free','lock'):
            for phase,scenarios in results[source+'-fixed-rule-'+mode]['raw'].items():
                for scenario,value in scenarios.items():
                    expected=old['results'][source+'-fixed-rule-hybrid']['raw'][phase][scenario]
                    normalized=expected|dict(trades=[{k:v for k,v in t.items() if k!='direction5'} for t in expected['trades']])
                    if value!=normalized:
                        raise ValueError('新fixed完整replay與父版不符')
                    count+=1
    return count


def load_banks(frozen):
    for record in frozen['auxiliaryModels'].values():
        model=json.loads((ARTIFACTS/record['file']).read_text());meta=record['metadata']
        if digest(model)!=record['hash'] or meta['cutoff']!=record['cutoff'] or (meta['maximumLabelEnd'] is not None and meta['maximumLabelEnd']>=record['cutoff']):
            raise ValueError('aux模型或截止不符')
    result={}
    for session,spec in frozen['sessions'].items():
        result[session]={}
        for key,record in spec['exitBank'].items():
            models=json.loads((ARTIFACTS/record['file']).read_text());meta=record['metadata']
            if (str(record['cutoff'])!=key or meta['cutoff']!=record['cutoff']
                or (meta['maximumLabelEnd'] is not None and meta['maximumLabelEnd']>=record['cutoff'])
                or {f:digest(m) for f,m in models.items()}!=record['hashes']):
                raise ValueError('退出bank模型或截止不符')
            result[session][key]=models
    return result


def main():
    global ARTIFACTS
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--stage',choices=['development','evaluation'],required=True)
    parser.add_argument('--database',type=Path,default=ROOT/'server/.research.sqlite3');parser.add_argument('--output',type=Path,default=ARTIFACTS)
    args=parser.parse_args();ARTIFACTS=args.output
    sources=base.datasets(args.database);implementation=hashes();packages=dict(lightgbm=lgb.__version__,numpy=np.__version__)
    reference=json.loads((REFERENCE/'frozen.json').read_text())
    if digest({k:v for k,v in reference.items() if k!='id'})!=reference['id'] or any(implementation.get(k)!=v for k,v in reference['implementation'].items()):
        raise ValueError('父凍結實作變更')
    if args.stage=='development':
        stocks=parent.parent.stock_parent.stock_data(args.database);rows,quality=parent.parent.auxiliary_rows(stocks,sources)
        identity=dict(implementation=digest(implementation),datasets={s:i for s,(i,_,_) in sources.items()})
        aux_bank=AuxiliaryBank(rows,identity)
        frozen=dict(createdAt=now().isoformat(),parentFrozen=reference['id'],implementation=implementation,packages=packages,
            policy=POLICY,stockDatasetId=parent.parent.stock_parent.STOCK_DATASET,auxiliaryQuality=quality,sessions={})
        for session,(ident,data,dates) in sources.items():
            if reference['sessions'][session]['datasetId']!=ident:
                raise ValueError('微台快照變更')
            report,record=develop(data,dates,session,aux_bank,identity|dict(session=session,datasetId=ident))
            save(f'{session}-development.json',report);a=int(len(dates)*.6);b=int(len(dates)*.8)
            frozen['sessions'][session]=record|dict(datasetId=ident,dateSplit=dict(development=dates[:a],validation=dates[a:b],historical_reused_test=dates[b:]))
        frozen['auxiliaryModels']={}
        for key,record in aux_bank.models.items():
            filename=f'aux-{record["cutoff"]}.json';save(filename,record['model'])
            frozen['auxiliaryModels'][key]=dict(file=filename,cutoff=record['cutoff'],metadata=record['metadata'],hash=record['hash'])
        frozen['id']=digest(frozen);save('frozen.json',frozen);print(json.dumps(dict(stage='frozen',id=frozen['id'])),flush=True)
    else:
        frozen=json.loads((ARTIFACTS/'frozen.json').read_text())
        if (digest({k:v for k,v in frozen.items() if k!='id'})!=frozen['id'] or implementation!=frozen['implementation']
            or packages!=frozen['packages'] or json.loads(json.dumps(POLICY))!=frozen['policy'] or reference['id']!=frozen['parentFrozen']):
            raise ValueError('凍結內容變更')
        banks=load_banks(frozen)
        for session,(ident,data,dates) in sources.items():
            spec=frozen['sessions'][session];a=int(len(dates)*.6);b=int(len(dates)*.8)
            split=dict(development=dates[:a],validation=dates[a:b],historical_reused_test=dates[b:])
            if spec['datasetId']!=ident or split!=spec['dateSplit']:
                raise ValueError('資料或日期切分變更')
            models={};engines={}
            for v in VARIANTS:
                model=json.loads((ARTIFACTS/f'{session}-{v}-model.json').read_text());meta=spec['training'][v]
                family=v.split('-')[1];exit_model=None if family=='fixed' else banks[session][str(meta['finalCutoff'])][family]
                if digest(model)!=spec['models'][v] or (model is not None and model['exitHash']!=digest(exit_model)):
                    raise ValueError('金額模型或exit鏈變更')
                models[v]=model;engines[v]=RecoveryEngine(exit_model,family)
            events,quality=build(data,dates[a:]);shapes=action_shapes(events['confirmed-fixed']+events['paired-fixed'])
            results={p:dict(raw={},guarded={}) for p in policies()}
            for phase,chosen in (('validation',dates[a:b]),('historical_reused_test',dates[b:])):
                allowed=set(chosen);raw=evaluate_policies({v:[e for e in events[v] if e.day in allowed] for v in VARIANTS},chosen,models,engines,shapes)
                for p,s in policies().items():
                    results[p]['raw'][phase]=raw[p]
                    results[p]['guarded'][phase]=raw[p] if spec['guards'][p]['check']['passed'] else compare([],{},chosen,engines[s['variant']],s['reentry'],False)
            checks={p:final_check(r['guarded'],'hybrid') for p,r in results.items()};raw_checks={p:final_check(r['raw'],'hybrid') for p,r in results.items()}
            selected=spec['selection']['selected'];intervals={p:{phase:{s:block_interval(r['dates']) for s,r in c.items()} for phase,c in v['raw'].items()} for p,v in results.items()}
            save(f'{session}-evaluation.json',dict(frozenId=frozen['id'],datasetId=ident,quality=quality,results=results,
                checks=checks,rawDiagnosticChecks=raw_checks,selected=selected,diagnosticIntervals=intervals,parentReplayMatches=verify_parent(results,session),
                qualified=selected is not None and checks[selected]['passed'],historyReused=True,executionEnabled=False,adoptionAllowed=False))
            print(json.dumps(dict(stage='evaluation',session=session,selected=selected)),flush=True)


if __name__=='__main__':
    main()
