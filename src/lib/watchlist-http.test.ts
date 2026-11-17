import { afterEach, expect, it, vi } from 'vitest';
import { apiDelete } from './api';
import { deleteWatchlist, fetchWatchlists, renameWatchlist, type ServerWatchlist } from './shioaji';

afterEach(() => { vi.unstubAllGlobals(); });

it('sends the JSON content type on a bodyless DELETE accepted by the local bridge', async () => {
    const fetch = vi.fn((_url: string, init: RequestInit) => {
        const json = new Headers(init.headers).get('Content-Type') === 'application/json';
        return Promise.resolve(new Response(JSON.stringify(json ? { success: true } : { detail: 'application/json required' }), { status: json ? 200 : 415 }));
    });
    vi.stubGlobal('fetch', fetch);
    await expect(apiDelete('/api/v1/watchlist/old')).resolves.toEqual({ success: true });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]?.[1]?.body).toBeUndefined();
});

it('renames through the real client transport and removes the old list, then deletes the new one', async () => {
    const original: ServerWatchlist = { id: 'old', name: '原清單', contracts: [{ code: '2330', security_type: 'STK', exchange: 'TSE' }] };
    const lists = new Map<string, ServerWatchlist>([[original.id, original]]);
    vi.stubGlobal('fetch', vi.fn((url: string, init: RequestInit = {}) => {
        const path = new URL(url, 'http://localhost').pathname;
        const method = init.method ?? 'GET';
        if (['POST', 'PUT', 'DELETE'].includes(method) && new Headers(init.headers).get('Content-Type') !== 'application/json') {
            return Promise.resolve(new Response('{"detail":"application/json required"}', { status: 415 }));
        }
        if (method === 'POST' && path === '/api/v1/watchlist') {
            const next = { ...JSON.parse(String(init.body)), id: 'new' } as ServerWatchlist;
            lists.set(next.id, next);
            return Promise.resolve(Response.json(next));
        }
        if (method === 'DELETE') {
            lists.delete(path.split('/').at(-1)!);
            return Promise.resolve(Response.json({ success: true }));
        }
        return Promise.resolve(Response.json([...lists.values()]));
    }));
    const renamed = await renameWatchlist(original, '新清單');
    expect(await fetchWatchlists()).toEqual([{ ...original, id: 'new', name: '新清單' }]);
    expect(renamed.contracts).toEqual(original.contracts);
    await deleteWatchlist(renamed.id);
    expect(await fetchWatchlists()).toEqual([]);
});
