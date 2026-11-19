// @vitest-environment jsdom
import { createElement, useState, type ComponentProps } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { initialAutoConfig, type AutoConfig } from '../lib/auto-trading';

const api = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('../lib/api', () => ({ apiGet: api.get }));
vi.mock('./ui/select-control', () => ({
    SelectControl: ({ onValueChange, wrapperClassName: _wrapper, ...props }: Omit<ComponentProps<'select'>, 'onChange'> & {
        onValueChange?: (value: string) => void; wrapperClassName?: string;
    }) => createElement('select', { ...props, onChange: event => onValueChange?.(event.currentTarget.value) }),
    SelectOption: (props: ComponentProps<'option'>) => createElement('option', props),
}));
import { AutoContractField } from './auto-contract-field';

const rows = [
    { code: 'TMFK6', delivery_date: '2026-11-18' },
    { code: 'TMFL6', delivery_date: '2026-12-16' },
    { code: 'TMFA7', delivery_date: '2027-01-20' },
    { code: 'TMFR1', target_code: 'TMFL6', delivery_date: '2026-12-16' },
    { code: 'TMFB7', delivery_date: '' },
].map(row => ({ security_type: 'FUT', multiplier: 10, target_code: null, ...row }));

function Harness({ saved = '', editable = true, day = '2026-11-19', session = 'afterhours' }: {
    saved?: string; editable?: boolean; day?: string; session?: AutoConfig['strategy_session'];
}) {
    const [draft, setDraft] = useState<AutoConfig>(() => ({ ...initialAutoConfig(), contract_code: saved, trade_date: day, strategy_session: session }));
    const [valid, setValid] = useState(false);
    return <><AutoContractField draft={draft} setDraft={setDraft} editable={editable} onValidityChange={setValid} />
        <button onClick={() => setDraft(old => ({ ...old, trade_date: '2026-12-16' }))}>選到期開盤日</button>
        <output aria-label="設定">{JSON.stringify({ code: draft.contract_code, valid })}</output></>;
}
const config = () => JSON.parse(screen.getByLabelText('設定').textContent!);
afterEach(() => { cleanup(); vi.clearAllMocks(); });

it('does not guess a monthly contract from the calendar month', () => {
    expect(initialAutoConfig().contract_code).toBe('');
});
it('defaults a new plan to the nearest eligible listed month after November expiry', async () => {
    api.get.mockResolvedValue(rows);
    render(<Harness />);
    await waitFor(() => expect(config()).toEqual({ code: 'TMFL6', valid: true }));
    expect(screen.getByRole('option', { name: /TMFL6.*2026-12-16 到期/ })).toBeTruthy();
    expect(screen.queryByRole('option', { name: /TMFR1|TMFB7|TMFK6/ })).toBeNull();
});
it('preserves an expired saved plan and requires explicit selection of another month', async () => {
    api.get.mockResolvedValue(rows);
    render(<Harness saved="TMFK6" />);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('2026-11-18 到期'));
    expect(config()).toEqual({ code: 'TMFK6', valid: false });
    fireEvent.change(screen.getByLabelText('微台具體合約'), { target: { value: 'TMFL6' } });
    await waitFor(() => expect(config()).toEqual({ code: 'TMFL6', valid: true }));
    expect(screen.queryByRole('alert')).toBeNull();
});
it('invalidates the selected month when the opening date changes without silently rolling it', async () => {
    api.get.mockResolvedValue(rows);
    render(<Harness saved="TMFL6" />);
    await waitFor(() => expect(config().valid).toBe(true));
    fireEvent.click(screen.getByText('選到期開盤日'));
    await waitFor(() => expect(config()).toEqual({ code: 'TMFL6', valid: false }));
    expect(screen.getByRole('alert').textContent).toContain('2026-12-16 到期');
});
it('keeps the legacy cash expiry-day rule while full sessions require a later expiry', async () => {
    api.get.mockResolvedValue(rows);
    render(<Harness day="2026-11-18" session="cash" />);
    await waitFor(() => expect(config()).toEqual({ code: 'TMFK6', valid: true }));
});
it('does not change locked plans, including an empty saved contract', async () => {
    api.get.mockResolvedValue(rows);
    render(<Harness editable={false} />);
    await waitFor(() => expect(screen.getByRole('option', { name: /TMFL6/ })).toBeTruthy());
    expect(config()).toEqual({ code: '', valid: false });
    expect((screen.getByLabelText('微台具體合約') as HTMLSelectElement).disabled).toBe(true);
});
it('keeps startup blocked on API failure and allows a read-only retry', async () => {
    api.get.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(rows);
    render(<Harness />);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('offline'));
    expect(config()).toEqual({ code: '', valid: false });
    fireEvent.click(screen.getByText('重試合約清單'));
    await waitFor(() => expect(config()).toEqual({ code: 'TMFL6', valid: true }));
});
it('does not invent a contract when no listed month covers the selected opening date', async () => {
    api.get.mockResolvedValue(rows);
    render(<Harness day="2027-02-01" />);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('目前沒有適用'));
    expect(config()).toEqual({ code: '', valid: false });
});
