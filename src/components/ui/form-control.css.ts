import { globalStyle } from '@vanilla-extract/css';

// All native form fields are rendered by these primitives. Element selectors
// keep geometry below panel/utility classes regardless of stylesheet order,
// including older WebViews without :where(). Visual treatment stays in shadcn.
globalStyle('input, textarea', {
    width: '100%',
    minWidth: 0,
    fontSize: '0.72rem',
    lineHeight: 1.45,
    padding: '3px 8px',
});

globalStyle('input', {
    height: 'auto',
    minHeight: '24px',
});

globalStyle('textarea', {
    minHeight: '60px',
});
