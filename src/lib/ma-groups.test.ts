import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { deleteMAGroup, listMAGroups, saveMAGroup } from './ma-groups';
import { addMALines } from './ma-presets';

beforeEach(() => {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (key: string) => store.get(key) ?? null, setItem: vi.fn((key: string, value: string) => { store.set(key, value); }) });
});
afterEach(() => vi.unstubAllGlobals());
const lines = () => [{ period: 7, color: '#123456' }, { period: 21, color: '#abcdef' }];

it('saves arbitrary periods/colors across reload and edits the saved group independently of applied chart lines', async () => {
    const input = lines();
    const group = saveMAGroup({ name: '  我的組合  ', lines: input });
    input[0]!.period = 99;
    const applied = addMALines([], group.lines);
    expect(applied.map(i => [i.params.period, i.styles?.line?.color])).toEqual([[7, '#123456'], [21, '#abcdef']]);
    vi.resetModules();
    const reloaded = await import('./ma-groups');
    expect(reloaded.listMAGroups()).toEqual([{ ...group, name: '我的組合', lines: lines() }]);
    reloaded.saveMAGroup({ id: group.id, name: '改名組合', lines: [{ period: 30, color: '#778899' }] });
    expect(reloaded.listMAGroups()).toHaveLength(1);
    expect(applied.map(i => i.params.period)).toEqual([7, 21]);
    reloaded.deleteMAGroup(group.id);
    expect(reloaded.listMAGroups()).toEqual([]);
    expect(applied).toHaveLength(2);
});

it('rejects duplicate names, invalid periods and duplicate periods without changing saved data', () => {
    const group = saveMAGroup({ name: 'My MA', lines: lines() });
    expect(() => saveMAGroup({ name: 'my ma', lines: lines() })).toThrow(/相同名稱/);
    for (const period of [0, 501, 1.5, NaN]) expect(() => saveMAGroup({ name: 'Invalid', lines: [{ period, color: '#123456' }] })).toThrow(/1–500/);
    expect(() => saveMAGroup({ name: 'Invalid', lines: [lines()[0]!, lines()[0]!] })).toThrow(/重複週期/);
    expect(() => saveMAGroup({ name: 'Invalid', lines: [{ period: 5, color: 'red' }] })).toThrow(/顏色/);
    expect(() => saveMAGroup({ id: 'deleted', name: 'Gone', lines: lines() })).toThrow(/已刪除/);
    expect(listMAGroups()).toEqual([group]);
});

it('reports a failed local save and keeps the previously persisted groups', () => {
    const group = saveMAGroup({ name: '保留', lines: lines() });
    vi.mocked(localStorage.setItem).mockImplementation(() => { throw new Error('quota'); });
    expect(() => deleteMAGroup(group.id)).toThrow(/無法儲存/);
    expect(() => saveMAGroup({ name: '未儲存', lines: lines() })).toThrow(/無法儲存/);
    expect(listMAGroups()).toEqual([group]);
});

it('keeps a stable empty snapshot for corrupt or unavailable storage', () => {
    localStorage.setItem('fubon-ma-groups-v1', '{bad json');
    expect(listMAGroups()).toEqual([]);
    expect(listMAGroups()).toBe(listMAGroups());
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('blocked'); } });
    expect(listMAGroups()).toBe(listMAGroups());
});
