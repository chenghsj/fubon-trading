import { Button } from './ui/button';
import { AsyncStatus } from './async-status';
import type { MAHistoryStatus } from '../lib/ma-history';
import * as styles from './indicator-dialog.css';

export function MAHistoryNotice({ status, onRetry }: { status: MAHistoryStatus | null; onRetry: () => void }) {
    if (!status) return null;
    const { phase, required, available } = status;
    const reason = phase === 'loading' ? '正在補取歷史…' : phase === 'error' ? '歷史查詢失敗' : phase === 'exhausted' ? '可取得的歷史不足，暫無法計算長週期均線' : '本輪補取已暫停，可繼續補取';
    return <div className={styles.maHistoryNotice}>
        <AsyncStatus phase={phase === 'loading' ? 'loading' : phase === 'error' ? 'error' : 'empty'}
            text={`均線需要 ${required} 根 K 棒，目前 ${available} 根；${reason}`} />
        {phase !== 'loading' && <Button size="compact" variant="outline" onClick={onRetry}>{phase === 'paused' ? '繼續補取' : '重新補取'}</Button>}
    </div>;
}
