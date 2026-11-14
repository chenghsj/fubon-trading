// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { useHotkeys, TICKET_ACTION_EVENT } from './use-hotkeys';
import { resetEscCancelArm } from '../lib/esc-cancel-arm';
import { Checkbox } from '../components/ui/checkbox';
import { Switch } from '../components/ui/switch';
import { Slider } from '../components/ui/slider';
import { RadioGroup, RadioGroupItem } from '../components/ui/radio-group';
const m = vi.hoisted(() => ({ cancel: vi.fn(async () => undefined), notify: vi.fn() }));
vi.mock('../lib/risk', () => ({ getRiskSettings: () => ({ escCancelAll: true }) }));
vi.mock('../lib/trade', () => ({ cancelAllOrders: m.cancel, notify: m.notify }));
function Harness() {
    useHotkeys({ onOpenPalette: () => undefined, onAfterCancelAll: () => undefined });
    return <><Checkbox aria-label="選取" /><Switch aria-label="設定" /><Slider aria-label="位置" defaultValue={[10]} />
        <RadioGroup aria-label="核對"><RadioGroupItem value="sent" aria-label="已送出" /></RadioGroup></>;
}
beforeEach(() => {
    resetEscCancelArm(); m.cancel.mockClear(); m.notify.mockClear();
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
});
afterEach(() => { cleanup(); resetEscCancelArm(); vi.unstubAllGlobals(); });
it.each(['checkbox', 'switch', 'slider', 'radio'] as const)('%s does not switch trading direction or count toward Escape cancel-all', async role => {
    render(<Harness />);
    const actions: string[] = [];
    const listener = (event: Event) => actions.push((event as CustomEvent).detail.action);
    window.addEventListener(TICKET_ACTION_EVENT, listener);
    try {
        const control = screen.getByRole(role); control.focus();
        fireEvent.keyDown(control, { key: 'b' }); fireEvent.keyDown(control, { key: 's' });
        fireEvent.keyDown(control, { key: 'Escape' }); fireEvent.keyDown(control, { key: 'Escape' });
        expect(actions).toEqual([]); expect(m.cancel).not.toHaveBeenCalled();
        control.blur();
        fireEvent.keyDown(document.body, { key: 'Escape' });
        control.focus(); fireEvent.keyDown(control, { key: 'Escape' }); control.blur();
        fireEvent.keyDown(document.body, { key: 'Escape' });
        expect(m.cancel).not.toHaveBeenCalled();
        fireEvent.keyDown(document.body, { key: 'Escape' });
        expect(m.cancel).toHaveBeenCalledTimes(1);
        fireEvent.keyDown(document.body, { key: 'b' }); fireEvent.keyDown(document.body, { key: 's' });
        expect(actions).toEqual(['Buy', 'Sell']);
    } finally { window.removeEventListener(TICKET_ACTION_EVENT, listener); }
});
