import { globalStyle, style, type StyleRule } from '@vanilla-extract/css';
import { vars } from '../theme.css';

const componentStyle = ({ selectors, ...rule }: StyleRule) => style({ selectors: { '&&': rule, ...selectors } });
const NARROW = 'screen and (max-width: 480px)';

export const appearance = style({ display: 'flex', flexDirection: 'column', gap: '0.85rem', minWidth: 0, padding: '0.5rem 0 0.75rem' });
export const heading = style({ margin: 0, fontSize: '0.78rem', fontWeight: 500, lineHeight: 1.5 });
const row: StyleRule = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.75rem', minWidth: 0 };
export const modeRow = style({ ...row, padding: '0.55rem 0.75rem', border: `1px solid ${vars.color.border}`, borderRadius: 14,
    '@media': { [NARROW]: { flexWrap: 'wrap' } },
});
export const rowLabel = style({ fontSize: '0.76rem', fontWeight: 400, flexShrink: 0 });
export const modeOptions = componentStyle({ display: 'flex', gap: '0.65rem', flexShrink: 0, maxWidth: '100%',
    '@media': { [NARROW]: { gap: '0.5rem', marginLeft: 'auto' } },
});
export const modeOption = componentStyle({ width: '4.4rem', height: '3.35rem', minWidth: 0, padding: '0.25rem', overflow: 'hidden', border: '2px solid transparent', borderRadius: 10, background: 'transparent',
    selectors: {
        '&[data-state="on"]': { borderColor: vars.color.accent, background: 'transparent' },
        '&:hover': { background: vars.color.muted },
        '&:focus-visible': { outline: `2px solid ${vars.color.accent}`, outlineOffset: 2 },
    },
    '@media': { [NARROW]: { width: '3.8rem', height: '3rem' } },
});
export const modePreview = style({ position: 'relative', display: 'flex', width: '100%', height: '100%', overflow: 'hidden', borderRadius: 5 });
export const previewWindow = style({ position: 'relative', display: 'flex', width: '100%', height: '100%', flexShrink: 0, padding: 3, gap: 3, overflow: 'hidden', background: 'var(--preview-background)', color: 'var(--preview-foreground)', border: '1px solid color-mix(in srgb, var(--preview-foreground) 12%, transparent)', borderRadius: 5 });
globalStyle(`${modePreview}[data-mode="system"] > ${previewWindow}`, { width: '100%', flexBasis: '100%' });
globalStyle(`${modePreview}[data-mode="system"] > ${previewWindow}:last-child`, { position: 'absolute', inset: 0, clipPath: 'inset(0 0 0 50%)' });
export const previewSidebar = style({ width: '18%', flexShrink: 0, background: 'var(--preview-panel)', borderRadius: 2, paddingTop: 2 });
globalStyle(`${previewSidebar} svg`, { width: '0.4rem', height: '0.4rem', margin: 'auto', opacity: 0.55 });
export const previewContent = style({ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 3, paddingTop: 3, minWidth: 0 });
export const previewLine = style({ width: '82%', height: 2, flexShrink: 0, borderRadius: 1, background: 'var(--preview-accent)' });
globalStyle(`${previewLine}:nth-child(2)`, { width: '100%', background: 'var(--preview-foreground)', opacity: 0.18 });
globalStyle(`${previewLine}:nth-child(3)`, { width: '70%', background: 'var(--preview-foreground)', opacity: 0.18 });
globalStyle(`${previewLine}:nth-child(4)`, { width: '90%' });
export const previewComposer = style({ width: '100%', minHeight: 5, marginTop: 'auto', borderRadius: 5, border: '1px solid color-mix(in srgb, var(--preview-foreground) 14%, transparent)', display: 'flex', alignItems: 'center', justifyContent: 'flex-end', padding: 1 });
globalStyle(`${previewComposer} > span`, { width: 3, height: 3, borderRadius: '50%', background: 'var(--preview-accent)' });

export const themeCard = style({ padding: '0 0.85rem', border: `1px solid ${vars.color.border}`, borderRadius: 14, minWidth: 0 });
export const settingRow = style({ ...row, minHeight: '2.75rem', padding: '0.45rem 0',
    '@media': { [NARROW]: { flexWrap: 'wrap', gap: '0.35rem' } },
});
globalStyle(`${settingRow} + ${settingRow}`, { borderTop: `1px solid ${vars.color.border}` });
export const themeControls = style({ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '0.4rem', minWidth: 0, maxWidth: '100%',
    '@media': { [NARROW]: { marginLeft: 'auto' } },
});
export const iconButton = componentStyle({ width: '1.65rem', height: '1.65rem', color: vars.color.mutedForeground, borderRadius: 6 });
export const presetTrigger = componentStyle({ width: '10.5rem', maxWidth: '100%', minWidth: 0, justifyContent: 'space-between', borderRadius: 999, height: '1.75rem', padding: '0.15rem 0.55rem 0.15rem 0.25rem', boxShadow: 'none', fontSize: '0.72rem', fontWeight: 400, background: 'transparent',
    '@media': { [NARROW]: { width: '8.5rem' } },
});
export const presetOption = style({ display: 'inline-flex', alignItems: 'center', gap: '0.35rem', minWidth: 0 });
export const presetName = style({ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' });
export const typeChip = style({ display: 'flex', alignItems: 'center', justifyContent: 'center', width: '1.2rem', height: '1.2rem', borderRadius: '50%', border: `1px solid ${vars.color.border}`, color: vars.color.accent, fontSize: '0.65rem', flexShrink: 0 });
export const presetChip = style({ display: 'inline-flex', flexShrink: 0, borderRadius: 999, overflow: 'hidden', border: `1px solid ${vars.color.borderBright}` });
globalStyle(`${presetChip} > span`, { width: 8, height: 14 });
export const accentControls = style({ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '0.4rem', minWidth: 0, flexWrap: 'wrap',
    '@media': { [NARROW]: { marginLeft: 'auto' } },
});
export const accentSelect = componentStyle({ borderRadius: 999, fontSize: '0.7rem', minHeight: '1.75rem', paddingLeft: '0.55rem', boxShadow: 'none' });
export const accentPicker = style({ display: 'inline-flex', alignItems: 'center', gap: '0.35rem', minHeight: '1.75rem', padding: '0.15rem 0.5rem', border: `1px solid ${vars.color.border}`, borderRadius: 999, cursor: 'pointer',
    selectors: { '&:focus-within': { outline: `2px solid ${vars.color.accent}`, outlineOffset: 2 } },
});
export const colorInput = componentStyle({ width: '0.85rem', minWidth: '0.85rem', height: '0.85rem', minHeight: 0, padding: 0, border: 0, borderRadius: '50%', background: 'none', cursor: 'pointer', flexShrink: 0, boxShadow: 'none',
    selectors: { '&::-webkit-color-swatch-wrapper': { padding: 0 }, '&::-webkit-color-swatch': { border: 'none', borderRadius: '50%' }, '&::-moz-color-swatch': { border: 'none', borderRadius: '50%' } },
});
export const hex = style({ fontFamily: vars.font.mono, fontSize: '0.63rem', fontWeight: 400, color: vars.color.foreground });
export const fallbackHint = style({ margin: '0 0 0.5rem', fontSize: '0.65rem', lineHeight: 1.5, color: vars.color.mutedForeground });
export const advancedToggle = componentStyle({ width: '100%', justifyContent: 'flex-start', padding: '0.45rem 0', borderTop: `1px solid ${vars.color.border}`, borderRadius: 0, fontSize: '0.65rem', fontWeight: 400, color: vars.color.mutedForeground });
export const editor = style({ display: 'flex', flexDirection: 'column', gap: vars.space.sm, padding: '0.25rem 0 0.75rem' });
export const swatches = style({ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(11rem, 100%), 1fr))', gap: vars.space.xs });
export const swatch = style({ display: 'flex', alignItems: 'center', gap: vars.space.sm, padding: '0.4rem', border: `1px solid ${vars.color.border}`, borderRadius: vars.radius.sm, fontSize: '0.7rem', cursor: 'pointer',
    selectors: { '&:focus-within': { outline: `2px solid ${vars.color.accent}`, outlineOffset: 1 } },
});
globalStyle(`${swatch} > span:last-child`, { marginLeft: 'auto' });
export const preview = style({ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: vars.space.md, padding: '0.4rem 0', fontSize: '0.68rem' });
export const previewAccent = style({ marginLeft: 'auto', color: vars.color.accent });
export const reset = componentStyle({ alignSelf: 'flex-end', color: vars.color.mutedForeground, fontSize: '0.65rem' });
