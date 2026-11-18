"""Postmortem forecast errors on fixed-rule entries; never changes selection."""
from importlib import import_module
import json

import numpy as np

from fubon_bridge.candle_patterns import action_shapes
from fubon_bridge.direction_execution import outcome, prepare
from fubon_bridge.loss_diagnostics import distribution
from fubon_bridge.position_value import ExitEngine, build, cash, predict, states
from fubon_bridge.research import digest
from fubon_bridge.structured_models import _predict_head

study=import_module('research-position-value');SOURCE=study.ARTIFACTS


def main():
    frozen=json.loads((SOURCE/'frozen.json').read_text());result=dict(frozenId=frozen['id'],postmortemOnly=True,selectionChanged=False,sessions={})
    if digest({k:v for k,v in frozen.items() if k!='id'})!=frozen['id']:
        raise ValueError('凍結不符')
    for session,(ident,data,dates) in study.base.datasets(study.ROOT/'server/.research.sqlite3').items():
        record=frozen['sessions'][session];report=json.loads((SOURCE/f'{session}-evaluation.json').read_text())
        if record['datasetId']!=ident or report['frozenId']!=frozen['id']:
            raise ValueError('資料或評估來源不符')
        exit_model=json.loads((SOURCE/f'{session}-exit-model.json').read_text())
        if digest(exit_model)!=record['exitHash']:
            raise ValueError('退出模型雜湊不符')
        engine=ExitEngine(exit_model);events,_=build(data,dates[int(len(dates)*.6):]);summary={}
        for source in ('confirmed','paired'):
            lookup={a.key:a for a in events[source+'-fixed']}
            entry=json.loads((SOURCE/f'{session}-{source}-fixed-model.json').read_text())
            if digest(entry)!=record['models'][source+'-fixed']:
                raise ValueError('進場模型雜湊不符')
            for phase in ('validation','historical_reused_test'):
                trades=report['results'][source+'-fixed-rule-hybrid']['raw'][phase]['normal']['trades']
                chosen=[lookup[t['time'],1 if t['side']=='Buy' else -1,t['plan']] for t in trades];shapes=action_shapes(chosen)
                scores,directions=predict(entry,chosen,shapes);records=[]
                for a in chosen:
                    baseline=outcome(a);_,fill,_=prepare(a);rows=states(a,cache=engine.cache)
                    values=_predict_head(exit_model['head'],np.asarray([r['x'] for r in rows])) if rows else []
                    for r,value in zip(rows,values,strict=True):
                        actual=baseline['net']-cash(fill['entry'],a.bars[r['index']+1]['open'],a.side,fill['slip'])
                        records.append(dict(time=a.time,stateTime=r['time'],predicted=float(value),actual=actual))
                actual_direction={a.key:a.side*(a.bars[a.index+5]['close']-a.bars[a.index+1]['open'])/shapes[a.key][1] for a in chosen}
                bad=[r for r in records if r['actual']<-30.];good=[r for r in records if r['actual']>0.]
                valid=[a for a in chosen if directions[a.key] is not None]
                summary[source+'-'+phase]=dict(entries=len(chosen),states=len(records),statesAreCorrelated=True,
                    badContinuation=len(bad),badContinuationHeld=sum(r['predicted']>=-30 for r in bad),
                    beneficialContinuation=len(good),beneficialContinuationCut=sum(r['predicted']<-30 for r in good),
                    predictedContinuation=distribution([r['predicted'] for r in records]),actualContinuation=distribution([r['actual'] for r in records]),
                    continuationAbsoluteError=distribution([abs(r['predicted']-r['actual']) for r in records]),
                    cashPositive=sum(scores[a.key] is not None and scores[a.key]>0 for a in chosen),
                    direction5PredictedPositive=sum(directions[a.key]>0 for a in valid),
                    direction5ActuallyPositive=sum(actual_direction[a.key]>0 for a in valid),
                    direction5WrongSign=sum((directions[a.key]>0)!=(actual_direction[a.key]>0) for a in valid),
                    direction5Forecasts=len(valid),future5MayFollowActualExit=True)
        result['sessions'][session]=summary
    with (SOURCE/'generalization-diagnosis.json').open('x') as stream:
        json.dump(result,stream,ensure_ascii=False,indent=2,allow_nan=False)
    print(json.dumps(result,ensure_ascii=False))


if __name__=='__main__':
    main()
