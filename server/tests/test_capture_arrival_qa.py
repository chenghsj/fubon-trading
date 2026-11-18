"""Full synthetic native tape: late final-second prints cannot advance decisions."""
from collections import defaultdict
from datetime import datetime
import hashlib
import json
from types import SimpleNamespace

import numpy as np

from fubon_bridge import capture_models
from fubon_bridge.candle_patterns import shape
from fubon_bridge.capture_models import prepare, reconciled
from fubon_bridge.capture_replay import load_tape
from fubon_bridge.mapping import TAIPEI
from fubon_bridge.market_capture import CaptureStore, validate_frame


def test_late_minute_close_print_is_known_before_all_features_and_entry(tmp_path, monkeypatch):
    start = int(datetime(2026, 1, 2, 8, 45, tzinfo=TAIPEI).timestamp())
    close = start + 90 * 60
    group = dict(session='regular', day='2026-01-02', symbol='TMFA6', month='202601',
        startUs=start * 1_000_000, endUs=(start + 300 * 60) * 1_000_000,
        researchStartUs=(start + 89 * 60) * 1_000_000,
        researchEndUs=(start + 295 * 60 + 3) * 1_000_000)
    packets = []
    prices_by_minute = defaultdict(list)
    for second in range(300 * 60):
        event = (start + second) * 1_000_000 + 200_000
        received = event + 100_000
        price = 40_000 + (second // 60) % 3
        # No intervening trades: this is delayed delivery without an exchange
        # timestamp regression, so the real capture validator accepts it.
        if second not in (5400, 5401):
            if second == 5399:
                price += 50
                received += 2_000_000
            data = dict(symbol='TMFA6', time=event, serial=second,
                trades=[dict(price=price, size=1)])
            packets.append((received, event, 'trades', data))
            prices_by_minute[second // 60 + 1].append(price)
        book = dict(symbol='TMFA6', time=event,
            bids=[dict(price=40_051, size=2)], asks=[dict(price=40_053, size=2)])
        packets.append((event + 100_000, event, 'books', book))
    packets.sort(key=lambda p: p[0])
    previous = {}
    records = []
    for received, event, channel, data in packets:
        assert event >= previous.get(channel, 0)
        previous[channel] = event
        assert validate_frame(data, channel, group, received) == (event, [])
        raw = json.dumps(dict(event='data', channel=channel, data=data))
        sha = hashlib.sha256(json.dumps(data, sort_keys=True,
            separators=(',', ':'), ensure_ascii=False).encode()).hexdigest()
        records.append(('synthetic-arrival-qa', 1, received, received, event,
            'TMFA6', '202601', 'regular', '2026-01-02', group['startUs'], group['endUs'],
            channel, 'data', 0, data.get('serial'), 1, 0, '[]', sha, raw))
    bars = [dict(time=start + minute * 60, month='202601', open=values[0],
        high=max(values), low=min(values), close=values[-1], volume=len(values))
        for minute, values in sorted(prices_by_minute.items())]
    store = CaptureStore(tmp_path / 'capture.sqlite3')
    with store.connect() as db:
        db.executemany('''INSERT INTO capture_frames(run_id,epoch,received_us,monotonic_ns,
            event_us,symbol,month,session,opening_day,window_start_us,window_end_us,
            channel,event_type,is_trial,serial,valid,duplicate,issues,sha256,raw_json)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)''', records)
        group['maximumFrameId'] = db.execute('SELECT MAX(id) FROM capture_frames').fetchone()[0]
    folder = tmp_path / 'runs' / 'arrival-qa'
    folder.mkdir(parents=True)
    tape, metadata = load_tape(store.path, group, tmp_path / 'normalized')
    assert reconciled(group, bars, metadata)['passed']
    arrivals = {int(k): v for k, v in metadata['minuteAvailableUs'].items()}
    assert arrivals[close] == (close + 1) * 1_000_000 + 300_000
    assert arrivals[close] > (close + 1) * 1_000_000  # Old entry would precede arrival.
    assert tape.features(close, shape(bars, 89, start)[1]) is not None
    # Establish that this delayed print materially changes closed candle inputs.
    earlier = [dict(bar) for bar in bars]
    earlier[89].update(high=40_000 + 89 % 3, close=40_000 + 89 % 3)
    assert shape(bars, 89, start)[0] != shape(earlier, 89, start)[0]
    # No real model fitting or SDK access: only the historical auxiliary prediction
    # is stubbed. Native tape, signal build, shapes, features and replay are real.
    monkeypatch.setattr(capture_models.lgb, 'Booster', lambda **kwargs:
        SimpleNamespace(predict=lambda x, **kw: np.zeros(len(x))))
    data = dict(source='fubon-paper', product='TMF', strategySession='regular',
        futures=bars, stocks={}, start='2026-01-02', end='2026-01-02')
    rows, _, diagnostics = prepare(store.path, data, [group], folder, {'text': 'synthetic aux stub'})
    assert diagnostics[group['day']]['reconciliation']['passed']
    selected = [r for source in rows.values() for r in source
        if r['action'].bars[r['action'].index]['time'] == close]
    assert selected  # Guard against a vacuous causality test with no signals.
    filled = []
    for row in selected:
        action = row['action']
        assert row['time'] == action.time == close + 5
        assert arrivals[close] <= action.time * 1_000_000
        assert row['micro'][71:] == tape.features(action.time, shape(bars, 89, start)[1])
        assert len(row['coarse']) == 71 and len(row['micro']) == 95
        if row['labels']['normal']['status'] == 'filled':
            trade = row['labels']['normal']
            assert trade['entryTime'] == close + 6
            assert trade['entryTime'] * 1_000_000 > arrivals[close]
            # Publication allowance must not extend the original holding horizon.
            assert trade['exitTime'] <= action.bars[action.end]['time'] + 3
            filled.append(trade)
    assert filled  # Check an admitted entry, not merely a rejected intent.
