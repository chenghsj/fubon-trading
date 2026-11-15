"""Durable sandbox strategy intents and a single writer lease, using the research database."""
import json
import time

from .mapping import now
from .research import canonical


class AutoStore:
    def __init__(self, research):
        self.research = research

    def latest(self):
        with self.research.connect() as db:
            row = db.execute("SELECT payload FROM research_auto_runs ORDER BY updated_at DESC LIMIT 1").fetchone()
        return json.loads(row[0]) if row else None

    def for_day(self, account, day):
        with self.research.connect() as db:
            row = db.execute("SELECT payload FROM research_auto_runs WHERE account=? AND day=?", (canonical(account), day)).fetchone()
        return json.loads(row[0]) if row else None

    def save(self, state, kind=None, message=None):
        at = now().isoformat()
        with self.research.connect() as db:
            db.execute("""INSERT INTO research_auto_runs VALUES(?,?,?,?,?)
                ON CONFLICT(id) DO UPDATE SET updated_at=excluded.updated_at,payload=excluded.payload""",
                (state["id"], state["config"]["trade_date"], canonical(state["config"]["account"]), at, canonical(state)))
            if message:
                db.execute("INSERT INTO research_auto_events(run_id,time,kind,message) VALUES(?,?,?,?)", (state["id"], at, kind or "state", message))

    def events(self, run_id):
        with self.research.connect() as db:
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
