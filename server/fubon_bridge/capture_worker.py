"""Bounded, offline research jobs alongside capture; no automatic trading."""
from datetime import timedelta
import json
import os
from pathlib import Path
import subprocess
import sys
import threading
import time

from .mapping import now


def atomic_json(path,value):
    path.parent.mkdir(parents=True,exist_ok=True)
    part=path.with_suffix(path.suffix+'.part')
    part.write_text(json.dumps(value,ensure_ascii=False,indent=2,allow_nan=False));part.replace(path)


class CaptureResearchWorker:
    def __init__(self,capture,directory):
        self.capture=capture;self.broker=capture.broker;self.directory=Path(directory)
        self.closing=threading.Event();self.wake=threading.Event();self.thread=None;self.process=None
        self.last_fetch=None;self.last_attempt=0.;self.error=None

    def start(self):
        if self.thread is None:
            self.thread=threading.Thread(target=self._loop,name='capture-offline-research',daemon=True);self.thread.start()

    def request(self):
        self.wake.set()
        return self.status()

    def status(self):
        path=self.directory/'status.json'
        try:result=json.loads(path.read_text())
        except (FileNotFoundError,ValueError):result=dict(state='waiting_data',message='等待已完成的收集時段與足夠樣本')
        return dict(result,running=self.process is not None and self.process.poll() is None,error=self.error,
            executionAllowed=False,adoptionAllowed=False)

    def _minutes(self):
        at=now();day=at.date().isoformat()
        # Historical minute data is published after about 17:30. Query complete
        # trading dates, letting the API return physical night timestamps.
        if at.hour<18 or self.last_fetch==day:
            return
        start=(at.date()-timedelta(days=7)).isoformat()
        for session in ('regular','afterhours'):
            path=self.directory/'minutes'/f'{day}-{session}.json'
            if path.exists():continue
            rows=self.broker.learning_candles('FUT','TMF',start,day,session=session)
            atomic_json(path,dict(source='fubon-paper',session=session,start=start,end=day,
                fetchedAt=at.isoformat(),rows=rows))
        self.last_fetch=day

    def _loop(self):
        while not self.closing.is_set():
            requested=self.wake.wait(timeout=60);self.wake.clear()
            if self.closing.is_set():break
            if not self.capture.enabled or self.broker.config.mode!='paper' or self.broker.config.session!='auto':continue
            if not requested and time.monotonic()-self.last_attempt<3600:continue
            self.last_attempt=time.monotonic()
            try:
                self.broker.ready();self._minutes()
                self.directory.mkdir(parents=True,exist_ok=True)
                with (self.directory/'worker.log').open('ab') as log:
                    env=os.environ|dict(OMP_NUM_THREADS='1',OPENBLAS_NUM_THREADS='1')
                    self.process=subprocess.Popen([sys.executable,'-m','fubon_bridge.capture_study',
                        '--database',str(self.capture.store.path),'--output',str(self.directory)],stdout=log,stderr=log,env=env)
                    deadline=time.monotonic()+900
                    while self.process.poll() is None:
                        if self.closing.wait(.5) or time.monotonic()>deadline:
                            self.process.terminate()
                            try:self.process.wait(timeout=5)
                            except subprocess.TimeoutExpired:self.process.kill();self.process.wait(timeout=5)
                            break
                    if self.process.returncode!=0:raise ValueError('offline study failed')
                self.error=None
            except Exception:
                self.error='離線研究或分鐘資料更新未完成；行情保存仍獨立執行，稍後可重試'
            finally:self.process=None

    def shutdown(self):
        self.closing.set();self.wake.set()
        if self.thread:self.thread.join(timeout=8)
