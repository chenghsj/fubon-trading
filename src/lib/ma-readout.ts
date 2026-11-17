import type { IndicatorPoint } from './indicators';

export type MaDirection = 1 | -1 | 0 | null;

/** Compare the displayed bar with its predecessor, never a later/latest bar. */
export function maReadout(points: readonly IndicatorPoint[], time?: number): { value: number | undefined; direction: MaDirection } {
    let index = points.length - 1;
    if (time !== undefined) {
        let lo = 0;
        let hi = index;
        index = -1;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            const point = points[mid]!;
            if (point.time === time) { index = mid; break; }
            if (point.time < time) lo = mid + 1;
            else hi = mid - 1;
        }
    }
    const value = points[index]?.value;
    if (value === undefined || !Number.isFinite(value)) return { value: undefined, direction: null };
    const previous = points[index - 1]?.value;
    if (previous === undefined || !Number.isFinite(previous)) return { value, direction: null };
    const diff = value - previous;
    const tolerance = Number.EPSILON * Math.max(1, Math.abs(value), Math.abs(previous)) * 8;
    return { value, direction: Math.abs(diff) <= tolerance ? 0 : diff > 0 ? 1 : -1 };
}
