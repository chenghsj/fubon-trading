"""Local immutable learning snapshots and native LightGBM text artifacts."""
import json
import threading
import zlib
from .mapping import now
from .research import canonical, digest


class LearningStore:
    def __init__(self, research):
        self.research = research
        self.lock = threading.Lock()
        self.initialized = False

    def connect(self):
        with self.lock:
            if not self.initialized:
                with self.research.connect() as db:
                    db.executescript("""
                    CREATE TABLE IF NOT EXISTS research_learning_chunks (id TEXT PRIMARY KEY, payload BLOB);
                    CREATE TABLE IF NOT EXISTS research_learning_datasets (id TEXT PRIMARY KEY, created_at TEXT, summary TEXT, payload BLOB);
                    CREATE TABLE IF NOT EXISTS research_learning_runs (id TEXT PRIMARY KEY, created_at TEXT, dataset_id TEXT, report TEXT, model BLOB);
                    CREATE TABLE IF NOT EXISTS research_learning_jobs (id TEXT PRIMARY KEY, updated_at TEXT, payload TEXT);
                    """)
                self.initialized = True
        return self.research.connect()

    def chunk(self, request):
        with self.connect() as db:
            row = db.execute('SELECT payload FROM research_learning_chunks WHERE id=?', (digest(request),)).fetchone()
            return json.loads(zlib.decompress(row[0])) if row else None

    def save_chunk(self, request, payload):
        with self.connect() as db:
            db.execute('INSERT OR REPLACE INTO research_learning_chunks VALUES(?,?)', (digest(request), zlib.compress(canonical(payload).encode())))

    def save_dataset(self, data, summary):
        ident = digest(data)
        summary = dict(summary, id=ident)
        with self.connect() as db:
            db.execute('INSERT OR IGNORE INTO research_learning_datasets VALUES(?,?,?,?)',
                (ident, now().isoformat(), canonical(summary), zlib.compress(canonical(data).encode())))
        return summary

    def dataset(self, ident):
        with self.connect() as db:
            row = db.execute('SELECT payload FROM research_learning_datasets WHERE id=?', (ident,)).fetchone()
            if not row:
                raise ValueError('找不到訓練資料版本')
            return json.loads(zlib.decompress(row[0]))

    def save_run(self, dataset_id, fingerprint, report, model=None):
        ident = digest(fingerprint)
        report = dict(report, id=ident, datasetId=dataset_id, executionEnabled=False)
        with self.connect() as db:
            db.execute('INSERT OR IGNORE INTO research_learning_runs VALUES(?,?,?,?,?)',
                (ident, now().isoformat(), dataset_id, canonical(report), zlib.compress(model.encode()) if model else None))
        return self.run(ident)

    def run(self, ident):
        with self.connect() as db:
            row = db.execute('SELECT report FROM research_learning_runs WHERE id=?', (ident,)).fetchone()
            if not row:
                raise ValueError('找不到模型研究版本')
            return json.loads(row[0])

    def model(self, ident):
        with self.connect() as db:
            row = db.execute('SELECT model FROM research_learning_runs WHERE id=?', (ident,)).fetchone()
            if not row or row[0] is None:
                raise ValueError('此版本沒有可匯出的模型；請檢查資料不足原因')
            return zlib.decompress(row[0]).decode()

    def job(self, payload):
        with self.connect() as db:
            db.execute('INSERT OR REPLACE INTO research_learning_jobs VALUES(?,?,?)', (payload['id'], now().isoformat(), canonical(payload)))

    def overview(self):
        with self.connect() as db:
            datasets = [json.loads(r[0]) for r in db.execute('SELECT summary FROM research_learning_datasets ORDER BY created_at DESC LIMIT 12')]
            runs = []
            for i,t,d,p in db.execute('SELECT id,created_at,dataset_id,report FROM research_learning_runs ORDER BY created_at DESC LIMIT 12'):
                report=json.loads(p)
                runs.append(dict(id=i,createdAt=t,datasetId=d,status=report['status'],metricsPassed=report['metricsPassed'],strategySession=report.get('strategySession','cash'),researchMethod=report.get('researchMethod','fixed'),modelBytes=(report.get('model') or {}).get('bytes',0)))
            jobs = [json.loads(r[0]) for r in db.execute('SELECT payload FROM research_learning_jobs ORDER BY updated_at DESC LIMIT 6')]
        files=[self.research.path,self.research.path.with_name(self.research.path.name+'-wal'),self.research.path.with_name(self.research.path.name+'-shm')]
        size=0
        for path in files:
            try:
                size+=path.stat().st_size
            except FileNotFoundError:
                pass  # A concurrent WAL checkpoint may remove its sidecar.
        return dict(datasets=datasets,runs=runs,jobs=jobs,databaseBytes=size)
