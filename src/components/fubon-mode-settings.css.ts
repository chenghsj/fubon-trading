import { globalStyle, style } from '@vanilla-extract/css';

export const dialog = style({ maxWidth: 460, width: 'calc(100vw - 32px)', maxHeight: '90dvh', overflowY: 'auto', padding: 20, gap: 16 });
// The terminal intentionally omits Tailwind's preflight. Reset browser prose
// margins locally so form spacing comes from FieldGroup, like other panels.
globalStyle(`${dialog} p, ${dialog} h2`, { margin: 0 });
export const permission = style({ minHeight: 44 });
export const actions = style({ display: 'flex', justifyContent: 'flex-end' });
export const action = style({ '@media': { '(pointer: coarse)': { minHeight: 44 } } });
