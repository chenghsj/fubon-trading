import { globalStyle, style } from '@vanilla-extract/css';
import { vars } from '../theme.css';
import { controlRow, rowControlHeight } from './ui/control-row.css';

export const wrap = style({ height: '100%', minHeight: 0, overflow: 'auto', padding: 8, fontSize: '.72rem', color: vars.color.foreground });
export const header = style({ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', justifyContent: 'space-between' });
export const title = style({ margin: 0, fontSize: '.78rem' });
export const status = style({ border: `1px solid ${vars.color.borderBright}`, borderRadius: vars.radius.sm, padding: '2px 6px', fontWeight: 650 });
export const warning = style({ color: vars.color.danger });
export const muted = style({ color: vars.color.mutedForeground, lineHeight: 1.5, margin: '4px 0' });
export const notice = style({ border: `1px solid ${vars.color.border}`, background: vars.color.inset, padding: '5px 8px', borderRadius: vars.radius.sm, lineHeight: 1.5, margin: '6px 0' });
export const fieldset = style({ margin: '8px 0', padding: 0, border: 0, minWidth: 0 });
export const grid = style({ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(min(100%,145px),1fr))', gap: 6, margin: '6px 0' });
export const field = style([controlRow, {
    display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0, fontSize: '.7rem',
    '@media': { '(pointer: coarse)': { vars: { [rowControlHeight]: 'max(44px, 1.5rem)' } } },
}]);
export const dateField = style({ maxWidth: '12rem' });
export const control = style({ width: '100%', minWidth: 0, border: `1px solid ${vars.color.border}`, borderRadius: vars.radius.sm, background: vars.color.inset, color: vars.color.foreground });
export const actions = style({ display: 'flex', flexWrap: 'wrap', gap: 6, margin: '8px 0' });
export const metrics = style({ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(min(100%,145px),1fr))', borderTop: `1px solid ${vars.color.border}`, borderBottom: `1px solid ${vars.color.border}`, margin: '8px 0' });
export const metric = style({ padding: '6px', minWidth: 0 });
export const number = style({ display: 'block', marginTop: 3, fontSize: '.84rem', fontFamily: vars.font.mono, overflowWrap: 'anywhere' });
export const heading = style({ fontSize: '.74rem', margin: '10px 0 5px' });
export const scroll = style({ overflowX: 'auto' });
export const table = style({ width: '100%', borderCollapse: 'collapse', whiteSpace: 'nowrap', fontFamily: vars.font.mono, fontSize: '.7rem' });
globalStyle(`${table} th,${table} td`, { padding: '5px 6px', textAlign: 'left', borderBottom: `1px solid ${vars.color.border}` });
export const log = style({ padding: 0, margin: '8px 0', listStyle: 'none' });
globalStyle(`${log} li`, { padding: '5px 0', borderBottom: `1px solid ${vars.color.border}`, lineHeight: 1.5, overflowWrap: 'anywhere' });
globalStyle(`${control}:focus-visible`, { outline: `2px solid ${vars.color.accent}`, outlineOffset: 2 });
globalStyle(`${wrap} input, ${wrap} textarea, ${wrap} button`, { '@media': { '(pointer: coarse)': { minHeight: 44 } } });
