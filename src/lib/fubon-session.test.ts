import { afterEach, describe, expect, it, vi } from 'vitest';
import { isLocalApi, SseParser } from './fubon-session';

const launch = 'L'.repeat(43);
const token = 'T'.repeat(43);

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

function browser(hash: string, saved?: string) {
    const storage = new Map(saved ? [['fubon-trading-session', saved]] : []);
    vi.stubGlobal('location', { hash, origin: 'http://127.0.0.1:5179', pathname: '/', search: '' });
    vi.stubGlobal('history', { replaceState: vi.fn() });
    vi.stubGlobal('sessionStorage', {
        getItem: (key: string) => storage.get(key), setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key),
    });
    return storage;
}

describe('Fubon session boundary', () => {
    it('strips the launch fragment and grants enrollment only, never trading authority', async () => {
        const storage = browser(`#fubon-launch=${launch}`);
        const native = vi.fn().mockResolvedValueOnce(Response.json({ enrollment_token: token }));
        vi.stubGlobal('fetch', native);
        const { prepareFubonSession, canEnrollPasskey } = await import('./fubon-session');
        expect(await prepareFubonSession()).toBe(false);
        expect(history.replaceState).toHaveBeenCalledWith(null, '', '/');
        expect(canEnrollPasskey()).toBe(true);
        expect(storage.size).toBe(0);
        expect(native.mock.calls[0]?.[1].headers.Authorization).toBe(`Bearer ${launch}`);
        expect(globalThis.fetch).toBe(native);
    });

    it('uses only a verified session for same-origin API authority and blocks redirect forwarding', async () => {
        browser('', token);
        const native = vi.fn().mockResolvedValue(Response.json({}));
        vi.stubGlobal('fetch', native);
        const { prepareFubonSession } = await import('./fubon-session');
        expect(await prepareFubonSession()).toBe(true);
        await fetch('/api/v1/watchlist', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        const request = native.mock.calls.at(-1)?.[1];
        expect(request.headers.get('Authorization')).toBe(`Bearer ${token}`);
        expect(request.redirect).toBe('error');
        expect(request.credentials).toBe('omit');
        await fetch('http://127.0.0.1:9999/api/v1/info');
        expect(native.mock.calls.at(-1)).toEqual(['http://127.0.0.1:9999/api/v1/info', undefined]);
        await fetch('https://example.com/collect');
        expect(native.mock.calls.at(-1)).toEqual(['https://example.com/collect', undefined]);
    });

    it('removes stale session authority after restart and never unlocks without a capability', async () => {
        const storage = browser('', token);
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 401 })));
        const { prepareFubonSession } = await import('./fubon-session');
        expect(await prepareFubonSession()).toBe(false);
        expect(storage.size).toBe(0);
    });

    it('does not send malformed capabilities or expose them in errors', async () => {
        browser('#fubon-launch=bad-secret');
        const native = vi.fn(); vi.stubGlobal('fetch', native);
        const { prepareFubonSession } = await import('./fubon-session');
        expect(await prepareFubonSession()).toBe(false);
        expect(native).not.toHaveBeenCalled();
        expect(history.replaceState).toHaveBeenCalled();
    });

    it('authenticates streaming requests and never places tokens in the stream URL', async () => {
        browser('', token);
        const native = vi.fn().mockResolvedValueOnce(Response.json({}));
        native.mockResolvedValueOnce(new Response(new ReadableStream({ start(controller) {
            controller.enqueue(new TextEncoder().encode('event: heartbeat\ndata: {"ok":true}\n\n')); controller.close();
        } }), { headers: { 'Content-Type': 'text/event-stream' } }));
        vi.stubGlobal('fetch', native);
        const { prepareFubonSession, openFubonEventSource } = await import('./fubon-session');
        expect(await prepareFubonSession()).toBe(true);
        const source = openFubonEventSource('http://127.0.0.1:5179/api/v1/stream/data');
        const events: string[] = [];
        source.addEventListener('heartbeat', event => events.push((event as MessageEvent).data));
        await vi.waitFor(() => expect(events).toEqual(['{"ok":true}']));
        const [url, options] = native.mock.calls.at(-1)!;
        expect(url).not.toContain(token);
        expect(options.headers.get('Authorization')).toBe(`Bearer ${token}`);
        source.close();
    });
});

it('recognizes only the same origin API, including Request inputs', () => {
    expect(isLocalApi('/api/v1/info', 'http://127.0.0.1:5179')).toBe(true);
    expect(isLocalApi('http://127.0.0.1:5178/api/v1/info', 'http://127.0.0.1:5179')).toBe(false);
    expect(isLocalApi(new Request('http://127.0.0.1:5179/assets/main.js'), 'http://127.0.0.1:5179')).toBe(false);
});

it('parses SSE split CRLF, multiple data lines, unicode, and named events', () => {
    const events: string[][] = [];
    const parser = new SseParser((name, data) => events.push([name, data]));
    for (const piece of [':comment\r', '\nevent: tick\r\ndata: 台', '指\r', '\ndata: 2\r\n\r', '\ndata: next\n\n']) parser.push(piece);
    expect(events).toEqual([['tick', '台指\n2'], ['message', 'next']]);
});


it('locks locally when logout is unavailable and bounds the request timeout', async () => {
    const storage = browser('', token);
    vi.stubGlobal('location', { hash: '', origin: 'http://127.0.0.1:5179', pathname: '/', search: '', reload: vi.fn() });
    const native = vi.fn().mockResolvedValueOnce(Response.json({})).mockRejectedValueOnce(new Error('offline'));
    vi.stubGlobal('fetch', native);
    const { prepareFubonSession, logoutFubonSession } = await import('./fubon-session');
    expect(await prepareFubonSession()).toBe(true);
    await logoutFubonSession();
    expect(storage.size).toBe(0);
    expect(location.reload).toHaveBeenCalledOnce();
    expect(native.mock.calls.at(-1)?.[1].signal).toBeInstanceOf(AbortSignal);
});
