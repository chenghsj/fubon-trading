import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { apiGet } from '@/lib/api';
import { FubonApiError, fubonPost } from '@/lib/fubon-api-detail';
import { waitForFubonRestart } from '@/lib/fubon-restart';
import { confirmCredentialUpdate } from '@/lib/passkeys';
import * as styles from './fubon-mode-settings.css';

interface Settings { available: boolean; configured: boolean; storage: string | null; instance_id: string }

function CredentialForm({ current, onBusy }: { current: Settings; onBusy: (busy: boolean) => void }) {
    const form = useRef<HTMLFormElement>(null);
    const submitting = useRef(false);
    const [phase, setPhase] = useState<'ready' | 'verifying' | 'saving' | 'restarting' | 'unknown'>('ready');
    const [error, setError] = useState('');
    const busy = phase === 'verifying' || phase === 'saving' || phase === 'restarting';
    useEffect(() => {
        const clear = () => form.current?.reset();
        window.addEventListener('pagehide', clear);
        return () => { clear(); window.removeEventListener('pagehide', clear); };
    }, []);

    async function save(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        if (submitting.current || !current.available || phase === 'unknown') return;
        const data = new FormData(event.currentTarget);
        const values = Object.fromEntries(['api_key', 'personal_id', 'cert_path', 'cert_password'].map(name => [name, String(data.get(name) ?? '')]));
        for (const name of Object.keys(values)) data.delete(name);
        event.currentTarget.reset(); // Clear visible inputs before device verification.
        submitting.current = true;
        setError(''); setPhase('verifying'); onBusy(true);
        let sent = false;
        try {
            const assertion = await confirmCredentialUpdate();
            setPhase('saving'); sent = true;
            await fubonPost('/api/v1/settings/credentials', { ...values, ...assertion, instance_id: current.instance_id }, 30_000);
            for (const name of Object.keys(values)) values[name] = '';
            setPhase('restarting');
            await waitForFubonRestart(current.instance_id);
        } catch (cause) {
            const rejected = cause instanceof FubonApiError && cause.status !== undefined && cause.status >= 400 && cause.status < 500;
            const unknown = sent && !rejected;
            setError(unknown ? '無法確認儲存或重新連線結果。請重新整理並查看設定狀態，不要直接重送。' : cause instanceof Error ? cause.message : '驗證未完成，請重新輸入後再試。');
            setPhase(unknown ? 'unknown' : 'ready');
            onBusy(false);
        } finally {
            for (const name of Object.keys(values)) values[name] = '';
            submitting.current = false;
        }
    }

    return <form ref={form} onSubmit={event => { void save(event); }} autoComplete="off">
        <FieldGroup className="gap-3">
            <FieldDescription>{current.configured ? '已設定登入資料。只更換 API Key 時，其餘欄位留白即可沿用。' : '尚未設定登入資料。首次使用請填寫 API Key、帳號與憑證資料。'}</FieldDescription>
            {!current.available && <Alert><AlertDescription>此啟動方式無法安全儲存。請在 macOS 使用 pnpm start 啟動後再設定。</AlertDescription></Alert>}
            <Field data-disabled={!current.available || busy}>
                <FieldLabel htmlFor="fubon-api-key">新 API Key</FieldLabel>
                <Input id="fubon-api-key" name="api_key" type="password" autoComplete="new-password" spellCheck={false} autoCapitalize="none" required maxLength={4096} disabled={!current.available || busy} aria-describedby="fubon-api-key-help" />
                <FieldDescription id="fubon-api-key-help">舊 Key 不會顯示。請貼上富邦核發的新 Key。</FieldDescription>
            </Field>
            <details open={current.configured ? undefined : true}>
                <summary>帳號與憑證{current.configured ? '（選填更新）' : '（首次設定必填）'}</summary>
                <FieldGroup className="gap-3 pt-3">
                    <Field><FieldLabel htmlFor="fubon-personal-id">身分證字號</FieldLabel>
                        <Input id="fubon-personal-id" name="personal_id" type="password" autoComplete="off" spellCheck={false} required={!current.configured} maxLength={128} disabled={!current.available || busy} /></Field>
                    <Field><FieldLabel htmlFor="fubon-cert-path">本機憑證完整路徑</FieldLabel>
                        <Input id="fubon-cert-path" name="cert_path" autoComplete="off" spellCheck={false} placeholder="/Users/你的使用者名稱/憑證.pfx" required={!current.configured} maxLength={4096} disabled={!current.available || busy} aria-describedby="fubon-cert-path-help" />
                        <FieldDescription id="fubon-cert-path-help">使用這台 Mac 上已有的憑證檔案，檔案權限須為 600。</FieldDescription></Field>
                    <Field><FieldLabel htmlFor="fubon-cert-password">憑證密碼</FieldLabel>
                        <Input id="fubon-cert-password" name="cert_password" type="password" autoComplete="new-password" required={!current.configured} maxLength={4096} disabled={!current.available || busy} /></Field>
                </FieldGroup>
            </details>
            <FieldDescription>登入資料儲存在 macOS Keychain，供此電腦的 Fubon Trading 共用。不寫入瀏覽器儲存空間或設定檔。儲存前需以 Passkey 驗證。</FieldDescription>
            <FieldDescription>儲存後重啟此服務並重新解鎖，交易模式維持原設定。策略、研究工作、未完成委託與持倉須先處理完畢。</FieldDescription>
            {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
            {busy && <p role="status">{phase === 'verifying' ? '等待 Passkey 驗證…' : phase === 'saving' ? '正在儲存至 Keychain…' : '已儲存，等待服務重新連線…'}</p>}
            <div className={styles.actions}><Button size="compact" className={styles.action} type="submit" disabled={!current.available || busy || phase === 'unknown'}>驗證並儲存 API Key</Button></div>
        </FieldGroup>
    </form>;
}

export function FubonCredentialSettings() {
    const [open, setOpen] = useState(false), [busy, setBusy] = useState(false);
    const [settings, setSettings] = useState<Settings>(), [error, setError] = useState('');
    useEffect(() => {
        if (!open) return;
        let disposed = false;
        setSettings(undefined); setError('');
        void apiGet<Settings>('/api/v1/settings/credentials').then(value => { if (!disposed) setSettings(value); }, () => {
            if (!disposed) setError('無法讀取設定狀態。請確認已解鎖介面及 macOS 鑰匙圈，再重新開啟。');
        });
        return () => { disposed = true; };
    }, [open]);
    return <Dialog open={open} onOpenChange={value => { if (!busy) setOpen(value); }}>
        <DialogTrigger asChild><Button size="compact" variant="outline">API Key 設定</Button></DialogTrigger>
        <DialogContent className={styles.dialog} showCloseButton={!busy} onEscapeKeyDown={event => { if (busy) event.preventDefault(); }} onPointerDownOutside={event => { if (busy) event.preventDefault(); }}>
            <DialogHeader className={styles.header}><DialogTitle className={styles.title}>API Key 設定</DialogTitle><DialogDescription className={styles.description}>安全更新富邦登入資料。</DialogDescription></DialogHeader>
            {open && (settings ? <CredentialForm current={settings} onBusy={setBusy} /> : error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : <p role="status">正在讀取設定狀態…</p>)}
        </DialogContent>
    </Dialog>;
}
