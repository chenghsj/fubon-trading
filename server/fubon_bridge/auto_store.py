"""Mode-isolated simulation intents and a shared writer lease."""
import json
import time
import threading

from .mapping import now
from .research import canonical


class AutoStore:
    def __init__(self, research, mode='sandbox'):
        self.research = research
        self.mode = mode
        self.initialized = False
        self.schema_lock = threading.Lock()

    def _database(self):
        with self.schema_lock:
            if not self.initialized:
                self._migrate()
                self.initialized = True
        return self.research.connect()

    def _migrate(self):
        with self.research.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            if 'mode' not in {r[1] for r in db.execute('PRAGMA table_info(research_auto_runs)')}:
                db.execute('ALTER TABLE research_auto_runs RENAME TO research_auto_runs_legacy')
                db.execute('''CREATE TABLE research_auto_runs (
                    id TEXT PRIMARY KEY,day TEXT,account TEXT,updated_at TEXT,payload TEXT,
                    mode TEXT NOT NULL,UNIQUE(mode,day,account))''')
                db.execute("INSERT INTO research_auto_runs SELECT *, 'sandbox' FROM research_auto_runs_legacy")
                db.execute('DROP TABLE research_auto_runs_legacy')
            db.execute('CREATE INDEX IF NOT EXISTS research_auto_mode ON research_auto_runs(mode,updated_at)')

    def latest(self):
        with self._database() as db:
            row = db.execute("SELECT payload FROM research_auto_runs WHERE mode=? ORDER BY updated_at DESC LIMIT 1",(self.mode,)).fetchone()
        return json.loads(row[0]) if row else None

    def for_day(self, account, day):
        with self._database() as db:
            row = db.execute("SELECT payload FROM research_auto_runs WHERE mode=? AND account=? AND day=? ORDER BY updated_at DESC LIMIT 1", (self.mode,canonical(account), day)).fetchone()
        return json.loads(row[0]) if row else None

    def save(self, state, kind=None, message=None):
        at = now().isoformat()
        with self._database() as db:
            changed=db.execute("""INSERT INTO research_auto_runs(id,day,account,updated_at,payload,mode) VALUES(?,?,?,?,?,?)
                ON CONFLICT(id) DO UPDATE SET updated_at=excluded.updated_at,payload=excluded.payload
                WHERE research_auto_runs.mode=excluded.mode""",
                (state["id"], state["config"]["trade_date"], canonical(state["config"]["account"]), at, canonical(state),self.mode))
            if not changed.rowcount:
                raise ValueError('策略紀錄模式不符，拒絕覆寫')
            if message:
                db.execute("INSERT INTO research_auto_events(run_id,time,kind,message) VALUES(?,?,?,?)", (state["id"], at, kind or "state", message))

    def events(self, run_id):
        with self._database() as db:
            rows = db.execute("SELECT id,time,kind,message FROM research_auto_events WHERE run_id=? ORDER BY id DESC LIMIT 100", (run_id,)).fetchall()
        return [dict(id=i, time=t, kind=k, message=m) for i,t,k,m in rows]

    def claim(self, owner):
        # A second backend using the same DB cannot send orders for this strategy.
        at = time.time()
        with self.research.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT owner,expires FROM research_auto_lease WHERE id=1").fetchone()
            if row and row[0] != owner and row[1] > at:
                raise ValueError("另一個服務仍持有策略執行權，請先停止原服務")
            db.execute("INSERT OR REPLACE INTO research_auto_lease VALUES(1,?,?)", (owner, at+90))

    def release(self, owner):
        with self.research.connect() as db:
            db.execute("DELETE FROM research_auto_lease WHERE id=1 AND owner=?", (owner,))
