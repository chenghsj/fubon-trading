import { globalStyle } from '@vanilla-extract/css';
import { vars } from '../../theme.css';

globalStyle('.select-trigger', {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6,
    width: '100%', minWidth: 0, minHeight: 24, padding: '3px 8px',
    border: `1px solid ${vars.color.border}`, borderRadius: vars.radius.sm,
    background: 'transparent', color: vars.color.foreground, fontSize: '.72rem', lineHeight: 1.45,
    textAlign: 'left', cursor: 'pointer',
});
globalStyle('.select-trigger > span:first-child', { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 });
globalStyle('.select-trigger:hover:not(:disabled)', { borderColor: vars.color.borderBright });
globalStyle('.select-trigger:focus-visible', { outline: `2px solid ${vars.color.accent}`, outlineOffset: 2 });
globalStyle('.select-trigger:disabled', { cursor: 'not-allowed', opacity: .5 });
globalStyle('.select-trigger[data-size="sm"]', { minHeight: '2rem', padding: '4px 12px' });
globalStyle('.select-trigger[data-size="default"]', { minHeight: '2.25rem', padding: '8px 12px', fontSize: '.875rem' });
globalStyle('.select-content', {
    zIndex: 2400, maxHeight: 'var(--radix-select-content-available-height)', minWidth: 'max(8rem, var(--radix-select-trigger-width))',
    maxWidth: 'var(--radix-select-content-available-width)', overflow: 'hidden',
    border: `1px solid ${vars.color.borderBright}`, borderRadius: vars.radius.sm,
    background: vars.color.panel, color: vars.color.foreground, boxShadow: '0 4px 16px rgb(0 0 0 / .18)',
    fontFamily: vars.font.body, fontSize: '.72rem', lineHeight: 1.45,
});
globalStyle('.select-viewport', { padding: 4 });
globalStyle('.select-item', {
    display: 'flex', alignItems: 'center', position: 'relative', minHeight: 24, padding: '3px 26px 3px 8px',
    borderRadius: vars.radius.sm, outline: 'none', cursor: 'default', userSelect: 'none', overflowWrap: 'anywhere',
});
globalStyle('.select-item[data-highlighted]', { background: vars.color.accentDim, color: vars.color.foreground });
globalStyle('.select-item[data-disabled]', { opacity: .45, pointerEvents: 'none' });
globalStyle('.select-check', { position: 'absolute', right: 6, display: 'flex', alignItems: 'center' });
globalStyle('.select-icon', { width: 12, height: 12, flexShrink: 0 });
globalStyle('.select-scroll', { display: 'flex', justifyContent: 'center', padding: 3 });
globalStyle('.select-label', { padding: '4px 8px', color: vars.color.mutedForeground, fontSize: '.68rem', fontWeight: 600 });
globalStyle('.select-separator', { height: 1, margin: '4px 0', background: vars.color.border });
globalStyle('.select-trigger[data-slot="select-trigger"][data-size], .select-item', { '@media': { '(pointer: coarse)': { minHeight: 44 } } });
