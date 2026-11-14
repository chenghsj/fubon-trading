// Settings keep category navigation fixed while the selected panel scrolls.
import { style, type StyleRule } from '@vanilla-extract/css';
import { vars } from '../theme.css';

const NARROW = 'screen and (max-width: 640px)';
const STACKED_ROW = 'screen and (max-width: 720px)';

// Component utilities also use single-class selectors. Scope the layout here
// so their default dimensions cannot override this dialog's composition.
const componentLayout = (rule: StyleRule) => style({ selectors: { '&&': rule } });

export const dialog = style({
    position: 'fixed',
    top: '50%',
    left: '50%',
    transform: 'translate(-50%, -50%)',
    width: 'min(50rem, calc(100vw - 32px))',
    height: ['min(38rem, calc(100vh - 48px))', 'min(38rem, calc(100dvh - 48px))'],
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
    '@media': {
        [NARROW]: {
            width: 'calc(100vw - 24px)',
            height: ['calc(100vh - 32px)', 'calc(100dvh - 32px)'],
        },
    },
});

export const title = style({
    flexShrink: 0,
    padding: `${vars.space.md} ${vars.space.lg}`,
    borderBottom: `1px solid ${vars.color.border}`,
});

export const closeButton = componentLayout({
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '1.75rem',
    height: '1.75rem',
    padding: 0,
    flexShrink: 0,
});

export const body = style({
    display: 'flex',
    flex: 1,
    minHeight: 0,
    minWidth: 0,
    '@media': {
        [NARROW]: { flexDirection: 'column' },
    },
});

export const nav = componentLayout({
    display: 'flex',
    height: 'auto',
    alignItems: 'stretch',
    justifyContent: 'flex-start',
    flexDirection: 'column',
    gap: vars.space.xs,
    width: '8.5rem',
    flexShrink: 0,
    borderRadius: 0,
    borderRight: `1px solid ${vars.color.border}`,
    padding: vars.space.sm,
    overflowY: 'auto',
    '@media': {
        [NARROW]: {
            flexDirection: 'row',
            width: '100%',
            borderRight: 'none',
            borderBottom: `1px solid ${vars.color.border}`,
            overflowX: 'auto',
            overflowY: 'hidden',
        },
    },
});

export const navItem = componentLayout({
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'flex-start',
    gap: vars.space.sm,
    minHeight: '1.75rem',
    padding: `${vars.space.xs} ${vars.space.sm}`,
    flexShrink: 0,
});

export const content = componentLayout({
    flex: 1,
    minWidth: 0,
    minHeight: 0,
    overflowY: 'auto',
    overscrollBehavior: 'contain',
    display: 'flex',
    flexDirection: 'column',
    gap: vars.space.sm,
    marginTop: 0,
    // Keep controls and their focus ring clear of the vertical scrollbar.
    padding: `${vars.space.sm} ${vars.space.lg} ${vars.space.lg}`,
    scrollbarGutter: 'stable',
    '@media': { [NARROW]: { padding: vars.space.md } },
});

export const preferenceList = componentLayout({ gap: 0 });

export const preferenceRow = componentLayout({
    display: 'grid',
    gridTemplateColumns: '9rem minmax(0, 1fr)',
    alignItems: 'center',
    gap: vars.space.md,
    padding: `${vars.space.sm} 0`,
    '@media': {
        [STACKED_ROW]: { gridTemplateColumns: 'minmax(0, 1fr)', gap: vars.space.sm },
    },
});

export const preferenceLabel = style({
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
    minWidth: 0,
});

export const preferenceTitle = style({
    fontSize: '0.78rem',
    fontWeight: 500,
    lineHeight: 1.5,
});

export const preferenceCaption = style({
    fontSize: '0.65rem',
    fontWeight: 400,
    color: vars.color.mutedForeground,
    lineHeight: 1.4,
});

export const preferenceControl = style({
    display: 'flex',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: vars.space.sm,
    minWidth: 0,
});

export const optionGroup = componentLayout({
    display: 'flex',
    flexWrap: 'wrap',
    justifyContent: 'flex-start',
    gap: vars.space.xs,
    width: 'fit-content',
    maxWidth: '100%',
});

export const option = componentLayout({
    minWidth: '3rem',
    height: '1.5rem',
    minHeight: '1.5rem',
    whiteSpace: 'nowrap',
    padding: `0 ${vars.space.sm}`,
});

export const limitOptions = componentLayout({
    '@media': {
        [NARROW]: {
            display: 'grid',
            gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
            width: '100%',
        },
    },
});

export const pricePreview = style({
    flexWrap: 'wrap',
    justifyContent: 'flex-start',
    gap: `${vars.space.xs} ${vars.space.md}`,
});

export const customEditor = style({
    display: 'flex',
    flexDirection: 'column',
    gap: vars.space.sm,
    paddingBottom: vars.space.md,
});

export const headerSettings = componentLayout({
    gap: vars.space.sm,
    minWidth: 0,
    margin: 0,
    padding: `${vars.space.sm} 0 0`,
    border: 0,
});

export const headerLegend = componentLayout({
    display: 'flex',
    alignItems: 'baseline',
    gap: vars.space.sm,
    marginBottom: vars.space.sm,
    padding: 0,
});

export const headerItems = componentLayout({
    display: 'grid',
    gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
    gap: `${vars.space.xs} ${vars.space.lg}`,
    '@media': {
        'screen and (max-width: 480px)': { gridTemplateColumns: 'minmax(0, 1fr)' },
    },
});

export const headerItem = componentLayout({
    justifyContent: 'space-between',
    gap: vars.space.sm,
    minHeight: '1.75rem',
    minWidth: 0,
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
