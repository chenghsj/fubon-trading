import { style, type StyleRule } from '@vanilla-extract/css';
import { vars } from './theme.css';

// Match other terminal panels: local geometry must outrank UI utility defaults.
const componentStyle = (rule: StyleRule) => style({ selectors: { '&&': rule } });

export const page = style({ display: 'flex', height: '100%', overflowY: 'auto', padding: 16 });
export const card = style({ width: '100%', maxWidth: 460, margin: 'auto' });
export const header = componentStyle({ padding: 22, gap: 12 });
export const brand = style({ margin: 0, fontSize: '.6875rem', letterSpacing: '.08em', color: vars.color.mutedForeground });
export const heading = style({ display: 'flex', alignItems: 'center', gap: 8 });
export const icon = style({ width: 28, height: 28, flexShrink: 0, color: vars.color.accent });
export const title = style({ margin: 0, fontSize: '1.125rem', lineHeight: 1.4 });
export const description = componentStyle({ fontSize: '.8125rem', lineHeight: 1.5 });
export const content = componentStyle({ display: 'flex', flexDirection: 'column', gap: 14, padding: '0 22px 16px' });
export const action = componentStyle({ width: '100%', minHeight: 36, '@media': { '(pointer: coarse)': { minHeight: 44 } } });
export const footer = componentStyle({ padding: '0 22px 22px' });
export const note = style({ margin: 0, fontSize: '.75rem', lineHeight: 1.5, color: vars.color.mutedForeground });
