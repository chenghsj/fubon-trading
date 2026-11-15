import { style } from '@vanilla-extract/css';
import { vars } from '../theme.css';

export const trigger = style({
    selectors: { '&&': { width: '100%', minHeight: '1.75rem', gap: vars.space.sm, padding: `0 ${vars.space.sm}`, background: vars.color.panelRaised } },
});
export const line = style({ flex: 1, height: '3px', minWidth: '1rem', borderRadius: '2px' });
export const popover = style({
    selectors: { '&&': { width: 'min(18rem, calc(100vw - 24px))', padding: vars.space.md, maxHeight: 'min(calc(100dvh - 24px), var(--radix-popover-content-available-height, 100dvh))', overflowY: 'auto' } },
});
export const palette = style({ display: 'flex', flexDirection: 'column', gap: vars.space.sm, width: '100%', maxWidth: '18rem' });
export const caption = style({ fontFamily: vars.font.body, fontSize: '0.68rem', fontWeight: 500, color: vars.color.mutedForeground });
export const quickColors = style({ display: 'grid', gridTemplateColumns: 'repeat(6, minmax(0, 1fr))', gap: vars.space.sm });
export const grid = style({ display: 'grid', gridTemplateColumns: 'repeat(10, minmax(0, 1fr))', gap: vars.space.xs });
export const swatch = style({
    selectors: {
        '&&': { position: 'relative', width: '100%', height: 'auto', aspectRatio: '1', minHeight: 0, border: '1px solid rgba(127,127,127,0.24)', borderRadius: '3px', padding: 0 },
        '&[aria-pressed="true"], &[aria-checked="true"]': { outline: `2px solid ${vars.color.foreground}`, outlineOffset: '1px' },
    },
    ':hover': { boxShadow: `0 0 0 1px ${vars.color.foreground}` },
});
export const selectedMark = style({
    position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)',
    display: 'flex', alignItems: 'center', justifyContent: 'center', width: '13px', height: '13px',
    borderRadius: '50%', color: vars.color.background, background: vars.color.foreground,
});
export const hexRow = style({ display: 'flex', alignItems: 'center', gap: vars.space.sm, minWidth: 0 });
export const hexPreview = style({ width: '1.5rem', height: '1.5rem', flexShrink: 0, borderRadius: '3px', border: `1px solid ${vars.color.border}` });
export const hexInput = style({ selectors: { '&&': { flex: 1, minWidth: 0, width: 0, fontFamily: vars.font.mono, fontSize: '0.72rem' } } });
