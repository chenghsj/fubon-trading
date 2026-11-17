import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.mock('./runtime', () => ({ getApiBase: () => 'http://fixture.invalid', getStreamBase: () => 'http://fixture.invalid' }));
vi.mock('./api', () => ({ apiPost: vi.fn() }));
vi.mock('./server-info-store', () => ({ forgetServerInfo: vi.fn(), knownServerInfo: () => ({ simulation: true }) }));
class Source {
    static last: Source;
    listeners = new Map<string, ((e: { data: string }) => void)[]>();
    constructor() { Source.last = this; }
    addEventListener(name: string, fn: (e: { data: string }) => void) { this.listeners.set(name, [...this.listeners.get(name) ?? [], fn]); }
    emit(name: string, data: unknown) { for (const fn of this.listeners.get(name) ?? []) fn({ data: JSON.stringify(data) }); }
    close() {}
}
beforeEach(() => {
    vi.resetModules(); vi.useFakeTimers();
    vi.stubGlobal('EventSource', Source); vi.stubGlobal('BroadcastChannel', undefined);
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false })));
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });
it('clears old futures ticks and books, preserves stocks and invalidates confirmations without reloading', async () => {
    const stream = await import('./stream');
    const sessions = await import('./market-session');
    const { forgetServerInfo } = await import('./server-info-store');
    stream.ensureStream();
    const source = Source.last;
    source.emit('tick_fop', { code: 'TMFK6', close: '25000', date: '2026-11-17', time: '13:45:00' });
    source.emit('bidask_fop', { code: 'TMFK6', bid_price: ['24999'], ask_price: ['25001'] });
    source.emit('tick_stk', { code: '2330', close: '1000', date: '2026-11-17', time: '13:30:00' });
    expect(stream.getQuote('TMFK6')?.tick).toBeDefined();
    source.emit('fubon_session_changed', { codes: ['TMFK6'] });
    expect(stream.getQuote('TMFK6')).toBeUndefined();
    expect(stream.getQuote('2330')?.tick).toBeDefined();
    expect(sessions.marketSessionVersion('TMFK6')).toBe(1);
    expect(sessions.marketSessionVersion('2330')).toBe(0);
    expect(forgetServerInfo).toHaveBeenCalledWith('http://fixture.invalid');
});
