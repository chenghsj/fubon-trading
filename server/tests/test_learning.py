from copy import deepcopy
from datetime import date, datetime, timedelta
import hashlib
import threading
import time
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient
from fubon_bridge.app import create_app
from fubon_bridge.auto_store import AutoStore
from fubon_bridge.config import Config
from fubon_bridge.learning_data import CollectionRequest, STOCKS, collect, futures_rows, quality
from fubon_bridge.learning_features import build_events, chronological_split, outcome, simulate
from fubon_bridge.learning_service import LearningService
from fubon_bridge.learning_store import LearningStore
from fubon_bridge.learning_train import TrainingRequest, train
from fubon_bridge.mapping import TAIPEI
from fubon_bridge.passkeys import PasskeyStore
from fubon_bridge.research import ResearchStore, normalize

CONFIG=dict(stopPoints=30,targetR=2,quantity=1,feePerSide=12,feeSource='statement',slippagePoints=1,taxRate=.00002)


def fixture(days=90):
    dates=[];day=date(2026,3,2)
    while len(dates)<days:
        if day.weekday()<5: dates.append(day)
        day+=timedelta(days=1)
    future=[];stocks={code:[] for code in STOCKS}
    for index,day in enumerate(dates):
        start=int(datetime.combine(day,datetime.min.time(),TAIPEI).timestamp())+9*3600
        for i in range(260):
            close=25000 if i<19 else 25010 if i<21 else 25070 if index%2 else 24970
            b=dict(time=start+(i+1)*60,open=close,high=close+2,low=close-2,close=close,volume=80 if index%2 and i==19 else 10,month=day.strftime('%Y%m'))
            if i==21:b.update(open=25010,high=25100 if index%2 else 25012,low=25008 if index%2 else 24900)
            future.append(b)
            for code in STOCKS:
                p=1000+i*.01
                stocks[code].append(dict(time=b['time'],open=p,high=p+.01,low=p-.01,close=p,volume=10))
    return dict(schema='fubon-learning-v1',source='synthetic',start=dates[0].isoformat(),end=dates[-1].isoformat(),product='TMF',contractQuery='1!',futures=future,stocks=stocks)


@pytest.fixture
def store(tmp_path):
    return LearningStore(ResearchStore(tmp_path/'research.db'))


def save(store,data):
    return store.save_dataset(data,quality(data))['id']


def test_months_close_labels_and_fractional_stock_prices():
    row=dict(date='2026-09-15T09:00:00+08:00',open=25000,high=25002,low=24998,close=25001,volume=2,contractMonth='202609')
    a=b=date(2026,9,15);bars=futures_rows([row],a,b)
    assert bars[0]['month']=='202609' and bars[0]['time']==int(datetime(2026,9,15,9,1,tzinfo=TAIPEI).timestamp())
    with pytest.raises(ValueError,match='月份'):futures_rows([dict(row,contractMonth='1!')],a,b)
    with pytest.raises(ValueError,match='跳動'):futures_rows([dict(row,open=25000.5)],a,b)
    with pytest.raises(ValueError,match='多個月份'):futures_rows([row,dict(row,contractMonth='202610')],a,b)
    assert normalize([dict(row,open=25000.5)],a,b)[0]['open']==25000.5


def test_features_no_future_and_missingness():
    data=fixture(2);events,diagnostic=build_events(data)
    assert len(events)>=2 and diagnostic['completeDays']==2
    changed=deepcopy(data);changed['futures'][20].update(open=26000,high=26002,low=25998,close=26000)
    newer,_=build_events(changed)
    assert events[0]['x']==newer[0]['x'] and outcome(newer[0],CONFIG) is None
    hole=deepcopy(data);hole['futures'].pop(50)
    _,diag=build_events(hole)
    assert diag['completeDays']==1 and len(diag['excludedDays'])==1
    absent=deepcopy(data);absent['futures']=absent['futures'][260:]
    assert quality(absent)['absentWeekdays']==[data['start']]
    missing=deepcopy(data);at=events[0]['time']
    missing['stocks']['2330']=[b for b in missing['stocks']['2330'] if b['time']!=at]
    assert build_events(missing)[1]['missingStockEvents']==2


def test_labels_costs_and_state_machine():
    event=deepcopy(build_events(fixture(2))[0][0]);event['path'][0].update(open=25010,high=25100,low=24900)
    t=outcome(event,CONFIG)
    assert t['reason']=='同根雙觸採停損' and t['stopPoints']==30
    assert (t['entry'],t['exit'],t['net'])==(25011,24980,-344)
    assert outcome(event,CONFIG,2)['net']<t['net']
    assert simulate([event,dict(event,time=event['time']+60)],CONFIG)['count']==1
    assert simulate([event],CONFIG,{event['time']:.49})['count']==0
    event['path'][0]['open']=25001
    assert outcome(event,CONFIG) is None


def test_date_split_purges_label_end():
    dates=[f'2026-09-{i:02}' for i in range(1,11)]
    values=[dict(day=d,time=i,labelEnd=int(datetime.fromisoformat(d).replace(tzinfo=TAIPEI).timestamp())+3600) for i,d in enumerate(dates)]
    values[5]['labelEnd']=int(datetime(2026,9,7,tzinfo=TAIPEI).timestamp())
    parts,split=chronological_split(values,dates)
    assert [len(p) for p in parts]==[5,2,2] and split['purged']==[1,0]
    assert parts[1][0]['day']=='2026-09-07' and parts[2][0]['day']=='2026-09-09'


def test_real_lightgbm_fit_reload_cache_and_source_version(store,monkeypatch):
    import lightgbm as lgb
    import fubon_bridge.learning_train as module
    ident=save(store,fixture());request=TrainingRequest(dataset_id=ident,config=CONFIG)
    report=train(store,request)
    assert report['model'] and report['counts']['train']>=20
    assert report['executionEnabled'] is False and report['adoptionAllowed'] is False
    assert report['split']['trainDates'][-1]<report['split']['validationDates'][0]<report['split']['testDates'][0]
    text=store.model(report['id'])
    assert hashlib.sha256(text.encode()).hexdigest()==report['model']['hash']
    assert lgb.Booster(model_str=text).num_feature()==12
    assert train(store,request)['id']==report['id']
    old=report['implementation'];monkeypatch.setattr(module,'implementation_hashes',lambda:dict(old,correction='v2'))
    assert train(store,request)['id']!=report['id']
    assert store.run(report['id'])['config']['feePerSide']==12
    for comparison in report['comparisons'].values():
        for key in ['baseline','filtered','stressBaseline','stressFiltered']:
            run=comparison[key]
            assert run['net']==sum(t['net'] for t in run['trades'])
            assert len({(t['side'],datetime.fromtimestamp(t['time'],TAIPEI).date()) for t in run['trades']})==run['count']


def test_insufficient_saved_without_model(store):
    ident=save(store,fixture(3));report=train(store,TrainingRequest(dataset_id=ident,config=CONFIG))
    assert report['status']=='insufficient' and report['model'] is None and report['reasons']
    with pytest.raises(ValueError,match='沒有'):store.model(report['id'])


def test_collection_resume_and_cache(store):
    class History:
        config=SimpleNamespace(mode='sandbox')
        def __init__(self):self.calls=0
        def learning_candles(self,kind,symbol,start,end):
            self.calls+=1
            if self.calls==6:raise ValueError('simulated disconnection')
            return [dict(date=start+'T09:00:00+08:00',open=25000,high=25002,low=24998,close=25000,volume=1,contractMonth=start[:7].replace('-',''))]
    broker=History();request=CollectionRequest(start='2026-08-01',end='2026-09-04')
    with pytest.raises(ValueError,match='disconnection'):collect(broker,store,request)
    result=collect(broker,store,request)
    assert broker.calls==11 and result['contracts']==['202608','202609']
    assert collect(broker,store,request)['id']==result['id'] and broker.calls==11
    with pytest.raises(ValueError):CollectionRequest(start='2024-01-01',end='2026-09-04')


def test_shared_learning_auto_lease_and_live_job_visibility(store,monkeypatch):
    import fubon_bridge.learning_service as module
    reached=threading.Event();release=threading.Event()
    def blocked(*args):reached.set();assert release.wait(5);return dict(id='result')
    monkeypatch.setattr(module,'collect',blocked)
    state=SimpleNamespace(snapshot=lambda:dict(position=None,pending=None,status='stopped'))
    a=LearningService(None,store,state);b=LearningService(None,LearningStore(store.research),state);auto=AutoStore(store.research)
    try:
        auto.claim('other-auto')
        with pytest.raises(ValueError,match='另一個'):a.start('collect',None)
        auto.release('other-auto');a.start('collect',None)
        assert reached.wait(5) and b.busy() and b.overview()['jobs'][0]['status']=='running'
        with pytest.raises(ValueError):b.start('collect',None)
        with pytest.raises(ValueError,match='另一個'):auto.claim('other-auto')
        release.set();a.executor.shutdown(wait=True)
        assert not b.busy() and b.overview()['jobs'][0]['status']=='completed'
        auto.claim('other-auto');auto.release('other-auto')
    finally:release.set();a.shutdown();b.shutdown()


def test_shutdown_queued_work_still_releases_lease(store):
    from concurrent.futures import ThreadPoolExecutor
    gate=threading.Event();entered=threading.Event()
    def initializer():entered.set();assert gate.wait(5)
    state=SimpleNamespace(snapshot=lambda:dict(position=None,pending=None,status='stopped'))
    service=LearningService(None,store,state);service.executor.shutdown()
    service.executor=ThreadPoolExecutor(max_workers=1,initializer=initializer)
    service.start('collect',None);assert entered.wait(5)
    closing=threading.Thread(target=service.shutdown);closing.start()
    deadline=time.monotonic()+5
    while not service.closing and time.monotonic()<deadline:time.sleep(.01)
    gate.set();closing.join(5)
    assert not closing.is_alive() and service.lease() is None
    assert service.overview()['jobs'][0]['status']=='failed'


def test_session_endpoints_and_no_sdk(tmp_path):
    def no_sdk():pytest.fail('must not initialize brokerage SDK')
    app=create_app(Config(),sdk_factory=no_sdk,passkey_store=PasskeyStore(tmp_path/'keys.db'),research_store=ResearchStore(tmp_path/'research.db'))
    with TestClient(app) as client:
        assert client.get('/api/v1/research/learning').status_code==401
        client.headers['Authorization']='Bearer '+app.state.session.issue()
        response=client.post('/api/v1/research/learning/collect',json=dict(start='2026-09-01',end='2026-09-03'))
        assert response.status_code==200
        deadline=time.monotonic()+5
        while time.monotonic()<deadline:
            status=client.get('/api/v1/research/learning').json()
            if status['jobs'][0]['status']!='running':break
            time.sleep(.01)
        assert status['jobs'][0]['status']=='completed' and status['datasets'][0]['source']=='synthetic'
        assert not app.state.broker.paper.orders
