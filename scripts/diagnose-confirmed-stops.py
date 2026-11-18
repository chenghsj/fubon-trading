"""Postmortem of previous frozen policy on development calibration only."""
import argparse
from importlib import import_module
import json
from pathlib import Path

from fubon_bridge.candle_patterns import action_shapes
from fubon_bridge.loss_diagnostics import decompose, distribution
from fubon_bridge.pattern_transfer import predict
from fubon_bridge.research import digest
from fubon_bridge.structured_research import build, compare, prepare

base=import_module('refine-regime')
ROOT=Path(__file__).resolve().parents[1]
PARENT=ROOT/'.fubon-dev/reports/stock-pattern-transfer-v1-corrected'
OUTPUT=ROOT/'.fubon-dev/reports/confirmed-stop-audit-v2.json'


def audit(events,trades):
    lookup={a.key:a for a in events};records=[]
    for trade in trades:
        side=1 if trade['side']=='Buy' else -1
        action=lookup[trade['time'],side,trade['plan']]
        changed,_=prepare(action)
        if changed is None:
            raise ValueError('已保存成交無法重現入場')
        target=trade['entry']+side*changed.target
        first=action.index+1
        exit_index=next(i for i,b in enumerate(action.bars) if b['time']==trade['exitTime'])
        before=action.bars[first:exit_index]  # Never infer stop-bar high/low order.
        later=action.bars[exit_index+1:action.end+1]
        mfe=max([0.]+[side*(b['high' if side>0 else 'low']-trade['entry'])/action.stop for b in before])
        mae=max([0.]+[side*(trade['entry']-b['low' if side>0 else 'high'])/action.stop for b in before])
        records.append(dict(time=trade['time'],day=trade['day'],plan=trade['plan'],reason=trade['reason'],
            net=trade['net'],minutesToExit=exit_index-first+1,
            favorableBeforeExitR=mfe,adverseBeforeExitR=mae,
            recoveredTargetAfterExit=any(side*(b['high' if side>0 else 'low']-target)>=0 for b in later),
            maximumLaterAdverseR=max([0.]+[side*(trade['entry']-b['low' if side>0 else 'high'])/action.stop for b in later]),
            signalBody=side*(action.bars[action.index]['close']-action.bars[action.index]['open']),
            minutesFromOpen=(action.time-action.start)//60))
    stops=[r for r in records if r['reason'] in ('stop','gap_stop','both_stop_first')]
    return dict(accounting=decompose(trades),stopCount=len(stops),
        stopMinutes=distribution([r['minutesToExit'] for r in stops]),
        stopFavorableR=distribution([r['favorableBeforeExitR'] for r in stops]),
        stopAdverseBeforeExitR=distribution([r['adverseBeforeExitR'] for r in stops]),
        stopWithin3Minutes=sum(r['minutesToExit']<=3 for r in stops),
        stoppedBeforeHalfR=sum(r['favorableBeforeExitR']<.5 for r in stops),
        recoveredTargetLater=sum(r['recoveredTargetAfterExit'] for r in stops),
        laterAdverseR=distribution([r['maximumLaterAdverseR'] for r in stops]),
        byPlan={p:dict(count=sum(r['plan']==p for r in records),
            stops=sum(r['plan']==p for r in stops),net=sum(r['net'] for r in records if r['plan']==p))
            for p in ('range','trend')},details=records)


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output',type=Path,default=OUTPUT)
    args=parser.parse_args()
    frozen=json.loads((PARENT/'frozen.json').read_text())
    if digest({k:v for k,v in frozen.items() if k!='id'})!=frozen['id']:
        raise ValueError('父版本凍結雜湊不符')
    output=dict(parentFrozen=frozen['id'],postmortemOnly=True,usedForTraining=False,
        stopBarExcluded=True,period='development calibration; no new held-out results',sessions={})
    for session,(ident,data,dates) in base.datasets(ROOT/'server/.research.sqlite3').items():
        previous=frozen['sessions'][session]
        if previous['datasetId']!=ident:
            raise ValueError('父版本微台快照不符')
        metadata=previous['models']['pooled-pretrain']['metadata'];selected=metadata['calibrationDates']
        if not set(selected)<=set(dates[:int(len(dates)*.6)]):
            raise ValueError('診斷不得讀取新的後段期別')
        events,_=build(data,selected);shapes=action_shapes(events)
        model=json.loads((PARENT/f'{session}-pooled-pretrain-model.json').read_text())
        if digest(model)!=previous['models']['pooled-pretrain']['hash']:
            raise ValueError('父版本模型雜湊不符')
        records={}
        for name,scores in (('rule',{a.key:1. for a in events}),('pooled-pretrain',predict(model,events,shapes))):
            result=compare(events,scores,selected,'hybrid')['normal']
            if name=='pooled-pretrain' and {k:v for k,v in result.items() if k!='trades'}!=previous['guards']['pooled-pretrain-0-hybrid']['metrics']['normal']:
                raise ValueError('父版本校準結果未完整重現')
            records[name]=audit(events,result['trades'])
            print(json.dumps(dict(session=session,policy=name,**{k:v for k,v in records[name].items() if k!='details'})),flush=True)
        output['sessions'][session]=dict(datasetId=ident,dates=selected,policies=records)
    with args.output.open('x') as stream:
        json.dump(output,stream,ensure_ascii=False,indent=2,allow_nan=False)


if __name__=='__main__':
    main()
