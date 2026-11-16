import { globalStyle, style } from '@vanilla-extract/css';
import { vars } from '../theme.css';

// Outrank DialogContent's utility defaults so its rem-based width and padding
// cannot enlarge this compact terminal form when the user scales the UI.
export const dialog = style({
    selectors: {
        '&&': {
            width: 'calc(100vw - 32px)',
            maxWidth: 440,
            maxHeight: 'calc(100dvh - 32px)',
            overflowY: 'auto',
            overscrollBehavior: 'contain',
            padding: vars.space.md,
            gap: '0.75rem',
            fontSize: '0.75rem',
        },
    },
});
export const header = style({ selectors: { '&&': { gap: vars.space.xs, paddingRight: '2rem', textAlign: 'left' } } });
export const title = style({ selectors: { '&&': { fontSize: '1rem', lineHeight: 1.4 } } });
export const description = style({ selectors: { '&&': { fontSize: '0.75rem', lineHeight: 1.5 } } });
// The terminal intentionally omits Tailwind's preflight. Reset browser prose
// margins locally so form spacing comes from FieldGroup, like other panels.
globalStyle(`${dialog} p, ${dialog} h2`, { margin: 0 });
globalStyle(`${dialog} [data-slot="field-description"], ${dialog} [data-slot="field-label"]`, { fontSize: '0.75rem' });
globalStyle(`${dialog} [data-slot="field"]`, { gap: vars.space.sm });
export const permission = style({ minHeight: 44 });
export const actions = style({ display: 'flex', justifyContent: 'flex-end' });
export const action = style({ '@media': { '(pointer: coarse)': { minHeight: 44 } } });
