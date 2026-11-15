import { futuresTax } from './futures-costs';
import type { ResearchBar, ResearchConfig } from './intraday-research';

export const REVISION_POLICY = { version: 'orb_atr_v2', atrPeriod: 14, atrMultiplier: 1.5, maxEntryDrift: 10, lossLimit: 1000 } as const;

/** Wilder ATR, reset at cash-session start; only contiguous completed minutes. */
export function cashAtr(bars: ResearchBar[], decision: number): number | null {
    const start = Math.floor((decision + 8 * 3600) / 86400) * 86400 - 8 * 3600 + 9 * 3600;
    const closed = bars.filter(b => b.time > start && b.time <= decision);
    const count = (decision - start) / 60;
    if (count < 14 || closed.length !== count || closed.some((b, i) => b.time !== start + (i + 1) * 60)) return null;
    let atr = 0, seed = 0;
    for (let i = 0; i < closed.length; i++) {
        const b = closed[i]!, previous = closed[i - 1]?.close;
        const tr = previous === undefined ? b.high - b.low : Math.max(b.high - b.low, Math.abs(b.high - previous), Math.abs(b.low - previous));
        if (i < 14) { seed += tr; if (i === 13) atr = seed / 14; }
        else atr = (atr * 13 + tr) / 14;
    }
    return atr;
}

export function revisedEntry(config: ResearchConfig, side: number, entry: number, close: number, boundary: number, atr: number | null, dayNet: number, multiplier: number, slippage: number, marketPrice: number) {
    if ((marketPrice - boundary) * side <= 0 || (entry - boundary) * side <= 0) return { reason: 'breakout' } as const;
    if (Math.abs(entry - close) > REVISION_POLICY.maxEntryDrift) return { reason: 'drift' } as const;
    if (atr === null || !Number.isFinite(atr) || atr <= 0) return { reason: 'warmup' } as const;
    const stopPoints = Math.max(config.stopPoints, Math.ceil(REVISION_POLICY.atrMultiplier * atr));
    const targetPoints = Math.ceil(stopPoints * config.targetR);
    const worst = Math.max(1, entry - side * (stopPoints + slippage));
    const risk = (stopPoints + slippage) * multiplier * config.quantity + config.feePerSide * config.quantity * 2
        + (futuresTax(entry, multiplier, config.taxRate, config.quantity) + futuresTax(worst, multiplier, config.taxRate, config.quantity));
    if (risk > Math.min(REVISION_POLICY.lossLimit, REVISION_POLICY.lossLimit + dayNet)) return { reason: 'budget' } as const;
    return { reason: null, stopPoints, targetPoints, risk } as const;
}
