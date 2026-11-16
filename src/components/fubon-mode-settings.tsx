import { useEffect, useState } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { SelectControl, SelectOption } from '@/components/ui/select-control';
import { Switch } from '@/components/ui/switch';
import { apiGet } from '@/lib/api';
import { FubonApiError, fubonPost } from '@/lib/fubon-api-detail';
import * as styles from './fubon-mode-settings.css';

type Mode = 'demo' | 'paper' | 'sandbox' | 'live';
interface Settings { mode: Mode; live_enabled: boolean; instance_id: string; available: boolean; saved: boolean; sandbox_configured: boolean }
const modes: Record<Mode, { label: string; detail: string }> = {
    demo: { label: '展示模式', detail: '合成行情，委託在本機模擬；展示帳簿重啟後清除。' },
    paper: { label: 'Paper 模擬交易', detail: '富邦正式行情，委託在本機模擬；保存委託、持倉與費稅。' },
    sandbox: { label: '富邦 Sandbox', detail: '富邦測試行情，委託送往官方測試主機；使用共用測試帳戶。' },
    live: { label: '正式交易', detail: '富邦正式行情，委託送往正式交易帳戶，會影響實際資金與部位。' },
};

function LiveTradingConsent({ enabled, onChange, acknowledgement, onAcknowledge, disabled }: {
    enabled: boolean; onChange: (value: boolean) => void; acknowledgement: string; onAcknowledge: (value: string) => void; disabled: boolean;
}) {
    return <FieldGroup className="gap-3">
        <Field orientation="horizontal" className={styles.permission}>
            <FieldContent><FieldLabel htmlFor="allow-live-orders">允許正式下單</FieldLabel>
                <FieldDescription>啟用後，手動委託可送往富邦正式帳戶；每筆仍需確認。</FieldDescription></FieldContent>
            <Switch id="allow-live-orders" checked={enabled} onCheckedChange={onChange} disabled={disabled} />
        </Field>
        <Field><FieldLabel htmlFor="live-acknowledgement">輸入「確認啟用正式下單」</FieldLabel>
            <Input id="live-acknowledgement" value={acknowledgement} onChange={event => onAcknowledge(event.target.value)} disabled={disabled} autoComplete="off" />
        </Field>
    </FieldGroup>;
}

async function waitForRestart(previous: string) {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
        try {
            const response = await fetch('/api/v1/passkeys/status', { signal: AbortSignal.timeout(1500), cache: 'no-store' });
            if (response.ok && (await response.json()).instance_id !== previous) { location.reload(); return; }
        } catch { /* The owned backend is restarting. */ }
        await new Promise(resolve => setTimeout(resolve, 500));
    }
    throw new Error('服務尚未完成重新連線，請重新整理確認目前模式；不要重複套用。');
}

function ModeSettingsForm({ current, onBusy }: { current: Settings; onBusy: (value: boolean) => void }) {
    const [mode, setMode] = useState(current.mode);
    // Every new live selection requires a fresh, explicit confirmation.
    const [enabled, setEnabled] = useState(false);
    const [acknowledgement, setAcknowledgement] = useState('');
    const [phase, setPhase] = useState<'ready' | 'saving' | 'restarting' | 'unknown'>('ready');
    const [error, setError] = useState('');
    const changed = mode !== current.mode;
    const busy = phase === 'saving' || phase === 'restarting';
    const live = mode === 'live';
    const sandboxMissing = mode === 'sandbox' && !current.sandbox_configured;
    const canApply = changed && current.available && !sandboxMissing && (!live || enabled && acknowledgement === '確認啟用正式下單');
    const select = (value: string) => { setMode(value as Mode); setEnabled(false); setAcknowledgement(''); setError(''); };
    async function apply() {
        if (!canApply || busy) return;
        setError(''); setPhase('saving'); onBusy(true);
        try {
            const result = await fubonPost<{ restarting: boolean }>('/api/v1/settings/mode', {
                mode, live_enabled: live && enabled, instance_id: current.instance_id,
                acknowledgement: live ? acknowledgement : '確認切換交易環境',
            }, 30_000);
            if (result.restarting) { setPhase('restarting'); await waitForRestart(current.instance_id); }
            else { setPhase('ready'); onBusy(false); }
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : '無法確認切換結果，請重新整理確認目前模式');
            setPhase(cause instanceof FubonApiError && cause.status !== undefined && cause.status >= 400 && cause.status < 500 ? 'ready' : 'unknown'); onBusy(false);
        }
    }
    return <FieldGroup className="gap-3">
        <FieldDescription>目前：{modes[current.mode].label} · 正式下單{current.mode === 'live' && current.live_enabled ? '已啟用' : '關閉'}</FieldDescription>
        <Field><FieldLabel htmlFor="fubon-mode">交易模式</FieldLabel>
            <SelectControl id="fubon-mode" value={mode} onValueChange={select} disabled={busy || phase === 'unknown'} wrapperClassName="w-full" className="w-full">
                {Object.entries(modes).map(([value, item]) => <SelectOption key={value} value={value}>{item.label}</SelectOption>)}
            </SelectControl>
            <FieldDescription>{modes[mode].detail}</FieldDescription>
        </Field>
        {live && changed && <LiveTradingConsent enabled={enabled} onChange={setEnabled} acknowledgement={acknowledgement} onAcknowledge={setAcknowledgement} disabled={busy || phase === 'unknown'} />}
        {live && !changed && <FieldDescription>正式下單目前已啟用。選擇 Paper 模擬交易並套用，可關閉正式下單。</FieldDescription>}
        {sandboxMissing && <Alert><AlertDescription>尚未備妥官方測試憑證。請依專案設定說明配置 Sandbox，再重新開啟此視窗。</AlertDescription></Alert>}
        {!current.available && <Alert><AlertDescription>此啟動方式不支援切換，請使用 pnpm start 啟動。</AlertDescription></Alert>}
        <FieldDescription>套用後自動重啟此服務，需重新以 Passkey 解鎖。策略、研究工作、未完成委託與持倉須先處理完畢。</FieldDescription>
        <FieldDescription>選擇保存在此工作目錄，之後啟動優先沿用；.env 作為初始設定。費率與研究資料保留。</FieldDescription>
        {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
        <div className={styles.actions}>
            {phase === 'unknown' ? <Button size="sm" className={styles.action} onClick={() => location.reload()}>重新整理確認模式</Button>
                : <Button size="sm" className={styles.action} variant={live ? 'destructive' : 'default'} disabled={!canApply || busy} onClick={() => { void apply(); }}>
                    {phase === 'saving' ? '正在檢查與保存…' : phase === 'restarting' ? '正在重新連線…' : live ? '確認並啟用正式下單' : '套用並重新連線'}
                </Button>}
        </div>
    </FieldGroup>;
}

export function FubonModeSettings() {
    const [open, setOpen] = useState(false), [busy, setBusy] = useState(false);
    const [settings, setSettings] = useState<Settings>(), [error, setError] = useState('');
    useEffect(() => {
        if (!open) return;
        let disposed = false;
        setSettings(undefined); setError('');
        void apiGet<Settings>('/api/v1/settings/mode').then(value => { if (!disposed) setSettings(value); }, () => {
            if (!disposed) setError('無法讀取模式設定，請確認服務與解鎖狀態後重新開啟。');
        });
        return () => { disposed = true; };
    }, [open]);
    return <Dialog open={open} onOpenChange={value => { if (!busy) setOpen(value); }}>
        <DialogTrigger asChild><Button size="compact" variant="outline">交易模式設定</Button></DialogTrigger>
        <DialogContent className={styles.dialog} showCloseButton={!busy} onEscapeKeyDown={event => { if (busy) event.preventDefault(); }} onPointerDownOutside={event => { if (busy) event.preventDefault(); }}>
            <DialogHeader className={styles.header}><DialogTitle className={styles.title}>交易模式設定</DialogTitle><DialogDescription className={styles.description}>選擇行情來源與委託執行環境。</DialogDescription></DialogHeader>
            {settings ? <ModeSettingsForm current={settings} onBusy={setBusy} /> : error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : <p role="status">正在讀取設定…</p>}
        </DialogContent>
    </Dialog>;
}
