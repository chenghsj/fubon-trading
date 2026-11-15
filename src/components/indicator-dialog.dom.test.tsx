// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { IndicatorDialog } from './indicator-dialog';
import { addMAPresets, MA_PRESET_GROUP } from '../lib/ma-presets';
import { listMAGroups } from '../lib/ma-groups';
import { COLOR_GRID } from './indicator-color-picker';

beforeEach(() => localStorage.clear());
afterEach(() => cleanup());

it('offers single MA presets and the group without opening the ordinary indicator editor', async () => {
    const user = userEvent.setup();
    const onAdd = vi.fn();
    const onAddMAPreset = vi.fn();
    render(<IndicatorDialog instances={[]} onAdd={onAdd} onAddMAPreset={onAddMAPreset} onAddMAGroup={vi.fn()} onClose={vi.fn()} />);
    const presets = screen.getByRole('group', { name: 'MA 預設週期' });
    await user.click(within(presets).getByRole('button', { name: '加入 MA120' }));
    expect(onAddMAPreset).toHaveBeenLastCalledWith([120]);
    await user.click(within(presets).getByRole('button', { name: '一鍵加入 5／10／20／60' }));
    expect(onAddMAPreset).toHaveBeenLastCalledWith([5, 10, 20, 60]);
    expect(onAdd).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: /^MA 移動平均/ }));
    expect(onAdd).toHaveBeenCalledWith('sma');
});

it('shows existing periods and disables the completed group after the chart updates', () => {
    const callbacks = { onAdd: vi.fn(), onAddMAPreset: vi.fn(), onAddMAGroup: vi.fn(), onClose: vi.fn() };
    const view = render(<IndicatorDialog instances={addMAPresets([], [5])} {...callbacks} />);
    expect(screen.getByRole('button', { name: 'MA5（已加入）' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: '一鍵加入 5／10／20／60' }).hasAttribute('disabled')).toBe(false);
    view.rerender(<IndicatorDialog instances={addMAPresets([], MA_PRESET_GROUP)} {...callbacks} />);
    expect(screen.getByRole('button', { name: '5／10／20／60 已齊全' }).hasAttribute('disabled')).toBe(true);
});

it('finds presets by period searches while respecting the selected category', async () => {
    const user = userEvent.setup();
    render(<IndicatorDialog instances={[]} onAdd={vi.fn()} onAddMAPreset={vi.fn()} onAddMAGroup={vi.fn()} onClose={vi.fn()} />);
    const search = screen.getByPlaceholderText('搜尋指標（名稱、縮寫、中英文都可以）');
    for (const query of ['MA5', 'MA (10)', '60期']) {
        await user.clear(search);
        await user.type(search, query);
        expect(screen.getByRole('group', { name: 'MA 預設週期' })).toBeDefined();
    }
    await user.click(screen.getByRole('button', { name: '副圖指標' }));
    expect(screen.queryByRole('group', { name: 'MA 預設週期' })).toBeNull();
});

it('creates, edits, applies and deletes a named combination without changing the chart until Apply', async () => {
    const user = userEvent.setup();
    const apply = vi.fn();
    render(<IndicatorDialog instances={[]} onAdd={vi.fn()} onAddMAPreset={vi.fn()} onAddMAGroup={apply} onClose={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: '建立均線組合' }));
    let editor = screen.getByRole('dialog', { name: '建立均線組合' });
    await user.type(within(editor).getByLabelText('組合名稱'), '盤中組合');
    await user.click(within(editor).getByRole('button', { name: '移除第 4 條均線' }));
    await user.click(within(editor).getByRole('button', { name: '移除第 3 條均線' }));
    fireEvent.change(within(editor).getByLabelText('第 1 條週期'), { target: { value: '7' } });
    fireEvent.change(within(editor).getByLabelText('第 2 條週期'), { target: { value: '21' } });
    await user.click(within(editor).getByRole('button', { name: '第 1 條顏色' }));
    await user.clear(screen.getByLabelText('自訂色碼'));
    await user.type(screen.getByLabelText('自訂色碼'), '#123456');
    await user.click(screen.getByRole('button', { name: '套用色碼' }));
    await user.click(within(editor).getByRole('button', { name: '儲存組合' }));
    expect(apply).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: '套用 盤中組合' }));
    expect(apply).toHaveBeenCalledWith([{ period: 7, color: '#123456' }, { period: 21, color: '#19b6c9' }]);
    await user.click(screen.getByRole('button', { name: '編輯 盤中組合' }));
    editor = screen.getByRole('dialog', { name: '編輯均線組合' });
    await user.clear(within(editor).getByLabelText('組合名稱'));
    await user.type(within(editor).getByLabelText('組合名稱'), '改名組合');
    await user.click(within(editor).getByRole('button', { name: '儲存組合' }));
    expect(screen.getByRole('button', { name: '套用 改名組合' })).toBeDefined();
    await user.click(screen.getByRole('button', { name: '編輯 改名組合' }));
    await user.click(screen.getByRole('button', { name: '刪除組合' }));
    expect(listMAGroups()).toEqual([]);
});

it('shows invalid duplicate periods and keeps cancellation from saving the group', async () => {
    const user = userEvent.setup();
    render(<IndicatorDialog instances={[]} onAdd={vi.fn()} onAddMAPreset={vi.fn()} onAddMAGroup={vi.fn()} onClose={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: '建立均線組合' }));
    const editor = screen.getByRole('dialog', { name: '建立均線組合' });
    await user.type(within(editor).getByLabelText('組合名稱'), 'Invalid');
    fireEvent.change(within(editor).getByLabelText('第 1 條週期'), { target: { value: '10' } });
    await user.click(within(editor).getByRole('button', { name: '儲存組合' }));
    expect(within(editor).getByRole('alert').textContent).toContain('重複週期');
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: '建立均線組合' })).toBeNull();
    expect(screen.getByRole('dialog', { name: '技術指標' })).toBeDefined();
    expect(listMAGroups()).toEqual([]);
});

it('selects a swatch, rejects incomplete hex and saves a custom color', async () => {
    const user = userEvent.setup();
    render(<IndicatorDialog instances={[]} onAdd={vi.fn()} onAddMAPreset={vi.fn()} onAddMAGroup={vi.fn()} onClose={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: '建立均線組合' }));
    const editor = screen.getByRole('dialog', { name: '建立均線組合' });
    await user.type(within(editor).getByLabelText('組合名稱'), '色票組合');
    const trigger = within(editor).getByRole('button', { name: '第 1 條顏色' });
    await user.click(trigger);
    await user.click(screen.getByRole('button', { name: '常用色 #B06FFF' }));
    expect(screen.queryByRole('dialog', { name: '選擇第 1 條顏色' })).toBeNull();
    await user.click(trigger);
    expect((screen.getByLabelText('自訂色碼') as HTMLInputElement).value).toBe('#B06FFF');
    await user.clear(screen.getByLabelText('自訂色碼'));
    await user.type(screen.getByLabelText('自訂色碼'), '#12');
    expect(screen.getByRole('button', { name: '套用色碼' }).hasAttribute('disabled')).toBe(true);
    await user.clear(screen.getByLabelText('自訂色碼'));
    await user.type(screen.getByLabelText('自訂色碼'), '#abcdef{Enter}');
    await user.click(within(editor).getByRole('button', { name: '儲存組合' }));
    expect(listMAGroups()[0]!.lines[0]!.color).toBe('#abcdef');
});

it('supports color arrow keys and closes only the palette on Escape, returning focus to its trigger', async () => {
    const user = userEvent.setup();
    render(<IndicatorDialog instances={[]} onAdd={vi.fn()} onAddMAPreset={vi.fn()} onAddMAGroup={vi.fn()} onClose={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: '建立均線組合' }));
    const editor = screen.getByRole('dialog', { name: '建立均線組合' });
    const trigger = within(editor).getByRole('button', { name: '第 1 條顏色' });
    await user.click(trigger);
    screen.getByRole('radio', { name: '顏色 #FFFFFF' }).focus();
    await user.keyboard('{ArrowRight}');
    const next = screen.getByRole('radio', { name: `顏色 ${COLOR_GRID[0]![1]!.toUpperCase()}` });
    expect(next.getAttribute('aria-checked')).toBe('true');
    expect(document.activeElement).toBe(next);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: '選擇第 1 條顏色' })).toBeNull();
    expect(screen.getByRole('dialog', { name: '建立均線組合' })).toBeDefined();
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    await user.keyboard('{Escape}');
    expect(screen.getByRole('dialog', { name: '技術指標' })).toBeDefined();
});
