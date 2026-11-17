import { describe, expect, it } from 'vitest';
import type { LayoutItem } from 'react-grid-layout';
import { positionWorkspacePanel } from './workspace-drag';

const panel: LayoutItem = { i: 'chart', x: 15, y: 0, w: 42.5, h: 8 };
const pixels = { x: (1666 - 6) / 72, y: 36 };

describe('precise panel drag positioning', () => {
    it.each([3, 1.5, 0.75])('lands at the adjacent fractional edge even with a %s-column step', step => {
        const left = { i: 'left', x: 0, y: 0, w: 14.25, h: 20 };
        expect(positionWorkspacePanel(panel, [left, panel], { x: 14.2, y: 0 }, 72, { x: step, y: 1 }, pixels))
            .toEqual({ x: 14.25, y: 0 });
    });

    it.each([14.25, 14.5, 14.75])('uses the raw pointer to align an edge at %s', edge => {
        const left = { i: 'left', x: 0, y: 0, w: edge, h: 20 };
        expect(positionWorkspacePanel(panel, [left, panel], { x: edge - 0.1, y: 0 }, 72, { x: 0.75, y: 0.25 }, pixels).x).toBe(edge);
    });

    it('does not snap a stationary axis or change a fractional starting position on pickup', () => {
        const original = { ...panel, x: 14.5, y: 8.25 };
        const left = { i: 'left', x: 0, y: 0, w: 14.25, h: 20 };
        expect(positionWorkspacePanel(original, [left, original], { x: 14.5, y: 8.25 }, 72, { x: 0.75, y: 0.25 }, pixels))
            .toEqual({ x: 14.5, y: 8.25 });
    });

    it('leaves deliberate overlaps to the existing collision behavior', () => {
        const left = { i: 'left', x: 0, y: 0, w: 14.25, h: 20 };
        expect(positionWorkspacePanel(panel, [left, panel], { x: 10, y: 0 }, 72, { x: 0.75, y: 0.25 }, pixels).x).toBe(9.75);
    });

    it('aligns right and bottom edges, including across different rows', () => {
        const original = { ...panel, w: 10, h: 4 };
        const neighbor = { i: 'other', x: 40.25, y: 12.5, w: 20, h: 8 };
        expect(positionWorkspacePanel(original, [original, neighbor], { x: 30.2, y: 8.4 }, 72, { x: 0.75, y: 0.25 }, pixels))
            .toEqual({ x: 30.25, y: 8.5 });
    });

    it('keeps the complete card inside the grid bounds', () => {
        expect(positionWorkspacePanel(panel, [panel], { x: 1000, y: -1000 }, 72, { x: 0.75, y: 0.25 }, pixels))
            .toEqual({ x: 29.5, y: 0 });
    });
});
