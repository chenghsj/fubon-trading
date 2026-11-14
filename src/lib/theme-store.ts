// src/lib/theme-store.ts — theme settings (mode + price-color convention),
// persisted to localStorage and applied as a class on <html>. On desktop
// the native window chrome (titlebar appearance) follows the mode too.

import { useSyncExternalStore } from 'react';
import { isTauri } from './runtime';
import { themeClasses, vars } from '../theme.css';
import { CUSTOM_BASES, alpha, customTokens, isCustomTheme, type CustomTheme } from './custom-theme';
import { THEME_PALETTES } from './theme-palette';

export type ThemeMode = 'dark' | 'light' | 'custom';
export type Convention = 'tw' | 'intl';
// 小／標準／大（2026-09-29 起整體放大一級，原本的 0.85 小拿掉）
export type FontScale = 1 | 1.15 | 1.3;

export interface ThemeSettings {
    mode: ThemeMode;
    convention: Convention;
    fontScale: FontScale;
    /** 自訂配色；mode 為 custom 時套用，切回深色／淺色時保留以便再切回來 */
    custom?: CustomTheme;
}

const STORAGE_KEY = 'sj-pro-theme';
const MODES: ThemeMode[] = ['dark', 'light', 'custom'];
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
                MODES.includes(mode as ThemeMode) &&
                CONVENTIONS.includes(s.convention as Convention)
            ) {
                const custom = isCustomTheme(s.custom) ? s.custom : undefined;
                return {
                    // 自訂配色遺失時退回深色
                    mode: mode === 'custom' && !custom ? 'dark' : (mode as ThemeMode),
                    convention: s.convention as Convention,
                    fontScale: migrateScale(s.fontScale),
                    ...(custom ? { custom } : {}),
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

/** 實際套用的起始底色：自訂配色以其 base 的 theme class 為底 */
export function baseMode(s: ThemeSettings): 'dark' | 'light' {
    return s.mode === 'custom' ? (s.custom?.base ?? 'dark') : s.mode;
}

/** 圖表等以 canvas 繪製的元件用來判斷是否需要重新套色 */
export function themeKey(s: ThemeSettings): string {
    const custom = activeCustom(s);
    return `${s.mode}-${s.convention}${custom ? `-${Object.values(custom).join(',')}` : ''}`;
}

/** 目前生效的自訂配色（mode 不是 custom 時為 undefined） */
export function activeCustom(s: ThemeSettings): CustomTheme | undefined {
    return s.mode === 'custom' ? (s.custom ?? CUSTOM_BASES.dark) : undefined;
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
    // 自訂配色：六色推算的 token 以 inline 變數蓋在底色 class 上；
    // 切回深色／淺色時移除
    const custom = activeCustom(settings);
    const tokens = custom ? customTokens(custom, settings.convention) : {};
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
// with the in-app theme — dark → dark, light → light (custom follows its base)
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
            crosshair: t.accent!,
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
        crosshair: p.accent,
        border: p.border,
        labelBg: p.panelRaised,
    };
}
