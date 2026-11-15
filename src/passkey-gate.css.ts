import { style, type StyleRule } from '@vanilla-extract/css';
import { vars } from './theme.css';

// Match other terminal panels: local geometry must outrank UI utility defaults.
const componentStyle = (rule: StyleRule) => style({ selectors: { '&&': rule } });

export const page = style({ display: 'flex', height: '100%', overflowY: 'auto', padding: 16 });
export const card = style({ width: '100%', maxWidth: 380, margin: 'auto' });
export const header = componentStyle({ padding: 16, gap: 10 });
export const brand = style({ margin: 0, fontSize: '.65rem', letterSpacing: '.08em', color: vars.color.mutedForeground });
export const heading = style({ display: 'flex', alignItems: 'center', gap: 8 });
export const icon = style({ width: 24, height: 24, flexShrink: 0, color: vars.color.accent });
export const title = style({ margin: 0, fontSize: '1rem', lineHeight: 1.4 });
export const description = componentStyle({ fontSize: '.75rem', lineHeight: 1.5 });
export const content = componentStyle({ display: 'flex', flexDirection: 'column', gap: 12, padding: '0 16px 12px' });
export const action = componentStyle({ width: '100%', minHeight: 32, '@media': { '(pointer: coarse)': { minHeight: 44 } } });
export const footer = componentStyle({ padding: '0 16px 16px' });
export const note = style({ margin: 0, fontSize: '.6875rem', lineHeight: 1.5, color: vars.color.mutedForeground });
