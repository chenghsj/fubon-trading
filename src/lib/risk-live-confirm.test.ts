import { beforeEach, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ info: undefined as { broker?: string; mode?: string } | undefined, listeners: new Set<() => void>() }));
vi.mock('./server-info-store', () => ({
    knownServerInfo: () => fixture.info,
    subscribeServerInfo: (listener: () => void) => { fixture.listeners.add(listener); return () => fixture.listeners.delete(listener); },
}));
vi.stubGlobal('window', new EventTarget());
const saved = new Map<string, string>();
vi.stubGlobal('localStorage', { getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => saved.set(key, value) });
const { getRiskSettings, setRiskSettings, subscribeRiskSettings } = await import('./risk');

beforeEach(() => { fixture.info = { broker: 'fubon', mode: 'paper' }; setRiskSettings({ confirmManualOrders: false }); });

it('forces every live manual entry path through the common confirmation preference without overwriting it', () => {
    fixture.info = { broker: 'fubon', mode: 'live' };
    expect(getRiskSettings().confirmManualOrders).toBe(true);
    expect(getRiskSettings().manualConfirmationRequired).toBe(true);
    const snapshot = getRiskSettings();
    expect(getRiskSettings()).toBe(snapshot);
    setRiskSettings({ confirmManualOrders: false });
    expect(getRiskSettings().confirmManualOrders).toBe(true);
    expect(JSON.parse(saved.get('sj-pro-risk')!).confirmManualOrders).toBe(false);
    fixture.info = { broker: 'fubon', mode: 'paper' };
    expect(getRiskSettings().confirmManualOrders).toBe(false);
});

it('requires fresh environment confirmation while server information is unknown', () => {
    fixture.info = undefined;
    expect(getRiskSettings().confirmManualOrders).toBe(true);
    fixture.info = { broker: 'fubon' };
    expect(getRiskSettings().confirmManualOrders).toBe(true);
});

it.each(['demo', 'paper', 'sandbox'])('keeps the saved preference in %s', mode => {
    fixture.info = { broker: 'fubon', mode };
    expect(getRiskSettings().confirmManualOrders).toBe(false);
    expect(getRiskSettings().manualConfirmationRequired).toBeUndefined();
});

it('notifies existing settings views when the server mode changes', () => {
    const listener = vi.fn();
    const off = subscribeRiskSettings(listener);
    fixture.info = { broker: 'fubon', mode: 'live' };
    fixture.listeners.forEach(callback => callback());
    expect(listener).toHaveBeenCalledOnce();
    off();
    expect(fixture.listeners.size).toBe(0);
});
