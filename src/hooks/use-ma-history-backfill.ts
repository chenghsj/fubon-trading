import { useEffect, useRef, useState, type RefObject } from 'react';
import { MAX_MA_BACKFILL_PAGES, type HistoryPaging, type MAHistoryStatus } from '../lib/ma-history';

export function useMAHistoryBackfill({ contextKey, required, available, loading, historyError, paging, loadMore, restart }: {
    contextKey: string; required: number; available: number; loading: boolean; historyError: boolean;
    paging: HistoryPaging; loadMore: RefObject<(() => boolean) | null>; restart: () => void;
}) {
    const budget = useRef({ key: '', count: 0 });
    const [retry, setRetry] = useState(0);
    const key = `${contextKey}|${required}|${retry}`;
    const attempts = budget.current.key === key ? budget.current.count : 0;
    useEffect(() => {
        if (required <= available || loading || historyError || paging.busy || paging.error || paging.exhausted) return;
        if (budget.current.key !== key) budget.current = { key, count: 0 };
        if (budget.current.count < MAX_MA_BACKFILL_PAGES && loadMore.current?.()) budget.current.count += 1;
    }, [key, required, available, loading, historyError, paging, loadMore]);

    const status: MAHistoryStatus | null = required > available ? {
        required, available,
        phase: loading || paging.busy ? 'loading' : historyError || paging.error ? 'error' : paging.exhausted ? 'exhausted' : attempts >= MAX_MA_BACKFILL_PAGES ? 'paused' : 'loading',
    } : null;
    const retryBackfill = () => {
        if (historyError || paging.error || paging.exhausted) restart();
        else setRetry(value => value + 1);
    };
    return { status, retryBackfill };
}
