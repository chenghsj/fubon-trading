import { describe, expect, it } from 'vitest';
import { maReadout } from './ma-readout';

describe('MA readout direction', () => {
    const points = [{ time: 60, value: 25000 }, { time: 120, value: 25001 }, { time: 180, value: 24999 }, { time: 240, value: 24999 }];
    it('uses the hovered bar and its predecessor for up/down/flat', () => {
        expect(maReadout(points, 120)).toEqual({ value: 25001, direction: 1 });
        expect(maReadout(points, 180)).toEqual({ value: 24999, direction: -1 });
        expect(maReadout(points, 240)).toEqual({ value: 24999, direction: 0 });
        expect(maReadout(points)).toEqual(maReadout(points, 240));
    });
    it('does not substitute a future/latest value during warmup or at a missing time', () => {
        expect(maReadout(points, 0)).toEqual({ value: undefined, direction: null });
        expect(maReadout(points, 150)).toEqual({ value: undefined, direction: null });
        expect(maReadout(points, 60)).toEqual({ value: 25000, direction: null });
        expect(maReadout([])).toEqual({ value: undefined, direction: null });
    });
    it('does not bridge a missing or invalid predecessor to invent an arrow', () => {
        expect(maReadout([{ time: 60 }, { time: 120, value: 10 }])).toEqual({ value: 10, direction: null });
        expect(maReadout([{ time: 60, value: NaN }, { time: 120, value: 10 }])).toEqual({ value: 10, direction: null });
        expect(maReadout([{ time: 60, value: 10 }, { time: 120, value: Infinity }])).toEqual({ value: undefined, direction: null });
    });
    it('compares unrounded MA values while ignoring floating-point noise', () => {
        expect(maReadout([{ time: 60, value: 25000.1 }, { time: 120, value: 25000.2 }]).direction).toBe(1);
        expect(maReadout([{ time: 60, value: 0.3 }, { time: 120, value: 0.1 + 0.2 }]).direction).toBe(0);
    });
});
