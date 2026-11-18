"""All-policy accounting, opportunity cost of locks, paired exits and forecast errors."""
import argparse
import csv
from importlib import import_module
import json
from pathlib import Path

from fubon_bridge.direction_execution import outcome as fixed_outcome, prepare
from fubon_bridge.loss_diagnostics import decompose, distribution, matched_latency
from fubon_bridge.position_value import ExitEngine as ParentEngine, FEATURES as BASE_FEATURES, cash, states
from fubon_bridge.recovery_lock import RecoveryEngine, SCENARIOS, VARIANTS
from fubon_bridge.research import digest

study=import_module('research-recovery-lock')
DELAYS={name:delay for name,_,delay in SCENARIOS}


def holding_minutes(trade,delay=0):
    # Signal is the prior minute close; delayed entry is one open later.
    return (trade['exitTime']-trade['time'])/60-delay


def load_frozen(source):
    frozen=json.loads((source/'frozen.json').read_text())
    if digest({k:v for k,v in frozen.items() if k!='id'})!=frozen['id'] or frozen['implementation']!=study.hashes():
        raise ValueError('摘要凍結或實作不符')
    reference=json.loads((study.REFERENCE/'frozen.json').read_text())
    if digest({k:v for k,v in reference.items() if k!='id'})!=frozen['parentFrozen']:
        raise ValueError('摘要父凍結不符')
    study.ARTIFACTS=source
    return frozen,study.load_banks(frozen)


def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--source',type=Path,default=study.ARTIFACTS)
    parser.add_argument('--database',type=Path,default=study.ROOT/'server/.research.sqlite3');args=parser.parse_args()
    frozen,banks=load_frozen(args.source);csv_rows=[];summary=dict(frozenId=frozen['id'],postmortemOnly=True,selectionChanged=False,sessions={})
    for session,(ident,data,dates) in study.base.datasets(args.database).items():
        spec=frozen['sessions'][session];report=json.loads((args.source/f'{session}-evaluation.json').read_text())
        if ident!=spec['datasetId'] or report['datasetId']!=ident or report['frozenId']!=frozen['id']:
            raise ValueError('摘要評估來源不符')
        accounting={};locks={};paired={};forecast={};mean_matches=0
        for p,value in report['results'].items():
            for mode,periods in value.items():
                for phase,scenarios in periods.items():
                    for scenario,result in scenarios.items():
                        detail=decompose(result['trades'],4 if scenario=='stress' else 2)
                        if detail['net']!=result['net']:
                            raise ValueError('交易加總與現金流不符')
                        csv_rows.append(dict(session=session,policy=p,mode=mode,phase=phase,scenario=scenario,
                            count=result['count'],net=result['net'],maxDrawdown=result['maxDrawdown'],withoutBestDay=result['withoutBestDay'],
                            fixedPathGross=detail['fixedPathGross'],fees=detail['fees'],taxes=detail['taxes'],slippage=detail['slippage']))
                        if mode=='raw':
                            accounting.setdefault(p,{}).setdefault(phase,{})[scenario]=dict(**detail,
                                loserHoldingMinutes=distribution([holding_minutes(t,DELAYS[scenario]) for t in result['trades'] if t['net']<0]),
                                winnerHoldingMinutes=distribution([holding_minutes(t,DELAYS[scenario]) for t in result['trades'] if t['net']>0]),funnel=result['funnel'])
        for v in VARIANTS:
            for entry in ('rule','cash'):
                for phase in ('validation','historical_reused_test'):
                    for scenario,_,_ in SCENARIOS:
                        free=report['results'][f'{v}-{entry}-free']['raw'][phase][scenario]
                        locked=report['results'][f'{v}-{entry}-lock']['raw'][phase][scenario]
                        key=lambda t:(t['time'],t['side'],t['plan'])
                        left={key(t):t for t in free['trades']};right={key(t):t for t in locked['trades']}
                        if not right.keys()<=left.keys() or any(left[k]!=t for k,t in right.items()):
                            raise ValueError('lock不是相同交易的子集')
                        removed=[t for k,t in left.items() if k not in right]
                        net=sum(t['net'] for t in removed)
                        if abs(locked['net']-free['net']+net)>1e-7:
                            raise ValueError('退出後鎖的機會成本不符')
                        locks[f'{v}-{entry}-{phase}-{scenario}']=dict(freeCount=free['count'],lockedCount=locked['count'],
                            freeNet=free['net'],lockedNet=locked['net'],difference=locked['net']-free['net'],
                            removed=decompose(removed,4 if scenario=='stress' else 2),
                            blockedWinners=sum(t['net']>0 for t in removed),blockedWinnerNet=sum(t['net'] for t in removed if t['net']>0),
                            blockedLosers=sum(t['net']<0 for t in removed),blockedLoserNet=sum(t['net'] for t in removed if t['net']<0),trades=removed)
        events,_=study.build(data,dates[int(len(dates)*.6):])
        for source in ('confirmed','paired'):
            lookup={a.key:a for a in events[source+'-fixed']};engines={};old_mean=None
            for family in ('mean','protected'):
                v=source+'-'+family;cutoff=str(spec['training'][v]['finalCutoff']);model=banks[session][cutoff][family]
                engines[family]=RecoveryEngine(model,family)
                if family=='mean':
                    old_mean=ParentEngine(None if model is None else dict(kind='position_value',version=1,features=BASE_FEATURES,targetUnit='NTD',head=model['heads']['mean']))
            for phase in ('validation','historical_reused_test'):
                for scenario,extra,delay in SCENARIOS:
                    trades=report['results'][source+'-fixed-rule-free']['raw'][phase][scenario]['trades']
                    for family,engine in engines.items():
                        records=[];errors=[]
                        for t in trades:
                            a=lookup[t['time'],1 if t['side']=='Buy' else -1,t['plan']]
                            fixed=fixed_outcome(a,extra,delay);changed=engine.outcome(a,extra,delay)
                            if fixed['net']!=t['net']:
                                raise ValueError('原入場無法重現')
                            if family=='mean':
                                if engine.outcome(a,extra,delay,marks=True)!=old_mean.outcome(a,extra,delay,marks=True):
                                    raise ValueError('近期mean與父engine同模型回放不符')
                                if changed is not None:
                                    mean_matches+=1
                            records.append(dict(time=a.time,day=a.day,side=t['side'],plan=a.plan,fixedNet=fixed['net'],
                                changedNet=changed['net'] if changed else None,fixedMinutes=holding_minutes(fixed,delay),
                                changedMinutes=holding_minutes(changed,delay) if changed else None,reason=changed['reason'] if changed else 'missingModel'))
                            if scenario=='normal' and engine.model is not None:
                                rows=states(a,cache=engine.cache);values,probabilities=engine.values(a,rows)
                                _,fill,_=prepare(a);last=None;streak=0
                                for r,v,p in zip(rows,values,probabilities,strict=True):
                                    allowed=v<-30 and (family=='mean' or p<=.25)
                                    streak=(streak+1 if last is not None and r['time']-last==180 else 1) if allowed else 0;last=r['time']
                                    actual=fixed['net']-cash(fill['entry'],a.bars[r['index']+1]['open'],a.side,fill['slip'])
                                    errors.append(dict(predicted=float(v),actual=actual,wouldExit=streak>=(1 if family=='mean' else 2),probability=p))
                        valid=[r for r in records if r['changedNet'] is not None];losers=[r for r in valid if r['fixedNet']<0]
                        actual=report['results'][f'{source}-{family}-rule-free']['raw'][phase][scenario]['trades']
                        matched=matched_latency(trades,actual)
                        paired[f'{source}-{family}-{phase}-{scenario}']=dict(independentEntriesOnly=True,notDeployablePortfolio=True,
                            count=len(records),valid=len(valid),fixedNet=sum(r['fixedNet'] for r in valid),changedNet=sum(r['changedNet'] for r in valid),
                            loserMinutesBefore=distribution([r['fixedMinutes'] for r in losers]),loserMinutesAfter=distribution([r['changedMinutes'] for r in losers]),
                            losersImproved=sum(r['changedNet']>r['fixedNet'] for r in losers),losersWorsened=sum(r['changedNet']<r['fixedNet'] for r in losers),
                            winnersTruncated=sum(r['fixedNet']>0 and r['changedNet']<r['fixedNet'] for r in valid),
                            winnersTurnedNonpositive=sum(r['fixedNet']>0 and r['changedNet']<=0 for r in valid),
                            portfolioMatched=matched,details=records)
                        if scenario=='normal':
                            bad=[r for r in errors if r['actual']<-30];good=[r for r in errors if r['actual']>0]
                            forecast[f'{source}-{family}-{phase}']=dict(states=len(errors),correlatedFixedBaselineStates=True,
                                mayFollowNewPolicyExit=True,badContinuation=len(bad),badHeld=sum(not r['wouldExit'] for r in bad),
                                goodContinuation=len(good),goodCut=sum(r['wouldExit'] for r in good),
                                predicted=distribution([r['predicted'] for r in errors]),actual=distribution([r['actual'] for r in errors]),
                                absoluteError=distribution([abs(r['predicted']-r['actual']) for r in errors]),
                                recoveryProbability=distribution([float(r['probability']) for r in errors if r['probability'] is not None]))
        summary['sessions'][session]=dict(accounting=accounting,lockOpportunityCosts=locks,sameEntryCounterfactuals=paired,
            forecastErrors=forecast,parentReplayMatches=study.verify_parent(report['results'],session),meanParentEngineMatches=mean_matches)
    with (args.source/'all-policy-results.csv').open('x') as stream:
        writer=csv.DictWriter(stream,fieldnames=list(csv_rows[0]));writer.writeheader();writer.writerows(csv_rows)
    with (args.source/'loss-summary.json').open('x') as stream:
        json.dump(summary,stream,ensure_ascii=False,indent=2,allow_nan=False)
    print(json.dumps(dict(rows=len(csv_rows),frozenId=frozen['id'])))


if __name__=='__main__':
    main()
