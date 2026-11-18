"""Reconcile every saved policy and compare matched exit paths, postmortem only."""
import csv
import json
from pathlib import Path

from fubon_bridge.loss_diagnostics import decompose, matched_latency
from fubon_bridge.research import digest

ROOT=Path(__file__).resolve().parents[1]
SOURCE=ROOT/'.fubon-dev/reports/confirmed-entry-exit-v1'


def main():
    frozen=json.loads((SOURCE/'frozen.json').read_text())
    if digest({k:v for k,v in frozen.items() if k!='id'})!=frozen['id']:
        raise ValueError('研究凍結無效')
    rows=[];summary=dict(frozenId=frozen['id'],postmortemOnly=True,selectionChanged=False,sessions={})
    for session in ('regular','afterhours'):
        report=json.loads((SOURCE/f'{session}-evaluation.json').read_text())
        if report['frozenId']!=frozen['id'] or report['datasetId']!=frozen['sessions'][session]['datasetId']:
            raise ValueError('評估資料與凍結不符')
        accounting={}
        for policy,result in report['results'].items():
            for mode,periods in result.items():
                for phase,comparison in periods.items():
                    for scenario,value in comparison.items():
                        detail=decompose(value['trades'],slip=4 if scenario=='stress' else 2)
                        if detail['net']!=value['net']:
                            raise ValueError('交易加總不符')
                        rows.append(dict(session=session,policy=policy,mode=mode,phase=phase,scenario=scenario,
                            count=value['count'],net=value['net'],maxDrawdown=value['maxDrawdown'],
                            withoutBestDay=value['withoutBestDay'],grossSamePath=detail['fixedPathGross'],
                            fees=detail['fees'],taxes=detail['taxes'],slippage=detail['slippage']))
                        if mode=='raw' and scenario=='normal':
                            t=value['trades']
                            accounting.setdefault(policy,{})[phase]=dict(**detail,
                                lossStops=sum(x['net']<0 and x['reason'] in ('stop','gap_stop','both_stop_first') for x in t),
                                protectiveStops=sum(x['net']>=0 and x['reason'] in ('stop','gap_stop','both_stop_first') for x in t),
                                negativeTrades=sum(x['net']<0 for x in t))
        pairs={}
        for phase in ('validation','historical_reused_test'):
            fixed=report['results']['structure-fixed-rule-hybrid']['raw'][phase]['normal']['trades']
            managed=report['results']['structure-managed-rule-hybrid']['raw'][phase]['normal']['trades']
            match=matched_latency(fixed,managed);key=lambda t:(t['time'],t['side'],t['plan'])
            left={key(t):t for t in fixed};right={key(t):t for t in managed};common=left.keys()&right.keys()
            pairs[phase]=dict(shared=match['shared'],fixedOnly=match['normalOnly'],managedOnly=match['delayedOnly'],
                sharedFixedNet=match['sharedNormalNet'],sharedManagedNet=match['sharedDelayedNet'],
                sharedDifference=match['sharedDifference'],flippedToLoss=match['flippedToLoss'],
                targetToNoProgress=sum(left[k]['reason']=='target' and right[k]['reason']=='no_progress' for k in common),
                stopToNoProgress=sum(left[k]['reason'] in ('stop','gap_stop','both_stop_first')
                    and right[k]['reason']=='no_progress' for k in common))
        summary['sessions'][session]=dict(accounting=accounting,matchedExitComparison=pairs)
    with (SOURCE/'all-policy-results.csv').open('x') as stream:
        writer=csv.DictWriter(stream,fieldnames=list(rows[0]));writer.writeheader();writer.writerows(rows)
    with (SOURCE/'loss-summary.json').open('x') as stream:
        json.dump(summary,stream,ensure_ascii=False,indent=2,allow_nan=False)
    print(json.dumps(dict(rows=len(rows),frozenId=frozen['id'])))


if __name__=='__main__':
    main()
