"""Postmortem only: later target recovery after saved stop fills is not a signal."""
from importlib import import_module
import json
from pathlib import Path

from fubon_bridge.loss_diagnostics import distribution
from fubon_bridge.opportunity_research import PLANS
from fubon_bridge.strategy_session import schedule

base=import_module('refine-regime')
ROOT=Path(__file__).resolve().parents[1]
SOURCE=ROOT/'.fubon-dev/reports/opportunity-actions-v1'
OUTPUT=ROOT/'.fubon-dev/reports/opportunity-stop-audit-v1.json'


def main():
    frozen=json.loads((SOURCE/'frozen.json').read_text());results={}
    for session,(ident,data,dates) in base.datasets(ROOT/'server/.research.sqlite3').items():
        if ident!=frozen['sessions'][session]['datasetId']:
            raise ValueError('資料快照不符')
        lookup={b['time']:b for b in data['futures']};records={}
        report=json.loads((SOURCE/f'{session}-evaluation.json').read_text())
        for period in ('validation','historical_reused_test'):
            trades=report['results']['flexible-raw-0-swing'][period]['normal']['trades'];stops=[]
            for t in trades:
                if t['reason']!='stop':
                    continue
                side=1 if t['side']=='Buy' else -1
                stop_distance=side*(t['entry']-(t['exit']+side*2))
                target=t['entry']+side*stop_distance*PLANS[t['plan']]['targetR']
                start=int(schedule(session).window(t['day'])[0].timestamp())
                deadline=min(t['time']+PLANS[t['plan']]['horizon']*60,
                    start+schedule(session).exit_minute*60)
                before=[lookup[at] for at in range(t['time']+60,t['exitTime'],60)]
                after=[lookup[at] for at in range(t['exitTime']+60,deadline+1,60)]
                favorable=max([0.]+[side*(b['high' if side>0 else 'low']-t['entry'])/stop_distance for b in before])
                recovered=any(side*(b['high' if side>0 else 'low']-target)>=0 for b in after)
                adverse=max([1.]+[side*(t['entry']-b['low' if side>0 else 'high'])/stop_distance for b in after])
                stops.append(dict(time=t['time'],exitTime=t['exitTime'],deadline=deadline,
                    recoveredOriginalTargetLater=recovered,favorableBeforeStopR=favorable,
                    maximumLaterAdverseR=adverse))
            records[period]=dict(stopCount=len(stops),tradeCount=len(trades),
                recoveredCount=sum(t['recoveredOriginalTargetLater'] for t in stops),
                favorableBeforeStopR=distribution([t['favorableBeforeStopR'] for t in stops]),
                maximumLaterAdverseR=distribution([t['maximumLaterAdverseR'] for t in stops]),details=stops)
        results[session]=records
    if OUTPUT.exists():
        raise ValueError('保留既有停損路徑稽核')
    OUTPUT.write_text(json.dumps(dict(sourceFrozen=frozen['id'],postmortemOnly=True,
        cannotBeFeatures=True,stopBarHighLowExcluded=True,results=results),ensure_ascii=False,indent=2))
    for session,periods in results.items():
        print(json.dumps(dict(session=session,**{p:{k:v for k,v in r.items() if k!='details'} for p,r in periods.items()})),flush=True)


if __name__=='__main__':
    main()
