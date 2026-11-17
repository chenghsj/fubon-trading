import { style } from '@vanilla-extract/css';
import { vars } from '../theme.css';

export const list = style({ overflowY: 'auto', minHeight: 0, padding: `0 ${vars.space.lg} ${vars.space.md}` });
export const heading = style({ display: 'flex', alignItems: 'baseline', gap: vars.space.sm, fontSize: '0.74rem', fontWeight: 600,
    margin: '16px 0 4px', color: vars.color.mutedForeground });
export const rows = style({ position: 'relative', listStyle: 'none', margin: 0, padding: 0 });
export const row = style({ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, padding: '4px 0', borderBottom: `1px solid ${vars.color.border}`,
    position: 'relative', background: vars.color.panelRaised,
    selectors: { '&[data-indicator-dragging="true"]': { background: vars.color.muted, boxShadow: '0 8px 20px rgba(0, 0, 0, 0.2)', borderRadius: vars.radius.sm } },
    '@media': { '(max-width: 480px) and (pointer: coarse)': { display: 'grid', gridTemplateColumns: '44px 3px minmax(0, 1fr)', rowGap: 0 } } });
export const swatch = style({ width: 3, height: 24, flexShrink: 0, borderRadius: 2 });
export const name = style({ selectors: { '&&': { display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 1,
    flex: 1, minWidth: 0, minHeight: 38, height: 'auto', whiteSpace: 'normal', overflowWrap: 'anywhere', textAlign: 'left', padding: '4px 6px', fontSize: '0.8rem' } },
    '@media': { '(pointer: coarse)': { selectors: { '&&': { minHeight: 44 } } } } });
export const description = style({ fontSize: '0.66rem', color: vars.color.mutedForeground, fontWeight: 400 });
export const label = style({ display: 'flex', alignItems: 'center', gap: 6 });
export const actions = style({ display: 'flex', flexShrink: 0, gap: 2,
    '@media': { '(max-width: 480px) and (pointer: coarse)': { gridColumn: 3, justifySelf: 'end' } } });
export const action = style({ selectors: { '&&': { width: 30, height: 30, padding: 0 } },
    '@media': { '(pointer: coarse)': { selectors: { '&&': { width: 44, height: 44 } } } } });
export const grip = style({ cursor: 'grab', touchAction: 'none', userSelect: 'none', color: vars.color.mutedForeground,
    selectors: { '&&': { width: 28, height: 38, padding: 0, background: 'transparent' },
        '&&:hover': { background: 'transparent', color: vars.color.foreground },
        '&&:active': { background: 'transparent' },
        '&[aria-pressed="true"]': { cursor: 'grabbing' }, '&:disabled': { cursor: 'default' } },
    '@media': { '(pointer: coarse)': { selectors: { '&&': { width: 44, height: 44 } } },
        '(max-width: 480px) and (pointer: coarse)': { gridRow: '1 / span 2' } } });
export const remove = style({ color: vars.color.danger });
export const hint = style({ fontSize: '0.68rem', color: vars.color.mutedForeground, lineHeight: 1.6, margin: '16px 0 0' });
export const empty = style({ display: 'flex', flexDirection: 'column', gap: 12, alignItems: 'center', justifyContent: 'center', minHeight: 180, fontSize: '0.8rem' });
