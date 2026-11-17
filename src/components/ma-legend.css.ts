import { style } from '@vanilla-extract/css';
import { vars } from '../theme.css';

export const row = style({
    display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, width: 'max-content', pointerEvents: 'auto',
    borderRadius: vars.radius.sm, background: `color-mix(in srgb, ${vars.color.panel} 72%, transparent)`,
    fontFamily: vars.font.mono, fontSize: '0.62rem', fontVariantNumeric: 'tabular-nums',
});
export const menuTrigger = style({ flexShrink: 0, fontFamily: 'inherit', fontSize: 'inherit', fontWeight: 600, color: vars.color.mutedForeground });
export const values = style({
    display: 'flex', alignItems: 'center', gap: 10, minWidth: 0, overflowX: 'auto', overflowY: 'hidden',
    scrollbarWidth: 'thin', overscrollBehaviorX: 'contain',
    ':focus-visible': { outline: `1px solid ${vars.color.accent}`, outlineOffset: -1 },
});
export const item = style({
    display: 'inline-flex', alignItems: 'center', flex: '0 0 auto', gap: 0, minHeight: 24,
    padding: '0 2px', border: 0, borderRadius: vars.radius.sm, background: 'transparent',
    fontFamily: 'inherit', fontSize: 'inherit', fontWeight: 500, whiteSpace: 'nowrap', cursor: 'pointer',
    selectors: { '&[data-dimmed="true"]': { opacity: 0.45 }, '&:hover': { background: vars.color.muted } },
    ':focus-visible': { outline: `1px solid ${vars.color.accent}`, outlineOffset: -1 },
    '@media': { '(pointer: coarse)': { minHeight: 44 } },
});
export const direction = style({
    marginLeft: 2, fontSize: '0.85em',
    selectors: {
        '&[data-direction="1"]': { color: vars.color.up },
        '&[data-direction="-1"]': { color: vars.color.down },
        '&[data-direction="0"]': { color: vars.color.mutedForeground },
    },
});
export const remove = style({ color: vars.color.danger });
