import type { Layout } from 'react-grid-layout';
import { GRID_LEGACY_SCALE } from './workspace';

export type RulerAxis = 'x' | 'y';
export interface RulerBoundary {
    position: number;
    min: number;
    max: number;
    positions: readonly number[];
}

export const RULER_PRECISIONS = ['standard', 'fine', 'finest'] as const;
export type RulerPrecision = typeof RULER_PRECISIONS[number];
export const RULER_PRECISION_LABELS: Record<RulerPrecision, string> = { standard: '標準', fine: '精細', finest: '極細' };
export const RULER_PRECISION_KEY = 'fubon-workspace-ruler-precision';
// At density 3 every canonical column maps to an exact binary quarter-cell.
export const PRECISE_GRID_DENSITY = 3;
export function loadRulerPrecision(): RulerPrecision {
    try {
        const value = localStorage.getItem(RULER_PRECISION_KEY);
        if (RULER_PRECISIONS.includes(value as RulerPrecision)) return value as RulerPrecision;
    } catch { /* Storage may be unavailable; the control still works in memory. */ }
    return 'standard';
}
export function rulerSteps(precision: RulerPrecision, renderDensity: number, standardDensity: number) {
    const divisor = precision === 'standard' ? 1 : precision === 'fine' ? 2 : 4;
    // Snap to whole canonical columns, never an amount rounded away on save.
    const columns = Math.max(1, Math.round(GRID_LEGACY_SCALE / standardDensity / divisor));
    return { x: columns * renderDensity / GRID_LEGACY_SCALE, y: 1 / divisor };
}

function edgePositions(layout: Layout, axis: RulerAxis, cols: number): number[] {
    const size = axis === 'x' ? 'w' : 'h';
    const limit = axis === 'x' ? cols : Infinity;
    return [...new Set(layout.flatMap(item => [item[axis], item[axis] + item[size]]))]
        .filter(position => position > 0 && position < limit).sort((a, b) => a - b);
}

/** Constrain actual rectangles; an edge on another row is not a collision. */
function boundaryFor(layout: Layout, axis: RulerAxis, cols: number, positions: readonly number[], unit: number): RulerBoundary {
    const size = axis === 'x' ? 'w' : 'h';
    const cross = axis === 'x' ? 'y' : 'x';
    const crossSize = axis === 'x' ? 'h' : 'w';
    const minimum = axis === 'x' ? 'minW' : 'minH';
    const maximum = axis === 'x' ? 'maxW' : 'maxH';
    const limit = axis === 'x' ? cols : Infinity;
    const moved = new Set(positions);
    const motions = layout.map(item => ({ item, start: item[axis], end: item[axis] + item[size],
        starts: moved.has(item[axis]), ends: moved.has(item[axis] + item[size]) }));
    let min = -Infinity;
    let max = Infinity;
    for (const motion of motions) {
        const { item, start, end, starts, ends } = motion;
        if (!starts && !ends) continue;
        if (item.static || item.isResizable === false) { min = 0; max = 0; break; }
        if (starts) min = Math.max(min, -start);
        if (ends) max = Math.min(max, limit - end);
        const minSize = Math.min(item[size], Math.max(unit, item[minimum] ?? 1));
        const maxSize = Math.max(item[size], item[maximum] ?? Infinity);
        if (ends && !starts) {
            min = Math.max(min, minSize - item[size]);
            max = Math.min(max, maxSize - item[size]);
        } else if (starts && !ends) {
            min = Math.max(min, item[size] - maxSize);
            max = Math.min(max, item[size] - minSize);
        }
    }
    for (let i = 0; i < motions.length; i++) {
        for (let j = i + 1; j < motions.length; j++) {
            const a = motions[i]!;
            const b = motions[j]!;
            if (a.item[cross] + a.item[crossSize] <= b.item[cross]
                || b.item[cross] + b.item[crossSize] <= a.item[cross]) continue;
            const [left, right] = a.end <= b.start ? [a, b] : [b, a];
            const gap = right.start - left.end;
            // Existing overlaps are normalized before a ruler gesture starts.
            if (gap < 0) continue;
            const relative = Number(left.ends) - Number(right.starts);
            if (relative > 0) max = Math.min(max, gap);
            if (relative < 0) min = Math.max(min, -gap);
        }
    }
    const position = (positions[0]! + positions.at(-1)!) / 2;
    return { position, min: position + min, max: position + max, positions };
}

export function rulerBoundaries(layout: Layout, axis: RulerAxis, cols: number, unit = 1): RulerBoundary[] {
    return edgePositions(layout, axis, cols).map(position => boundaryFor(layout, axis, cols, [position], unit));
}

/** Merge overlapping hit targets into one junction that moves all its edges. */
export function rulerHandleGroups(layout: Layout, axis: RulerAxis, cols: number, unit: number, pixelsPerUnit: number, hitSize = 24): RulerBoundary[] {
    const groups: number[][] = [];
    for (const position of edgePositions(layout, axis, cols)) {
        const group = groups.at(-1);
        if (group && (position - group.at(-1)!) * Math.abs(pixelsPerUnit) < hitSize) group.push(position);
        else groups.push([position]);
    }
    return groups.map(positions => boundaryFor(layout, axis, cols, positions, unit));
}

/** Move both sides of a shared edge; spanning panels and other edges stay put. */
export function resizeRulerBoundary(layout: Layout, axis: RulerAxis, boundary: RulerBoundary, delta: number, step = 1) {
    const applied = Number.isFinite(delta) ? Math.max(boundary.min, Math.min(boundary.max, boundary.position + Math.round(delta / step) * step)) - boundary.position : 0;
    const size = axis === 'x' ? 'w' : 'h';
    const moved = new Set(boundary.positions);
    return {
        delta: applied,
        layout: layout.map(item => {
            const starts = moved.has(item[axis]);
            const ends = moved.has(item[axis] + item[size]);
            if (!starts && !ends) return item;
            return { ...item, [axis]: item[axis] + (starts ? applied : 0), [size]: item[size] + (Number(ends) - Number(starts)) * applied };
        }),
    };
}

export const GRID_ROW_HEIGHT = 30;
export const GRID_GAP = 6;
export const gridColumnStep = (width: number, cols: number) => (width - GRID_GAP) / cols;
export const gridRowStep = GRID_ROW_HEIGHT + GRID_GAP;
/** RGL padding equals the gap: the guide sits in the middle of that gap. */
export const rulerPixel = (position: number, step: number) => GRID_GAP / 2 + position * step;
