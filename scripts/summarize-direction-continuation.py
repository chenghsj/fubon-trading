"""Reconcile all frozen direction policies and diagnose identical-entry exits."""
from dataclasses import replace
from importlib import import_module
import csv
import json
from pathlib import Path

from fubon_bridge.confirmed_execution import outcome as old_outcome
from fubon_bridge.direction_execution import build, outcome
from fubon_bridge.loss_diagnostics import decompose, distribution, matched_latency
from fubon_bridge.research import digest

base=import_module('refine-regime')
ROOT=Path(__file__).resolve().parents[1]
SOURCE=ROOT/'.fubon-dev/reports/direction-continuation-v1-clarified'


def main():
    frozen=json.loads((SOURCE/'frozen.json').read_text())
    if digest({k:v for k,v in frozen.items() if k!='id'})!=frozen['id']:
        raise ValueError('凍結雜湊不符')
    rows=[];summary=dict(frozenId=frozen['id'],postmortemOnly=True,selectionChanged=False,sessions={})
    for session,(ident,data,dates) in base.datasets(ROOT/'server/.research.sqlite3').items():
        report=json.loads((SOURCE/f'{session}-evaluation.json').read_text())
        if report['frozenId']!=frozen['id'] or report['datasetId']!=ident:
            raise ValueError('資料或評估凍結不符')
        accounting={}
        for policy,result in report['results'].items():
            for mode,periods in result.items():
                for phase,comparison in periods.items():
                    for scenario,value in comparison.items():
                        detail=decompose(value['trades'],slip=4 if scenario=='stress' else 2)
                        if detail['net']!=value['net']:
                            raise ValueError('交易加總與現金流不符')
                        rows.append(dict(session=session,policy=policy,mode=mode,phase=phase,scenario=scenario,
                            count=value['count'],net=value['net'],maxDrawdown=value['maxDrawdown'],
                            withoutBestDay=value['withoutBestDay'],grossSamePath=detail['fixedPathGross'],
                            fees=detail['fees'],taxes=detail['taxes'],slippage=detail['slippage']))
                        if mode=='raw' and scenario=='normal':
                            trades=value['trades']
                            accounting.setdefault(policy,{})[phase]=dict(**detail,
                                buy=sum(t['side']=='Buy' for t in trades),sell=sum(t['side']=='Sell' for t in trades),
                                predictedScore=distribution([t['score'] for t in trades]),
                                negativeTrades=sum(t['net']<0 for t in trades))
        a=int(len(dates)*.6);events,_=build(data,dates[a:])
        lookup={e.key:e for e in events['confirmed-fixed']};matches={};counterfactuals={}
        for phase in ('validation','historical_reused_test'):
            for source in ('confirmed','paired'):
                left=report['results'][f'{source}-fixed-rule-hybrid']['raw'][phase]['normal']['trades']
                right=report['results'][f'{source}-evidence-rule-hybrid']['raw'][phase]['normal']['trades']
                match=matched_latency(left,right)
                matches[source+'-'+phase]=dict(shared=match['shared'],fixedOnly=match['normalOnly'],evidenceOnly=match['delayedOnly'],
                    sharedFixedNet=match['sharedNormalNet'],sharedEvidenceNet=match['sharedDelayedNet'],
                    difference=match['sharedDifference'],flippedToLoss=match['flippedToLoss'])
            trades=report['results']['confirmed-fixed-rule-hybrid']['raw'][phase]['normal']['trades'];records=[]
            for t in trades:
                side=1 if t['side']=='Buy' else -1;event=lookup[t['time'],side,t['plan']]
                fixed=outcome(event);timer=old_outcome(replace(event,variant='structure-managed'))
                evidence=outcome(replace(event,exit_mode='evidence'))
                if fixed['net']!=t['net'] or timer is None or evidence is None:
                    raise ValueError('獨立相同入場反事實不能重現')
                records.append(dict(time=t['time'],fixedNet=fixed['net'],timerNet=timer['net'],
                    evidenceNet=evidence['net'],timerReason=timer['reason'],evidenceReason=evidence['reason']))
            counterfactuals[phase]=dict(independentEntriesOnly=True,notDeployablePortfolio=True,count=len(records),
                fixedNet=sum(r['fixedNet'] for r in records),timerNet=sum(r['timerNet'] for r in records),
                evidenceNet=sum(r['evidenceNet'] for r in records),
                timerTruncatedWinners=sum(r['fixedNet']>0 and r['timerNet']<r['fixedNet'] for r in records),
                evidenceTruncatedWinners=sum(r['fixedNet']>0 and r['evidenceNet']<r['fixedNet'] for r in records),
                timerTurnedWinnerNonpositive=sum(r['fixedNet']>0 and r['timerNet']<=0 for r in records),
                evidenceTurnedWinnerNonpositive=sum(r['fixedNet']>0 and r['evidenceNet']<=0 for r in records),details=records)
        summary['sessions'][session]=dict(accounting=accounting,matchedExits=matches,sameEntryCounterfactuals=counterfactuals)
    with (SOURCE/'all-policy-results.csv').open('x') as stream:
        writer=csv.DictWriter(stream,fieldnames=list(rows[0]));writer.writeheader();writer.writerows(rows)
    with (SOURCE/'loss-summary.json').open('x') as stream:
        json.dump(summary,stream,ensure_ascii=False,indent=2,allow_nan=False)
    print(json.dumps(dict(rows=len(rows),frozenId=frozen['id'])))


if __name__=='__main__':
    main()
