"""Frozen competing-direction and continuation study; read-only market snapshots."""
import argparse
from importlib import import_module
import hashlib
import json
from pathlib import Path

import lightgbm as lgb
import numpy as np

from fubon_bridge.candle_patterns import action_shapes, boundary, future_days, samples, stock_days
from fubon_bridge.confirmed_models import block_interval, predict as parent_predict
from fubon_bridge.direction_execution import POLICY as EXECUTION_POLICY, VARIANTS, build, compare, rule_scores
from fubon_bridge.direction_models import (POLICY as MODEL_POLICY, KINDS, AuxiliaryBank,
    fit, policies, predict, select)
from fubon_bridge.mapping import now
from fubon_bridge.pattern_transfer import partition
from fubon_bridge.research import digest
from fubon_bridge.structured_models import calibration_check, final_check

base=import_module('refine-regime');parent=import_module('research-entry-exit')
stock_parent=import_module('research-pattern-transfer')
ROOT=Path(__file__).resolve().parents[1]
ARTIFACTS=ROOT/'.fubon-dev/reports/direction-continuation-v1-clarified'
REFERENCE=ROOT/'.fubon-dev/reports/confirmed-entry-exit-v1'


def hashes():
    paths=[Path(__file__),*(ROOT/'server/fubon_bridge'/name for name in ('direction_execution.py','direction_models.py')),
        ROOT/'docs/research/tmf-direction-continuation-protocol-v1.md']
    return parent.hashes()|{p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in paths}


def auxiliary_rows(stocks,sources):
    cutoff=max(boundary(partition(dates[:int(len(dates)*.6)])[2][0]) for _,_,dates in sources.values())
    rows=[];quality={}
    for code in MODEL_POLICY.get('stockCodes',('2330','2454','2317','2881')):
        found,info=samples(code,stock_days(stocks['stocks'][code]),cutoff);rows.extend(found);quality[code]=info
    for session,(_,data,dates) in sources.items():
        found,info=samples('TMF',future_days(data,dates[:int(len(dates)*.6)]),cutoff)
        rows.extend(found);quality['TMF-'+session]=info
    return rows,dict(cutoff=cutoff,byAssetSession=quality,maximumLabelEnd=max((r.label_end for r in rows),default=None))


def save(name,value):
    ARTIFACTS.mkdir(parents=True,exist_ok=True)
    with (ARTIFACTS/name).open('x') as stream:
        json.dump(value,stream,ensure_ascii=False,indent=2,allow_nan=False)


def compact(comparison):
    return {s:{k:v for k,v in r.items() if k!='trades'} for s,r in comparison.items()}


def scored(model,events,shapes):
    return rule_scores(events) if model=='rule' else predict(model,events,shapes)


def matches(spec,variant,filter_name):
    return spec['variant']==variant and (spec['model']=='rule' if filter_name=='rule' else spec['model'].startswith(filter_name+'-'))


def develop(data,dates,session,bank):
    cuts=[int(len(dates)*f) for f in MODEL_POLICY['folds']]
    events,quality=build(data,dates[:cuts[-1]]);shapes=action_shapes([a for rows in events.values() for a in rows])
    trials={p:dict(spec=s,folds=[]) for p,s in policies().items()}
    training={f'{v}-{k}':[] for v in VARIANTS for k in KINDS}
    for a,b in zip(cuts,cuts[1:]):
        before=set(dates[:a]);held=set(dates[a:b])
        for variant in VARIANTS:
            prior=[e for e in events[variant] if e.day in before];testing=[e for e in events[variant] if e.day in held]
            filters=[('rule','rule',dict(calibrationDates=partition(dates[:a])[2]))]
            for kind in KINDS:
                model,metadata=fit(prior,dates[:a],session,kind,bank,shapes)
                training[f'{variant}-{kind}'].append(metadata);filters.append((kind,model,metadata))
                print(json.dumps(dict(session=session,fold=[a,b],variant=variant,kind=kind,
                    fitActions=metadata['fitActions'],excludedAux=metadata['excludedMissingAux'])),flush=True)
            for filter_name,model,metadata in filters:
                calibration_set=set(metadata['calibrationDates']);calibration=[e for e in prior if e.day in calibration_set]
                cal_scores=scored(model,calibration,shapes);scores=scored(model,testing,shapes)
                for policy,spec in policies().items():
                    if not matches(spec,variant,filter_name):
                        continue
                    metrics=compare(calibration,cal_scores,metadata['calibrationDates'],spec['scope'],spec['threshold'])
                    guard=calibration_check(metrics,spec['scope'])
                    raw=compare(testing,scores,dates[a:b],spec['scope'],spec['threshold'])
                    guarded=raw if guard['passed'] else compare(testing,scores,dates[a:b],spec['scope'],spec['threshold'],False)
                    trials[policy]['folds'].append(dict(calibration=guard,calibrationMetrics=compact(metrics),
                        raw=compact(raw),guarded=compact(guarded)))
    selection=select(trials);models={};guards={}
    for variant in VARIANTS:
        filters=[('rule','rule',dict(calibrationDates=partition(dates[:cuts[-1]])[2]))]
        for kind in KINDS:
            model,metadata=fit(events[variant],dates[:cuts[-1]],session,kind,bank,shapes)
            name=f'{variant}-{kind}';save(f'{session}-{name}-model.json',model)
            models[name]=dict(metadata=metadata,hash=digest(model));filters.append((kind,model,metadata))
            print(json.dumps(dict(session=session,stage='final-fit',variant=variant,kind=kind,
                fitActions=metadata['fitActions'])),flush=True)
        for filter_name,model,metadata in filters:
            allowed=set(metadata['calibrationDates']);calibration=[e for e in events[variant] if e.day in allowed]
            scores=scored(model,calibration,shapes)
            for policy,spec in policies().items():
                if matches(spec,variant,filter_name):
                    metrics=compare(calibration,scores,metadata['calibrationDates'],spec['scope'],spec['threshold'])
                    guards[policy]=dict(check=calibration_check(metrics,spec['scope']),metrics=compact(metrics),
                        calibrationDates=metadata['calibrationDates'])
    return dict(quality=quality,trials=trials,selection=selection,training=training),models,guards


def baseline(dates,session,reference,events,shapes):
    old=json.loads((REFERENCE/f'{session}-evaluation.json').read_text());checks={}
    # The original fixed and managed events/models stay untouched for comparison.
    for variant in ('structure-fixed','structure-managed'):
        model=json.loads((REFERENCE/f'{session}-{variant}-model.json').read_text())
        if digest(model)!=reference['sessions'][session]['models'][variant]['hash']:
            raise ValueError('父版模型雜湊不符')
        for phase,chosen in (('validation',dates[int(len(dates)*.6):int(len(dates)*.8)]),
            ('historical_reused_test',dates[int(len(dates)*.8):])):
            allowed=set(chosen);testing=[e for e in events[variant] if e.day in allowed]
            for filter_name,filter_model in (('rule','rule'),('tree',model)):
                scores={a.key:1. for a in testing} if filter_name=='rule' else parent_predict(filter_model,testing,shapes)
                for scope in ('hybrid','range','trend'):
                    for threshold in ((0.,) if filter_name=='rule' else (0.,30.)):
                        key=f'{variant}-rule-{scope}' if filter_name=='rule' else f'{variant}-tree-{int(threshold)}-{scope}'
                        result=parent.compare(testing,scores,chosen,scope,threshold)
                        if result!=old['results'][key]['raw'][phase]:
                            raise ValueError(f'父版完整重播不符：{session}/{phase}/{key}')
                        checks.setdefault(key,{})[phase]=True
    return checks


def main():
    global ARTIFACTS
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--stage',choices=['development','evaluation'],required=True)
    parser.add_argument('--database',type=Path,default=ROOT/'server/.research.sqlite3')
    parser.add_argument('--output',type=Path,default=ARTIFACTS)
    args=parser.parse_args();ARTIFACTS=args.output
    sources=base.datasets(args.database);stocks=stock_parent.stock_data(args.database);implementation=hashes()
    packages=dict(lightgbm=lgb.__version__,numpy=np.__version__)
    reference=json.loads((REFERENCE/'frozen.json').read_text())
    if digest({k:v for k,v in reference.items() if k!='id'})!=reference['id']:
        raise ValueError('父版凍結雜湊不符')
    if any(implementation.get(k)!=v for k,v in reference['implementation'].items()):
        raise ValueError('父版程式或規格已改變')
    if args.stage=='development':
        auxiliary,quality=auxiliary_rows(stocks,sources)
        identity=dict(datasetIds={s:i for s,(i,_,_) in sources.items()},stockDatasetId=stock_parent.STOCK_DATASET,
            implementation=digest(implementation),maximumAuxiliaryCutoff=quality['cutoff'])
        bank=AuxiliaryBank(auxiliary,identity)
        frozen=dict(createdAt=now().isoformat(),parentFrozen=reference['id'],implementation=implementation,
            packages=packages,executionPolicy=EXECUTION_POLICY,modelPolicy=MODEL_POLICY,
            stockDatasetId=stock_parent.STOCK_DATASET,auxiliaryQuality=quality,auxiliaryIdentity=identity,sessions={})
        for session,(ident,data,dates) in sources.items():
            if reference['sessions'][session]['datasetId']!=ident:
                raise ValueError('微台固定快照已改變')
            report,models,guards=develop(data,dates,session,bank)
            save(f'{session}-development.json',dict(datasetId=ident,**report))
            a=int(len(dates)*.6);b=int(len(dates)*.8)
            frozen['sessions'][session]=dict(datasetId=ident,models=models,guards=guards,selection=report['selection'],
                dateSplit=dict(development=dates[:a],validation=dates[a:b],historical_reused_test=dates[b:]))
        frozen['auxiliaryModels']={}
        for key,record in bank.models.items():
            filename=f'aux-{record["cutoff"]}.json';save(filename,record['model'])
            frozen['auxiliaryModels'][key]=dict(file=filename,cutoff=record['cutoff'],metadata=record['metadata'],hash=record['hash'])
        frozen['id']=digest(frozen);save('frozen.json',frozen)
        print(json.dumps(dict(stage='frozen',id=frozen['id'],auxiliaryModels=len(bank.models))),flush=True)
    else:
        frozen=json.loads((ARTIFACTS/'frozen.json').read_text())
        if (digest({k:v for k,v in frozen.items() if k!='id'})!=frozen['id'] or frozen['implementation']!=implementation
            or frozen['packages']!=packages or frozen['parentFrozen']!=reference['id']
            or frozen['executionPolicy']!=json.loads(json.dumps(EXECUTION_POLICY))
            or frozen['modelPolicy']!=json.loads(json.dumps(MODEL_POLICY)) or frozen['stockDatasetId']!=stock_parent.STOCK_DATASET):
            raise ValueError('凍結程式／規格／套件／資料已變更')
        for record in frozen['auxiliaryModels'].values():
            model=json.loads((ARTIFACTS/record['file']).read_text());metadata=record['metadata']
            if digest(model)!=record['hash'] or metadata.get('cutoff')!=record['cutoff'] or (metadata.get('maximumLabelEnd') is not None and metadata['maximumLabelEnd']>=record['cutoff']):
                raise ValueError('輔助模型或時間截止不符')
        for session,(ident,data,dates) in sources.items():
            spec=frozen['sessions'][session];a=int(len(dates)*.6);b=int(len(dates)*.8)
            split=dict(development=dates[:a],validation=dates[a:b],historical_reused_test=dates[b:])
            if spec['datasetId']!=ident or spec['dateSplit']!=split:
                raise ValueError('完整日期切分或資料快照不符')
            events,quality=build(data,dates[a:]);shapes=action_shapes([e for rows in events.values() for e in rows])
            old_events,_=parent.build(data,dates[a:])
            old_shapes=action_shapes([e for name in ('structure-fixed','structure-managed') for e in old_events[name]])
            matched=baseline(dates,session,reference,old_events,old_shapes)
            results={p:dict(raw={},guarded={}) for p in policies()}
            for variant in VARIANTS:
                filters=[('rule','rule')]
                for kind in KINDS:
                    name=f'{variant}-{kind}';model=json.loads((ARTIFACTS/f'{session}-{name}-model.json').read_text())
                    if digest(model)!=spec['models'][name]['hash']:
                        raise ValueError('金額模型雜湊不符')
                    filters.append((kind,model))
                for phase,chosen in (('validation',dates[a:b]),('historical_reused_test',dates[b:])):
                    allowed=set(chosen);testing=[e for e in events[variant] if e.day in allowed]
                    for filter_name,model in filters:
                        scores=scored(model,testing,shapes)
                        for policy,settings in policies().items():
                            if not matches(settings,variant,filter_name):
                                continue
                            raw=compare(testing,scores,chosen,settings['scope'],settings['threshold'])
                            passed=spec['guards'][policy]['check']['passed']
                            guarded=raw if passed else compare(testing,scores,chosen,settings['scope'],settings['threshold'],False)
                            results[policy]['raw'][phase]=raw;results[policy]['guarded'][phase]=guarded
                print(json.dumps(dict(session=session,stage='evaluation',variant=variant)),flush=True)
            checks={p:final_check(r['guarded'],policies()[p]['scope']) for p,r in results.items()}
            raw_checks={p:final_check(r['raw'],policies()[p]['scope']) for p,r in results.items()}
            selected=spec['selection']['selected'];fixed=[f'{v}-{k}-0-hybrid' for v in VARIANTS for k in KINDS]
            intervals={p:{phase:{s:block_interval(v['dates']) for s,v in comparison.items()}
                for phase,comparison in results[p]['raw'].items()} for p in dict.fromkeys(fixed+([selected] if selected else []))}
            save(f'{session}-evaluation.json',dict(frozenId=frozen['id'],datasetId=ident,parentReplayMatched=matched,
                quality=quality,selected=selected,results=results,checks=checks,rawDiagnosticChecks=raw_checks,
                diagnosticIntervals=intervals,qualified=selected is not None and checks[selected]['passed'],
                executionEnabled=False,adoptionAllowed=False,historyReused=True))


if __name__=='__main__':
    main()
