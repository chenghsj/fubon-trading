// src/theme.css.ts — themeable design tokens.
// 2 modes (dark / light) × 2 price-color conventions
// (tw: red-up green-down, intl: green-up red-down) = 4 theme classes.

import {
    createTheme,
    globalKeyframes,
    globalStyle,
} from '@vanilla-extract/css';

interface Palette {
    background: string;
    panel: string;
    panelRaised: string;
    inset: string;
    foreground: string;
    muted: string;
    mutedForeground: string;
    border: string;
    borderBright: string;
    accent: string;
    accentDim: string;
    amber: string;
    red: string;
    redDim: string;
    redFlash: string;
    green: string;
    greenDim: string;
    greenFlash: string;
    // 狀態錯誤色（斷線、錯誤、破壞性動作）：朱紅，和漲跌紅分開，與 mobile 一致
    danger: string;
    dangerDim: string;
    // 白字實心底（按鈕、徽章）：深色朱紅太亮，白字不足 4.5:1，改用較深的朱紅
    dangerSolid: string;
    // 日內區間軌的引線（影線）：漲跌色往 wickBase 混到 wickShare，霧面淡色但對背景仍過 3:1
    wickBase: string;
    wickShare: string;
}

// Neutral shadcn chrome; market up/down and status colors remain semantic.
const dark: Palette = {
    background: '#0a0a0a',
    panel: '#0a0a0a',
    panelRaised: '#171717',
    inset: '#0a0a0a',
    foreground: '#fafafa',
    muted: '#262626',
    mutedForeground: '#a1a1a1',
    border: '#262626',
    borderBright: '#404040',
    accent: '#fafafa',
    accentDim: 'rgba(250, 250, 250, 0.1)',
    amber: '#e0a43c',
    red: '#f23645',
    redDim: 'rgba(242, 54, 69, 0.13)',
    redFlash: 'rgba(242, 54, 69, 0.2)',
    green: '#16b389',
    greenDim: 'rgba(22, 179, 137, 0.13)',
    greenFlash: 'rgba(22, 179, 137, 0.18)',
    // 對 panel 6.92:1；白字對 dangerSolid 4.87:1
    danger: '#ff6a4d',
    dangerDim: 'rgba(255, 106, 77, 0.13)',
    dangerSolid: '#d03a24',
    // 往灰色混：紅 #b85e6e 4.53:1、綠 #4a9d90 6.07:1（對 panel）
    wickBase: '#7e8798',
    wickShare: '50%',
};

const light: Palette = {
    background: '#ffffff',
    panel: '#ffffff',
    panelRaised: '#ffffff',
    inset: '#fafafa',
    foreground: '#0a0a0a',
    muted: '#f5f5f5',
    mutedForeground: '#737373',
    border: '#e5e5e5',
    borderBright: '#d4d4d4',
    accent: '#171717',
    accentDim: 'rgba(23, 23, 23, 0.05)',
    amber: '#b97f14',
    red: '#d6213a',
    redDim: 'rgba(214, 33, 58, 0.10)',
    redFlash: 'rgba(214, 33, 58, 0.16)',
    green: '#0a8a66',
    greenDim: 'rgba(10, 138, 102, 0.10)',
    greenFlash: 'rgba(10, 138, 102, 0.14)',
    // 對 panel 5.41:1、對 background 4.74:1；白字對 dangerSolid 5.41:1
    danger: '#c5341a',
    dangerDim: 'rgba(197, 52, 26, 0.10)',
    dangerSolid: '#c5341a',
    // 淺色的灰比實體深，往灰混會比實體還搶眼，改往白混：紅 #de4d61 3.93:1、綠 #3ba185 3.17:1
    wickBase: '#ffffff',
    wickShare: '80%',
};

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
            accentDim: p.accentDim,
            magenta: p.mutedForeground,
            amber: p.amber,
            up,
            upDim,
            upFlash,
            down,
            // Small colored control labels need stronger contrast on a light tint.
            upControl: p === light ? (convention === 'tw' ? '#be123c' : '#047857') : up,
            downControl: p === light ? (convention === 'tw' ? '#047857' : '#be123c') : down,
            downDim,
            downFlash,
            wickUp: `color-mix(in srgb, ${up} ${p.wickShare}, ${p.wickBase})`,
            wickDown: `color-mix(in srgb, ${down} ${p.wickShare}, ${p.wickBase})`,
            flat: p.mutedForeground,
            // 狀態色（成功／錯誤／正式環境等）固定，不隨漲跌配色翻轉；
            // 錯誤用朱紅 danger，不沿用漲跌紅，避免台股配色下錯誤和「漲」同色。
            // 價格、買賣方向才用 up／down
            success: p.green,
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
        '--primary-foreground': vars.color.background,
        '--secondary': vars.color.muted,
        '--secondary-foreground': vars.color.foreground,
        '--muted': vars.color.muted,
        '--muted-foreground': vars.color.mutedForeground,
        '--accent': vars.color.muted,
        '--accent-foreground': vars.color.foreground,
        '--destructive': vars.color.dangerSolid,
        '--destructive-foreground': '#ffffff',
        '--border': vars.color.border,
        '--input': vars.color.borderBright,
        '--ring': vars.color.accent,
        '--radius': vars.radius.lg,
        '--trade-up': vars.color.upControl,
        '--trade-up-dim': vars.color.upDim,
        '--trade-down': vars.color.downControl,
        '--trade-down-dim': vars.color.downDim,
    },
});
