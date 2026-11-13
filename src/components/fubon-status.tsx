import { Button } from '@/components/ui/button';
import { useEffect, useState } from 'react';
import { fetchInfo, type ServerInfo } from '../lib/shioaji';
import { onStreamEvent } from '../lib/stream';
import { refreshTradingStateForModeChange } from '../lib/trading-state';
import { createFubonReconciler } from '../lib/fubon-reconcile';
import { logoutFubonSession } from '../lib/fubon-session';
import * as styles from './fubon-status.css';

export function FubonStatus() {
    const [info, setInfo] = useState<ServerInfo>();
    const [failed, setFailed] = useState(false);
    useEffect(() => {
        let disposed = false;
        let timer: ReturnType<typeof setTimeout>;
        const load = async () => {
            try {
                const next = await fetchInfo();
                if (!disposed) { setInfo(next); setFailed(false); }
            } catch {
                if (!disposed) setFailed(true);
            } finally {
                if (!disposed) timer = setTimeout(load, 5000);
            }
        };
        void load();
        const reconcile = createFubonReconciler(refreshTradingStateForModeChange);
        const stop = onStreamEvent('fubon_reconcile_required', () => {
            reconcile.request();
        });
        return () => { disposed = true; clearTimeout(timer); reconcile.stop(); stop(); };
    }, []);
    const unavailable = failed || !info || info.broker !== 'fubon' || !info.connected;
    const label = unavailable ? (info?.error || '富邦服務尚未連線，請啟動 pnpm start')
        : info.mode === 'demo' ? '展示模式 · 合成行情／本機模擬委託，非市場資料'
        : info.mode === 'paper' ? '模擬模式 · 富邦真實行情／本機模擬委託，不送券商'
        : '正式交易 · 委託會送至富邦';
    return <div className={unavailable || info?.mode === 'live' ? styles.warning : styles.banner} role="status">
        <strong>Fubon Trading</strong>
        <span>{label}</span>
        <span>手動交易 · 自動停損停利尚未支援</span>
        {info?.mode !== 'demo' && info?.connected && <span>{info.session === 'afterhours' ? '夜盤' : '日盤'} · {info.market_connected ? '行情已連線' : '行情等待連線'}</span>}
        <Button size="compact" variant="ghost" type="button" title="鎖定此工作階段，不會取消委託或平倉" onClick={() => { void logoutFubonSession(); }} >鎖定介面</Button>
        <a className={styles.link} href="https://github.com/chenghsj/fubon-trading" target="_blank" rel="noreferrer">專案與設定說明</a>
    </div>;
}
