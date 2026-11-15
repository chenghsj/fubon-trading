import { describe, expect, it } from 'vitest';
import { basketMomentum, DEFAULT_RESEARCH_CONFIG, researchTradeStats, runIntradayComparison, type ResearchDataset, type ResearchTrade } from './intraday-research';

function fixture(): ResearchDataset {
    const start = Date.parse('2026-11-10T09:00:00+08:00') / 1000;
    const futures = Array.from({ length: 260 }, (_, i) => {
        const c = i >= 19 ? 102 : 100;
        return { time: start + (i + 1) * 60, open: c, high: c + 1, low: c - 1, close: c, volume: 10 };
    });
    const stock = futures.map((b, i) => ({ ...b, open: 100 + i, close: 100 + i, high: 101 + i, low: 99 + i }));
    return { schema: 'fubon-intraday-v1', id: 'test', source: 'synthetic', product: 'TMF', contractMonth: '202611', multiplier: 10,
        start: '2026-11-10', end: '2026-11-10', weightDate: '2026-11-01', basket: [{ code: '2330', weight: .4 }], futures, stocks: { '2330': stock } };
}
const config = { ...DEFAULT_RESEARCH_CONFIG, stopPoints: 10, slippagePoints: 0, feePerSide: 0, taxRate: 0 };

describe('cash-session intraday comparison', () => {
    it('shows negative average net despite more winners than losers and leaves empty statistics undefined', () => {
        const trade = runIntradayComparison(fixture(), config).baseline.trades[0]!;
        const sample: ResearchTrade[] = [10, 10, 10, -100, 0].map(net => ({ ...trade, net }));
        expect(researchTradeStats(sample)).toEqual({ meanNet: -14, averageWin: 10, averageLoss: 100, profitFactor: .3 });
        expect(researchTradeStats([])).toEqual({ meanNet: null, averageWin: null, averageLoss: null, profitFactor: null });
        expect(researchTradeStats([trade]).profitFactor).toBeNull();
    });
    it('enters only after range completion and a 5m close, on the next 1m open', () => {
        const d = fixture();
        d.futures[20]!.open = 105; d.futures[20]!.high = 106;
        const result = runIntradayComparison(d, config);
        const trade = result.baseline.trades[0]!;
        expect(trade.entryTime).toBe(Date.parse('2026-11-10T09:20:00+08:00') / 1000);
        expect(trade.entry).toBe(105);
        expect(trade.reason).toBe('13:20 日內平倉');
        expect(result.filtered.trades).toEqual(result.baseline.trades);
    });
    it('uses stop first for unknown same-minute stop/target ordering and includes both-side fees and slippage', () => {
        const d = fixture();
        d.futures[21]!.low = 50; d.futures[21]!.high = 200;
        const result = runIntradayComparison(d, { ...config, slippagePoints: 1, feePerSide: 20 });
        const trade = result.baseline.trades[0]!;
        expect(trade).toMatchObject({ entry: 103, exit: 92, gross: -110, costs: 40, net: -150, ambiguous: true });
        expect(result.baseline.net).toBe(-150);
        expect(result.baseline.maxDrawdown).toBeGreaterThanOrEqual(150);
    });
    it('fills a gap through a stop at the adverse open instead of the stop level', () => {
        const d = fixture();
        d.futures[21] = { ...d.futures[21]!, open: 70, high: 71, low: 69, close: 70 };
        expect(runIntradayComparison(d, config).baseline.trades[0]).toMatchObject({ exit: 70, reason: '跳空停損', net: -320 });
    });
    it('rejects a long when the weighted cash basket moves down, while preserving the baseline', () => {
        const d = fixture();
        d.stocks['2330'] = d.stocks['2330']!.map((b, i) => ({ ...b, open: 1000 - i, close: 1000 - i, high: 1001 - i, low: 999 - i }));
        const result = runIntradayComparison(d, config);
        expect(result.baseline.trades).toHaveLength(1);
        expect(result.filtered.trades).toHaveLength(0);
        expect(result.filtered.winRate).toBeNull();
        expect(result.diagnostics.filterRejected).toBe(1);
    });
    it('never takes a stock price from the future or carries an old quote across missing data', () => {
        const d = fixture(), at = d.futures[19]!.time;
        const before = basketMomentum(d, at);
        d.stocks['2330']![20] = { ...d.stocks['2330']![20]!, close: 9000, high: 9001 };
        expect(basketMomentum(d, at)).toBe(before);
        d.stocks['2330'] = d.stocks['2330']!.filter(b => b.time !== at);
        expect(basketMomentum(d, at)).toBeNull();
        const result = runIntradayComparison(d, config);
        expect(result.baseline.trades).toHaveLength(0);
        expect(result.filtered.trades).toHaveLength(0);
        expect(result.diagnostics.missingBasketTimes).toBe(1);
    });
    it('excludes incomplete futures days and rejects duplicate bars and invalid costs', () => {
        const d = fixture(); d.futures.splice(30, 1);
        expect(() => runIntradayComparison(d, config)).toThrow('沒有完整');
        const duplicate = fixture(); duplicate.futures.splice(1, 0, duplicate.futures[0]!);
        expect(() => runIntradayComparison(duplicate, config)).toThrow('不重複');
        expect(() => runIntradayComparison(fixture(), { ...config, quantity: 1.5 })).toThrow('請檢查');
    });
    it('tracks price-based tax on each fill and reports scenario provenance limitations', () => {
        const d = fixture(); d.weightDate = '2026-11-15';
        const result = runIntradayComparison(d, { ...config, taxRate: .00002 });
        expect(result.baseline.trades[0]!.costs).toBeCloseTo(0);
        expect(result.warnings.join(' ')).toMatch(/事後假設/);
        expect(result.warnings.join(' ')).toMatch(/合成展示/);
    });
    it('rounds fractional R targets away to a valid one-point price and rejects half-point slippage', () => {
        const d = fixture();
        d.futures[20]!.low = 102;
        d.futures[21]!.low = 102; d.futures[21]!.high = 104;
        const trade = runIntradayComparison(d, { ...config, stopPoints: 1, targetR: 1.5 }).baseline.trades[0]!;
        expect(trade).toMatchObject({ entry: 102, exit: 104, gross: 20 });
        expect(() => runIntradayComparison(d, { ...config, slippagePoints: .5 })).toThrow('請檢查');
    });
    it('rejects a failed breakout on both sides even when adverse slippage would push it outside the range', () => {
        for (const side of [1, -1]) {
            const d = fixture();
            if (side < 0) for (const b of d.futures) {
                const { open, high, low, close } = b;
                Object.assign(b, { open: 200 - open, high: 200 - low, low: 200 - high, close: 200 - close });
            }
            d.futures[20] = { ...d.futures[20]!, open: 100, high: 101, low: 99, close: 100 };
            const result = runIntradayComparison(d, { ...config, slippagePoints: 2 });
            expect(result.baseline.trades).toHaveLength(1);
            expect(result.revision?.run.trades).toHaveLength(0);
            expect(result.revision?.rejected.breakout).toBe(1);
            expect(result.revision?.stressRevised.trades).toHaveLength(0);
        }
    });
    it('freezes the signal-time ATR distance and retains net-cost arithmetic in all scenarios', () => {
        const d = fixture();
        d.futures[21] = { ...d.futures[21]!, low: 98, high: 200 };
        const result = runIntradayComparison(d, { ...config, stopPoints: 1, feePerSide: 12, feeSource: 'statement' });
        expect(result.revision?.run.trades[0]).toMatchObject({ entry: 102, exit: 98, net: -64, ambiguous: true });
        for (const run of [result.baseline, result.filtered, result.revision!.run, result.revision!.stressBaseline, result.revision!.stressRevised]) {
            expect(run.net).toBeCloseTo(run.trades.reduce((sum, t) => sum + t.net, 0));
            expect(run.gross - run.costs).toBeCloseTo(run.net);
        }
        expect(result.config).toMatchObject({ feePerSide: 12, feeSource: 'statement', taxRounding: 'per-contract-yuan' });
    });
});
