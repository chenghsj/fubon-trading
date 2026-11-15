// @vitest-environment jsdom
import { useState } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Checkbox } from './ui/checkbox';
import { Switch } from './ui/switch';
import { Label } from './ui/label';
import { Slider } from './ui/slider';
import { Tabs, TabsList, TabsTrigger, TabsContent } from './ui/tabs';
import { SelectControl, SelectOption } from './ui/select-control';
import { RadioGroup, RadioGroupItem } from './ui/radio-group';

beforeEach(() => {
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
    Element.prototype.scrollIntoView = vi.fn();
    Element.prototype.hasPointerCapture = () => false;
    Element.prototype.setPointerCapture = vi.fn();
    Element.prototype.releasePointerCapture = vi.fn();
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it('uses controlled Checkbox and Switch state with labels and disabled behavior', async () => {
    function Controls() {
        const [on, setOn] = useState(false);
        return <><Label htmlFor="selected">選取委託</Label><Checkbox id="selected" checked={on} onCheckedChange={next => setOn(next === true)} />
            <Switch checked={on} onCheckedChange={setOn} aria-label="隱私" />
            <Checkbox disabled aria-label="不可操作" /></>;
    }
    const user = userEvent.setup(); render(<Controls />);
    await user.click(screen.getByText('選取委託'));
    expect(screen.getByRole('checkbox', { name: '選取委託' }).getAttribute('aria-checked')).toBe('true');
    const toggle = screen.getByRole('switch', { name: '隱私' });
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    toggle.focus(); await user.keyboard(' ');
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    await user.click(screen.getByRole('checkbox', { name: '不可操作' }));
    expect(screen.getByRole('checkbox', { name: '不可操作' }).getAttribute('aria-checked')).toBe('false');
});
it('preserves numeric slider values and keyboard steps', async () => {
    function Control() { const [value, setValue] = useState(10); return <Slider min={0} max={20} step={2} value={[value]} onValueChange={next => setValue(next[0]!)} aria-label="回放位置" />; }
    const user = userEvent.setup(); render(<Control />);
    const slider = screen.getByRole('slider', { name: '回放位置' }); slider.focus();
    await user.keyboard('{ArrowRight}');
    expect(slider.getAttribute('aria-valuenow')).toBe('12');
});
it('supports vertical tab navigation and labelled panels', async () => {
    const user = userEvent.setup();
    render(<Tabs defaultValue="appearance" orientation="vertical"><TabsList aria-label="設定分類"><TabsTrigger value="appearance">外觀</TabsTrigger><TabsTrigger value="risk">風控</TabsTrigger></TabsList><TabsContent value="appearance">主題</TabsContent><TabsContent value="risk">單筆上限</TabsContent></Tabs>);
    screen.getByRole('tab', { name: '外觀' }).focus(); await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('tab', { name: '風控' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tabpanel', { name: '風控' }).textContent).toBe('單筆上限');
});
it('keeps Select changes and deliberate radio selection controlled', async () => {
    function Controls() { const [value, setValue] = useState(''); return <><SelectControl aria-label="帳戶" value={value} onValueChange={selectedValue => setValue(selectedValue)}><SelectOption value="">請選擇</SelectOption><SelectOption value="F">期貨</SelectOption></SelectControl><RadioGroup value={value} onValueChange={setValue} aria-label="核對結果"><Label htmlFor="confirm-sent">確認已送出</Label><RadioGroupItem id="confirm-sent" value="F" /></RadioGroup></>; }
    const user = userEvent.setup(); render(<Controls />);
    expect(screen.getByRole('radio').getAttribute('aria-checked')).toBe('false');
    const trigger = screen.getByRole('combobox');
    expect(trigger.tagName).toBe('BUTTON');
    trigger.focus();
    await user.keyboard('{ArrowDown}');
    await user.click(screen.getByRole('option', { name: '期貨' }));
    expect(screen.getByRole('radio', { name: '確認已送出' }).getAttribute('aria-checked')).toBe('true');
    expect(document.activeElement).toBe(trigger);
});
