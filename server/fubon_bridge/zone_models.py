"""Fixed NTD entry filters for zone hypotheses, with a frozen past auxiliary."""
from collections import Counter
import math

import numpy as np

from .candle_patterns import FEATURES as SHAPES, boundary, oriented
from .direction_execution import outcome
from .pattern_transfer import tree
from .research import digest
from .structured_models import PARAMETERS, _comparison_errors, _predict_head
from .strategy_session import schedule
from .zone_entry import SOURCES, ZONE_FEATURES, orient_zone

FEATURES=SHAPES+['side','trendPlan','stopATR','targetATR','costATR','sessionFraction','plannedRiskNTD','auxSigned']+[
    'efficiency15','direction15ATR3','distanceMean15ATR3','breakDistanceATR3','body3ATR3','rangeWidthATR3','structuralStop']+ZONE_FEATURES
POLICY=dict(version='zone-entry-values-v1',features=FEATURES,minimumFitDays=20,minimumFitActions=100,
    auxiliaryWarmupDays=60,fitFraction=.8,folds=[.3,.4,.5,.6],dateFractions=[.6,.8],rounds=150,
    parameters=PARAMETERS|dict(num_threads=1),thresholdNTD=0.,target='separate normal/stress/delayed conditional means; unfilled=0',
    executionAllowed=False,adoptionAllowed=False)
SCENARIOS=dict(normal=(0,0),stress=(2,0),delayed=(0,1))
POLICIES={f'{s}-{k}':dict(source=s,kind=k) for s in SOURCES for k in ('rule','value')}


def matrix(events,shapes,auxiliary):
    if not events:return np.empty((0,len(FEATURES)))
    raw=np.asarray([shapes[a.key][0] for a in events]);aux=_predict_head(auxiliary,raw);rows=[]
    for a,prediction in zip(events,aux,strict=True):
        shape,atr=shapes[a.key];friction=a.x[5]/a.x[2]*a.stop
        rows.append(oriented(shape,a.side)+[a.side,float(a.plan=='trend'),a.stop/atr,a.target/atr,friction/atr,
            (a.time-a.start)/(schedule(a.session).duration*60),a.planned_risk,float(prediction)*a.side]+list(a.context)+orient_zone(a.zone,a.side))
    x=np.asarray(rows)
    if x.shape!=(len(events),len(FEATURES)) or not np.isfinite(x).all():raise ValueError('區間金額模型特徵無效')
    return x


def fit(events,dates,shapes,auxiliary,auxiliary_meta):
    cut=int(len(dates)*.8);fit_dates=dates[60:cut];cal=dates[cut:];cutoff=boundary(cal[0]) if cal else 0
    if not fit_dates:return None,dict(fitDates=[],calibrationDates=cal,fitActions=0,fitDays=0,reason='60日暖身後沒有fit日期')
    earliest=boundary(fit_dates[0]) if fit_dates else 0
    if (auxiliary_meta['cutoff']>earliest or auxiliary_meta['metadata']['maximumLabelEnd']>=auxiliary_meta['cutoff']):
        raise ValueError('共同K棒輔助超過最早微台fit截止')
    selected=[];used=set();allowed=set(fit_dates);purged=0
    for a in sorted(events,key=lambda a:a.time):
        if a.day not in allowed:continue
        if a.label_end>=cutoff or a.start+schedule(a.session).duration*60>=cutoff:purged+=1;continue
        key=(a.day,a.side,a.plan,a.time//300)
        if key not in used:used.add(key);selected.append(a)
    meta=dict(fitDates=fit_dates,calibrationDates=cal,calibrationCutoff=cutoff,fitActions=len(selected),
        fitDays=len({a.day for a in selected}),purgedActions=purged,maximumLabelEnd=max((a.label_end for a in selected),default=None),
        auxiliary=auxiliary_meta)
    if len(selected)<100 or meta['fitDays']<20:return None,meta|dict(reason='fit不足100動作／20開盤日')
    x=matrix(selected,shapes,auxiliary);counts=Counter(a.day for a in selected)
    weights=np.asarray([len(selected)/len(counts)/counts[a.day] for a in selected]);heads={};labels={};no_fill={}
    for scenario,(extra,delay) in SCENARIOS.items():
        trades=[outcome(a,extra,delay) for a in selected]
        y=np.asarray([t['net'] if t is not None else 0. for t in trades]);no_fill[scenario]=sum(t is None for t in trades)
        heads[scenario]=tree(x,y,weights,FEATURES,POLICY['parameters'])
        labels[scenario]=dict(mean=float(y.mean()),median=float(np.median(y)))
    model=dict(kind='zone-entry-value',version=1,features=FEATURES,targetUnit='NTD',heads=heads,auxiliary=auxiliary)
    return model,meta|dict(hash=digest(model),labels=labels,noFillActions=no_fill)


def predict(model,events,shapes):
    if model is None:return {a.key:None for a in events}
    if (model.get('kind')!='zone-entry-value' or model.get('version')!=1 or model.get('features')!=FEATURES
        or model.get('targetUnit')!='NTD' or set(model['heads'])!=set(SCENARIOS)):
        raise ValueError('區間模型格式／情境或單位不符')
    if not events:return {}
    x=matrix(events,shapes,model['auxiliary']);values=np.min([_predict_head(head,x) for head in model['heads'].values()],axis=0)
    if not np.isfinite(values).all():raise ValueError('區間模型金額非有限')
    return {a.key:float(v) for a,v in zip(events,values,strict=True)}


def select(trials):
    ranking=[]
    for name in POLICIES:
        folds=trials[name];reasons=[]
        if len(folds)!=3:reasons.append('缺三個發展折')
        for i,f in enumerate(folds):
            if not f['calibration']['passed']:reasons.append(f'fold{i}:校準未過')
            reasons.extend(f'fold{i}:{r}' for r in _comparison_errors(f['guarded'],'hybrid',30,None))
        for plan in ('range','trend'):
            branches=[f['guarded']['stress']['byPlan'][plan] for f in folds]
            if sum(b['count'] for b in branches)<20 or sum(b['net'] for b in branches)<=0:reasons.append(plan+':發展分支不足20或未獲利')
        nets=[f['guarded']['stress']['net'] for f in folds]
        score=min(nets) if nets and all(math.isfinite(n) for n in nets) else None
        ranking.append(dict(name=name,eligible=not reasons,reasons=reasons,worstStress=score))
    eligible=sorted([r for r in ranking if r['eligible']],key=lambda r:r['worstStress'],reverse=True)
    return dict(selected=eligible[0]['name'] if eligible else None,rankings=ranking,adoptionAllowed=False,executionAllowed=False)
