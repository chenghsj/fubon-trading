import { style } from '@vanilla-extract/css';
import { vars } from '../theme.css';
import { resultCodeWeight, resultDetailSize, resultTextSize, searchResults, searchSurface } from './search-surface.css';

export const anchor = style({ position: 'relative', display: 'inline-flex', flexShrink: 0 });
export const icon = style({
    position: 'absolute', right: 7, top: '50%', transform: 'translateY(-50%)',
    color: vars.color.mutedForeground, pointerEvents: 'none',
});

export const popup = style({
    ...searchSurface,
    // Override the primitive's utilities regardless of CSS import order.
    selectors: { '&&': { width: '26rem', maxWidth: 'calc(100vw - 1rem)', padding: 0 } },
    maxHeight: 'var(--radix-popover-content-available-height)',
    overflowY: 'auto', overflowX: 'hidden', textTransform: 'none', letterSpacing: 0,
});
export const results = style({
    ...searchResults,
    maxHeight: '18rem', overflowY: 'auto', overscrollBehavior: 'contain',
});
export const result = style({
    minHeight: '2.4rem', padding: `${vars.space.xs} ${vars.space.md}`,
    vars: { [resultTextSize]: '0.76rem', [resultCodeWeight]: '700', [resultDetailSize]: '0.65rem' },
});
export const hint = style({
    padding: `${vars.space.sm} ${vars.space.md}`,
    fontSize: '0.68rem', fontWeight: 400, color: vars.color.mutedForeground,
});
