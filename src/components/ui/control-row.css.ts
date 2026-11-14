import { createVar, globalStyle, style } from '@vanilla-extract/css';

export const rowControlHeight = createVar();

// A row owns its controls' height. Typography and horizontal padding can stay
// specific to each panel without producing different top/bottom edges.
export const controlRow = style({
    vars: { [rowControlHeight]: 'max(24px, 1.5rem)' },
});

const controls = [
    'input[data-slot="input"]',
    'select[data-slot="native-select"]',
    'button[data-slot="button"]:not([role="switch"])',
    'button[data-state="on"]',
    'button[data-state="off"]',
];

globalStyle(controls.map(selector => `${controlRow} ${selector}`).join(', '), {
    boxSizing: 'border-box',
    height: rowControlHeight,
    minHeight: rowControlHeight,
    maxHeight: rowControlHeight,
    paddingTop: 0,
    paddingBottom: 0,
    alignSelf: 'center',
    // Font-size/theme changes must not animate each control's geometry apart.
    transitionProperty: 'color, background-color, border-color, box-shadow, opacity, transform',
});
