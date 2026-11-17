import { SelectControl, SelectOption } from './ui/select-control';
import { useEffect, useRef, useState } from 'react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Textarea } from './ui/textarea';
import { PaperLedger } from './paper-ledger';
import { AutoModelField } from './auto-model-field';
import { ContractFeeNote } from './contract-fee-note';
import { getContractFee, useContractFee } from '../lib/contract-fee';
import { apiGet } from '../lib/api';
import { fubonPost } from '../lib/fubon-api-detail';
import { autoAccountKey, AUTO_STATUS, initialAutoConfig, nextAutoTradeDate, parseAutoBasket, type AutoAccount, type AutoConfig, type AutoState } from '../lib/auto-trading';
import { SESSION_LABEL, SESSION_RULE, type StrategySession } from '../lib/strategy-session';
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
    const fee = useContractFee('TMF');
    const accept = (next: AutoState) => {
        if (!alive.current) return;
        setState(next);
        if (next.config && loadedId.current !== next.id) {
            const savedFee = getContractFee('TMF');
            const mayApplyFee = !next.config.model_run_id && !next.entryCount && !next.pending && !next.position && !activeStatuses.has(next.status);
            setDraft({ ...next.config, ...(savedFee && mayApplyFee ? { fee_per_side: savedFee.feePerSide, fee_source: 'statement' as const } : {}) });
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
    const control = async (command: 'pause' | 'stop' | 'reconcile' | 'archive' | 'flatten') => {
        if (!state?.id) return;
        setBusy('正在套用控制…'); setError('');
        try { accept(await fubonPost<AutoState>('/api/v1/automation/control', { command, run_id: state.id, acknowledgement: command === 'flatten' ? '確認退出 paper 策略部位' : acknowledgement, execution_allowed: !getRiskSettings().locked }, 45000)); setAcknowledgement(''); }
        catch (e) { if (alive.current) setError(message(e)); }
        finally { if (alive.current) setBusy(''); }
    };
    const runningOrExposed = !!state && (!!state.pending || !!state.position || state.status === 'running' || state.status === 'stopping');
    const lockedPlan = runningOrExposed || !!state && state.entryCount > 0 && draft.trade_date === state.config?.trade_date && (draft.strategy_session ?? 'cash') === (state.config?.strategy_session ?? 'cash');
    const editable = !busy && !lockedPlan;
    const globalBlock = checkOrderAllowed(1);
    const mayStart = !!state?.available && !!draft.account.account_id && !busy && !globalBlock && !state.pending && !state.position && !['running', 'stopping'].includes(state.status);
    useEffect(() => {
        if (fee && editable && !draft.model_run_id && (!state?.entryCount || draft.trade_date !== state.config?.trade_date) && !activeStatuses.has(state?.status ?? 'idle')) setDraft(old => ({ ...old, fee_per_side: fee.feePerSide, fee_source: 'statement' }));
    }, [fee, editable, state?.entryCount, state?.status, state?.config?.trade_date, draft.trade_date, draft.model_run_id]);
    const applyFee = (value: number) => setDraft(old => ({ ...old, fee_per_side: value, fee_source: 'statement' }));
    const updateNumber = (key: keyof AutoConfig, value: string) => setDraft(old => ({ ...old, [key]: value === '' ? NaN : Number(value), ...(key === 'fee_per_side' ? { fee_source: Number(value) === fee?.feePerSide ? 'statement' as const : 'assumed' as const } : {}) }));
    const paper = state?.mode === 'paper';
    const choices = accounts.filter(a => !paper || a.account_id === 'PAPER-AUTO-F');
    useEffect(() => {
        const account = accounts.find(a => a.account_id === 'PAPER-AUTO-F');
        if (paper && !state?.config && account) setDraft(old => old.account.account_id === 'PAPER-AUTO-F' ? old : { ...old, account });
    }, [paper, state?.config, accounts]);
    return <section className={s.wrap} aria-label={paper ? 'Paper 自動交易' : 'Sandbox 自動交易'}>
        <div className={s.header}><h2 className={s.title}>自動交易 · 微台日／夜盤</h2><span className={`${s.status} ${state?.status === 'attention' ? s.warning : ''}`}>{state ? AUTO_STATUS[state.status] : '讀取狀態…'}</span></div>
        <p className={s.muted}>{paper ? 'Paper 正式行情／本機模擬委託' : '官方 sandbox 日盤測試委託'} · 單口、單一部位 · {SESSION_LABEL[draft.strategy_session ?? 'cash']}</p>
        <p className={s.notice}><strong>策略驗證：研究中</strong><br />已檢查收盤訊號、缺漏資料與執行風控；已加入固定成本壓力情境，仍未通過穩健性檢查；尚缺獨立樣本外與盤中前測。啟動僅用於 paper／sandbox 流程測試，不代表已通過獲利驗證。</p>
        {state && !state.available && <p role="status" className={s.notice}>目前為 {state.mode}。此面板支援 paper 本機模擬或官方 sandbox 日盤，正式交易不可啟動。</p>}
        <div className={s.notice} role="status"><strong>{state?.reason ?? '正在連線'}</strong><br />{state?.owned ? `本分頁持有控制權 · 心跳剩餘 ${state.leaseSeconds} 秒` : state?.id && activeStatuses.has(state.status) ? '此分頁可停止或對帳；尚未持有新倉控制權。' : '啟動前不會產生委託。'}</div>
        {globalBlock && <p className={s.warning}>新倉受風控限制：{globalBlock}</p>}
        {risk.locked && <p className={s.warning}>風控鎖定也會阻擋自動退出送單；已有曝險時請人工確認。</p>}
        {syncError && <p role="alert" className={s.warning}>{syncError}</p>}
        {error && <p role="alert" className={s.warning}>{error}</p>}
        {paper && <PaperLedger />}
        <div className={s.metrics}>
            <div className={s.metric}>進場委託次數<strong className={s.number}>{state?.entryCount ?? 0} / {state?.config?.max_entries ?? draft.max_entries}</strong></div>
            <div className={s.metric}>本策略追蹤曝險<strong className={s.number}>{state?.position ? `${state.position.side === 'Buy' ? '多' : '空'} ${state.position.quantity} 口` : state?.pending ? '委託待確認' : '無'}</strong></div>
            <div className={s.metric}>估計已實現淨損益<strong className={s.number}>${amount(state?.realizedNet)}</strong></div>
            <div className={s.metric}>估計未實現淨損益<strong className={s.number}>{state?.position ? `$${amount(state.unrealizedNet)}` : '—'}</strong></div>
        </div>
        <form onSubmit={e => { e.preventDefault(); void start(); }}>
            <label className={`${s.field} ${s.dateField}`}>實際開盤日期（夜盤為15:00所在日）<Input className={s.control} type="date" required disabled={!!busy || runningOrExposed} value={draft.trade_date} onChange={e => setDraft(old => ({ ...old, trade_date: e.target.value }))} /></label>
            <label className={s.field}>策略盤別<SelectControl aria-label="策略盤別" value={draft.strategy_session ?? 'cash'} disabled={!!busy || runningOrExposed} onValueChange={value => setDraft(old => ({ ...old, strategy_session: value as StrategySession, trade_date: nextAutoTradeDate(Date.now(), value as StrategySession), model_run_id: null, decision_minutes: 5, use_basket: false }))} wrapperClassName="w-full">{Object.entries(SESSION_LABEL).map(([key,label]) => <SelectOption key={key} value={key} disabled={key === 'afterhours' && !paper}>{label}</SelectOption>)}</SelectControl></label>
            <p className={s.muted}>{SESSION_RULE[draft.strategy_session ?? 'cash']}請在上方交易模式設定選擇相同的行情盤別；同一時間只執行一份計畫。</p>
            <fieldset className={s.fieldset} disabled={!editable}>
                <legend className={s.heading}>策略與執行設定</legend>
                <div className={s.grid}>
                    <label className={s.field}>{paper ? '策略模擬帳戶' : '期貨測試帳戶'}<SelectControl aria-label={paper ? '策略模擬帳戶' : '期貨測試帳戶'} wrapperClassName="w-full" disabled={!editable} className={s.control} value={autoAccountKey(draft.account)} onValueChange={selectedValue => { const a = accounts.find(a => autoAccountKey(a) === selectedValue); if (a) setDraft(old => ({ ...old, account: a })); }}><SelectOption value=":">選擇帳戶</SelectOption>{choices.map(a => <SelectOption key={autoAccountKey(a)} value={autoAccountKey(a)}>{a.broker_id}-{a.account_id}</SelectOption>)}</SelectControl></label>
                    <label className={s.field}>微台具體合約<Input className={s.control} value={draft.contract_code} required pattern="TMF[A-L][0-9]" placeholder="TMFK6" onChange={e => setDraft(old => ({ ...old, contract_code: e.target.value.toUpperCase() }))} /></label>
                    <label className={s.field}>權值股濾網<SelectControl aria-label="權值股濾網" wrapperClassName="w-full" disabled={!editable || !!draft.model_run_id || (draft.strategy_session ?? 'cash') !== 'cash'} className={s.control} value={draft.use_basket ? 'basket' : 'baseline'} onValueChange={selectedValue => setDraft(old => ({ ...old, use_basket: selectedValue === 'basket' }))}><SelectOption value="baseline">開盤區間突破</SelectOption><SelectOption value="basket">突破＋權值股方向濾網</SelectOption></SelectControl></label>
                    <label className={s.field}>策略版本<SelectControl aria-label="策略版本" wrapperClassName="w-full" disabled={!editable || !!draft.model_run_id} className={s.control} value={draft.strategy_version ?? 'orb_v1'} onValueChange={value => setDraft(old => ({ ...old, strategy_version: value as AutoConfig['strategy_version'] }))}><SelectOption value="orb_v1">V1 固定停損</SelectOption><SelectOption value="orb_atr_v2">V2 波動風控（研究候選）</SelectOption></SelectControl></label>
                </div>
                <AutoModelField draft={draft} setDraft={setDraft} editable={editable} />
                {draft.strategy_version === 'orb_atr_v2' && <p className={s.muted}>V2：停損取設定下限與 1 分 Wilder ATR14 × 1.5 的較大值，停利沿用設定比例；進場後固定距離。缺資料、偏離訊號逾 10 點或含費稅風險超出剩餘預算時跳過。</p>}
                {draft.use_basket && <><label className={s.field}>固定假設權重 · 每行「股票代碼,百分比」<Textarea className={s.control} rows={4} value={basketText} onChange={e => setBasketText(e.target.value)} /></label><p className={s.muted}>固定假設範例，不是官方歷史權重；這個濾網尚未證明能改善收益。</p></>}
                <div className={s.grid}>{([
                    ['stop_points', '停損距離（點）', 1, 1000, 1], ['target_points', '停利距離（點）', 1, 2000, 1],
                    ['slippage_points', 'IOC 限價距離買賣價（點）', 0, 10, 1], ['max_entries', '本日進場委託上限', 1, 2, 1],
                    ['loss_limit', '停止新倉的估計損失門檻 NT$', 10, 100000, 10], ['fee_per_side', '每口單邊手續費 NT$', 0, 1000, 1],
                    ['tax_rate', '每邊期交稅率假設', 0, .01, .00001],
                ] as const).map(([key, label, min, max, step]) => <label className={s.field} key={key}>{label}<Input className={s.control} type="number" required disabled={!!draft.model_run_id} min={min} max={max} step={step} value={Number.isFinite(draft[key]) ? draft[key] : ''} onChange={e => updateNumber(key, e.target.value)} /></label>)}</div>
                <div className={s.muted}><ContractFeeNote product="TMF" value={draft.fee_per_side} disabled={!editable || !!draft.model_run_id} onApply={applyFee} />本計畫成本來源：{draft.fee_source === 'statement' ? '對帳單核對費率' : '試算假設'}。有進場意圖後保留原成本設定。</div>
            </fieldset>
            {lockedPlan && <p className={s.muted}>執行設定已固定；本日一旦有進場意圖，重新啟動也保留額度與原設定。</p>}
            <div className={s.actions}><Button size="compact" type="submit" disabled={!mayStart}>啟動／恢復 {paper ? 'paper' : 'sandbox'} 策略</Button><Button size="compact" type="button" variant="outline" disabled={!!busy || !state?.id || !activeStatuses.has(state.status)} onClick={() => void control('pause')}>停止新倉</Button><Button size="compact" type="button" variant="destructive" disabled={!!busy || !state?.id || !activeStatuses.has(state.status)} onClick={() => void control('stop')}>停止並退出</Button><Button size="compact" type="button" variant="outline" disabled={!!busy || !state?.id || !activeStatuses.has(state.status)} onClick={() => void control('reconcile')}>重新對帳與接管監控</Button></div>
        </form>
        {busy && <p role="status">{busy}</p>}
        <p className={s.muted}>首 15 分鐘建立區間，只處理啟動後的新 {draft.decision_minutes ?? 5} 分收盤訊號，每方向每盤最多一次進場意圖，每次 1 口。日盤與夜盤分開計額度，午夜不重設；限價 IOC 未成交也占用額度。模型計畫限訊號後20分鐘，並在所選盤別退出期限嘗試退出。停損停利以確認成交價為基準，由本機服務每 5 秒監控，沒有建立券商端保護單。</p>
        <p className={s.muted}>面板關閉、鎖定或心跳逾時 15 秒會停止新倉；服務在線時仍追蹤既有曝險。風控鎖會阻擋所有自動送單。退出最多嘗試三張已確認結果的 IOC；未知結果不重送。服務重啟後須手動恢復／對帳。</p>
        {state?.position && <div className={s.notice}>本策略成交推導：{state.position.side === 'Buy' ? '多' : '空'} 1 口 · 成交價 {amount(state.position.entryPrice)}<br />{state.position.referenceType === 'fill' ? '確認成交價基準' : '限價暫估／舊計畫基準'} {state.position.referencePrice} · 停損 {state.position.stop} · 停利 {state.position.target}<br />{state.monitoring ? '後端監控中' : '尚未接管退出監控，請重新對帳'}</div>}
        {paper && state?.position && <div className={s.actions}><Button size="compact" variant="destructive" disabled={!!busy || risk.locked || !!state.pending} onClick={() => void control('flatten')}>確認退出保存的 paper 策略部位</Button><p className={s.muted}>可處理隔日保留的部位，僅使用原具體合約與所選盤別的新鮮行情；不恢復新倉。</p></div>}
        {state?.quote && <p className={s.muted}>最近報價 {amount(state.quote.price)} · {when(state.quote.time)}{state.quote.trial ? ' · 試撮' : ''}</p>}
        {state?.position?.exitDeadline && <p className={s.muted}>模型訊號退出期限：{when(state.position.exitDeadline)}</p>}
        {state?.lastSignal?.model && <p className={s.muted}>模型 {state.lastSignal.model.runId.slice(0, 12)} · 分數 {state.lastSignal.model.score?.toFixed(3) ?? '無法計算'} / 門檻 {state.lastSignal.model.threshold} · {state.lastSignal.model.accepted ? '保留訊號' : '跳過進場'}</p>}
        {state?.lastSignal && <div className={s.notice}>最近判斷 {when(state.lastSignal.time)} · {state.lastSignal.reason}<br />開盤區間 {amount(state.lastSignal.low)}～{amount(state.lastSignal.high)}{state.lastSignal.score !== null && ` · 籃子加權變化 ${(state.lastSignal.score * 100).toFixed(4)}%`}</div>}
        <h3 className={s.heading}>本策略委託</h3>
        <div className={s.scroll}><table className={s.table}><thead><tr><th>時間／識別碼</th><th>用途／方向</th><th>限價</th><th>狀態</th><th>確認成交</th><th>成交價</th></tr></thead><tbody>{state?.orders.map(o => <tr key={o.tag}><td>{when(o.submittedAt)}<br />{o.tag}</td><td>{o.role === 'entry' ? '進場' : '退出'} / {o.action === 'Buy' ? '買' : '賣'}</td><td>{o.limit}</td><td>{o.status}</td><td>{o.filled} 口</td><td>{o.filled ? amount(o.fillPrice) : '—'}</td></tr>)}{!state?.orders.length && <tr><td colSpan={6}>尚無策略委託。啟動後符合完整資料與風控條件才會送出測試單。</td></tr>}</tbody></table></div>
        <h3 className={s.heading}>執行紀錄</h3>
        <ul className={s.log}>{state?.events.map(e => <li key={e.id}><span className={s.muted}>{when(e.time)}</span><br />{e.message}</li>)}{!state?.events.length && <li>尚未啟動；設定與意圖會保存在本地資料庫。</li>}</ul>
        <p className={s.muted}>損益含設定的費率估計，不是券商帳務。{paper ? 'Paper 使用策略專用模擬帳戶，費稅按凍結設定保存；手動單不影響策略部位。' : '共用測試帳戶的其他操作可能改變總庫存；本面板只根據自有識別碼的成交追蹤策略曝險。'}</p>
        {state?.status === 'attention' && <details><summary>已人工處理：封存本次追蹤</summary><p className={s.muted}>先到委託／持倉確認模擬委託與部位均已處理。封存只結束本機追蹤，不會撤單或平倉，本日也不能再次啟動。</p><label className={s.field}>輸入「已確認測試委託與部位」<Input className={s.control} value={acknowledgement} onChange={e => setAcknowledgement(e.target.value)} /></label><div className={s.actions}><Button size="compact" variant="outline" disabled={!!busy || acknowledgement !== '已確認測試委託與部位'} onClick={() => void control('archive')}>確認並封存</Button></div></details>}
    </section>;
}
