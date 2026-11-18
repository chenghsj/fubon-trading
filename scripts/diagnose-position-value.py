"""Development-only explanation of long-held losses and recoveries."""
from dataclasses import replace
from importlib import import_module
import json
from pathlib import Path

from fubon_bridge.direction_execution import compare, outcome, prepare, rule_scores
from fubon_bridge.loss_diagnostics import distribution
from fubon_bridge.position_value import build, cash, states
from fubon_bridge.research import digest

parent=import_module('research-direction-continuation');ROOT=Path(__file__).resolve().parents[1]
SOURCE=ROOT/'.fubon-dev/reports/direction-continuation-v1-clarified'
OUTPUT=ROOT/'.fubon-dev/reports/position-value-development-diagnosis-v1.json'


def main():
    frozen=json.loads((SOURCE/'frozen.json').read_text())
    if digest({k:v for k,v in frozen.items() if k!='id'})!=frozen['id']:
        raise ValueError('父凍結不符')
    report=dict(parentFrozen=frozen['id'],period='development calibration only',postmortemOnly=True,sessions={})
    for session,(ident,data,dates) in parent.base.datasets(ROOT/'server/.research.sqlite3').items():
        selected=frozen['sessions'][session]['guards']['confirmed-fixed-rule-hybrid']['calibrationDates']
        if not set(selected)<=set(dates[:int(len(dates)*.6)]):
            raise ValueError('診斷不得取後段')
        events,_=build(data,selected);rows=events['confirmed-fixed'];lookup={a.key:a for a in rows}
        result=compare(rows,rule_scores(rows),selected,'hybrid')['normal'];records=[];cache={}
        for t in result['trades']:
            a=lookup[t['time'],1 if t['side']=='Buy' else -1,t['plan']]
            fixed=outcome(a);evidence=outcome(replace(a,exit_mode='evidence'));_,fill,_=prepare(a)
            decision=states(a,cache=cache)
            records.append(dict(time=a.time,side=t['side'],plan=a.plan,fixedNet=fixed['net'],evidenceNet=evidence['net'],
                fixedHoldingMinutes=(fixed['exitTime']-(a.time))/60,
                evidenceHoldingMinutes=(evidence['exitTime']-a.time)/60,
                states=len(decision),firstStateContinuationNTD=(fixed['net']-cash(fill['entry'],a.bars[decision[0]['index']+1]['open'],a.side,fill['slip'])) if decision else None))
        losers=[r for r in records if r['fixedNet']<0];recoveries=[r for r in records if r['fixedNet']>0 and r['states']]
        summary=dict(trades=len(records),fixedNet=sum(r['fixedNet'] for r in records),sameEntryEvidenceNet=sum(r['evidenceNet'] for r in records),
            fixedLoserHoldingMinutes=distribution([r['fixedHoldingMinutes'] for r in losers]),
            sameFixedLosersEvidenceHoldingMinutes=distribution([r['evidenceHoldingMinutes'] for r in losers]),
            fixedLosersWorsenedByEvidence=sum(r['evidenceNet']<r['fixedNet'] for r in losers),
            eligibleLossStates=sum(r['states'] for r in records),recoveringWinnersWithLossState=len(recoveries),
            firstStateContinuationNTD=distribution([r['firstStateContinuationNTD'] for r in records if r['states']]))
        report['sessions'][session]=dict(datasetId=ident,dates=selected,summary=summary,details=records)
        print(json.dumps(dict(session=session,**summary)),flush=True)
    with OUTPUT.open('x') as stream:
        json.dump(report,stream,ensure_ascii=False,indent=2,allow_nan=False)


if __name__=='__main__':
    main()
