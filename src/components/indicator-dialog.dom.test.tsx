// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { IndicatorDialog } from './indicator-dialog';
import { addMAPresets, MA_PRESET_GROUP } from '../lib/ma-presets';
import { listMAGroups, saveMAGroup } from '../lib/ma-groups';
import { COLOR_GRID } from './indicator-color-picker';
import { newInstance } from '../lib/indicator-defs';

beforeEach(() => localStorage.clear());
afterEach(() => cleanup());

it('only offers explicit custom MA creation and omits all built-in preset and bulk-add controls', async () => {
    const user = userEvent.setup();
    const onAdd = vi.fn();
    render(<IndicatorDialog instances={[]} onAdd={onAdd} onAddMAGroup={vi.fn()} onClose={vi.fn()} />);
    expect(screen.queryByRole('group', { name: 'MA 預設週期' })).toBeNull();
    expect(screen.queryByRole('button', { name: /加入 MA(?:5|10|20|60|120|240)$/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /一鍵加入|5／10／20／60 已齊全/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /^MA 移動平均/ })).toBeNull();
    await user.click(screen.getByText('MA 移動平均'));
    expect(onAdd).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: '自訂均線' }));
    expect(onAdd).toHaveBeenCalledExactlyOnceWith('sma');
});

it('edits a hidden existing MA through the management tab without adding or unhiding a duplicate', async () => {
    const user = userEvent.setup();
    const [ma] = addMAPresets([], [20]);
    ma!.hidden = true;
    ma!.visibleTf = [60];
    const management = { timeframe: 3, onSettings: vi.fn(), onToggle: vi.fn(), onReorder: vi.fn(), onRemove: vi.fn(), onDuplicate: vi.fn() };
    const onAdd = vi.fn();
    render(<IndicatorDialog instances={[ma!]} management={management} onAdd={onAdd} onAddMAGroup={vi.fn()} onClose={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'MA(20) 設定' }));
    expect(management.onSettings).toHaveBeenCalledExactlyOnceWith(ma!.id);
    expect(onAdd).not.toHaveBeenCalled();
    expect(management.onToggle).not.toHaveBeenCalled();
    expect(ma).toMatchObject({ hidden: true, visibleTf: [60], params: { period: 20 } });
});

it('starts an empty named-group editor with one editable line instead of a preset pack', async () => {
    const user = userEvent.setup();
    render(<IndicatorDialog instances={[]} onAdd={vi.fn()} onAddMAGroup={vi.fn()} onClose={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: '建立均線組合' }));
    const editor = screen.getByRole('dialog', { name: '建立均線組合' });
    expect(within(editor).getAllByRole('spinbutton')).toHaveLength(1);
    expect((within(editor).getByLabelText('第 1 條週期') as HTMLInputElement).value).toBe('20');
});

it('separates applying missing group lines from editing the saved combination', async () => {
    const user = userEvent.setup();
    const group = saveMAGroup({ name: 'QA 清楚組合', lines: [{ period: 5, color: '#123456' }, { period: 10, color: '#234567' }, { period: 20, color: '#345678' }] });
    const onAddMAGroup = vi.fn();
    const props = { onAdd: vi.fn(), onAddMAGroup, onClose: vi.fn() };
    const view = render(<IndicatorDialog instances={addMAPresets([], [5])} {...props} />);
    const apply = screen.getByRole('button', { name: '套用 QA 清楚組合' });
    expect(apply.textContent).toMatch(/套用.*加入 2 條/);
    await user.click(apply);
    expect(onAddMAGroup).toHaveBeenCalledExactlyOnceWith(group.lines);
    view.rerender(<IndicatorDialog instances={addMAPresets([], [5, 10, 20])} {...props} />);
    const complete = screen.getByRole('button', { name: 'QA 清楚組合（已加入）' });
    expect(complete.hasAttribute('disabled')).toBe(true);
    expect(complete.textContent).toContain('已全部加入');
    const edit = screen.getByRole('button', { name: '編輯 QA 清楚組合' });
    expect(edit.textContent).toContain('編輯組合');
    await user.click(edit);
    expect(screen.getByRole('dialog', { name: '編輯均線組合' })).toBeDefined();
    expect(onAddMAGroup).toHaveBeenCalledTimes(1);
});

it('finds custom MA by arbitrary root-count searches without offering presets, while respecting category', async () => {
    const user = userEvent.setup();
    render(<IndicatorDialog instances={[]} onAdd={vi.fn()} onAddMAGroup={vi.fn()} onClose={vi.fn()} />);
    const search = screen.getByPlaceholderText('搜尋指標（名稱、縮寫、中英文都可以）');
    for (const query of ['MA5', 'MA (10)', '60期', '137根']) {
        await user.clear(search);
        await user.type(search, query);
        expect(screen.getByRole('button', { name: '自訂均線' })).toBeDefined();
        expect(screen.queryByRole('group', { name: 'MA 預設週期' })).toBeNull();
    }
    await user.click(screen.getByRole('button', { name: '副圖指標' }));
    expect(screen.queryByRole('button', { name: '自訂均線' })).toBeNull();
});

it('creates, edits, applies and deletes a named combination without changing the chart until Apply', async () => {
    const user = userEvent.setup();
    const apply = vi.fn();
    render(<IndicatorDialog instances={addMAPresets([], MA_PRESET_GROUP)} onAdd={vi.fn()} onAddMAGroup={apply} onClose={vi.fn()} />);
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
    render(<IndicatorDialog instances={addMAPresets([], MA_PRESET_GROUP)} onAdd={vi.fn()} onAddMAGroup={vi.fn()} onClose={vi.fn()} />);
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
    render(<IndicatorDialog instances={[]} onAdd={vi.fn()} onAddMAGroup={vi.fn()} onClose={vi.fn()} />);
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
    render(<IndicatorDialog instances={[]} onAdd={vi.fn()} onAddMAGroup={vi.fn()} onClose={vi.fn()} />);
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

it('opens an actionable current list, including hidden and timeframe-disabled indicators', async () => {
    const user = userEvent.setup();
    const ma = newInstance('sma'), volume = newInstance('volume'), macd = newInstance('macd');
    volume.hidden = true;
    macd.visibleTf = [5];
    const management = { timeframe: 1, onSettings: vi.fn(), onToggle: vi.fn(), onReorder: vi.fn(), onRemove: vi.fn(), onDuplicate: vi.fn() };
    const callbacks = { onAdd: vi.fn(), onAddMAGroup: vi.fn(), onClose: vi.fn() };
    const view = render(<IndicatorDialog instances={[ma, volume, macd]} management={management} {...callbacks} />);
    expect(screen.getByRole('tab', { name: '已加入（3）' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByText('已隱藏')).toBeDefined();
    expect(screen.getByText('此時框停用')).toBeDefined();
    expect(screen.queryByRole('button', { name: /上移|下移/ })).toBeNull();
    await user.click(screen.getByRole('button', { name: '成交量 顯示' }));
    expect(management.onToggle).toHaveBeenCalledWith(volume.id);
    screen.getByRole('button', { name: '成交量 拖曳排序' }).focus();
    fireEvent.keyDown(document.activeElement!, { key: ' ', repeat: true });
    expect(screen.getByRole('button', { name: '成交量 拖曳排序' }).getAttribute('aria-pressed')).toBe('false');
    await user.keyboard(' {ArrowDown}{Enter}');
    expect(management.onReorder).toHaveBeenCalledWith(volume.id, [macd.id, volume.id]);
    await user.keyboard(' {ArrowDown}{Escape}');
    expect(management.onReorder).toHaveBeenCalledTimes(1);
    expect(callbacks.onClose).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: '成交量 設定' }));
    expect(management.onSettings).toHaveBeenCalledWith(volume.id);
    await user.click(screen.getByRole('button', { name: '成交量 更多操作' }));
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(callbacks.onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: '技術指標' })).toBeDefined();
    await user.click(screen.getByRole('button', { name: '成交量 更多操作' }));
    await user.click(screen.getByRole('menuitem', { name: '移除' }));
    expect(management.onRemove).toHaveBeenCalledWith(volume.id);
    view.rerender(<IndicatorDialog instances={[]} management={management} {...callbacks} />);
    expect(screen.getByText('這張圖還沒有指標')).toBeDefined();
    await user.click(screen.getByRole('button', { name: '新增指標' }));
    expect(screen.getByRole('tab', { name: '新增指標' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('textbox', { name: '搜尋指標' })).toBeDefined();
});

it('lets the keyboard favorite a catalog item without accidentally adding it', async () => {
    const user = userEvent.setup();
    const onAdd = vi.fn();
    render(<IndicatorDialog instances={[]} onAdd={onAdd} onAddMAGroup={vi.fn()} onClose={vi.fn()} />);
    const favorite = screen.getByRole('button', { name: '收藏 RSI 相對強弱' });
    favorite.focus();
    await user.keyboard(' ');
    expect(onAdd).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '取消收藏 RSI 相對強弱' }).getAttribute('aria-pressed')).toBe('true');
    screen.getByRole('button', { name: /^RSI 相對強弱/ }).focus();
    await user.keyboard('{Enter}');
    expect(onAdd).toHaveBeenCalledWith('rsi');
});
