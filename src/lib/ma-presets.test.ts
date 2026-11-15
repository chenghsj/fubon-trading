import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { outputStyle, DEF_BY_TYPE, type IndicatorInstance } from './indicator-defs';
import { addMAPresets, MA_PRESET_GROUP, MA_PRESETS } from './ma-presets';
import { IndicatorInstanceService, initializeIndicatorPanels } from './indicator-instance-service';

beforeEach(() => {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => { store.set(key, value); },
    });
});
afterEach(() => vi.unstubAllGlobals());

it('adds the selected periods as distinct visible simple moving averages despite saved type defaults', () => {
    const defaults = JSON.stringify({ sma: { params: { period: 99 }, styles: { line: { color: '#000000', visible: false, opacity: 0 } } } });
    localStorage.setItem('sj-pro-ind-defaults-v1', defaults);
    const lines = addMAPresets([], MA_PRESETS.map(p => p.period));
    expect(lines.map(i => [i.type, i.params.period])).toEqual([
        ['sma', 5], ['sma', 10], ['sma', 20], ['sma', 60], ['sma', 120], ['sma', 240],
    ]);
    expect(new Set(lines.map(i => i.id)).size).toBe(6);
    const styles = lines.map(i => outputStyle(i, DEF_BY_TYPE.get('sma')!, 'line'));
    expect(new Set(styles.map(s => s.color)).size).toBe(6);
    for (const style of styles) expect(style).toMatchObject({ visible: true, opacity: 100, plot: 'line' });
    expect(localStorage.getItem('sj-pro-ind-defaults-v1')).toBe(defaults);
});

it('fills only missing periods without changing existing MA settings or confusing EMA with MA', () => {
    const current: IndicatorInstance[] = [
        { id: 'existing-ma', type: 'sma', params: { period: 5 }, colors: {}, hidden: true, styles: { line: { color: '#123456' } } },
        { id: 'existing-ema', type: 'ema', params: { period: 10 }, colors: {} },
    ];
    const original = structuredClone(current);
    const next = addMAPresets(current, [...MA_PRESET_GROUP, 10]);
    expect(next.slice(0, 2)).toEqual(original);
    expect(next.slice(2).map(i => i.params.period)).toEqual([10, 20, 60]);
    expect(current).toEqual(original);
    expect(addMAPresets(next, MA_PRESET_GROUP)).toBe(next);
});

it('persists a group atomically on one chart and preserves other charts and global defaults', () => {
    let workspace = initializeIndicatorPanels({ blocks: [
        { id: 'a', type: 'chart', pin: null }, { id: 'b', type: 'chart', pin: null },
    ], layout: [] });
    const service = new IndicatorInstanceService({ getWorkspace: () => workspace, updateWorkspace: next => { workspace = next; } });
    const state = service.snapshot('a');
    service.replace('a', addMAPresets(state.instances, MA_PRESET_GROUP), state.revision);
    expect(service.snapshot('a').instances.map(i => i.params.period)).toEqual([5, 10, 20, 60]);
    expect(service.snapshot('b').instances).toEqual([]);
    expect(localStorage.getItem('sj-pro-indicators-v2')).toBeNull();
    const full = Array.from({ length: 99 }, (_, index) => ({ id: `ma-${index}`, type: 'sma', params: { period: 1 }, colors: {} }));
    service.replace('b', full, service.snapshot('b').revision);
    const before = structuredClone(service.snapshot('b'));
    expect(() => service.replace('b', addMAPresets(full, MA_PRESET_GROUP), before.revision)).toThrow(/100/);
    expect(service.snapshot('b')).toEqual(before);
});
