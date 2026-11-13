/** Only a single-use launch capability can create this process's API session.
 * Session authority stays in this tab's sessionStorage; never cookies, URLs,
 * localStorage, analytics, or the Vite build environment. */
const STORAGE_KEY = 'fubon-trading-session';
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
let accessToken = '';
let installed = false;

export function isLocalApi(input: RequestInfo | URL, origin: string): boolean {
    const url = new URL(input instanceof Request ? input.url : String(input), origin);
    return url.origin === origin && url.pathname.startsWith('/api/');
}

export async function prepareFubonSession(): Promise<boolean> {
    const originalFetch = globalThis.fetch.bind(globalThis);
    const fragment = new URLSearchParams(location.hash.slice(1));
    let launch = fragment.get('fubon-launch');
    if (launch !== null) {
        // Remove the capability before loading any application/analytics modules.
        history.replaceState(null, '', location.pathname + location.search);
    }
    try {
        if (launch !== null) {
            if (!TOKEN.test(launch)) throw new Error('Invalid launch capability');
            const response = await originalFetch('/api/v1/session', {
                method: 'POST', headers: { Authorization: `Bearer ${launch}`, 'Content-Type': 'application/json' },
                body: '{}', credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(10_000),
            });
            launch = null;
            if (!response.ok) throw new Error('Launch denied');
            const result: unknown = await response.json();
            const value = (result as { access_token?: unknown })?.access_token;
            if (typeof value !== 'string' || !TOKEN.test(value)) throw new Error('Invalid session');
            accessToken = value;
            try { sessionStorage.setItem(STORAGE_KEY, value); } catch { /* Memory-only session still works. */ }
        } else {
            try { accessToken = sessionStorage.getItem(STORAGE_KEY) ?? ''; } catch { /* storage unavailable */ }
        }
        if (!TOKEN.test(accessToken)) throw new Error('Session missing');
        const response = await originalFetch('/api/v1/info', {
            headers: { Authorization: `Bearer ${accessToken}` },
            credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) throw new Error('Session expired');
        if (!installed) {
            globalThis.fetch = (input, init) => {
                if (!isLocalApi(input, location.origin)) return originalFetch(input, init);
                const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
                headers.set('Authorization', `Bearer ${accessToken}`);
                // Never forward authority through a redirect to another origin.
                return originalFetch(input, { ...init, headers, credentials: 'omit', redirect: 'error' });
            };
            installed = true;
        }
        return true;
    } catch {
        launch = null;
        accessToken = '';
        try { sessionStorage.removeItem(STORAGE_KEY); } catch { /* storage unavailable */ }
        return false;
    }
}

/** Native EventSource cannot attach Authorization. REST and SSE must enforce
 * the same authority; no query-string tickets or port-shared cookies. The
 * existing stream watchdog owns reconnection, so this adapter never retries. */
class AuthorizedEventSource extends EventTarget {
    onopen: ((event: Event) => void) | null = null;
    onerror: ((event: Event) => void) | null = null;
    private controller = new AbortController();

    constructor(url: string) {
        super();
        void Promise.resolve().then(() => this.read(url));
    }

    close() { this.controller.abort(); }

    private async read(url: string) {
        try {
            const response = await fetch(url, { headers: { Accept: 'text/event-stream' }, signal: this.controller.signal });
            if (!response.ok || !response.headers.get('content-type')?.startsWith('text/event-stream') || !response.body) throw new Error('Stream unavailable');
            if (this.controller.signal.aborted) return;
            this.onopen?.(new Event('open'));
            const reader = response.body.getReader();
            const parser = new SseParser((name, data) => {
                if (!this.controller.signal.aborted) this.dispatchEvent(new MessageEvent(name, { data }));
            });
            const decoder = new TextDecoder();
            try {
                while (!this.controller.signal.aborted) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    parser.push(decoder.decode(value, { stream: true }));
                }
            } finally {
                await reader.cancel().catch(() => undefined);
                reader.releaseLock();
            }
            if (!this.controller.signal.aborted) throw new Error('Stream ended');
        } catch {
            if (!this.controller.signal.aborted) this.onerror?.(new Event('error'));
        }
    }
}

export class SseParser {
    private line = '';
    private name = 'message';
    private data: string[] = [];
    private size = 0;
    private afterCR = false;
    constructor(private emit: (name: string, data: string) => void) {}
    push(chunk: string) {
        for (const character of chunk) {
            if (this.afterCR && character === '\n') { this.afterCR = false; continue; }
            this.afterCR = character === '\r';
            if (character !== '\r' && character !== '\n') {
                this.line += character;
                if (++this.size > 1_048_576) throw new Error('Stream frame too large');
                continue;
            }
            const line = this.line;
            this.line = '';
            if (!line) {
                if (this.data.length) this.emit(this.name, this.data.join('\n'));
                this.name = 'message'; this.data = []; this.size = 0;
            } else {
                const colon = line.indexOf(':');
                const field = colon < 0 ? line : line.slice(0, colon);
                const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
                if (field === 'event') this.name = value || 'message';
                if (field === 'data') this.data.push(value);
            }
        }
    }
}

export function openFubonEventSource(url: string): EventSource {
    if (!accessToken || !isLocalApi(url, location.origin)) return new EventSource(url);
    return new AuthorizedEventSource(url) as unknown as EventSource;
}
