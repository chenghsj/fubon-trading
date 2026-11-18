"""Development-only postmortem of directional errors and truncated winners."""
from dataclasses import replace
from importlib import import_module
import json
from pathlib import Path

from fubon_bridge.confirmed_execution import build, compare, outcome, prepare
from fubon_bridge.loss_diagnostics import distribution
from fubon_bridge.research import digest

base=import_module('refine-regime')
ROOT=Path(__file__).resolve().parents[1]
PARENT=ROOT/'.fubon-dev/reports/confirmed-entry-exit-v1'
OUTPUT=ROOT/'.fubon-dev/reports/direction-exit-audit-v1.json'


def main():
    frozen=json.loads((PARENT/'frozen.json').read_text())
    if digest({k:v for k,v in frozen.items() if k!='id'})!=frozen['id']:
        raise ValueError('父版本凍結不符')
    report=dict(parentFrozen=frozen['id'],postmortemOnly=True,trainingFeatures=False,
        period='development calibration only',sessions={})
    for session,(ident,data,dates) in base.datasets(ROOT/'server/.research.sqlite3').items():
        spec=frozen['sessions'][session]
        selected=spec['models']['structure-fixed']['metadata']['calibrationDates']
        if spec['datasetId']!=ident or not set(selected)<=set(dates[:int(len(dates)*.6)]):
            raise ValueError('資料或開發期日期不符')
        variants,_=build(data,selected);events=variants['structure-fixed'];lookup={a.key:a for a in events}
        result=compare(events,{a.key:1. for a in events},selected,'hybrid')['normal']
        if {k:v for k,v in result.items() if k!='trades'}!=spec['guards']['structure-fixed-rule-hybrid']['metrics']['normal']:
            raise ValueError('原校準結果未完整重現')
        records=[]
        for trade in result['trades']:
            side=1 if trade['side']=='Buy' else -1;a=lookup[trade['time'],side,trade['plan']]
            changed,fill,_=prepare(a)
            managed=outcome(replace(a,variant='structure-managed'))
            if outcome(a)['net']!=trade['net'] or managed is None:
                raise ValueError('相同入場反事實不符')
            record=dict(time=a.time,day=a.day,side=side,plan=a.plan,net=trade['net'],
                managedNet=managed['net'],managedReason=managed['reason'],
                extensionAtr3=a.context[3],direction15Atr3=a.context[1])
            for minutes in (5,15):
                end=min(fill['first']+minutes-1,a.end)
                record[f'return{minutes}R']=side*(a.bars[end]['close']-trade['entry'])/changed.stop
            if managed['reason']=='no_progress':
                decision=next(b for b in a.bars if b['time']==managed['exitTime'])
                record['decisionPnlR']=side*(decision['close']-trade['entry'])/changed.stop
            records.append(record)
        cut=[r for r in records if r['managedReason']=='no_progress']
        truncated=[r for r in cut if r['net']>0 and r['managedNet']<r['net']]
        summary=dict(trades=len(records),return5R=distribution([r['return5R'] for r in records]),
            return15R=distribution([r['return15R'] for r in records]),
            negativeAt5=sum(r['return5R']<0 for r in records),negativeAt15=sum(r['return15R']<0 for r in records),
            noProgress=len(cut),noProgressOriginalWinners=len(truncated),
            truncatedWithLossLessThanHalfR=sum(r['decisionPnlR']>-.5 for r in truncated),
            noProgressDecisionPnlR=distribution([r['decisionPnlR'] for r in cut]),
            fixedNet=sum(r['net'] for r in records),sameEntryManagedNet=sum(r['managedNet'] for r in records))
        report['sessions'][session]=dict(datasetId=ident,dates=selected,summary=summary,details=records)
        print(json.dumps(dict(session=session,**summary)),flush=True)
    with OUTPUT.open('x') as stream:
        json.dump(report,stream,ensure_ascii=False,indent=2,allow_nan=False)


if __name__=='__main__':
    main()
