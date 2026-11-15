import { globalStyle, style } from '@vanilla-extract/css';
import { vars } from '../theme.css';
import { controlRow, rowControlHeight } from './ui/control-row.css';

export const wrap = style({ height: '100%', minHeight: 0, overflow: 'auto', padding: 8, fontSize: '.72rem', color: vars.color.foreground, containerType: 'inline-size' });
export const heading = style({ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 6, marginBottom: 6 });
export const title = style({ margin: 0, fontSize: '.78rem', fontWeight: 650 });
export const muted = style({ color: vars.color.mutedForeground, lineHeight: 1.5, margin: '4px 0' });
export const notice = style({ padding: '5px 8px', border: `1px solid ${vars.color.borderBright}`, borderRadius: vars.radius.sm, background: vars.color.inset, lineHeight: 1.5, margin: '6px 0' });
export const grid = style({ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 145px), 1fr))', gap: 6, margin: '6px 0' });
export const field = style([controlRow, {
    display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0, fontSize: '.7rem',
    '@media': { '(pointer: coarse)': { vars: { [rowControlHeight]: 'max(44px, 1.5rem)' } } },
}]);
export const input = style({ width: '100%', minWidth: 0, borderRadius: vars.radius.sm, border: `1px solid ${vars.color.border}`, color: vars.color.foreground, background: vars.color.inset });
export const actions = style({ display: 'flex', flexWrap: 'wrap', gap: 6, margin: '8px 0' });
export const error = style({ color: vars.color.danger, lineHeight: 1.6 });
export const tableScroll = style({ overflowX: 'auto', margin: '10px 0' });
export const table = style({ width: '100%', borderCollapse: 'collapse', fontFamily: vars.font.mono, fontSize: '.7rem', whiteSpace: 'nowrap' });
globalStyle(`${table} th, ${table} td`, { padding: '5px 6px', textAlign: 'right', borderBottom: `1px solid ${vars.color.border}` });
globalStyle(`${table} th:first-child, ${table} td:first-child`, { textAlign: 'left' });
export const chart = style({ width: '100%', height: 150, background: vars.color.inset, border: `1px solid ${vars.color.border}`, borderRadius: vars.radius.sm });
export const baseLine = style({ fill: 'none', stroke: vars.color.mutedForeground, strokeWidth: 1.5 });
export const filterLine = style({ fill: 'none', stroke: vars.color.accent, strokeWidth: 2 });
export const subhead = style({ fontSize: '.74rem', margin: '10px 0 5px' });
export const records = style({ display: 'flex', flexDirection: 'column', gap: 4 });
export const recordButton = style({ whiteSpace: 'normal', height: 'auto', lineHeight: 1.5 });
globalStyle(`${wrap} input, ${wrap} textarea, ${wrap} button`, { '@media': { '(pointer: coarse)': { minHeight: 44 } } });
