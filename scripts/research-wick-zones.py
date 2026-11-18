"""Fixed, two-stage, offline-only entry study. Does not import a broker."""
import argparse
from importlib import import_module
import hashlib
import json
from pathlib import Path
import sys

import lightgbm as lgb
import numpy as np

from fubon_bridge.candle_patterns import action_shapes,boundary
from fubon_bridge.capture_models import auxiliary
from fubon_bridge.confirmed_models import block_interval
from fubon_bridge.direction_execution import compare,rule_scores
from fubon_bridge.loss_diagnostics import decompose
from fubon_bridge.mapping import now
from fubon_bridge.research import digest
from fubon_bridge.structured_models import calibration_check,final_check
from fubon_bridge.zone_entry import build,POLICY
from fubon_bridge.zone_models import POLICIES,POLICY as MODEL_POLICY,fit,predict

ROOT=Path(__file__).resolve().parents[1]
base=import_module('refine-regime')


def save(folder,name,value):
    folder.mkdir(parents=True,exist_ok=True)
    with (folder/name).open('x') as f:json.dump(value,f,ensure_ascii=False,indent=2,allow_nan=False)


def hashes():
    paths=[Path(__file__),ROOT/'scripts/refine-regime.py',ROOT/'scripts/diagnose-entry-quality.py',ROOT/'docs/research/tmf-wick-volume-zones-protocol-v1.md',
        *sorted((ROOT/'server/fubon_bridge').glob('*.py'))]
    return {str(p.relative_to(ROOT)):hashlib.sha256(p.read_bytes()).hexdigest() for p in paths}


def compact(value):
    return {scenario:{k:v for k,v in result.items() if k!='trades'} for scenario,result in value.items()}


def scored(kind,model,events,shapes):
    return rule_scores(events) if kind=='rule' else predict(model,events,shapes)


def develop(folder,session,data,dates,aux,aux_meta):
    from fubon_bridge.zone_models import select
    cuts=[int(len(dates)*f) for f in (.3,.4,.5,.6)]
    events,quality=build(data,dates[:cuts[-1]])
    shapes=action_shapes([a for rows in events.values() for a in rows]);trials={p:[] for p in POLICIES};training={}
    for a,b in zip(cuts,cuts[1:]):
        for source in events:
            prior=[e for e in events[source] if e.day in set(dates[:a])]
            held=[e for e in events[source] if e.day in set(dates[a:b])]
            model,meta=fit(prior,dates[:a],shapes,aux,aux_meta)
            save(folder,f'{session}-{a}-{source}-model.json',model);training[f'{a}-{source}']=meta
            for kind in ('rule','value'):
                name=source+'-'+kind;cal=dates[int(a*.8):a];cal_events=[e for e in prior if e.day in set(cal)]
                cv=scored(kind,model,cal_events,shapes);v=scored(kind,model,held,shapes)
                cm=compare(cal_events,cv,cal,'hybrid');guard=calibration_check(cm,'hybrid')
                raw=compare(held,v,dates[a:b],'hybrid');guarded=raw if guard['passed'] else compare([],{},dates[a:b],'hybrid')
                trials[name].append(dict(calibration=guard,calibrationMetrics=compact(cm),raw=compact(raw),guarded=compact(guarded)))
            print(json.dumps(dict(session=session,fold=[a,b],source=source,fitActions=meta['fitActions'],fitDays=meta['fitDays'])),flush=True)
    selection=select(trials);models={};guards={};a=cuts[-1];cal=dates[int(a*.8):a]
    for source,values in events.items():
        model,meta=fit(values,dates[:a],shapes,aux,aux_meta);file=f'{session}-final-{source}-model.json'
        save(folder,file,model);models[source]=dict(file=file,hash=digest(model),metadata=meta)
        chosen=[e for e in values if e.day in set(cal)]
        for kind in ('rule','value'):
            name=source+'-'+kind;v=scored(kind,model,chosen,shapes);metrics=compare(chosen,v,cal,'hybrid')
            guards[name]=dict(check=calibration_check(metrics,'hybrid'),metrics=compact(metrics))
    report=dict(quality=quality,training=training,trials=trials,selection=selection)
    save(folder,f'{session}-development.json',report)
    return dict(models=models,guards=guards,selection=selection,
        dateSplit=dict(development=dates[:a],validation=dates[a:int(len(dates)*.8)],historical_reused_test=dates[int(len(dates)*.8):]))


def evaluate(folder,session,data,dates,spec,frozen):
    a=int(len(dates)*.6);b=int(len(dates)*.8);events,quality=build(data,dates[a:]);shapes=action_shapes([e for rows in events.values() for e in rows])
    results={}
    for name,p in POLICIES.items():
        record=spec['models'][p['source']];model=json.loads((folder/record['file']).read_text())
        if digest(model)!=record['hash']:raise ValueError('新進場模型hash不符')
        results[name]=dict(raw={},guarded={},accounting={},dailyIntervals={})
        for phase,ds in (('validation',dates[a:b]),('historical_reused_test',dates[b:])):
            chosen=[e for e in events[p['source']] if e.day in set(ds)];v=scored(p['kind'],model,chosen,shapes)
            raw=compare(chosen,v,ds,'hybrid');guarded=raw if spec['guards'][name]['check']['passed'] else compare([],{},ds,'hybrid')
            results[name]['raw'][phase]=raw;results[name]['guarded'][phase]=guarded
            results[name]['accounting'][phase]={s:decompose(r['trades'],2+(2 if s=='stress' else 0)) for s,r in raw.items()}
            results[name]['dailyIntervals'][phase]={s:block_interval(r['dates']) for s,r in raw.items()}
        print(json.dumps(dict(session=session,policy=name,historyNet=results[name]['raw']['historical_reused_test']['normal']['net'])),flush=True)
    checks={name:final_check(r['guarded'],'hybrid') for name,r in results.items()};selected=spec['selection']['selected']
    save(folder,f'{session}-evaluation.json',dict(frozenId=frozen['id'],quality=quality,results=results,checks=checks,
        rawChecks={n:final_check(r['raw'],'hybrid') for n,r in results.items()},selected=selected,
        numericQualified=selected is not None and checks[selected]['passed'],historyReused=True,executionAllowed=False,adoptionAllowed=False))


def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--stage',required=True,choices=['development','evaluation'])
    parser.add_argument('--database',type=Path,default=ROOT/'server/.research.sqlite3');parser.add_argument('--output',type=Path,required=True)
    args=parser.parse_args();sources=base.datasets(args.database);implementation=hashes()
    identity=dict(implementation=implementation,packages=dict(python=sys.version,numpy=np.__version__,lightgbm=lgb.__version__),
        executionPolicy=POLICY,modelPolicy=MODEL_POLICY,datasetIds={s:v[0] for s,v in sources.items()})
    if args.stage=='development':
        args.output.mkdir(parents=True,exist_ok=False)
        # Bind immutable protocol/source identity before any new performance is
        # read; the final frozen also records all trained native heads/choices.
        save(args.output,'predeclared.json',identity)
        for file,expected in implementation.items():
            target=args.output/'source'/file;target.parent.mkdir(parents=True,exist_ok=True)
            raw=(ROOT/file).read_bytes()
            if hashlib.sha256(raw).hexdigest()!=expected:raise ValueError('凍結期間來源改變')
            with target.open('xb') as stream:stream.write(raw)
        cutoff=min(boundary(dates[60]) for _,_,dates in sources.values());aux,record=auxiliary(cutoff)
        if aux is None:raise ValueError('缺少早於cash訓練的固定共同K棒模型')
        save(args.output,'auxiliary.json',dict(model=aux,record=record));frozen=dict(createdAt=now().isoformat(),**identity,auxiliary=record,sessions={})
        for session,(_,data,dates) in sources.items():frozen['sessions'][session]=develop(args.output,session,data,dates,aux,record)
        frozen['id']=digest(frozen);save(args.output,'frozen.json',frozen)
    else:
        frozen=json.loads((args.output/'frozen.json').read_text())
        if digest({k:v for k,v in frozen.items() if k!='id'})!=frozen['id']:raise ValueError('新進場研究frozen hash不符')
        if any(json.loads(json.dumps(frozen[k]))!=json.loads(json.dumps(v)) for k,v in identity.items()):
            raise ValueError('資料／程式／規格／套件已改變；不能開後段')
        if any(hashlib.sha256((args.output/'source'/file).read_bytes()).hexdigest()!=expected for file,expected in implementation.items()):
            raise ValueError('已保存來源快照hash不符')
        saved=json.loads((args.output/'auxiliary.json').read_text())
        if saved['record']!=frozen['auxiliary'] or digest(saved['model'])!=saved['record']['hash']:raise ValueError('aux保存hash不符')
        for session,(_,data,dates) in sources.items():evaluate(args.output,session,data,dates,frozen['sessions'][session],frozen)


if __name__=='__main__':main()
