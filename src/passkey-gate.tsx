import { useEffect, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ShieldCheck } from 'lucide-react';
import { canEnrollPasskey, sessionRequest } from './lib/fubon-session';
import { passkeysSupported, unlockWithPasskey } from './lib/passkeys';
import { initTheme } from './lib/theme-store';
import { Button } from './components/ui/button';
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from './components/ui/card';
import { Alert, AlertDescription } from './components/ui/alert';
import { Separator } from './components/ui/separator';
import * as styles from './passkey-gate.css';
import './index.css';

function PasskeyGate({ onUnlocked }: { onUnlocked: () => Promise<void> }) {
    const local = location.hostname === 'localhost';
    const [enrolled, setEnrolled] = useState(false);
    const [loading, setLoading] = useState(local);
    const [connected, setConnected] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const supported = passkeysSupported();
    useEffect(() => {
        if (!local) return;
        let cancelled = false;
        void sessionRequest('/api/v1/passkeys/status').then(result => {
            if (!cancelled) { setEnrolled(result.enrolled === true); setConnected(true); }
        }).catch(() => { if (!cancelled) setConnected(false); })
            .finally(() => { if (!cancelled) setLoading(false); });
        return () => { cancelled = true; };
    }, [local]);
    const unlock = async () => {
        if (busy) return;
        setBusy(true); setError('');
        try { await unlockWithPasskey(!enrolled); await onUnlocked(); }
        catch (cause) {
            // Enrollment may have succeeded before the subsequent login failed.
            try { setEnrolled((await sessionRequest('/api/v1/passkeys/status')).enrolled === true); } catch { /* Keep the last known state. */ }
            setError(cause instanceof Error ? cause.message : '驗證未完成，請重試。');
            setBusy(false);
        }
    };
    const title = !local ? '請使用本機解鎖網址' : loading ? '正在確認解鎖狀態'
        : !connected ? '尚未連上本機服務' : enrolled ? '使用 Passkey 解鎖' : '建立你的 Passkey';
    const description = !local ? 'Passkey 綁定 localhost，請從啟動視窗進入。'
        : loading ? '正在連線至本機交易服務。'
        : !connected ? '請執行 pnpm start，然後重新整理此頁面。'
        : enrolled ? '使用 Touch ID、裝置解鎖或安全金鑰驗證身分，進入交易介面。'
        : '先為本機介面建立 Passkey，之後可用 Touch ID 或安全金鑰解鎖。';
    const problem = error || (connected && !supported ? '此瀏覽器不支援 Passkey，請使用新版 Chrome、Safari 或 Edge 開啟啟動視窗。'
        : connected && !enrolled && !canEnrollPasskey() ? '首次設定需要啟動授權。請重新執行 pnpm start，使用自動開啟的視窗。' : '');
    return <main className={styles.page}>
        <Card className={styles.card} aria-labelledby="passkey-title">
            <CardHeader className={styles.header}>
                <p className={styles.brand}>FUBON TRADING / 本機交易終端</p>
                <div className={styles.heading}>
                    <ShieldCheck className={styles.icon} aria-hidden />
                    <CardTitle><h1 id="passkey-title" className={styles.title}>{title}</h1></CardTitle>
                </div>
                <CardDescription className={styles.description}>{description}</CardDescription>
            </CardHeader>
            <CardContent className={styles.content}>
                {!local && <Button asChild className={styles.action} variant="outline"><a href={`http://localhost:${location.port}/`}>開啟 localhost 介面</a></Button>}
                {local && connected && supported && (enrolled || canEnrollPasskey()) && <Button className={styles.action} disabled={busy} onClick={() => { void unlock(); }}>{busy ? '等待裝置驗證…' : enrolled ? '使用 Passkey 解鎖' : '建立 Passkey 並解鎖'}</Button>}
                {problem && <Alert variant="destructive"><AlertDescription>{problem}</AlertDescription></Alert>}
                <Separator />
            </CardContent>
            <CardFooter className={styles.footer}><p className={styles.note}>Passkey 用來解鎖本機介面。已儲存的富邦連線資料會由後端從 Keychain 自動讀取，不需每次重新輸入 API Key 或憑證密碼。</p></CardFooter>
        </Card>
    </main>;
}

export async function showPasskeyGate(onUnlocked: () => Promise<void>) {
    const host = document.getElementById('root') as (HTMLElement & { __shioajiRoot?: Root }) | null;
    if (!host) return;
    initTheme();
    // The terminal reuses this root after authentication succeeds.
    const root = host.__shioajiRoot ?? createRoot(host);
    host.__shioajiRoot = root;
    root.render(<PasskeyGate onUnlocked={onUnlocked} />);
}
