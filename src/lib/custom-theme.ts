// src/lib/custom-theme.ts — 自訂配色（主題「自訂」）：使用者只挑六個顏色，
// 其餘 token（面板層次、邊框、次要文字、漲跌底色）由這六色推算，
// 以 inline CSS 變數蓋在起始底色（深色／淺色）的 theme class 上。

import type { Convention } from './theme-store';
import { THEME_PALETTES, solidPriceColor } from './theme-palette';

export type CustomBase = 'dark' | 'light';

export interface CustomTheme {
    base: CustomBase;
    background: string;
    panel: string;
    foreground: string;
    accent: string;
    red: string;
    green: string;
}

export type CustomColorKey = Exclude<keyof CustomTheme, 'base'>;

export const CUSTOM_COLOR_FIELDS: { key: CustomColorKey; label: string }[] = [
    { key: 'background', label: '背景' },
    { key: 'panel', label: '面板' },
    { key: 'foreground', label: '文字' },
    { key: 'accent', label: '強調色' },
    { key: 'red', label: '紅（漲跌）' },
    { key: 'green', label: '綠（漲跌）' },
];

// 自訂配色的起點與內建主題共用色票；已儲存的自訂配色維持原值。
function customBase(base: CustomBase): CustomTheme {
    const { background, panel, foreground, accent, red, green } = THEME_PALETTES[base];
    return { base, background, panel, foreground, accent, red, green };
}

export const CUSTOM_BASES: Record<CustomBase, CustomTheme> = {
    dark: customBase('dark'),
    light: customBase('light'),
};

export { CODEX_THEME_PRESETS as CUSTOM_PRESETS } from './codex-theme-presets';

// 狀態錯誤色（朱紅）：不跟使用者挑的漲跌紅，固定依底色，與 theme.css.ts 一致
export const CUSTOM_DANGER: Record<CustomBase, { danger: string; dangerSolid: string }> = {
    dark: { danger: THEME_PALETTES.dark.danger, dangerSolid: THEME_PALETTES.dark.dangerSolid },
    light: { danger: THEME_PALETTES.light.danger, dangerSolid: THEME_PALETTES.light.dangerSolid },
};

const HEX = /^#[0-9a-f]{6}$/i;

export function isCustomTheme(v: unknown): v is CustomTheme {
    if (!v || typeof v !== 'object') return false;
    const t = v as Record<string, unknown>;
    return (
        (t.base === 'dark' || t.base === 'light') &&
        CUSTOM_COLOR_FIELDS.every(({ key }) => typeof t[key] === 'string' && HEX.test(t[key] as string))
    );
}

function rgb(hex: string): [number, number, number] {
    const n = parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** a→b 依 t（0–1）混色，回傳 #rrggbb */
export function mix(a: string, b: string, t: number): string {
    const [ar, ag, ab] = rgb(a);
    const [br, bg, bb] = rgb(b);
    const c = (x: number, y: number) => Math.round(x + (y - x) * t).toString(16).padStart(2, '0');
    return `#${c(ar, br)}${c(ag, bg)}${c(ab, bb)}`;
}

export function alpha(hex: string, a: number): string {
    const [r, g, b] = rgb(hex);
    return `rgba(${r}, ${g}, ${b}, ${a})`;
}

function luminance(hex: string): number {
    const [r, g, b] = rgb(hex).map(value => {
        const channel = value / 255;
        return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    });
    return r! * 0.2126 + g! * 0.7152 + b! * 0.0722;
}

/** 選擇對強調色底對比最高的字色，亮／暗及任意自訂色都適用。 */
function onAccent(hex: string): string {
    return luminance(hex) > 0.179 ? '#000000' : '#ffffff';
}

// 有些 Codex 色票的文字較柔和，固定比例混色會讓次要文字失去對比。
// 由原本的混色比例逐步靠近使用者文字色；不更動儲存的六色色票。
function mutedForeground(t: CustomTheme): string {
    const share = t.base === 'dark' ? 0.42 : 0.3;
    const surfaces = [t.background, t.panel, mix(t.panel, t.foreground, t.base === 'dark' ? 0.04 : 0.02)].map(luminance);
    for (let step = 0; step <= 100; step++) {
        const color = mix(t.foreground, t.panel, share * (1 - step / 100));
        const value = luminance(color);
        if (surfaces.every(surface => (Math.max(value, surface) + 0.05) / (Math.min(value, surface) + 0.05) >= 4.5)) {
            return color;
        }
    }
    return t.foreground;
}

/** 六色推算出完整的 color token（鍵名同 theme.css.ts 的 vars.color） */
export function customTokens(t: CustomTheme, convention: Convention): Record<string, string> {
    const dark = t.base === 'dark';
    const fg = t.foreground;
    const up = convention === 'tw' ? t.red : t.green;
    const down = convention === 'tw' ? t.green : t.red;
    const dim = dark ? 0.13 : 0.1;
    const flash = dark ? 0.2 : 0.16;
    const mutedFg = mutedForeground(t);
    return {
        background: t.background,
        panel: t.panel,
        panelRaised: mix(t.panel, fg, dark ? 0.04 : 0.02),
        inset: mix(t.background, t.panel, 0.4),
        foreground: fg,
        muted: mix(t.panel, fg, dark ? 0.07 : 0.06),
        mutedForeground: mutedFg,
        border: mix(t.panel, fg, dark ? 0.1 : 0.12),
        borderBright: mix(t.panel, fg, dark ? 0.18 : 0.22),
        accent: t.accent,
        onAccent: onAccent(t.accent),
        accentDim: alpha(t.accent, dark ? 0.12 : 0.1),
        magenta: mutedFg,
        up,
        upSolid: solidPriceColor(up),
        upDim: alpha(up, dim),
        upFlash: alpha(up, flash),
        down,
        downSolid: solidPriceColor(down),
        upControl: dark ? mix(up, '#ffffff', 0.26) : mix(up, '#000000', 0.2),
        downControl: dark ? mix(down, '#ffffff', 0.26) : mix(down, '#000000', 0.2),
        downDim: alpha(down, dim),
        downFlash: alpha(down, flash),
        // 日內區間軌的引線：同 theme.css.ts，深底往次要文字色混一半、淺底往底色混兩成
        wickUp: dark ? mix(up, mutedFg, 0.5) : mix(up, t.panel, 0.2),
        wickDown: dark ? mix(down, mutedFg, 0.5) : mix(down, t.panel, 0.2),
        flat: mutedFg,
        success: t.green,
        successSolid: solidPriceColor(t.green),
        successDim: alpha(t.green, dim),
        danger: CUSTOM_DANGER[t.base].danger,
        dangerDim: alpha(CUSTOM_DANGER[t.base].danger, dim),
        dangerSolid: CUSTOM_DANGER[t.base].dangerSolid,
    };
}
