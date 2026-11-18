"""Filtered negative control retains an auditable, exact full-parent reference."""
from fubon_bridge.candle_patterns import boundary
from fubon_bridge.direction_execution import build as parent_build, compare, rule_scores
from fubon_bridge.research import digest
from fubon_bridge.zone_entry import build


def full_day(day, flat_zone):
    start = boundary(day) + 8 * 3600 + 45 * 60
    bars = []
    for i in range(300):
        if flat_zone:
            opening = close = 40100
            high, low = (40400, 39800) if i < 27 else (40100, 40100)
            if i == 89:
                close, high = 40130, 40132
        else:
            opening, close = 40000 + (i - 1) % 3, 40000 + i % 3
            high, low = max(opening, close) + 15, min(opening, close) - 15
            if i == 89:
                opening, high, low, close = 40001, 40043, 39985, 40042
            if i in (90, 91, 92):
                opening, high, low, close = 40042, 40044, 40014, 40023
                if i == 92:
                    opening = 40022
        bars.append(dict(time=start + (i + 1) * 60, month='202601', open=opening,
            high=high, low=low, close=close, volume=100 + i % 17))
    return bars


def test_filtered_confirmed_records_excluded_parent_and_replays_common_trades_exactly():
    dates = ['2026-01-02', '2026-01-05']
    data = dict(source='fubon-paper', product='TMF', strategySession='regular', stocks={},
        futures=full_day(dates[0], True) + full_day(dates[1], False), start=dates[0], end=dates[-1])
    parent, _ = parent_build(data, dates)
    original = parent['confirmed-fixed']
    events, quality = build(data, dates)
    retained = events['confirmed']
    assert original and retained  # Exercise real retained trades as well as an exclusion.
    keys = {a.key for a in retained}
    common = [a for a in original if a.key in keys]
    excluded = [a for a in original if a.key not in keys]
    assert len(excluded) == 1 and excluded[0].day == dates[0]
    control = quality['parentControl']
    assert control['parentEvents'] == len(original)
    assert control['excludedParentEvents'] == 1
    assert control['excludedParentKeys'] == [a.key for a in excluded]
    assert control['commonReplayMatched']
    expected = compare(common, rule_scores(common), dates, 'hybrid')
    actual = compare(retained, rule_scores(retained), dates, 'hybrid')
    assert actual == expected  # Includes all native trade records in all three scenarios.
    assert all(r['trades'] for r in actual.values())
    full = compare(original, rule_scores(original), dates, 'hybrid')
    for scenario, result in full.items():
        reference = {k: v for k, v in result.items() if k != 'trades'}
        reference['tradeHash'] = digest(result['trades'])
        assert control['fullParentRule'][scenario] == reference
