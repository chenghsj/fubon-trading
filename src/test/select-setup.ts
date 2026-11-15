import { vi } from 'vitest';

// Node renderer tests cover consumer/account logic without a browser. Radix
// requires DOM APIs; the real Select is covered by jsdom and browser QA.
vi.mock('../components/ui/select-control', async original => {
    if (typeof HTMLFormElement !== 'undefined') return original();
    const { createElement, forwardRef } = await import('react');
    return {
        SelectControl: forwardRef(function SelectControl({ children, ...props }: Record<string, unknown>, ref) {
            return createElement('select-control', { ...props, ref }, children as React.ReactNode);
        }),
        SelectOption: ({ children, ...props }: Record<string, unknown>) => createElement('select-option', props, children as React.ReactNode),
        SelectOptionGroup: ({ children, ...props }: Record<string, unknown>) => createElement('select-group', props, children as React.ReactNode),
    };
});
