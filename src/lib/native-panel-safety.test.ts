// @vitest-environment jsdom
// Independent QA: native submissions use a fake transport and browser primitives.
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const transport = vi.hoisted(() => ({
    post: vi.fn(),
    get: vi.fn(),
    base: 'http://127.0.0.1:21991',
}));
vi.mock('./api', () => ({ apiPost: transport.post, apiGet: transport.get }));
vi.mock('./runtime', () => ({ getApiBase: () => transport.base }));

import {
    nativeAccountKey, reconcileNativeAttempt, submitNativeAction,
    type NativeAccount, type NativeResult,
} from './native-panels';
import { forgetNativeAttempt, rememberNativeAttempt, useNativeAttempt } from './native-attempts';
import { nativeDisplay } from './native-display';
import { setRiskSettings } from './risk';

const account: NativeAccount = {
    account_type: 'S', broker_id: '9A95', account_id: '9816502',
    label: 'QA fixture', environment: 'production',
};
const body = (request_id = 'qa-first', selected = account) => ({
    operation: 'batch_place', account: selected, instance_id: 'qa-instance', request_id,
    legs: [{ symbol: '2330', side: 'Buy', quantity: 100, price: 600 }],
});
const result: NativeResult = {
    operation: 'batch_place', source: 'fubon', fetched_at: '2026-11-17T01:00:00+08:00',
    columns: [], rows: [], detail_keys: [], summary: {}, metadata: {}, note: '', submitted: true,
};
const accountKey = (mode = 'live') => nativeAccountKey(account, mode);
const storageKey = (mode = 'live') => `sj-native-attempt:${transport.base}:${accountKey(mode)}`;
const record = (request_id = 'qa-first') => ({
    request_id, instance_id: 'qa-instance', operation: 'batch_place', created_at: '2026-11-17T01:00:00Z',
});
const locksDescriptor = Object.getOwnPropertyDescriptor(navigator, 'locks');

function installLocks(denied = false) {
    const held = new Set<string>();
    const request = vi.fn(async (
        name: string,
        _options: { ifAvailable: boolean },
        callback: (lock: { name: string } | null) => Promise<unknown>,
    ) => {
        if (denied || held.has(name)) return callback(null);
        held.add(name);
        try { return await callback({ name }); }
        finally { held.delete(name); }
    });
    Object.defineProperty(navigator, 'locks', { configurable: true, value: { request } });
    return request;
}

beforeEach(() => {
    vi.restoreAllMocks();
    transport.post.mockReset();
    transport.get.mockReset();
    transport.base = 'http://127.0.0.1:21991';
    localStorage.clear();
    setRiskSettings({ locked: false, enabled: false, maxQty: 0, maxDailyLoss: 0 });
    installLocks();
});
afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    if (locksDescriptor) Object.defineProperty(navigator, 'locks', locksDescriptor);
    else Reflect.deleteProperty(navigator, 'locks');
});

describe('unknown native submission outcomes', () => {
    it('persists a timed-out attempt across remount and rejects a fresh request ID until explicit reconciliation', async () => {
        const firstMount = renderHook(() => useNativeAttempt(accountKey()));
        const timeout = Object.assign(new Error('Response timed out after dispatch'), { requestTimedOut: true });
        transport.post.mockRejectedValueOnce(timeout);
        await act(async () => { await expect(submitNativeAction(body(), 'live')).rejects.toBe(timeout); });
        expect(firstMount.result.current).toMatchObject({ request_id: 'qa-first', instance_id: 'qa-instance', operation: 'batch_place' });
        expect(firstMount.result.current?.created_at).toEqual(expect.any(String));
        expect(JSON.parse(localStorage.getItem(storageKey())!)).toMatchObject({ request_id: 'qa-first' });
        firstMount.unmount();

        const remounted = renderHook(() => useNativeAttempt(accountKey()));
        expect(remounted.result.current?.request_id).toBe('qa-first');
        await expect(submitNativeAction(body('qa-new-id'), 'live')).rejects.toThrow('核對');
        expect(transport.post).toHaveBeenCalledTimes(1);

        transport.post.mockResolvedValueOnce({ reconciled: true, submitted: false });
        await act(async () => {
            await reconcileNativeAttempt({ account, request_id: 'qa-first', instance_id: 'qa-instance', acknowledgement: '已於券商核對此請求' });
            forgetNativeAttempt(accountKey(), 'qa-first');
        });
        expect(remounted.result.current).toBeNull();
        expect(transport.post).toHaveBeenNthCalledWith(2, '/api/v1/native/reconcile', expect.objectContaining({ request_id: 'qa-first' }));
        transport.post.mockResolvedValueOnce(result);
        await act(async () => { await expect(submitNativeAction(body('qa-after-reconcile'), 'live')).resolves.toBe(result); });
        expect(transport.post).toHaveBeenCalledTimes(3);
        expect(remounted.result.current).toBeNull();
    });

    it.each(['paper', 'live', 'demo'])('shares production pending records with %s while Sandbox is separate', async mode => {
        rememberNativeAttempt(accountKey('live'), record());
        expect(nativeAccountKey(account, mode)).toBe(accountKey('live'));
        await expect(submitNativeAction(body('qa-production-new'), mode)).rejects.toThrow('核對');
        expect(transport.post).not.toHaveBeenCalled();
        expect(accountKey('sandbox')).not.toBe(accountKey('live'));
        transport.post.mockResolvedValueOnce(result);
        await expect(submitNativeAction(body('qa-sandbox'), 'sandbox')).resolves.toBe(result);
        expect(JSON.parse(localStorage.getItem(storageKey('live'))!).request_id).toBe('qa-first');
    });

    it('allows an unrelated broker account while preserving the blocked account record', async () => {
        rememberNativeAttempt(accountKey(), record());
        transport.post.mockResolvedValueOnce(result);
        await expect(submitNativeAction(body('qa-other-account', { ...account, account_id: '9816121' }), 'live')).resolves.toBe(result);
        expect(JSON.parse(localStorage.getItem(storageKey())!).request_id).toBe('qa-first');
    });

    it('keeps unreadable persisted JSON blocked rather than permitting a new ID', async () => {
        localStorage.setItem(storageKey(), '{interrupted-write');
        const mounted = renderHook(() => useNativeAttempt(accountKey()));
        expect(mounted.result.current?.request_id).toBe('invalid-local-record');
        await expect(submitNativeAction(body('qa-new-id'), 'live')).rejects.toThrow('核對');
        expect(transport.post).not.toHaveBeenCalled();
    });

    it.each(['400 native rejection after dispatch', '409 result unknown', '500 native failure', 'NetworkError'])('retains the pending record for %s', async message => {
        transport.post.mockRejectedValueOnce(new Error(message));
        await expect(submitNativeAction(body(), 'live')).rejects.toThrow(message);
        expect(JSON.parse(localStorage.getItem(storageKey())!).request_id).toBe('qa-first');
        await expect(submitNativeAction(body('qa-new-id'), 'live')).rejects.toThrow('核對');
        expect(transport.post).toHaveBeenCalledTimes(1);
    });

    it('does not remove a different pending record when reconciling an old request ID', () => {
        rememberNativeAttempt(accountKey(), record('qa-newer'));
        forgetNativeAttempt(accountKey(), 'qa-older');
        expect(JSON.parse(localStorage.getItem(storageKey())!).request_id).toBe('qa-newer');
    });

    it('updates mounted consumers when a different window changes localStorage', () => {
        const mounted = renderHook(() => useNativeAttempt(accountKey()));
        act(() => {
            localStorage.setItem(storageKey(), JSON.stringify(record('qa-other-window')));
            window.dispatchEvent(new StorageEvent('storage', { key: storageKey(), newValue: JSON.stringify(record('qa-other-window')) }));
        });
        expect(mounted.result.current?.request_id).toBe('qa-other-window');
        act(() => {
            localStorage.removeItem(storageKey());
            window.dispatchEvent(new StorageEvent('storage', { key: storageKey(), newValue: null }));
        });
        expect(mounted.result.current).toBeNull();
    });
});

describe('native submission dispatch gates', () => {
    it('persists before transport dispatch and clears after a successful broker reply', async () => {
        transport.post.mockImplementationOnce(async (path: string) => {
            expect(path).toBe('/api/v1/native/action');
            expect(JSON.parse(localStorage.getItem(storageKey())!)).toMatchObject({ request_id: 'qa-first', operation: 'batch_place' });
            return result;
        });
        await expect(submitNativeAction(body(), 'live')).resolves.toBe(result);
        expect(localStorage.getItem(storageKey())).toBeNull();
    });

    it.each([401, 403, 422])('clears a pre-dispatch HTTP %s rejection', async status => {
        const error = Object.assign(new Error(`${status} Rejected before SDK dispatch`), { status });
        transport.post.mockRejectedValueOnce(error);
        await expect(submitNativeAction(body(), 'live')).rejects.toBe(error);
        expect(localStorage.getItem(storageKey())).toBeNull();
        transport.post.mockResolvedValueOnce(result);
        await expect(submitNativeAction(body('qa-corrected'), 'live')).resolves.toBe(result);
    });

    it('never posts when Web Locks are unavailable', async () => {
        Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined });
        await expect(submitNativeAction(body(), 'live')).rejects.toThrow('Web Locks');
        expect(transport.post).not.toHaveBeenCalled();
        expect(localStorage.getItem(storageKey())).toBeNull();
    });

    it('never posts or writes a record when another window holds the Web Lock', async () => {
        const request = installLocks(true);
        await expect(submitNativeAction(body(), 'live')).rejects.toThrow('另一個視窗');
        expect(request).toHaveBeenCalledWith(`native-broker:${accountKey()}`, { ifAvailable: true }, expect.any(Function));
        expect(transport.post).not.toHaveBeenCalled();
        expect(localStorage.getItem(storageKey())).toBeNull();
    });

    it('shares an in-flight Web Lock across paper/live for the same broker account', async () => {
        let finish!: (reply: NativeResult) => void;
        transport.post.mockImplementationOnce(() => new Promise<NativeResult>(resolve => { finish = resolve; }));
        const first = submitNativeAction(body(), 'live');
        await expect(submitNativeAction(body('qa-concurrent'), 'paper')).rejects.toThrow('另一個視窗');
        expect(transport.post).toHaveBeenCalledTimes(1);
        finish(result);
        await expect(first).resolves.toBe(result);
        expect(localStorage.getItem(storageKey())).toBeNull();
    });

    it('never posts if the pending request ID cannot be saved', async () => {
        vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('quota', 'QuotaExceededError'); });
        await expect(submitNativeAction(body(), 'live')).rejects.toThrow('拒絕送出');
        expect(transport.post).not.toHaveBeenCalled();
    });

    it('never posts if existing pending records cannot be read', async () => {
        localStorage.setItem(storageKey(), JSON.stringify(record('qa-previous-unknown')));
        transport.post.mockResolvedValueOnce(result);
        vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new DOMException('storage blocked', 'SecurityError'); });
        await expect(submitNativeAction(body('qa-must-not-overwrite'), 'live')).rejects.toThrow();
        expect(transport.post).not.toHaveBeenCalled();
    });
});

describe('native submission shares existing risk controls', () => {
    it('blocks an initially locked order before any API call or pending-record write', async () => {
        setRiskSettings({ locked: true });
        await expect(submitNativeAction(body(), 'live')).rejects.toMatchObject({ nativeNotDispatched: true });
        expect(transport.post).not.toHaveBeenCalled();
        expect(localStorage.getItem(storageKey())).toBeNull();
    });

    it('applies stock share-to-lot limits to each batch leg and futures limits in contracts before HTTP', async () => {
        setRiskSettings({ enabled: true, maxQty: 1 });
        const batch = { ...body(), legs: [
            { symbol: '2330', side: 'Buy', quantity: 1000, price: 600 },
            { symbol: '2317', side: 'Buy', quantity: 1001, price: 200 },
        ] };
        await expect(submitNativeAction(batch, 'live')).rejects.toMatchObject({ nativeNotDispatched: true });
        const future = { ...body('qa-future'), account: { ...account, account_type: 'F' }, operation: 'dualleg_place', quantity: 2 };
        await expect(submitNativeAction(future, 'live')).rejects.toMatchObject({ nativeNotDispatched: true });
        expect(transport.post).not.toHaveBeenCalled();
        expect(localStorage.getItem(storageKey())).toBeNull();

        // A one-lot order is 1000 shares; maxQty applies to each order, not the batch total.
        transport.post.mockResolvedValueOnce(result);
        const secondLeg = batch.legs[1];
        if (!secondLeg) throw new Error('Expected the second batch fixture leg');
        secondLeg.quantity = 1000;
        await expect(submitNativeAction(batch, 'live')).resolves.toBe(result);
        expect(transport.post).toHaveBeenCalledTimes(1);
    });

    it('rechecks a late risk lock at beforeDispatch and clears the known-unsent attempt', async () => {
        const dispatched = vi.fn();
        transport.post.mockImplementationOnce(async (_path: string, _body: unknown, options: { beforeDispatch?: () => void }) => {
            expect(JSON.parse(localStorage.getItem(storageKey())!).request_id).toBe('qa-first');
            setRiskSettings({ locked: true });
            const beforeDispatch = options?.beforeDispatch;
            if (!beforeDispatch) throw new Error('Expected the native pre-dispatch risk guard');
            beforeDispatch();
            dispatched();
            return result;
        });
        await expect(submitNativeAction(body(), 'live')).rejects.toMatchObject({ nativeNotDispatched: true });
        expect(dispatched).not.toHaveBeenCalled();
        expect(localStorage.getItem(storageKey())).toBeNull();
        // Once unlocked, this known-unsent request does not require false reconciliation.
        setRiskSettings({ locked: false });
        transport.post.mockResolvedValueOnce(result);
        await expect(submitNativeAction(body('qa-after-unlock'), 'live')).resolves.toBe(result);
    });

    it('allows cancellation through both risk checks while new order entry is locked', async () => {
        setRiskSettings({ locked: true, enabled: true, maxQty: 1 });
        const cancellation = { ...body('qa-cancel'), operation: 'condition_cancel', guid: 'qa-condition-guid' };
        transport.post.mockImplementationOnce(async (_path: string, _body: unknown, options: { beforeDispatch?: () => void }) => {
            const beforeDispatch = options?.beforeDispatch;
            if (!beforeDispatch) throw new Error('Expected the native pre-dispatch risk guard');
            beforeDispatch();
            return { ...result, operation: 'condition_cancel' };
        });
        await expect(submitNativeAction(cancellation, 'live')).resolves.toMatchObject({ operation: 'condition_cancel' });
        expect(transport.post).toHaveBeenCalledTimes(1);
        expect(localStorage.getItem(storageKey())).toBeNull();
    });
});

describe('native payload and final review privacy', () => {
    it('masks account selectors recursively in native detail arrays and final review JSON', () => {
        const review = {
            ...body(), account: { ...account, branch_no: '1234' },
            children: [{ account: '9816121', parent: { account_id: '9988776', person_id: 'A123456789' } }],
            request_id: 'public-opaque-id',
        };
        const transformed = nativeDisplay(review, '', true, false, true) as typeof review;
        expect(transformed.account.account_id).toBe('•••••02');
        expect(transformed.account.broker_id).toBe('••95');
        expect(transformed.account.branch_no).toBe('••34');
        const child = transformed.children[0];
        if (!child) throw new Error('Expected the nested child fixture');
        expect(child.account).toBe('•••••21');
        expect(child.parent.account_id).toBe('•••••76');
        expect(child.parent.person_id).toBe('••••••••89');
        expect(transformed.request_id).toBe('public-opaque-id');
        expect(review.account.account_id).toBe('9816502');
    });

    it('masks nested account quantities/prices, fees, taxes and totals, including explicit zero', () => {
        const payload = { rows: [{ filled_qty: 0, filled_price: 600, buy_fee: 12, buy_tax: 0, total_settlement_amount: -6012 }], summary: { realized_profit: 100, realized_loss: 0 }, legs: body().legs };
        expect(nativeDisplay(payload, '', false, true, true)).toEqual({
            rows: [{ filled_qty: '•••••', filled_price: '•••••', buy_fee: '•••••', buy_tax: '•••••', total_settlement_amount: '•••••' }],
            summary: { realized_profit: '•••••', realized_loss: '•••••' },
            legs: [{ symbol: '2330', side: 'Buy', quantity: '•••••', price: '•••••' }],
        });
    });

    it('masks documented settlement debit and credit fields in native account details', () => {
        // Official query_settlement response fields (llms-full.txt SettlementData).
        const settlement = { buy_settlement: -1429513, sell_settlement: 677626, settlement_date: '2024/03/06' };
        expect(nativeDisplay(settlement, '', false, true, true)).toEqual({
            buy_settlement: '•••••', sell_settlement: '•••••', settlement_date: '2024/03/06',
        });
    });

    it('preserves public market numbers and zero even when both privacy toggles are on', () => {
        const publicData = { symbol: 'IX0001', lastPrice: 0, tradeValue: 1000, volume: 0, openInterest: 0, price: 0, missing: null, nested: [{ quantity: 0, fee: 0 }] };
        expect(nativeDisplay(publicData, '', true, true, false)).toEqual(publicData);
    });

    it('preserves the wire types, nulls and explicit zero when masking is off', () => {
        const unmasked = { account_id: account.account_id, quantity: 0, price: 0, amount: '0', margin_ratio: null, nested: [{ account_id: account.account_id, buy_fee: 0 }], missing: undefined };
        expect(nativeDisplay(unmasked, '', false, false, true)).toEqual(unmasked);
    });

    it('treats account and money masking as independent toggles', () => {
        expect(nativeDisplay({ account_id: account.account_id, price: 0 }, '', true, false, true)).toEqual({ account_id: '•••••02', price: 0 });
        expect(nativeDisplay({ account_id: account.account_id, price: 0 }, '', false, true, true)).toEqual({ account_id: account.account_id, price: '•••••' });
    });
});
