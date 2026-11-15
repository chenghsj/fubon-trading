from copy import deepcopy
from datetime import datetime, timedelta
import hashlib
from types import SimpleNamespace

import numpy as np
import pytest
from fastapi.testclient import TestClient

from fubon_bridge.app import create_app
from fubon_bridge.auto_store import AutoStore
from fubon_bridge.auto_trading import AutoConfig, SandboxAutoTrader
from fubon_bridge.config import Config
from fubon_bridge.learning_features import build_events, signal_features
from fubon_bridge.learning_inference import EntryFilter, model_choices, model_settings
from fubon_bridge.learning_store import LearningStore
from fubon_bridge.learning_train import TrainingRequest, train
from fubon_bridge.intraday_strategy import entry_plan
from fubon_bridge.mapping import TAIPEI
from fubon_bridge.passkeys import PasskeyStore
from fubon_bridge.research import ResearchStore
from test_auto_trading import ACCOUNT, HEADER, FakeGateway
from test_learning import CONFIG, fixture, save


@pytest.fixture(scope='module')
def trained(tmp_path_factory):
    store = LearningStore(ResearchStore(tmp_path_factory.mktemp('inference')/'research.db'))
    data = fixture()
    # Synthetic test rows stand in for an explicitly named market source only in this isolated DB.
    data['source'] = 'fubon-sandbox'
    ident = save(store, data)
    report = train(store, TrainingRequest(dataset_id=ident, config=CONFIG))
    assert report['model']
    return store, report


def config_for(report, **changes):
    return AutoConfig(account=ACCOUNT, contract_code='TMFK6', trade_date='2026-11-13',
        model_run_id=report['id'], **(model_settings(report) | changes))


def test_real_prediction_matches_training_features_and_ignores_future(trained):
    store, report = trained
    model = EntryFilter(store, report['id'], config_for(report).model_dump(mode='json'))
    data = fixture(2)
    events, _ = build_events(data)
    for event in events:
        signal, values = signal_features(data['futures'], event['time'], data['stocks'])
        assert values == event['x'] and signal == event['signal']
        result = model.evaluate(data['futures'], event['time'], data['stocks'])
        assert result['features'] == event['x']
        expected = float(model.model.predict(np.asarray([event['x']]), num_threads=2)[0])
        assert result['score'] == expected and result['accepted'] == (expected >= .5)
    event = events[0]
    changed = deepcopy(data)
    for row in changed['futures']:
        if row['time'] > event['time']: row['close'] = float('nan')
    assert model.evaluate(changed['futures'], event['time'], changed['stocks']) == model.evaluate(data['futures'], event['time'], data['stocks'])


@pytest.mark.parametrize('problem', ['missing_future', 'missing_stock', 'duplicate', 'nan'])
def test_invalid_features_reject_without_predicting(trained, monkeypatch, problem):
    store, report = trained
    model = EntryFilter(store, report['id'], config_for(report).model_dump(mode='json'))
    data = fixture(2); decision = build_events(data)[0][0]['time']
    if problem == 'missing_future': data['futures'].pop(3)
    if problem == 'missing_stock': data['stocks']['2330'] = [b for b in data['stocks']['2330'] if b['time'] != decision]
    if problem == 'duplicate': data['futures'].append(deepcopy(data['futures'][0]))
    if problem == 'nan': data['stocks']['2330'][19]['close'] = float('nan')
    monkeypatch.setattr(model.model, 'predict', lambda *_args, **_kwargs: pytest.fail('must not predict invalid rows'))
    result = model.evaluate(data['futures'], decision, data['stocks'])
    assert result['accepted'] is False and result['score'] is None and result['reason']


@pytest.mark.parametrize('change', [dict(fee_per_side=13), dict(slippage_points=2), dict(loss_limit=2000), dict(stop_points=40)])
def test_cost_and_policy_mismatch_rejected(trained, change):
    store, report = trained
    with pytest.raises(ValueError, match='設定不符'):
        EntryFilter(store, report['id'], config_for(report, **change).model_dump(mode='json'))


def test_versions_dates_artifact_and_synthetic_are_rejected(trained, monkeypatch):
    store, report = trained
    cfg = config_for(report).model_dump(mode='json')
    with pytest.raises(ValueError, match='晚於'):
        EntryFilter(store, report['id'], cfg | dict(trade_date=report['diagnostics']['end']))
    original_run = store.run
    for change, message in [(dict(source='synthetic'), '合成'), (dict(features=['wrong']), '版本'), (dict(implementation={}), '版本')]:
        monkeypatch.setattr(store, 'run', lambda _: deepcopy(report) | change)
        with pytest.raises(ValueError, match=message): EntryFilter(store, report['id'], cfg)
    monkeypatch.setattr(store, 'run', original_run)
    text = store.model(report['id'])
    monkeypatch.setattr(store, 'model', lambda _: text+'\n')
    with pytest.raises(ValueError, match='完整性'): EntryFilter(store, report['id'], cfg)


def make_trader(trained, tmp_path, winning=True):
    store, report = trained
    # Copy only the immutable model report/artifact to the temporary execution DB.
    learning = LearningStore(ResearchStore(tmp_path/'execution.db'))
    with store.connect() as source, learning.connect() as target:
        row = source.execute('SELECT * FROM research_learning_runs WHERE id=?', (report['id'],)).fetchone()
        target.execute('INSERT INTO research_learning_runs VALUES(?,?,?,?,?)', row)
    clock = SimpleNamespace(at=datetime(2026,11,13,9,19,tzinfo=TAIPEI), mono=0)
    gateway = FakeGateway(clock)
    data = fixture(2)
    day = data['end'] if winning else data['start']
    base = int(datetime.fromisoformat(day).replace(tzinfo=TAIPEI).timestamp())
    offset = int(clock.at.replace(hour=0,minute=0).timestamp())-base
    def shift(rows):
        return [dict(b,time=b['time']+offset) for b in rows if datetime.fromtimestamp(b['time'],TAIPEI).date().isoformat()==day]
    gateway.candles = shift(data['futures'])
    stocks = {code:shift(rows) for code,rows in data['stocks'].items()}
    gateway.bars = lambda code, _day, kind='FUT': deepcopy(stocks[code] if kind=='STK' else gateway.candles)
    gateway.price = 25010
    auto_store = AutoStore(learning.research)
    trader = SandboxAutoTrader(gateway,auto_store,lambda header:header==HEADER,clock=lambda:clock.at,monotonic=lambda:clock.mono)
    return trader, gateway, clock, auto_store, config_for(report)


@pytest.mark.parametrize('winning', [True, False])
def test_real_model_controls_entry_and_persists_decision(trained, tmp_path, winning):
    trader, gateway, clock, store, config = make_trader(trained,tmp_path,winning)
    trader.start(config,HEADER)
    clock.at = clock.at.replace(minute=20,second=1)
    trader.tick()
    assert len(gateway.requests) == int(winning)
    model = trader.state['lastSignal']['model']
    assert model['accepted'] is winning and len(model['features']) == 12
    assert store.latest()['lastSignal']['model'] == model
    if winning:
        order = trader.state['orders'][0]
        assert order['modelRunId'] == config.model_run_id
        assert order['modelHash'] == hashlib.sha256(trained[0].model(config.model_run_id).encode()).hexdigest()
        assert order['exitDeadline'] == trader.state['lastSignal']['time']+1200
    else:
        assert trader.state['entryCount'] == 0


def test_exit_deadline_survives_restart_and_unavailable_model(trained,tmp_path):
    trader,gateway,clock,store,config = make_trader(trained,tmp_path)
    trader.start(config,HEADER);clock.at=clock.at.replace(minute=20,second=1);trader.tick()
    gateway.fill(25011);clock.at+=timedelta(seconds=1);trader.tick()
    deadline=trader.state['position']['exitDeadline']
    store.release(trader.writer)
    restarted=SandboxAutoTrader(gateway,store,trader.authorize,clock=lambda:clock.at,monotonic=lambda:clock.mono)
    restarted.tick();assert len(gateway.requests)==1 and restarted.entry_filter is None
    with LearningStore(store.research).connect() as db:
        db.execute('DELETE FROM research_learning_runs')
    restarted.control('reconcile',HEADER,restarted.state['id'],execution_allowed=True)
    clock.at=datetime.fromtimestamp(deadline,TAIPEI);gateway.price=25011
    restarted.tick()
    assert len(gateway.requests)==2 and gateway.requests[-1]['role']=='exit'
    assert restarted.state['exitReason']=='模型20分鐘退出期限'


def test_inference_failure_never_falls_back_to_unfiltered_entry(trained,tmp_path,monkeypatch):
    trader,gateway,clock,_,config=make_trader(trained,tmp_path)
    trader.start(config,HEADER)
    monkeypatch.setattr(trader.entry_filter.model,'predict',lambda *_a,**_kw:[float('nan')])
    clock.at=clock.at.replace(minute=20,second=1);trader.tick()
    assert trader.state['status']=='attention' and not gateway.requests


def test_model_list_requires_session_and_cannot_activate_demo(tmp_path,trained):
    app=create_app(Config(),sdk_factory=lambda:pytest.fail('no SDK'),passkey_store=PasskeyStore(tmp_path/'keys.db'),research_store=ResearchStore(tmp_path/'app.db'))
    with TestClient(app) as client:
        assert client.get('/api/v1/automation/models').status_code==401
        client.headers['Authorization']='Bearer '+app.state.session.issue()
        assert client.get('/api/v1/automation/models').json()==[]
        assert client.post('/api/v1/automation/start',json=config_for(trained[1]).model_dump(mode='json')).status_code==400


def test_model_choices_preserve_diagnostic_warning(trained):
    choices=model_choices(trained[0])
    assert choices[0]['blocked'] is None and choices[0]['reasons']
    assert choices[0]['settings']['strategy_version']=='orb_atr_v2'


def test_fractional_trained_r_is_preserved_during_live_entry(trained,tmp_path):
    learning, report = trained
    new_report = train(learning, TrainingRequest(dataset_id=report['datasetId'],config=CONFIG | dict(stopPoints=31,targetR=1.5)))
    trader,gateway,clock,store,config=make_trader((learning,new_report),tmp_path)
    trader.start(config,HEADER);clock.at=clock.at.replace(minute=20,second=1);trader.tick()
    # Reuse the actual, accepted model decision to verify ATR-adjusted target rounding.
    signal=trader.state['lastSignal'];signal['atr']=40
    trader.state['orders']=[];trader.state['pending']=None;trader.state['usedSides']=[];trader.state['entryCount']=0
    trader._send('Buy','entry','fractional R regression')
    order=trader.state['orders'][0]
    assert order['stopPoints']==60 and order['targetPoints']==90
    training_cfg=dict(config.model_dump(mode='json'),target_points=31*1.5)
    expected,_=entry_plan(training_cfg,signal,'Buy',order['limit'],gateway.price,0)
    assert order['targetPoints']==expected['targetPoints']


def test_all_model_decisions_survive_newer_signals_and_restart(trained,tmp_path):
    trader,gateway,clock,store,config=make_trader(trained,tmp_path,winning=False)
    trader.start(config,HEADER);clock.at=clock.at.replace(minute=20,second=1);trader.tick()
    first=deepcopy(trader.state['lastSignal'])
    clock.at=clock.at.replace(minute=25);trader.tick()
    second=deepcopy(trader.state['lastSignal'])
    assert second['time']>first['time']
    restored=AutoStore(store.research)
    assert restored.model_decisions(trader.state['id'])[-1]==first
    # Re-saving a changed copy at the same timestamp must not rewrite its original audit row.
    trader.state['lastSignal']=deepcopy(first);trader.state['lastSignal']['model']['score']=.123
    store.save(trader.state)
    assert restored.model_decisions(trader.state['id'])[-1]==first
