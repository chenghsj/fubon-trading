"""Atomic local simulation ledger. Never shares broker or sandbox account state."""
from contextlib import contextmanager
import json


def empty_book():
    return dict(schema=1, orders={}, positions=[])


class PaperStore:
    def __init__(self, research):
        self.research = research

    @contextmanager
    def transaction(self):
        with self.research.connect() as db:
            db.execute('CREATE TABLE IF NOT EXISTS paper_books (id INTEGER PRIMARY KEY CHECK(id=1), payload TEXT NOT NULL)')
            db.execute('CREATE TABLE IF NOT EXISTS paper_tags (tag TEXT PRIMARY KEY, order_id TEXT NOT NULL UNIQUE)')
            db.execute('BEGIN IMMEDIATE')
            row = db.execute('SELECT payload FROM paper_books WHERE id=1').fetchone()
            state = json.loads(row[0]) if row else empty_book()
            if state.get('schema') != 1 or not isinstance(state.get('orders'),dict) or not isinstance(state.get('positions'),list):
                raise ValueError('paper 帳本格式無法讀取，請保留資料並檢查本機資料庫')
            original = json.dumps(state,ensure_ascii=False,allow_nan=False)
            yield state
            payload = json.dumps(state,ensure_ascii=False,allow_nan=False)
            if payload == original:
                return
            # The book and unique strategy tags commit together with all fills/costs.
            for ident, trade in state['orders'].items():
                tag = trade.get('paper',{}).get('strategyTag')
                if tag:
                    prior = db.execute('SELECT order_id FROM paper_tags WHERE tag=?',(tag,)).fetchone()
                    if prior and prior[0] != ident:
                        raise ValueError('paper 策略識別碼已使用')
                    db.execute('INSERT OR IGNORE INTO paper_tags VALUES(?,?)',(tag,ident))
            db.execute('INSERT OR REPLACE INTO paper_books VALUES(1,?)',(payload,))

    def read(self):
        with self.research.connect() as db:
            db.execute('CREATE TABLE IF NOT EXISTS paper_books (id INTEGER PRIMARY KEY CHECK(id=1), payload TEXT NOT NULL)')
            row = db.execute('SELECT payload FROM paper_books WHERE id=1').fetchone()
            state = json.loads(row[0]) if row else empty_book()
            if state.get('schema') != 1 or not isinstance(state.get('orders'),dict) or not isinstance(state.get('positions'),list):
                raise ValueError('paper 帳本格式無法讀取，請保留資料並檢查本機資料庫')
            return state
