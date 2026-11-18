import { useEffect, useState } from 'react';
import { apiGet } from '../lib/api';
import { fubonPost } from '../lib/fubon-api-detail';
import { Button } from './ui/button';
import * as s from './intraday-research.css';

export type CaptureStatus = {
    enabled: boolean; available: boolean; state: string; error: string | null;
    counts: Record<string, number>; queueDepth: number; pendingDroppedPackets: number;
    lastCommitUs: number | null; databaseBytes: number;
    window: { symbol: string; month: string; session: string; openingDay: string } | null;
    acknowledgedChannels: string[];
    research?: { state: string; message: string; running: boolean; error: string | null; updatedUs?: number; sessions?: Record<string, { usableDays: number; fitDays: number }> };
    last: Record<string, { receivedUs: number; eventUs: number | null; valid: boolean; trial: boolean }>;
};
const states: Record<string, string> = { stopped: '已停止收集', error: '保存中斷', waiting_connection: '等待解鎖或行情連線', market_closed: '等待開盤', collecting: '正在保存行情', waiting_data: '等待兩頻道確認與新資料' };
const when = (us?: number | null) => us ? new Date(us / 1000).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false }) : '尚無';

export function MarketCapturePanel() {
    const [status, setStatus] = useState<CaptureStatus | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false);
    useEffect(() => {
        let disposed = false, timer: ReturnType<typeof setTimeout>;
        const poll = async () => {
            try {
                const next = await apiGet<CaptureStatus>('/api/v1/research/capture');
                if (!disposed) { setStatus(next); setError(''); }
            } catch (e) { if (!disposed) setError(e instanceof Error ? e.message : String(e)); }
            if (!disposed) timer = setTimeout(() => void poll(), 3000);
        };
        void poll();
        return () => { disposed = true; clearTimeout(timer); };
    }, []);
    const control = async (action: 'start' | 'stop') => {
        setBusy(true); setError('');
        try { setStatus(await fubonPost<CaptureStatus>(`/api/v1/research/capture/${action}`, {})); }
        catch (e) { setError(e instanceof Error ? e.message : String(e)); }
        finally { setBusy(false); }
    };
    const counts = status?.counts ?? {};
    return <section aria-label="逐筆與五檔行情收集">
        <h3 className={s.subhead}>逐筆成交與五檔 · 本機保存</h3>
        <p className={s.notice} role="status">{status ? states[status.state] ?? status.state : '讀取收集狀態…'}{status?.window && ` · ${status.window.symbol}／${status.window.month} · ${status.window.session === 'afterhours' ? '夜盤' : '日盤'} · 開盤日 ${status.window.openingDay}`}</p>
        <p className={s.muted}>只記錄富邦真實行情，不下單、不啟動或替換 Paper 策略。啟用後，鎖定介面或關閉面板仍收集；服務重啟會保留設定，須再解鎖一次才能恢復行情連線。</p>
        <div className={s.grid}>
            <p>已保存訊息：{(counts.frames ?? 0).toLocaleString()}<br />正式新成交：{(counts.tradePrints ?? 0).toLocaleString()}<br />五檔訊息：{(counts.books ?? 0).toLocaleString()}</p>
            <p>無效訊息：{(counts.invalidFrames ?? 0).toLocaleString()}<br />重複成交訊息：{(counts.duplicateFrames ?? 0).toLocaleString()}<br />試撮訊息：{(counts.trialFrames ?? 0).toLocaleString()}</p>
        </div>
        <p className={s.muted}>最近成交：{when(status?.last?.trades?.eventUs)}<br />最近五檔：{when(status?.last?.books?.eventUs)}<br />最近保存：{when(status?.lastCommitUs)} · 待寫入 {status?.queueDepth ?? 0} · 本機資料 {((status?.databaseBytes ?? 0) / 1048576).toFixed(1)} MiB</p>
        {!!((counts.droppedPackets ?? 0) || status?.pendingDroppedPackets || (counts.lostControlEvents ?? 0)) && <p className={s.error}>曾有收集遺失，相關時段不視為完整。已記錄丟失 {Math.max(counts.droppedPackets ?? 0, status?.pendingDroppedPackets ?? 0)} 則。</p>}
        <p className={s.muted}>保存來源微秒時間、接收時間、實際月份、日夜盤與原生行情欄位；中斷與重新訂閱另留紀錄。五檔有資料不代表整段可成交，研究仍檢查價差、深度、陳舊與缺段。磁碟剩餘不足 512 MiB 時停止保存並保留缺口。</p>
        <div className={s.actions}>
            <Button size="compact" disabled={busy || !status?.available || status.enabled} onClick={() => void control('start')}>啟用行情收集（不下單）</Button>
            <Button size="compact" variant="outline" disabled={busy || !status?.enabled} onClick={() => void control('stop')}>停止行情收集</Button>
        </div>
        {status && !status.available && <p className={s.muted}>收集需使用 Paper 模式與自動行情盤別。</p>}
        {(error || status?.error) && <p className={s.error} role="alert">{error || status?.error}</p>}
        {status?.research && <p className={s.notice}>秒級研究：{status.research.running ? '離線檢查／回測中' : status.research.message}<br />{Object.entries(status.research.sessions ?? {}).map(([key, value]) => `${key === 'regular' ? '日盤' : '夜盤'} ${value.usableDays} 個可用開盤日／fit ${value.fitDays} 日`).join('；')}<br />{status.research.error || '每小時檢查一次；每日18:00後更新官方分鐘資料。通過歷史數值門檻也不會自動開啟Paper。'}</p>}
    </section>;
}
