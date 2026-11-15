// Specialized cash-session comparison harness, independent of broker orders and chart state.
import { futuresTax } from './futures-costs';
import { cashAtr, revisedEntry, REVISION_POLICY } from './intraday-policy';
export interface ResearchBar { time: number; open: number; high: number; low: number; close: number; volume: number }
export interface ResearchDataset {
    schema: 'fubon-intraday-v1'; id: string; source: string;
    product: 'TMF' | 'MXF' | 'TXF'; contractMonth: string; multiplier: number;
    start: string; end: string; weightDate: string;
    basket: { code: string; weight: number }[];
    futures: ResearchBar[]; stocks: Record<string, ResearchBar[]>;
    cacheHits?: number; assetCount?: number;
}
export interface ResearchConfig {
    stopPoints: number; targetR: number; quantity: number;
    feeSource?: 'assumed' | 'statement'; taxRounding?: 'per-contract-yuan'; feePerSide: number; slippagePoints: number; taxRate: number;
}
export const DEFAULT_RESEARCH_CONFIG: ResearchConfig = {
    stopPoints: 30, targetR: 2, quantity: 1, feeSource: 'assumed', taxRounding: 'per-contract-yuan', feePerSide: 20, slippagePoints: 1, taxRate: 0.00002,
};
export interface ResearchTrade {
    side: 'long' | 'short'; entryTime: number; exitTime: number; entry: number; exit: number;
    gross: number; costs: number; net: number; reason: string; ambiguous: boolean;
}
export interface ResearchRun {
    trades: ResearchTrade[]; net: number; gross: number; costs: number; maxDrawdown: number;
    winRate: number | null; equity: { time: number; value: number }[];
}
export interface ResearchComparison {
    config: ResearchConfig; baseline: ResearchRun; filtered: ResearchRun;
    context: Pick<ResearchDataset, 'id' | 'source' | 'product' | 'contractMonth' | 'start' | 'end' | 'weightDate'>;
    diagnostics: { completeDays: number; excludedDays: string[]; missingBasketTimes: number; filterRejected: number };
    warnings: string[];
    revision?: { policy: typeof REVISION_POLICY; run: ResearchRun; stressBaseline: ResearchRun; stressRevised: ResearchRun; rejected: Record<string, number> } | null;
}

/** Descriptive net-of-cost sample statistics, never a forecast of future win probability. */
export function researchTradeStats(trades: ResearchTrade[]) {
    const wins = trades.filter(t => t.net > 0), losses = trades.filter(t => t.net < 0);
    const won = wins.reduce((sum, t) => sum + t.net, 0);
    const lost = -losses.reduce((sum, t) => sum + t.net, 0);
    return {
        meanNet: trades.length ? (won - lost) / trades.length : null,
        averageWin: wins.length ? won / wins.length : null,
        averageLoss: losses.length ? lost / losses.length : null,
        profitFactor: losses.length ? won / lost : null,
    };
}

const MINUTE = 60;
const DAY = 86400;
const localDay = (t: number) => Math.floor((t + 8 * 3600) / DAY);
const minuteOfDay = (t: number) => ((t + 8 * 3600) % DAY) / MINUTE;
const dayLabel = (day: number) => new Date(day * DAY * 1000).toISOString().slice(0, 10);

function validateBars(bars: ResearchBar[]) {
    let last = -Infinity;
    for (const b of bars) {
        if (![b.time, b.open, b.high, b.low, b.close, b.volume].every(Number.isFinite)
            || !Number.isInteger(b.time / 60) || b.time <= last || Math.min(b.open, b.high, b.low, b.close) <= 0
            || b.high < Math.max(b.open, b.close) || b.low > Math.min(b.open, b.close) || b.high < b.low || b.volume < 0) {
            throw new Error('歷史資料必須是依時間排序且不重複的有效 1 分 K');
        }
        last = b.time;
    }
}

function validate(dataset: ResearchDataset, config: ResearchConfig) {
    if (dataset.schema !== 'fubon-intraday-v1' || dataset.multiplier !== ({ TMF: 10, MXF: 50, TXF: 200 })[dataset.product]) {
        throw new Error('回測資料版本或期貨乘數不符');
    }
    if (![config.stopPoints, config.targetR, config.quantity, config.feePerSide, config.slippagePoints, config.taxRate].every(Number.isFinite) || !Number.isInteger(config.stopPoints) || config.stopPoints < 1 || config.targetR <= 0
        || !Number.isInteger(config.quantity) || config.quantity < 1 || config.quantity > 100
        || config.feePerSide < 0 || !Number.isInteger(config.slippagePoints) || config.slippagePoints < 0 || config.taxRate < 0 || config.taxRate > .01) {
        throw new Error('請檢查停損、報酬倍數、口數與交易成本');
    }
    const codes = dataset.basket.map(m => m.code);
    if (!codes.length || new Set(codes).size !== codes.length || dataset.basket.some(m => !Number.isFinite(m.weight) || m.weight <= 0)
        || dataset.basket.reduce((s, m) => s + m.weight, 0) > 1.000001) throw new Error('權重名單無效');
    validateBars(dataset.futures);
    if (dataset.futures.some(b => ![b.open, b.high, b.low, b.close].every(Number.isInteger))) throw new Error('台指期貨價格必須符合 1 點跳動單位');
    Object.values(dataset.stocks).forEach(validateBars);
}

/** Decision uses only exact, already-closed stock bars; never fills gaps with later/older prices. */
export function basketMomentum(dataset: ResearchDataset, time: number, maps?: Map<string, Map<number, ResearchBar>>): number | null {
    const index = maps ?? new Map(Object.entries(dataset.stocks).map(([c, bs]) => [c, new Map(bs.map(b => [b.time, b]))]));
    let score = 0;
    for (const member of dataset.basket) {
        const series = index.get(member.code);
        const current = series?.get(time), previous = series?.get(time - 5 * MINUTE);
        if (!current || !previous || localDay(previous.time) !== localDay(time)) return null;
        score += member.weight * (current.close / previous.close - 1);
    }
    return score;
}

/** First version: 09:00–09:15 cash-aligned range; 5m close cross; next 1m open fill.
 * Stop/target are market-on-trigger estimates. Same-minute double touch chooses stop.
 * Both variants share data availability. No optimizer, portfolio margin, or live orders.
 */
export function runIntradayComparison(dataset: ResearchDataset, config: ResearchConfig): ResearchComparison {
    validate(dataset, config);
    const maps = new Map(Object.entries(dataset.stocks).map(([c, bs]) => [c, new Map(bs.map(b => [b.time, b]))]));
    const grouped = new Map<number, ResearchBar[]>();
    for (const b of dataset.futures) {
        const m = minuteOfDay(b.time);
        if (m <= 540 || m > 800) continue; // (09:00,13:20], close-label timestamps
        const d = localDay(b.time);
        if (!grouped.has(d)) grouped.set(d, []);
        grouped.get(d)!.push(b);
    }
    const days: ResearchBar[][] = [], excludedDays: string[] = [];
    for (const [d, bars] of grouped) {
        if (bars.length !== 260 || bars.some((b, i) => minuteOfDay(b.time) !== 541 + i)) excludedDays.push(dayLabel(d));
        else days.push(bars);
    }
    if (!days.length) throw new Error('沒有完整的日盤資料：每個交易日需含 09:01–13:20 的 260 根 1 分 K');
    const missing = new Set<number>();
    let filterRejected = 0;

    function simulate(filtered: boolean, revised = false, extraSlip = 0, rejected: Record<string, number> = {}): ResearchRun {
        const trades: ResearchTrade[] = [], equity: ResearchRun['equity'] = [];
        let balance = 0, peak = 0, drawdown = 0;
        const size = dataset.multiplier * config.quantity;
        const slippage = config.slippagePoints + extraSlip;
        const cost = (price: number) => config.feePerSide * config.quantity + futuresTax(price, dataset.multiplier, config.taxRate, config.quantity);
        for (const bars of days) {
            const dayStartBalance = balance;
            const high = Math.max(...bars.slice(0, 15).map(b => b.high));
            const low = Math.min(...bars.slice(0, 15).map(b => b.low));
            const used = new Set<number>();
            let pending = 0;
            let signal: { close: number; boundary: number; atr: number | null } | null = null;
            let position: { side: number; entry: number; entryTime: number; entryCost: number; stop: number; target: number } | null = null;
            for (let i = 0; i < bars.length; i++) {
                const b = bars[i]!;
                if (pending && !position) {
                    const side = pending;
                    const entry = b.open + side * slippage;
                    if (entry <= 0) throw new Error('滑價設定產生無效成交價格');
                    pending = 0;
                    const plan = revised ? revisedEntry(config, side, entry, signal!.close, signal!.boundary, signal!.atr, balance - dayStartBalance, dataset.multiplier, slippage, b.open)
                        : { reason: null, stopPoints: config.stopPoints, targetPoints: Math.ceil(config.stopPoints * config.targetR) };
                    if (plan.reason) rejected[plan.reason] = (rejected[plan.reason] ?? 0) + 1;
                    else {
                        position = { side, entry, entryTime: b.time - MINUTE, entryCost: cost(entry),
                            stop: entry - side * plan.stopPoints!, target: entry + side * plan.targetPoints! };
                        balance -= position.entryCost;
                        used.add(side);
                    }
                }
                if (position) {
                    const p = position;
                    const stopHit = p.side > 0 ? b.low <= p.stop : b.high >= p.stop;
                    const targetHit = p.side > 0 ? b.high >= p.target : b.low <= p.target;
                    const gapStop = p.side > 0 ? b.open <= p.stop : b.open >= p.stop;
                    const gapTarget = p.side > 0 ? b.open >= p.target : b.open <= p.target;
                    let exit: number | undefined;
                    let reason = '';
                    const ambiguous = !gapStop && !gapTarget && stopHit && targetHit;
                    if (gapStop) { exit = b.open; reason = '跳空停損'; }
                    else if (gapTarget) { exit = p.target; reason = '停利'; }
                    else if (stopHit) { exit = p.stop; reason = ambiguous ? '同根雙觸，採停損' : '停損'; }
                    else if (targetHit) { exit = p.target; reason = '停利'; }
                    else if (i === bars.length - 1) { exit = b.close; reason = '13:20 日內平倉'; }
                    if (exit !== undefined) {
                        exit -= p.side * slippage;
                        if (exit <= 0) throw new Error('滑價設定產生無效平倉價格');
                        const gross = (exit - p.entry) * p.side * size;
                        const costs = p.entryCost + cost(exit);
                        trades.push({ side: p.side > 0 ? 'long' : 'short', entryTime: p.entryTime, exitTime: b.time,
                            entry: p.entry, exit, gross, costs, net: gross - costs, reason, ambiguous });
                        balance += gross - cost(exit);
                        position = null;
                    }
                }
                const marked = balance + (position ? (b.close - position.entry) * position.side * size : 0);
                peak = Math.max(peak, marked);
                drawdown = Math.max(drawdown, peak - marked);
                equity.push({ time: b.time, value: marked });
                const m = minuteOfDay(b.time);
                if (position || m < 560 || m > 790 || m % 5 !== 0) continue; // 09:20–13:10 decisions
                const previous = bars[i - 5]!;
                let side = 0;
                if (b.close > high && previous.close <= high) side = 1;
                else if (b.close < low && previous.close >= low) side = -1;
                if (!side || used.has(side)) continue;
                const score = basketMomentum(dataset, b.time, maps);
                if (score === null) { if (!revised && !extraSlip) missing.add(b.time); continue; }
                if (filtered && score * side <= 0) { filterRejected++; continue; }
                pending = side;
                signal = { close: b.close, boundary: side > 0 ? high : low, atr: revised ? cashAtr(bars, b.time) : null };
            }
        }
        return { trades, equity, net: balance, gross: trades.reduce((s, t) => s + t.gross, 0),
            costs: trades.reduce((s, t) => s + t.costs, 0), maxDrawdown: drawdown,
            winRate: trades.length ? trades.filter(t => t.net > 0).length / trades.length : null };
    }
    const baseline = simulate(false), filtered = simulate(true);
    const rejected: Record<string, number> = {};
    const revision = { policy: REVISION_POLICY, run: simulate(false, true, 0, rejected),
        stressBaseline: simulate(false, false, 2), stressRevised: simulate(false, true, 2), rejected };
    return { config: { ...config, taxRounding: 'per-contract-yuan' }, baseline, filtered, revision,
        context: { id: dataset.id, source: dataset.source, product: dataset.product, contractMonth: dataset.contractMonth,
            start: dataset.start, end: dataset.end, weightDate: dataset.weightDate },
        diagnostics: { completeDays: days.length, excludedDays, missingBasketTimes: missing.size, filterRejected },
        warnings: [
            ...(dataset.source === 'synthetic' ? ['合成展示資料僅驗證流程，不代表市場績效。'] : []),
            '權重為固定假設版本，並非已驗證的逐日歷史成分；有事後選股與權重偏誤。',
            ...(dataset.weightDate > dataset.start ? ['權重日期晚於回測開始日，屬事後假設情境。'] : []),
            '以 5 分收盤判斷、下一根 1 分開盤加不利滑價成交；不含行情傳輸延遲、排隊、部分成交與保證金限制。',
            '日期完整性尚未比對交易所休市日曆；完整日僅計有觀測的日期，整日無資料不列入缺段日。',
            '期交稅依每口每邊成交價計算、元以下四捨五入；保存舊版結果保留當時的未取整估計。',
            '停損停利同根觸及採停損；回撤以分鐘收盤估值，可能低估根內風險。',
            '三組均僅在權值股資料同步可用時進場；結果不包含樣本外驗證。',
            'V2 為固定規則的研究候選：1 分 Wilder ATR14 × 1.5、10 點偏離門檻、1000 元含成本預算；未自動調參。多 2 點每邊滑價為固定壓力情境，不代表實際 IOC 成交。',
        ],
    };
}
