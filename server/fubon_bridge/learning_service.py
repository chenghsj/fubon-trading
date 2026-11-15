"""One bounded background research job; independent of order execution."""
from concurrent.futures import ThreadPoolExecutor
import threading
import uuid
from .learning_data import collect
from .learning_train import train
from .auto_store import AutoStore
import time


class LearningService:
    def __init__(self, broker, store, automation):
        self.broker,self.store,self.automation=broker,store,automation
        self.lock=threading.RLock()
        self.executor=ThreadPoolExecutor(max_workers=1,thread_name_prefix='learning')
        self.current=None
        self.closing=False
        self.activity=AutoStore(store.research)

    def lease(self):
        with self.store.research.connect() as db:
            row=db.execute('SELECT owner,expires FROM research_auto_lease WHERE id=1').fetchone()
        return row[0] if row and row[1]>time.time() else None

    def overview(self):
        result=self.store.overview()
        for job in result['jobs']:
            if job['status']=='running' and job.get('leaseOwner')!=self.lease():
                job.update(status='interrupted',message='此程序未持有該工作；服務可能重啟，請確認後重試，已下載批次保留')
        return result

    def busy(self):
        owner=self.lease()
        return bool(owner and owner.startswith('LR'))

    def start(self, action, request):
        with self.lock:
            if self.closing or self.busy():
                raise ValueError('已有研究工作執行中，請等待完成')
            state=self.automation.snapshot()
            if state['position'] or state['pending'] or state['status'] in {'running','stopping'}:
                raise ValueError('請先停止策略並確認沒有曝險或待確認委託，再執行歷史研究')
            owner='LR'+uuid.uuid4().hex
            self.activity.claim(owner)  # Same SQLite atomic lease used by every auto writer.
            job=dict(id=uuid.uuid4().hex,leaseOwner=owner,action=action,status='running',message='準備研究工作',progress=0,resultId=None)
            self.current=job
            try:
                self.store.job(job)
            except Exception:
                self.activity.release(owner)
                raise
            stop_renewal=threading.Event()
            lost=threading.Event()
            def renew():
                while not stop_renewal.wait(15):
                    try:
                        self.activity.claim(owner)
                    except Exception:
                        lost.set(); return
            renewal=threading.Thread(target=renew,name='learning-lease',daemon=True)
            renewal.start()
            def update(message,progress):
                with self.lock:
                    if self.closing or lost.is_set() or self.lease()!=owner:
                        raise ValueError('服務已停止，工作中斷；已下載批次仍保留')
                    job.update(message=message,progress=progress)
                    self.store.job(job)
            def work():
                try:
                    update('開始研究工作',0)
                    result=collect(self.broker,self.store,request,update) if action=='collect' else train(self.store,request,update)
                    with self.lock:
                        job.update(status='completed',message='資料已保存' if action=='collect' else '模型研究已保存；未啟用自動交易',progress=1,resultId=result['id'])
                except Exception as error:
                    with self.lock:
                        job.update(status='failed',message=str(error) if isinstance(error,ValueError) else '研究工作失敗，已保存資料仍保留；請檢查套件與資料品質')
                finally:
                    stop_renewal.set()
                    renewal.join()
                    try:
                        self.store.job(job)
                    finally:
                        self.activity.release(owner)
            try:
                self.executor.submit(work)
            except Exception:
                stop_renewal.set()
                renewal.join()
                job.update(status='failed',message='無法啟動研究工作，請重新啟動服務')
                try:
                    self.store.job(job)
                finally:
                    self.activity.release(owner)
                raise ValueError(job['message']) from None
            return dict(job)

    def shutdown(self):
        with self.lock:
            self.closing=True
        # Queued work must enter its closing guard/finally to stop lease renewal.
        self.executor.shutdown(wait=True,cancel_futures=False)
