// src/components/indicator-dialog.css.ts — TradingView-style indicator
// picker dialog + per-instance settings modal.

import { style, styleVariants } from '@vanilla-extract/css';
import { vars } from '../theme.css';

const NARROW = 'screen and (max-width: 600px)';

// These dialogs own their geometry instead of inheriting the terminal's w-full.
const dialogPosition = style({
    position: 'fixed',
    top: '50%',
    left: '50%',
    transform: 'translate(-50%, -50%)',
});

export const overlay = style({
    position: 'fixed',
    inset: 0,
    zIndex: 2000,
    background: 'rgba(0, 0, 0, 0.45)',
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'center',
    paddingTop: '10vh',
});

export const dialog = style([dialogPosition, {
    display: 'flex',
    flexDirection: 'column',
    width: 'min(42rem, calc(100vw - 32px))',
    maxHeight: ['min(34rem, calc(100vh - 32px))', 'min(34rem, calc(100dvh - 32px))'],
    background: vars.color.panelRaised,
    border: `1px solid ${vars.color.borderBright}`,
    borderRadius: vars.radius.lg,
    boxShadow: '0 24px 64px rgba(0, 0, 0, 0.5)',
    overflow: 'hidden',
}]);

export const header = style({
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    flexShrink: 0,
    padding: `${vars.space.md} ${vars.space.lg}`,
    fontFamily: vars.font.display,
    fontSize: '0.9rem',
    fontWeight: 600,
    color: vars.color.foreground,
});

export const closeBtn = style({
    display: 'inline-flex',
    alignItems: 'center',
    cursor: 'pointer',
    background: 'transparent',
    border: 'none',
    color: vars.color.mutedForeground,
    padding: '4px',
    borderRadius: vars.radius.sm,
    ':hover': { color: vars.color.foreground, background: vars.color.muted },
});

export const searchWrap = style({
    display: 'flex',
    alignItems: 'center',
    flexShrink: 0,
    gap: '8px',
    margin: `0 ${vars.space.lg} ${vars.space.md}`,
    padding: `0 ${vars.space.md}`,
    background: vars.color.inset,
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.md,
    color: vars.color.mutedForeground,
    ':focus-within': { borderColor: vars.color.accent },
});

export const searchInput = style({
    flex: 1,
    fontFamily: vars.font.body,
    fontSize: '0.82rem',
    color: vars.color.foreground,
    background: 'transparent',
    border: 'none',
    padding: '8px 0',
    outline: 'none',
    '::placeholder': { color: vars.color.mutedForeground },
});

export const body = style({
    display: 'flex',
    flex: 1,
    minHeight: 0,
    borderTop: `1px solid ${vars.color.border}`,
    '@media': {
        [NARROW]: { flexDirection: 'column' },
    },
});

export const sidebar = style({
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
    width: '11rem',
    flexShrink: 0,
    padding: vars.space.md,
    borderRight: `1px solid ${vars.color.border}`,
    overflowY: 'auto',
    '@media': {
        [NARROW]: {
            flexDirection: 'row',
            flexWrap: 'wrap',
            width: '100%',
            padding: vars.space.sm,
            borderRight: 'none',
            borderBottom: `1px solid ${vars.color.border}`,
        },
    },
});

export const sideTitle = style({
    fontFamily: vars.font.display,
    fontSize: '0.6rem',
    fontWeight: 600,
    letterSpacing: '0.08em',
    color: vars.color.mutedForeground,
    padding: '8px 8px 3px',
    userSelect: 'none',
    '@media': {
        [NARROW]: { display: 'none' },
    },
});

const sideItemBase = style({
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    fontFamily: vars.font.body,
    fontSize: '0.76rem',
    textAlign: 'left',
    cursor: 'pointer',
    background: 'transparent',
    border: 'none',
    borderRadius: vars.radius.sm,
    color: vars.color.foreground,
    padding: '6px 8px',
    ':hover': { background: vars.color.muted },
});

export const sideItem = styleVariants({
    normal: [sideItemBase],
    active: [
        sideItemBase,
        { background: vars.color.muted, fontWeight: 600 },
    ],
});

export const list = style({
    flex: 1,
    minWidth: 0,
    minHeight: 0,
    overflowY: 'auto',
    padding: `${vars.space.sm} 0`,
});

export const listHeader = style({
    fontFamily: vars.font.display,
    fontSize: '0.6rem',
    fontWeight: 600,
    letterSpacing: '0.08em',
    color: vars.color.mutedForeground,
    padding: `4px ${vars.space.lg}`,
    userSelect: 'none',
});

export const row = style({
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    width: '100%',
    textAlign: 'left',
    cursor: 'pointer',
    background: 'transparent',
    border: 'none',
    padding: `7px ${vars.space.lg}`,
    ':hover': { background: vars.color.muted },
});

export const maPresets = style({
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-start',
    gap: vars.space.sm,
    padding: `${vars.space.xs} ${vars.space.lg} ${vars.space.md}`,
});

export const maPresetOptions = style({
    display: 'flex',
    flexWrap: 'wrap',
    gap: vars.space.xs,
});

export const maPresetButton = style({
    selectors: {
        '&&': {
            minHeight: '1.75rem',
            padding: `${vars.space.xs} ${vars.space.sm}`,
            gap: vars.space.xs,
            fontSize: '0.7rem',
        },
    },
});

export const maPresetGroup = style({
    color: vars.color.accent,
    maxWidth: '100%',
    selectors: {
        '&&': {
            minHeight: '1.75rem',
            whiteSpace: 'normal',
            textAlign: 'left',
            justifyContent: 'flex-start',
            padding: `${vars.space.xs} ${vars.space.sm}`,
        },
    },
});

export const maPresetHint = style({
    fontFamily: vars.font.body,
    fontSize: '0.66rem',
    color: vars.color.mutedForeground,
});

export const maGroupRow = style({
    display: 'flex',
    alignItems: 'center',
    gap: vars.space.xs,
    width: '100%',
    minWidth: 0,
});

export const maGroupApply = style({
    selectors: { '&&': { flex: 1, minWidth: 0, justifyContent: 'flex-start', textAlign: 'left', whiteSpace: 'normal', overflowWrap: 'anywhere', padding: vars.space.sm } },
});

export const maGroupLine = style({
    display: 'grid',
    gridTemplateColumns: 'auto minmax(0, 1fr) 4rem 1.75rem',
    alignItems: 'center',
    gap: vars.space.sm,
});

export const maGroupError = style({ color: vars.color.danger, fontSize: '0.74rem' });

export const maHistoryNotice = style({
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: vars.space.sm,
    padding: vars.space.sm,
    fontFamily: vars.font.body,
    fontSize: '0.68rem',
    color: vars.color.mutedForeground,
    background: vars.color.inset,
});

export const rowSwatch = style({
    width: '10px',
    height: '10px',
    borderRadius: '3px',
    flexShrink: 0,
});

export const rowMain = style({
    flex: 1,
    minWidth: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: '1px',
});

export const rowName = style({
    fontFamily: vars.font.body,
    fontSize: '0.8rem',
    fontWeight: 500,
    color: vars.color.foreground,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
});

export const rowDesc = style({
    fontFamily: vars.font.body,
    fontSize: '0.66rem',
    color: vars.color.mutedForeground,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
});

export const customTag = style({
    display: 'inline-block',
    fontFamily: vars.font.display,
    fontSize: '0.56rem',
    fontWeight: 600,
    letterSpacing: '0.05em',
    color: vars.color.accent,
    background: vars.color.accentDim,
    borderRadius: '3px',
    padding: '1px 5px',
    marginLeft: '6px',
    verticalAlign: '1px',
});

export const newCustomBtn = style([
    sideItemBase,
    {
        marginTop: 'auto',
        '@media': {
            [NARROW]: { marginTop: 0 },
        },
        color: vars.color.accent,
        border: `1px dashed ${vars.color.border}`,
        ':hover': {
            background: vars.color.accentDim,
            borderColor: vars.color.accent,
        },
    },
]);

export const rowAdded = style({
    fontFamily: vars.font.mono,
    fontSize: '0.62rem',
    fontWeight: 600,
    color: vars.color.accent,
    flexShrink: 0,
});

export const starBtn = styleVariants({
    normal: [
        {
            display: 'inline-flex',
            alignItems: 'center',
            cursor: 'pointer',
            background: 'transparent',
            border: 'none',
            color: vars.color.mutedForeground,
            padding: '3px',
            borderRadius: vars.radius.sm,
            opacity: 0.35,
            flexShrink: 0,
            selectors: {
                [`${row}:hover &`]: { opacity: 1 },
            },
            ':hover': { color: vars.color.amber },
        },
    ],
    active: [
        {
            display: 'inline-flex',
            alignItems: 'center',
            cursor: 'pointer',
            background: 'transparent',
            border: 'none',
            color: vars.color.amber,
            padding: '3px',
            borderRadius: vars.radius.sm,
            flexShrink: 0,
        },
    ],
});

export const empty = style({
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    height: '8rem',
    fontFamily: vars.font.body,
    fontSize: '0.76rem',
    color: vars.color.mutedForeground,
});

export const footer = style({
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    flexWrap: 'wrap',
    flexShrink: 0,
    gap: `${vars.space.xs} ${vars.space.md}`,
    padding: `${vars.space.sm} ${vars.space.lg}`,
    borderTop: `1px solid ${vars.color.border}`,
    fontFamily: vars.font.body,
    fontSize: '0.66rem',
    color: vars.color.mutedForeground,
});

export const footerHint = style({
    flexBasis: '100%',
});

// ---- settings modal ----

export const settingsDialog = style([dialogPosition, {
    display: 'flex',
    flexDirection: 'column',
    width: 'min(27rem, 92vw)',
    maxHeight: 'min(34rem, 84vh)',
    background: vars.color.panelRaised,
    border: `1px solid ${vars.color.borderBright}`,
    borderRadius: vars.radius.lg,
    boxShadow: '0 24px 64px rgba(0, 0, 0, 0.5)',
    overflow: 'hidden',
}]);

export const tabs = style({
    display: 'flex',
    gap: '2px',
    padding: `0 ${vars.space.lg}`,
    borderBottom: `1px solid ${vars.color.border}`,
});

const tabBase = style({
    fontFamily: vars.font.body,
    fontSize: '0.74rem',
    fontWeight: 500,
    cursor: 'pointer',
    background: 'transparent',
    border: 'none',
    borderBottom: '2px solid transparent',
    color: vars.color.mutedForeground,
    padding: '7px 12px',
    ':hover': { color: vars.color.foreground },
});

export const tab = styleVariants({
    normal: [tabBase],
    active: [
        tabBase,
        {
            color: vars.color.foreground,
            fontWeight: 600,
            borderBottomColor: vars.color.accent,
        },
    ],
});

export const settingsBody = style({
    flex: 1,
    minHeight: 0,
    overflowY: 'auto',
    display: 'flex',
    flexDirection: 'column',
    gap: '10px',
    padding: vars.space.lg,
});

export const fieldRow = style({
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '10px',
    fontFamily: vars.font.body,
    fontSize: '0.74rem',
    color: vars.color.foreground,
});

export const fieldInput = style({
    width: '5rem',
    fontFamily: vars.font.mono,
    fontSize: '0.76rem',
    textAlign: 'right',
    color: vars.color.foreground,
    background: vars.color.inset,
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.sm,
    padding: '4px 8px',
    outline: 'none',
    ':focus': { borderColor: vars.color.accent },
});

export const styleSection = style({
    display: 'flex',
    flexDirection: 'column',
    gap: '6px',
    paddingBottom: '8px',
    borderBottom: `1px solid ${vars.color.border}`,
    selectors: { '&:last-child': { borderBottom: 'none' } },
});

export const styleHead = style({
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    fontFamily: vars.font.body,
    fontSize: '0.74rem',
    fontWeight: 600,
    color: vars.color.foreground,
});

export const styleRow = style({
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '10px',
});

export const styleRowBtns = style({
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
});

const previewBtnBase = style({
    display: 'inline-flex',
    alignItems: 'center',
    gap: '5px',
    cursor: 'pointer',
    background: vars.color.inset,
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.sm,
    padding: '4px 8px',
    ':hover': { borderColor: vars.color.borderBright },
});

export const previewBtn = styleVariants({
    normal: [previewBtnBase],
    active: [previewBtnBase, { borderColor: vars.color.accent }],
});

export const previewSwatch = style({
    width: '12px',
    height: '12px',
    borderRadius: '3px',
    border: '1px solid rgba(255,255,255,0.15)',
});

export const previewLine = style({
    width: '22px',
    borderRadius: '1px',
});

// band 預覽：淡填色＋上下緣線，和圖上的價格帶同一個樣子
export const previewBand = style({
    width: '22px',
    height: '10px',
    boxSizing: 'border-box',
});

const plotBtnBase = style({
    display: 'inline-flex',
    alignItems: 'center',
    gap: '3px',
    fontFamily: vars.font.body,
    fontSize: '0.68rem',
    cursor: 'pointer',
    background: vars.color.inset,
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.sm,
    color: vars.color.foreground,
    padding: '4px 8px',
    ':hover': { borderColor: vars.color.borderBright },
});

export const plotBtn = styleVariants({
    normal: [plotBtnBase],
    active: [plotBtnBase, { borderColor: vars.color.accent }],
});

export const plotMenu = style({
    display: 'flex',
    gap: '4px',
    flexWrap: 'wrap',
    padding: '6px',
    background: vars.color.inset,
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.md,
});

const plotItemBase = style({
    fontFamily: vars.font.body,
    fontSize: '0.7rem',
    cursor: 'pointer',
    background: 'transparent',
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.sm,
    color: vars.color.foreground,
    padding: '3px 10px',
    ':hover': { borderColor: vars.color.borderBright },
});

export const plotItem = styleVariants({
    normal: [plotItemBase],
    active: [
        plotItemBase,
        { borderColor: vars.color.accent, fontWeight: 600 },
    ],
});

// ---- TradingView-style color panel ----

export const colorPanel = style({
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
    padding: '8px',
    background: vars.color.inset,
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.md,
});

export const colorTools = style({
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
});

export const colorToolLabel = style({
    fontFamily: vars.font.body,
    fontSize: '0.66rem',
    color: vars.color.mutedForeground,
    width: '3.2rem',
    flexShrink: 0,
});

export const opacitySlider = style({
    flex: 1,
    accentColor: vars.color.accent,
    cursor: 'pointer',
});

export const opacityValue = style({
    fontFamily: vars.font.mono,
    fontSize: '0.68rem',
    color: vars.color.foreground,
    width: '2.6rem',
    textAlign: 'right',
});

export const sectionTitle = style({
    fontFamily: vars.font.display,
    fontSize: '0.6rem',
    fontWeight: 600,
    letterSpacing: '0.08em',
    color: vars.color.mutedForeground,
    paddingTop: '4px',
    userSelect: 'none',
});

export const fieldSelect = style({
    fontFamily: vars.font.mono,
    fontSize: '0.74rem',
    color: vars.color.foreground,
    background: vars.color.inset,
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.sm,
    padding: '3px 6px',
    outline: 'none',
    ':focus': { borderColor: vars.color.accent },
});

export const defaultsWrap = style({
    position: 'relative',
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
});

export const defaultsMenu = style({
    position: 'absolute',
    bottom: 'calc(100% + 6px)',
    left: 0,
    zIndex: 10,
    display: 'flex',
    flexDirection: 'column',
    gap: '1px',
    width: '10rem',
    background: vars.color.panelRaised,
    border: `1px solid ${vars.color.borderBright}`,
    borderRadius: vars.radius.md,
    boxShadow: '0 8px 24px rgba(0, 0, 0, 0.4)',
    padding: '4px',
});

export const defaultsItem = style({
    fontFamily: vars.font.body,
    fontSize: '0.72rem',
    textAlign: 'left',
    cursor: 'pointer',
    background: 'transparent',
    border: 'none',
    borderRadius: vars.radius.sm,
    color: vars.color.foreground,
    padding: '5px 8px',
    ':hover': { background: vars.color.muted },
});

export const savedTip = style({
    fontFamily: vars.font.body,
    fontSize: '0.64rem',
    color: vars.color.accent,
});

const widthBtnBase = style({
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '26px',
    height: '20px',
    cursor: 'pointer',
    background: 'transparent',
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.sm,
    padding: 0,
    ':hover': { borderColor: vars.color.borderBright },
});

export const widthBtn = styleVariants({
    normal: [widthBtnBase],
    active: [widthBtnBase, { borderColor: vars.color.accent }],
});

export const widthLine = style({
    width: '14px',
    borderRadius: '1px',
    background: vars.color.foreground,
});

export const settingsFooter = style({
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '8px',
    padding: `${vars.space.md} ${vars.space.lg}`,
    borderTop: `1px solid ${vars.color.border}`,
});

export const dangerBtn = style({
    fontFamily: vars.font.body,
    fontSize: '0.72rem',
    fontWeight: 500,
    cursor: 'pointer',
    background: 'transparent',
    border: 'none',
    color: vars.color.danger,
    padding: '5px 8px',
    borderRadius: vars.radius.sm,
    ':hover': { background: vars.color.muted },
});

export const footerActions = style({
    display: 'flex',
    gap: '8px',
});

const actionBase = style({
    fontFamily: vars.font.body,
    fontSize: '0.74rem',
    fontWeight: 600,
    cursor: 'pointer',
    borderRadius: vars.radius.sm,
    padding: '5px 16px',
});

export const cancelBtn = style([
    actionBase,
    {
        background: 'transparent',
        border: `1px solid ${vars.color.border}`,
        color: vars.color.foreground,
        ':hover': { borderColor: vars.color.borderBright },
    },
]);

export const okBtn = style([
    actionBase,
    {
        background: vars.color.accent,
        border: `1px solid ${vars.color.accent}`,
        color: vars.color.onAccent,
        ':hover': { opacity: 0.9 },
    },
]);

export const checkbox = style({
    accentColor: vars.color.accent,
    cursor: 'pointer',
});
