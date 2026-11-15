// @vitest-environment jsdom
import { useState } from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CustomThemeEditor } from './custom-theme-editor';
import { TerminalDialog } from './terminal-dialog';
import { Button } from './ui/button';
import { CUSTOM_BASES } from '../lib/custom-theme';
import { setThemeSettings } from '../lib/theme-store';
import { escStackDepth } from '../hooks/use-esc-close';

const scrollIntoViewDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollIntoView');

function Harness() {
    const [open, setOpen] = useState(false);
    return <>
        <Button onClick={() => setOpen(true)}>設定入口</Button>
        {open && <TerminalDialog title="外觀測試" onClose={() => setOpen(false)}>
            <CustomThemeEditor />
        </TerminalDialog>}
    </>;
}

beforeEach(() => {
    vi.stubGlobal('ResizeObserver', class {
        observe() {}
        unobserve() {}
        disconnect() {}
    });
    Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
    setThemeSettings({ mode: 'custom', custom: CUSTOM_BASES.light });
});

afterEach(() => {
    cleanup();
    expect(escStackDepth()).toBe(0);
    if (scrollIntoViewDescriptor) Object.defineProperty(Element.prototype, 'scrollIntoView', scrollIntoViewDescriptor);
    else Reflect.deleteProperty(Element.prototype, 'scrollIntoView');
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

it.each(['', 'Nord'])('搜尋 %j 時，Escape 只關主題清單，下一次才關設定', async (query) => {
    const user = userEvent.setup();
    render(<Harness />);
    const opener = screen.getByRole('button', { name: '設定入口' });
    await user.click(opener);
    const trigger = screen.getByRole('combobox', { name: 'Codex 預設組合' });
    await user.click(trigger);
    const search = screen.getByRole('combobox', { name: '搜尋 Codex 主題' });
    if (query) await user.type(search, query);

    let claimed = false;
    window.addEventListener('keydown', event => { claimed = event.defaultPrevented; }, { once: true });
    await user.keyboard('{Escape}');

    expect(claimed).toBe(true);
    expect(screen.getByRole('dialog', { name: '外觀測試' })).toBeDefined();
    expect(screen.queryByRole('combobox', { name: '搜尋 Codex 主題' })).toBeNull();
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    await waitFor(() => expect(document.activeElement).toBe(trigger));

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: '外觀測試' })).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(opener));
});
