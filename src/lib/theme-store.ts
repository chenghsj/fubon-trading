// src/lib/theme-store.ts — theme settings (mode + price-color convention),
// persisted to localStorage and applied as a class on <html>. On desktop
// the native window chrome (titlebar appearance) follows the mode too.

import { useSyncExternalStore } from 'react';
import { isTauri } from './runtime';
import { themeClasses, vars } from '../theme.css';
import { CUSTOM_COLOR_FIELDS, CUSTOM_PRESETS, alpha, customTokens, isCustomTheme, type CustomTheme } from './custom-theme';
import { THEME_PALETTES } from './theme-palette';
import { activeCustom, baseMode, currentTheme } from './theme-appearance';
export { activeCustom, baseMode, currentTheme } from './theme-appearance';

export type ThemeMode = 'system' | 'dark' | 'light';
export type Convention = 'tw' | 'intl';
// 小／標準／大（2026-09-29 起整體放大一級，原本的 0.85 小拿掉）
export type FontScale = 1 | 1.15 | 1.3;

export interface ThemeSettings {
    mode: ThemeMode;
    convention: Convention;
    fontScale: FontScale;
    /** 與深淺模式分開；未指定時使用內建配色，custom 使用儲存的六色。 */
    preset?: string;
    custom?: CustomTheme;
    accent?: string;
}

const STORAGE_KEY = 'sj-pro-theme';
const MODES: ThemeMode[] = ['system', 'dark', 'light'];
const CONVENTIONS: Convention[] = ['tw', 'intl'];
const SCALES: FontScale[] = [1, 1.15, 1.3];
const DEFAULT_SCALE: FontScale = 1.15;

// 舊設定：純黑（midnight）即現在的深色；0.85 已移除，改為最小的 1
function migrateMode(mode: unknown): unknown {
    return mode === 'midnight' ? 'dark' : mode;
}
function migrateScale(scale: unknown): FontScale {
    if (scale === 0.85) return 1;
    return SCALES.includes(scale as FontScale) ? (scale as FontScale) : DEFAULT_SCALE;
}

function load(): ThemeSettings {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) {
            const s = JSON.parse(raw) as Partial<Record<keyof ThemeSettings, unknown>>;
            const mode = migrateMode(s.mode);
            if (
                (MODES.includes(mode as ThemeMode) || mode === 'custom') &&
                CONVENTIONS.includes(s.convention as Convention)
            ) {
                const custom = isCustomTheme(s.custom) ? s.custom : undefined;
                const legacyPreset = mode === 'custom' && custom
                    ? CUSTOM_PRESETS.find(p => p.theme.base === custom.base && CUSTOM_COLOR_FIELDS.every(({ key }) => p.theme[key].toLowerCase() === custom[key].toLowerCase()))?.name ?? 'custom'
                    : undefined;
                const preset = legacyPreset ?? (s.preset === 'custom' && custom || CUSTOM_PRESETS.some(p => p.name === s.preset) ? s.preset as string : undefined);
                return {
                    mode: mode === 'custom' ? custom?.base ?? 'dark' : mode as ThemeMode,
                    convention: s.convention as Convention,
                    fontScale: migrateScale(s.fontScale),
                    ...(preset ? { preset } : {}),
                    ...(custom ? { custom } : {}),
                    ...(typeof s.accent === 'string' && /^#[0-9a-f]{6}$/i.test(s.accent) ? { accent: s.accent } : {}),
                };
            }
        }
    } catch {
        // corrupted settings — use defaults
    }
    return { mode: 'dark', convention: 'tw', fontScale: DEFAULT_SCALE };
}

let settings: ThemeSettings = load();
const listeners = new Set<() => void>();
let systemQuery: MediaQueryList | undefined;

/** 圖表等以 canvas 繪製的元件用來判斷是否需要重新套色 */
export function themeKey(s: ThemeSettings): string {
    const custom = activeCustom(s);
    return `${baseMode(s)}-${s.convention}${custom ? `-${Object.values(custom).join(',')}` : ''}${s.accent ? `-${s.accent}` : ''}`;
}

const colorVars = vars.color as Record<string, string>;
// 'var(--color-accent__abc)' → '--color-accent__abc'
const cssVarName = (ref: string) => ref.slice(4, -1);

function applyClass() {
    const root = document.documentElement;
    for (const cls of Object.values(themeClasses)) {
        root.classList.remove(cls);
    }
    const base = baseMode(settings);
    const key = `${base}-${settings.convention}`;
    const cls = themeClasses[key] ?? themeClasses['dark-tw'];
    if (cls) root.classList.add(cls);
    // 主題配色以 inline 變數蓋在深淺模式 class 上；預設主題移除覆寫。
    const custom = activeCustom(settings);
    const tokens = custom ? customTokens(custom, settings.convention) : {};
    if (settings.accent) {
        const accentTokens = customTokens(currentTheme(settings), settings.convention);
        for (const name of ['accent', 'onAccent', 'accentDim']) tokens[name] = accentTokens[name]!;
    }
    for (const [name, ref] of Object.entries(colorVars)) {
        const value = tokens[name];
        if (value) root.style.setProperty(cssVarName(ref), value);
        else root.style.removeProperty(cssVarName(ref));
    }
    // light/dark <select>/scrollbar rendering follows this hint too
    root.style.colorScheme = base === 'light' ? 'light' : 'dark';
    // every style is rem-based, so scaling the root font-size scales the UI
    root.style.fontSize = `${16 * settings.fontScale}px`;
}

// sync the native window chrome (macOS appearance / Windows titlebar)
// with the resolved in-app appearance, including system preference changes.
async function applyNativeTheme() {
    if (!isTauri) return;
    try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window');
        await getCurrentWindow().setTheme(baseMode(settings));
    } catch {
        // older runtime without set-theme permission
    }
}

export function initTheme() {
    if (!systemQuery && typeof window !== 'undefined' && window.matchMedia) {
        systemQuery = window.matchMedia('(prefers-color-scheme: dark)');
        const onSystemChange = () => {
            if (settings.mode !== 'system') return;
            // A fresh snapshot also updates canvas charts and other store subscribers.
            settings = { ...settings };
            applyClass();
            void applyNativeTheme();
            listeners.forEach(l => l());
        };
        if (systemQuery.addEventListener) systemQuery.addEventListener('change', onSystemChange);
        else systemQuery.addListener(onSystemChange);
    }
    applyClass();
    void applyNativeTheme();
}

export function setThemeSettings(next: Partial<ThemeSettings>) {
    settings = { ...settings, ...next };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    applyClass();
    void applyNativeTheme();
    listeners.forEach((l) => l());
}

export function useThemeSettings(): ThemeSettings {
    return useSyncExternalStore(
        (l) => {
            listeners.add(l);
            return () => listeners.delete(l);
        },
        () => settings,
    );
}

// ---- chart palette (canvas needs concrete color strings) ----

export interface ChartColors {
    up: string;
    upVol: string;
    down: string;
    downVol: string;
    text: string;
    grid: string;
    crosshair: string;
    border: string;
    labelBg: string;
}

export function getChartColors(s: ThemeSettings): ChartColors {
    const custom = activeCustom(s);
    if (custom) {
        const t = customTokens(custom, s.convention);
        const up = t.up!;
        const down = t.down!;
        return {
            up,
            upVol: alpha(up, 0.42),
            down,
            downVol: alpha(down, 0.4),
            text: t.mutedForeground!,
            grid: alpha(t.border!, 0.7),
            crosshair: s.accent ?? t.accent!,
            border: t.border!,
            labelBg: t.panelRaised!,
        };
    }
    const mode = baseMode(s);
    const p = THEME_PALETTES[mode];
    const redVol = alpha(p.red, mode === 'dark' ? 0.45 : 0.4);
    const greenVol = alpha(p.green, mode === 'dark' ? 0.4 : 0.35);
    const isTw = s.convention === 'tw';
    return {
        up: isTw ? p.red : p.green,
        upVol: isTw ? redVol : greenVol,
        down: isTw ? p.green : p.red,
        downVol: isTw ? greenVol : redVol,
        text: p.mutedForeground,
        grid: alpha(p.border, mode === 'dark' ? 0.7 : 0.9),
        crosshair: s.accent ?? p.accent,
        border: p.border,
        labelBg: p.panelRaised,
    };
}
