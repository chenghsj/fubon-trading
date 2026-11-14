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
    const title = !local ? '請使用本機登入網址' : loading ? '正在確認登入狀態'
        : !connected ? '尚未連上本機服務' : enrolled ? '使用 Passkey 解鎖' : '建立你的 Passkey';
    const description = !local ? 'Passkey 綁定 localhost，請從啟動視窗進入。'
        : loading ? '正在連線至本機交易服務。'
        : !connected ? '請執行 pnpm start，然後重新整理此頁面。'
        : enrolled ? '使用 Touch ID、裝置解鎖或安全金鑰驗證身分，進入交易介面。'
        : '首次設定後，即可使用 Passkey 解鎖，不必每次輸入登入資料。';
    const problem = error || (connected && !supported ? '此瀏覽器不支援 Passkey，請使用新版 Chrome、Safari 或 Edge 開啟啟動視窗。'
        : connected && !enrolled && !canEnrollPasskey() ? '首次設定需要啟動授權。請重新執行 pnpm start，使用自動開啟的視窗。' : '');
    return <main className="flex h-full items-center justify-center overflow-y-auto bg-background p-6 text-foreground">
        <Card className="my-auto w-full max-w-md">
            <CardHeader>
                <p className="m-0 text-xs tracking-widest text-muted-foreground">FUBON TRADING / 本機交易終端</p>
                <ShieldCheck className="my-5 size-10 text-primary" aria-hidden />
                <CardTitle><h1 className="m-0 text-2xl">{title}</h1></CardTitle>
                <CardDescription>{description}</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
                {!local && <Button asChild variant="outline"><a href={`http://localhost:${location.port}/`}>開啟 localhost 介面</a></Button>}
                {local && connected && supported && (enrolled || canEnrollPasskey()) && <Button className="w-full" disabled={busy} onClick={() => { void unlock(); }}>{busy ? '等待裝置驗證…' : enrolled ? '使用 Passkey 解鎖' : '建立 Passkey 並解鎖'}</Button>}
                <div role="status" aria-live="polite">{problem && <Alert variant="destructive"><AlertDescription>{problem}</AlertDescription></Alert>}</div>
                <Separator />
            </CardContent>
            <CardFooter><p className="m-0 text-sm text-muted-foreground">Passkey 用來解鎖本機介面。富邦登入資料保存在 Keychain，解鎖後由後端使用；不會傳入瀏覽器。</p></CardFooter>
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
