import { describe, expect, it } from 'vitest';
import type { Layout, LayoutItem } from 'react-grid-layout';
import { resizePointer, resizeWorkspacePanel } from './workspace-resize';

const panel: LayoutItem = { i: 'a', x: 2.25, y: 0, w: 10, h: 8.25, minW: 4, minH: 3 };
const steps = { x: 0.75, y: 0.25 };
const pixels = { x: 24, y: 36 };
const resize = (others: Layout, w: number, h: number, handle: 'e' | 's' | 'se' = 'se') =>
    resizeWorkspacePanel(panel, [panel, ...others], { w, h }, handle, 72, steps, pixels);

describe('panel edge resize', () => {
    it('aligns a nearby off-grid edge, including an edge on another row', () => {
        expect(resize([{ i: 'below', x: 2.25, y: 8.25, w: 10.5, h: 8 }], 10.4, 8.25, 'e')).toEqual({ w: 10.5, h: 8.25 });
    });
    it('stops at a fractional neighbor even when the next grid step overshoots', () => {
        const neighbor = { i: 'b', x: 12.5, y: 0, w: 8, h: 8 };
        expect(resize([neighbor], 15, 8.25, 'e')).toEqual({ w: 10.25, h: 8.25 });
        expect(neighbor.y).toBe(0);
    });
    it('does not change the stationary axis or resize without pointer movement', () => {
        expect(resize([], 11.5, 9, 'e')).toEqual({ w: 11.5, h: 8.25 });
        expect(resize([], 11, 9, 's')).toEqual({ w: 10, h: 9 });
        expect(resize([], 10, 8.25)).toEqual({ w: 10, h: 8.25 });
    });
    it('allows a corner to grow into the next row so lower cards can flow down', () => {
        const diagonal = { i: 'b', x: 12.5, y: 8.5, w: 8, h: 8 };
        expect(resize([diagonal], 14, 12)).toEqual({ w: 13.75, h: 12 });
        expect(resize([diagonal], 9, 12)).toEqual({ w: 9.25, h: 12 });
    });
    it('honors min/max dimensions and the outer grid edge', () => {
        expect(resize([], -100, -100)).toEqual({ w: 4, h: 3 });
        expect(resize([], 1000, 8.25, 'e').w).toBe(69.75);
        const constrained = { ...panel, maxW: 11, maxH: 9 };
        expect(resizeWorkspacePanel(constrained, [constrained], { w: 100, h: 100 }, 'se', 72, steps, pixels)).toEqual({ w: 11, h: 9 });
    });
    it('reads mouse, active touch and final touch positions without coordinates becoming zero', () => {
        expect(resizePointer({ clientX: 0, clientY: 9 } as MouseEvent)).toEqual({ x: 0, y: 9 });
        expect(resizePointer({ touches: [{ clientX: 7, clientY: 9 }], changedTouches: [] } as unknown as TouchEvent)).toEqual({ x: 7, y: 9 });
        expect(resizePointer({ touches: [], changedTouches: [{ clientX: 7, clientY: 9 }] } as unknown as TouchEvent)).toEqual({ x: 7, y: 9 });
    });
});
