// src/theme.css.ts — themeable design tokens.
// 2 modes (dark / light) × 2 price-color conventions
// (tw: red-up green-down, intl: green-up red-down) = 4 theme classes.

import {
    createTheme,
    globalKeyframes,
    globalStyle,
} from '@vanilla-extract/css';

import { mix } from './lib/custom-theme';
import { THEME_PALETTES, solidPriceColor, type Palette } from './lib/theme-palette';

const { dark, light } = THEME_PALETTES;

// tw: red = up (台股慣例); intl: green = up
function makeTokens(p: Palette, convention: 'tw' | 'intl') {
    const up = convention === 'tw' ? p.red : p.green;
    const upDim = convention === 'tw' ? p.redDim : p.greenDim;
    const upFlash = convention === 'tw' ? p.redFlash : p.greenFlash;
    const down = convention === 'tw' ? p.green : p.red;
    const downDim = convention === 'tw' ? p.greenDim : p.redDim;
    const downFlash = convention === 'tw' ? p.greenFlash : p.redFlash;
    return {
        color: {
            background: p.background,
            panel: p.panel,
            panelRaised: p.panelRaised,
            inset: p.inset,
            foreground: p.foreground,
            muted: p.muted,
            mutedForeground: p.mutedForeground,
            border: p.border,
            borderBright: p.borderBright,
            accent: p.accent,
            onAccent: p.onAccent,
            accentDim: p.accentDim,
            magenta: p.mutedForeground,
            amber: p.amber,
            up,
            upSolid: solidPriceColor(up),
            upDim,
            upFlash,
            down,
            downSolid: solidPriceColor(down),
            upControl: p === light ? (convention === 'tw' ? '#be123c' : '#047857') : mix(up, '#ffffff', 0.26),
            downControl: p === light ? (convention === 'tw' ? '#047857' : '#be123c') : mix(down, '#ffffff', 0.26),
            downDim,
            downFlash,
            wickUp: `color-mix(in srgb, ${up} ${p.wickShare}, ${p.wickBase})`,
            wickDown: `color-mix(in srgb, ${down} ${p.wickShare}, ${p.wickBase})`,
            flat: p.mutedForeground,
            // 狀態色（成功／錯誤／正式環境等）固定，不隨漲跌配色翻轉；
            // 錯誤用朱紅 danger，不沿用漲跌紅，避免台股配色下錯誤和「漲」同色。
            // 價格、買賣方向才用 up／down
            success: p.green,
            successSolid: solidPriceColor(p.green),
            successDim: p.greenDim,
            danger: p.danger,
            dangerDim: p.dangerDim,
            // 白字實心底專用（按鈕、徽章）；文字、邊框、點、淡底仍用 danger
            dangerSolid: p.dangerSolid,
        },
        space: {
            xs: '0.25rem',
            sm: '0.5rem',
            md: '1rem',
            lg: '1.5rem',
            xl: '2rem',
        },
        radius: {
            sm: '0.25rem',
            md: '0.375rem',
            lg: '0.5rem',
        },
        font: {
            display:
                "'Inter', system-ui, -apple-system, 'Segoe UI', sans-serif",
            mono: "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace",
            body: "'Inter', system-ui, -apple-system, 'Segoe UI', sans-serif",
        },
    };
}

export const [darkTwClass, vars] = createTheme(makeTokens(dark, 'tw'));

export const themeClasses: Record<string, string> = {
    'dark-tw': darkTwClass,
    'dark-intl': createTheme(vars, makeTokens(dark, 'intl')),
    'light-tw': createTheme(vars, makeTokens(light, 'tw')),
    'light-intl': createTheme(vars, makeTokens(light, 'intl')),
};

// price-update flash animations follow the active theme
globalKeyframes('flash-up', {
    '0%': { background: vars.color.upFlash },
    '100%': { background: 'transparent' },
});

globalKeyframes('flash-down', {
    '0%': { background: vars.color.downFlash },
    '100%': { background: 'transparent' },
});

globalStyle('html, body', {
    background: vars.color.background,
    color: vars.color.foreground,
});

globalStyle('body', {
    fontFamily: vars.font.body,
});

// native <option> popups don't inherit the themed select colors on
// Linux/Windows — without this, dark themes render white-on-white text
// in every dropdown (issue #1)
globalStyle('select option', {
    background: vars.color.panel,
    color: vars.color.foreground,
});

globalStyle('::-webkit-scrollbar', { width: '8px', height: '8px' });
globalStyle('::-webkit-scrollbar-track', { background: 'transparent' });
globalStyle('::-webkit-scrollbar-thumb', {
    background: vars.color.border,
    borderRadius: '4px',
});
globalStyle('::-webkit-scrollbar-thumb:hover', {
    background: vars.color.borderBright,
});

// shadcn semantic tokens reference the active terminal palette, including
// custom inline overrides. Portals inherit these aliases from <html>.
globalStyle(':root', {
    vars: {
        '--background': vars.color.background,
        '--foreground': vars.color.foreground,
        '--card': vars.color.panel,
        '--card-foreground': vars.color.foreground,
        '--popover': vars.color.panelRaised,
        '--popover-foreground': vars.color.foreground,
        '--primary': vars.color.accent,
        '--primary-soft': vars.color.accentDim,
        '--primary-foreground': vars.color.onAccent,
        '--secondary': vars.color.muted,
        '--secondary-foreground': vars.color.foreground,
        '--muted': vars.color.muted,
        '--muted-foreground': vars.color.mutedForeground,
        '--accent': vars.color.muted,
        '--accent-foreground': vars.color.foreground,
        '--destructive': vars.color.danger,
        '--destructive-solid': vars.color.dangerSolid,
        '--destructive-foreground': '#ffffff',
        '--border': vars.color.border,
        '--input': vars.color.borderBright,
        '--ring': vars.color.accent,
        '--radius': vars.radius.lg,
        '--trade-up': vars.color.upControl,
        '--trade-up-dim': vars.color.upDim,
        '--trade-up-solid': vars.color.upSolid,
        '--trade-down': vars.color.downControl,
        '--trade-down-dim': vars.color.downDim,
        '--trade-down-solid': vars.color.downSolid,
    },
});
