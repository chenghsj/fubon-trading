"""Integrated range midpoint tick checks through real signal build and fixed replay."""
from datetime import datetime
import math

import pytest

from fubon_bridge.direction_execution import outcome
from fubon_bridge.mapping import TAIPEI
from fubon_bridge.opportunity_research import State
from fubon_bridge.zone_entry import ZoneAction, build, zone_context


def tick_fixture(side):
    start = int(datetime(2026, 1, 2, 8, 45, tzinfo=TAIPEI).timestamp())
    bars = []
    for i in range(300):
        three = i // 3
        low = 40000 + (three // 2) % 10 if three % 2 == 0 else 40100
        bars.append(dict(time=start + (i + 1) * 60, month='202601',
            open=40100, high=40200 + three % 4, low=low, close=40100, volume=100))
    bars[90].update(open=40000, high=40006, low=39990, close=40002, volume=200)
    bars[91].update(open=40002, high=40006, low=40001, close=40003, volume=200)
    bars[92].update(open=40003, high=40006, low=40002, close=40005, volume=200)
    bars[93].update(open=40005, high=40110, low=40000, close=40105)
    if side < 0:
        bars = [b | dict(open=80200-b['open'], high=80200-b['low'],
            low=80200-b['high'], close=80200-b['close']) for b in bars]
    return dict(source='fubon-paper', product='TMF', strategySession='regular',
        futures=bars, stocks={}, start='2026-01-02', end='2026-01-02'), start


@pytest.mark.parametrize('side', [1, -1])
def test_fractional_quantile_midpoint_builds_tradable_target_and_exit(side):
    data, start = tick_fixture(side)
    stream = State(start, 'regular', '2026-01-02')
    for bar in data['futures'][:93]:
        prior_atr = stream.atr3.value
        stream.push(bar)
    raw_midpoint = zone_context(stream, prior_atr)['mid']
    assert not float(raw_midpoint).is_integer()
    events, _ = build(data, ['2026-01-02'])
    signals = [a for a in events['wick-zone'] if a.time == data['futures'][92]['time']
        and a.plan == 'range' and a.side == side]
    assert len(signals) == 1  # A real admitted signal, not just a rounding unit test.
    a = signals[0]
    assert isinstance(a, ZoneAction)
    assert float(a.target_level).is_integer()
    expected = math.floor(raw_midpoint) if side > 0 else math.ceil(raw_midpoint)
    assert a.target_level == expected
    assert side * (raw_midpoint - a.target_level) >= 0
    assert any(b.key == a.key for b in events['wick-volume'])
    trade = outcome(a)
    assert trade is not None and trade['reason'] == 'target'
    assert trade['exit'] == expected - side * 2
    assert float(trade['entry']).is_integer() and float(trade['exit']).is_integer()
