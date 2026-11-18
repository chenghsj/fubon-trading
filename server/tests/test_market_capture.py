from collections import Counter
from copy import deepcopy
from datetime import datetime
import json
import sqlite3
import threading
import time
from types import SimpleNamespace as NS
from unittest.mock import Mock

from fastapi.testclient import TestClient
import pytest

from fubon_bridge.app import create_app
from fubon_bridge.broker import Broker
from fubon_bridge.config import Config
from fubon_bridge.mapping import TAIPEI
from fubon_bridge.market_capture import CaptureStore, MarketCapture, market_window
from fubon_bridge.passkeys import PasskeyStore


def us(value):
    return int(datetime.fromisoformat(value).replace(tzinfo=TAIPEI).timestamp()*1e6)


@pytest.fixture
def capture(tmp_path,monkeypatch):
    clock=[us('2026-11-18T15:01:00')]
    monkeypatch.setattr('fubon_bridge.market_capture.clock_us',lambda:clock[0])
    contract=dict(code='TMFR1',target_code='TMFL6',delivery_month='202612',market_session='afterhours',
        market_open='2026-11-18T15:00:00+08:00',market_close='2026-11-19T05:00:00+08:00')
    broker=NS(config=Config(mode='paper'),capture_hook_errors=0,connected_sockets={'futopt'},ready=Mock(),
        market_contract=Mock(side_effect=lambda *_:deepcopy(contract)),subscribe=Mock(),refresh_market_sessions=Mock(),
        market_socket=Mock(return_value=NS(subscriptions=Mock())),place_order=Mock(side_effect=AssertionError('no orders')))
    service=MarketCapture(broker,CaptureStore(tmp_path/'capture.sqlite3'),minimum_free_bytes=0)
    yield service,broker,contract,clock
    service.shutdown()


def packet(channel='trades',at=None,serial=10,event='data',**extras):
    data=dict(symbol='TMFL6',time=at if at is not None else us('2026-11-18T15:01:00'))
    data.update(dict(trades=[dict(price=40000,size=2)],serial=serial) if channel=='trades'
        else dict(bids=[dict(price=39999-i,size=5+i) for i in range(5)],asks=[dict(price=40001+i,size=6+i) for i in range(5)]))
    return dict(event=event,channel=channel,data=data|extras)


def offer(service,message,clock):
    service.offer('futopt',message,clock[0],time.monotonic_ns())


def wait_for(predicate):
    deadline=time.monotonic()+3
    while not predicate():
        assert time.monotonic()<deadline
        time.sleep(.01)


def test_persists_microsecond_native_fields_trial_snapshot_and_duplicate(capture):
    c,b,contract,clock=capture;c.start()
    offer(c,dict(event='subscribed',data=[dict(channel=x,symbol='TMFL6') for x in ('trades','books')]),clock)
    data=packet();offer(c,data,clock);offer(c,data,clock)
    offer(c,packet('books'),clock)
    offer(c,packet(serial=11,event='snapshot'),clock)
    offer(c,packet(serial=12,isTrial=True),clock)
    wait_for(lambda:c.status()['counts'].get('frames')==5)
    s=c.status();assert s['counts']['tradePrints']==1 and s['counts']['duplicateFrames']==1
    assert s['counts']['snapshotFrames']==1 and s['counts']['trialFrames']==1
    assert s['state']=='collecting' and not s['executionAllowed'] and not s['adoptionAllowed']
    c.shutdown()
    with c.store.connect(True) as db:
        rows=db.execute('SELECT received_us,event_us,symbol,month,opening_day,raw_json FROM capture_frames').fetchall()
        assert rows[0][:5]==(clock[0],clock[0],'TMFL6','202612','2026-11-18')
        assert json.loads(rows[2][-1])['data']['bids'][0]==dict(price=39999,size=5)
        assert db.execute('SELECT ended_us FROM capture_runs').fetchone()[0] is not None
    b.place_order.assert_not_called()


def test_queue_overflow_retains_priority_disconnect_and_loss_marker(capture):
    c,_,contract,clock=capture
    c.frames=__import__('queue').Queue(1);c.enabled=c.accepting=True;c.window=market_window(contract)
    offer(c,packet(),clock);offer(c,packet(serial=11),clock)
    offer(c,dict(event='capture_connection',data=dict(state='disconnect')),clock)
    assert c.dropped==1 and c.epoch==1 and len(c.controls)==1
    c.begin();wait_for(lambda:c.status()['counts'].get('droppedPackets')==1);c.shutdown()
    with c.store.connect(True) as db:
        kinds=[r[0] for r in db.execute('SELECT kind FROM capture_audit')]
        assert 'connection' in kinds and 'capture_loss' in kinds


def test_recording_survives_midnight_and_new_window_never_retags_old_symbol(capture):
    c,b,contract,clock=capture;c.start()
    clock[0]=us('2026-11-19T00:00:01');offer(c,packet(at=clock[0]),clock)
    wait_for(lambda:c.status()['counts'].get('frames')==1)
    contract.update(target_code='TMFA7',delivery_month='202701',market_open='2026-12-16T15:00:00+08:00',market_close='2026-12-17T05:00:00+08:00')
    clock[0]=us('2026-12-16T15:00:01');c.maintain()
    offer(c,packet(at=clock[0],serial=12),clock) # late previous contract; not relabelled.
    offer(c,packet(at=clock[0],serial=13,symbol='TMFA7'),clock)
    wait_for(lambda:c.status()['counts'].get('frames')==2);c.shutdown()
    with c.store.connect(True) as db:
        assert db.execute('SELECT symbol,month,opening_day FROM capture_frames ORDER BY id').fetchall()==[
            ('TMFL6','202612','2026-11-18'),('TMFA7','202701','2026-12-16')]


def test_no_ack_is_not_connected_health_and_disconnect_resets_ack_immediately(capture):
    c,_,_,clock=capture;c.start();offer(c,packet(),clock);offer(c,packet('books'),clock)
    wait_for(lambda:c.status()['counts'].get('frames')==2)
    assert c.status()['state']=='waiting_data'
    offer(c,dict(event='subscribed',data=[dict(channel=x,symbol='TMFL6') for x in ('trades','books')]),clock)
    wait_for(lambda:c.status()['state']=='collecting')
    offer(c,dict(event='capture_connection',data=dict(state='disconnect')),clock)
    assert c.status()['acknowledgedChannels']==[] and c.status()['state']=='waiting_data'


def test_queued_old_contract_ack_cannot_confirm_new_contract(capture):
    c,b,contract,clock=capture
    c.enabled=c.accepting=True;c.window=market_window(contract)
    offer(c,dict(event='subscribed',data=[dict(channel=x,symbol='TMFL6') for x in ('trades','books')]),clock)
    contract.update(target_code='TMFA7',delivery_month='202701',market_open='2026-12-16T15:00:00+08:00',market_close='2026-12-17T05:00:00+08:00')
    # Change the frozen context before draining the old ACK. No socket reconnect
    # is needed to invalidate an ACK belonging to another contract/window.
    c.window=market_window(contract);c.begin()
    clock[0]=us('2026-12-16T15:00:01')
    offer(c,packet(at=clock[0],symbol='TMFA7'),clock)
    offer(c,packet('books',at=clock[0],symbol='TMFA7'),clock)
    wait_for(lambda:c.status()['counts'].get('frames')==2)
    assert c.status()['acknowledgedChannels']==[] and c.status()['state']=='waiting_data'


def test_stop_and_restart_setting_unclean_run_and_storage_failure(capture):
    c,b,_,clock=capture
    with c.store.connect() as db:db.execute('INSERT INTO capture_runs VALUES(?,?,NULL)',('crashed',clock[0]-100))
    c.start();wait_for(lambda:c.store.summary()['lastCommitUs'] is not None)
    c.stop();offer(c,packet(),clock);c.shutdown()
    assert not c.store.enabled()
    with c.store.connect(True) as db:
        assert db.execute("SELECT count(*) FROM capture_audit WHERE kind='unclean_restart'").fetchone()[0]==1
        assert db.execute('SELECT count(*) FROM capture_frames').fetchone()[0]==0
    other=MarketCapture(b,c.store,minimum_free_bytes=10**30)
    other.start();wait_for(lambda:other.error is not None);other.shutdown()
    assert other.status()['state']=='error'


def test_callback_isolation_and_single_capture_before_alias_mapping():
    emit=Mock();b=Broker(Config(mode='paper',session='regular'),emit)
    b.subscriptions={}
    for code in ('TMFR1','TMFL6'):
        b.subscriptions[(code,'Tick')]=dict(kind='futopt',channel='trades',contract=dict(code=code,target_code='TMFL6'))
    b.paper.tick=Mock();b.raw_market_sink=Mock(side_effect=RuntimeError('writer broken'))
    b._on_market('futopt',packet())
    b.raw_market_sink.assert_called_once()
    assert b.capture_hook_errors==1 and emit.call_count==2
    assert all(call.args[0]=='tick_fop' for call in emit.call_args_list)


def test_db_lock_does_not_block_capture_callback(capture):
    c,_,_,clock=capture;c.start()
    with c.store.connect() as db:
        db.execute('BEGIN IMMEDIATE')
        before=time.monotonic()
        for i in range(50):offer(c,packet(serial=i),clock)
        assert time.monotonic()-before<.2
    c.shutdown()


@pytest.mark.parametrize('patch',[dict(time=float('nan')),dict(time=True),dict(trades=[dict(price=1.5,size=1)]),dict(serial=None)])
def test_invalid_payload_preserved_but_not_used_for_training(capture,patch):
    c,_,_,clock=capture;c.start();offer(c,packet(**patch),clock)
    wait_for(lambda:c.status()['counts'].get('frames')==1)
    assert c.status()['counts']['invalidFrames']==1 and c.status()['counts'].get('tradePrints',0)==0


def test_local_routes_require_auth_and_revoking_ui_does_not_stop_capture(tmp_path):
    app=create_app(Config(mode='paper'),passkey_store=PasskeyStore(tmp_path/'passkeys.sqlite3'))
    connect=Mock();app.state.broker.connect=connect
    with TestClient(app) as client:
        assert client.get('/api/v1/research/capture').status_code==401
        token='Bearer '+app.state.session.issue();client.headers['Authorization']=token
        assert client.post('/api/v1/research/capture/start',json={}).json()['enabled']
        app.state.session.revoke(token)
        assert client.post('/api/v1/research/capture/stop',json={}).status_code==401
        assert app.state.capture.enabled
        connect.assert_not_called() # No new SDK session or implicit Passkey bypass.


@pytest.mark.parametrize('mode',['demo','sandbox','live'])
def test_synthetic_and_order_modes_not_labelled_as_real_paper_capture(tmp_path,mode):
    b=NS(config=Config(mode=mode,live_enabled=mode=='live'))
    c=MarketCapture(b,CaptureStore(tmp_path/'capture.sqlite3'))
    with pytest.raises(ValueError,match='Paper'):c.start()
