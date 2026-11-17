import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { calcGridItemPosition, type Layout, type LayoutItem } from 'react-grid-layout';
import { GRID_LEGACY_COLS, type Workspace } from '../lib/workspace';
import { desktopGridLayout, gridDensity, NARROW_GRID_WIDTH, normalizeGridLayout, projectNarrowGridLayout, sameGridGeometry, storeGridLayout } from '../lib/workspace-grid';
import { GRID_GAP, GRID_ROW_HEIGHT, gridColumnStep, gridRowStep, loadRulerPrecision, PRECISE_GRID_DENSITY, resizeRulerBoundary, rulerHandleGroups, rulerSteps, RULER_PRECISION_KEY, type RulerAxis, type RulerBoundary, type RulerPrecision } from '../lib/workspace-ruler';
import { panelResizeHandle, resizePointer, resizeWorkspacePanel, type PanelResizeHandle } from '../lib/workspace-resize';
import { WorkspaceResizeScroll } from '../lib/workspace-resize-scroll';
import { WorkspaceDragInput } from '../lib/workspace-drag';

interface WorkspaceGridOptions {
    workspace: Workspace;
    workspaceRef: RefObject<Workspace>;
    width: number;
    updateWorkspace: (workspace: Workspace) => void;
    scrollRef?: RefObject<HTMLElement | null>;
}

interface GestureFrame {
    id: string;
    kind: 'drag' | 'resize';
    /** The stored layout the gesture started from; any replacement revokes it. */
    layout: Layout;
    density: number;
    cols: number;
    width: number;
    renderLayout: Layout;
    exact: boolean;
    resize?: { pointer: { x: number; y: number }; handle: PanelResizeHandle; steps: { x: number; y: number }; scroll?: WorkspaceResizeScroll };
}

interface RulerFrame {
    layout: Layout;
    density: number;
    cols: number;
    width: number;
    renderLayout: Layout;
    original: Layout;
    axis: RulerAxis;
    boundary: RulerBoundary;
    delta: number;
    exact: boolean;
    step: number;
}

/** Keep pixel-to-grid calculations and canonical coordinates in one gesture frame. */
export function useWorkspaceGrid({ workspace, workspaceRef, width, updateWorkspace, scrollRef }: WorkspaceGridOptions) {
    const [gesture, setGesture] = useState<GestureFrame | null>(null);
    const [precision, setPrecision] = useState(loadRulerPrecision);
    const [ruler, setRuler] = useState<RulerFrame | null>(null);
    const rulerRef = useRef<RulerFrame | null>(null);
    const resizeNode = useRef<HTMLElement | null>(null);
    const resizePointerRef = useRef<{ x: number; y: number } | undefined>(undefined);
    const resizeStartEvent = useRef<Event | undefined>(undefined);
    const gridNode = useRef<HTMLDivElement | null>(null);
    const dragInput = useRef(new WorkspaceDragInput()).current;
    const captureResizeStart = useCallback((event: Event) => {
        resizeStartEvent.current = event;
        if (gridNode.current) dragInput.start(event, gridNode.current);
    }, [dragInput]);
    const innerRef = useCallback((node: HTMLDivElement | null) => {
        dragInput.clear();
        gridNode.current?.removeEventListener('mousedown', captureResizeStart, true);
        gridNode.current?.removeEventListener('touchstart', captureResizeStart, true);
        gridNode.current = node;
        node?.addEventListener('mousedown', captureResizeStart, true);
        node?.addEventListener('touchstart', captureResizeStart, true);
        if (!node) resizeStartEvent.current = undefined;
    }, [captureResizeStart, dragInput]);
    const clearResizePreview = useCallback(() => {
        const node = resizeNode.current;
        if (!node) return;
        delete node.dataset.workspaceResizing;
        node.style.removeProperty('--workspace-resize-width');
        node.style.removeProperty('--workspace-resize-height');
        resizeNode.current = null;
    }, []);
    const previewResize = useCallback((handleNode: HTMLElement | null, item: LayoutItem, coordinateWidth: number, cols: number) => {
        // react-resizable reports its handle span, rather than the panel root.
        const node = handleNode?.closest?.<HTMLElement>('.react-grid-item');
        if (!node) return;
        const position = calcGridItemPosition({ containerWidth: coordinateWidth, cols, rowHeight: GRID_ROW_HEIGHT,
            margin: [GRID_GAP, GRID_GAP], containerPadding: [GRID_GAP, GRID_GAP], maxRows: Infinity }, item.x, item.y, item.w, item.h);
        resizeNode.current = node;
        node.dataset.workspaceResizing = 'true';
        node.style.setProperty('--workspace-resize-width', `${position.width}px`);
        node.style.setProperty('--workspace-resize-height', `${position.height}px`);
    }, []);
    useEffect(() => {
        if (gesture?.layout !== workspace.layout) clearResizePreview();
    }, [gesture, workspace.layout, clearResizePreview]);
    useEffect(() => clearResizePreview, [clearResizePreview]);
    useLayoutEffect(() => {
        if (gesture?.kind !== 'resize' || gesture.layout !== workspace.layout) return;
        // RGL 2.2.3 reads nativeEvent from native document mouse/touch moves,
        // losing that event. Capture coordinates only while this gesture lives.
        const track = (event: Event) => {
            if (!gesture.resize?.scroll?.isReplaying) resizePointerRef.current = resizePointer(event);
        };
        window.addEventListener?.('mousemove', track, true);
        window.addEventListener?.('touchmove', track, true);
        return () => {
            window.removeEventListener?.('mousemove', track, true);
            window.removeEventListener?.('touchmove', track, true);
            resizePointerRef.current = undefined;
        };
    }, [gesture, workspace.layout]);
    useLayoutEffect(() => {
        if (gesture?.kind !== 'resize' || gesture.layout !== workspace.layout || !gesture.resize?.scroll) return;
        const original = gesture.renderLayout.find(item => item.i === gesture.id)!;
        return gesture.resize.scroll.start(() => gesture.layout === workspaceRef.current.layout,
            Math.max(0, (original.maxH ?? Infinity) - original.h) * gridRowStep);
    }, [gesture, workspace.layout, workspaceRef]);
    const [resync, setResync] = useState(0);
    const activeRuler = ruler?.layout === workspace.layout ? ruler : null;
    const activeFrame = activeRuler ?? (gesture?.layout === workspace.layout ? gesture : null);
    const exact = activeFrame?.exact ?? (workspace.preciseGrid === true || precision !== 'standard');
    const density = activeFrame?.density ?? (exact ? PRECISE_GRID_DENSITY : gridDensity(width));
    const renderCols = activeFrame?.cols ?? GRID_LEGACY_COLS * density;
    const renderWidth = activeFrame?.width ?? width;
    const hitSize = typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches ? 44 : 24;
    const projected = !activeFrame && width < NARROW_GRID_WIDTH;
    const desktop = useMemo(() => activeFrame?.renderLayout ?? desktopGridLayout(workspace, width, density, exact), [activeFrame, workspace, width, density, exact]);
    const renderLayout = useMemo(() => {
        const layout = projected ? projectNarrowGridLayout(desktop, workspace.blocks.map(block => block.id), renderCols) : desktop;
        // RGL only re-reads an equal-content layout prop when it changes; a revoked drop is undone this way.
        return resync ? layout.map(item => ({ ...item, resync })) : layout;
    }, [projected, desktop, workspace.blocks, renderCols, resync]);
    const normalizedGridLayout = useMemo(
        () => normalizeGridLayout(renderLayout, workspace.blocks.map(block => block.id), renderCols),
        [renderLayout, workspace.blocks, renderCols],
    );
    dragInput.configure({ layout: normalizedGridLayout, layoutKey: workspace.layout, currentLayout: () => workspaceRef.current.layout,
        width: renderWidth, cols: renderCols, steps: rulerSteps(precision, density, gridDensity(renderWidth)), scrollHost: scrollRef?.current });
    const persistGridLayout = useCallback((next: Layout, coordinateDensity: number, coordinateExact: boolean) => {
        // Preserve panel writes made in the same commit, not the render's older workspace.
        const current = workspaceRef.current;
        const stored = storeGridLayout(current.layout, next, coordinateDensity, coordinateExact);
        if (stored) updateWorkspace({ ...current, ...(coordinateExact ? { preciseGrid: true } : {}), layout: stored });
    }, [workspaceRef, updateWorkspace]);
    const onLayoutChange = useCallback((next: Layout) => {
        if (rulerRef.current || projected || workspace.layout !== workspaceRef.current.layout) return;
        // RGL can emit its previous-density layout while synchronizing new props.
        if (sameGridGeometry(next, normalizedGridLayout)) persistGridLayout(next, density, exact);
    }, [projected, workspace.layout, workspaceRef, normalizedGridLayout, persistGridLayout, density, exact]);
    const startGesture = useCallback((kind: GestureFrame['kind'], next: Layout, item: LayoutItem | null, event?: Event, node?: HTMLElement | null) => {
        if (!item || rulerRef.current || projected || activeFrame || workspace.layout !== workspaceRef.current.layout
            || !sameGridGeometry(next, normalizedGridLayout)) return;
        // RGL also loses nativeEvent on touchstart. Capture it at the grid
        // before react-resizable handles it, and only reuse the same handle.
        const captured = resizeStartEvent.current;
        resizeStartEvent.current = undefined;
        if (!event && node && (captured?.target as HTMLElement | null)?.closest?.('.react-resizable-handle') === node) event = captured;
        const pointer = event && resizePointer(event);
        const handle = event && panelResizeHandle(event);
        if (kind === 'resize') {
            resizePointerRef.current = pointer;
            // A held mouse outside the scroll host can start the browser's
            // selection auto-scroll, competing with our measured resize scroll.
            event?.preventDefault?.();
        }
        if (kind === 'resize' && pointer && handle && node) previewResize(node, item, renderWidth, renderCols);
        setGesture({ id: item.i, kind, layout: workspace.layout, density, cols: renderCols, width: renderWidth, renderLayout: normalizedGridLayout, exact,
            ...(kind === 'resize' && pointer && handle ? { resize: { pointer, handle, steps: rulerSteps(precision, density, gridDensity(renderWidth)),
                ...(handle !== 'e' && scrollRef?.current ? { scroll: new WorkspaceResizeScroll(scrollRef.current, event!) } : {}) } } : {}) });
    }, [projected, activeFrame, workspace.layout, workspaceRef, normalizedGridLayout, density, renderCols, renderWidth, exact, precision, previewResize, scrollRef]);
    const resizePanel = useCallback((_next: Layout, _old: LayoutItem | null, item: LayoutItem | null, placeholder: LayoutItem | null, event: Event, node: HTMLElement | null) => {
        if (!gesture || gesture.kind !== 'resize' || item?.i !== gesture.id || gesture.layout !== workspaceRef.current.layout) return;
        const original = gesture.renderLayout.find(row => row.i === item.i);
        if (!original || !gesture.resize) return;
        const pointer = gesture.resize.scroll?.isReplaying ? resizePointerRef.current : resizePointer(event) ?? resizePointerRef.current;
        if (!pointer) return;
        const pixels = { x: gridColumnStep(gesture.width, gesture.cols), y: gridRowStep };
        const proposed = { w: original.w + (pointer.x - gesture.resize.pointer.x) / pixels.x,
            h: original.h + (pointer.y - gesture.resize.pointer.y + (gesture.resize.scroll?.delta ?? 0)) / pixels.y };
        const size = resizeWorkspacePanel(original, gesture.renderLayout, proposed, gesture.resize.handle, gesture.cols, gesture.resize.steps, pixels);
        // RGL calls onResize before compaction. Correct its rounded item and
        // placeholder here so side neighbors don't collide. Lower cards can
        // still flow down when the user deliberately increases the height.
        Object.assign(item, size);
        if (placeholder) Object.assign(placeholder, size);
        previewResize(node, item, gesture.width, gesture.cols);
    }, [gesture, workspaceRef, previewResize]);
    const stopGesture = useCallback((kind: GestureFrame['kind'], next: Layout, item: LayoutItem | null) => {
        if (!gesture || gesture.kind !== kind || item?.i !== gesture.id) return;
        clearResizePreview();
        if (kind === 'drag') dragInput.clear();
        setGesture(null); // Also unlock a changed viewport when a no-op stop has no workspace write.
        if (gesture.layout === workspaceRef.current.layout) persistGridLayout(next, gesture.density, gesture.exact);
        else setResync(count => count + 1);
    }, [gesture, workspaceRef, persistGridLayout, clearResizePreview, dragInput]);
    const startRuler = useCallback((axis: RulerAxis, position: number) => {
        if (rulerRef.current || activeFrame || projected || workspace.layout !== workspaceRef.current.layout) return false;
        const pixels = axis === 'x' ? gridColumnStep(renderWidth, renderCols) : gridRowStep;
        const boundary = rulerHandleGroups(normalizedGridLayout, axis, renderCols, exact ? 0.25 : 1, pixels, hitSize).find(edge => edge.position === position);
        if (!boundary || boundary.min >= boundary.max) return false;
        const frame: RulerFrame = { layout: workspace.layout, density, cols: renderCols, width: renderWidth,
            renderLayout: normalizedGridLayout, original: normalizedGridLayout, axis, boundary, delta: 0,
            exact, step: rulerSteps(precision, density, gridDensity(renderWidth))[axis] };
        rulerRef.current = frame;
        setRuler(frame);
        return true;
    }, [activeFrame, projected, workspace.layout, workspaceRef, normalizedGridLayout, density, renderCols, renderWidth, exact, precision, hitSize]);
    const moveRuler = useCallback((delta: number) => {
        const frame = rulerRef.current;
        if (!frame || frame.layout !== workspaceRef.current.layout) return;
        const resized = resizeRulerBoundary(frame.original, frame.axis, frame.boundary, delta, frame.step);
        const next = { ...frame, renderLayout: resized.layout, delta: resized.delta };
        rulerRef.current = next;
        setRuler(next);
    }, [workspaceRef]);
    const stopRuler = useCallback((cancel = false) => {
        const frame = rulerRef.current;
        rulerRef.current = null;
        setRuler(null);
        if (!frame) return;
        if (!cancel && frame.layout === workspaceRef.current.layout) persistGridLayout(frame.renderLayout, frame.density, frame.exact);
        // Force RGL to undo its preview, even when the original prop is equal.
        setResync(count => count + 1);
    }, [workspaceRef, persistGridLayout]);
    const changePrecision = useCallback((value: RulerPrecision) => {
        if (rulerRef.current || activeFrame) return;
        setPrecision(value);
        try { localStorage.setItem(RULER_PRECISION_KEY, value); } catch { /* Keep the selection in memory. */ }
    }, [activeFrame]);
    const gridProps = useMemo(() => ({
        innerRef,
        constraints: dragInput.constraints,
        onLayoutChange,
        onDragStart: (next: Layout, _old: LayoutItem | null, item: LayoutItem | null) => startGesture('drag', next, item),
        onResizeStart: (next: Layout, _old: LayoutItem | null, item: LayoutItem | null, _placeholder: LayoutItem | null, event: Event, node: HTMLElement | null) => startGesture('resize', next, item, event, node),
        onResize: resizePanel,
        onDragStop: (next: Layout, _old: LayoutItem | null, item: LayoutItem | null) => stopGesture('drag', next, item),
        onResizeStop: (next: Layout, _old: LayoutItem | null, item: LayoutItem | null) => stopGesture('resize', next, item),
        dragConfig: { enabled: !projected && !ruler, handle: '.drag-handle', cancel: 'button, input, select' },
        resizeConfig: { enabled: !projected && !ruler, handles: ['e', 's', 'se'] as const },
    }), [innerRef, dragInput, onLayoutChange, startGesture, stopGesture, resizePanel, projected, ruler]);
    const rulerProps = {
        layout: activeRuler?.original ?? normalizedGridLayout,
        width: renderWidth, cols: renderCols,
        enabled: !projected && !gesture,
        precision, onPrecisionChange: changePrecision,
        steps: rulerSteps(precision, density, gridDensity(renderWidth)),
        unit: exact ? 0.25 : 1,
        hitSize,
        active: activeRuler ? { axis: activeRuler.axis, position: activeRuler.boundary.position, positions: activeRuler.boundary.positions, delta: activeRuler.delta } : null,
        onStart: startRuler, onMove: moveRuler, onStop: stopRuler,
    };
    return { renderLayout, renderCols, renderWidth, density, gridProps, rulerProps };
}
