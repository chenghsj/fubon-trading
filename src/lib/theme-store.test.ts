import { afterEach, describe, expect, it, vi } from 'vitest';

const rootStyle = { props: new Map<string, string>(), setProperty(k: string, v: string) { this.props.set(k, v); }, removeProperty(k: string) { this.props.delete(k); } } as { props: Map<string, string>; setProperty(k: string, v: string): void; removeProperty(k: string): void; [k: string]: unknown };

async function loadWith(saved: unknown) {
    rootStyle.props.clear();
    vi.resetModules();
    const store = new Map<string, string>();
    if (saved !== undefined) store.set('sj-pro-theme', JSON.stringify(saved));
    vi.stubGlobal('localStorage', {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
    });
    vi.stubGlobal('document', { documentElement: { classList: { add() {}, remove() {} }, style: rootStyle } });
    vi.doMock('../theme.css', () => ({ themeClasses: {}, vars: { color: { accent: 'var(--accent)', up: 'var(--up)' } } }));
    const mod = await import('./theme-store');
    return mod;
}

afterEach(() => {
    vi.unstubAllGlobals();
    vi.doUnmock('../theme.css');
});

describe('theme settings migration', () => {
    it('defaults to dark with the standard (enlarged) font size', async () => {
        const m = await loadWith(undefined);
        m.setThemeSettings({});
        expect(JSON.parse((globalThis.localStorage as Storage).getItem('sj-pro-theme')!)).toEqual({ mode: 'dark', convention: 'tw', fontScale: 1.15 });
    });

    it('maps the old 純黑 mode to dark and the removed 0.85 size to the smallest', async () => {
        const m = await loadWith({ mode: 'midnight', convention: 'intl', fontScale: 0.85 });
        m.setThemeSettings({});
        expect(JSON.parse((globalThis.localStorage as Storage).getItem('sj-pro-theme')!)).toEqual({ mode: 'dark', convention: 'intl', fontScale: 1 });
    });

    it('keeps an existing size and light mode as saved', async () => {
        const m = await loadWith({ mode: 'light', convention: 'tw', fontScale: 1.3 });
        m.setThemeSettings({});
        expect(JSON.parse((globalThis.localStorage as Storage).getItem('sj-pro-theme')!)).toEqual({ mode: 'light', convention: 'tw', fontScale: 1.3 });
    });

    it('migrates legacy custom colors and clears the override when choosing the default theme', async () => {
        const custom = { base: 'dark', background: '#0b1628', panel: '#132238', foreground: '#dfe7f5', accent: '#4da3ff', red: '#ff4d5e', green: '#22c997' };
        const m = await loadWith({ mode: 'custom', convention: 'intl', fontScale: 1.15, custom });
        m.initTheme();
        expect(rootStyle.props.get('--accent')).toBe('#4da3ff');
        expect(rootStyle.props.get('--up')).toBe('#22c997'); // 綠漲紅跌
        expect(m.getChartColors({ mode: 'dark', preset: 'custom', convention: 'tw', fontScale: 1.15, custom: custom as never }).up).toBe('#ff4d5e');
        m.setThemeSettings({ preset: undefined });
        expect(rootStyle.props.has('--accent')).toBe(false);
        // 切回深色仍保留自訂配色，之後可再切回
        expect(JSON.parse((globalThis.localStorage as Storage).getItem('sj-pro-theme')!).custom).toEqual(custom);
    });

    it('falls back to dark when a saved custom theme is invalid', async () => {
        const m = await loadWith({ mode: 'custom', convention: 'tw', fontScale: 1.15, custom: { base: 'dark', background: 'red' } });
        m.setThemeSettings({});
        expect(JSON.parse((globalThis.localStorage as Storage).getItem('sj-pro-theme')!).mode).toBe('dark');
    });

    it('recognizes legacy presets while preserving the chosen base and colors', async () => {
        const m = await loadWith(undefined);
        const { CUSTOM_PRESETS } = await import('./custom-theme');
        const preset = CUSTOM_PRESETS.find(p => p.name === 'Proof')!;
        const migrated = await loadWith({ mode: 'custom', convention: 'intl', fontScale: 1, custom: preset.theme });
        migrated.setThemeSettings({});
        expect(JSON.parse(localStorage.getItem('sj-pro-theme')!)).toMatchObject({ mode: 'light', preset: 'Proof', convention: 'intl', custom: preset.theme });
        expect(m.baseMode({ mode: 'light' })).toBe('light');
    });

    it('keeps the selected theme across modes and restores it after an unavailable variant', async () => {
        const m = await loadWith({ mode: 'light', convention: 'tw', fontScale: 1, preset: 'Proof', accent: '#123456' });
        m.initTheme();
        expect(m.currentTheme({ mode: 'light', convention: 'tw', fontScale: 1, preset: 'Proof', accent: '#123456' })).toMatchObject({ background: '#f5f3ed', accent: '#123456' });
        expect(rootStyle.props.get('--accent')).toBe('#123456');
        m.setThemeSettings({ mode: 'dark', accent: undefined });
        expect(rootStyle.props.has('--accent')).toBe(false);
        m.setThemeSettings({ mode: 'light' });
        expect(rootStyle.props.get('--accent')).toBe('#3b715a');
        expect(JSON.parse(localStorage.getItem('sj-pro-theme')!).preset).toBe('Proof');
    });

    it('ignores unknown theme names and invalid saved accent values', async () => {
        const m = await loadWith({ mode: 'system', convention: 'tw', preset: 'missing', accent: 'red' });
        m.setThemeSettings({});
        expect(JSON.parse(localStorage.getItem('sj-pro-theme')!)).toEqual({ mode: 'system', convention: 'tw', fontScale: 1.15 });
    });

    it('follows OS changes only in system mode and installs a single listener', async () => {
        let dark = false;
        let onChange = () => {};
        const addEventListener = vi.fn((_event: string, listener: () => void) => { onChange = listener; });
        vi.stubGlobal('window', { matchMedia: () => ({ get matches() { return dark; }, addEventListener }) });
        const m = await loadWith({ mode: 'system', convention: 'tw', fontScale: 1, preset: 'Catppuccin' });
        m.initTheme(); m.initTheme();
        expect(addEventListener).toHaveBeenCalledTimes(1);
        expect(rootStyle.props.get('--accent')).toBe('#8337e5');
        const lightKey = m.themeKey({ mode: 'system', convention: 'tw', fontScale: 1 });
        dark = true; onChange();
        expect(rootStyle.props.get('--accent')).toBe('#cba6f7');
        expect(m.themeKey({ mode: 'system', convention: 'tw', fontScale: 1 })).not.toBe(lightKey);
        m.setThemeSettings({ mode: 'light' });
        onChange();
        expect(rootStyle.props.get('--accent')).toBe('#8337e5');
    });

    it('supports system appearance changes in older WebViews with addListener', async () => {
        let dark = false;
        let onChange = () => {};
        vi.stubGlobal('window', { matchMedia: () => ({ get matches() { return dark; }, addListener: (listener: () => void) => { onChange = listener; } }) });
        const m = await loadWith({ mode: 'system', convention: 'tw', fontScale: 1, preset: 'Catppuccin' });
        m.initTheme();
        expect(rootStyle.props.get('--accent')).toBe('#8337e5');
        dark = true; onChange();
        expect(rootStyle.props.get('--accent')).toBe('#cba6f7');
    });
});
