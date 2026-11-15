import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('local contract fee profile', () => {
    let saved: Map<string, string>;
    beforeEach(() => {
        vi.resetModules(); saved = new Map();
        vi.stubGlobal('localStorage', { getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => saved.set(key, value) });
    });
    it('persists a verified single-side rate for its own product only', async () => {
        const fees = await import('./contract-fee');
        expect(fees.getContractFee('TMF')).toBeNull();
        fees.saveContractFee('TMF', 12);
        expect(fees.getContractFee('TMF')).toMatchObject({ feePerSide: 12, source: 'statement' });
        expect(fees.getContractFee('MXF')).toBeNull();
        vi.resetModules();
        expect((await import('./contract-fee')).getContractFee('TMF')?.feePerSide).toBe(12);
    });
    it('rejects invalid costs and leaves the previous profile intact when saving fails', async () => {
        const fees = await import('./contract-fee');
        fees.saveContractFee('TMF', 12);
        expect(() => fees.saveContractFee('TMF', NaN)).toThrow('有效');
        expect(() => fees.saveContractFee('TX', 12)).toThrow('有效');
        vi.stubGlobal('localStorage', { setItem: () => { throw new Error('storage unavailable'); } });
        expect(() => fees.saveContractFee('TMF', 16)).toThrow('storage unavailable');
        expect(fees.getContractFee('TMF')?.feePerSide).toBe(12);
    });
    it('ignores malformed local values rather than silently using them as a verified fee', async () => {
        saved.set('fubon.contract-fees.v1', JSON.stringify({ TMF: { product: 'MXF', feePerSide: 12, source: 'statement', updatedAt: '2026-11-15' } }));
        expect((await import('./contract-fee')).getContractFee('TMF')).toBeNull();
    });
});
