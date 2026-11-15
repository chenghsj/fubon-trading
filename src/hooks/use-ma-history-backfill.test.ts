// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useMAHistoryBackfill } from './use-ma-history-backfill';
import { requiredMABars } from '../lib/ma-history';
import type { IndicatorInstance } from '../lib/indicator-defs';

afterEach(cleanup);
const idle = () => ({ busy: false, error: false, exhausted: false });
function setup(overrides: Partial<Parameters<typeof useMAHistoryBackfill>[0]> = {}) {
    const load = vi.fn(() => true);
    const props = { contextKey: 'a|1D|0', required: 240, available: 100, loading: false, historyError: false,
        paging: idle(), loadMore: { current: load }, restart: vi.fn(), ...overrides };
    const hook = renderHook(input => useMAHistoryBackfill(input), { initialProps: props });
    return { ...hook, props, load };
}

it('limits automatic pages to six despite live-bar updates and resumes only after an explicit request', () => {
    const { result, rerender, props, load } = setup({ required: 500 });
    for (let page = 1; page <= 6; page++) rerender({ ...props, available: 100 + page, paging: idle() });
    expect(load).toHaveBeenCalledTimes(6);
    expect(result.current.status?.phase).toBe('paused');
    rerender({ ...props, available: 120, paging: idle() });
    expect(load).toHaveBeenCalledTimes(6);
    act(() => result.current.retryBackfill());
    expect(load).toHaveBeenCalledTimes(7);
    rerender({ ...props, available: 500, paging: idle() });
    expect(result.current.status).toBeNull();
});

it('waits for the current page, stops on errors or exhaustion and restarts failed history only on user retry', () => {
    const { result, rerender, props, load } = setup({ paging: { ...idle(), busy: true } });
    expect(load).not.toHaveBeenCalled();
    rerender({ ...props, paging: idle() });
    expect(load).toHaveBeenCalledOnce();
    rerender({ ...props, paging: { ...idle(), error: true } });
    expect(result.current.status?.phase).toBe('error');
    act(() => result.current.retryBackfill());
    expect(props.restart).toHaveBeenCalledOnce();
    expect(load).toHaveBeenCalledOnce();
    rerender({ ...props, paging: { ...idle(), exhausted: true } });
    expect(result.current.status?.phase).toBe('exhausted');
    expect(load).toHaveBeenCalledOnce();
    rerender({ ...props, contextKey: 'b|5m|1', paging: idle() });
    expect(load).toHaveBeenCalledTimes(2);
});

it('does not consume the budget when a concurrent scroll already owns the pager', () => {
    const load = vi.fn(() => false);
    const { result, props, rerender } = setup({ loadMore: { current: load } });
    expect(result.current.status?.phase).toBe('loading');
    load.mockReturnValue(true);
    for (let page = 0; page < 6; page++) rerender({ ...props, paging: idle() });
    expect(load.mock.results.filter(result => result.value === true)).toHaveLength(6);
    // The last page's completion publishes the pager state after its claim.
    rerender({ ...props, paging: idle() });
    expect(result.current.status?.phase).toBe('paused');
});

it('keeps an initial history failure recoverable while live candles continue arriving', () => {
    const { result, props, rerender, load } = setup({ historyError: true, available: 0, loadMore: { current: null } });
    rerender({ ...props, available: 2 });
    expect(result.current.status?.phase).toBe('error');
    expect(load).not.toHaveBeenCalled();
    act(() => result.current.retryBackfill());
    expect(props.restart).toHaveBeenCalledOnce();
});

it('counts only enabled MA lines in the active timeframe and uses definition defaults for missing parameters', () => {
    const line = (id: string, period: number, patch: Partial<IndicatorInstance> = {}): IndicatorInstance => ({ id, type: 'sma', params: { period }, colors: {}, ...patch });
    expect(requiredMABars([
        line('a', 240, { hidden: true }), line('b', 120, { visibleTf: [1] }),
        line('c', 60, { styles: { line: { visible: false } } }), line('d', 30, { type: 'rsi' }),
        line('e', 21, { type: 'ema' }), line('f', 9, { type: 'wma' }),
    ], 5)).toBe(21);
    expect(requiredMABars([line('default', 0, { params: {} })], 5)).toBe(20);
    expect(requiredMABars([], 5)).toBe(0);
});
