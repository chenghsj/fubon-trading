"""Fixed six-policy quote research. Models and reports never reach execution."""
from collections import Counter, defaultdict
from dataclasses import replace
import json
import math
from pathlib import Path

import lightgbm as lgb
import numpy as np

from .candle_patterns import FEATURES as SHAPES, action_shapes, boundary, future_days
from .capture_replay import SCENARIOS, load_tape
from .direction_execution import build, rule_scores
from .intraday_strategy import futures_tax
from .research import digest
from .structured_models import PARAMETERS, _comparison_errors, calibration_check, final_check
from .strategy_session import schedule

ROOT=Path(__file__).resolve().parents[2]
COARSE=SHAPES+['side','trendPlan','stopAtr','targetAtr','frictionAtr','sessionFraction','plannedRiskNTD','auxDirection']
PARAMS=PARAMETERS|dict(num_threads=1)
POLICIES={f'{source}-{kind}':dict(source=source,kind=kind) for source in ('confirmed','paired') for kind in ('rule','coarse','micro')}


def auxiliary(cutoff):
    base=ROOT/'.fubon-dev/reports/recovery-lock-v1';path=base/'frozen.json'
    if not path.exists():return None,dict(reason='缺已保存的股票＋微台共同K棒輔助模型')
    frozen=json.loads(path.read_text())
    if digest({k:v for k,v in frozen.items() if k!='id'})!=frozen['id']:
        raise ValueError('共同K棒父凍結hash不符')
    rows=[r for r in frozen['auxiliaryModels'].values() if r['cutoff']<=cutoff and
        r['metadata'].get('cutoff')==r['cutoff'] and
        r['metadata'].get('maximumLabelEnd') is not None and r['metadata']['maximumLabelEnd']<r['cutoff'] and
        {'TMF','2330','2454','2317','2881'}<=set(r['metadata'].get('byAsset',{}))]
    if not rows:return None,dict(reason='沒有早於新行情研究截止的共同K棒模型')
    record=max(rows,key=lambda r:r['cutoff']);model=json.loads((base/record['file']).read_text())
    if digest(model)!=record['hash'] or model.get('kind')!='tree':raise ValueError('共同K棒模型hash或格式不符')
    return model,dict(parentFrozen=frozen['id'],**record)


def reconciled(group,bars,metadata):
    actual={int(k):v for k,v in metadata['minutes'].items()};ambiguous=set(metadata['ambiguousMinutes']);checked=0;errors=[]
    if metadata['counts'].get('invalidResearchFrames',0):errors.append('研究區間有無效原生訊息')
    if not bars or {b.get('month') for b in bars}!={group['month']}:errors.append('分鐘資料與原生實際月契約不符')
    start=group['startUs']//1_000_000+90*60;end=group['endUs']//1_000_000-5*60
    for bar in bars:
        if not start<=bar['time']<=end or bar['time'] in ambiguous:continue
        checked+=1;observed=actual.get(bar['time'])
        if observed is None or observed!=[bar['low'],bar['high'],bar['volume']]:
            if len(errors)<10:errors.append(f"分鐘價量對帳不符:{bar['time']}")
    if checked<.98*((end-start)//60+1):errors.append('可明確歸屬分鐘少於研究區間98%')
    return dict(passed=not errors,checkedMinutes=checked,ambiguousMinutes=sorted(ambiguous),reasons=errors)


def prepare(database,data,groups,folder,aux_model):
    chosen={g['day']:g for g in groups};events,quality=build(data,sorted(chosen))
    inputs={s:events[s+'-fixed'] for s in ('confirmed','paired')};shapes=action_shapes([a for rows in inputs.values() for a in rows])
    unique={a.time:a for rows in inputs.values() for a in rows}
    booster=lgb.Booster(model_str=aux_model['text'])
    times=sorted(unique);signals=booster.predict(np.asarray([shapes[unique[t].key][0] for t in times]),num_threads=1) if times else []
    auxiliary_values=dict(zip(times,signals,strict=True));rows={s:[] for s in inputs};diagnostics={}
    bars_by_day={day:bars for day,_,bars in future_days(data,sorted(chosen))}
    for day,g in sorted(chosen.items()):
        tape,meta=load_tape(database,g,folder.parent.parent/'normalized')
        check=reconciled(g,bars_by_day.get(day,[]),meta);diagnostics[day]=dict(reconciliation=check,source=meta['orderedPacketHash'])
        if not check['passed']:continue
        for source,values in inputs.items():
            counts=Counter()
            for a in values:
                if a.day!=day:continue
                counts['rawSignals']+=1;x,atr=shapes[a.key];original_time=a.time
                # Whole closed-minute features must also be arrival-causal.
                # Fixed five-second publication allowance, never an adaptive
                # hindsight clock; the original holding deadline stays fixed.
                decision=original_time+5
                if any(int(t)<=original_time and available>decision*1_000_000
                    for t,available in meta['minuteAvailableUs'].items()):
                    counts['minuteNotYetAvailable']+=1;continue
                a=replace(a,time=decision);micro=tape.features(decision,atr)
                if micro is None:counts['missingCausalMicroFeatures']+=1;continue
                friction=4+(40+2*futures_tax(a.bars[a.index]['close'],10,.00002))/10
                coarse=x+[a.side,float(a.plan=='trend'),a.stop/atr,a.target/atr,friction/atr,
                    (a.time-a.start)/(schedule(a.session).duration*60),a.planned_risk,float(auxiliary_values[original_time])]
                labels={name:tape.outcome(a,extra,delay) for name,(extra,delay) in SCENARIOS.items()}
                counts['eligibleSignals']+=1;counts['censoredLabels']+=int(any(v['status']=='censored' for v in labels.values()))
                rows[source].append(dict(action=a,day=day,time=a.time,labelEnd=a.label_end+4,
                    coarse=coarse,micro=coarse+micro,labels=labels,group=g))
            diagnostics[day][source]=dict(counts)
    return rows,quality,diagnostics


def fit(rows,dates,kind,folder,name):
    n=int(len(dates)*.8);fit_dates=dates[:n];calibration=dates[n:]
    cutoff=boundary(calibration[0]) if calibration else 0;selected=[];used=set();censored=0
    for row in sorted(rows,key=lambda r:r['time']):
        a=row['action'];key=(row['day'],a.side,a.plan,row['time']//300)
        if (row['day'] not in fit_dates or row['labelEnd']>=cutoff or key in used
            or row['group']['endUs']>=cutoff*1_000_000):continue
        if any(v['status']=='censored' for v in row['labels'].values()):censored+=1;continue
        used.add(key);selected.append(row)
    meta=dict(fitDates=fit_dates,calibrationDates=calibration,cutoff=cutoff,actions=len(selected),days=len({r['day'] for r in selected}),
        maximumLabelEnd=max((r['labelEnd'] for r in selected),default=None),kind=kind,censoredFitActions=censored,
        labelPopulation='complete-case outcomes only; conditional means may be biased by missing exits')
    if len(selected)<100 or meta['days']<20:return None,meta|dict(reason='fit不足100動作／20開盤日')
    counts=Counter(r['day'] for r in selected);weights=np.array([len(selected)/len(counts)/counts[r['day']] for r in selected])
    x=np.array([r[kind] for r in selected]);models={};records={}
    if not np.isfinite(x).all():raise ValueError('模型特徵非有限')
    for scenario in SCENARIOS:
        y=np.array([r['labels'][scenario]['net'] for r in selected])
        if not np.isfinite(y).all():raise ValueError('金額標籤非有限；不可將未知退出補0')
        model=lgb.train(PARAMS,lgb.Dataset(x,label=y,weight=weights),num_boost_round=150)
        path=folder/f'{name}-{scenario}.txt';model.save_model(str(path))
        records[scenario]=dict(file=path.name,hash=digest(dict(text=model.model_to_string())))
        models[scenario]=model
    return models,meta|dict(models=records,features=x.shape[1])


def scores(rows,model,kind):
    if kind=='rule':return rule_scores([r['action'] for r in rows])
    if model is None:return {r['action'].key:None for r in rows}
    if not rows:return {}
    values=np.min([head.predict(np.array([r[kind] for r in rows]),num_threads=1) for head in model.values()],axis=0)
    if not np.isfinite(values).all():raise ValueError('預測金額非有限')
    return {r['action'].key:float(v) for r,v in zip(rows,values,strict=True)}


def comparison(database,rows,values,dates,kind,cache,enabled=True):
    results={};grouped=defaultdict(list)
    for r in rows:
        if r['day'] in dates:grouped[r['time']].append(r)
    for scenario,(extra,delay) in SCENARIOS.items():
        balance=peak=drawdown=0.;by_day=dict.fromkeys(dates,0.);trades=[];funnel=Counter();complete=True
        day=None;busy=0;entries=0;used=set();realized=0.;tape=None
        for at,candidates in sorted(grouped.items()):
            if candidates[0]['day']!=day:
                day=candidates[0]['day'];entries=0;used=set();realized=0.;busy=0
                tape,_=load_tape(database,candidates[0]['group'],cache)
            if not enabled:funnel['calibrationBlocked']+=1;continue
            if at<busy or entries>=2 or realized<=-1000:funnel['positionOrBudget']+=1;continue
            eligible=[r for r in candidates if r['action'].side not in used and values.get(r['action'].key) is not None and values[r['action'].key]>0]
            if not eligible:funnel['noPositiveScore']+=1;continue
            best=max(eligible,key=lambda r:(values[r['action'].key],r['action'].plan=='range',r['action'].side>0))
            a=best['action'];opposite=[values[r['action'].key] for r in candidates if r['action'].side!=a.side
                and values.get(r['action'].key) is not None]
            if a.source=='paired' and kind!='rule' and opposite and values[a.key]-max(opposite)<30:
                funnel['directionMargin']+=1;continue
            trade=tape.outcome(a,extra,delay,realized,marks=True)
            if trade['status']=='not_sent':funnel[trade['reason']]+=1;continue
            if trade['status']=='censored':
                complete=False;funnel['unknownOpenExposure']+=1;break
            drawdown=max(drawdown,peak-balance-trade['minimumNet'],trade['internalDrawdown'])
            peak=max(peak,balance+trade['maximumNet']);balance+=trade['net'];by_day[day]+=trade['net'];realized+=trade['net']
            entries+=1;used.add(a.side);busy=trade['exitTime'];trades.append(trade|dict(score=values[a.key]))
        results[scenario]=dict(complete=complete,count=len(trades),net=balance if complete else None,
            maxDrawdown=drawdown if complete else None,withoutBestDay=balance-max(by_day.values(),default=0.) if complete else None,
            trades=trades,dates=by_day,funnel=dict(funnel),
            byPlan={p:dict(count=sum(t['plan']==p for t in trades),net=sum(t['net'] for t in trades if t['plan']==p)) for p in ('range','trend')})
    return results


def select(trials):
    records=[]
    for name,folds in trials.items():
        reasons=[]
        if len(folds)!=3:reasons.append('缺三個發展折')
        for i,f in enumerate(folds):
            if not f['calibration']['passed']:reasons.append(f'fold{i}:校準未過')
            reasons.extend(f'fold{i}:{r}' for r in _comparison_errors(f['guarded'],'hybrid',30,None))
        for plan in ('range','trend'):
            branches=[f['guarded']['stress']['byPlan'][plan] for f in folds]
            if sum(v['count'] for v in branches)<20 or sum(v['net'] for v in branches)<=0:reasons.append(plan+':發展分支未達20筆且獲利')
        nets=[f['guarded']['stress']['net'] for f in folds]
        rank=min(nets) if nets and all(isinstance(n,(int,float)) and math.isfinite(n) for n in nets) else None
        records.append(dict(name=name,eligible=not reasons,reasons=reasons,worstStress=rank))
    qualified=sorted([r for r in records if r['eligible']],key=lambda r:r['worstStress'],reverse=True)
    return dict(selected=qualified[0]['name'] if qualified else None,rankings=records,executionAllowed=False,adoptionAllowed=False)


def evaluate(database,minutes,inspection,sessions,folder):
    from .capture_study import eligible_groups
    usable=eligible_groups(inspection,minutes)
    aux,aux_meta=auxiliary(min(boundary(g['day']) for g in usable))
    if aux is None:return dict(blocked=aux_meta,executionAllowed=False,adoptionAllowed=False)
    (folder/'auxiliary.json').write_text(json.dumps(dict(model=aux,metadata=aux_meta),ensure_ascii=False))
    result={};cache=folder.parent.parent/'normalized'
    for session,spec in sessions.items():
        if spec['state']!='ready_for_replay':continue
        dates=spec['dates'];groups=[g for g in usable if g['session']==session and g['day'] in dates]
        rows,quality,diagnostics=prepare(database,minutes[session]['data'],groups,folder,aux)
        dates=[d for d in dates if diagnostics[d]['reconciliation']['passed']]
        if int(int(len(dates)*.6)*.8)<20:
            result[session]=dict(blocked='原生價量／合約對帳後完整fit日期不足20日',usableDates=dates,
                sourceDiagnostics=diagnostics,executionAllowed=False,adoptionAllowed=False)
            continue
        cuts=[int(len(dates)*f) for f in (.3,.4,.5,.6)];trials={p:[] for p in POLICIES};training={}
        for a,b in zip(cuts,cuts[1:]):
            models={}
            for source in ('confirmed','paired'):
                for kind in ('coarse','micro'):
                    key=source+'-'+kind;models[key],training[f'{a}-{key}']=fit(rows[source],dates[:a],kind,folder,f'{session}-{a}-{key}')
            for policy,p in POLICIES.items():
                selected=rows[p['source']];model=models.get(policy);v=scores(selected,model,p['kind'])
                cal=dates[int(a*.8):a]
                calibration=calibration_check(comparison(database,selected,v,cal,p['kind'],cache),'hybrid')
                raw=comparison(database,selected,v,dates[a:b],p['kind'],cache)
                guarded=raw if calibration['passed'] else comparison(database,[],{},dates[a:b],p['kind'],cache,False)
                trials[policy].append(dict(calibration=calibration,raw=raw,guarded=guarded))
        selection=select(trials);a=cuts[-1];b=int(len(dates)*.8);final={}
        for source in ('confirmed','paired'):
            for kind in ('coarse','micro'):
                key=source+'-'+kind;final[key],training[f'final-{key}']=fit(rows[source],dates[:a],kind,folder,f'{session}-final-{key}')
        results={}
        for policy,p in POLICIES.items():
            selected=rows[p['source']];v=scores(selected,final.get(policy),p['kind']);cal=dates[int(a*.8):a]
            cal_metrics=comparison(database,selected,v,cal,p['kind'],cache)
            guard=calibration_check(cal_metrics,'hybrid')
            raw={phase:comparison(database,selected,v,ds,p['kind'],cache) for phase,ds in dict(validation=dates[a:b],historical_reused_test=dates[b:]).items()}
            check=final_check(raw,'hybrid')
            results[policy]=dict(raw=raw,calibration=guard,calibrationMetrics=cal_metrics,finalCheck=check,selected=selection['selected']==policy,
                numericQualified=selection['selected']==policy and guard['passed'] and check['passed'])
        result[session]=dict(dateSplit=dict(development=dates[:a],validation=dates[a:b],historical_reused_test=dates[b:]),
            quality=quality,sourceDiagnostics=diagnostics,training=training,trials=trials,selection=selection,results=results,
            auxiliary=aux_meta,parameters=PARAMS,rounds=150,coarseFeatures=COARSE,microDimensions=95,
            executionAllowed=False,adoptionAllowed=False,historyReused=True)
    return result
