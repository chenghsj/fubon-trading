// src/lib/utils/kbars.test.ts — aggregate() 必須沿用 shioaji 1 分 K 的
// close-label-right 慣例：N 分 K 的 label 是桶的收盤分鐘（5 分 K =
// 08:50、08:55…13:45），不是開盤分鐘。

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Candle } from '../types/market';
import {
    aggregate,
    candleBucket,
    calendarHistoryDays,
    dateStrOffset,
    nowWallClockUtc,
    wallClockToUtc,
} from './kbars';

const t = (s: string) => wallClockToUtc(s);

// labels (from, to] 的 1 分 K，價格遞增方便驗 OHLC
function minBars(from: string, to: string): Candle[] {
    const out: Candle[] = [];
    let i = 0;
    for (let m = t(from) + 60; m <= t(to); m += 60) {
        i += 1;
        out.push({
            time: m,
            open: i,
            high: i + 0.5,
            low: i - 0.5,
            close: i + 0.25,
            volume: 10,
        });
    }
    return out;
}

describe('aggregate close-label-right', () => {
    it('day-session open: labels 08:46-08:50 form the 08:50 bar', () => {
        const bars = aggregate(
            minBars('2026-08-12T08:45:00', '2026-08-12T08:55:00'),
            5,
        );
        expect(bars.map((b) => b.time)).toEqual([
            t('2026-08-12T08:50:00'),
            t('2026-08-12T08:55:00'),
        ]);
        // 08:50 bar = 五根 1 分 K（08:46-08:50）
        expect(bars[0]!.open).toBe(1); // label 08:46 的 open
        expect(bars[0]!.close).toBe(5.25); // label 08:50 的 close
        expect(bars[0]!.volume).toBe(50);
    });

    it('boundary label lands in its own closing bucket (08:50→08:50)', () => {
        const one = minBars('2026-08-12T08:49:00', '2026-08-12T08:50:00');
        const bars = aggregate(one, 5);
        expect(bars).toHaveLength(1);
        expect(bars[0]!.time).toBe(t('2026-08-12T08:50:00'));
    });

    it('full TXF day session yields 60 bars ending 13:45', () => {
        const bars = aggregate(
            minBars('2026-08-12T08:45:00', '2026-08-12T13:45:00'),
            5,
        );
        expect(bars).toHaveLength(60);
        expect(bars[0]!.time).toBe(t('2026-08-12T08:50:00'));
        expect(bars[bars.length - 1]!.time).toBe(t('2026-08-12T13:45:00'));
        // 每桶滿 5 根
        expect(bars.every((b) => b.volume === 50)).toBe(true);
    });

    it('stock session 09:01-13:30 → 09:05 … 13:30', () => {
        const bars = aggregate(
            minBars('2026-08-12T09:00:00', '2026-08-12T13:30:00'),
            5,
        );
        expect(bars[0]!.time).toBe(t('2026-08-12T09:05:00'));
        expect(bars[bars.length - 1]!.time).toBe(t('2026-08-12T13:30:00'));
    });

    it('daily keeps calendar-day floor labels', () => {
        const bars = aggregate(
            minBars('2026-08-12T09:00:00', '2026-08-12T10:00:00'),
            1440,
        );
        expect(bars).toHaveLength(1);
        expect(bars[0]!.time).toBe(t('2026-08-12T00:00:00'));
    });

    it('1-minute passthrough unchanged', () => {
        const src = minBars('2026-08-12T09:00:00', '2026-08-12T09:03:00');
        expect(aggregate(src, 1)).toBe(src);
    });
});

describe('calendar candles', () => {
    const bars = (...dates: string[]): Candle[] => dates.map((date, i) => ({
        time: t(`${date}T13:30:00`), open: 100 + i, high: 110 + i,
        low: 90 - i, close: 105 + i, volume: 10,
    }));

    it('groups Monday through Sunday, including a week crossing the year boundary', () => {
        const result = aggregate(bars('2026-12-28', '2026-12-31', '2027-01-01', '2027-01-04'), 10080);
        expect(result).toEqual([
            { time: t('2026-12-28'), open: 100, high: 112, low: 88, close: 107, volume: 30 },
            { time: t('2027-01-04'), open: 103, high: 113, low: 87, close: 108, volume: 10 },
        ]);
        expect(candleBucket(t('2027-01-03T23:59:00'), 10080, 'tick')).toBe(t('2026-12-28'));
    });

    it('uses calendar months across leap day and the year boundary', () => {
        const result = aggregate(bars('2027-12-31', '2028-01-03', '2028-02-01', '2028-02-29', '2028-03-01'), 43200);
        expect(result.map(b => b.time)).toEqual(['2027-12-01', '2028-01-01', '2028-02-01', '2028-03-01'].map(t));
        expect(result[2]).toEqual({ time: t('2028-02-01'), open: 102, high: 113, low: 87, close: 108, volume: 20 });
    });

    it.each([1440, 10080, 43200])('uses the same bucket for history and live ticks at timeframe %i', minutes => {
        for (const date of ['2026-12-31T13:30:00', '2027-01-01T09:01:00', '2027-01-04T09:01:00']) {
            expect(candleBucket(t(date), minutes, 'tick')).toBe(aggregate(bars(date.slice(0, 10)), minutes)[0]!.time);
        }
    });

    it('keeps the distinct intraday history and live boundary labels', () => {
        expect(candleBucket(t('2026-11-17T09:05:00'), 5)).toBe(t('2026-11-17T09:05:00'));
        expect(candleBucket(t('2026-11-17T09:05:00'), 5, 'tick')).toBe(t('2026-11-17T09:10:00'));
    });

    it.each([
        [1440, '2026-11-30', '2026-12-01'],
        [10080, '2026-12-27', '2026-12-28'],
        [43200, '2026-12-31', '2027-01-01'],
    ])('keeps the closing midnight history minute with its live %i candle', (minutes, lastDay, nextDay) => {
        const liveBucket = candleBucket(t(`${lastDay}T23:59:30`), Number(minutes), 'tick');
        expect(candleBucket(t(`${nextDay}T00:00:00`), Number(minutes))).toBe(liveBucket);
        expect(candleBucket(t(`${nextDay}T00:00:00`), Number(minutes), 'tick')).not.toBe(liveBucket);
    });
});

// 時段判斷一律用台灣交易所時間 — 不能隨本機時區漂移（CI 跑 UTC、
// 海外使用者）
describe('Taiwan wall clock is independent of the machine timezone', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('nowWallClockUtc encodes Taiwan local time', () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-09-25T12:00:30Z')); // 台北 20:00:30
        expect(nowWallClockUtc()).toBe(wallClockToUtc('2026-09-25T20:00:30'));
    });

    it('dateStrOffset uses the Taiwan date across the UTC day boundary', () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-09-24T17:30:00Z')); // 台北 09-25 01:30
        expect(dateStrOffset(0)).toBe('2026-09-25');
        expect(dateStrOffset(1)).toBe('2026-09-24');
        expect(dateStrOffset(-1)).toBe('2026-09-26');
    });

    it('extends calendar history to the first Monday or first day of the month', () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-11-17T01:00:00Z'));
        expect(dateStrOffset(calendarHistoryDays(240, 10080))).toBe('2026-03-16');
        expect(dateStrOffset(calendarHistoryDays(240, 43200))).toBe('2026-03-01');
        expect(calendarHistoryDays(240, 1440)).toBe(240);
        // All calendar pages stay within the server's 365-day query cap.
        for (const minutes of [10080, 43200]) {
            let oldest = 0;
            for (let page = 0; page < 5; page++) {
                const from = calendarHistoryDays(oldest + 240, minutes);
                expect(from - oldest).toBeLessThan(365);
                oldest = from;
            }
        }
    });
});
