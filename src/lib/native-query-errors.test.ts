// @vitest-environment jsdom
// Exercise the real apiPost/error parser; only the HTTP transport is synthetic.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./runtime', () => ({ isTauri: false, getApiBase: () => 'http://native-query.invalid' }));

import { FubonApiError } from './fubon-api-detail';
import { nativeAccountKey, queryNative, submitNativeAction, type NativeResult } from './native-panels';
import { setRiskSettings } from './risk';

const fetchMock = vi.fn<typeof fetch>();
const query = { operation: 'conditions', account_type: 'F', broker_id: 'QA', account_id: 'fixture-only' };
const result: NativeResult = {
    operation: 'conditions', source: 'fubon', fetched_at: '2026-11-17T09:00:00+08:00',
    columns: [{ key: 'quantity', label: '數量' }], rows: [{ quantity: 0, parent_guid: null }],
    detail_keys: [], summary: {}, metadata: { account_type: 'F' }, note: '',
};
const account = { account_type: 'F' as const, broker_id: 'QA', account_id: 'fixture-only', label: '合成帳戶', environment: 'production' };
const action = { operation: 'trail_create', account, request_id: 'qa-request', instance_id: 'qa-instance', quantity: 1 };
const pendingKey = () => `sj-native-attempt:http://native-query.invalid:${nativeAccountKey(account, 'live')}`;
const locksDescriptor = Object.getOwnPropertyDescriptor(navigator, 'locks');
const jsonResponse = (status: number, body: unknown) => new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json' },
});

beforeEach(() => {
    localStorage.clear();
    setRiskSettings({ locked: false, enabled: false });
    fetchMock.mockReset().mockRejectedValue(new Error('Unexpected fixture HTTP request'));
    vi.stubGlobal('fetch', fetchMock);
    Object.defineProperty(navigator, 'locks', { configurable: true, value: {
        request: async (_name: string, _options: unknown, callback: (lock: object) => unknown) => callback({}),
    } });
});

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    if (locksDescriptor) Object.defineProperty(navigator, 'locks', locksDescriptor);
    else Reflect.deleteProperty(navigator, 'locks');
    localStorage.clear();
});

describe('native read query error details', () => {
    it.each([
        [400, '此區間查無條件單資料'],
        [403, '此帳戶尚無查詢權限'],
    ])('preserves HTTP %s FastAPI detail and its status prefix', async (status, detail) => {
        fetchMock.mockResolvedValueOnce(jsonResponse(status, { detail }));
        const error = await queryNative(query).catch(error => error);
        expect(error).toBeInstanceOf(FubonApiError);
        expect(error).toMatchObject({ status, message: `${status}：${detail}` });
    });

    it('formats FastAPI 422 field locations and validation messages', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse(422, { detail: [
            { loc: ['body', 'start'], msg: '日期格式無效' },
            { loc: ['body', 'filters', 'quantity'], msg: '必須大於零' },
        ] }));
        await expect(queryNative(query)).rejects.toMatchObject({
            status: 422, message: '422：start：日期格式無效；filters.quantity：必須大於零',
        });
    });

    it('falls back to the HTTP status text without exposing an HTML error body', async () => {
        fetchMock.mockResolvedValueOnce(new Response('<html>fixture upstream failure</html>', { status: 502, statusText: 'Bad Gateway' }));
        const error = await queryNative(query).catch(error => error);
        expect(error).toMatchObject({ status: 502 });
        expect(error.message).toMatch(/^502\b/);
        expect(error.message).toContain('Bad Gateway');
        expect(error.message).not.toContain('<html>');
    });

    it('returns the native payload unchanged through the actual JSON POST transport', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse(200, result));
        await expect(queryNative(query)).resolves.toEqual(result);
        expect(fetchMock).toHaveBeenCalledExactlyOnceWith('http://native-query.invalid/api/v1/native/query', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(query), signal: expect.any(AbortSignal),
        });
    });

    it('does not dispatch an already cancelled query', async () => {
        const controller = new AbortController(); controller.abort();
        await expect(queryNative(query, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('discards a late successful response after the caller cancels', async () => {
        let finish!: (response: Response) => void;
        fetchMock.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
        const controller = new AbortController();
        const pending = queryNative(query, controller.signal);
        controller.abort(); finish(jsonResponse(200, result));
        await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('keeps the 25 second bound when the transport never answers', async () => {
        vi.useFakeTimers();
        fetchMock.mockImplementationOnce(() => new Promise(() => undefined));
        const pending = queryNative(query);
        const failure = expect(pending).rejects.toThrow();
        await vi.advanceTimersByTimeAsync(24_999);
        const transportSignal = fetchMock.mock.calls[0]![1]!.signal!;
        expect(transportSignal.aborted).toBe(false);
        await vi.advanceTimersByTimeAsync(1); await failure;
        expect(transportSignal.aborted).toBe(true);
    });

    it('keeps the 25 second bound when an error response body stalls', async () => {
        vi.useFakeTimers();
        const stalled = () => new Promise<unknown>(() => undefined);
        fetchMock.mockResolvedValueOnce({
            status: 400, statusText: 'Bad Request', ok: false,
            json: stalled, clone: () => ({ json: stalled }),
        } as Response);
        let settled = false;
        const pending = queryNative(query).then(
            value => { settled = true; return { value }; },
            error => { settled = true; return { error }; },
        );
        await vi.advanceTimersByTimeAsync(25_000);
        expect(settled).toBe(true);
        expect(await pending).toHaveProperty('error', expect.any(Error));
    });
});

describe('native write outcome isolation', () => {
    it.each(['HTTP 400', 'transport failure'])('retains the pending write lock after %s', async failure => {
        if (failure === 'HTTP 400') fetchMock.mockResolvedValueOnce(jsonResponse(400, { detail: '券商未確認此請求' }));
        else fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
        await expect(submitNativeAction(action, 'live')).rejects.toThrow();
        expect(JSON.parse(localStorage.getItem(pendingKey())!)).toMatchObject({ request_id: 'qa-request' });
        await expect(submitNativeAction({ ...action, request_id: 'qa-retry' }, 'live')).rejects.toThrow('核對');
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('still clears the pending write lock for a pre-dispatch HTTP 403 rejection', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse(403, { detail: '拒絕送出' }));
        await expect(submitNativeAction(action, 'live')).rejects.toMatchObject({ status: 403 });
        expect(localStorage.getItem(pendingKey())).toBeNull();
    });
});
