import { useSyncExternalStore } from 'react';
import { getApiBase } from './runtime';

const versions = new Map<string, number>();
const listeners = new Set<() => void>();
export const marketSessionVersion = (code: string) => versions.get(`${getApiBase()}:${code}`) ?? 0;
export function advanceMarketSessions(codes: readonly string[]) {
    for (const code of new Set(codes)) versions.set(`${getApiBase()}:${code}`, marketSessionVersion(code) + 1);
    for (const listener of listeners) listener();
}
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
/** Retire history, books and in-flight reads when the source session changes. */
export function useMarketSessionVersion(codes: string | readonly string[]) {
    return useSyncExternalStore(subscribe, () => (typeof codes === 'string' ? [codes] : codes)
        .reduce((sum, code) => sum + marketSessionVersion(code), 0));
}
