"""Postmortem only: all-policy accounting, paired exits and direction errors."""
import csv
from importlib import import_module
import json
from pathlib import Path

from fubon_bridge.candle_patterns import action_shapes
from fubon_bridge.direction_execution import outcome as fixed_outcome
from fubon_bridge.loss_diagnostics import decompose, distribution, matched_latency
from fubon_bridge.position_value import ExitEngine, build
from fubon_bridge.research import digest

study=import_module('research-position-value');ROOT=Path(__file__).resolve().parents[1]
SOURCE=ROOT/'.fubon-dev/reports/position-value-v1'


def duration(t):
    return (t['exitTime']-t['time'])/60


def load_exit(frozen,session):
    model=json.loads((SOURCE/f'{session}-exit-model.json').read_text())
    if digest(model)!=frozen['sessions'][session]['exitHash']:
        raise ValueError('摘要退出模型與凍結不符')
    return model


def main():
    frozen=json.loads((SOURCE/'frozen.json').read_text())
    if digest({k:v for k,v in frozen.items() if k!='id'})!=frozen['id']:
        raise ValueError('凍結不符')
    reference=json.loads((study.REFERENCE/'frozen.json').read_text())
    if digest({k:v for k,v in reference.items() if k!='id'})!=frozen['parentFrozen']:
        raise ValueError('摘要父凍結不符')
    summary=dict(frozenId=frozen['id'],postmortemOnly=True,selectionChanged=False,sessions={});csv_rows=[]
    for session,(ident,data,dates) in study.base.datasets(ROOT/'server/.research.sqlite3').items():
        report=json.loads((SOURCE/f'{session}-evaluation.json').read_text())
        if report['frozenId']!=frozen['id'] or report['datasetId']!=ident:
            raise ValueError('評估來源不符')
        old=json.loads((study.REFERENCE/f'{session}-evaluation.json').read_text());replayed=0
        if old['frozenId']!=reference['id']:
            raise ValueError('父評估來源不符')
        for v in ('confirmed-fixed','paired-fixed'):
            for scope in ('hybrid','range','trend'):
                p=f'{v}-rule-{scope}'
                for phase,scenarios in report['results'][p]['raw'].items():
                    for scenario,value in scenarios.items():
                        normalized=dict(value,trades=[{k:v for k,v in t.items() if k!='direction5'} for t in value['trades']])
                        if normalized!=old['results'][p]['raw'][phase][scenario]:
                            raise ValueError('新replay的固定出場與父版完整交易／指標不符')
                        replayed+=1
        events,_=build(data,dates[int(len(dates)*.6):]);shapes=action_shapes(events['confirmed-fixed']+events['paired-fixed'])
        lookups={s:{a.key:a for a in events[s+'-fixed']} for s in ('confirmed','paired')}
        model=load_exit(frozen,session);engine=ExitEngine(model)
        accounting={};matches={};counterfactuals={}
        for p,result in report['results'].items():
            for mode,periods in result.items():
                for phase,scenarios in periods.items():
                    for scenario,value in scenarios.items():
                        detail=decompose(value['trades'],4 if scenario=='stress' else 2)
                        if detail['net']!=value['net']:
                            raise ValueError('現金流與交易明細不符')
                        csv_rows.append(dict(session=session,policy=p,mode=mode,phase=phase,scenario=scenario,
                            count=value['count'],net=value['net'],maxDrawdown=value['maxDrawdown'],withoutBestDay=value['withoutBestDay'],
                            fixedPathGross=detail['fixedPathGross'],fees=detail['fees'],taxes=detail['taxes'],slippage=detail['slippage']))
                        if mode=='raw' and scenario=='normal':
                            trades=value['trades'];lookup=lookups[p.split('-')[0]]
                            directional=[a.side*(a.bars[a.index+5]['close']-a.bars[a.index+1]['open'])/shapes[a.key][1]
                                for t in trades for a in [lookup[t['time'],1 if t['side']=='Buy' else -1,t['plan']]]]
                            accounting.setdefault(p,{})[phase]=dict(**detail,
                                loserHoldingMinutes=distribution([duration(t) for t in trades if t['net']<0]),
                                winnerHoldingMinutes=distribution([duration(t) for t in trades if t['net']>0]),
                                direction5Atr=distribution(directional),positiveDirection5=sum(v>0 for v in directional),
                                directionAfterActualExitMayOccur=True,funnel=value['funnel'])
        for phase in ('validation','historical_reused_test'):
            for source in ('confirmed','paired'):
                records=[]
                left=report['results'][f'{source}-fixed-rule-hybrid']['raw'][phase]['normal']['trades']
                right=report['results'][f'{source}-learned-rule-hybrid']['raw'][phase]['normal']['trades']
                match=matched_latency(left,right)
                matches[source+'-'+phase]=dict(shared=match['shared'],fixedOnly=match['normalOnly'],learnedOnly=match['delayedOnly'],
                    sharedFixedNet=match['sharedNormalNet'],sharedLearnedNet=match['sharedDelayedNet'],difference=match['sharedDifference'],
                    flippedToLoss=match['flippedToLoss'])
                for t in left:
                    a=lookups[source][t['time'],1 if t['side']=='Buy' else -1,t['plan']]
                    fixed=fixed_outcome(a);learned=engine.outcome(a)
                    if fixed['net']!=t['net']:
                        raise ValueError('原入場逐筆不能重現')
                    records.append(dict(time=a.time,day=a.day,side=t['side'],plan=a.plan,fixedNet=fixed['net'],
                        learnedNet=learned['net'] if learned else None,fixedHoldingMinutes=duration(fixed),
                        learnedHoldingMinutes=duration(learned) if learned else None,
                        learnedReason=learned['reason'] if learned else 'missingModel'))
                valid=[r for r in records if r['learnedNet'] is not None];losers=[r for r in valid if r['fixedNet']<0]
                counterfactuals[source+'-'+phase]=dict(independentEntriesOnly=True,notDeployablePortfolio=True,count=len(records),
                    valid=len(valid),fixedNet=sum(r['fixedNet'] for r in valid),learnedNet=sum(r['learnedNet'] for r in valid),
                    fixedLoserHoldingMinutes=distribution([r['fixedHoldingMinutes'] for r in losers]),
                    learnedSameLoserHoldingMinutes=distribution([r['learnedHoldingMinutes'] for r in losers]),
                    losersImproved=sum(r['learnedNet']>r['fixedNet'] for r in losers),losersWorsened=sum(r['learnedNet']<r['fixedNet'] for r in losers),
                    winnersTruncated=sum(r['fixedNet']>0 and r['learnedNet']<r['fixedNet'] for r in valid),
                    winnersTurnedNonpositive=sum(r['fixedNet']>0 and r['learnedNet']<=0 for r in valid),details=records)
        summary['sessions'][session]=dict(newReplayParentMatches=replayed,accounting=accounting,matchedPortfolios=matches,sameEntryCounterfactuals=counterfactuals)
    with (SOURCE/'all-policy-results.csv').open('x') as stream:
        writer=csv.DictWriter(stream,fieldnames=list(csv_rows[0]));writer.writeheader();writer.writerows(csv_rows)
    with (SOURCE/'loss-summary.json').open('x') as stream:
        json.dump(summary,stream,ensure_ascii=False,indent=2,allow_nan=False)
    print(json.dumps(dict(rows=len(csv_rows),frozenId=frozen['id'])))


if __name__=='__main__':
    main()
