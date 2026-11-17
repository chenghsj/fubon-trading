import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ fetch: vi.fn(), base: 'fixture' }));
vi.mock('./runtime', () => ({ getApiBase: () => mocks.base }));
vi.mock('./shioaji', () => ({ fetchKbars: mocks.fetch }));
const contract = { code: '2330', exchange: 'TSE', security_type: 'STK', target_code: null } as const;
beforeEach(() => { vi.resetModules(); mocks.fetch.mockReset().mockResolvedValue({ Close: [100] }); mocks.base = 'fixture'; });
describe('chart history request sharing', () => {
    it('retires only changed instruments at a session boundary', async () => {
        const { fetchChartHistory } = await import('./chart-history');
        const { advanceMarketSessions } = await import('./market-session');
        const future = { ...contract, code: 'TMFK6', exchange: 'TAIFEX', security_type: 'FUT' } as const;
        const old = fetchChartHistory(future, '2026-11-16', '2026-11-17');
        const stock = fetchChartHistory(contract, '2026-11-16', '2026-11-17');
        advanceMarketSessions(['TMFK6']);
        expect(fetchChartHistory(future, '2026-11-16', '2026-11-17')).not.toBe(old);
        expect(fetchChartHistory(contract, '2026-11-16', '2026-11-17')).toBe(stock);
        expect(mocks.fetch).toHaveBeenCalledTimes(3);
    });
    it('shares concurrent and completed requests across presentation rebuilds', async () => {
        const { fetchChartHistory } = await import('./chart-history');
        const a = fetchChartHistory(contract, '2026-09-01', '2026-09-12');
        const b = fetchChartHistory({ ...contract }, '2026-09-01', '2026-09-12', { timeoutMs: 5000 });
        expect(a).toBe(b); await a;
        await fetchChartHistory({ ...contract }, '2026-09-01', '2026-09-12');
        expect(mocks.fetch).toHaveBeenCalledOnce();
    });
    it('gives separate panels fresh revisions instead of reusing local counter 1', async () => {
        const { fetchChartHistory, nextChartHistoryRevision } = await import('./chart-history');
        const first = nextChartHistoryRevision();
        await fetchChartHistory(contract, '2026-09-01', '2026-09-12', { revision: first });
        const second = nextChartHistoryRevision();
        await fetchChartHistory(contract, '2026-09-01', '2026-09-12', { revision: second });
        expect(first).not.toBe(second);
        expect(mocks.fetch).toHaveBeenCalledTimes(2);
        await fetchChartHistory(contract, '2026-09-01', '2026-09-12', { revision: second });
        expect(mocks.fetch).toHaveBeenCalledTimes(2);
    });
    it('caches failures but allows an explicit manual revision, date or server change', async () => {
        const { fetchChartHistory } = await import('./chart-history');
        mocks.fetch.mockRejectedValueOnce(new Error('offline'));
        await expect(fetchChartHistory(contract, '2026-09-01', '2026-09-12')).rejects.toThrow('offline');
        await expect(fetchChartHistory(contract, '2026-09-01', '2026-09-12')).rejects.toThrow('offline');
        expect(mocks.fetch).toHaveBeenCalledOnce();
        await fetchChartHistory(contract, '2026-09-01', '2026-09-12', { revision: 1 });
        await fetchChartHistory(contract, '2026-09-01', '2026-09-13');
        mocks.base = 'other'; await fetchChartHistory(contract, '2026-09-01', '2026-09-13');
        expect(mocks.fetch).toHaveBeenCalledTimes(4);
    });
});
