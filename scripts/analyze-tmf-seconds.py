"""Audit official trades against minute history, then compare price-only forecasts."""
import argparse
from collections import Counter, defaultdict
import csv
from datetime import datetime
import gzip
import hashlib
from importlib import import_module
import json
from pathlib import Path
import platform

import lightgbm as lgb
import numpy as np

from fubon_bridge.candle_patterns import FEATURES as CANDLE_FEATURES, boundary, future_days, shape
from fubon_bridge.mapping import TAIPEI
from fubon_bridge.microstructure_data import read_archive
from fubon_bridge.microstructure_research import FEATURES, SecondTape
from fubon_bridge.research import digest

ROOT=Path(__file__).resolve().parents[1]
PARAMS=dict(objective='regression',metric='l2',num_leaves=7,max_depth=3,min_data_in_leaf=40,
    lambda_l2=100,learning_rate=.03,seed=42,num_threads=1,verbosity=-1,deterministic=True,force_col_wise=True)


def save(path,value):
    with path.open('x') as f:
        json.dump(value,f,ensure_ascii=False,indent=2,allow_nan=False)


def load(source,sources):
    manifest=json.loads((source/'manifest.json').read_text());minute={};groups={};mapping={}
    for session,(_,data,dates) in sources.items():
        for day,start,bars in future_days(data,dates):
            ident=(session,day,bars[0]['month']);groups[ident]=(start,bars)
            for b in bars:
                key=(b['time'],b['month']);minute[key]=b;mapping[key]=ident
    accum={};tapes=defaultdict(list);ranges=[]
    totals=Counter()
    verified=[]
    for record in manifest['archives']:
        raw=source/record['archive']
        if hashlib.sha256(raw.read_bytes()).hexdigest()!=record['quality']['archiveSha256']:
            raise ValueError('官方原始ZIP hash不符')
        quality=record['quality']
        _,expected,actual_quality=read_archive(raw.read_bytes(),record['archive'].replace('.zip','.csv'),
            datetime.fromisoformat(manifest['completedAt']).timestamp())
        if actual_quality!=quality:
            raise ValueError('重新解析原始CSV與資料品質紀錄不符')
        for k in ('prints','quantityBothSides','oddQuantityRows','auctionPrints','tradedContractSeconds','multiplePrintSeconds','multiplePriceSeconds','excludedNonMonthlyRows'):
            totals[k]+=quality.get(k,0)
        first=None;last=None
        seconds_path=source/(record['tradingDate']+'-seconds.jsonl.gz')
        with gzip.open(seconds_path,'rt') as stream:
            for line,original in zip(stream,expected,strict=True):
                s=json.loads(line);t=s['time'];month=s['month'];key=((t//60+1)*60,month)
                if s!=original:
                    raise ValueError('秒級衍生檔與官方ZIP重新解析結果不符')
                first=t if first is None else min(t,first);last=t if last is None else max(t,last)
                if key not in minute:
                    continue
                v=accum.get(key)
                if v is None:
                    accum[key]=[s['low'],s['high'],s['quantityBothSides'],t,s['low'],s['high'],t,s['low'],s['high']]
                else:
                    v[0]=min(v[0],s['low']);v[1]=max(v[1],s['high']);v[2]+=s['quantityBothSides']
                    if t<v[3]:
                        v[3:6]=[t,s['low'],s['high']]
                    if t>v[6]:
                        v[6:9]=[t,s['low'],s['high']]
                tapes[mapping[key]].append((t,s['vwap'],s['low'],s['high'],s['quantityBothSides'],s['trades']))
        ranges.append(dict(tradingDate=record['tradingDate'],first=first,last=last))
        verified.append(dict(file=seconds_path.name,sha256=hashlib.sha256(seconds_path.read_bytes()).hexdigest(),rows=len(expected)))
        print(json.dumps(dict(audited=record['tradingDate'],matchedMinutes=len(accum))),flush=True)
    physical=sorted(ranges,key=lambda r:r['first'])
    if any(a['last']>=b['first'] for a,b in zip(physical,physical[1:])):
        raise ValueError('不同日檔的實體秒區間重疊，需先查明重複來源')
    reconciliation={};eligible={}
    for session in sources:
        checks=Counter();examples=[];available=[]
        for ident,(start,bars) in groups.items():
            if ident[0]!=session:
                continue
            found=[b for b in bars if (b['time'],b['month']) in accum]
            if len(found)>=.99*len(bars):
                available.append(ident)
            for b in found:
                v=accum[(b['time'],b['month'])];checks['matchedMinutes']+=1
                tests=dict(highLow=v[0]==b['low'] and v[1]==b['high'],
                    volumeRaw=v[2]==b['volume'],volumeHalf=v[2]/2==b['volume'],
                    openWithinFirstSecond=v[4]<=b['open']<=v[5],closeWithinLastSecond=v[7]<=b['close']<=v[8])
                checks.update({k:int(x) for k,x in tests.items()})
                if not all(tests[k] for k in ('highLow','volumeHalf','openWithinFirstSecond','closeWithinLastSecond')) and len(examples)<10:
                    examples.append(dict(time=b['time'],month=b['month'],api=b,publicSecondSummary=v,checks=tests))
        reconciliation[session]=dict(checks=checks,matchRates={k:v/checks['matchedMinutes'] for k,v in checks.items() if k!='matchedMinutes'},
            examples=examples,coverageDates=[x[1] for x in sorted(available)])
        eligible[session]=sorted(available,key=lambda x:x[1])
    audit=dict(manifestSha256=hashlib.sha256((source/'manifest.json').read_bytes()).hexdigest(),
        tradingDates=sorted(r['tradingDate'] for r in manifest['archives']),archives=len(ranges),
        totals=dict(totals),physicalRanges=physical,verifiedSeconds=verified,reconciliation=reconciliation,quoteRows=0,
        sameSecondOrderKnown=False,executionAllowed=False,adoptionAllowed=False)
    return audit,groups,tapes,eligible


def observations(groups,tapes,idents):
    rows=[];excluded=Counter()
    for ident in idents:
        session,day,month=ident;start,bars=groups[ident];tape=SecondTape(tapes[ident])
        for i,b in enumerate(bars):
            minute=(b['time']-start)//60
            if minute<90 or minute%3 or i==len(bars)-1:
                continue
            coarse=shape(bars,i,start)
            if coarse is None:
                excluded['coarseHistory']+=1;continue
            x,atr=coarse;at=b['time'];micro=tape.features(at,atr);label=tape.label(at,atr)
            if micro is None or label is None:
                excluded['secondsCoverage']+=1;continue
            past5=micro[2]*atr
            rows.append(dict(day=day,time=at,month=month,atr=atr,
                coarse=[*x,minute/len(bars)],micro=micro,prior5Points=past5,
                reversal=past5*label['points']<0 if past5 else None,**label))
    return rows,dict(excluded)


def metrics(rows,prediction):
    if not rows:
        return dict(observations=0,days=0)
    target=np.array([r['target'] for r in rows]);atr=np.array([r['atr'] for r in rows]);p=np.asarray(prediction)
    errors=abs(p-target);daily=[]
    for day in sorted({r['day'] for r in rows}):
        mask=np.array([r['day']==day for r in rows]);daily.append(dict(day=day,maeAtr=float(errors[mask].mean())))
    mask=target!=0
    return dict(observations=len(rows),days=len(daily),maeAtr=float(errors.mean()),
        dailyMeanMaeAtr=float(np.mean([r['maeAtr'] for r in daily])),
        clippedTargetMaePoints=float(np.mean(errors*atr)),
        rawPriceMaePoints=float(np.mean(abs(p*atr-np.array([r['points'] for r in rows])))),
        nonzeroDirectionObservations=int(mask.sum()),
        directionAccuracy=float(np.mean(np.sign(p[mask])==np.sign(target[mask]))) if mask.any() else None,daily=daily)


def run_session(session,groups,tapes,idents,out):
    dates=[x[1] for x in idents];a=int(len(dates)*.6);b=int(len(dates)*.8)
    split=dict(fit=dates[:a],validation=dates[a:b],reused_history=dates[b:])
    rows,excluded=observations(groups,tapes,idents)
    cutoff=boundary(split['validation'][0]) if split['validation'] else 0
    fit=[r for r in rows if r['day'] in set(split['fit']) and r['labelEnd']<cutoff]
    with gzip.open(out/f'{session}-observations.jsonl.gz','wt') as f:
        for r in rows:
            f.write(json.dumps(r,ensure_ascii=False,allow_nan=False)+'\n')
    report=dict(dateSplit=split,validObservations=len(rows),excluded=excluded,models={},metrics={},
        purgedFitObservations=sum(r['day'] in set(split['fit']) and r['labelEnd']>=cutoff for r in rows),
        executionAllowed=False,adoptionAllowed=False,netProfit=None,
        pathDiagnostics=dict(reversalEligible=sum(r['reversal'] is not None for r in rows),
            reversals=sum(r['reversal'] is True for r in rows),
            meanLongVwapGivebackPoints=float(np.mean([r['longVwapGivebackPoints'] for r in rows])) if rows else None,
            meanShortVwapGivebackPoints=float(np.mean([r['shortVwapGivebackPoints'] for r in rows])) if rows else None))
    if len({r['day'] for r in fit})<10 or len(fit)<1000 or not split['validation'] or not split['reused_history']:
        return report|dict(blocked='探索fit不足10日／1000觀測，或後段日期不足')
    if any(r['labelEnd']>=cutoff for r in fit):
        raise ValueError('fit標籤越過validation截止')
    counts=Counter(r['day'] for r in fit);weight=np.array([len(fit)/len(counts)/counts[r['day']] for r in fit])
    all_predictions={};all_metrics={}
    for variant in ('coarse','seconds'):
        x=np.array([r['coarse']+(r['micro'] if variant=='seconds' else []) for r in fit]);y=np.array([r['target'] for r in fit])
        model=lgb.train(PARAMS,lgb.Dataset(x,label=y,weight=weight),num_boost_round=100)
        path=out/f'{session}-{variant}.txt';model.save_model(str(path))
        report['models'][variant]=dict(file=path.name,sha256=hashlib.sha256(path.read_bytes()).hexdigest(),
            fitDays=len(counts),fitObservations=len(fit),features=x.shape[1],maximumLabelEnd=max(r['labelEnd'] for r in fit),cutoff=cutoff)
        all_predictions[variant]=model.predict(np.array([r['coarse']+(r['micro'] if variant=='seconds' else []) for r in rows]))
    all_predictions['zero']=np.zeros(len(rows))
    for phase,days in split.items():
        mask=np.array([r['day'] in set(days) and (phase!='fit' or r['labelEnd']<cutoff) for r in rows])
        subset=[r for r,keep in zip(rows,mask,strict=True) if keep]
        all_metrics[phase]={v:metrics(subset,p[mask]) for v,p in all_predictions.items()}
    report['metrics']=all_metrics
    paired=[s['maeAtr']-c['maeAtr'] for s,c in zip(all_metrics['reused_history']['seconds']['daily'],all_metrics['reused_history']['coarse']['daily'],strict=True)]
    if paired:
        rng=np.random.default_rng(42);sample=np.asarray(paired);boot=rng.choice(sample,(2000,len(sample)),replace=True).mean(axis=1)
        report['pairedDayBootstrap']=dict(days=len(sample),meanMaeDifference=float(sample.mean()),
            percentile95=[float(x) for x in np.quantile(boot,[.025,.975])],unit='daily MAE in ATR; seconds minus coarse',iterations=2000)
    with (out/f'{session}-observations.csv').open('x',newline='') as f:
        columns=['day','time','month','atr','target','points','prior5Points','reversal','longFavorableVwapPoints','shortFavorableVwapPoints',
            'longVwapGivebackPoints','shortVwapGivebackPoints','labelEnd','coarsePredictionAtr','secondsPredictionAtr']
        writer=csv.DictWriter(f,fieldnames=columns);writer.writeheader()
        for i,r in enumerate(rows):
            writer.writerow({k:r[k] for k in columns if k in r}|dict(coarsePredictionAtr=float(all_predictions['coarse'][i]),secondsPredictionAtr=float(all_predictions['seconds'][i])))
    return report


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source',type=Path,default=ROOT/'.fubon-dev/tick-research/taifex-tmf-v1')
    parser.add_argument('--output',type=Path,default=ROOT/'.fubon-dev/reports/seconds-v1')
    parser.add_argument('--audit-only',action='store_true');args=parser.parse_args();out=args.output;out.mkdir(parents=True,exist_ok=True)
    sources=import_module('refine-regime').datasets(ROOT/'server/.research.sqlite3')
    paths=[Path(__file__),ROOT/'scripts/fetch-taifex-tmf-ticks.py',ROOT/'scripts/refine-regime.py',
        *(ROOT/'server/fubon_bridge'/name for name in ('microstructure_data.py','microstructure_research.py',
            'candle_patterns.py','learning_data.py','learning_multiframe.py','strategy_session.py','research.py','mapping.py')),
        ROOT/'docs/research/tmf-seconds-protocol-v1.md']
    spec=dict(createdAt=datetime.now(TAIPEI).isoformat(),implementation={p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in paths},
        datasets={s:i for s,(i,_,_) in sources.items()},params=PARAMS,rounds=100,
        packages=dict(python=platform.python_version(),lightgbm=lgb.__version__,numpy=np.__version__),
        coarseFeatures=[*CANDLE_FEATURES,'sessionFraction'],secondsFeatures=FEATURES,
        sourceManifestSha256=hashlib.sha256((args.source/'manifest.json').read_bytes()).hexdigest(),executionAllowed=False,adoptionAllowed=False)
    spec['id']=digest(spec);save(out/'frozen-spec.json',spec)
    audit,groups,tapes,eligible=load(args.source,sources);save(out/'audit.json',audit)
    if args.audit_only:
        print(json.dumps(audit['reconciliation'],ensure_ascii=False));return
    report=dict(frozenId=spec['id'],sessions={},executionAllowed=False,adoptionAllowed=False,netProfit=None)
    for session in sources:
        rates=audit['reconciliation'][session]['matchRates']
        if any(rates.get(k,0)<.995 for k in ('highLow','openWithinFirstSecond','closeWithinLastSecond')):
            report['sessions'][session]=dict(blocked='分鐘high/low或首末秒必要條件對帳未達99.5%，先查明來源差異')
        else:
            report['sessions'][session]=run_session(session,groups,tapes,eligible[session],out)
        save(out/f'{session}-result.json',report['sessions'][session])
        print(json.dumps(dict(session=session,result=report['sessions'][session]),ensure_ascii=False),flush=True)
    save(out/'report.json',report)


if __name__=='__main__':
    main()
