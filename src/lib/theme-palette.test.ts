import { describe, expect, it } from 'vitest';
import { CUSTOM_BASES, CUSTOM_PRESETS, customTokens, mix } from './custom-theme';
import { THEME_PALETTES, solidPriceColor } from './theme-palette';

function contrast(a: string, b: string): number {
    const luminance = (hex: string) => {
        const [r, g, blue] = [1, 3, 5].map(start => {
            const channel = parseInt(hex.slice(start, start + 2), 16) / 255;
            return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
        });
        return r! * 0.2126 + g! * 0.7152 + blue! * 0.0722;
    };
    const values = [luminance(a), luminance(b)].sort((x, y) => x - y);
    return (values[1]! + 0.05) / (values[0]! + 0.05);
}

function brighten(hex: string): string {
    return `#${[1, 3, 5].map(start =>
        Math.min(255, Math.round(parseInt(hex.slice(start, start + 2), 16) * 1.1))
            .toString(16).padStart(2, '0'),
    ).join('')}`;
}

describe('Absolutely palette contrast', () => {
    it('keeps text, price and status colors readable on every built-in surface', () => {
        for (const p of Object.values(THEME_PALETTES)) {
            for (const surface of [p.background, p.panel, p.panelRaised, p.inset, p.muted]) {
                for (const ink of [p.foreground, p.mutedForeground, p.accent, p.red, p.green, p.danger]) {
                    expect(contrast(ink, surface), `${ink} on ${surface}`).toBeGreaterThanOrEqual(4.5);
                }
            }
            expect(contrast(p.onAccent, p.accent)).toBeGreaterThanOrEqual(4.5);
            expect(contrast('#ffffff', p.dangerSolid)).toBeGreaterThanOrEqual(4.5);
            for (const color of [p.red, p.green]) {
                expect(contrast('#ffffff', solidPriceColor(color))).toBeGreaterThanOrEqual(4.5);
                const wick = mix(p.wickBase, color, parseFloat(p.wickShare) / 100);
                expect(contrast(wick, p.panel)).toBeGreaterThanOrEqual(3);
            }
        }
    });

    it('keeps price control text readable over tinted built-in surfaces', () => {
        for (const base of ['dark', 'light'] as const) {
            const p = THEME_PALETTES[base];
            for (const convention of ['tw', 'intl'] as const) {
                const tokens = customTokens(CUSTOM_BASES[base], convention);
                for (const direction of ['up', 'down']) {
                    const color = tokens[direction]!;
                    for (const surface of [p.panel, p.panelRaised, p.muted]) {
                        const tinted = mix(surface, color, base === 'dark' ? 0.13 : 0.1);
                        expect(contrast(tokens[`${direction}Control`]!, tinted)).toBeGreaterThanOrEqual(4.5);
                    }
                }
            }
        }
    });

    it('keeps solid accent control labels readable for custom bases, presets and arbitrary accents', () => {
        const themes = [...Object.values(CUSTOM_BASES), ...CUSTOM_PRESETS.map(p => p.theme)];
        for (const accent of ['#000000', '#ffffff', '#777777', '#ff0000', '#00ff00', '#0000ff']) {
            themes.push({ ...CUSTOM_BASES.dark, accent, red: accent, green: accent });
        }
        for (const theme of themes) {
            const tokens = customTokens(theme, 'tw');
            expect(contrast(tokens.onAccent!, theme.accent), theme.accent).toBeGreaterThanOrEqual(4.5);
            for (const key of ['upSolid', 'downSolid', 'successSolid']) {
                expect(contrast('#ffffff', tokens[key]!)).toBeGreaterThanOrEqual(5.5);
                expect(contrast('#ffffff', brighten(tokens[key]!))).toBeGreaterThanOrEqual(4.5);
            }
        }
    });
});
