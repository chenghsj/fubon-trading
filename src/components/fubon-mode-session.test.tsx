// @vitest-environment jsdom
import { createElement, type ComponentProps } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Settings = {
    mode: 'demo' | 'paper' | 'sandbox' | 'live'; live_enabled: boolean;
    session?: 'regular' | 'afterhours'; instance_id: string; available: boolean;
    saved: boolean; sandbox_configured: boolean;
};
const fixture = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), restart: vi.fn(), settings: {} as Settings }));
vi.mock('../lib/api', () => ({ apiGet: fixture.get }));
vi.mock('../lib/fubon-api-detail', () => ({
    fubonPost: fixture.post,
    FubonApiError: class FubonApiError extends Error {
        constructor(message: string, readonly status?: number) { super(message); }
    },
}));
vi.mock('../lib/fubon-restart', () => ({ waitForFubonRestart: fixture.restart }));
// The real form/dialog runs in jsdom; native select isolates its value contract from Radix layout.
vi.mock('./ui/select-control', () => ({
    SelectControl: ({ onValueChange, wrapperClassName: _wrapper, ...props }: Omit<ComponentProps<'select'>, 'onChange'> & {
        onValueChange?: (value: string) => void; wrapperClassName?: string;
    }) => createElement('select', { ...props, onChange: event => onValueChange?.(event.currentTarget.value) }),
    SelectOption: (props: ComponentProps<'option'>) => createElement('option', props),
}));

import { FubonModeSettings } from './fubon-mode-settings';
import { FubonApiError } from '../lib/fubon-api-detail';

beforeEach(() => {
    fixture.get.mockReset(); fixture.post.mockReset(); fixture.restart.mockReset();
    fixture.settings = { mode: 'paper', live_enabled: false, session: 'regular', instance_id: 'offline-instance', available: true, saved: false, sandbox_configured: true };
    fixture.get.mockImplementation(async () => fixture.settings);
    fixture.post.mockResolvedValue({ restarting: false });
    fixture.restart.mockResolvedValue(undefined);
});
afterEach(cleanup);

async function open() {
    render(<FubonModeSettings />);
    fireEvent.click(screen.getByRole('button', { name: '交易模式設定' }));
    await screen.findByLabelText('交易模式');
}
const sessionInput = () => screen.getByLabelText('期權行情與委託盤別') as HTMLSelectElement;
const apply = (live = false) => screen.getByRole('button', { name: live ? '確認並啟用正式下單' : '套用並重新連線' }) as HTMLButtonElement;

describe('day/night session settings form', () => {
    it('changes the active Paper session without selecting a different mode or enabling live orders', async () => {
        await open();
        expect(sessionInput().value).toBe('regular');
        expect(apply().disabled).toBe(true);
        fireEvent.change(sessionInput(), { target: { value: 'afterhours' } });
        expect(apply().disabled).toBe(false);
        expect(screen.queryByRole('switch')).toBeNull();
        fireEvent.click(apply());
        await waitFor(() => expect(fixture.post).toHaveBeenCalledWith('/api/v1/settings/mode', {
            mode: 'paper', live_enabled: false, session: 'afterhours', instance_id: 'offline-instance', acknowledgement: '確認切換交易環境',
        }, 30_000));
        expect(fixture.restart).not.toHaveBeenCalled();
    });

    it('shows the active night session, keeps an unchanged selection disabled, and permits returning to day', async () => {
        fixture.settings.session = 'afterhours';
        await open();
        expect(sessionInput().value).toBe('afterhours');
        expect(apply().disabled).toBe(true);
        fireEvent.change(sessionInput(), { target: { value: 'regular' } });
        expect(apply().disabled).toBe(false);
        fireEvent.change(sessionInput(), { target: { value: 'afterhours' } });
        expect(apply().disabled).toBe(true);
        expect(fixture.post).not.toHaveBeenCalled();
    });

    it('keeps an older server without a session field compatible and omits unknown session from its POST', async () => {
        delete fixture.settings.session;
        await open();
        expect(screen.queryByLabelText('期權行情與委託盤別')).toBeNull();
        fireEvent.change(screen.getByLabelText('交易模式'), { target: { value: 'demo' } });
        fireEvent.click(apply());
        await waitFor(() => expect(fixture.post).toHaveBeenCalledTimes(1));
        expect(fixture.post).toHaveBeenCalledWith('/api/v1/settings/mode', {
            mode: 'demo', live_enabled: false, instance_id: 'offline-instance', acknowledgement: '確認切換交易環境',
        }, 30_000);
    });

    it('requires fresh live permission and exact acknowledgement even for a session-only change in live mode', async () => {
        fixture.settings.mode = 'live'; fixture.settings.live_enabled = true;
        await open();
        fireEvent.change(sessionInput(), { target: { value: 'afterhours' } });
        const consent = screen.getByRole('switch', { name: '允許正式下單' });
        expect(consent.getAttribute('aria-checked')).toBe('false');
        expect(apply(true).disabled).toBe(true);
        fireEvent.click(consent);
        expect(apply(true).disabled).toBe(true);
        fireEvent.change(screen.getByLabelText('輸入「確認啟用正式下單」'), { target: { value: '確認切換交易環境' } });
        expect(apply(true).disabled).toBe(true);
        fireEvent.change(screen.getByLabelText('輸入「確認啟用正式下單」'), { target: { value: '確認啟用正式下單' } });
        expect(apply(true).disabled).toBe(false);
        fireEvent.click(apply(true));
        await waitFor(() => expect(fixture.post).toHaveBeenCalledWith('/api/v1/settings/mode', {
            mode: 'live', live_enabled: true, session: 'afterhours', instance_id: 'offline-instance', acknowledgement: '確認啟用正式下單',
        }, 30_000));
    });

    it('disables both selectors during a real restart response and waits on the old instance ID', async () => {
        fixture.post.mockResolvedValueOnce({ restarting: true });
        await open();
        fireEvent.change(sessionInput(), { target: { value: 'afterhours' } });
        fireEvent.click(apply());
        await waitFor(() => expect(fixture.restart).toHaveBeenCalledWith('offline-instance'));
        expect(sessionInput().disabled).toBe(true);
        expect((screen.getByLabelText('交易模式') as HTMLSelectElement).disabled).toBe(true);
        expect((screen.getByRole('button', { name: '正在重新連線…' }) as HTMLButtonElement).disabled).toBe(true);
    });

    it('shows idle rejection without treating the new session as already saved', async () => {
        fixture.post.mockRejectedValueOnce(new FubonApiError('請先停止策略並處理未確認委託', 400));
        await open();
        fireEvent.change(sessionInput(), { target: { value: 'afterhours' } });
        fireEvent.click(apply());
        await screen.findByText('請先停止策略並處理未確認委託');
        expect(sessionInput().disabled).toBe(false);
        expect(apply().disabled).toBe(false);
        expect(fixture.restart).not.toHaveBeenCalled();
        expect(fixture.settings.session).toBe('regular');
    });
});
