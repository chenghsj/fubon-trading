import { afterEach, expect, it, vi } from 'vitest';
import { createFubonReconciler } from './fubon-reconcile';

afterEach(() => vi.useRealTimers());

it('coalesces a report burst into one read and never polls', async () => {
    vi.useFakeTimers();
    const refresh = vi.fn(async () => {});
    const reconcile = createFubonReconciler(refresh);
    reconcile.request(); reconcile.request(); reconcile.request();
    await vi.advanceTimersByTimeAsync(300);
    expect(refresh).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(refresh).toHaveBeenCalledTimes(1);
    reconcile.stop();
});

it('repeats a snapshot if a newer report arrives during its read', async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    const refresh = vi.fn().mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; })).mockResolvedValue(undefined);
    const reconcile = createFubonReconciler(refresh);
    reconcile.request();
    await vi.advanceTimersByTimeAsync(300);
    reconcile.request();
    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(refresh).toHaveBeenCalledTimes(2);
    reconcile.stop();
});

it('does not start a queued read after the component unmounts', async () => {
    vi.useFakeTimers();
    const refresh = vi.fn(async () => {});
    const reconcile = createFubonReconciler(refresh);
    reconcile.request(); reconcile.stop();
    await vi.advanceTimersByTimeAsync(1000);
    expect(refresh).not.toHaveBeenCalled();
});
