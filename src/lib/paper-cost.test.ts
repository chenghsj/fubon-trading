import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const current = vi.hoisted(() => ({ info: { broker: 'fubon', mode: 'paper' } as { broker: string; mode: string } }));
vi.mock('./server-info-store', () => ({ knownServerInfo: () => current.info }));
beforeEach(() => {
    vi.resetModules();
    current.info = { broker: 'fubon', mode: 'paper' };
    const values = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => values.set(k, v) });
});
afterEach(() => vi.unstubAllGlobals());

it('uses the saved product fee in paper orders and preserves explicit assumptions for other index products', async () => {
    const fees = await import('./contract-fee');
    fees.saveContractFee('TMF', 12);
    const { paperCostPayload } = await import('./paper-cost');
    expect(paperCostPayload({ code: 'TMFK6', security_type: 'FUT' })).toEqual({ paper_cost: { fee_per_side: 12, tax_rate: .00002, fee_source: 'statement' } });
    expect(paperCostPayload({ code: 'MXFK6', security_type: 'FUT' })).toEqual({ paper_cost: { fee_per_side: 20, tax_rate: .00002, fee_source: 'assumed' } });
    fees.saveContractFee('TMF', 16);
    expect(paperCostPayload({ code: 'TMFK6', security_type: 'FUT' }).paper_cost?.fee_per_side).toBe(16);
});

it('never appends local assumptions to sandbox, live, another broker, stocks or options', async () => {
    const { paperCostPayload } = await import('./paper-cost');
    for (const mode of ['sandbox', 'live', 'demo']) {
        current.info.mode = mode;
        expect(paperCostPayload({ code: 'TMFK6', security_type: 'FUT' })).toEqual({});
    }
    current.info = { broker: 'shioaji', mode: 'paper' };
    expect(paperCostPayload({ code: 'TMFK6', security_type: 'FUT' })).toEqual({});
    current.info.broker = 'fubon';
    expect(paperCostPayload({ code: '2330', security_type: 'STK' })).toEqual({});
    expect(paperCostPayload({ code: 'TXO12345K6', security_type: 'OPT' })).toEqual({});
});
