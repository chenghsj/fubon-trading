"""Per-checkout, non-secret watchlists survive broker/session restarts."""
import json
import os
from pathlib import Path
import tempfile


class WatchlistStore:
    def __init__(self, path=None):
        self.path = Path(path) if path is not None else None

    @staticmethod
    def validate(value):
        try:
            rows = value['lists']
            if value['version'] != 1 or not isinstance(rows, list):
                raise ValueError()
            lists = {}
            for row in rows:
                if not isinstance(row['id'], str) or not isinstance(row['name'], str) or not isinstance(row['contracts'], list):
                    raise ValueError()
                if not row['id'] or row['id'] in lists:
                    raise ValueError()
                for contract in row['contracts']:
                    if not isinstance(contract, dict) or not isinstance(contract.get('code'), str) or not contract['code'].strip():
                        raise ValueError()
                lists[row['id']] = row
            return lists
        except (ValueError, KeyError, TypeError):
            raise ValueError('自選清單設定無法讀取，請保留設定檔並修復；不會覆蓋為預設清單') from None

    def load(self):
        if self.path is None or not self.path.exists():
            return None
        try:
            return self.validate(json.loads(self.path.read_text()))
        except (OSError, ValueError):
            raise ValueError('自選清單設定無法讀取，請保留設定檔並修復；不會覆蓋為預設清單') from None

    def save(self, lists):
        value = dict(version=1, lists=list(lists.values()))
        self.validate(value)
        if self.path is None:
            return
        self.path.parent.mkdir(parents=True, exist_ok=True)
        fd, temporary = tempfile.mkstemp(prefix='.watchlists-', dir=self.path.parent)
        try:
            with os.fdopen(fd, 'w') as stream:
                json.dump(value, stream, ensure_ascii=False, allow_nan=False)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, self.path)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)
