import { style } from '@vanilla-extract/css';
import { vars } from '../theme.css';

export const banner = style({
    display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '6px 16px',
    flexShrink: 0, padding: '7px 12px', fontSize: 12,
    background: vars.color.background, color: vars.color.foreground,
    borderBottom: `1px solid ${vars.color.border}`,
});

export const warning = style([banner, { color: '#f59e0b' }]);

export const link = style({ marginLeft: 'auto', color: 'inherit', textDecoration: 'underline' });
