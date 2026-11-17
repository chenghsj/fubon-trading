import { StrictMode, createElement, useCallback, useEffect, useRef, useState } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { calcGridItemPosition, GridItem, GridLayout, type LayoutItem } from 'react-grid-layout';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { normalizeGridLayout, sameGridGeometry, storeGridLayout } from './workspace-grid';
import * as gridGeometry from './workspace-grid';
import { gridDensity } from './workspace-grid';
import { toRenderGeom, type Workspace } from './workspace';
import { useWorkspaceGrid } from '../hooks/use-workspace-grid';
import appSource from '../App.tsx?raw';
import ts from 'typescript';

const initial: LayoutItem[] = [
    { i: 'a', x: 0, y: 0, w: 72, h: 8 },
    { i: 'b', x: 72, y: 0, w: 216, h: 8 },
];
const node = {
    addEventListener() {}, removeEventListener() {},
    ownerDocument: { addEventListener() {}, removeEventListener() {}, body: {}, defaultView: {} },
};
let view: ReactTestRenderer | undefined;

beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('window', { requestAnimationFrame: () => 1, cancelAnimationFrame() {} });
});
afterEach(async () => {
    await act(async () => view?.unmount());
    view = undefined;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

function createHarness(options: { width?: number; layout?: LayoutItem[]; preciseGrid?: boolean; scrollHost?: HTMLElement } = {}) {
    const geometryCheck = vi.spyOn(gridGeometry, 'sameGridGeometry');
    const stats = {
        writes: 0, mounts: 0, unmounts: 0,
        get rejected() { return geometryCheck.mock.results.filter(result => result.type === 'return' && result.value === false).length; },
    };
    const api = {
        width: (_width: number) => {},
        bounce: (_width: number, _returnWidth: number) => {},
        replace: (_layout: LayoutItem[], _ids?: string[]) => {},
        updateLayout: (_layout: LayoutItem[]) => {},
        metadata: () => {},
        stored: initial as LayoutItem[],
        blocks: [] as Workspace['blocks'],
        ruler: undefined as ReturnType<typeof useWorkspaceGrid>['rulerProps'] | undefined,
        preciseGrid: undefined as boolean | undefined,
    };
    function Panel() {
        useEffect(() => { stats.mounts++; return () => { stats.unmounts++; }; }, []);
        return createElement('span', null, 'public panel');
    }
    function Harness() {
        const [width, setWidth] = useState(options.width ?? 1910);
        const [workspace, setWorkspace] = useState<Workspace>(() => ({
            blocks: (options.layout ?? initial).map(item => ({ id: item.i, type: 'watchlist', pin: null })),
            layout: options.layout ?? initial,
            ...(options.preciseGrid ? { preciseGrid: true } : {}),
        }));
        const pendingBounce = useRef<number | undefined>(undefined);
        const latest = useRef(workspace);
        const scrollRef = useRef(options.scrollHost ?? null);
        latest.current = workspace;
        api.stored = workspace.layout;
        api.preciseGrid = workspace.preciseGrid;
        api.blocks = workspace.blocks;
        api.width = setWidth;
        api.bounce = (next, back) => { pendingBounce.current = back; setWidth(next); };
        api.replace = (next, nextIds = next.map(item => item.i)) => {
            const current = latest.current;
            const replacement: Workspace = {
                ...current, layout: next,
                blocks: nextIds.map(id => current.blocks.find(block => block.id === id) ?? { id, type: 'watchlist', pin: null }),
            };
            latest.current = replacement;
            setWorkspace(replacement);
        };
        api.metadata = () => setWorkspace(current => ({ ...current, blocks: current.blocks.map(block => ({ ...block, pin: '2330' })) }));
        api.updateLayout = layout => {
            const next = { ...latest.current, layout };
            latest.current = next;
            setWorkspace(next);
        };
        const updateWorkspace = useCallback((next: Workspace) => {
            // A finite cap turns a feedback loop into a failed exact write count instead of a hang.
            if (stats.writes >= 20) return;
            stats.writes++;
            latest.current = next;
            setWorkspace(next);
        }, []);
        const { renderLayout, renderCols, renderWidth, gridProps, rulerProps } = useWorkspaceGrid({ workspace, workspaceRef: latest, width, updateWorkspace, scrollRef });
        api.ruler = rulerProps;
        useEffect(() => {
            if (pendingBounce.current === undefined) return;
            const back = pendingBounce.current;
            pendingBounce.current = undefined;
            setWidth(back);
        }, [width]);
        return createElement(GridLayout, {
            width: renderWidth, layout: renderLayout,
            gridConfig: { cols: renderCols, rowHeight: 30, margin: [6, 6], containerPadding: [6, 6] },
            ...gridProps,
            children: workspace.blocks.map(({ id }) => createElement('div', { key: id }, createElement(Panel))),
        });
    }
    return { stats, api, element: createElement(StrictMode, null, createElement(Harness)) };
}

async function mountHarness(options?: Parameters<typeof createHarness>[0]) {
    const harness = createHarness(options);
    await act(async () => { view = create(harness.element, { createNodeMock: () => node }); });
    return harness;
}

describe('RGL controlled-layout passive-effect feedback', () => {
    it.each([[1910, 640], [640, 1910]])('rapid %i → %i → first width settles without rewriting stale density', async (first, middle) => {
        const { stats, api } = await mountHarness({ width: first });
        const mounts = stats.mounts;
        const unmounts = stats.unmounts;
        await act(async () => api.bounce(middle, first));
        expect(stats.writes).toBe(0);
        // RGL really replays the middle width's density; the geometry guard rejects it.
        expect(stats.rejected).toBeGreaterThanOrEqual(1);
        expect(api.stored).toEqual(initial);
        expect(stats.mounts).toBe(mounts);
        expect(stats.unmounts).toBe(unmounts);
    });

    it('same-density minW updates and metadata-only rerenders do not rewrite or remount panels', async () => {
        const { stats, api } = await mountHarness({ width: 1801 });
        const before = { ...stats };
        for (const width of [2799, 1910, 1801, 2500]) await act(async () => api.width(width));
        for (let index = 0; index < 4; index++) await act(async () => api.metadata());
        expect(stats.writes).toBe(before.writes);
        expect(stats.mounts).toBe(before.mounts);
        expect(stats.unmounts).toBe(before.unmounts);
        expect(api.stored).toEqual(initial);
    });

    it('mount acknowledges real bounds and vertical compaction without changing frozen inputs', async () => {
        const layout = [{ i: 'a', x: -12, y: 10, w: 400, h: 4 }];
        const original = structuredClone(layout);
        Object.freeze(layout[0]);
        Object.freeze(layout);
        const { stats, api } = await mountHarness({ layout });
        expect(stats.writes).toBe(1);
        expect(api.stored[0]).toMatchObject({ x: 0, y: 0, w: 288, h: 4 });
        expect(layout).toEqual(original);
    });

    it('add/remove/profile/reset replacements settle and match actual child keys', async () => {
        const { stats, api } = await mountHarness();
        expect(stats.writes).toBe(0);
        await act(async () => api.replace([...api.stored, { i: 'c', x: 0, y: Infinity, w: 72, h: 4 }]));
        expect(api.stored.find(item => item.i === 'c')?.y).toBe(8);
        expect(stats.writes).toBe(1);
        await act(async () => api.replace(api.stored, ['a', 'c']));
        expect(api.stored.map(item => item.i)).toEqual(['a', 'c']);
        expect(stats.writes).toBe(2);
        await act(async () => api.replace([{ i: 'profile', x: 0, y: 30, w: 288, h: 4 }]));
        expect(api.stored).toMatchObject([{ i: 'profile', y: 0, w: 288 }]);
        expect(stats.writes).toBe(3);
        await act(async () => api.replace(initial));
        expect(api.stored).toEqual(initial);
        expect(stats.writes).toBe(3);
    });

    it('missing child layout receives the same default row as RGL and orphan rows disappear', async () => {
        const { stats, api } = await mountHarness();
        await act(async () => api.replace(initial, ['b', 'new']));
        expect(api.stored.map(item => item.i)).toEqual(['b', 'new']);
        expect(api.stored.find(item => item.i === 'new')).toMatchObject({ x: 0, y: 0, w: 6, h: 1 });
        expect(stats.writes).toBe(1);
    });
});

describe('workspace ruler gesture lifecycle', () => {
    it('previews and saves a clustered junction as one gesture, and cancels atomically', async () => {
        const layout: LayoutItem[] = [
            { i: 'watch', x: 0, y: 0, w: 57, h: 25 },
            { i: 'chart', x: 57, y: 0, w: 164, h: 11 },
            { i: 'dock', x: 57, y: 11, w: 166, h: 9 },
            { i: 'right', x: 224, y: 0, w: 64, h: 25 },
        ];
        const { api, stats } = await mountHarness({ width: 1666, layout, preciseGrid: true });
        await act(async () => api.ruler!.onPrecisionChange('finest'));
        await act(async () => { expect(api.ruler!.onStart('x', 55.625)).toBe(true); });
        expect(api.ruler!.active!.positions).toEqual([55.25, 55.75, 56]);
        await act(async () => api.ruler!.onMove(3));
        expect(stats.writes).toBe(0);
        await act(async () => api.ruler!.onStop(true));
        expect(api.stored).toEqual(layout);
        await act(async () => { api.ruler!.onStart('x', 55.625); api.ruler!.onMove(3); api.ruler!.onStop(); });
        expect(stats.writes).toBe(1);
        expect(api.stored).toMatchObject([{ w: 57 }, { w: 176 }, { w: 178 }, { x: 236, w: 52 }]);
    });
    it.each([[1280, 3], [1910, 2], [3000, 1], [4200, 1]])('fine ruler at width %i saves a real smaller column step of %i canonical units', async (width, units) => {
        const { api, stats } = await mountHarness({ width });
        await act(async () => api.ruler!.onPrecisionChange('finest'));
        expect(stats.writes).toBe(0);
        expect(api.ruler!.cols).toBe(72);
        await act(async () => {
            expect(api.ruler!.onStart('x', 18)).toBe(true);
            api.ruler!.onMove(api.ruler!.steps.x);
            api.ruler!.onStop();
        });
        expect(stats.writes).toBe(1);
        expect(api.stored).toMatchObject([{ w: 72 + units }, { x: 72 + units, w: 216 - units }]);
        expect(api.preciseGrid).toBe(true);
        const stored = structuredClone(api.stored);
        const geometry = view!.root.findByType(GridLayout).props.layout;
        await act(async () => api.ruler!.onPrecisionChange('standard'));
        expect(sameGridGeometry(view!.root.findByType(GridLayout).props.layout, geometry)).toBe(true);
        for (const next of [320, 1280, 1910, 3000, 4200]) await act(async () => api.width(next));
        expect(api.stored).toEqual(stored);
        expect(stats.writes).toBe(1);
        await act(async () => view!.unmount());
        view = undefined;
        const reloaded = await mountHarness({ width, layout: stored, preciseGrid: true });
        expect(reloaded.api.stored).toEqual(stored);
        expect(reloaded.stats.writes).toBe(0);
        expect(sameGridGeometry(view!.root.findByType(GridLayout).props.layout, geometry)).toBe(true);
    });
    it('quarter-row edits survive standard mode, viewport changes and reload', async () => {
        const rows = [initial[0]!, { ...initial[0]!, i: 'c', y: 8 }];
        const { api, stats } = await mountHarness({ width: 1280, layout: rows });
        await act(async () => api.ruler!.onPrecisionChange('finest'));
        await act(async () => {
            expect(api.ruler!.onStart('y', 8)).toBe(true);
            api.ruler!.onMove(api.ruler!.steps.y);
            api.ruler!.onStop();
        });
        expect(api.stored).toMatchObject([{ h: 8.25 }, { y: 8.25, h: 7.75 }]);
        expect(stats.writes).toBe(1);
        const stored = structuredClone(api.stored);
        await act(async () => api.ruler!.onPrecisionChange('standard'));
        await act(async () => api.width(1910));
        expect(api.stored).toEqual(stored);
        expect(stats.writes).toBe(1);
        await act(async () => view!.unmount());
        view = undefined;
        const reloaded = await mountHarness({ width: 1910, layout: stored, preciseGrid: true });
        expect(reloaded.api.stored).toEqual(stored);
        expect(reloaded.stats.writes).toBe(0);
    });
    it('does not change precision or save settings during an active ruler drag', async () => {
        const { api } = await mountHarness();
        await act(async () => { api.ruler!.onStart('x', 12); });
        await act(async () => api.ruler!.onPrecisionChange('finest'));
        expect(api.ruler!.precision).toBe('standard');
        await act(async () => api.ruler!.onStop(true));
    });
    it('previews both sides, writes once on release, and keeps newer panel settings', async () => {
        const { api, stats } = await mountHarness();
        const mounts = stats.mounts;
        await act(async () => { expect(api.ruler!.onStart('x', 12)).toBe(true); });
        await act(async () => api.ruler!.onMove(3));
        expect(stats.writes).toBe(0);
        expect(api.stored).toEqual(initial);
        expect(view!.root.findByType(GridLayout).props.layout).toMatchObject([{ w: 15 }, { x: 15, w: 33 }]);
        await act(async () => api.metadata());
        await act(async () => api.ruler!.onStop());
        expect(stats.writes).toBe(1);
        expect(api.stored).toMatchObject([{ x: 0, w: 90 }, { x: 90, w: 198 }]);
        expect(api.blocks.every(block => block.pin === '2330')).toBe(true);
        expect(stats.mounts).toBe(mounts);
    });
    it('cancel restores the preview without saving', async () => {
        const { api, stats } = await mountHarness();
        await act(async () => { api.ruler!.onStart('x', 12); });
        await act(async () => api.ruler!.onMove(3));
        await act(async () => api.ruler!.onStop(true));
        expect(stats.writes).toBe(0);
        expect(api.stored).toEqual(initial);
        expect(view!.root.findByType(GridLayout).props.layout).toMatchObject([{ w: 12 }, { x: 12, w: 36 }]);
    });
    it('locks density through a viewport change and supports a synchronous keyboard step', async () => {
        const { api, stats } = await mountHarness();
        await act(async () => { api.ruler!.onStart('x', 12); });
        await act(async () => api.width(1500));
        expect(api.ruler!.cols).toBe(48);
        await act(async () => api.ruler!.onMove(2));
        await act(async () => api.ruler!.onStop());
        expect(api.stored).toMatchObject([{ w: 84 }, { x: 84, w: 204 }]);
        expect(api.ruler!.cols).toBe(24);
        await act(async () => {
            expect(api.ruler!.onStart('x', 7)).toBe(true);
            api.ruler!.onMove(1);
            api.ruler!.onStop();
        });
        expect(stats.writes).toBe(2);
        expect(api.stored).toMatchObject([{ w: 96 }, { x: 96, w: 192 }]);
    });
    it('a replaced layout revokes the gesture and narrow displays cannot start one', async () => {
        const { api, stats } = await mountHarness();
        await act(async () => { api.ruler!.onStart('x', 12); });
        const replacement = initial.map(item => ({ ...item, h: 10 }));
        await act(async () => api.replace(replacement));
        await act(async () => { api.ruler!.onMove(3); api.ruler!.onStop(); });
        expect(api.stored).toEqual(replacement);
        expect(stats.writes).toBe(0);
        await act(async () => api.width(390));
        await act(async () => { expect(api.ruler!.onStart('x', 6)).toBe(false); });
    });
});

describe('gesture coordinate epoch', () => {
    const item = (id = 'a') => view!.root.findAllByType(GridItem).find(row => row.props.i === id)!;
    const grid = () => view!.root.findByType(GridLayout).props;
    const draggable = () => item().find(row => typeof row.props.onStart === 'function' && typeof row.props.onStop === 'function');
    const resizable = () => item().find(row => typeof row.props.onResizeStart === 'function' && !!row.props.draggableOpts);
    const position = (w: number, h: number) => {
        const { margin, containerPadding, containerWidth, cols, rowHeight, maxRows } = item().props;
        return calcGridItemPosition({ margin, containerPadding, containerWidth, cols, rowHeight, maxRows }, 0, 0, w, h);
    };
    const physicalNode = { ...node, offsetParent: { scrollLeft: 0, scrollTop: 0, getBoundingClientRect: () => ({ left: 0, top: 0 }) },
        getBoundingClientRect: () => ({ left: 6, top: 6 }) };

    it('physical panel resize reaches a fractional neighbor without pushing it down', async () => {
        const layout = [{ i: 'a', x: 0, y: 0, w: 152, h: 8 }, { i: 'b', x: 153, y: 0, w: 135, h: 8 }];
        const { api, stats } = await mountHarness({ width: 1666, layout, preciseGrid: true });
        await act(async () => api.ruler!.onPrecisionChange('finest'));
        const event = (clientX: number) => ({ nativeEvent: { clientX, clientY: 0,
            target: { closest: () => ({ className: 'react-resizable-handle react-resizable-handle-e' }) } } });
        await act(async () => resizable().props.onResizeStart(event(0), { node: physicalNode, size: position(38, 8), handle: 'e' }));
        await act(async () => resizable().props.onResize(event(23), { node: physicalNode, size: position(39, 8), handle: 'e' }));
        expect(item('b').props).toMatchObject({ x: 38.25, y: 0 });
        expect(item().props.w).toBe(38.25);
        expect(stats.writes).toBe(0);
        await act(async () => resizable().props.onResizeStop(event(23), { node: physicalNode, size: position(39, 8), handle: 'e' }));
        expect(api.stored).toMatchObject([{ w: 153, h: 8 }, { x: 153, y: 0, w: 135 }]);
        expect(stats.writes).toBe(1);
    });

    it.each(['s', 'se'] as const)('physical %s resize grows downward and moves only the cards below it', async handle => {
        const layout = [
            { i: 'a', x: 0, y: 0, w: 144, h: 8.25 },
            { i: 'b', x: 144, y: 0, w: 144, h: 20 },
            { i: 'c', x: 0, y: 8.25, w: 144, h: 4 },
            { i: 'd', x: 0, y: 12.25, w: 144, h: 4 },
        ];
        const { api, stats } = await mountHarness({ width: 1666, layout, preciseGrid: true });
        await act(async () => api.ruler!.onPrecisionChange('finest'));
        const event = (clientY: number) => ({ nativeEvent: { clientX: 100, clientY,
            target: { closest: () => ({ className: `react-resizable-handle react-resizable-handle-${handle}` }) } } });
        const before = position(36, 8.25);
        const after = position(36, 10.5);
        await act(async () => resizable().props.onResizeStart(event(100), { node: physicalNode, size: before, handle }));
        await act(async () => resizable().props.onResize(event(181), { node: physicalNode, size: after, handle }));
        expect(item().props.h).toBe(10.5);
        expect(item('b').props).toMatchObject({ x: 36, y: 0, w: 36, h: 20 });
        expect(item('c').props.y).toBe(10.5);
        expect(item('d').props.y).toBe(14.5);
        expect(stats.writes).toBe(0);
        await act(async () => resizable().props.onResizeStop(event(181), { node: physicalNode, size: after, handle }));
        expect(api.stored).toMatchObject([{ w: 144, h: 10.5 }, { x: 144, y: 0, h: 20 }, { y: 10.5 }, { y: 14.5 }]);
        expect(stats.writes).toBe(1);
    });

    it('includes workspace scrolling in the native resize and restores scroll anchoring on release', async () => {
        const style = new Map([['overflow-anchor', 'auto']]);
        const listeners = new Map<string, EventListener>();
        const viewport = {
            requestAnimationFrame: () => 1, cancelAnimationFrame: vi.fn(),
            addEventListener: (type: string, listener: EventListener) => listeners.set(type, listener),
            removeEventListener: (type: string) => listeners.delete(type),
        };
        vi.stubGlobal('window', viewport);
        const host = { scrollTop: 100, style: {
            getPropertyValue: (key: string) => style.get(key), getPropertyPriority: () => '',
            setProperty: (key: string, value: string) => style.set(key, value), removeProperty: (key: string) => style.delete(key),
        }, ownerDocument: { defaultView: viewport, addEventListener() {}, removeEventListener() {} } };
        const { api, stats } = await mountHarness({ width: 1666, preciseGrid: true, scrollHost: host as unknown as HTMLElement,
            layout: [{ i: 'a', x: 0, y: 0, w: 147, h: 8.25 }] });
        await act(async () => api.ruler!.onPrecisionChange('finest'));
        const event = { nativeEvent: { clientX: 100, clientY: 600, preventDefault: vi.fn(),
            target: { closest: () => ({ className: 'react-resizable-handle react-resizable-handle-s' }) } } };
        const start = position(36.75, 8.25);
        await act(async () => resizable().props.onResizeStart(event, { node: physicalNode, size: start, handle: 's' }));
        expect(style.get('overflow-anchor')).toBe('none');
        expect(event.nativeEvent.preventDefault).toHaveBeenCalledOnce();
        host.scrollTop += 108;
        await act(async () => resizable().props.onResize(event, { node: physicalNode, size: start, handle: 's' }));
        expect(item().props).toMatchObject({ w: 36.75, h: 11.25 });
        expect(stats.writes).toBe(0);
        await act(async () => resizable().props.onResizeStop(event, { node: physicalNode, size: start, handle: 's' }));
        expect(api.stored[0]).toMatchObject({ w: 147, h: 11.25 });
        expect(stats.writes).toBe(1);
        expect(style.get('overflow-anchor')).toBe('auto');
        expect(listeners.size).toBe(0);
        expect(viewport.cancelAnimationFrame).toHaveBeenCalled();
    });

    it('tracks native moves when RGL omits the nativeEvent in its resize callback', async () => {
        const listeners = new Map<string, (event: Event) => void>();
        vi.stubGlobal('window', { requestAnimationFrame: () => 1, cancelAnimationFrame() {},
            addEventListener: (type: string, listener: (event: Event) => void) => listeners.set(type, listener),
            removeEventListener: (type: string) => listeners.delete(type) });
        const { api } = await mountHarness({ width: 1666, preciseGrid: true,
            layout: [{ i: 'a', x: 0, y: 0, w: 152, h: 8 }, { i: 'b', x: 153, y: 0, w: 135, h: 8 }] });
        await act(async () => api.ruler!.onPrecisionChange('finest'));
        const event = { nativeEvent: { clientX: 100, clientY: 100,
            target: { closest: () => ({ className: 'react-resizable-handle react-resizable-handle-e' }) } } };
        await act(async () => resizable().props.onResizeStart(event, { node: physicalNode, size: position(38, 8), handle: 'e' }));
        expect(listeners.has('mousemove')).toBe(true);
        await act(async () => {
            listeners.get('mousemove')!({ clientX: 123, clientY: 100 } as MouseEvent);
            // react-resizable delivers a native event, without a nativeEvent property.
            resizable().props.onResize({}, { node: physicalNode, size: position(39, 8), handle: 'e' });
        });
        expect(item().props.w).toBe(38.25);
        expect(item('b').props.y).toBe(0);
        await act(async () => resizable().props.onResizeStop({}, { node: physicalNode, size: position(39, 8), handle: 'e' }));
        expect(api.stored[0]!.w).toBe(153);
        expect(listeners.has('mousemove')).toBe(false);
        expect(listeners.has('touchmove')).toBe(false);
    });

    it('recovers the native touchstart RGL omits before a precise bottom resize', async () => {
        const { api } = await mountHarness({ width: 1666, preciseGrid: true,
            layout: [{ i: 'a', x: 0, y: 0, w: 147, h: 8.25 }] });
        await act(async () => api.ruler!.onPrecisionChange('finest'));
        const listeners = new Map<string, (event: Event) => void>();
        grid().innerRef({
            addEventListener: (type: string, listener: (event: Event) => void) => listeners.set(type, listener),
            removeEventListener: (type: string) => listeners.delete(type),
        });
        const handle = { ...physicalNode, className: 'react-resizable-handle react-resizable-handle-s' };
        const event = (clientY: number) => ({ touches: [{ clientX: 100, clientY }], changedTouches: [],
            target: { closest: () => handle }, preventDefault: vi.fn() });
        const start = event(600);
        listeners.get('touchstart')!(start as unknown as TouchEvent);
        await act(async () => resizable().props.onResizeStart({}, { node: handle, size: position(36.75, 8.25), handle: 's' }));
        expect(start.preventDefault).toHaveBeenCalledOnce();
        await act(async () => resizable().props.onResize({ nativeEvent: event(609) }, { node: handle, size: position(36.75, 8.5), handle: 's' }));
        expect(item().props).toMatchObject({ w: 36.75, h: 8.5 });
        await act(async () => resizable().props.onResizeStop({}, { node: handle, size: position(36.75, 8.5), handle: 's' }));
        expect(api.stored[0]).toMatchObject({ w: 147, h: 8.5 });
        grid().innerRef(null);
        expect(listeners.size).toBe(0);
    });

    it.each(['e', 's', 'se'] as const)('physical %s resize uses fine pointer deltas and preserves the stationary fractional axis', async handle => {
        const { api, stats } = await mountHarness({ width: 1666, preciseGrid: true,
            layout: [{ i: 'a', x: 57, y: 0, w: 165, h: 8.25 }] });
        await act(async () => api.ruler!.onPrecisionChange('finest'));
        const event = (clientX: number, clientY: number) => ({ nativeEvent: { clientX, clientY,
            target: { closest: () => ({ className: `react-resizable-handle react-resizable-handle-${handle}` }) } } });
        const before = position(41.25, 8.25);
        const stepX = (1666 - 6) / 72;
        const after = { ...before, width: before.width + stepX * 0.75, height: before.height + 9 };
        await act(async () => resizable().props.onResizeStart(event(100, 100), { node: physicalNode, size: before, handle }));
        await act(async () => api.width(1900));
        await act(async () => api.ruler!.onPrecisionChange('standard')); // The gesture retains its original fine step.
        await act(async () => resizable().props.onResize(event(100 + stepX * 0.75, 109), { node: physicalNode, size: after, handle }));
        expect(item().props).toMatchObject({ w: handle === 's' ? 41.25 : 42, h: handle === 'e' ? 8.25 : 8.5 });
        expect(stats.writes).toBe(0);
        await act(async () => resizable().props.onResizeStop(event(100 + stepX * 0.75, 109), { node: physicalNode, size: after, handle }));
        expect(api.stored[0]).toMatchObject({ x: 57, w: handle === 's' ? 165 : 168, h: handle === 'e' ? 8.25 : 8.5 });
        expect(stats.writes).toBe(1);
    });

    it.each([[1910, 640], [640, 1910], [1910, 320]])('physical drag callbacks %i → %i keep the coordinate epoch through stop', async (start, next) => {
        const { api, stats } = await mountHarness({ width: start });
        // A changed geometry is rejected as an autonomous acknowledgment; only the gesture stop persists it.
        await act(async () => grid().onLayoutChange(initial.map(row => ({ ...row, w: 1 }))));
        expect(stats.writes).toBe(0);
        const { cols } = grid().gridConfig;
        const mounts = stats.mounts;
        const columnPixels = (start - 12 - 6 * (cols - 1)) / cols + 6;
        await act(async () => draggable().props.onStart({ clientX: 6, clientY: 6 }, { node: physicalNode }));
        // Cross RGL's public drag threshold before the viewport changes.
        await act(async () => draggable().props.onDrag({ clientX: 10, clientY: 6 }, { node: physicalNode, deltaX: 0, deltaY: 0 }));
        await act(async () => api.width(next));
        expect(grid()).toMatchObject({ width: start, gridConfig: { cols } });
        await act(async () => draggable().props.onDrag({ clientX: 10 + columnPixels * 2, clientY: 366 }, { node: physicalNode, deltaX: columnPixels * 2, deltaY: 360 }));
        await act(async () => draggable().props.onStop({}, { node: physicalNode }));
        expect(api.stored.find(row => row.i === 'a')).toMatchObject({ x: 2 * 12 / gridDensity(start), y: 8, w: 72 });
        expect(stats.writes).toBe(1);
        expect(stats.mounts).toBe(mounts);
        expect(grid()).toMatchObject({ width: next, gridConfig: { cols: gridDensity(next) * 24 } });
    });

    it.each(([[1910, 640], [640, 1910], [1910, 320]] as const).flatMap(([start, next]) =>
        (['e', 's', 'se'] as const).map(handle => ({ start, next, handle })),
    ))('physical $handle resize callbacks $start → $next preserve axes and write only on release', async ({ start, next, handle }) => {
        const { api, stats } = await mountHarness({ width: start });
        expect(resizable().props.resizeHandles).toEqual(['e', 's', 'se']);
        const originalColumns = 72 * gridDensity(start) / 12;
        const columns = originalColumns + (handle === 's' ? 0 : 2);
        const rows = handle === 'e' ? 8 : 10;
        const startSize = position(originalColumns, 8);
        const resized = position(columns, rows);
        await act(async () => resizable().props.onResizeStart({ nativeEvent: {} }, { node: physicalNode, size: startSize, handle }));
        const constraints = item().props.minW;
        await act(async () => api.width(next));
        expect(grid().width).toBe(start);
        expect(item().props.minW).toBe(constraints);
        await act(async () => resizable().props.onResize({ nativeEvent: {} }, { node: physicalNode, size: resized, handle }));
        expect(stats.writes).toBe(0);
        await act(async () => resizable().props.onResizeStop({ nativeEvent: {} }, { node: physicalNode, size: resized, handle }));
        expect(api.stored.find(row => row.i === 'a')).toMatchObject({ x: 0, y: 0, w: columns * 12 / gridDensity(start), h: rows });
        expect(stats.writes).toBe(1);
        expect(grid().width).toBe(next);
    });

    it('no-op stop still unlocks a pending narrow projection without a write', async () => {
        const { api, stats } = await mountHarness();
        await act(async () => item().props.onDragStart('a', 0, 0, { e: {}, node }));
        await act(async () => api.width(320));
        expect(grid().gridConfig.cols).toBe(48);
        await act(async () => item().props.onDragStop('a', 0, 0, { e: {}, node }));
        expect(stats.writes).toBe(0);
        expect(api.stored).toEqual(initial);
        expect(grid().layout.every((row: LayoutItem) => row.x === 0 && row.w === 24)).toBe(true);
        expect(grid().dragConfig.enabled).toBe(false);
    });

    it('multiple width changes and panel metadata retain the gesture frame and merge latest metadata', async () => {
        const { api, stats } = await mountHarness();
        await act(async () => item().props.onDragStart('a', 0, 0, { e: {}, node }));
        for (const width of [2800, 320, 3900, 640]) await act(async () => api.width(width));
        await act(async () => api.metadata());
        expect(grid().width).toBe(1910);
        expect(grid().gridConfig.cols).toBe(48);
        await act(async () => item().props.onDragStop('a', 2, 10, { e: {}, node }));
        expect(grid().width).toBe(640);
        expect(api.blocks.every(block => block.pin === '2330')).toBe(true);
        expect(api.stored.find(row => row.i === 'a')?.w).toBe(72);
        expect(stats.writes).toBe(1);
    });

    it.each(['profile', 'same-layout reset', 'remove', 'layout update'] as const)('%s revokes the gesture frame and captured old callbacks without overwriting the new workspace', async action => {
        const { api, stats } = await mountHarness();
        await act(async () => item().props.onDragStart('a', 0, 0, { e: {}, node }));
        const old = grid();
        const stop = item().props.onDragStop;
        await act(async () => api.width(320));
        const replacement = action === 'profile' ? initial.map(row => ({ ...row, x: row.i === 'a' ? 72 : 144, w: 72 }))
            : action === 'remove' ? [initial[1]!] : action === 'layout update' ? initial.map(row => ({ ...row, h: 6 })) : structuredClone(initial);
        await act(async () => {
            // A layout-only update keeps the block list; every other action replaces it too.
            if (action === 'layout update') api.updateLayout(replacement);
            else api.replace(replacement);
            // The old acknowledgment arrives before React commits the replacement.
            old.onLayoutChange(initial.map(row => ({ ...row, ...toRenderGeom(row, 2) })));
        });
        expect(grid().width).toBe(320);
        await act(async () => stop('a', 2, 10, { e: {}, node }));
        expect(api.stored).toEqual(replacement);
        expect(stats.writes).toBe(0);
        expect(grid().width).toBe(320);
        expect(grid().dragConfig.enabled).toBe(false);
    });

    it('an equal-content replacement revokes the drop and RGL shows the stored position again', async () => {
        const { api, stats } = await mountHarness();
        await act(async () => item().props.onDragStart('a', 0, 0, { e: {}, node }));
        await act(async () => api.replace(structuredClone(initial)));
        await act(async () => item().props.onDragStop('a', 2, 10, { e: {}, node }));
        expect(stats.writes).toBe(0);
        expect(api.stored).toEqual(initial);
        expect(item().props).toMatchObject({ x: 0, y: 0 });
        // Later gestures persist again instead of being rejected as foreign geometry.
        await act(async () => item().props.onDragStart('a', 0, 0, { e: {}, node }));
        await act(async () => item().props.onDragStop('a', 2, 10, { e: {}, node }));
        expect(stats.writes).toBe(1);
        expect(api.stored.find(row => row.i === 'a')).toMatchObject({ x: 12 });
    });

    it('a replacement that keeps the layout (agent pin) still saves the drop', async () => {
        const { api, stats } = await mountHarness();
        await act(async () => item().props.onDragStart('a', 0, 0, { e: {}, node }));
        await act(async () => api.replace(api.stored));
        await act(async () => item().props.onDragStop('a', 2, 10, { e: {}, node }));
        expect(stats.writes).toBe(1);
        expect(api.stored.find(row => row.i === 'a')).toMatchObject({ x: 12 });
    });

    it('a stale start with an unrecognized coordinate frame grants no stop authority', async () => {
        const { api, stats } = await mountHarness();
        const old = grid();
        await act(async () => old.onDragStart(initial, initial[0], initial[0]));
        await act(async () => api.width(320));
        expect(grid().width).toBe(320);
        await act(async () => grid().onDragStop(initial, initial[0], initial[0]));
        expect(api.stored).toEqual(initial);
        expect(stats.writes).toBe(0);
    });
});

describe('narrow display-only workspace', () => {
    const grid = () => view!.root.findByType(GridLayout).props;

    it.each([320, 360, 639])('container %i projects every child to a full-width vertical row with zero persistence', async width => {
        const { api, stats } = await mountHarness({ width });
        expect(grid().layout.map(({ i, x, y, w }: LayoutItem) => ({ i, x, y, w }))).toEqual([
            { i: 'a', x: 0, y: 0, w: 24 }, { i: 'b', x: 0, y: 8, w: 24 },
        ]);
        expect(grid().dragConfig.enabled).toBe(false);
        expect(grid().resizeConfig.enabled).toBe(false);
        expect(stats.writes).toBe(0);
        expect(api.stored).toEqual(initial);
    });

    it('640 is the desktop boundary and restores normal interactions', async () => {
        const { stats } = await mountHarness({ width: 640 });
        expect(grid().dragConfig.enabled).toBe(true);
        expect(grid().resizeConfig.enabled).toBe(true);
        expect(grid().layout[0].w).toBe(6);
        expect(stats.writes).toBe(0);
    });

    it('stored per-item interaction overrides cannot enable dragging or resizing in narrow mode', async () => {
        const enabled = initial.map(row => ({ ...row, isDraggable: true, isResizable: true }));
        const { api, stats } = await mountHarness({ width: 320, layout: enabled });
        expect(view!.root.findAllByType(GridItem).every(row => !row.props.isDraggable && !row.props.isResizable)).toBe(true);
        expect(api.stored).toEqual(enabled);
        expect(stats.writes).toBe(0);
    });

    it('320 → 1280 → 360 → 1910 preserves canonical precision and mounted panels', async () => {
        const fine = [{ i: 'a', x: 7, y: 0, w: 67, h: 8 }];
        const { api, stats } = await mountHarness({ width: 320, layout: fine });
        const mounts = stats.mounts;
        const unmounts = stats.unmounts;
        for (const width of [1280, 360, 1910]) await act(async () => api.width(width));
        expect(api.stored).toEqual(fine);
        expect(stats.writes).toBe(0);
        expect(stats.mounts).toBe(mounts);
        expect(stats.unmounts).toBe(unmounts);
        expect(grid().dragConfig.enabled).toBe(true);
        expect(grid().resizeConfig.enabled).toBe(true);
    });

    it('captured wide callbacks and attempted narrow gestures cannot persist a projection', async () => {
        const { api, stats } = await mountHarness();
        const old = grid();
        await act(async () => api.width(320));
        const projected = grid().layout;
        await act(async () => {
            old.onLayoutChange(initial.map(row => ({ ...row, w: 1 })));
            old.onDragStart(initial, initial[0], initial[0]);
            grid().onDragStart(projected, projected[0], projected[0]);
            grid().onDragStop(projected, projected[0], projected[0]);
            grid().onResizeStart(projected, projected[0], projected[0]);
            grid().onResizeStop(projected, projected[0], projected[0]);
            grid().onLayoutChange(projected);
        });
        expect(stats.writes).toBe(0);
        expect(api.stored).toEqual(initial);
        expect(grid().width).toBe(320);
    });

    it('narrow profile/remove changes remain canonical, including their original gaps', async () => {
        const { api, stats } = await mountHarness({ width: 320 });
        const profile = [{ i: 'profile', x: 13, y: 30, w: 151, h: 7 }];
        await act(async () => api.replace(profile));
        expect(api.stored).toEqual(profile);
        expect(grid().layout[0]).toMatchObject({ x: 0, y: 0, w: 24, h: 7 });
        expect(stats.writes).toBe(0);
        // The wide view may compact a profile's existing gap, but never stores the narrow projection.
        await act(async () => api.width(1280));
        expect(api.stored[0]).toMatchObject({ x: 12, w: 156, y: 0 });
        expect(stats.writes).toBe(1);
    });
});

describe('grid geometry boundaries', () => {
    it('normalization follows child order, projection follows visual order, both strip orphans and keep frozen rows intact', () => {
        const rows = [{ i: 'b', x: 12, y: 0, w: 12, h: 3 }, { i: 'a', x: 0, y: 0, w: 12, h: 5 }, { i: 'orphan', x: 0, y: 5, w: 24, h: 8 }];
        const copy = structuredClone(rows);
        rows.forEach(Object.freeze);
        Object.freeze(rows);
        expect(normalizeGridLayout(rows, ['new', 'b', 'a'], 24).map(item => item.i)).toEqual(['new', 'b', 'a']);
        expect(gridGeometry.projectNarrowGridLayout(rows, ['b', 'a'], 24)).toMatchObject([
            { i: 'a', x: 0, y: 0, w: 24, h: 5, minW: 24, maxW: 24, static: true, isDraggable: false, isResizable: false },
            { i: 'b', x: 0, y: 5, w: 24, h: 3, static: true },
        ]);
        expect(rows).toEqual(copy);
    });
    it.each([[0, 1], [1799, 1], [1800, 2], [2799, 2], [2800, 3], [3899, 3], [3900, 4]])('width %i uses the shared density %i', (width, density) => {
        expect(gridDensity(width)).toBe(density);
    });

    it('geometry matching ignores ordering and constraints, not identity or duplicate rows', () => {
        expect(sameGridGeometry(initial, [...initial].reverse().map(item => ({ ...item, minW: 1, moved: true })))).toBe(true);
        expect(sameGridGeometry(initial, [initial[0]!, initial[0]!])).toBe(false);
        expect(sameGridGeometry([initial[0]!, initial[0]!], initial)).toBe(false);
        expect(sameGridGeometry(initial, initial.slice(1))).toBe(false);
    });

    it.each(['i', 'x', 'y', 'w', 'h'] as const)('%s differences reject stale autonomous rows', key => {
        const changed = initial.map(item => ({ ...item }));
        if (key === 'i') changed[0]!.i = 'other';
        else changed[0]![key]++;
        expect(sameGridGeometry(initial, changed)).toBe(false);
    });

    it.each([1, 2, 3, 4])('density %i acknowledgment preserves sub-render precision and row identity', density => {
        const current = [{ i: 'fine', x: 7, y: 0, w: 67, h: 8, minW: 36 }];
        const rendered = current.map(item => ({ ...item, ...toRenderGeom(item, density) }));
        expect(storeGridLayout(current, rendered, density)).toBeUndefined();
        const changed = storeGridLayout(current, [...rendered, { i: 'new', x: 0, y: 8, w: 1, h: 1 }], density)!;
        expect(changed[0]).toBe(current[0]);
        expect(changed[1]?.w).toBe(12 / density);
    });
});

describe('App shared-adapter wiring', () => {
    it('spreads the shared handler bag without local overrides or a remount key', () => {
        const source = ts.createSourceFile('App.tsx', appSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
        const nodes: ts.Node[] = [];
        const visit = (node: ts.Node) => { nodes.push(node); ts.forEachChild(node, visit); };
        visit(source);
        const text = (node: ts.Node | undefined) => node?.getText(source);
        const hookImport = nodes.filter(ts.isImportDeclaration).find(node => ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text === './hooks/use-workspace-grid');
        const declaration = nodes.filter(ts.isVariableDeclaration).find(node => node.initializer && ts.isCallExpression(node.initializer) && text(node.initializer.expression) === 'useWorkspaceGrid');
        if (!declaration?.initializer || !ts.isCallExpression(declaration.initializer) || !ts.isObjectBindingPattern(declaration.name)) throw new Error('Missing shared grid adapter destructuring');
        const bindings = Object.fromEntries(declaration.name.elements.map(binding => [text(binding.propertyName ?? binding.name), text(binding.name)]));
        const grids = nodes.filter(ts.isJsxOpeningElement).filter(node => text(node.tagName) === 'GridLayout');
        expect(grids).toHaveLength(1);
        const properties = grids[0]!.attributes.properties;
        const attribute = (name: string) => properties.filter(ts.isJsxAttribute).find(node => text(node.name) === name);
        const value = (name: string) => { const init = attribute(name)?.initializer; return init && ts.isJsxExpression(init) ? init.expression : undefined; };
        const [options] = declaration.initializer.arguments;
        const config = value('gridConfig');
        expect({
            bindings, hookImport: text(hookImport?.importClause?.namedBindings), objectOptions: !!options && ts.isObjectLiteralExpression(options),
            spreads: properties.filter(ts.isJsxSpreadAttribute).map(spread => text(spread.expression)),
            overrides: ['onLayoutChange', 'onDragStart', 'onResizeStart', 'onDragStop', 'onResizeStop', 'dragConfig', 'resizeConfig', 'key'].filter(attribute),
            layout: text(value('layout')), width: text(value('width')),
            cols: config && ts.isObjectLiteralExpression(config) ? text(config.properties.filter(ts.isPropertyAssignment).find(node => text(node.name) === 'cols')?.initializer) : undefined,
        }).toEqual({
            bindings: expect.objectContaining({ gridProps: expect.any(String), renderLayout: expect.any(String), renderWidth: expect.any(String), renderCols: expect.any(String) }),
            hookImport: expect.stringContaining('useWorkspaceGrid'), objectOptions: true, spreads: [bindings.gridProps], overrides: [],
            layout: bindings.renderLayout, width: bindings.renderWidth, cols: bindings.renderCols,
        });
    });
});
