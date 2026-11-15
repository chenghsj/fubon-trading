import { useSyncExternalStore } from 'react';

type FeeProfile = { product: string; feePerSide: number; source: 'statement'; updatedAt: string };
const key = 'fubon.contract-fees.v1';
let cache: Record<string, FeeProfile> | undefined;
const listeners = new Set<() => void>();
function profiles() {
    if (cache) return cache;
    cache = {};
    try {
        const saved: unknown = JSON.parse(localStorage.getItem(key) ?? '{}');
        if (saved && typeof saved === 'object') for (const [product, value] of Object.entries(saved)) {
            const p = value as Partial<FeeProfile> | null;
            if (/^(TMF|MXF|TXF)$/.test(product) && p?.product === product && typeof p.feePerSide === 'number'
                && Number.isFinite(p.feePerSide) && p.feePerSide >= 0 && p.feePerSide <= 1000
                && p.source === 'statement' && typeof p.updatedAt === 'string') cache[product] = p as FeeProfile;
        }
    } catch { /* A missing local profile keeps the explicit cost assumption. */ }
    return cache;
}
export const getContractFee = (product: string) => profiles()[product] ?? null;
export function saveContractFee(product: string, feePerSide: number) {
    if (!/^(TMF|MXF|TXF)$/.test(product) || !Number.isFinite(feePerSide) || feePerSide < 0 || feePerSide > 1000) throw new Error('請輸入有效的每口單邊手續費');
    const next = { ...profiles(), [product]: { product, feePerSide, source: 'statement' as const, updatedAt: new Date().toISOString() } };
    localStorage.setItem(key, JSON.stringify(next));
    cache = next;
    listeners.forEach(fn => fn());
}
const subscribe = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
export function useContractFee(product: string) { return useSyncExternalStore(subscribe, () => getContractFee(product), () => null); }
if (typeof window !== 'undefined') window.addEventListener('storage', event => {
    if (event.key === key || event.key === null) { cache = undefined; listeners.forEach(fn => fn()); }
});
