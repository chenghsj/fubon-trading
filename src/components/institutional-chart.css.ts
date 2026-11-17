import { style } from '@vanilla-extract/css';
import { vars } from '../theme.css';

export const root = style({ display: 'flex', flexDirection: 'column', gap: 14, minWidth: 0 });
export const toolbar = style({ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center', justifyContent: 'space-between' });
export const unit = style({ display: 'flex', alignItems: 'center', gap: 8, width: 'auto', whiteSpace: 'nowrap' });
export const metrics = style({ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 8, '@container': { '(max-width: 620px)': { gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' }, '(max-width: 300px)': { gridTemplateColumns: '1fr' } } });
export const metric = style({ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', justifyContent: 'flex-start', gap: 8, minWidth: 0, minHeight: 94, height: 'auto', padding: 10, whiteSpace: 'normal', textAlign: 'left' });
export const figure = style({ margin: 0, display: 'flex', flexDirection: 'column', gap: 10 });
export const scroll = style({ display: 'flex', overflowX: 'auto', minWidth: 0 });
export const axis = style({ position: 'sticky', left: 0, zIndex: 1, flexShrink: 0, width: 82, height: 255, marginRight: -82, background: vars.color.panel, fontFamily: vars.font.mono });
export const chart = style({ display: 'block', flexShrink: 0, width: '100%', height: 255, fontFamily: vars.font.mono });
export const date = style({ display: 'flex', alignItems: 'center', gap: 8, width: 'auto', whiteSpace: 'nowrap' });
export const readout = style({ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', fontVariantNumeric: 'tabular-nums' });
export const details = style({ borderTop: `1px solid ${vars.color.border}`, paddingTop: 10 });
export const empty = style({ padding: '24px 8px', textAlign: 'center', color: vars.color.mutedForeground });
