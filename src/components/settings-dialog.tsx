import { ToggleGroup, ToggleGroupItem } from './ui/toggle-group';
import { Field } from '@/components/ui/field';
import { Tabs, TabsList, TabsTrigger, TabsContent } from './ui/tabs';
import { TerminalDialog } from './terminal-dialog';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { canTrade } from '../lib/account-tradable';
// src/components/settings-dialog.tsx — 統一設定面板：外觀／音效與隱私／
// 帳號／風控／版面 五分類。原本散在 header 的主題/帳號/版面 popover 全數
// 收斂到這裡；風控「規則」也在此（Kill Switch 留在 header，一鍵可達）。

import {
    Bot,
    LayoutGrid,
    Palette,
    RefreshCw,
    ShieldAlert,
    UserRound,
    Volume2,
    X,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { AsyncStatus } from './async-status';
import {
    ensureAccounts,
    refreshAccounts,
    selectAccount,
    useAccounts,
} from '../lib/account-store';
import {
    API_MANAGEMENT_URL,
    SIGNING_URLS,
    unsignedAccountLabel,
    unsignedAccountTitle,
} from '../lib/account-signing';
import { useServerInfo } from '../lib/server-info-store';
import {
    HEADER_ITEMS,
    setHeaderItem,
    useHeaderItems,
} from '../lib/header-items';
import {
    maskAccountId,
    maskMoney,
    maskName,
    setPrivacyMode,
    setPrivacyMoney,
    usePrivacyMode,
    usePrivacyMoney,
} from '../lib/privacy';
import {
    getDailyPnl,
    setRiskSettings,
    useRiskSettings,
} from '../lib/risk';
import { isTauri } from '../lib/runtime';
import { setSoundEnabled, soundEnabled } from '../lib/sounds';
import {
    setThemeSettings,
    useThemeSettings,
    baseMode,
    type Convention,
    type FontScale,
    type ThemeMode,
} from '../lib/theme-store';
import {
    setToastScale,
    useToastScale,
    type ToastScale,
} from '../lib/toast-prefs';
import {
    setLimitStyle,
    useLimitStyle,
    type LimitStyle,
} from '../lib/limit-style-prefs';
import {
    setChartHoverPricePick,
    useChartHoverPricePick,
} from '../lib/chart-price-prefs';
import {
    isAgentHarnessEnabled,
    setAgentHarnessEnabled,
} from '../lib/tauri';
import { CUSTOM_BASES } from '../lib/custom-theme';
import { CustomThemeEditor } from './custom-theme-editor';
import { BackgroundExecutionSetting } from './background-execution-setting';
import { ExternalLink } from './external-link';
import { Orb } from './orb';
import * as hud from './hud-header.css';
import * as panel from './panel.css';
import * as styles from './settings-dialog.css';

const MODE_OPTIONS: { key: ThemeMode; label: string }[] = [
    { key: 'dark', label: '深色' },
    { key: 'light', label: '淺色' },
    { key: 'custom', label: '自訂' },
];

const CONVENTION_OPTIONS: { key: Convention; label: string }[] = [
    { key: 'tw', label: '紅漲綠跌' },
    { key: 'intl', label: '綠漲紅跌' },
];

const LIMIT_STYLE_OPTIONS: { key: LimitStyle; label: string; title: string }[] = [
    { key: 'block', label: '數字區色塊', title: '價格與漲跌兩行包成實心色塊、白字' },
    { key: 'tint', label: '淡底＋色條', title: '整列淡淡的漲跌色底，右緣一條實色色條' },
    { key: 'solid', label: '整列實心', title: '整列實心漲跌色、白字' },
    { key: 'none', label: '不標示', title: '到漲跌停不加任何標示' },
];

type SettingsTab =
    | 'appearance'
    | 'soundPrivacy'
    | 'accounts'
    | 'risk'
    | 'agent'
    | 'layout';

const TABS: { key: SettingsTab; label: string; icon: React.ReactNode }[] = [
    { key: 'appearance', label: '外觀', icon: <Palette size={13} /> },
    { key: 'soundPrivacy', label: '音效與隱私', icon: <Volume2 size={13} /> },
    { key: 'accounts', label: '帳號', icon: <UserRound size={13} /> },
    { key: 'risk', label: '風控', icon: <ShieldAlert size={13} /> },
    { key: 'agent', label: 'Agent', icon: <Bot size={13} /> },
    { key: 'layout', label: '版面', icon: <LayoutGrid size={13} /> },
];

function AppearanceSection() {
    const settings = useThemeSettings();
    const limitStyle = useLimitStyle();
    const toastScale = useToastScale();
    const headerItems = useHeaderItems();
    return (
        <>
            <span className={hud.settingLabel}>主題 Theme</span>
            <ToggleGroup type="single" value={String(settings.mode)} className={hud.settingGroup}>
                {MODE_OPTIONS.map((m) => (
                    <ToggleGroupItem value={String(m.key)}
                        key={m.key}
                        onClick={() =>
                            setThemeSettings(
                                m.key === 'custom'
                                    ? { mode: 'custom', custom: settings.custom ?? CUSTOM_BASES[baseMode(settings)] }
                                    : { mode: m.key },
                            )
                        }
                    >
                        {m.label}
                    </ToggleGroupItem>
                ))}
            </ToggleGroup>
            {settings.mode === 'custom' && <CustomThemeEditor />}
            <span className={hud.settingLabel}>漲跌顏色 Price Colors</span>
            <ToggleGroup type="single" value={String(settings.convention)} className={hud.settingGroup}>
                {CONVENTION_OPTIONS.map((c) => (
                    <ToggleGroupItem value={String(c.key)}
                        key={c.key}
                        onClick={() => setThemeSettings({ convention: c.key })}
                    >
                        {c.label}
                    </ToggleGroupItem>
                ))}
            </ToggleGroup>
            <div className={hud.convPreview}>
                <span className={panel.dirText.up}>▲ +1.25 上漲</span>
                <span className={panel.dirText.down}>▼ -1.25 下跌</span>
            </div>
            <span className={hud.settingLabel} id='limit-style-label'>
                自選清單漲跌停 Limit Highlight
            </span>
            <ToggleGroup type="single" value={String(limitStyle)}
                className={hud.settingGroup}
                role='group'
                aria-labelledby='limit-style-label'
            >
                {LIMIT_STYLE_OPTIONS.map((o) => (
                    <ToggleGroupItem value={String(o.key)}
                        key={o.key}
                        title={o.title}
                        onClick={() => setLimitStyle(o.key)}
                    >
                        {o.label}
                    </ToggleGroupItem>
                ))}
            </ToggleGroup>
            <span className={hud.settingLabel}>字級 Font Size</span>
            <ToggleGroup type="single" value={String(settings.fontScale)} className={hud.settingGroup}>
                {(
                    [
                        [1, '小'],
                        [1.15, '標準'],
                        [1.3, '大'],
                    ] as [FontScale, string][]
                ).map(([scale, label]) => (
                    <ToggleGroupItem value={String(scale)}
                        key={scale}
                        onClick={() => setThemeSettings({ fontScale: scale })}
                    >
                        {label}
                    </ToggleGroupItem>
                ))}
            </ToggleGroup>
            <span className={hud.settingLabel}>通知大小 Toast Size</span>
            <ToggleGroup type="single" value={String(toastScale)} className={hud.settingGroup}>
                {(
                    [
                        [0.9, '小'],
                        [1, '標準'],
                        [1.25, '大'],
                    ] as [ToastScale, string][]
                ).map(([scale, label]) => (
                    <ToggleGroupItem value={String(scale)}
                        key={scale}
                        onClick={() => setToastScale(scale)}
                    >
                        {label}
                    </ToggleGroupItem>
                ))}
            </ToggleGroup>
            <span className={hud.settingLabel}>頂欄顯示 Header Items</span>
            {HEADER_ITEMS.map((item) => (
                <Field orientation="horizontal" key={item.key} className={hud.switchRow}>
                    <span className={hud.switchLabel}>{item.label}</span>
                    <Switch  checked={headerItems[item.key]}  aria-label={item.label}
                        title={
                            headerItems[item.key]
                                ? `隱藏頂欄「${item.label}」`
                                : `顯示頂欄「${item.label}」`
                        }
                        onCheckedChange={() =>
                            setHeaderItem(item.key, !headerItems[item.key])
                        }
                    />
                </Field>
            ))}
            <span className={hud.emptyHint}>
                logo、環境徽章、伺服器、風控、新增面板與設定為固定項目，
                無法隱藏。
            </span>
        </>
    );
}

function SoundPrivacySection() {
    const [sound, setSound] = useState(soundEnabled());
    const priv = usePrivacyMode();
    const privMoney = usePrivacyMoney();
    return (
        <>
            <span className={hud.settingLabel}>音效 Sound</span>
            <Field orientation="horizontal" className={hud.switchRow}>
                <span className={hud.switchLabel}>成交/警示音效</span>
                <Switch  checked={sound}  aria-label={'成交/警示音效'}
                    title={sound ? '關閉音效' : '開啟成交/警示音效'}
                    onCheckedChange={() => {
                        setSoundEnabled(!sound);
                        setSound(!sound);
                    }}
                />
            </Field>
            <span className={hud.settingLabel}>隱私 Privacy</span>
            <Field orientation="horizontal" className={hud.switchRow}>
                <span
                    className={hud.switchLabel}
                    title='截圖/分享畫面時遮蔽帳號號碼與姓名'
                >
                    帳號遮蔽
                </span>
                <Switch  checked={priv}  aria-label={'帳號遮蔽'}
                    title='截圖/分享畫面時遮蔽帳號號碼與姓名'
                    onCheckedChange={() => setPrivacyMode(!priv)}
                />
            </Field>
            <Field orientation="horizontal" className={hud.switchRow}>
                <span
                    className={hud.switchLabel}
                    title='遮蔽水位/數量/損益/權益等金額（炫耀截圖用）'
                >
                    金額遮蔽
                </span>
                <Switch  checked={privMoney}  aria-label={'金額遮蔽'}
                    title='遮蔽水位/數量/損益/權益等金額（炫耀截圖用）'
                    onCheckedChange={() => setPrivacyMoney(!privMoney)}
                />
            </Field>
            <span className={hud.emptyHint}>
                遮蔽只影響畫面顯示，不影響下單與查詢。
            </span>
        </>
    );
}

export function AccountsSection() {
    const { accounts, selectedStock, selectedFutures, loaded, loadError } = useAccounts();
    const simulation = useServerInfo()?.simulation === true;
    const priv = usePrivacyMode();
    const [refreshing, setRefreshing] = useState(false);
    useEffect(ensureAccounts, []);
    const unsignedTypes = (['S', 'F'] as const).filter((t) =>
        accounts.some((a) => a.account_type === t && !a.signed),
    );
    const groups: { label: string; type: 'S' | 'F'; selected: string }[] = [
        {
            label: '證券帳戶',
            type: 'S',
            selected: selectedStock
                ? `${selectedStock.broker_id}-${selectedStock.account_id}`
                : '',
        },
        {
            label: '期貨帳戶',
            type: 'F',
            selected: selectedFutures
                ? `${selectedFutures.broker_id}-${selectedFutures.account_id}`
                : '',
        },
    ];
    return (
        <>
            {groups.map((g) => {
                const list = accounts.filter(
                    (a) => a.account_type === g.type,
                );
                if (list.length === 0) return null;
                return (
                    <div key={g.type}>
                        <span className={hud.settingLabel}>{g.label}</span>
                        {list.map((a) => {
                            const key = `${a.broker_id}-${a.account_id}`;
                            return (
                                <Button aria-pressed={g.selected === key} size="compact" variant={g.selected === key ? 'secondary' : 'outline'}
                                    key={key}
                                    className={cn(
                                        hud.opt[
                                            g.selected === key ? 'on' : 'off'
                                        ],
                                        !canTrade(a) && styles.acctUnsigned,
                                        'w-full min-w-0 flex-col items-start justify-start whitespace-normal text-left',
                                    )}
                                    style={{ width: '100%', marginTop: 4 }}
                                    disabled={!canTrade(a)}
                                    title={
                                        a.signed
                                            ? undefined
                                            : unsignedAccountTitle(simulation)
                                    }
                                    onClick={() => selectAccount(a)}
                                >
                                    <span className="max-w-full [overflow-wrap:anywhere]">
                                        {a.broker_id}-
                                        {maskAccountId(a.account_id, priv)}（
                                        {maskName(a.username, priv)}）
                                    </span>
                                    {!a.signed && (
                                        <span className={styles.unsignedTag}>
                                            {unsignedAccountLabel(simulation)}
                                        </span>
                                    )}
                                </Button>
                            );
                        })}
                    </div>
                );
            })}
            {loaded && accounts.length === 0 && (
                <span className={hud.emptyHint}>
                    <AsyncStatus phase={loadError ? 'error' : 'idle'}
                        text={loadError
                            ? '帳號讀取失敗 — 請確認伺服器連線後按下方「重新整理帳號」。'
                            : '尚未取得帳號 — 伺服器就緒後按下方「重新整理帳號」。'} />
                </span>
            )}
            {!loaded && (
                <span className={hud.emptyHint}><AsyncStatus phase='loading' text='載入帳號中…' /></span>
            )}
            <span className={hud.emptyHint}>
                下單與帳務查詢都使用選定的帳號；
                {simulation
                    ? unsignedAccountLabel(true)
                    : '尚未完成 API 約定書簽署或模擬測試的帳戶會列出但無法選為下單帳戶。'}
                {unsignedTypes.length > 0 && (
                    <>
                        請到永豐 API 管理頁查看原因並完成：
                        <span className={styles.signLinks}>
                            <ExternalLink
                                href={API_MANAGEMENT_URL}
                                className={styles.signLink}
                            >
                                API 管理頁
                            </ExternalLink>
                            {unsignedTypes.map((t) => (
                                <ExternalLink
                                    key={t}
                                    href={SIGNING_URLS[t].url}
                                    className={styles.signLink}
                                >
                                    {SIGNING_URLS[t].label}
                                </ExternalLink>
                            ))}
                        </span>
                    </>
                )}
            </span>
            <Button size="compact" variant="outline"
                className={hud.updateBtn}
                disabled={refreshing}
                onClick={() => {
                    setRefreshing(true);
                    void refreshAccounts().finally(() =>
                        setRefreshing(false),
                    );
                }}
            >
                {refreshing ? (
                    <Orb size={12} variant='ring' />
                ) : (
                    <RefreshCw size={13} />
                )}
                {refreshing ? '重新整理中…' : '重新整理帳號'}
            </Button>
        </>
    );
}

function RiskSection() {
    const risk = useRiskSettings();
    const hoverPricePick = useChartHoverPricePick();
    const dailyPnl = getDailyPnl();
    // 金額遮蔽也要蓋住這裡的損益估算 — 隱私開關不該在設定 dialog 裡漏底
    const privMoney = usePrivacyMoney();
    return (
        <>
            <span className={hud.settingLabel}>風控規則 Rules</span>
            <Field orientation="horizontal" className={hud.switchRow}>
                <span className={hud.switchLabel}>啟用風控規則</span>
                <Switch  checked={risk.enabled}  aria-label={'啟用風控規則'}
                    onCheckedChange={() =>
                        setRiskSettings({ enabled: !risk.enabled })
                    }
                />
            </Field>
            <div className={hud.saveRow}>
                <span className={hud.riskLabel}>單筆上限</span>
                <Input
                    className={hud.saveInput}
                    inputMode='numeric'
                    value={risk.maxQty || ''}
                    placeholder='不限'
                    onChange={(e) => {
                        const v = Number(e.target.value);
                        if (Number.isInteger(v) && v >= 0) {
                            setRiskSettings({ maxQty: v });
                        }
                    }}
                />
            </div>
            <div className={hud.saveRow}>
                <span className={hud.riskLabel}>日虧上限</span>
                <Input
                    className={hud.saveInput}
                    inputMode='numeric'
                    value={risk.maxDailyLoss || ''}
                    placeholder='不限 (TWD)'
                    onChange={(e) => {
                        const v = Number(e.target.value);
                        if (Number.isInteger(v) && v >= 0) {
                            setRiskSettings({ maxDailyLoss: v });
                        }
                    }}
                />
            </div>
            <span className={hud.emptyHint}>
                目前當日損益估算：
                {maskMoney(Math.round(dailyPnl).toLocaleString(), privMoney)}
                （持倉未實現＋期貨平倉）
                <br />
                停損/停利觸價單不受風控封鎖。
                <br />
                Kill Switch（鎖定下單）在畫面右上角「風控」鈕，一鍵鎖定/解鎖。
            </span>
            <span className={hud.settingLabel}>下單確認</span>
            <Field orientation="horizontal" className={hud.switchRow}>
                <span
                    className={hud.switchLabel}
                    title='手動下單前顯示可視化委託確認（方向/商品/價格/數量）；停損停利等自動觸發單不受影響'
                >
                    手動下單確認
                </span>
                <Switch  checked={risk.confirmManualOrders}  aria-label={'手動下單確認'}
                    title={
                        risk.confirmManualOrders
                            ? '關閉手動下單確認'
                            : '啟用手動下單確認'
                    }
                    onCheckedChange={() =>
                        setRiskSettings({
                            confirmManualOrders: !risk.confirmManualOrders,
                        })
                    }
                />
            </Field>
            <span className={hud.emptyHint}>
                預設關閉（維持快速下單）。開啟後閃電下單、下單面板、
                圖表點價、平倉與鋪單都會先跳委託確認；停損/停利等
                自動觸發單與 Agent 下單不經過此確認。
            </span>
            {isTauri && <BackgroundExecutionSetting />}
            <span className={hud.settingLabel}>圖表帶價 Chart Price</span>
            <Field orientation="horizontal" className={hud.switchRow}>
                <span
                    className={hud.switchLabel}
                    title='在 K 線圖上移動游標時，把十字線價位即時帶入同商品的下單面板'
                >
                    游標移動帶價
                </span>
                <Switch
                     aria-label={'圖表游標選價'}
                     checked={hoverPricePick}
                    title={
                        hoverPricePick
                            ? '關閉游標移動帶價（只在點擊圖表時帶價）'
                            : '啟用游標移動帶價'
                    }
                    onCheckedChange={() => setChartHoverPricePick(!hoverPricePick)}
                />
            </Field>
            <span className={hud.emptyHint}>
                {'預設關閉，避免游標掃過圖表時改寫已填好的委託價；關閉時仍可點擊 K 線圖或五檔帶價。'}
            </span>
            <span className={hud.settingLabel}>快捷鍵 Hotkeys</span>
            <Field orientation="horizontal" className={hud.switchRow}>
                <span
                    className={hud.switchLabel}
                    title='0.6 秒內連按兩次 Esc 撤銷所有未成交委託'
                >
                    雙擊 Esc 全部刪單
                </span>
                <Switch  checked={risk.escCancelAll}  aria-label={'Esc 連按兩次刪除全部委託'}
                    title={
                        risk.escCancelAll
                            ? '關閉雙擊 Esc 全部刪單'
                            : '啟用雙擊 Esc 全部刪單'
                    }
                    onCheckedChange={() =>
                        setRiskSettings({ escCancelAll: !risk.escCancelAll })
                    }
                />
            </Field>
            <span className={hud.emptyHint}>
                預設關閉，避免誤觸；開啟後在非輸入狀態下 0.6 秒內連按兩次
                Esc 會撤銷全部未成交委託（第一下會先跳提示）。
            </span>
        </>
    );
}

function AgentSection() {
    const [enabled, setEnabled] = useState(isAgentHarnessEnabled());
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');

    const [note, setNote] = useState('');
    const toggle = async () => {
        const next = !enabled;
        setBusy(true);
        setError('');
        setNote('');
        try {
            const res = await setAgentHarnessEnabled(next);
            setEnabled(next);
            if (res.restarted) {
                // 撿到孤兒 sidecar（上次 app 異常退出）— 已透過 native
                // spawn 重啟以取得 harness 所有權
                setNote('伺服器已自動重啟以建立 Agent Harness 所有權');
            }
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause));
        } finally {
            setBusy(false);
        }
    };

    return (
        <>
            <span className={hud.settingLabel}>Agent Harness</span>
            <Field orientation="horizontal" className={hud.switchRow}>
                <span className={hud.switchLabel}>保護 Agent 下單操作</span>
                <Switch  checked={enabled}  aria-label={'Agent 測試介面'}
                    disabled={busy}
                    title={enabled ? '關閉 Agent Harness' : '開啟 Agent Harness'}
                    onCheckedChange={() => void toggle()}
                />
            </Field>
            <span className={hud.emptyHint}>
                關閉時，一般 UI 下單走原本的直接 HTTP 路徑；開啟後，Agent
                與 UI 的每筆交易異動都需要一次性授權。切換立即生效，
                不需重啟伺服器。
            </span>
            <Field orientation="horizontal" className={hud.switchRow}>
                <span
                    className={hud.switchLabel}
                    title='Agent 在正式環境的每筆交易都需由獨立核可視窗確認'
                >
                    正式環境逐筆核可
                </span>
                <Switch aria-label={'正式環境逐筆核可'}  checked={true}
                    disabled
                    title='Phase 1 安全基線：正式環境固定開啟'
                />
            </Field>
            <span className={hud.emptyHint}>
                正式環境的逐筆確認固定由獨立的原生核可視窗確認，無法關閉；
                正式 Auto 首筆需在原生視窗授權本次 runtime 與帳戶，停止或
                切換後失效。每次 App 重啟都會恢復為「逐筆確認」。此安全邊界與
                「手動下單確認」（設定 → 風控）互相獨立。
            </span>
            {busy && (
                <span className={hud.emptyHint}>
                    切換中…（若需重啟伺服器約 10–60 秒）
                </span>
            )}
            {note && <span className={hud.emptyHint}>{note}</span>}
            {error && <span className={styles.errorText}>{error}</span>}
        </>
    );
}

export interface LayoutSectionProps {
    onResetWorkspace: () => void;
    // 開版面庫（presets/save/load/rename/delete 全在版面庫 dialog）
    onOpenLayoutLibrary: () => void;
}

function LayoutSection({
    onResetWorkspace,
    onOpenLayoutLibrary,
    onClose,
}: LayoutSectionProps & { onClose: () => void }) {
    return (
        <>
            <span className={hud.settingLabel}>版面 Layouts</span>
            <Button size="compact" variant="outline"
                className={hud.updateBtn}
                onClick={() => {
                    onClose();
                    onOpenLayoutLibrary();
                }}
            >
                <LayoutGrid size={13} /> 開啟版面庫…
            </Button>
            <span className={hud.emptyHint}>
                預設版面、儲存/切換/改名/刪除自訂版面都在版面庫；
                頂欄的「版面」鈕可直接開啟。
            </span>
            <Button size="compact" variant="ghost"
                className={hud.menuItem}
                onClick={() => {
                    onResetWorkspace();
                    onClose();
                }}
            >
                ↺ 重設為預設版面
            </Button>
        </>
    );
}

export function SettingsDialog({
    open,
    onClose,
    ...layoutProps
}: LayoutSectionProps & {
    open: boolean;
    onClose: () => void;
}) {
    const [tab, setTab] = useState<SettingsTab>('appearance');


    if (!open) return null;

    return (
        <TerminalDialog title="設定" onClose={onClose} layout="custom" className={styles.dialog}>
                <div className={hud.srvDialogTitle}>
                    設定
                    <Button size="compact" variant="ghost"
                        className={hud.profileDelete}
                        title='關閉（Esc）'
                        onClick={onClose}
                    >
                        <X size={12} />
                    </Button>
                </div>
                <Tabs value={tab} onValueChange={value => setTab(value as SettingsTab)} className={styles.body} orientation="vertical">
                    <TabsList className={cn(styles.nav, 'h-auto items-stretch justify-start')} aria-label="設定分類">
                        {TABS.map(t => <TabsTrigger key={t.key} value={t.key}>{t.icon}{t.label}</TabsTrigger>)}
                    </TabsList>
                    <TabsContent value={tab} className={styles.content}>
                        {tab === 'appearance' && <AppearanceSection />}
                        {tab === 'soundPrivacy' && <SoundPrivacySection />}
                        {tab === 'accounts' && <AccountsSection />}
                        {tab === 'risk' && <RiskSection />}
                        {tab === 'agent' && <AgentSection />}
                        {tab === 'layout' && <LayoutSection {...layoutProps} onClose={onClose} />}
                    </TabsContent>
                </Tabs>
        </TerminalDialog>
    );
}
