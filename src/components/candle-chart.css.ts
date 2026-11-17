// src/components/candle-chart.css.ts

import { style, styleVariants } from '@vanilla-extract/css';
import { vars } from '../theme.css';

export const wrap = style({
    display: 'flex',
    flexDirection: 'column',
    flex: 1,
    minHeight: 0,
});

// 窄面板放不下時換行（不把按鈕擠成直排字、右端按鈕不被裁掉）；不用
// overflow 捲動 — 那會把掛在按鈕下的彈出面板一起裁掉
export const toolbar = style({
    display: 'flex',
    flexWrap: 'wrap',
    gap: '2px',
    padding: `4px ${vars.space.sm}`,
    borderBottom: `1px solid ${vars.color.border}`,
    flexShrink: 0,
});

const tfBase = style({
    whiteSpace: 'nowrap',
    fontFamily: vars.font.mono,
    fontSize: '0.7rem',
    fontWeight: 500,
    padding: '2px 10px',
    cursor: 'pointer',
    background: 'transparent',
    border: '1px solid transparent',
    borderRadius: vars.radius.sm,
    color: vars.color.mutedForeground,
    transition: 'all 0.12s',
    ':hover': { color: vars.color.foreground },
});

export const tfBtn = styleVariants({
    normal: [tfBase],
    active: [
        tfBase,
        {
            color: vars.color.foreground,
            background: vars.color.muted,
        },
    ],
});

export const iconBtn = style([
    tfBase,
    {
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '2px 6px',
    },
]);

// 圖上顯示類開關（K 棒讀值）：開＝前景色，關＝淡灰
export const iconBtnToggle = styleVariants({
    on: [iconBtn, { color: vars.color.foreground }],
    off: [iconBtn, { opacity: 0.55 }],
});

// 委託線鎖定鈕（與 K 棒讀值等圖示開關同一組）：
// - locked：已鎖定＝按下狀態（前景色＋底色），aria-pressed=true
// - live：未鎖定且圖上有拖得動的委託線，強調色提醒「現在拖得動」
// - idle：未鎖定但圖上沒有可拖的線，與其他關閉的開關同樣淡灰
const orderLockBase = style([
    iconBtn,
    {
        ':focus-visible': { outline: `2px solid ${vars.color.accent}`, outlineOffset: 1 },
        '@media': { '(prefers-reduced-motion: reduce)': { transition: 'none' } },
    },
]);

export const orderLockBtn = styleVariants({
    locked: [orderLockBase, { color: vars.color.foreground, background: vars.color.muted }],
    live: [orderLockBase, { color: vars.color.accent, ':hover': { color: vars.color.accent, background: vars.color.accentDim } }],
    idle: [orderLockBase, { opacity: 0.55 }],
});

export const toolbarDivider = style({
    width: '1px',
    alignSelf: 'stretch',
    margin: '2px 4px',
    background: vars.color.border,
});

const modeBase = style({
    whiteSpace: 'nowrap',
    fontFamily: vars.font.body,
    fontSize: '0.66rem',
    fontWeight: 500,
    padding: '2px 8px',
    cursor: 'pointer',
    background: 'transparent',
    border: '1px solid transparent',
    borderRadius: vars.radius.sm,
    color: vars.color.mutedForeground,
    transition: 'all 0.12s',
    ':hover': { color: vars.color.foreground },
});

export const modeBtn = styleVariants({
    normal: [modeBase],
    active: [
        modeBase,
        { color: vars.color.foreground, background: vars.color.muted },
    ],
    armed: [
        modeBase,
        {
            color: '#1a1304',
            background: vars.color.amber,
            borderColor: vars.color.amber,
            fontWeight: 600,
        },
    ],
});

// 圖表操作共用一個靠右位置，換行時指標與更新不分開。
export const chartTools = style({
    display: 'inline-flex',
    alignItems: 'center',
    flexShrink: 0,
    gap: 4,
    marginLeft: 'auto',
});

export const indicatorBtn = styleVariants({
    normal: [modeBase],
    active: [
        modeBase,
        {
            color: vars.color.foreground,
            background: vars.color.muted,
        },
    ],
});


// 交易／畫圖模式提示：放在左上角圖例欄（triggerList）的流裡、K 棒讀值之後，
// 委託／觸價／指標列跟著往下排 — 任何寬度都不會蓋住委託的 CANCEL。
// 外層 hintSlot 寬度為 0，提示本身不撐寬其他列；最大寬度由 inline style 依圖寬限制，
// 超過就換行（只會把下面的列往下推）
export const hintSlot = style({
    alignSelf: 'flex-start',
    width: 0,
    overflow: 'visible',
    pointerEvents: 'none',
});

export const modeHint = style({
    width: 'max-content',
    fontFamily: vars.font.body,
    fontSize: '0.66rem',
    fontWeight: 600,
    color: '#1a1304',
    background: vars.color.amber,
    borderRadius: vars.radius.sm,
    padding: '2px 10px',
    pointerEvents: 'none',
});

// 提示列的第二行（鎖定說明）：獨立一行
export const modeHintNote = style({
    display: 'block',
});

// 畫圖模式的提示：與交易模式同一個位置，但用中性的面板色，不搶琥珀
// 那組「武裝中、下一下會下單」的警示語彙
export const drawHint = style([
    modeHint,
    {
        color: vars.color.foreground,
        background: 'color-mix(in srgb, ' + vars.color.panelRaised + ' 92%, transparent)',
        border: `1px solid ${vars.color.border}`,
        fontWeight: 500,
    },
]);

export const triggerList = style({
    position: 'absolute',
    top: '8px',
    left: '8px',
    zIndex: 5,
    // 容器本身不吃滑鼠（K 棒讀值列底下的圖表要收得到移動／點擊／觸控）；
    // 有按鈕的列（委託、觸價、指標圖例）各自恢復
    pointerEvents: 'none',
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
    fontFamily: vars.font.mono,
    fontSize: '0.64rem',
    fontVariantNumeric: 'tabular-nums',
});

export const triggerRow = style({
    pointerEvents: 'auto',
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
    padding: '1px 6px',
    background: vars.color.panelRaised,
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.sm,
    color: vars.color.foreground,
});

export const orderCancel = style({
    fontFamily: vars.font.display,
    fontSize: '0.58rem',
    fontWeight: 600,
    letterSpacing: '0.04em',
    cursor: 'pointer',
    background: 'transparent',
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.sm,
    color: vars.color.danger,
    padding: '0 6px',
    ':hover': {
        borderColor: vars.color.danger,
        background: vars.color.muted,
    },
});

export const triggerRemove = style({
    fontFamily: vars.font.mono,
    fontSize: '0.62rem',
    lineHeight: 1,
    cursor: 'pointer',
    background: 'transparent',
    border: 'none',
    color: vars.color.mutedForeground,
    padding: '1px 2px',
    ':hover': { color: vars.color.danger },
});

// 左側畫圖工具列與圖表本體並排。工具列佔位而不是浮在圖上 — 浮動會蓋住
// 最左邊那幾根 K 棒，往左拖載入更舊歷史時特別礙事。
export const chartRow = style({
    display: 'flex',
    flex: 1,
    minHeight: 0,
    minWidth: 0,
});

export const chartHost = style({
    flex: 1,
    minHeight: 0,
    minWidth: 0,
    position: 'relative',
    // 點圖表時取得鍵盤焦點（畫圖的 Delete 只在焦點在圖上時作用），
    // 不畫焦點框
    outline: 'none',
});

export const chartColumn = style({ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0, minHeight: 0 });
export const chartReadouts = style({
    display: 'flex', flexDirection: 'column', gap: 1, flexShrink: 0, minWidth: 0,
    padding: '2px 6px', background: vars.color.panelRaised,
    borderBottom: `1px solid ${vars.color.border}`,
});

// ---- indicator legend（TradingView 式，圖上左上角，一列一個實例）----

const legendItemBase = style({
    position: 'relative', // anchors the ⋯ context menu
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    padding: '1px 4px 1px 6px',
    background: 'transparent',
    borderRadius: vars.radius.sm,
    fontFamily: vars.font.mono,
    fontSize: '0.62rem',
    fontVariantNumeric: 'tabular-nums',
    width: '100%',
    maxWidth: '100%',
    minWidth: 0,
    pointerEvents: 'auto',
});

export const legendItem = styleVariants({
    normal: [legendItemBase],
    hidden: [legendItemBase],
});

export const legendLabel = style({
    fontFamily: vars.font.mono,
    fontSize: '0.62rem',
    fontWeight: 600,
    cursor: 'pointer',
    background: 'transparent',
    border: 'none',
    padding: 0,
    flexShrink: 1,
    minWidth: 0,
    maxWidth: '45%',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    ':hover': { textDecoration: 'underline' },
});

export const legendVals = style({
    display: 'inline-flex',
    flex: '1 1 auto',
    gap: '6px',
    minWidth: 0,
    overflowX: 'auto',
    whiteSpace: 'nowrap',
    scrollbarWidth: 'thin',
    ':focus-visible': { outline: `1px solid ${vars.color.accent}`, outlineOffset: -1 },
});

export const legendVal = style({
    fontWeight: 500,
});

export const legendCtrls = style({
    display: 'inline-flex',
    gap: '1px',
    flexShrink: 0,
    marginLeft: 'auto',
});

export const legendCtrlBtn = style({
    display: 'inline-flex',
    alignItems: 'center',
    cursor: 'pointer',
    background: 'transparent',
    border: 'none',
    color: vars.color.mutedForeground,
    padding: '1px 2px',
    borderRadius: vars.radius.sm,
    ':hover': { color: vars.color.foreground, background: vars.color.muted },
    selectors: { '&&': { width: 24, height: 24, padding: 0 } },
    '@media': { '(pointer: coarse)': { selectors: { '&&': { width: 44, height: 44 } } } },
});

export const legendRemove = style({ color: vars.color.danger });

// Each pane has an opaque header, with a matching inset in its price scale.
export const paneLegend = style({
    position: 'absolute',
    left: 0,
    right: 0,
    display: 'flex',
    alignItems: 'center',
    padding: '0 6px',
    background: vars.color.panelRaised,
    borderBottom: `1px solid ${vars.color.border}`,
    zIndex: 5,
    fontFamily: vars.font.mono,
    fontSize: '0.64rem',
    fontVariantNumeric: 'tabular-nums',
    selectors: { '&[data-collapsed="true"]': { overflow: 'hidden' } },
});

export const legendNote = style({
    fontFamily: vars.font.body,
    fontSize: '0.58rem',
    color: vars.color.mutedForeground,
});

export const emptyMsg = style({
    position: 'absolute',
    inset: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: vars.color.mutedForeground,
    fontFamily: vars.font.display,
    fontSize: '0.78rem',
});

// ---- K 棒讀值列（開高低收，issue #240）— 左上角堆疊第一列 ----
// 整列不吃滑鼠：游標經過讀值列時圖表照樣收到移動／點擊（畫圖、點價不受影響）
export const ohlcRow = style({
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'baseline',
    columnGap: '8px',
    rowGap: '1px',
    padding: '1px 6px',
    // 資訊列獨立於 canvas，最大寬度依容器扣除左右留白。
    width: 'fit-content',
    background: 'transparent',
    borderRadius: vars.radius.sm,
    fontFamily: vars.font.mono,
    fontSize: '0.64rem',
    fontVariantNumeric: 'tabular-nums',
    color: vars.color.foreground,
    whiteSpace: 'nowrap',
    pointerEvents: 'none',
    userSelect: 'none',
});

export const ohlcItem = style({
    display: 'inline-flex',
    alignItems: 'baseline',
    gap: '3px',
    fontWeight: 500,
});

export const ohlcLabel = style({
    fontFamily: vars.font.body,
    fontSize: '0.6rem',
    color: vars.color.mutedForeground,
});
