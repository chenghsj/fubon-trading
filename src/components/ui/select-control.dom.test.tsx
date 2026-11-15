// @vitest-environment jsdom
import { useState } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { TerminalDialog } from '../terminal-dialog';
import { SelectControl, SelectOption, SelectOptionGroup } from './select-control';
import { escStackDepth } from '@/hooks/use-esc-close';
import { useHotkeys, TICKET_ACTION_EVENT } from '@/hooks/use-hotkeys';
import { setRiskSettings } from '@/lib/risk';
import { resetEscCancelArm } from '@/lib/esc-cancel-arm';

const trading = vi.hoisted(() => ({ cancel: vi.fn(async () => []), notify: vi.fn() }));
vi.mock('@/lib/trade', () => ({ cancelAllOrders: trading.cancel, notify: trading.notify }));

beforeEach(() => {
    trading.cancel.mockClear(); trading.notify.mockClear(); resetEscCancelArm();
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
    Element.prototype.scrollIntoView = vi.fn();
    Element.prototype.hasPointerCapture = () => false;
    Element.prototype.setPointerCapture = vi.fn();
    Element.prototype.releasePointerCapture = vi.fn();
});
afterEach(() => { cleanup(); expect(escStackDepth()).toBe(0); setRiskSettings({ escCancelAll: false }); resetEscCancelArm(); vi.unstubAllGlobals(); });

it('preserves numeric zero, empty choices and labelled option groups', async () => {
    const changed = vi.fn();
    function Harness() {
        const [value, setValue] = useState<string | number>(0);
        return <SelectControl aria-label="月份" value={value} onValueChange={next => { changed(next); setValue(next); }}>
            <SelectOption value="">跟隨主畫面</SelectOption>
            <SelectOptionGroup label="到期月份"><SelectOption value={0}>近月</SelectOption><SelectOption value={202612}>十二月</SelectOption></SelectOptionGroup>
        </SelectControl>;
    }
    const user = userEvent.setup(); render(<Harness />);
    const trigger = screen.getByRole('combobox', { name: '月份' });
    expect(trigger.tagName).toBe('BUTTON');
    expect(trigger.textContent).toContain('近月');
    await user.click(trigger);
    expect(screen.getByRole('group', { name: '到期月份' })).toBeTruthy();
    await user.click(screen.getByRole('option', { name: '十二月' }));
    expect(changed).toHaveBeenLastCalledWith('202612');
    expect(trigger.textContent).toContain('十二月');
    await user.click(trigger);
    await user.click(screen.getByRole('option', { name: '跟隨主畫面' }));
    expect(changed).toHaveBeenLastCalledWith('');
    expect(trigger.textContent).toContain('跟隨主畫面');
});

it('closes only the Select on Escape before closing its surrounding dialog', async () => {
    function Harness() {
        const [open, setOpen] = useState(true);
        return open && <TerminalDialog title="策略設定" onClose={() => setOpen(false)}>
            <SelectControl aria-label="策略" defaultValue="base"><SelectOption value="base">基準</SelectOption><SelectOption value="filter">濾網</SelectOption></SelectControl>
        </TerminalDialog>;
    }
    const user = userEvent.setup(); render(<Harness />);
    const trigger = screen.getByRole('combobox', { name: '策略' });
    await user.click(trigger);
    expect(screen.getByRole('listbox')).toBeTruthy();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(screen.getByRole('dialog', { name: '策略設定' })).toBeTruthy();
    expect(document.activeElement).toBe(trigger);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
});

it('supports keyboard navigation through a long list and ignores disabled options', async () => {
    const changed = vi.fn();
    render(<SelectControl aria-label="商品" defaultValue="0" onValueChange={changed}>
        {Array.from({ length: 70 }, (_, i) => <SelectOption key={i} value={i} disabled={i === 1}>商品 {i}</SelectOption>)}
    </SelectControl>);
    const user = userEvent.setup();
    screen.getByRole('combobox').focus();
    await user.keyboard('{Enter}{ArrowDown}{Enter}');
    expect(changed).toHaveBeenLastCalledWith('2');
    await user.keyboard('{Enter}{End}{Enter}');
    expect(changed).toHaveBeenLastCalledWith('69');
});

it('does not open or emit changes when disabled', async () => {
    const changed = vi.fn();
    render(<SelectControl aria-label="鎖定帳戶" disabled value="F" onValueChange={changed}><SelectOption value="F">期貨</SelectOption></SelectControl>);
    const user = userEvent.setup(); await user.click(screen.getByRole('combobox'));
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(changed).not.toHaveBeenCalled();
});

it('keeps Select typeahead and repeated Escape away from trading hotkeys', async () => {
    const actions = vi.fn();
    function Harness() {
        useHotkeys({ onOpenPalette: () => undefined, onAfterCancelAll: () => undefined });
        return <SelectControl aria-label="英文帳戶" defaultValue="B"><SelectOption value="B">Broker B</SelectOption><SelectOption value="S">Stock S</SelectOption></SelectControl>;
    }
    setRiskSettings({ escCancelAll: true });
    window.addEventListener(TICKET_ACTION_EVENT, actions);
    try {
        const user = userEvent.setup(); render(<Harness />);
        const trigger = screen.getByRole('combobox');
        trigger.focus();
        await user.keyboard('bs');
        await user.click(trigger);
        expect(screen.getByRole('listbox')).toBeTruthy();
        await user.keyboard('bs{Escape}{Escape}');
        expect(screen.queryByRole('listbox')).toBeNull();
        expect(actions).not.toHaveBeenCalled();
        expect(trading.cancel).not.toHaveBeenCalled();
        expect(trading.notify).not.toHaveBeenCalled();
    } finally { window.removeEventListener(TICKET_ACTION_EVENT, actions); }
});
