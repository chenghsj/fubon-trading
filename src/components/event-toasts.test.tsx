import { createElement, Fragment, type ReactNode } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ExternalToast } from 'sonner';

const fixture = vi.hoisted(() => {
    const storage = new Map<string, string>();
    (globalThis as { localStorage?: unknown }).localStorage = {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => void storage.set(key, value),
    };
    let nextId = 0;
    const show = () => vi.fn((_title: ReactNode, _options?: ExternalToast) => `toast-${++nextId}`);
    return {
        notice: undefined as undefined | ((notice: { kind: 'info' | 'ok' | 'err'; title: string; body?: string }) => void),
        order: undefined as undefined | (() => void),
        offNotice: vi.fn(),
        offOrder: vi.fn(),
        info: show(), success: show(), error: show(), custom: vi.fn(), dismiss: vi.fn(),
        deal: vi.fn(), alert: vi.fn(), errorSound: vi.fn(), orderSound: vi.fn(),
        accounts: [{ account_id: '1234567' }],
    };
});

vi.mock('sonner', () => ({ toast: {
    info: fixture.info, success: fixture.success, error: fixture.error,
    custom: fixture.custom, dismiss: fixture.dismiss,
} }));
vi.mock('./ui/sonner', () => ({ Toaster: () => null }));
vi.mock('../lib/account-store', () => ({ useAccounts: () => ({ accounts: fixture.accounts }) }));
vi.mock('../lib/trade', () => ({ onNotice: (callback: typeof fixture.notice) => {
    fixture.notice = callback;
    return fixture.offNotice;
} }));
vi.mock('../lib/stream', () => ({ onOrderEvent: (callback: typeof fixture.order) => {
    fixture.order = callback;
    return fixture.offOrder;
} }));
vi.mock('../lib/order-report', () => ({ describeOrderReport: () => ({
    kind: 'deal', title: '已成交', lines: [{ text: '上漲 +1.25', dir: 'up' }],
}) }));
vi.mock('../lib/sounds', () => ({
    playDeal: fixture.deal, playAlert: fixture.alert,
    playError: fixture.errorSound, playOrder: fixture.orderSound,
}));

import { EventToasts } from './event-toasts';
import { setToastScale } from '../lib/toast-prefs';
import { secretMoney, setPrivacyMode, setPrivacyMoney } from '../lib/privacy';

let view: ReactTestRenderer | undefined;
let message: ReactTestRenderer | undefined;
beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.clearAllMocks();
    setPrivacyMode(false);
    setPrivacyMoney(false);
    setToastScale(1);
});
afterEach(async () => {
    await act(async () => { view?.unmount(); message?.unmount(); });
    view = undefined;
    message = undefined;
    setPrivacyMode(false);
    setPrivacyMoney(false);
    setToastScale(1);
});
const mount = async (onEvent = vi.fn()) => {
    await act(async () => { view = create(createElement(EventToasts, { onEvent })); });
    return onEvent;
};
const renderMessage = async (show: typeof fixture.info) => {
    const [title, options] = show.mock.calls.at(-1)!;
    await act(async () => {
        message = create(createElement(Fragment, null, title, options?.description as ReactNode));
    });
};
const text = () => JSON.stringify(message!.toJSON());

it('uses native Sonner title and description slots for layout notices', async () => {
    await mount();
    fixture.notice!({ kind: 'info', title: '版面已套用', body: '預設版面「標準看盤」' });
    expect(fixture.info).toHaveBeenCalledOnce();
    expect(fixture.custom).not.toHaveBeenCalled();
    expect(fixture.info.mock.calls[0]![1]?.duration).toBe(6000);
    await renderMessage(fixture.info);
    expect(text()).toContain('版面已套用');
    expect(text()).toContain('預設版面「標準看盤」');
});

it('re-masks the visible native title and description when privacy changes', async () => {
    await mount();
    fixture.notice!({ kind: 'info', title: '帳號 1234567', body: `帳號 1234567，金額 ${secretMoney('1,234')}` });
    await renderMessage(fixture.info);
    expect(text()).toContain('1234567');
    expect(text()).toContain('1,234');
    await act(async () => { setPrivacyMode(true); setPrivacyMoney(true); });
    expect(text()).not.toContain('1234567');
    expect(text()).not.toContain('1,234');
    expect(fixture.info).toHaveBeenCalledOnce();
    await act(async () => { setPrivacyMode(false); setPrivacyMoney(false); });
    expect(text()).toContain('1234567');
    expect(text()).toContain('1,234');
});

it('preserves deal/error behavior and dismisses only its remaining notifications', async () => {
    const onEvent = await mount();
    fixture.order!();
    fixture.notice!({ kind: 'err', title: '讀取失敗' });
    fixture.notice!({ kind: 'info', title: '手動關閉的通知' });
    expect(fixture.success).toHaveBeenCalledOnce();
    expect(fixture.deal).toHaveBeenCalledOnce();
    expect(onEvent).toHaveBeenCalledOnce();
    expect(fixture.errorSound).toHaveBeenCalledOnce();
    expect(fixture.error.mock.calls[0]![1]?.duration).toBe(9000);
    const completedId = fixture.success.mock.results[0]!.value;
    const remainingId = fixture.error.mock.results[0]!.value;
    const dismissedId = fixture.info.mock.results[0]!.value;
    fixture.success.mock.calls[0]![1]?.onAutoClose?.({ id: completedId });
    fixture.info.mock.calls[0]![1]?.onDismiss?.({ id: dismissedId });
    await act(async () => { view!.unmount(); });
    view = undefined;
    expect(fixture.dismiss).toHaveBeenCalledExactlyOnceWith(remainingId);
    expect(fixture.offNotice).toHaveBeenCalledOnce();
    expect(fixture.offOrder).toHaveBeenCalledOnce();
});

it('updates the existing toast ID after size changes without replaying its event', async () => {
    const onEvent = await mount();
    fixture.notice!({ kind: 'ok', title: '設定通知範例', body: '內容' });
    const originalId = fixture.success.mock.results[0]!.value;
    await act(async () => { setToastScale(1.25); });
    expect(fixture.success).toHaveBeenCalledTimes(2);
    expect(fixture.success.mock.calls[1]![1]?.id).toBe(originalId);
    expect(fixture.orderSound).toHaveBeenCalledOnce();
    expect(onEvent).toHaveBeenCalledOnce();
    await act(async () => { view!.unmount(); });
    view = undefined;
    expect(fixture.dismiss).toHaveBeenCalledExactlyOnceWith(originalId);
});
