"""Fixed-parameter chronological research. Models never authorize execution."""
import hashlib
from pathlib import Path
from typing import Literal
from pydantic import BaseModel, Field, model_validator
from .learning_features import FEATURES, POLICY, features_for, policy_for, build_events, outcome, simulate, chronological_split
from .research import RunConfig

PARAMETERS = dict(objective='binary',num_leaves=7,max_depth=3,min_data_in_leaf=15,learning_rate=.05,
    lambda_l2=1,seed=42,num_threads=2,verbosity=-1,deterministic=True,force_col_wise=True)


def implementation_hashes():
    return {name:hashlib.sha256(Path(__file__).with_name(name).read_bytes()).hexdigest() for name in
        ['learning_data.py','learning_features.py','learning_train.py','learning_inference.py','intraday_strategy.py','auto_trading.py','research.py','strategy_session.py','learning_walkforward.py']}


class TrainingRequest(BaseModel):
    dataset_id: str = Field(pattern=r'^[a-f0-9]{64}$')
    config: RunConfig
    method: Literal['fixed','walkforward'] = 'fixed'

    @model_validator(mode='after')
    def single_lot(self):
        if self.config.quantity!=1:
            raise ValueError('模型第一版限微台單口，請將口數設為1')
        return self


def train(store, request, progress=lambda *_:None):
    if request.method == 'walkforward':
        from .learning_walkforward import train_walkforward
        return train_walkforward(store,request,progress)
    try:
        import lightgbm as lgb
        import numpy as np
    except (ImportError,OSError):
        raise ValueError('訓練套件尚未就緒；請安裝 learning extra，macOS 另需 libomp') from None
    data=store.dataset(request.dataset_id)
    session = data.get('strategySession', 'cash')
    features, policy = features_for(session), policy_for(session)
    config=request.config.model_dump(mode='json')
    config['taxRounding']='per-contract-yuan'
    implementation=implementation_hashes()
    fingerprint=dict(dataset=request.dataset_id,implementation=implementation,config=config,features=features,policy=policy,parameters=PARAMETERS,
        rounds=50,lightgbm=lgb.__version__,numpy=np.__version__)
    from .research import digest
    try:
        return store.run(digest(fingerprint))
    except ValueError:
        pass
    progress('建立當時可見特徵與20分鐘結果標籤',.1)
    raw,diagnostics=build_events(data)
    events=[]
    for event in raw:
        label=outcome(event,config)
        if label is not None:
            events.append(dict(event,y=label['label'],labelEnd=label['exitTime']))
    parts,split=chronological_split(events,diagnostics['completeDates'],session)
    report=dict(strategySession=session,policy=policy,implementation=implementation,features=features,parameters=PARAMETERS,config=config,source=data['source'],
        diagnostics=dict(diagnostics,labeledEvents=len(events),riskRejectedEvents=len(raw)-len(events)),split=split,
        counts={name:len(p) for name,p in zip(['train','validation','test'],parts)},
        executionEnabled=False,adoptionAllowed=False,metricsPassed=False,status='insufficient',reasons=[],
        comparisons={},predictions=[],model=None,packages=dict(lightgbm=lgb.__version__,numpy=np.__version__))
    training,validation,test=parts
    if len(training)<20 or len({e['y'] for e in training})<2:
        report['reasons']=['訓練事件不足20筆或只有一種結果標籤，未建立模型；需補不同盤勢資料']
        return store.save_run(request.dataset_id,fingerprint,report)
    progress('訓練固定參數 LightGBM（50輪）',.4)
    # Training-only feature binning: no validation/test rows enter Dataset construction.
    dataset=lgb.Dataset(np.asarray([e['x'] for e in training],dtype=np.float64),label=[e['y'] for e in training],feature_name=features)
    model=lgb.train(PARAMETERS,dataset,num_boost_round=50)
    text=model.model_to_string()
    restored=lgb.Booster(model_str=text)
    report['model']=dict(hash=hashlib.sha256(text.encode()).hexdigest(),bytes=len(text.encode()),
        splitCount=int(model.feature_importance(importance_type='split').sum()),
        importance=dict(zip(features,[float(v) for v in model.feature_importance(importance_type='gain')])))
    if not report['model']['splitCount']:
        report['reasons'].append('模型沒有有效樹分裂，目前只輸出固定分數；需要更多有差異的訓練事件')
    gates=[]
    for name,values in [('validation',validation),('test',test)]:
        progress(f'計算{name}封存時段與成本壓力',.7 if name=='validation' else .9)
        predictions=restored.predict(np.asarray([e['x'] for e in values],dtype=np.float64)).tolist() if values else []
        scores={e['time']:float(p) for e,p in zip(values,predictions)}
        # Evaluate all raw events on the same held-out dates, rerunning the full state machine.
        dates=set(split['validationDates' if name=='validation' else 'testDates'])
        sequence=[e for e in raw if e['day'] in dates]
        # Score even ordinary-cost risk rejects: stress may alter their admissibility.
        all_predictions=restored.predict(np.asarray([e['x'] for e in sequence],dtype=np.float64)).tolist() if sequence else []
        all_scores={e['time']:float(p) for e,p in zip(sequence,all_predictions)}
        base=simulate(sequence,config); filtered=simulate(sequence,config,all_scores)
        stress_base=simulate(sequence,config,extra_slippage=2);stress=simulate(sequence,config,all_scores,2)
        accuracy=sum((p>=.5)==bool(e['y']) for e,p in zip(values,predictions))/len(values) if values else None
        brier=sum((p-e['y'])**2 for e,p in zip(values,predictions))/len(values) if values else None
        report['comparisons'][name]=dict(baseline=base,filtered=filtered,stressBaseline=stress_base,stressFiltered=stress,
            accuracy=accuracy,brier=brier,scoreCalibrated=False)
        report['predictions'] += [dict(time=e['time'],side=e['side'],score=scores[e['time']],label=e['y']) for e in values][-20:]
        gates.append(filtered['count']>=5 and filtered['net']>0 and stress['net']>0 and filtered['net']>base['net'] and filtered['maxDrawdown']<=base['maxDrawdown'])
    enough=diagnostics['completeDays']>=60 and len(training)>=60 and len(validation)>=20 and len(test)>=20
    report['metricsPassed']=enough and all(gates)
    qualified = report['metricsPassed'] and data.get('marketDataVerified') is True and diagnostics['calendarVerified'] and not diagnostics['excludedDays'] and not diagnostics['missingStockEvents'] and config['feeSource']=='statement'
    report['status']='research_candidate' if qualified else 'diagnostic'
    if not enough:
        report['reasons'].append('研究比較門檻不足：需60完整日及60/20/20個訓練/驗證/測試事件；這仍不是統計充分條件')
    if not all(gates):
        report['reasons'].append('驗證或測試未同時通過淨損益、回撤、交易數與滑價壓力比較')
    report['reasons'] += ['目前為研究模型，尚未完成來源獨立核對、固定選股偏誤與盤中前測；不核准正式交易，可手動選入 Paper／Sandbox 實驗',
        '測試日期已用於本報告，後續調整須保留新的未見期間；分數未校準為未來勝率']
    return store.save_run(request.dataset_id,fingerprint,report,text)
