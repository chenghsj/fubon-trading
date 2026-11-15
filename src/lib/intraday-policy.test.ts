import { describe, expect, it } from 'vitest';
import fixture from './fixtures/intraday-policy.json';
import { cashAtr, revisedEntry } from './intraday-policy';
import { DEFAULT_RESEARCH_CONFIG } from './intraday-research';

describe('fixed V2 policy shared with sandbox execution', () => {
    it('seeds with 14 true ranges, then uses Wilder recursion and only closed contiguous cash minutes', () => {
        const decision = fixture.start + 16 * 60;
        expect(cashAtr(fixture.bars, fixture.start + 13 * 60)).toBeNull();
        expect(cashAtr(fixture.bars, fixture.start + 14 * 60)).toBe(2);
        expect(cashAtr(fixture.bars, fixture.start + 15 * 60)).toBeCloseTo(37 / 14, 10);
        expect(cashAtr(fixture.bars, decision)).toBeCloseTo(509 / 196, 10);
        expect(cashAtr(fixture.bars.filter((_, i) => i !== 3), decision)).toBeNull();
        expect(cashAtr(fixture.bars, decision + 86400)).toBeNull();
        const changed = fixture.bars.map((b, i) => i === 15 ? { ...b, high: 10000 } : b);
        expect(cashAtr(changed, fixture.start + 15 * 60)).toBeCloseTo(37 / 14, 10);
    });
    for (const c of fixture.cases) it(c.name, () => {
        const side = c.action === 'Buy' ? 1 : -1;
        const plan = revisedEntry({ ...DEFAULT_RESEARCH_CONFIG, feePerSide: 12 }, side, c.limit, c.close,
            side > 0 ? c.high : c.low, c.atr, c.realized, 10, 2, c.price);
        expect(plan.reason).toBe(c.blocked ?? null);
        if (plan.reason === null) {
            expect(plan.stopPoints).toBe(c.stop);
            expect(plan.targetPoints).toBe(c.stop! * 2);
            expect(plan.risk).toBeCloseTo(c.risk!, 6);
        }
    });
    it('includes contract size and quantity in the risk budget', () => {
        expect(revisedEntry({ ...DEFAULT_RESEARCH_CONFIG, quantity: 3 }, 1, 25023, 25020, 25010, 20, 0, 10, 2, 25020).reason).toBe('budget');
        expect(revisedEntry(DEFAULT_RESEARCH_CONFIG, 1, 25023, 25020, 25010, 20, 0, 50, 2, 25020).reason).toBe('budget');
    });
});
