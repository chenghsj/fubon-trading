import { calcGridItemPosition, type Layout, type LayoutItem } from 'react-grid-layout';
import { defaultConstraints, type LayoutConstraint } from 'react-grid-layout/core';
import { resizePointer } from './workspace-resize';
import { GRID_GAP, GRID_ROW_HEIGHT, gridColumnStep, gridRowStep } from './workspace-ruler';

/** Align actual edges before RGL resolves collisions, retaining fractional columns. */
export function positionWorkspacePanel(original: LayoutItem, layout: Layout, proposed: { x: number; y: number },
    cols: number, steps: { x: number; y: number }, pixels: { x: number; y: number }) {
    const others = layout.filter(item => item.i !== original.i);
    const snap = (value: number, start: number, size: number, axis: 'x' | 'y', max: number) => {
        if (Math.abs(value - start) < 1e-6) return start;
        const dimension = axis === 'x' ? 'w' : 'h';
        const edges = [0, max, ...others.flatMap(item => [item[axis], item[axis] + item[dimension],
            item[axis] - size, item[axis] + item[dimension] - size])];
        const near = edges.filter(edge => Number.isFinite(edge) && edge >= 0 && edge <= max && Math.abs(edge - value) * pixels[axis] <= 8)
            .sort((a, b) => Math.abs(a - value) - Math.abs(b - value));
        return Math.max(0, Math.min(max, near[0] ?? start + Math.round((value - start) / steps[axis]) * steps[axis]));
    };
    return { x: snap(proposed.x, original.x, original.w, 'x', cols - original.w),
        y: snap(proposed.y, original.y, original.h, 'y', Infinity) };
}

interface DragCoordinates {
    layout: Layout;
    layoutKey: Layout;
    currentLayout: () => Layout;
    width: number;
    cols: number;
    steps: { x: number; y: number };
    scrollHost?: HTMLElement | null;
}
interface DragInput {
    coordinates: DragCoordinates;
    node: HTMLElement;
    view: Window;
    start: { x: number; y: number };
    pointer: { x: number; y: number };
    scroll: { x: number; y: number };
    original?: LayoutItem;
}

/** Bridge the unrounded native pointer into RGL's public positioning constraint. */
export class WorkspaceDragInput {
    private coordinates?: DragCoordinates;
    private input?: DragInput;
    readonly constraints: LayoutConstraint[] = [{ name: 'workspace-precise-position',
        constrainPosition: (item, x, y) => this.position(item, x, y) }, ...defaultConstraints];

    configure(coordinates: DragCoordinates) { this.coordinates = coordinates; }

    start(event: Event, grid: HTMLElement) {
        const target = event.target as HTMLElement | null;
        const node = target?.closest<HTMLElement>('.react-grid-item');
        const pointer = resizePointer(event);
        if (!this.coordinates || !pointer || !node || node.parentElement !== grid
            || !target?.closest('.drag-handle') || target.closest('button, input, select')
            || ('button' in event && (event as MouseEvent).button !== 0)) return;
        this.clear();
        const view = grid.ownerDocument.defaultView!;
        const scrollHost = this.coordinates.scrollHost;
        this.input = { coordinates: this.coordinates, node, view, start: pointer, pointer,
            scroll: { x: scrollHost?.scrollLeft ?? 0, y: scrollHost?.scrollTop ?? 0 } };
        // Capture before react-draggable's document handler, including the first
        // move that crosses its threshold and emits drag-start and drag together.
        view.addEventListener('mousemove', this.track, true);
        view.addEventListener('touchmove', this.track, true);
        // Bubble-phase release runs after RGL's final position constraint.
        view.addEventListener('mouseup', this.clear);
        view.addEventListener('touchend', this.clear);
        view.addEventListener('touchcancel', this.clear);
    }

    private track = (event: Event) => {
        if (event.type === 'mousemove' && (event as MouseEvent).buttons === 0) return;
        const pointer = resizePointer(event);
        if (this.input && pointer) this.input.pointer = pointer;
    };

    private position(item: LayoutItem, x: number, y: number) {
        const input = this.input;
        if (!input) return { x, y };
        const frame = input.coordinates;
        if (frame.layoutKey !== frame.currentLayout()) { this.clear(); return { x, y }; }
        const original = input.original ??= frame.layout.find(row => row.i === item.i);
        if (!original || original.i !== item.i) return { x, y };
        const pixels = { x: gridColumnStep(frame.width, frame.cols), y: gridRowStep };
        const proposed = { x: original.x + (input.pointer.x - input.start.x + (frame.scrollHost?.scrollLeft ?? 0) - input.scroll.x) / pixels.x,
            y: original.y + (input.pointer.y - input.start.y + (frame.scrollHost?.scrollTop ?? 0) - input.scroll.y) / pixels.y };
        const position = positionWorkspacePanel(original, frame.layout, proposed, frame.cols, frame.steps, pixels);
        const box = calcGridItemPosition({ containerWidth: frame.width, cols: frame.cols, rowHeight: GRID_ROW_HEIGHT,
            margin: [GRID_GAP, GRID_GAP], containerPadding: [GRID_GAP, GRID_GAP], maxRows: Infinity }, position.x, position.y, original.w, original.h);
        input.node.dataset.workspaceDragging = 'true';
        input.node.style.setProperty('--workspace-drag-left', `${box.left}px`);
        input.node.style.setProperty('--workspace-drag-top', `${box.top}px`);
        return position;
    }

    clear = () => {
        const input = this.input;
        this.input = undefined;
        if (!input) return;
        delete input.node.dataset.workspaceDragging;
        input.node.style.removeProperty('--workspace-drag-left');
        input.node.style.removeProperty('--workspace-drag-top');
        input.view.removeEventListener('mousemove', this.track, true);
        input.view.removeEventListener('touchmove', this.track, true);
        input.view.removeEventListener('mouseup', this.clear);
        input.view.removeEventListener('touchend', this.clear);
        input.view.removeEventListener('touchcancel', this.clear);
    };
}
