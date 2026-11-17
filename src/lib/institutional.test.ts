import { describe, expect, it } from 'vitest';
import { formatShares, formatShareTick, institutionalRows, institutionalSeries, institutionalTotal } from './institutional';

describe('法人籌碼顯示轉換', () => {
    it('把截圖中的 2301 股數轉成張，保留零股精度和買賣超符號', () => {
        expect(formatShares(13148681, 'lots')).toBe('13,148.681');
        expect(formatShares(-1865105, 'lots', true)).toBe('-1,865.105');
        expect(formatShares(476000, 'lots', true)).toBe('+476');
        expect(formatShares(13148681, 'shares')).toBe('13,148,681');
        expect(formatShares(0, 'lots', true)).toBe('0');
        for (const value of [null, undefined, '', '1000', NaN, Infinity]) {
            expect(formatShares(value, 'lots')).toBe('—');
        }
    });
    it('依日期排序而不修改來源，也不補出來源未回傳的交易日', () => {
        const input = [{ date: '2026-11-16', total: -2000 }, { date: '2026-11-10', total: 1501 }];
        const rows = institutionalRows(input);
        expect(rows.map(row => row.date)).toEqual(['2026-11-10', '2026-11-16']);
        expect(institutionalSeries(rows, 'total', true)).toEqual([1501, -499]);
        expect(institutionalTotal(rows, 'total')).toBe(-499);
        expect(input[0]!.date).toBe('2026-11-16');
    });
    it('任一筆缺值使完整合計未知，累計走勢從缺值起不再推造數值', () => {
        const rows = [{ total: 1000 }, { total: null }, { total: -100 }];
        expect(institutionalTotal(rows, 'total')).toBeNull();
        expect(institutionalSeries(rows, 'total', true)).toEqual([1000, null, null]);
        expect(institutionalSeries(rows, 'total', false)).toEqual([1000, null, -100]);
        expect(institutionalTotal([], 'total')).toBeNull();
        expect(institutionalTotal([{ total: 0 }], 'total')).toBe(0);
    });
    it('零股規模的張數刻度與半格刻度不會被四捨五入成零', () => {
        expect(formatShareTick(1, 'lots')).toBe('0.001');
        expect(formatShareTick(0.5, 'lots')).toBe('0.0005');
        expect(formatShareTick(-0.5, 'lots')).toBe('-0.0005');
        expect(formatShareTick(0.5, 'shares')).toBe('0.5');
        expect(formatShareTick(0, 'lots')).toBe('0');
    });
});
