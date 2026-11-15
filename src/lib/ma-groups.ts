import { validateMALines, type MALinePreset } from './ma-presets';

export interface MAGroup { id: string; name: string; lines: MALinePreset[] }
const KEY = 'fubon-ma-groups-v1';
let cachedRaw: string | null | undefined;
const EMPTY: MAGroup[] = [];
let cached: MAGroup[] = EMPTY;
const listeners = new Set<() => void>();

function validGroup(value: unknown): value is MAGroup {
    if (!value || typeof value !== 'object') return false;
    const group = value as MAGroup;
    if (typeof group.id !== 'string' || !group.id || typeof group.name !== 'string' || !group.name.trim() || group.name.length > 30 || !Array.isArray(group.lines)) return false;
    try { validateMALines(group.lines); return true; } catch { return false; }
}

export function listMAGroups(): MAGroup[] {
    try {
        const raw = localStorage.getItem(KEY);
        if (raw !== cachedRaw) {
            cachedRaw = raw;
            const parsed: unknown = raw ? JSON.parse(raw) : [];
            cached = Array.isArray(parsed) ? parsed.filter(validGroup).slice(0, 20) : [];
        }
    } catch { cachedRaw = undefined; cached = EMPTY; }
    return cached;
}

export function subscribeMAGroups(listener: () => void) {
    listeners.add(listener);
    const changed = (event: StorageEvent) => { if (!event.key || event.key === KEY) listener(); };
    window.addEventListener('storage', changed);
    return () => { listeners.delete(listener); window.removeEventListener('storage', changed); };
}

function persist(groups: MAGroup[]) {
    try { localStorage.setItem(KEY, JSON.stringify(groups)); }
    catch { throw new Error('無法儲存到本機，請確認瀏覽器儲存空間後重試'); }
    cachedRaw = undefined;
    for (const listener of listeners) listener();
}

export function saveMAGroup(input: { id?: string; name: string; lines: MALinePreset[] }): MAGroup {
    const name = input.name.trim();
    if (!name || name.length > 30) throw new Error('組合名稱須為 1–30 個字');
    validateMALines(input.lines);
    const groups = listMAGroups();
    if (input.id && !groups.some(g => g.id === input.id)) throw new Error('此組合已刪除，請重新建立');
    if (groups.some(g => g.id !== input.id && g.name.toLocaleLowerCase() === name.toLocaleLowerCase())) throw new Error('已有相同名稱的組合，請使用其他名稱');
    if (!input.id && groups.length >= 20) throw new Error('最多儲存 20 個均線組合');
    const group = { id: input.id ?? crypto.randomUUID(), name, lines: structuredClone(input.lines) };
    persist(input.id ? groups.map(g => g.id === input.id ? group : g) : [...groups, group]);
    return group;
}

export function deleteMAGroup(id: string) {
    persist(listMAGroups().filter(g => g.id !== id));
}
