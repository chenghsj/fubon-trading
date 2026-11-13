// @vitest-environment jsdom
import { useState } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { TerminalDialog } from './terminal-dialog';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { escStackDepth } from '../hooks/use-esc-close';

function Harness({ locked = false }: { locked?: boolean }) {
    const [open, setOpen] = useState(false);
    const [nested, setNested] = useState(false);
    return <>
        <Button onClick={() => setOpen(true)}>設定入口</Button>
        {open && <TerminalDialog title="設定測試" onClose={() => setOpen(false)} locked={locked}>
            <Input aria-label="商品" />
            <Button onClick={() => setNested(true)}>進階設定</Button>
            <Button onClick={() => setOpen(false)}>取消</Button>
            {nested && <TerminalDialog title="進階測試" onClose={() => setNested(false)}>
                <Button onClick={() => setNested(false)}>關閉進階</Button>
            </TerminalDialog>}
        </TerminalDialog>}
    </>;
}
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it('contains keyboard focus and returns it to the opener on Escape', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const opener = screen.getByRole('button', { name: '設定入口' });
    await user.click(opener);
    const dialog = screen.getByRole('dialog', { name: '設定測試' });
    expect(dialog.contains(document.activeElement)).toBe(true);
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '取消' }));
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: '商品' }));
    let claimed = false;
    window.addEventListener('keydown', event => { if (event.key === 'Escape') claimed = event.defaultPrevented; }, { once: true });
    await user.keyboard('{Escape}');
    expect(claimed).toBe(true);
    expect(screen.queryByRole('dialog')).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(opener));
    expect(escStackDepth()).toBe(0);
});

it('closes only the upper nested dialog per Escape press', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('button', { name: '設定入口' }));
    const nestedOpener = screen.getByRole('button', { name: '進階設定' });
    await user.click(nestedOpener);
    expect(screen.getByRole('dialog', { name: '進階測試' })).toBeDefined();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: '進階測試' })).toBeNull();
    expect(screen.getByRole('dialog', { name: '設定測試' })).toBeDefined();
    await waitFor(() => expect(document.activeElement).toBe(nestedOpener));
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
});

it('keeps a busy dialog and an IME composition open', async () => {
    const user = userEvent.setup();
    const view = render(<Harness locked />);
    await user.click(screen.getByRole('button', { name: '設定入口' }));
    await user.keyboard('{Escape}');
    expect(screen.getByRole('dialog')).toBeDefined();
    view.rerender(<Harness />);
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape', isComposing: true });
    expect(screen.getByRole('dialog')).toBeDefined();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
});
