import { globalStyle } from '@vanilla-extract/css';

// All native form fields are rendered by these primitives. Element selectors
// keep geometry below panel/utility classes regardless of stylesheet order,
// including older WebViews without :where(). Visual treatment stays in shadcn.
globalStyle('input, select, textarea', {
    width: '100%',
    minWidth: 0,
    fontSize: '0.72rem',
    lineHeight: 1.45,
    padding: '3px 8px',
});

globalStyle('input, select', {
    height: 'auto',
    minHeight: '24px',
});

globalStyle('textarea', {
    minHeight: '60px',
});

globalStyle('select[data-size="default"]', {
    height: '2.25rem',
    fontSize: '0.875rem',
    padding: '8px 12px',
});

globalStyle('select[data-size="sm"]', {
    height: '2rem',
    fontSize: '0.875rem',
    padding: '4px 12px',
});

// Reserve the icon's space even when the panel supplies its own padding.
globalStyle('[data-slot="native-select"][data-icon="true"]', {
    paddingRight: '24px',
});
