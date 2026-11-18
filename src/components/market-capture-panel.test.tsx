// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('../lib/api', () => ({ apiGet: api.get }));
vi.mock('../lib/fubon-api-detail', () => ({ fubonPost: api.post }));
import { MarketCapturePanel, type CaptureStatus } from './market-capture-panel';

afterEach(() => { cleanup(); vi.resetAllMocks(); });
const status = (enabled = false): CaptureStatus => ({ enabled, available: true, state: enabled ? 'waiting_data' : 'stopped', error: null,
    counts: { frames: 120, tradePrints: 50, books: 70 }, queueDepth: 0, pendingDroppedPackets: 0, lastCommitUs: null, databaseBytes: 1024,
    window: null, acknowledgedChannels: [], last: {} });

it('enables only market recording and never calls automation or trading routes', async () => {
    api.get.mockResolvedValue(status()); api.post.mockResolvedValue(status(true));
    render(<MarketCapturePanel />);
    const start = await screen.findByRole('button', { name: '啟用行情收集（不下單）' });
    await waitFor(() => expect((start as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(start);
    await waitFor(() => expect(api.post).toHaveBeenCalledExactlyOnceWith('/api/v1/research/capture/start', {}));
    expect(screen.getByRole('status').textContent).toContain('等待兩頻道確認與新資料');
    expect(screen.getByText(/正式新成交：50/)).toBeTruthy();
});

it('shows actual loss instead of calling incomplete capture complete', async () => {
    api.get.mockResolvedValue({ ...status(true), counts: { frames: 4, droppedPackets: 7 }, pendingDroppedPackets: 7 });
    render(<MarketCapturePanel />);
    expect(await screen.findByText(/曾有收集遺失/)).toBeTruthy();
    expect(screen.getByText(/已記錄丟失 7 則/)).toBeTruthy();
});
