import { SelectControl, SelectOption } from './ui/select-control';
import { useEffect, useRef, useState } from 'react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Textarea } from './ui/textarea';
import { apiGet } from '../lib/api';
import { fubonPost } from '../lib/fubon-api-detail';
import { autoAccountKey, AUTO_STATUS, initialAutoConfig, parseAutoBasket, type AutoAccount, type AutoConfig, type AutoState } from '../lib/auto-trading';
import { checkOrderAllowed, getRiskSettings, useRiskSettings } from '../lib/risk';
import * as s from './auto-trading.css';

const amount = (n: number | null | undefined) => n == null ? '待確認' : n.toLocaleString('zh-TW', { maximumFractionDigits: 0 });
const when = (value: string | number) => new Date(typeof value === 'number' ? value * 1000 : value).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false });
const message = (e: unknown) => e instanceof Error ? e.message : String(e);
const activeStatuses = new Set(['running', 'paused', 'stopping', 'attention']);

export function AutoTradingPanel() {
    const [draft, setDraft] = useState<AutoConfig>(initialAutoConfig);
    const [basketText, setBasketText] = useState(() => draft.basket.map(b => `${b.code},${b.weight * 100}`).join('\n'));
    const [accounts, setAccounts] = useState<AutoAccount[]>([]);
    const [state, setState] = useState<AutoState | null>(null);
    const [error, setError] = useState(''), [syncError, setSyncError] = useState(''), [busy, setBusy] = useState('');
    const [acknowledgement, setAcknowledgement] = useState('');
    const alive = useRef(true), loadedId = useRef<string | null | undefined>(undefined);
    const risk = useRiskSettings();
    const accept = (next: AutoState) => {
        if (!alive.current) return;
        setState(next);
        if (next.config && loadedId.current !== next.id) {
            setDraft(next.config);
            setBasketText(next.config.basket.map(b => `${b.code},${Number((b.weight * 100).toFixed(4))}`).join('\n'));
        }
        loadedId.current = next.id;
    };
    useEffect(() => {
        alive.current = true;
        let timer: ReturnType<typeof setTimeout>;
        const poll = async () => {
            try { accept(await apiGet<AutoState>('/api/v1/automation/state')); if (alive.current) setSyncError(''); }
            catch (e) { if (alive.current) setSyncError(`狀態更新失敗：${message(e)}。請確認連線，勿重複啟動。`); }
            finally { if (alive.current) timer = setTimeout(poll, 2000); }
        };
        void poll();
        void apiGet<(AutoAccount & { signed?: boolean })[]>('/api/v1/auth/accounts').then(rows => {
            if (!alive.current) return;
            const choices = rows.filter(a => a.account_type === 'F' && a.signed !== false).map(a => ({ account_type: a.account_type, broker_id: a.broker_id, account_id: a.account_id }));
            setAccounts(choices);
            setDraft(old => old.account.account_id || !choices[0] ? old : { ...old, account: choices[0] });
        }).catch(e => { if (alive.current) setError(`無法讀取期貨帳戶：${message(e)}`); });
        return () => { alive.current = false; clearTimeout(timer); };
    }, []);
    const controller = !!state?.owned && activeStatuses.has(state.status);
    useEffect(() => {
        if (!controller || !state?.id) return;
        const runId = state.id;
        let disposed = false, pending = false;
        const heartbeat = async () => {
            if (pending || disposed) return;
            pending = true;
            try {
                await fubonPost('/api/v1/automation/heartbeat', { run_id: runId, entries_allowed: checkOrderAllowed(1) === null, execution_allowed: !getRiskSettings().locked });
            } catch (e) { if (!disposed && alive.current) setSyncError(`控制心跳失敗：${message(e)}。後端將暫停新倉，請重新整理狀態。`); }
            finally { pending = false; }
        };
        void heartbeat();
        const timer = setInterval(() => void heartbeat(), 3000);
        return () => { disposed = true; clearInterval(timer); };
    }, [state?.id, controller, risk.locked]);
    const start = async () => {
        const blocked = checkOrderAllowed(1);
        if (blocked) { setError(blocked); return; }
        setBusy('正在啟動…'); setError('');
        try {
            const config = { ...draft, basket: draft.use_basket ? parseAutoBasket(basketText) : draft.basket };
            setDraft(config);
            accept(await fubonPost<AutoState>('/api/v1/automation/start', config, 45000));
        }
        catch (e) { if (alive.current) setError(message(e)); }
        finally { if (alive.current) setBusy(''); }
    };
    const control = async (command: 'pause' | 'stop' | 'reconcile' | 'archive') => {
        if (!state?.id) return;
        setBusy('正在套用控制…'); setError('');
        try { accept(await fubonPost<AutoState>('/api/v1/automation/control', { command, run_id: state.id, acknowledgement, execution_allowed: !getRiskSettings().locked }, 45000)); setAcknowledgement(''); }
        catch (e) { if (alive.current) setError(message(e)); }
        finally { if (alive.current) setBusy(''); }
    };
    const runningOrExposed = !!state && (!!state.pending || !!state.position || state.status === 'running' || state.status === 'stopping');
    const lockedPlan = runningOrExposed || !!state && state.entryCount > 0 && draft.trade_date === state.config?.trade_date && !['stopped', 'completed', 'archived'].includes(state.status);
    const editable = !busy && !lockedPlan;
    const globalBlock = checkOrderAllowed(1);
    const mayStart = !!state?.available && !!draft.account.account_id && !busy && !globalBlock && !state.pending && !state.position && !['running', 'stopping'].includes(state.status);
    const updateNumber = (key: keyof AutoConfig, value: string) => setDraft(old => ({ ...old, [key]: value === '' ? NaN : Number(value) }));
    return <section className={s.wrap} aria-label="Sandbox 自動交易">
        <div className={s.header}><h2 className={s.title}>自動交易 · 微台日盤</h2><span className={`${s.status} ${state?.status === 'attention' ? s.warning : ''}`}>{state ? AUTO_STATUS[state.status] : '讀取狀態…'}</span></div>
        <p className={s.muted}>官方 sandbox 測試委託 · 單口、單一部位 · 09:00 開盤區間策略</p>
        <p className={s.notice}><strong>策略驗證：研究中</strong><br />已檢查收盤訊號、缺漏資料與執行風控；尚未完成獨立樣本外、成本壓力與盤中前測驗證。啟動僅用於 sandbox 流程測試，不代表已通過獲利驗證。</p>
        {state && !state.available && <p role="status" className={s.notice}>目前為 {state.mode}。請以既有官方 sandbox 設定啟動服務；此面板僅在 sandbox 執行。</p>}
        <div className={s.notice} role="status"><strong>{state?.reason ?? '正在連線'}</strong><br />{state?.owned ? `本分頁持有控制權 · 心跳剩餘 ${state.leaseSeconds} 秒` : state?.id && activeStatuses.has(state.status) ? '此分頁可停止或對帳；尚未持有新倉控制權。' : '啟動前不會產生委託。'}</div>
        {globalBlock && <p className={s.warning}>新倉受風控限制：{globalBlock}</p>}
        {risk.locked && <p className={s.warning}>風控鎖定也會阻擋自動退出送單；已有曝險時請人工確認。</p>}
        {syncError && <p role="alert" className={s.warning}>{syncError}</p>}
        {error && <p role="alert" className={s.warning}>{error}</p>}
        <div className={s.metrics}>
            <div className={s.metric}>進場委託次數<strong className={s.number}>{state?.entryCount ?? 0} / {state?.config?.max_entries ?? draft.max_entries}</strong></div>
            <div className={s.metric}>本策略追蹤曝險<strong className={s.number}>{state?.position ? `${state.position.side === 'Buy' ? '多' : '空'} ${state.position.quantity} 口` : state?.pending ? '委託待確認' : '無'}</strong></div>
            <div className={s.metric}>估計已實現淨損益<strong className={s.number}>${amount(state?.realizedNet)}</strong></div>
            <div className={s.metric}>估計未實現淨損益<strong className={s.number}>{state?.position ? `$${amount(state.unrealizedNet)}` : '—'}</strong></div>
        </div>
        <form onSubmit={e => { e.preventDefault(); void start(); }}>
            <label className={`${s.field} ${s.dateField}`}>單次交易日期<Input className={s.control} type="date" required disabled={!!busy || runningOrExposed} value={draft.trade_date} onChange={e => setDraft(old => ({ ...old, trade_date: e.target.value }))} /></label>
            <fieldset className={s.fieldset} disabled={!editable}>
                <legend className={s.heading}>策略與執行設定</legend>
                <div className={s.grid}>
                    <label className={s.field}>期貨測試帳戶<SelectControl aria-label="期貨測試帳戶" wrapperClassName="w-full" disabled={!editable} className={s.control} value={autoAccountKey(draft.account)} onValueChange={selectedValue => { const a = accounts.find(a => autoAccountKey(a) === selectedValue); if (a) setDraft(old => ({ ...old, account: a })); }}><SelectOption value=":">選擇帳戶</SelectOption>{accounts.map(a => <SelectOption key={autoAccountKey(a)} value={autoAccountKey(a)}>{a.broker_id}-{a.account_id}</SelectOption>)}</SelectControl></label>
                    <label className={s.field}>微台具體合約<Input className={s.control} value={draft.contract_code} required pattern="TMF[A-L][0-9]" placeholder="TMFK6" onChange={e => setDraft(old => ({ ...old, contract_code: e.target.value.toUpperCase() }))} /></label>
                    <label className={s.field}>策略版本<SelectControl aria-label="策略版本" wrapperClassName="w-full" disabled={!editable} className={s.control} value={draft.use_basket ? 'basket' : 'baseline'} onValueChange={selectedValue => setDraft(old => ({ ...old, use_basket: selectedValue === 'basket' }))}><SelectOption value="baseline">開盤區間突破</SelectOption><SelectOption value="basket">突破＋權值股方向濾網</SelectOption></SelectControl></label>
                </div>
                {draft.use_basket && <><label className={s.field}>固定假設權重 · 每行「股票代碼,百分比」<Textarea className={s.control} rows={4} value={basketText} onChange={e => setBasketText(e.target.value)} /></label><p className={s.muted}>固定假設範例，不是官方歷史權重；這個濾網尚未證明能改善收益。</p></>}
                <div className={s.grid}>{([
                    ['stop_points', '停損距離（點）', 1, 1000, 1], ['target_points', '停利距離（點）', 1, 2000, 1],
                    ['slippage_points', 'IOC 限價距離買賣價（點）', 0, 10, 1], ['max_entries', '本日進場委託上限', 1, 2, 1],
                    ['loss_limit', '停止新倉的估計損失門檻 NT$', 10, 100000, 10], ['fee_per_side', '每口單邊手續費假設 NT$', 0, 1000, 1],
                    ['tax_rate', '每邊期交稅率假設', 0, .01, .00001],
                ] as const).map(([key, label, min, max, step]) => <label className={s.field} key={key}>{label}<Input className={s.control} type="number" required min={min} max={max} step={step} value={Number.isFinite(draft[key]) ? draft[key] : ''} onChange={e => updateNumber(key, e.target.value)} /></label>)}</div>
            </fieldset>
            {lockedPlan && <p className={s.muted}>執行設定已固定；本日一旦有進場意圖，重新啟動也保留額度與原設定。</p>}
            <div className={s.actions}><Button size="compact" type="submit" disabled={!mayStart}>啟動／恢復 sandbox 策略</Button><Button size="compact" type="button" variant="outline" disabled={!!busy || !state?.id || !activeStatuses.has(state.status)} onClick={() => void control('pause')}>停止新倉</Button><Button size="compact" type="button" variant="destructive" disabled={!!busy || !state?.id || !activeStatuses.has(state.status)} onClick={() => void control('stop')}>停止並退出</Button><Button size="compact" type="button" variant="outline" disabled={!!busy || !state?.id || !activeStatuses.has(state.status)} onClick={() => void control('reconcile')}>重新對帳與接管監控</Button></div>
        </form>
        {busy && <p role="status">{busy}</p>}
        <p className={s.muted}>首 15 分鐘建立區間；09:20–13:10 只處理啟動後的新 5 分收盤訊號，每方向最多一次進場意圖，每次 1 口。限價 IOC 未成交也占用進場額度；13:20 嘗試退出。停損停利以進場限價為基準，由本機服務每 5 秒監控，沒有建立券商端保護單。</p>
        <p className={s.muted}>面板關閉、鎖定或心跳逾時 15 秒會停止新倉；服務在線時仍追蹤既有曝險。風控鎖會阻擋所有自動送單。退出最多嘗試三張已確認結果的 IOC；未知結果不重送。服務重啟後須手動恢復／對帳。</p>
        {state?.position && <div className={s.notice}>本策略成交推導：{state.position.side === 'Buy' ? '多' : '空'} 1 口 · 成交價 {amount(state.position.entryPrice)}<br />進場限價基準 {state.position.referencePrice} · 停損 {state.position.stop} · 停利 {state.position.target}<br />{state.monitoring ? '後端監控中' : '尚未接管退出監控，請重新對帳'}</div>}
        {state?.quote && <p className={s.muted}>最近報價 {amount(state.quote.price)} · {when(state.quote.time)}{state.quote.trial ? ' · 試撮' : ''}</p>}
        {state?.lastSignal && <div className={s.notice}>最近判斷 {when(state.lastSignal.time)} · {state.lastSignal.reason}<br />開盤區間 {amount(state.lastSignal.low)}～{amount(state.lastSignal.high)}{state.lastSignal.score !== null && ` · 籃子加權變化 ${(state.lastSignal.score * 100).toFixed(4)}%`}</div>}
        <h3 className={s.heading}>本策略委託</h3>
        <div className={s.scroll}><table className={s.table}><thead><tr><th>時間／識別碼</th><th>用途／方向</th><th>限價</th><th>狀態</th><th>確認成交</th><th>成交價</th></tr></thead><tbody>{state?.orders.map(o => <tr key={o.tag}><td>{when(o.submittedAt)}<br />{o.tag}</td><td>{o.role === 'entry' ? '進場' : '退出'} / {o.action === 'Buy' ? '買' : '賣'}</td><td>{o.limit}</td><td>{o.status}</td><td>{o.filled} 口</td><td>{o.filled ? amount(o.fillPrice) : '—'}</td></tr>)}{!state?.orders.length && <tr><td colSpan={6}>尚無策略委託。啟動後符合完整資料與風控條件才會送出測試單。</td></tr>}</tbody></table></div>
        <h3 className={s.heading}>執行紀錄</h3>
        <ul className={s.log}>{state?.events.map(e => <li key={e.id}><span className={s.muted}>{when(e.time)}</span><br />{e.message}</li>)}{!state?.events.length && <li>尚未啟動；設定與意圖會保存在本地資料庫。</li>}</ul>
        <p className={s.muted}>損益含設定的費率估計，不是券商帳務。共用測試帳戶的其他操作可能改變總庫存；本面板只根據自有識別碼的成交追蹤策略曝險。</p>
        {state?.status === 'attention' && <details><summary>已人工處理：封存本次追蹤</summary><p className={s.muted}>先到委託／持倉確認測試單與部位均已處理。封存只結束本機追蹤，不會撤單或平倉，本日也不能再次啟動。</p><label className={s.field}>輸入「已確認測試委託與部位」<Input className={s.control} value={acknowledgement} onChange={e => setAcknowledgement(e.target.value)} /></label><div className={s.actions}><Button size="compact" variant="outline" disabled={!!busy || acknowledgement !== '已確認測試委託與部位'} onClick={() => void control('archive')}>確認並封存</Button></div></details>}
    </section>;
}
