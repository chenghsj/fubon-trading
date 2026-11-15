import { apiPost } from './api';

/** Preserve FastAPI detail messages without changing manual order API semantics. */
export async function fubonPost<T>(path: string, body: unknown, timeoutMs?: number): Promise<T> {
    let detail: Promise<string> | undefined;
    try {
        return await apiPost<T>(path, body, { timeoutMs, onResponse: response => {
            if (!response.ok) detail = response.clone().json().then(data => {
                if (typeof data.detail === 'string') return data.detail;
                if (Array.isArray(data.detail)) return data.detail.map((item: { loc?: string[]; msg?: string }) => `${item.loc?.slice(1).join('.') ?? ''}：${item.msg ?? '格式無效'}`).join('；');
                return typeof data.message === 'string' ? data.message : '';
            }).catch(() => '');
        } });
    } catch (error) {
        throw new Error((await detail) || (error instanceof Error ? error.message : String(error)));
    }
}
