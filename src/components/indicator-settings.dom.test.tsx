// @vitest-environment jsdom
import { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { IndicatorSettingsModal } from './indicator-dialog';
import { newInstance, type IndicatorInstance } from '../lib/indicator-defs';

const timeframes = [1, 3, 5, 15, 60, 1440, 10080, 43200].map(minutes => ({ label: minutes === 1440 ? '1D' : minutes === 10080 ? '1W' : minutes === 43200 ? '1M' : `${minutes}m`, minutes }));

function settings(initial = newInstance('sma'), options: { isNew?: boolean; currentTimeframe?: number } = {}) {
    const onPatch = vi.fn(), onCommit = vi.fn(), onCancel = vi.fn(), onRemove = vi.fn();
    function Harness({ currentTimeframe = options.currentTimeframe }: { currentTimeframe?: number }) {
        const [inst, setInst] = useState(initial);
        return <IndicatorSettingsModal inst={inst} timeframes={timeframes} isNew={options.isNew} currentTimeframe={currentTimeframe}
            onPatch={patch => { onPatch(patch); setInst(current => ({ ...current, ...patch })); }}
            onCommit={onCommit} onCancel={onCancel} onRemove={onRemove} />;
    }
    const view = render(<Harness />);
    return { ...view, Harness, onPatch, onCommit, onCancel, onRemove };
}

beforeEach(() => {
    localStorage.clear();
    vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Indicator settings must not access the network'); }));
});
afterEach(() => { cleanup(); expect(fetch).not.toHaveBeenCalled(); vi.unstubAllGlobals(); });

it('explains MA root count using the current chart interval and updates the accessible description', () => {
    const view = settings(newInstance('sma'), { currentTimeframe: 3 });
    const period = screen.getByRole('spinbutton', { name: '計算期間（K 棒根數）' });
    const description = () => document.getElementById(period.getAttribute('aria-describedby')!)!.textContent;
    expect(description()).toContain('MA20：以最近 20 根 K 棒的收盤價計算平均');
    expect(description()).toMatch(/目前圖表是 3 分 K，使用 20 根\s*3 分 K\s*計算/);
    fireEvent.change(period, { target: { value: '60' } });
    expect(view.onPatch).toHaveBeenCalledExactlyOnceWith({ params: { period: 60 } });
    expect(description()).toContain('MA60');
    expect(description()).toContain('切換圖表週期時，根數維持 60 根');
    view.rerender(<view.Harness currentTimeframe={1440} />);
    expect(description()).toMatch(/目前圖表是 日 K，使用 60 根\s*日 K\s*計算/);
    expect((period as HTMLInputElement).value).toBe('60');
    expect(view.onPatch).toHaveBeenCalledTimes(1);
});

it.each([[10080, '週 K'], [43200, '月 K']] as const)('explains MA calculations and visibility on the %s calendar interval', async (minutes, label) => {
    const user = userEvent.setup();
    const view = settings(newInstance('sma'), { currentTimeframe: minutes });
    const period = screen.getByRole('spinbutton', { name: '計算期間（K 棒根數）' });
    const description = document.getElementById(period.getAttribute('aria-describedby')!)!.textContent;
    expect(description).toContain(`目前圖表是 ${label}，使用 20 根 ${label} 計算`);
    await user.click(screen.getByRole('tab', { name: '顯示週期' }));
    expect(screen.getByRole('checkbox', { name: `${label}（目前圖表）` })).toBeDefined();
    await user.click(screen.getByRole('button', { name: '只勾選目前週期' }));
    expect(view.onPatch).toHaveBeenLastCalledWith({ visibleTf: [minutes] });
});

it('limits visibility edits to visibleTf, warns when all intervals are hidden and restores all', async () => {
    const user = userEvent.setup();
    const view = settings(newInstance('sma'), { currentTimeframe: 3 });
    await user.click(screen.getByRole('tab', { name: '顯示週期' }));
    expect(screen.getByText('這裡只控制顯示；計算參數不會改變。未勾選的圖表週期會隱藏此指標。')).toBeDefined();
    const current = screen.getByRole('checkbox', { name: '3 分 K（目前圖表）' });
    await user.click(current);
    expect(view.onPatch).toHaveBeenLastCalledWith({ visibleTf: [1, 5, 15, 60, 1440, 10080, 43200] });
    for (const checkbox of screen.getAllByRole('checkbox')) if (checkbox.getAttribute('aria-checked') === 'true') await user.click(checkbox);
    expect(view.onPatch).toHaveBeenLastCalledWith({ visibleTf: [] });
    expect(screen.getByRole('status').textContent).toContain('所有圖表週期隱藏');
    for (const checkbox of screen.getAllByRole('checkbox')) await user.click(checkbox);
    expect(view.onPatch).toHaveBeenLastCalledWith({ visibleTf: undefined });
    expect(screen.queryByRole('status')).toBeNull();
    expect(view.onPatch.mock.calls.every(call => Object.keys(call[0] as Partial<IndicatorInstance>).join() === 'visibleTf')).toBe(true);
    await user.click(screen.getByRole('tab', { name: '計算參數' }));
    expect((screen.getByRole('spinbutton') as HTMLInputElement).value).toBe('20');
    expect(view.onCommit).not.toHaveBeenCalled();
});

it('distinguishes a new preview from editing and has no removal action until added', async () => {
    const user = userEvent.setup();
    const view = settings(newInstance('sma'), { isNew: true, currentTimeframe: 5 });
    expect(screen.getByText('新增 MA 移動平均')).toBeDefined();
    expect(screen.getByText('目前僅預覽；按「加入圖表」才會保留。')).toBeDefined();
    expect(screen.queryByRole('button', { name: '從圖表移除' })).toBeNull();
    expect(screen.queryByRole('button', { name: '儲存修改' })).toBeNull();
    await user.click(screen.getByRole('button', { name: '加入圖表' }));
    expect(view.onCommit).toHaveBeenCalledOnce();
    expect(view.onRemove).not.toHaveBeenCalled();
});

it('uses visibility shortcuts without changing calculation parameters and disables the active scope', async () => {
    const user = userEvent.setup();
    const view = settings(newInstance('sma'), { currentTimeframe: 3 });
    await user.click(screen.getByRole('tab', { name: '顯示週期' }));
    const all = screen.getByRole('button', { name: '全部勾選' });
    const current = screen.getByRole('button', { name: '只勾選目前週期' });
    expect(all.hasAttribute('disabled')).toBe(true);
    expect(current.hasAttribute('disabled')).toBe(false);
    await user.click(current);
    expect(view.onPatch).toHaveBeenCalledExactlyOnceWith({ visibleTf: [3] });
    expect(current.hasAttribute('disabled')).toBe(true);
    expect(screen.getAllByRole('checkbox').filter(box => box.getAttribute('aria-checked') === 'true')).toEqual([screen.getByRole('checkbox', { name: '3 分 K（目前圖表）' })]);
    await user.click(all);
    expect(view.onPatch).toHaveBeenLastCalledWith({ visibleTf: undefined });
    expect(all.hasAttribute('disabled')).toBe(true);
    await user.click(screen.getByRole('tab', { name: '計算參數' }));
    expect((screen.getByRole('spinbutton') as HTMLInputElement).value).toBe('20');
    expect(view.onCommit).not.toHaveBeenCalled();
});

it.each([undefined, 2])('does not offer a current-only shortcut for unavailable interval %s', async currentTimeframe => {
    const user = userEvent.setup();
    settings(newInstance('sma'), { currentTimeframe });
    await user.click(screen.getByRole('tab', { name: '顯示週期' }));
    expect(screen.queryByRole('button', { name: '只勾選目前週期' })).toBeNull();
});

it('keeps omitted isNew compatible with edit/save/remove actions', async () => {
    const user = userEvent.setup();
    const view = settings();
    expect(screen.getByText('編輯 MA 移動平均')).toBeDefined();
    expect(screen.getByText('圖表即時預覽；取消會放棄這次圖表修改。')).toBeDefined();
    expect(screen.queryByRole('button', { name: '加入圖表' })).toBeNull();
    await user.click(screen.getByRole('button', { name: '儲存修改' }));
    expect(view.onCommit).toHaveBeenCalledOnce();
    await user.click(screen.getByRole('button', { name: '從圖表移除' }));
    expect(view.onRemove).toHaveBeenCalledOnce();
});

it.each(['取消', '取消指標設定', 'Escape'])('routes %s to cancel instead of retaining a new preview', async label => {
    const user = userEvent.setup();
    const view = settings(newInstance('sma'), { isNew: true });
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '30' } });
    if (label === 'Escape') await user.keyboard('{Escape}');
    else await user.click(screen.getByRole('button', { name: label }));
    expect(view.onCancel).toHaveBeenCalledOnce();
    expect(view.onCommit).not.toHaveBeenCalled();
    expect(view.onRemove).not.toHaveBeenCalled();
});

it('supports keyboard navigation between the calculation, appearance and visibility tabs without changing values', async () => {
    const user = userEvent.setup();
    const view = settings();
    screen.getByRole('tab', { name: '計算參數' }).focus();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: '外觀' }).getAttribute('aria-selected')).toBe('true');
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: '顯示週期' }).getAttribute('aria-selected')).toBe('true');
    expect(view.onPatch).not.toHaveBeenCalled();
    expect(view.onCommit).not.toHaveBeenCalled();
});

it('keeps parameterless volume settings on appearance without misleading MA calculation guidance', () => {
    settings(newInstance('volume'), { currentTimeframe: 3 });
    expect(screen.queryByRole('tab', { name: '計算參數' })).toBeNull();
    expect(screen.getByRole('tab', { name: '外觀' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.queryByText(/根 K 棒的收盤價計算平均/)).toBeNull();
});
