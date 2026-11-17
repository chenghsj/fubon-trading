import { describe, expect, it } from 'vitest';
import type { Layout } from 'react-grid-layout';
import { resizeRulerBoundary, rulerBoundaries, rulerHandleGroups, rulerSteps, type RulerAxis } from './workspace-ruler';

const layout: Layout = [
    { i: 'a', x: 0, y: 0, w: 8, h: 8, minW: 3, minH: 4 },
    { i: 'b', x: 8, y: 0, w: 16, h: 8, minW: 6, minH: 4 },
    { i: 'c', x: 0, y: 8, w: 8, h: 12, minW: 4, minH: 6 },
    { i: 'd', x: 8, y: 8, w: 16, h: 12, minW: 8, minH: 6 },
];
function resize(rows: Layout, axis: RulerAxis, position: number, delta: number) {
    const boundary = rulerBoundaries(rows, axis, 24).find(edge => edge.position === position)!;
    return resizeRulerBoundary(rows, axis, boundary, delta);
}

describe('workspace ruler boundaries', () => {
    it('merges close junction edges and moves them together up to the real minimum width', () => {
        const rows: Layout = [
            { i: 'chart', x: 14.25, y: 0, w: 41, h: 11, minW: 10 },
            { i: 'dock', x: 14.25, y: 11, w: 41.5, h: 9, minW: 10 },
            { i: 'right', x: 56, y: 0, w: 16, h: 25, minW: 10 },
        ];
        const groups = rulerHandleGroups(rows, 'x', 72, 0.25, 23);
        expect(groups).toHaveLength(2);
        const junction = groups[1]!;
        expect(junction.positions).toEqual([55.25, 55.75, 56]);
        expect((junction.position - groups[0]!.position) * 23).toBeGreaterThan(24);
        const next = resizeRulerBoundary(rows, 'x', junction, 100, 0.75);
        expect(next.delta).toBe(6);
        expect(next.layout).toMatchObject([{ x: 14.25, w: 47 }, { x: 14.25, w: 47.5 }, { x: 62, w: 10 }]);
        expect(next.layout[2]!.x - next.layout[0]!.x - next.layout[0]!.w).toBe(0.75);
    });
    it('translates a small panel when both its edges belong to one junction', () => {
        const rows: Layout = [
            { i: 'left', x: 0, y: 0, w: 10, h: 8 },
            { i: 'thin', x: 10, y: 0, w: 0.5, h: 8, maxW: 0.5 },
            { i: 'right', x: 10.5, y: 0, w: 13.5, h: 8 },
        ];
        const group = rulerHandleGroups(rows, 'x', 24, 0.25, 20)[0]!;
        expect(group.positions).toEqual([10, 10.5]);
        const next = resizeRulerBoundary(rows, 'x', group, 2, 0.25);
        expect(next.layout).toMatchObject([{ w: 12 }, { x: 12, w: 0.5 }, { x: 12.5, w: 11.5 }]);
    });
    it('lets staggered edges close their gap and align with the actual neighbor', () => {
        const rows: Layout = [
            { i: 'chart', x: 14.25, y: 0, w: 41, h: 11, minW: 10 },
            { i: 'dock', x: 14.25, y: 11, w: 41.5, h: 9, minW: 10 },
            { i: 'right', x: 56, y: 0, w: 16, h: 25, minW: 10 },
        ];
        const boundary = rulerBoundaries(rows, 'x', 72, 0.25).find(edge => edge.position === 55.25)!;
        const resized = resizeRulerBoundary(rows, 'x', boundary, 0.75, 0.25);
        expect(resized.delta).toBe(0.75);
        expect(resized.layout[0]!.x + resized.layout[0]!.w).toBe(56);
        expect(resized.layout[1]).toEqual(rows[1]);
    });
    it('does not let an unrelated row block horizontal expansion', () => {
        const rows: Layout = [
            { i: 'a', x: 0, y: 0, w: 8, h: 8, minW: 3 },
            { i: 'b', x: 8, y: 0, w: 16, h: 8, minW: 4 },
            { i: 'c', x: 0, y: 8, w: 10, h: 8, minW: 3 },
            { i: 'd', x: 10, y: 8, w: 14, h: 8, minW: 4 },
        ];
        const next = resize(rows, 'x', 8, 4);
        expect(next.delta).toBe(4);
        expect(next.layout.slice(2)).toEqual(rows.slice(2));
    });
    it('fine snapping respects fractional row limits and shared edges', () => {
        const rows: Layout = [{ i: 'a', x: 0, y: 0, w: 24, h: 8.25 }, { i: 'b', x: 0, y: 8.25, w: 24, h: 4 }];
        const boundary = rulerBoundaries(rows, 'y', 24, 0.25)[0]!;
        const next = resizeRulerBoundary(rows, 'y', boundary, 0.38, 0.25);
        expect(next.delta).toBe(0.5);
        expect(next.layout).toMatchObject([{ h: 8.75 }, { y: 8.75, h: 3.5 }]);
        expect(resizeRulerBoundary(rows, 'y', boundary, -0.1, 0.25).delta).toBe(0);
    });
    it.each([1, 2, 3, 4])('precision steps at density %i save whole canonical columns', density => {
        const standard = rulerSteps('standard', 3, density);
        const fine = rulerSteps('fine', 3, density);
        const finest = rulerSteps('finest', 3, density);
        expect(fine.x).toBeLessThan(standard.x);
        expect(finest.x).toBeLessThan(fine.x);
        expect(Number.isInteger(finest.x * 4)).toBe(true);
        expect([standard.y, fine.y, finest.y]).toEqual([1, 0.5, 0.25]);
    });
    it('resizes a shared column across every row without changing the outer width', () => {
        const before = structuredClone(layout);
        const { layout: next, delta } = resize(layout, 'x', 8, 3);
        expect(delta).toBe(3);
        expect(next.map(({ x, w }) => [x, w])).toEqual([[0, 11], [11, 13], [0, 11], [11, 13]]);
        expect(next.map(({ y, h }) => [y, h])).toEqual(layout.map(({ y, h }) => [y, h]));
        expect(layout).toEqual(before);
    });
    it('resizes a row across every column and allows the last row to grow', () => {
        expect(resize(layout, 'y', 8, 2).layout.map(({ y, h }) => [y, h])).toEqual([[0, 10], [0, 10], [10, 10], [10, 10]]);
        expect(resize(layout, 'y', 20, 3).layout.map(({ y, h }) => [y, h])).toEqual([[0, 8], [0, 8], [8, 15], [8, 15]]);
    });
    it('clamps against the strictest panel minimum and maximum on either side', () => {
        expect(resize(layout, 'x', 8, -100).delta).toBe(-4);
        expect(resize(layout, 'x', 8, 100).delta).toBe(8);
        const limits = layout.map(item => item.i === 'a' ? { ...item, maxW: 9 } : item);
        expect(resize(limits, 'x', 8, 100).delta).toBe(1);
        expect(resize(layout, 'y', 8, -100).delta).toBe(-4);
        expect(resize(layout, 'y', 8, 100).delta).toBe(6);
    });
    it('keeps spanning panels fixed and stops exactly at the actual neighbor in a sparse layout', () => {
        const sparse: Layout = [
            { i: 'a', x: 0, y: 0, w: 8, h: 8 },
            { i: 'b', x: 10, y: 0, w: 14, h: 8 },
            { i: 'span', x: 0, y: 8, w: 24, h: 8 },
        ];
        const next = resize(sparse, 'x', 8, 10);
        expect(next.delta).toBe(2);
        expect(next.layout[2]).toBe(sparse[2]);
        expect(next.layout[0]!.w).toBe(next.layout[1]!.x);
    });
    it.each(['static', 'isResizable'] as const)('a locked panel protects its shared edge (%s)', flag => {
        const locked = layout.map(item => item.i === 'a' ? { ...item, [flag]: flag === 'static' } : item);
        expect(resize(locked, 'x', 8, 2).delta).toBe(0);
    });
    it('does not force an already undersized panel to jump or shrink further', () => {
        const small = layout.map(item => item.i === 'a' ? { ...item, minW: 10 } : item);
        expect(resize(small, 'x', 8, -1).delta).toBe(0);
        expect(resize(small, 'x', 8, 1).delta).toBe(1);
    });
});
