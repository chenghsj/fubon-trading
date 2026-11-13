import { FieldSet } from '@/components/ui/field';
import { TerminalDialog } from './terminal-dialog';
import { Button } from '@/components/ui/button';
import { X } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { type CredentialDraft, type DesktopSettings, type ServerStatus } from '../lib/tauri';
import { CredentialProfiles } from './credential-profiles';
import * as s from './server-settings-dialog.css';

export type ServerConnectionSettings = CredentialDraft;
export function ServerSettingsDialog({ settings, status, busy, pendingApply = false, switching, applyOnSwitch = false, onSave, onProfileAction, onImported, onClose, children }: {
    settings: DesktopSettings; status: ServerStatus | null | undefined; busy: boolean; pendingApply?: boolean;
    // 切換中的進度文字；spawn 送出後 busy 已結束，帳號操作仍要鎖到重新載入，但可以關閉對話框看主畫面
    switching?: string; applyOnSwitch?: boolean;
    onSave: (draft: CredentialDraft, apply: boolean) => Promise<DesktopSettings>;
    onProfileAction: (action: 'select' | 'delete', id: string) => Promise<DesktopSettings>;
    onImported: (settings: DesktopSettings) => void;
    onClose: () => void; children?: ReactNode;
}) {
    const [credentialBusy, setCredentialBusy] = useState(false);
    const [editingProfile, setEditingProfile] = useState(false);
    const locked = busy || credentialBusy;
    return <TerminalDialog title="伺服器設定" onClose={onClose} locked={locked} className={s.dialog}>
            <header className={s.header}><div><h2 id="server-settings-title" className={s.title}>伺服器設定</h2><p className={s.hint}>{status?.running ? `伺服器運行中 · ${status.simulation === true ? '模擬環境' : status.simulation === false ? '正式環境' : '環境未知'} · ${status.scheme ?? 'scheme 未知'}` : '伺服器未啟動'}{pendingApply ? ' · 有設定尚未套用' : ''}</p></div><Button size="compact" variant="ghost" className={s.iconButton} aria-label="關閉伺服器設定" title="關閉" disabled={locked} onClick={onClose}><X size={16} /></Button></header>
            <div className={s.body}>
                {switching && <p role="status" className={s.notice}>{switching} 就緒後畫面會自動重新載入。</p>}
                <CredentialProfiles settings={settings} busy={busy || !!switching} running={!!status?.running} applyOnSwitch={applyOnSwitch} onSave={onSave} onAction={onProfileAction} onImported={onImported} onBusyChange={setCredentialBusy} onEditingChange={setEditingProfile} />
                {!editingProfile && <FieldSet className={s.fields} disabled={locked || !!switching}>{children}</FieldSet>}
            </div>
            <footer className={s.footer}><p className={s.footerHint}>重啟會停止本 App 的 Agent、撤銷本次 Auto 授權，並暫時中斷行情；既有委託不會因此撤銷。</p><Button size="compact" variant="outline" className={s.button} disabled={locked} onClick={onClose}>關閉</Button></footer>
    </TerminalDialog>;
}
