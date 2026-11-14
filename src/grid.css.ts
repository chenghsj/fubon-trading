// src/grid.css.ts — react-grid-layout integration styles

import { globalStyle, style } from '@vanilla-extract/css';
import { vars } from './theme.css';

// Match shadcn Card's rounded-xl, including the wrapper that casts the lift shadow.
const panelRadius = '0.75rem';

export const gridWrap = style({
    flex: 1,
    minHeight: 0,
    overflowY: 'auto',
    overflowX: 'hidden',
});

// each grid item hosts exactly one panel; make it fill the cell
export const cell = style({
    display: 'flex',
    flexDirection: 'column',
    minHeight: 0,
    borderRadius: panelRadius,
});

globalStyle(`${cell} > *`, {
    flex: 1,
    minHeight: 0,
});

globalStyle('.drag-handle', {
    cursor: 'grab',
});

// The narrow display is static: nothing to grab.
globalStyle('.react-grid-item.static .drag-handle', {
    cursor: 'default',
});

globalStyle('.react-grid-item.react-draggable-dragging .drag-handle', {
    cursor: 'grabbing',
});

// drop-target ghost
globalStyle(`${gridWrap} .react-grid-item.react-grid-placeholder`, {
    background: vars.color.accentDim,
    border: `1px dashed ${vars.color.accent}`,
    borderRadius: panelRadius,
    opacity: 1,
});

// while dragging / resizing, lift the panel
globalStyle(`${gridWrap} .react-grid-item.react-draggable-dragging, ${gridWrap} .react-grid-item.resizing`, {
    zIndex: 30,
    opacity: 0.92,
    boxShadow: '0 12px 32px rgba(0, 0, 0, 0.55)',
});

// Show resize affordances when the panel is hovered.
globalStyle('.react-grid-item > .react-resizable-handle', {
    opacity: 0,
    transition: 'opacity 0.15s',
});

globalStyle('.react-grid-item:hover > .react-resizable-handle', {
    opacity: 0.7,
});

globalStyle('.react-grid-item > .react-resizable-handle::after', {
    borderRight: `2px solid ${vars.color.mutedForeground}`,
    borderBottom: `2px solid ${vars.color.mutedForeground}`,
});

// A small concentric arc inside the Card's 0.75rem corner; keep the 20px hit area.
globalStyle('.react-grid-item > .react-resizable-handle-se::after', {
    width: '0.5rem',
    height: '0.5rem',
    right: '0.375rem',
    bottom: '0.375rem',
    borderBottomRightRadius: '0.375rem',
    borderRightWidth: '1.5px',
    borderBottomWidth: '1.5px',
});

// Use the panel gap and border for edge targets, keeping scrollbars and corners clear.
const rightHandle = `${gridWrap} .react-grid-item > .react-resizable-handle-e`;
const bottomHandle = `${gridWrap} .react-grid-item > .react-resizable-handle-s`;

globalStyle(rightHandle, {
    top: '20px',
    right: '-5px',
    bottom: '20px',
    width: '6px',
    height: 'auto',
    marginTop: 0,
    transform: 'none',
    cursor: 'ew-resize',
    zIndex: 1,
});

globalStyle(bottomHandle, {
    left: '20px',
    right: '20px',
    bottom: '-5px',
    width: 'auto',
    height: '6px',
    marginLeft: 0,
    transform: 'none',
    cursor: 'ns-resize',
    zIndex: 1,
});

// Keep edge resizing available without visible grips.
globalStyle(`${rightHandle}::after, ${bottomHandle}::after`, {
    display: 'none',
});
