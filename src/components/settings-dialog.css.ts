// src/components/settings-dialog.css.ts — 統一設定 dialog：置中、左側分類
// 欄＋右內容；窄視窗時分類欄轉為頂部橫向 chips。視覺語彙沿用 server
// manager 的 srvDialog 家族（hud-header.css.ts）。

import { style, styleVariants } from '@vanilla-extract/css';
import { vars } from '../theme.css';

const NARROW = 'screen and (max-width: 640px)';

export const backdrop = style({
    position: 'fixed',
    inset: 0,
    zIndex: 209,
    background: 'rgba(0, 0, 0, 0.45)',
});

export const dialog = style({
    position: 'fixed',
    top: '7vh',
    left: '50%',
    transform: 'translateX(-50%)',
    width: 'min(38rem, calc(100vw - 32px))',
    // fixed-ish height so switching categories doesn't bounce the layout
    height: 'min(30rem, 84vh)',
    display: 'flex',
    flexDirection: 'column',
    gap: vars.space.sm,
    padding: vars.space.md,
});

export const body = style({
    display: 'flex',
    gap: vars.space.md,
    flex: 1,
    minHeight: 0,
    '@media': {
        [NARROW]: { flexDirection: 'column', gap: vars.space.sm },
    },
});

export const nav = style({
    display: 'flex',
    height: 'auto',
    alignItems: 'stretch',
    justifyContent: 'flex-start',
    flexDirection: 'column',
    gap: '2px',
    width: '9.5rem',
    flexShrink: 0,
    borderRight: `1px solid ${vars.color.border}`,
    paddingRight: vars.space.sm,
    '@media': {
        [NARROW]: {
            flexDirection: 'row',
            width: '100%',
            borderRight: 'none',
            borderBottom: `1px solid ${vars.color.border}`,
            paddingRight: 0,
            paddingBottom: vars.space.sm,
            overflowX: 'auto',
        },
    },
});

const navItemBase = style({
    display: 'flex',
    alignItems: 'center',
    gap: '7px',
    fontFamily: vars.font.body,
    fontSize: '0.74rem',
    fontWeight: 500,
    textAlign: 'left',
    padding: '6px 9px',
    cursor: 'pointer',
    whiteSpace: 'nowrap',
    flexShrink: 0,
});

export const navItem = styleVariants({
    off: [navItemBase],
    on: [
        navItemBase,
        {
            fontWeight: 600,
        },
    ],
});

export const content = style({
    flex: 1,
    minWidth: 0,
    minHeight: 0,
    overflowY: 'auto',
    display: 'flex',
    flexDirection: 'column',
    gap: vars.space.sm,
    // Keep controls and their focus ring clear of the vertical scrollbar.
    paddingRight: vars.space.md,
});

// unsigned account row (issue #16): visible but never selectable
export const acctUnsigned = style({
    opacity: 0.55,
    cursor: 'not-allowed',
});

export const unsignedTag = style({
    maxWidth: '100%',
    overflowWrap: 'anywhere',
    fontSize: '0.6rem',
    color: vars.color.amber,
});

export const signLinks = style({
    display: 'flex',
    flexWrap: 'wrap',
    gap: '4px 12px',
    marginTop: '4px',
});

export const signLink = style({
    display: 'inline-flex',
    alignItems: 'center',
    gap: '3px',
    color: vars.color.accent,
    textDecoration: 'none',
    selectors: {
        '&:hover': { textDecoration: 'underline' },
    },
});

export const errorText = style({
    fontSize: '0.68rem',
    color: vars.color.danger,
    whiteSpace: 'pre-wrap',
});
