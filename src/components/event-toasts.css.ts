// Sonner owns the surface, icon slot and stacking animation. These rules only
// set the terminal's density and keep long notification text readable.
import { style, styleVariants } from '@vanilla-extract/css';
import { vars } from '../theme.css';

export const toast = style({
    selectors: {
        '&[data-sonner-toast][data-styled=true]': {
            alignItems: 'flex-start',
            gap: '10px',
            padding: '12px 14px',
            fontFamily: vars.font.body,
            fontSize: 'calc(0.75rem * var(--event-toast-scale, 1))',
        },
    },
});

export const icon = styleVariants({
    deal: { color: vars.color.amber },
    ok: { color: vars.color.success },
    err: { color: vars.color.danger },
    info: { color: vars.color.mutedForeground },
});

export const content = style({
    minWidth: 0,
    flex: 1,
    paddingRight: '24px',
    overflowWrap: 'anywhere',
});

export const closeButton = style({
    selectors: {
        '[data-sonner-toast] &&[data-close-button]': {
            top: '8px',
            right: '8px',
            left: 'auto',
            transform: 'none',
            width: '24px',
            height: '24px',
            padding: 0,
            border: 'none',
            background: 'transparent',
        },
    },
});

export const title = style({
    fontWeight: 600,
    lineHeight: 1.4,
});

export const description = style({
    fontSize: '0.92em',
    lineHeight: 1.5,
});

const lineBase = style({
    whiteSpace: 'normal',
    overflowWrap: 'anywhere',
    fontVariantNumeric: 'tabular-nums',
});

export const line = styleVariants({
    plain: [lineBase],
    up: [lineBase, { color: vars.color.up }],
    down: [lineBase, { color: vars.color.down }],
});
