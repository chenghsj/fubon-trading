import { globalStyle, style } from '@vanilla-extract/css';
import { vars } from '../theme.css';

export const surface = style({
    position: 'relative',
    display: 'grid',
    gridTemplateColumns: '28px minmax(0, 1fr)',
    gridTemplateRows: '28px auto',
    alignItems: 'stretch',
    '@media': {
        '(max-width: 667px)': { gridTemplateColumns: '0 minmax(0, 1fr)', gridTemplateRows: '0 auto' },
        '(pointer: coarse) and (min-width: 668px)': { gridTemplateColumns: '44px minmax(0, 1fr)', gridTemplateRows: '44px auto' },
    },
});
const rail = style({
    position: 'relative',
    background: vars.color.panel,
    color: vars.color.mutedForeground,
    userSelect: 'none',
    '@media': { '(max-width: 667px)': { display: 'none' } },
});
export const horizontal = style([rail, { gridColumn: 2, gridRow: 1, position: 'sticky', top: 0, zIndex: 40, borderBottom: `1px solid ${vars.color.border}` }]);
export const verticalTrack = style({ gridColumn: 1, gridRow: 2, position: 'relative', overflow: 'hidden' });
export const vertical = style([rail, { position: 'absolute', inset: 0, borderRight: `1px solid ${vars.color.border}` }]);
export const corner = style([rail, { gridColumn: 1, gridRow: 1, position: 'sticky', top: 0, zIndex: 41,
    display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0, cursor: 'pointer',
    border: 0, borderRight: `1px solid ${vars.color.border}`, borderBottom: `1px solid ${vars.color.border}`,
    selectors: {
        '&:hover, &[data-state="open"]': { color: vars.color.accent, background: vars.color.accentDim },
        '&:focus-visible': { outline: `2px solid ${vars.color.accent}`, outlineOffset: -2 },
        '&:disabled': { cursor: 'default', opacity: 0.5 },
    },
}]);
export const precisionPanel = style({ padding: 12 });
export const precisionTitle = style({ fontSize: 13, fontWeight: 600, margin: '0 0 8px' });
export const precisionOptions = style({ gap: 4 });
export const precisionOption = style({
    display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
    width: '100%', minHeight: 44, padding: '6px 10px', border: 0, borderRadius: 6,
    background: 'transparent', color: vars.color.foreground, textAlign: 'left', cursor: 'pointer', fontSize: 12,
    selectors: {
        '&:hover': { background: vars.color.muted },
        '&[data-state="checked"]': { background: vars.color.accentDim },
        '&:focus-visible': { outline: `2px solid ${vars.color.accent}`, outlineOffset: -2 },
        '&:disabled': { cursor: 'default', opacity: 0.5 },
    },
});
export const precisionOptionCopy = style({ display: 'flex', flexDirection: 'column', gap: 2, lineHeight: '16px', fontWeight: 500 });
globalStyle(`${precisionOptionCopy} small`, { color: vars.color.mutedForeground, fontFamily: vars.font.mono, fontSize: 10, fontWeight: 400, lineHeight: '14px' });
export const precisionCheck = style({ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 18, flexShrink: 0, color: vars.color.accent });
export const precisionHint = style({ fontSize: 11, lineHeight: 1.6, color: vars.color.mutedForeground, margin: '10px 0 0' });
export const content = style({ gridColumn: 2, gridRow: 2, minWidth: 0, position: 'relative' });
export const tick = style({ position: 'absolute', pointerEvents: 'none', fontFamily: vars.font.mono, fontSize: 9, lineHeight: 1 });
globalStyle(`${horizontal} > ${tick}`, { bottom: 0, height: 4, borderLeft: `1px solid ${vars.color.border}` });
globalStyle(`${horizontal} > ${tick}[data-major="true"]`, { height: 8 });
globalStyle(`${horizontal} > ${tick} > span`, { position: 'absolute', bottom: 10, transform: 'translateX(-50%)' });
globalStyle(`${horizontal} > ${tick}[data-edge="start"] > span`, { transform: 'none' });
globalStyle(`${horizontal} > ${tick}[data-edge="end"] > span`, { transform: 'translateX(-100%)' });
globalStyle(`${vertical} > ${tick}`, { right: 0, width: 4, borderTop: `1px solid ${vars.color.border}` });
globalStyle(`${vertical} > ${tick}[data-major="true"]`, { width: 8 });
globalStyle(`${vertical} > ${tick} > span`, { position: 'absolute', right: 10, transform: 'translateY(-50%)' });
export const handle = style({
    position: 'absolute', display: 'flex', alignItems: 'center', justifyContent: 'center', touchAction: 'none',
    color: vars.color.mutedForeground, zIndex: 1, borderRadius: 3, outlineOffset: -2,
    selectors: {
        '&:hover, &[data-active="true"]': { background: vars.color.accentDim, color: vars.color.accent },
        '&:focus-visible': { outline: `2px solid ${vars.color.accent}` },
        '&[data-axis="x"]': { top: 0, bottom: 0, width: 24, transform: 'translateX(-50%)', cursor: 'ew-resize' },
        '&[data-axis="y"]': { left: 0, right: 0, height: 24, transform: 'translateY(-50%)', cursor: 'ns-resize' },
        '&[aria-disabled="true"]': { opacity: 0.4, cursor: 'default' },
    },
    '@media': { '(pointer: coarse)': { selectors: { '&[data-axis="x"]': { width: 44 }, '&[data-axis="y"]': { height: 44 } } } },
});
globalStyle(`${handle} > span`, { width: 8, height: 8, background: 'currentColor', border: `1px solid ${vars.color.panel}`, borderRadius: 2 });
globalStyle(`${handle}[data-grouped="true"] > span`, { width: 12 });
export const guide = style({ position: 'absolute', zIndex: 35, pointerEvents: 'none',
    selectors: {
        '&[data-axis="x"]': { top: 0, bottom: 0, borderLeft: `1px dashed ${vars.color.accent}` },
        '&[data-axis="y"]': { left: 0, right: 0, borderTop: `1px dashed ${vars.color.accent}` },
        '&[data-grouped="true"]': { background: vars.color.accentDim },
        '&[data-axis="x"][data-grouped="true"]': { borderRight: `1px dashed ${vars.color.accent}` },
        '&[data-axis="y"][data-grouped="true"]': { borderBottom: `1px dashed ${vars.color.accent}` },
    },
});
globalStyle(`${surface}[data-ruler-dragging] .react-grid-item`, { transition: 'none', pointerEvents: 'none' });
