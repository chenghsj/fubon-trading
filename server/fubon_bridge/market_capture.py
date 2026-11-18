"""Persistent, nonblocking market-only capture. Never calls an order API."""
from collections import Counter, deque
from contextlib import contextmanager
from copy import deepcopy
import hashlib
import json
import math
import os
from pathlib import Path
import queue
import re
import shutil
import sqlite3
import threading
import time
import uuid

from .mapping import stamp

CHANNELS=('trades','books')
MAX_FRAME_BYTES=256*1024


def clock_us():
    return time.time_ns()//1000


def integer(value,minimum=0):
    return isinstance(value,(int,float)) and not isinstance(value,bool) and math.isfinite(value) and minimum<=value<=2**63-1 and value==int(value)


def market_window(contract):
    symbol=contract.get('target_code') or contract['code'];month=str(contract.get('delivery_month',''))[:6]
    if not re.fullmatch(r'20\d{2}(0[1-9]|1[0-2])',month) or symbol!='TMF'+'ABCDEFGHIJKL'[int(month[4:])-1]+month[3]:
        raise ValueError('收集契約缺少可核對的實際月份')
    start,end=(int(stamp(contract[k]).timestamp()*1e6) for k in ('market_open','market_close'))
    session=contract.get('market_session')
    if start>=end or session not in ('regular','afterhours'):
        raise ValueError('收集缺少官方日夜盤交易時段')
    return dict(symbol=symbol,month=month,session=session,openingDay=stamp(contract['market_open']).date().isoformat(),
        startUs=start,endUs=end)


class CaptureStore:
    def __init__(self,path):
        self.path=Path(path);self.path.parent.mkdir(parents=True,exist_ok=True)
        with self.connect() as db:
            db.execute('PRAGMA journal_mode=WAL')
            db.executescript('''
                CREATE TABLE IF NOT EXISTS capture_settings(id INTEGER PRIMARY KEY CHECK(id=1), enabled INTEGER NOT NULL);
                INSERT OR IGNORE INTO capture_settings VALUES(1,0);
                CREATE TABLE IF NOT EXISTS capture_runs(id TEXT PRIMARY KEY, started_us INTEGER, ended_us INTEGER);
                CREATE TABLE IF NOT EXISTS capture_frames(
                    id INTEGER PRIMARY KEY AUTOINCREMENT,run_id TEXT,epoch INTEGER,received_us INTEGER,monotonic_ns INTEGER,
                    event_us INTEGER,symbol TEXT,month TEXT,session TEXT,opening_day TEXT,window_start_us INTEGER,window_end_us INTEGER,
                    channel TEXT,event_type TEXT,is_trial INTEGER,serial INTEGER,valid INTEGER,duplicate INTEGER,
                    issues TEXT,sha256 TEXT,raw_json TEXT);
                CREATE INDEX IF NOT EXISTS capture_source_key ON capture_frames(symbol,session,window_start_us,event_us,serial);
                CREATE INDEX IF NOT EXISTS capture_day ON capture_frames(session,opening_day,id);
                CREATE TABLE IF NOT EXISTS capture_audit(id INTEGER PRIMARY KEY AUTOINCREMENT,run_id TEXT,at_us INTEGER,kind TEXT,detail TEXT);
                CREATE TABLE IF NOT EXISTS capture_summary(id INTEGER PRIMARY KEY CHECK(id=1),payload TEXT);
            ''')

    @contextmanager
    def connect(self,readonly=False):
        db=sqlite3.connect(f'file:{self.path}?mode=ro' if readonly else self.path,uri=readonly,timeout=2)
        try:
            db.execute('PRAGMA busy_timeout=2000')
            if not readonly:
                db.execute('PRAGMA synchronous=FULL')
            with db:
                yield db
        finally:
            db.close()

    def enabled(self):
        with self.connect(True) as db:
            return bool(db.execute('SELECT enabled FROM capture_settings WHERE id=1').fetchone()[0])

    def enable(self,value):
        with self.connect() as db:
            db.execute('UPDATE capture_settings SET enabled=? WHERE id=1',(int(value),))

    def summary(self):
        with self.connect(True) as db:
            row=db.execute('SELECT payload FROM capture_summary WHERE id=1').fetchone()
            return json.loads(row[0]) if row else dict(counts={},last={},lastCommitUs=None)


def validate_frame(data,channel,window,received):
    issues=[];at=data.get('time');trial=data.get('isTrial',False)
    if not isinstance(trial,bool):
        issues.append('invalid_trial_flag')
    if not integer(at,1):
        issues.append('invalid_exchange_time');at=None
    elif not window['startUs']<=at<=window['endUs']:
        issues.append('outside_official_window')
    elif at>received+1_000_000 or received-at>5_000_000:
        issues.append('clock_or_delivery_delay')
    if channel=='trades':
        trades=data.get('trades')
        if not isinstance(trades,list) or not trades or any(not isinstance(t,dict) or not integer(t.get('price'),1) or not integer(t.get('size'),1) for t in trades):
            issues.append('invalid_trades')
        if not integer(data.get('serial'),0):
            issues.append('missing_serial')
    else:
        sides=[data.get(k) for k in ('bids','asks')]
        if any(not isinstance(s,list) or not 1<=len(s)<=5 or any(not isinstance(x,dict) or not integer(x.get('price'),1) or not integer(x.get('size'),1) for x in s) for s in sides):
            issues.append('non_executable_book')
        else:
            bid,ask=sides
            if (any(a['price']<=b['price'] for a,b in zip(bid,bid[1:]))
                or any(a['price']>=b['price'] for a,b in zip(ask,ask[1:])) or bid[0]['price']>ask[0]['price']):
                issues.append('crossed_or_unsorted_book')
    return int(at) if at is not None else None,issues


class MarketCapture:
    def __init__(self,broker,store,*,queue_size=10000,minimum_free_bytes=512*1024*1024):
        self.broker=broker;self.store=store;self.enabled=store.enabled();self.accepting=self.enabled
        self.minimum_free_bytes=minimum_free_bytes;self.frames=queue.Queue(queue_size)
        self.pending_bytes=0;self.maximum_queue_bytes=32*1024*1024;self.reported_hook_errors=0
        self.lock=threading.Lock();self.controls=deque();self.control_overflow=0;self.dropped=0
        self.run_id=uuid.uuid4().hex;self.epoch=0;self.window=None;self.acks=set();self.seen={}
        self.error=None;self.route_error=None;self.retry_at=0.;self.request_at=0.;self.closed=False;self.thread=None
        self.saved=store.summary();self.request_lock=threading.Lock()

    def notice(self,kind,detail=None,at=None):
        with self.lock:
            if len(self.controls)>=1000:
                self.control_overflow+=1
            else:
                self.controls.append((at or clock_us(),kind,detail or {}))

    def begin(self):
        with self.request_lock:
            if self.thread is None:
                self.thread=threading.Thread(target=self._writer,name='fubon-market-capture',daemon=True);self.thread.start()

    def start(self):
        if self.broker.config.mode!='paper' or self.broker.config.session!='auto':
            raise ValueError('真實行情收集限Paper模式與自動盤別；不使用展示／測試合成資料')
        if self.closed or self.error:
            raise ValueError('收集器已關閉或寫入失敗，請保留資料並重啟服務')
        self.store.enable(True)
        with self.lock:
            self.enabled=self.accepting=True
        self.begin();self.notice('enabled');self.maintain()
        return self.status()

    def stop(self):
        with self.lock:
            self.enabled=self.accepting=False
        self.notice('disabled')
        self.store.enable(False)
        return self.status()

    def offer(self,kind,raw,received_us,monotonic_ns):
        # This path performs no SDK calls, file IO, DB access or blocking puts.
        if kind!='futopt':
            return
        with self.lock:
            if not self.accepting or self.closed or self.error:
                return
            if isinstance(raw,dict) and raw.get('event')=='capture_connection':
                state=raw.get('data',{}).get('state','unknown')
                if state!='connected':
                    self.epoch+=1;self.acks.clear();self.seen.clear()
                if len(self.controls)<1000:
                    self.controls.append((received_us,'connection',dict(state=state,epoch=self.epoch)))
                else:self.control_overflow+=1
                return
            window=deepcopy(self.window);epoch=self.epoch
        packet=raw if isinstance(raw,str) else json.dumps(raw,ensure_ascii=False,separators=(',',':'))
        size=len(packet.encode('utf-8'))
        with self.lock:
            if not self.accepting or self.closed or self.error:
                return
            if size>MAX_FRAME_BYTES or self.pending_bytes+size>self.maximum_queue_bytes:
                self.dropped+=1;return
            try:
                self.frames.put_nowait((packet,received_us,monotonic_ns,window,epoch,size))
                self.pending_bytes+=size
            except queue.Full:self.dropped+=1

    def maintain(self):
        if not self.enabled or self.closed or self.error or time.monotonic()<self.retry_at:
            return
        if self.broker.config.mode!='paper' or self.broker.config.session!='auto':
            self.route_error='收集限Paper與自動盤別';return
        self.begin()
        if self.broker.capture_hook_errors!=self.reported_hook_errors:
            self.notice('capture_hook_error',dict(count=self.broker.capture_hook_errors-self.reported_hook_errors))
            self.reported_hook_errors=self.broker.capture_hook_errors
        try:
            self.broker.ready() # Never logs into SDK; existing Passkey flow owns login.
            contract=self.broker.market_contract(dict(code='TMFR1',security_type='FUT'))
            window=market_window(contract)
            with self.lock:
                changed=window!=self.window
                if changed:
                    old=self.window;self.window=window;self.acks.clear();self.seen.clear()
            if changed:
                self.notice('window_change',dict(previous=old,current=window))
            connected='futopt' in self.broker.connected_sockets
            if changed or not connected or time.monotonic()-self.request_at>=60:
                self.request_at=time.monotonic()
                self.broker.subscribe(dict(code='TMFR1',security_type='FUT'),'Tick')
                self.broker.subscribe(dict(code='TMFR1',security_type='FUT'),'BidAsk')
                self.broker.refresh_market_sessions()
                self.broker.market_socket('futopt').subscriptions()
            self.route_error=None
        except Exception:
            self.retry_at=time.monotonic()+10
            self.route_error='等待解鎖或行情連線／官方交易時段恢復'
            self.notice('routing_or_connection_unavailable')

    def _process(self,db,item,counts,last):
        raw,received,mono,window,epoch,_=item
        try:
            message=json.loads(raw)
            if not isinstance(message,dict):raise ValueError()
        except (ValueError,TypeError):
            counts['malformedPackets']+=1;return
        event=message.get('event');data=message.get('data',{})
        if event=='capture_connection':
            return
        if event in ('authenticated','heartbeat','pong','error','unsubscribed'):
            self._audit(db,received,event,{})
            if event in ('error','unsubscribed'):
                with self.lock:self.acks.clear()
            return
        if event in ('subscribed','subscriptions'):
            for row in data if isinstance(data,list) else [data]:
                if isinstance(row,dict) and window and row.get('symbol')==window['symbol'] and row.get('channel') in CHANNELS:
                    with self.lock:
                        if epoch==self.epoch and window==self.window:self.acks.add(row['channel'])
                    self._audit(db,received,event,dict(symbol=row['symbol'],channel=row['channel'],epoch=epoch))
            return
        channel=message.get('channel')
        if event not in ('data','snapshot') or channel not in CHANNELS or not window or not isinstance(data,dict) or data.get('symbol')!=window['symbol']:
            return
        at,issues=validate_frame(data,channel,window,received);serial=data.get('serial');duplicate=False
        previous_channel=last.get(channel)
        if previous_channel and previous_channel.get('epoch')==epoch:
            if at is not None and previous_channel.get('eventUs') is not None and at<previous_channel['eventUs']:
                issues.append('source_time_regression')
            if received<previous_channel['receivedUs']:
                issues.append('receive_clock_regression')
        canonical=json.dumps(data,sort_keys=True,separators=(',',':'),ensure_ascii=False)
        sha=hashlib.sha256(canonical.encode()).hexdigest()
        if channel=='trades' and at is not None and integer(serial):
            previous=db.execute('SELECT sha256 FROM capture_frames WHERE symbol=? AND session=? AND window_start_us=? AND event_us=? AND serial=? AND channel=\'trades\' LIMIT 1',
                (window['symbol'],window['session'],window['startUs'],at,serial)).fetchone()
            if previous:
                duplicate=previous[0]==sha
                if not duplicate:issues.append('conflicting_serial')
        trial=data.get('isTrial',False) is True;valid=not issues
        db.execute('''INSERT INTO capture_frames(run_id,epoch,received_us,monotonic_ns,event_us,symbol,month,session,opening_day,
            window_start_us,window_end_us,channel,event_type,is_trial,serial,valid,duplicate,issues,sha256,raw_json)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)''',
            (self.run_id,epoch,received,mono,at,window['symbol'],window['month'],window['session'],window['openingDay'],
             window['startUs'],window['endUs'],channel,event,int(trial),int(serial) if integer(serial) else None,int(valid),int(duplicate),json.dumps(issues),sha,raw))
        counts['frames']+=1;counts[channel]+=1;counts['trialFrames']+=int(trial);counts['invalidFrames']+=int(not valid)
        counts['duplicateFrames']+=int(duplicate);counts['snapshotFrames']+=int(event=='snapshot')
        if valid and not trial and not duplicate and event=='data' and channel=='trades':
            counts['tradePrints']+=len(data['trades'])
        if valid and not trial and channel=='books':counts['executableBooks']+=1
        last[channel]=dict(receivedUs=received,eventUs=at,symbol=window['symbol'],valid=valid,trial=trial,epoch=epoch)
        with self.lock:
            if valid and not trial and epoch==self.epoch and window==self.window:self.seen[channel]=received

    def _audit(self,db,at,kind,detail):
        db.execute('INSERT INTO capture_audit(run_id,at_us,kind,detail) VALUES(?,?,?,?)',
            (self.run_id,at,kind,json.dumps(detail,ensure_ascii=False,allow_nan=False)))

    def _writer(self):
        owner=None
        try:
            owner=open(str(self.store.path)+'.lock','a+b')
            if os.name=='nt':
                import msvcrt
                owner.write(b'0');owner.flush();owner.seek(0);msvcrt.locking(owner.fileno(),msvcrt.LK_NBLCK,1)
            else:
                import fcntl
                fcntl.flock(owner.fileno(),fcntl.LOCK_EX|fcntl.LOCK_NB)
            with self.store.connect() as db:
                unclean=db.execute('SELECT id FROM capture_runs WHERE ended_us IS NULL').fetchall()
                db.execute('INSERT INTO capture_runs VALUES(?,?,NULL)',(self.run_id,clock_us()))
                if unclean:self._audit(db,clock_us(),'unclean_restart',dict(runs=[r[0] for r in unclean]))
            counts=Counter(self.saved['counts']);last=dict(self.saved['last']);reported_drop=reported_controls=0;disk_check=0
            while True:
                batch=[]
                try:batch.append(self.frames.get(timeout=.25))
                except queue.Empty:pass
                for _ in range(499):
                    try:batch.append(self.frames.get_nowait())
                    except queue.Empty:break
                with self.lock:
                    self.pending_bytes-=sum(item[-1] for item in batch)
                    controls=list(self.controls);self.controls.clear()
                    dropped,overflow=self.dropped,self.control_overflow
                if time.monotonic()-disk_check>10:
                    disk_check=time.monotonic()
                    if shutil.disk_usage(self.store.path.parent).free<self.minimum_free_bytes:
                        raise OSError('capture storage low')
                if not batch and not controls and dropped==reported_drop and overflow==reported_controls and not self.closed:
                    continue
                with self.store.connect() as db:
                    for at,kind,detail in controls:self._audit(db,at,kind,detail)
                    if dropped!=reported_drop or overflow!=reported_controls:
                        self._audit(db,clock_us(),'capture_loss',dict(dataPackets=dropped-reported_drop,controlEvents=overflow-reported_controls))
                        counts['droppedPackets']+=dropped-reported_drop;counts['lostControlEvents']+=overflow-reported_controls
                        reported_drop,reported_controls=dropped,overflow
                    for item in batch:self._process(db,item,counts,last)
                    saved=dict(counts=dict(counts),last=deepcopy(last),lastCommitUs=clock_us())
                    db.execute('INSERT OR REPLACE INTO capture_summary VALUES(1,?)',(json.dumps(saved,allow_nan=False),))
                    if self.closed and self.frames.empty():
                        self._audit(db,clock_us(),'clean_shutdown',{})
                        db.execute('UPDATE capture_runs SET ended_us=? WHERE id=?',(clock_us(),self.run_id))
                with self.lock:self.saved=saved
                if self.closed and self.frames.empty():break
        except Exception:
            # A run left open in SQLite is durable evidence of an interrupted
            # capture even if disk-full makes writing an error marker impossible.
            with self.lock:
                self.error='行情保存失敗或已有收集程序；已停止寫入，該段資料不可視為完整'
                self.accepting=False
        finally:
            if owner:owner.close()

    def status(self):
        with self.lock:
            result=deepcopy(self.saved);window=deepcopy(self.window);enabled=self.enabled;error=self.error
            acks=sorted(self.acks);seen=dict(self.seen)
        at=clock_us();active=bool(window and window['startUs']<=at<window['endUs'])
        state='stopped' if not enabled else 'error' if error else 'waiting_connection' if self.route_error or not window else 'market_closed' if not active else 'collecting' if len(acks)==2 and all(at-seen.get(c,0)<30_000_000 for c in CHANNELS) else 'waiting_data'
        return dict(result,enabled=enabled,state=state,error=error or self.route_error,window=window,acknowledgedChannels=acks,
            queueDepth=self.frames.qsize(),pendingDroppedPackets=self.dropped,pendingControlLoss=self.control_overflow,
            queuedBytes=self.pending_bytes,hookErrors=self.broker.capture_hook_errors,
            databaseBytes=sum(p.stat().st_size for p in (self.store.path,Path(str(self.store.path)+'-wal')) if p.exists()),
            source='fubon-paper',product='TMF',available=self.broker.config.mode=='paper' and self.broker.config.session=='auto',
            researchOnly=True,executionAllowed=False,adoptionAllowed=False)

    def shutdown(self):
        with self.lock:self.accepting=False;self.closed=True
        if self.thread:
            self.thread.join(timeout=8)
            if self.thread.is_alive():
                with self.lock:self.error='行情保存尚未排空；保留未完成紀錄，資料不可視為完整'
