// src/lib/utils/kbars.ts — KBars column arrays -> candles, aggregation

import type { Candle, KBars } from '../types/market';

// kbar datetimes are Taiwan local; encode wall-clock as UTC so the chart
// axis shows Taiwan session times regardless of viewer timezone.
export function wallClockToUtc(dt: string): number {
    const y = Number(dt.slice(0, 4));
    const mo = Number(dt.slice(5, 7));
    const d = Number(dt.slice(8, 10));
    const h = Number(dt.slice(11, 13)) || 0;
    const mi = Number(dt.slice(14, 16)) || 0;
    const s = Number(dt.slice(17, 19)) || 0;
    return Date.UTC(y, mo - 1, d, h, mi, s) / 1000;
}

export function kbarsToCandles(k: KBars): Candle[] {
    const out: Candle[] = [];
    for (let i = 0; i < k.datetime.length; i++) {
        const dt = k.datetime[i];
        if (!dt) continue;
        out.push({
            time: wallClockToUtc(dt),
            open: k.Open[i] ?? 0,
            high: k.High[i] ?? 0,
            low: k.Low[i] ?? 0,
            close: k.Close[i] ?? 0,
            volume: k.Volume[i] ?? 0,
        });
    }
    out.sort((a, b) => a.time - b.time);
    return out;
}

// Calendar buckets use Taiwan wall-clock encoded as UTC, like the source bars.
// Week labels are Mondays; month labels are the first day, including short months.
// 10080 / 43200 are timeframe identifiers, not fixed-length week/month arithmetic.
export function candleBucket(time: number, minutes: number, source: 'history' | 'tick' = 'history'): number {
    // A history label at 00:00 closes the previous day's 23:59 minute.
    const calendarTime = source === 'history' ? time - 60 : time;
    const day = Math.floor(calendarTime / 86400) * 86400;
    if (minutes === 43200) {
        const date = new Date(calendarTime * 1000);
        return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1) / 1000;
    }
    if (minutes === 10080) {
        const weekday = new Date(calendarTime * 1000).getUTCDay();
        return day - ((weekday + 6) % 7) * 86400;
    }
    if (minutes >= 1440) return day;
    const seconds = minutes * 60;
    return source === 'tick'
        ? Math.floor(time / seconds) * seconds + seconds
        : Math.ceil(time / seconds) * seconds;
}

// Aggregate 1-minute candles into N-minute, daily, weekly or monthly bars.
// 1 分 K 是 close-label-right（label 08:46 = 08:45:00–08:45:59 成交），
// N 分 K 必須沿用同一慣例：ceil 到桶的收盤 label（5 分 K = 08:50、
// 08:55…13:45，08:50 那根 = label 08:46–08:50）。floor 會整體早移
// 一分鐘且開盤桶只剩 4 根。日 K 維持日曆日。
export function aggregate(candles: Candle[], minutes: number): Candle[] {
    if (minutes <= 1) return candles;
    const out: Candle[] = [];
    let cur: Candle | null = null;
    for (const c of candles) {
        const bucket = candleBucket(c.time, minutes);
        if (!cur || cur.time !== bucket) {
            if (cur) out.push(cur);
            cur = { ...c, time: bucket };
        } else {
            cur.high = Math.max(cur.high, c.high);
            cur.low = Math.min(cur.low, c.low);
            cur.close = c.close;
            cur.volume += c.volume;
        }
    }
    if (cur) out.push(cur);
    return out;
}

// 台灣（交易所）時間 UTC+8、無日光節約 — 與本機時區無關，海外或
// 系統時區不是台北的使用者也要拿到同一套時段/日期
const TW_OFFSET_SEC = 8 * 3600;

// 現在時刻的台灣牆鐘時間，用 wallClockToUtc 同款編碼
export function nowWallClockUtc(): number {
    return Math.floor(Date.now() / 1000) + TW_OFFSET_SEC;
}

// Include the complete first calendar bar when history starts midweek/month.
// Align every page, including the history floor, so pagination never invents
// a partial oldest week's/month's OHLC or volume.
export function calendarHistoryDays(daysAgo: number, minutes: number): number {
    const today = Math.floor(nowWallClockUtc() / 86400) * 86400;
    return Math.round((today - candleBucket(today - daysAgo * 86400, minutes, 'tick')) / 86400);
}

// 台灣日期 N 天前（負數 = 之後）的 YYYY-MM-DD
export function dateStrOffset(daysAgo: number): string {
    const d = new Date(
        Date.now() + TW_OFFSET_SEC * 1000 - daysAgo * 86400_000,
    );
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}
