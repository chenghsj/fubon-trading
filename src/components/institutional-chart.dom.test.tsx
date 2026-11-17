// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { InstitutionalChart } from './institutional-chart';
import type { NativeResult } from '../lib/native-panels';

beforeEach(() => {
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
    Element.prototype.scrollIntoView = vi.fn();
    Element.prototype.hasPointerCapture = () => false;
    Element.prototype.setPointerCapture = vi.fn();
    Element.prototype.releasePointerCapture = vi.fn();
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('共用控制項實際切換法人、累計、股數與日期，並以鍵盤操作選單', async () => {
    const data: NativeResult = { operation: 'institutional', source: 'fubon', fetched_at: '2026-11-17',
        columns: [], detail_keys: [], summary: {}, metadata: { symbol: '2330' }, note: '', rows: [
            { date: '2026-11-10', 'foreign.net': 1500, total: 1400 },
            { date: '2026-11-11', 'foreign.net': -1000, total: -500 },
        ] };
    const user = userEvent.setup();
    render(<InstitutionalChart data={data}/>);
    await user.click(screen.getByRole('radio', { name: /外資及陸資/ }));
    expect(screen.getByRole('status').textContent).toContain('-1 張');
    await user.click(screen.getByRole('radio', { name: '區間累計走勢' }));
    expect(screen.getByRole('status').textContent).toContain('+0.5 張');
    await user.click(screen.getByRole('combobox', { name: '顯示單位' }));
    await user.keyboard('{End}{Enter}');
    expect(screen.getByRole('status').textContent).toContain('+500 股');
    await user.click(screen.getByRole('combobox', { name: '查看日期' }));
    await user.click(screen.getByRole('option', { name: '2026-11-10' }));
    expect(screen.getByRole('status').textContent).toContain('+1,500 股');
    await user.click(screen.getByText('每日買賣明細（股）'));
    expect(within(screen.getByRole('table')).getByRole('columnheader', { name: '外資買賣超（股）' })).toBeTruthy();
    expect(within(screen.getByRole('table')).getByText('+1,500')).toBeTruthy();
    // A single-choice group cannot clear the active institution.
    await user.click(screen.getByRole('radio', { name: /外資及陸資/ }));
    expect(screen.getByRole('status').textContent).toContain('+1,500 股');
});
