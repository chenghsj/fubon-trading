import { expect, it } from 'vitest';
import { newInstance } from './indicator-defs';
import { indicatorPeers, moveIndicatorInCategory, reorderIndicatorCategory } from './indicator-order';

it('moves a sub-pane past interleaved overlays in one action without changing the overlay order', () => {
    const ma = newInstance('sma'), volume = newInstance('volume'), ema = newInstance('ema'), macd = newInstance('macd');
    const original = [ma, volume, ema, macd];
    const moved = moveIndicatorInCategory(original, volume.id, 1);
    expect(moved).toEqual([ma, macd, ema, volume]);
    expect(indicatorPeers(moved, volume.id)).toEqual([macd, volume]);
    expect(indicatorPeers(moved, ma.id)).toEqual([ma, ema]);
    expect(moveIndicatorInCategory(moved, volume.id, -1)).toEqual(original);
    expect(original).toEqual([ma, volume, ema, macd]);
});

it('drags across several peers while preserving interleaved members of the other category', () => {
    const ma = newInstance('sma'), volume = newInstance('volume'), ema = newInstance('ema'), macd = newInstance('macd'), rsi = newInstance('rsi');
    const original = [ma, volume, ema, macd, rsi];
    expect(reorderIndicatorCategory(original, volume.id, [macd.id, rsi.id, volume.id])).toEqual([ma, macd, ema, rsi, volume]);
    for (const invalid of [[volume.id, volume.id, rsi.id], [volume.id, macd.id], [ma.id, macd.id, rsi.id], [volume.id, macd.id, 'removed']]) {
        expect(reorderIndicatorCategory(original, volume.id, invalid)).toBe(original);
    }
    expect(reorderIndicatorCategory(original, volume.id, [volume.id, macd.id, rsi.id])).toBe(original);
    expect(reorderIndicatorCategory(original, 'removed', [volume.id, macd.id, rsi.id])).toBe(original);
});

it('keeps the first and last of each category at their own boundary', () => {
    const ma = newInstance('sma'), volume = newInstance('volume'), macd = newInstance('macd');
    const original = [ma, volume, macd];
    expect(moveIndicatorInCategory(original, ma.id, 1)).toBe(original);
    expect(moveIndicatorInCategory(original, volume.id, -1)).toBe(original);
    expect(moveIndicatorInCategory(original, macd.id, 1)).toBe(original);
    expect(moveIndicatorInCategory(original, 'missing', 1)).toBe(original);
});
