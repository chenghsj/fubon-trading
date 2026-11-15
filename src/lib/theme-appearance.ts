import { CUSTOM_BASES, CUSTOM_PRESETS, type CustomTheme } from './custom-theme';
import type { ThemeSettings } from './theme-store';

/** Resolve appearance without depending on the persisted store or React. */
export function baseMode(settings: Pick<ThemeSettings, 'mode'>): 'dark' | 'light' {
    if (settings.mode !== 'system') return settings.mode;
    return typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/** Missing light/dark variants fall back to that mode's built-in palette. */
export function activeCustom(settings: Pick<ThemeSettings, 'mode' | 'preset' | 'custom'>): CustomTheme | undefined {
    const base = baseMode(settings);
    if (settings.preset === 'custom') return settings.custom?.base === base ? settings.custom : undefined;
    return CUSTOM_PRESETS.find(p => p.name === settings.preset && p.theme.base === base)?.theme;
}

export function currentTheme(settings: ThemeSettings): CustomTheme {
    const theme = activeCustom(settings) ?? CUSTOM_BASES[baseMode(settings)];
    return settings.accent ? { ...theme, accent: settings.accent } : theme;
}
