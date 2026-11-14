// Absolutely 的暖灰／暖白與陶土色，取自 Codex 內建色票。
// 次要文字、強調色及行情色依交易介面的文字對比需求調整。
// CSS、canvas 圖表與自訂主題的起始色共用此處，避免切換後色票不一致。
export interface Palette {
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
    onAccent: string;
    accentDim: string;
    amber: string;
    red: string;
    redDim: string;
    redFlash: string;
    green: string;
    greenDim: string;
    greenFlash: string;
    danger: string;
    dangerDim: string;
    dangerSolid: string;
    wickBase: string;
    wickShare: string;
}

export const THEME_PALETTES: Record<'dark' | 'light', Palette> = {
    dark: {
        background: '#2d2d2b',
        panel: '#373735',
        panelRaised: '#3d3d3a',
        inset: '#282826',
        foreground: '#f9f9f7',
        muted: '#42423f',
        mutedForeground: '#b2b2b0',
        border: '#50504d',
        borderBright: '#8c8c86',
        accent: '#e0a184',
        onAccent: '#2d2d2b',
        accentDim: 'rgba(224, 161, 132, 0.12)',
        amber: '#e0a43c',
        red: '#ff8b95',
        redDim: 'rgba(255, 139, 149, 0.13)',
        redFlash: 'rgba(255, 139, 149, 0.2)',
        green: '#40c9a2',
        greenDim: 'rgba(64, 201, 162, 0.13)',
        greenFlash: 'rgba(64, 201, 162, 0.18)',
        danger: '#ff927a',
        dangerDim: 'rgba(255, 146, 122, 0.13)',
        dangerSolid: '#d03a24',
        wickBase: '#b2b2b0',
        wickShare: '80%',
    },
    light: {
        background: '#f9f9f7',
        panel: '#f4f4f2',
        panelRaised: '#ffffff',
        inset: '#eeeee9',
        foreground: '#2d2d2b',
        muted: '#e8e8e3',
        mutedForeground: '#686864',
        border: '#d9d9d2',
        borderBright: '#b9b9b0',
        accent: '#9e5035',
        onAccent: '#ffffff',
        accentDim: 'rgba(158, 80, 53, 0.10)',
        amber: '#94630c',
        red: '#c91f36',
        redDim: 'rgba(201, 31, 54, 0.10)',
        redFlash: 'rgba(201, 31, 54, 0.16)',
        green: '#087654',
        greenDim: 'rgba(8, 118, 84, 0.10)',
        greenFlash: 'rgba(8, 118, 84, 0.14)',
        danger: '#c13219',
        dangerDim: 'rgba(193, 50, 25, 0.10)',
        dangerSolid: '#c5341a',
        wickBase: '#f4f4f2',
        wickShare: '80%',
    },
};

/** 實心狀態底維持白字 5.5:1，為既有 brightness(1.1) hover 留足 4.5:1 餘裕。 */
export function solidPriceColor(hex: string): string {
    const channels = [1, 3, 5].map(start => parseInt(hex.slice(start, start + 2), 16));
    for (let step = 0; step <= 100; step++) {
        const rgb = channels.map(channel => Math.round(channel * (1 - step / 100)));
        const linear = rgb.map(channel => {
            const value = channel / 255;
            return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
        });
        const luminance = linear[0]! * 0.2126 + linear[1]! * 0.7152 + linear[2]! * 0.0722;
        if (1.05 / (luminance + 0.05) >= 5.5) {
            return `#${rgb.map(channel => channel.toString(16).padStart(2, '0')).join('')}`;
        }
    }
    return '#000000';
}
