import { getContractFee } from './contract-fee';
export interface AutoAccount { account_type: 'F'; broker_id: string; account_id: string }
export interface AutoConfig {
    account: AutoAccount; contract_code: string; trade_date: string;
    stop_points: number; target_points: number; slippage_points: number;
    max_entries: number; loss_limit: number; fee_per_side: number; tax_rate: number;
    strategy_version?: 'orb_v1' | 'orb_atr_v2'; fee_source?: 'assumed' | 'statement';
    model_run_id?: string | null;
    use_basket: boolean; basket: { code: string; weight: number }[];
}
export interface AutoOrder {
    tag: string; role: 'entry' | 'exit'; action: 'Buy' | 'Sell'; limit: number;
    status: string; filled: number; fillPrice: number | null; orderId: string | null;
    submittedAt: number; cancelRequested: boolean; entryTag: string | null;
}
export interface AutoState {
    id: string | null; status: 'idle' | 'running' | 'paused' | 'stopping' | 'stopped' | 'attention' | 'completed' | 'archived';
    reason: string; config: AutoConfig | null; mode: string; available: boolean; owned: boolean; monitoring: boolean;
    leaseSeconds: number; entryCount: number; pending: string | null; executionBlocked: boolean;
    realizedNet: number | null; unrealizedNet: number | null; updatedAt: string | null;
    position: { side: 'Buy' | 'Sell'; quantity: number; entryPrice: number | null; referencePrice: number; referenceType?: 'fill' | 'limit'; stop: number; target: number; exitDeadline?: number } | null;
    quote: { price: number; time: number; bid: number; ask: number; trial: boolean } | null;
    lastSignal: { time: number; side: 'Buy' | 'Sell' | null; high: number | null; low: number | null; score: number | null; close?: number; atr?: number | null; reason: string;
        model?: { runId: string; hash: string; score: number | null; threshold: number; accepted: boolean; reason: string } } | null;
    orders: AutoOrder[]; events: { id: number; time: string; kind: string; message: string }[];
}
export const AUTO_STATUS: Record<AutoState['status'], string> = {
    idle: '尚未啟動', running: '策略執行中', paused: '新倉已暫停', stopping: '正在停止並退出',
    stopped: '已停止', attention: '需要處理', completed: '本次日盤已結束', archived: '已人工封存',
};
export function nextAutoTradeDate(epoch = Date.now()): string {
    const local = new Date(epoch + 8 * 3600000);
    if (local.getUTCHours() * 60 + local.getUTCMinutes() >= 790) local.setUTCDate(local.getUTCDate() + 1);
    while (local.getUTCDay() === 0 || local.getUTCDay() === 6) local.setUTCDate(local.getUTCDate() + 1);
    return local.toISOString().slice(0, 10);
}
export function initialAutoConfig(): AutoConfig {
    const day = nextAutoTradeDate(), fee = getContractFee('TMF');
    return { account: { account_type: 'F', broker_id: '', account_id: '' },
        contract_code: `TMF${'ABCDEFGHIJKL'[Number(day.slice(5, 7)) - 1]}${day[3]}`, trade_date: day,
        stop_points: 30, target_points: 60, slippage_points: 2, max_entries: 2, loss_limit: 1000,
        strategy_version: 'orb_v1', fee_source: fee ? 'statement' : 'assumed',
        fee_per_side: fee?.feePerSide ?? 20, tax_rate: .00002, use_basket: false,
        basket: [{ code: '2330', weight: .4 }, { code: '2454', weight: .04 }, { code: '2317', weight: .02 }, { code: '2881', weight: .01 }],
    };
}
export const autoAccountKey = (a: AutoAccount) => `${a.broker_id}:${a.account_id}`;
export function parseAutoBasket(text: string): AutoConfig['basket'] {
    const members = text.trim().split('\n').filter(line => line.trim()).map(line => {
        const [rawCode = '', rawWeight, ...extra] = line.split(/[,，]/);
        const code = rawCode.trim(), weight = Number(rawWeight) / 100;
        if (!/^\d{4,6}$/.test(code) || !rawWeight?.trim() || extra.length || !Number.isFinite(weight) || weight <= 0 || weight > 1) throw new Error('每行請輸入股票代碼與權重百分比，例如 2330,40');
        return { code, weight };
    });
    if (!members.length || members.length > 12 || new Set(members.map(m => m.code)).size !== members.length || members.reduce((sum, m) => sum + m.weight, 0) > 1.000001) throw new Error('請輸入 1–12 檔不重複股票，權重合計不超過 100%');
    return members;
}
