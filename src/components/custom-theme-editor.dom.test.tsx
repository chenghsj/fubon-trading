// @vitest-environment jsdom
import { useState } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
    Element.prototype.hasPointerCapture = () => false;
    Element.prototype.setPointerCapture = vi.fn();
    Element.prototype.releasePointerCapture = vi.fn();
    setThemeSettings({ mode: 'light', preset: undefined, accent: undefined, custom: CUSTOM_BASES.light });
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
    const trigger = screen.getByRole('combobox', { name: '主題' });
    await user.click(trigger);
    const search = screen.getByRole('combobox', { name: '搜尋主題' });
    if (query) await user.type(search, query);

    let claimed = false;
    window.addEventListener('keydown', event => { claimed = event.defaultPrevented; }, { once: true });
    await user.keyboard('{Escape}');

    expect(claimed).toBe(true);
    expect(screen.getByRole('dialog', { name: '外觀測試' })).toBeDefined();
    expect(screen.queryByRole('combobox', { name: '搜尋主題' })).toBeNull();
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    await waitFor(() => expect(document.activeElement).toBe(trigger));

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: '外觀測試' })).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(opener));
});

it('主題、深淺模式和強調色可以分別設定並還原', async () => {
    const user = userEvent.setup();
    render(<CustomThemeEditor />);
    const trigger = screen.getByRole('combobox', { name: '主題' });
    await user.click(trigger);
    await user.type(screen.getByRole('combobox', { name: '搜尋主題' }), 'Catppuccin');
    await user.click(screen.getByRole('option', { name: 'Catppuccin' }));
    expect(trigger.textContent).toContain('Catppuccin');
    await user.click(screen.getByRole('radio', { name: '深色' }));
    expect(trigger.textContent).toContain('Catppuccin');
    fireEvent.change(screen.getByLabelText('強調色顏色'), { target: { value: '#abcdef' } });
    const saved = () => JSON.parse(localStorage.getItem('sj-pro-theme')!);
    expect(saved()).toMatchObject({ mode: 'dark', preset: 'Catppuccin', accent: '#abcdef' });
    await user.click(trigger);
    await user.type(screen.getByRole('combobox', { name: '搜尋主題' }), 'Nord');
    await user.click(screen.getByRole('option', { name: 'Nord' }));
    expect(saved()).toMatchObject({ mode: 'dark', preset: 'Nord', accent: '#abcdef' });
    expect(screen.getByRole('combobox', { name: '強調色來源' }).textContent).toContain('自訂');
    await user.click(screen.getByRole('combobox', { name: '強調色來源' }));
    await user.click(screen.getByRole('option', { name: '主題預設' }));
    expect(saved().accent).toBeUndefined();
    expect(trigger.textContent).toContain('Nord');
});

it('進階配色保留六色編輯，且不會重設深淺模式', async () => {
    const user = userEvent.setup();
    render(<CustomThemeEditor />);
    expect(screen.queryByLabelText('背景顏色')).toBeNull();
    await user.click(screen.getByRole('button', { name: '進階配色' }));
    fireEvent.change(screen.getByLabelText('背景顏色'), { target: { value: '#fefefe' } });
    expect(JSON.parse(localStorage.getItem('sj-pro-theme')!)).toMatchObject({ mode: 'light', preset: 'custom', custom: { background: '#fefefe' } });
    await user.click(screen.getByRole('button', { name: '重設為預設配色' }));
    expect(JSON.parse(localStorage.getItem('sj-pro-theme')!)).toMatchObject({ mode: 'light' });
    expect(JSON.parse(localStorage.getItem('sj-pro-theme')!).preset).toBeUndefined();
    expect(screen.getByRole('combobox', { name: '主題' }).textContent).toContain('Absolutely');
});

it('主題清單只顯示目前模式可用的版本', async () => {
    const user = userEvent.setup();
    render(<CustomThemeEditor />);
    const trigger = screen.getByRole('combobox', { name: '主題' });
    await user.click(trigger);
    expect(screen.getByRole('option', { name: 'Proof' })).toBeDefined();
    expect(screen.queryByRole('option', { name: 'Dracula' })).toBeNull();
    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('radio', { name: '深色' }));
    await user.click(trigger);
    expect(screen.getByRole('option', { name: 'Dracula' })).toBeDefined();
    expect(screen.queryByRole('option', { name: 'Proof' })).toBeNull();
});
