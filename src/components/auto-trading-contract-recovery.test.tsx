// @vitest-environment jsdom
import { createElement, type ComponentProps } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { initialAutoConfig } from '../lib/auto-trading';

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('../lib/api', () => ({ apiGet: api.get }));
vi.mock('../lib/fubon-api-detail', () => ({ fubonPost: api.post }));
vi.mock('../lib/risk', () => ({ useRiskSettings: () => ({ locked: false }), getRiskSettings: () => ({ locked: false }), checkOrderAllowed: () => null }));
vi.mock('../lib/contract-fee', () => ({ useContractFee: () => null, getContractFee: () => null }));
vi.mock('./auto-model-field', () => ({ AutoModelField: () => null }));
vi.mock('./paper-ledger', () => ({ PaperLedger: () => null }));
vi.mock('./contract-fee-note', () => ({ ContractFeeNote: () => null }));
vi.mock('./ui/select-control', () => ({
    SelectControl: ({ onValueChange, wrapperClassName: _wrapper, ...props }: Omit<ComponentProps<'select'>, 'onChange'> & {
        onValueChange?: (value: string) => void; wrapperClassName?: string;
    }) => createElement('select', { ...props, onChange: event => onValueChange?.(event.currentTarget.value) }),
    SelectOption: (props: ComponentProps<'option'>) => createElement('option', props),
}));
import { AutoTradingPanel } from './auto-trading-panel';

afterEach(() => { cleanup(); vi.clearAllMocks(); });
it('allows read-only catalog retry and resume for a paused plan whose execution settings are locked', async () => {
    const account = { account_type: 'F' as const, broker_id: 'LOCAL', account_id: 'PAPER-AUTO-F' };
    const config = { ...initialAutoConfig(), account, contract_code: 'TMFL6', trade_date: '2026-11-19', strategy_session: 'afterhours' as const };
    let reads = 0;
    api.get.mockImplementation(async (url: string) => {
        if (url.includes('/data/contracts/futures')) {
            if (!reads++) throw new Error('transient offline');
            return [{ code: 'TMFL6', delivery_date: '2026-12-16', security_type: 'FUT', multiplier: 10, target_code: null }];
        }
        if (url.endsWith('/auth/accounts')) return [account];
        if (url.endsWith('/automation/state')) return {
            id: 'paused-plan', status: 'paused', reason: '新倉已暫停', config, mode: 'paper', available: true,
            owned: false, monitoring: true, leaseSeconds: 0, entryCount: 1, pending: null, position: null,
            realizedNet: 0, unrealizedNet: 0, quote: null, lastSignal: null, orders: [], events: [],
        };
        throw new Error(`Unexpected read: ${url}`);
    });
    render(<AutoTradingPanel />);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('transient offline'));
    const resume = screen.getByRole('button', { name: '啟動／恢復 paper 策略' }) as HTMLButtonElement;
    expect(resume.disabled).toBe(true);
    const retry = screen.getByRole('button', { name: '重試合約清單' });
    expect(retry.matches(':disabled')).toBe(false);
    fireEvent.click(retry);
    await waitFor(() => expect(resume.disabled).toBe(false));
    expect((screen.getByLabelText('微台具體合約') as HTMLSelectElement).disabled).toBe(true);
    expect((screen.getByLabelText('微台具體合約') as HTMLSelectElement).value).toBe('TMFL6');
    expect(api.post).not.toHaveBeenCalled();
});
