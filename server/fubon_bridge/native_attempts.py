"""Durable native submission outcomes; an ambiguous write is never retried."""
import json
import threading
from contextlib import contextmanager
from fastapi import HTTPException
from .mapping import now


class NativeAttempts:
    def __init__(self, research):
        self.research=research
        self._schema_lock=threading.Lock()
        self._initialized=False

    @contextmanager
    def database(self):
        with self.research.connect() as db:
            with self._schema_lock:
                if not self._initialized:
                    db.execute('''CREATE TABLE IF NOT EXISTS native_submission_attempts (
                        environment TEXT NOT NULL, id TEXT NOT NULL, account_key TEXT NOT NULL,
                        operation TEXT NOT NULL, fingerprint TEXT NOT NULL, status TEXT NOT NULL,
                        created_at TEXT NOT NULL, result TEXT, PRIMARY KEY(environment,id))''')
                    self._initialized=True
            yield db

    def begin(self, environment, ident, account, operation, fingerprint):
        with self.database() as db:
            db.execute('BEGIN IMMEDIATE')
            old=db.execute('SELECT fingerprint,status,result FROM native_submission_attempts WHERE environment=? AND id=?',(environment,ident)).fetchone()
            if old:
                if old[0]==fingerprint and old[1]=='complete':
                    return json.loads(old[2])
                raise HTTPException(409,'此送出紀錄已有結果或尚待核對，不能重複送出')
            blocked=db.execute("SELECT id FROM native_submission_attempts WHERE environment=? AND account_key=? AND status IN ('pending','uncertain')",(environment,account)).fetchone()
            if blocked:
                raise HTTPException(409,'此帳戶有送出結果尚待核對，請先查詢券商紀錄並完成核對')
            db.execute('INSERT INTO native_submission_attempts VALUES(?,?,?,?,?,?,?,NULL)',
                (environment,ident,account,operation,fingerprint,'pending',now().isoformat()))
        return None

    def complete(self, environment, ident, result):
        with self.database() as db:
            db.execute("UPDATE native_submission_attempts SET status='complete',result=? WHERE environment=? AND id=?",
                       (json.dumps(result,ensure_ascii=False,allow_nan=False),environment,ident))

    def uncertain(self, environment, ident):
        with self.database() as db:
            db.execute("UPDATE native_submission_attempts SET status='uncertain' WHERE environment=? AND id=?",(environment,ident))

    def pending(self, environment, account):
        with self.database() as db:
            rows=db.execute("SELECT id,operation,status,created_at FROM native_submission_attempts WHERE environment=? AND account_key=? AND status IN ('pending','uncertain') ORDER BY created_at",(environment,account)).fetchall()
        return [dict(request_id=row[0],operation=row[1],status=row[2],created_at=row[3]) for row in rows]

    def reconcile(self, environment, account, ident):
        with self.database() as db:
            old=db.execute('SELECT status FROM native_submission_attempts WHERE environment=? AND account_key=? AND id=?',(environment,account,ident)).fetchone()
            if old and old[0] in {'complete','verified'}:
                return
            changed=db.execute("UPDATE native_submission_attempts SET status='verified' WHERE environment=? AND account_key=? AND id=? AND status IN ('pending','uncertain')",(environment,account,ident))
            if changed.rowcount!=1:
                # Tombstone a possibly delayed request that never reached the
                # ledger. It must not be dispatched after the user reconciles.
                other=db.execute('SELECT account_key FROM native_submission_attempts WHERE environment=? AND id=?',(environment,ident)).fetchone()
                if other:
                    raise ValueError('送出識別碼不屬於所選帳戶')
                db.execute('INSERT INTO native_submission_attempts VALUES(?,?,?,?,?,?,?,NULL)',
                    (environment,ident,account,'reconciled-before-dispatch','','verified',now().isoformat()))
