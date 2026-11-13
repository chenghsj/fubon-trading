import type { Config } from 'tailwindcss';
import animate from 'tailwindcss-animate';

export default {
    content: ['./index.html', './approval.html', './src/**/*.{ts,tsx}'],
    // The terminal already supplies its reset; preserve chart/grid geometry.
    corePlugins: { preflight: false },
    theme: {
        extend: {
            colors: { 'primary-soft': 'var(--primary-soft)', 'destructive-solid': 'var(--destructive-solid)', ...Object.fromEntries([
                'background', 'foreground', 'border', 'input', 'ring',
                'primary', 'secondary', 'muted', 'accent', 'destructive', 'popover', 'card',
            ].map(name => [name, ['primary', 'secondary', 'muted', 'accent', 'destructive', 'popover', 'card'].includes(name)
                ? { DEFAULT: `var(--${name})`, foreground: `var(--${name}-foreground)` }
                : `var(--${name})`])) },
            borderRadius: { lg: 'var(--radius)', md: 'calc(var(--radius) - 2px)', sm: 'calc(var(--radius) - 4px)' },
        },
    },
    plugins: [animate],
} satisfies Config;
