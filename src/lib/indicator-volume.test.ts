import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEF_BY_TYPE, loadInstances, newInstance, saveInstances } from './indicator-defs';
import { IndicatorInstanceService, initializeIndicatorPanels } from './indicator-instance-service';
import type { Workspace } from './workspace';

beforeEach(() => {
    const storage = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) });
});
afterEach(() => vi.unstubAllGlobals());

describe('volume is a managed pane indicator', () => {
    it('computes per-candle volume, including zero, as a pane histogram', () => {
        const def = DEF_BY_TYPE.get('volume')!;
        expect(def.category).toBe('pane');
        expect(def.outputs[0]).toMatchObject({ kind: 'histogram', colorByCandle: true });
        const bars = [10, 0, 25].map((volume, index) => ({ time: 1000 + index * 60, open: 10, high: 12, low: 8, close: 11, volume }));
        expect(def.compute(bars, {})).toEqual({ volume: [{ time: 1000, value: 10 }, { time: 1060, value: 0 }, { time: 1120, value: 25 }] });
    });
    it('migrates old global defaults once, puts volume before oscillators and leaves old storage intact', () => {
        const old = [newInstance('sma'), newInstance('macd')];
        localStorage.setItem('sj-pro-indicators-v2', JSON.stringify(old));
        const migrated = loadInstances();
        expect(migrated.map(instance => instance.type)).toEqual(['sma', 'volume', 'macd']);
        expect(migrated.filter(instance => instance.type !== 'volume')).toEqual(old);
        expect(JSON.parse(localStorage.getItem('sj-pro-indicators-v2')!)).toEqual(old);
        expect(loadInstances()).toEqual(migrated);
        saveInstances([]);
        expect(loadInstances()).toEqual([]);
    });
    it('preserves the old always-visible volume for an empty legacy panel but respects a new empty panel', () => {
        const workspace: Workspace = { blocks: [{ id: 'old', type: 'chart', pin: null, indicatorState: { revision: 'old', instances: [] } }], layout: [] };
        const migrated = initializeIndicatorPanels(workspace);
        expect(migrated.blocks[0]!.indicatorState).toMatchObject({ schemaVersion: 2, instances: [{ type: 'volume' }] });
        expect(initializeIndicatorPanels(migrated)).toBe(migrated);
        const empty = { ...migrated, blocks: migrated.blocks.map(block => ({ ...block, indicatorState: { ...block.indicatorState!, instances: [] } })) };
        expect(initializeIndicatorPanels(empty)).toBe(empty);
    });
    it('does not resurrect a removed volume during workspace initialization or reload', () => {
        let workspace = initializeIndicatorPanels({ blocks: [{ id: 'chart', type: 'chart', pin: null }], layout: [] });
        const service = new IndicatorInstanceService({ getWorkspace: () => workspace, updateWorkspace: next => { workspace = initializeIndicatorPanels(next); } });
        const state = service.snapshot('chart');
        expect(state.instances.map(instance => instance.type)).toEqual(['volume']);
        service.remove('chart', state.instances[0]!.id, state.revision);
        expect(service.snapshot('chart')).toMatchObject({ schemaVersion: 2, instances: [] });
        expect(initializeIndicatorPanels(structuredClone(workspace)).blocks[0]!.indicatorState!.instances).toEqual([]);
    });
    it('keeps existing volume settings without duplicates', () => {
        const volume = { ...newInstance('volume'), hidden: true, precision: 1 };
        localStorage.setItem('sj-pro-indicators-v2', JSON.stringify([volume]));
        expect(loadInstances()).toEqual([volume]);
    });
    it('lets a migrated full panel stay editable while rejecting further additions', () => {
        const instances = Array.from({ length: 100 }, () => newInstance('sma'));
        let workspace = initializeIndicatorPanels({ blocks: [{ id: 'chart', type: 'chart', pin: null,
            indicatorState: { revision: 'old-full', instances } }], layout: [] });
        const service = new IndicatorInstanceService({ getWorkspace: () => workspace, updateWorkspace: next => { workspace = next; } });
        const volume = service.snapshot('chart').instances.find(instance => instance.type === 'volume')!;
        expect(service.snapshot('chart').instances).toHaveLength(101);
        service.update('chart', volume.id, { hidden: true });
        expect(service.snapshot('chart').instances.find(instance => instance.id === volume.id)!.hidden).toBe(true);
        expect(() => service.mount('chart', 'sma')).toThrow(/100/);
    });
});
