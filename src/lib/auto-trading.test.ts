import { describe, expect, it } from 'vitest';
import { nextAutoTradeDate, parseAutoBasket } from './auto-trading';

describe('sandbox automation setup', () => {
    it('defaults to the next weekday after the day-session entry cutoff', () => {
        expect(nextAutoTradeDate(Date.parse('2026-11-13T13:10:00+08:00'))).toBe('2026-11-16');
        expect(nextAutoTradeDate(Date.parse('2026-11-15T08:00:00+08:00'))).toBe('2026-11-16');
        expect(nextAutoTradeDate(Date.parse('2026-11-16T08:00:00+08:00'))).toBe('2026-11-16');
    });
    it('parses completed editable basket text and rejects duplicate or overallocated weights', () => {
        expect(parseAutoBasket('2330,40\n2454,4')).toEqual([{ code: '2330', weight: .4 }, { code: '2454', weight: .04 }]);
        expect(() => parseAutoBasket('2330,')).toThrow('每行');
        expect(() => parseAutoBasket('2330,60\n2330,30')).toThrow('不重複');
        expect(() => parseAutoBasket('2330,90\n2454,20')).toThrow('100%');
    });
});
