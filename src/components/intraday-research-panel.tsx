import { SelectControl, SelectOption } from './ui/select-control';
import { useEffect, useId, useRef, useState } from 'react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Textarea } from './ui/textarea';
import { apiGet } from '../lib/api';
import { fubonPost as researchPost } from '../lib/fubon-api-detail';
import { DEFAULT_RESEARCH_CONFIG, researchTradeStats, type ResearchComparison, type ResearchConfig, type ResearchDataset, type ResearchRun } from '../lib/intraday-research';
import * as s from './intraday-research.css';

type DatabaseStats = { bars: number; datasets: number; weights: number; runs: number; signals: number };
type SavedRun = { id: string; createdAt: string; datasetId: string; result: ResearchComparison };
type Latest = { time: number; price: number; source: string; weightedReturn: number | null; missing: string[]; elapsedMs: number };
const day = (offset = 0) => new Date(Date.now() + 8 * 3600000 - offset * 86400000).toISOString().slice(0, 10);
const cash = (n: number) => n.toLocaleString('zh-TW', { maximumFractionDigits: 0 });
const dateTime = (t: number) => new Date(t * 1000).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false });
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

function parseBasket(text: string) {
    return text.trim().split('\n').filter(l => l.trim()).map(line => {
        const [code, raw, ...extra] = line.trim().split(/[\s,，]+/);
        const weight = Number(raw) / 100;
        if (!code || !/^\d{4,6}$/.test(code) || !raw || extra.length || !(weight > 0 && weight <= 1)) throw new Error('每行請輸入股票代碼、權重百分比，例如 2330,40');
        return { code, weight };
    });
}

function EquityChart({ result }: { result: ResearchComparison }) {
    const all = [...result.baseline.equity, ...result.filtered.equity].map(p => p.value);
    const lo = Math.min(0, ...all), hi = Math.max(1, ...all);
    const points = (run: ResearchRun) => run.equity.map((p, i) => ({ ...p, i }))
        .filter(p => p.i % Math.max(1, Math.floor(run.equity.length / 1000)) === 0 || p.i === run.equity.length - 1)
        .map(p => `${10 + p.i / Math.max(1, run.equity.length - 1) * 780},${130 - (p.value - lo) / (hi - lo) * 115}`).join(' ');
    return <><p className={s.muted}>累計損益：灰線＝基準，強調色＝權值股濾網。縱軸範圍 NT$ {cash(lo)}～{cash(hi)}。</p>
        <svg className={s.chart} viewBox="0 0 800 150" role="img" aria-label="基準與權值股濾網累計損益比較">
            <polyline className={s.baseLine} points={points(result.baseline)} />
            <polyline className={s.filterLine} points={points(result.filtered)} />
        </svg></>;
}

function Results({ result }: { result: ResearchComparison }) {
    const [variant, setVariant] = useState<'baseline' | 'filtered'>('filtered');
    return <section aria-label="回測結果">
        <p className={s.notice}>{result.context.source === 'synthetic' ? '合成展示結果' : '富邦歷史情境回測'} · {result.context.product} {result.context.contractMonth} · {result.context.start}～{result.context.end}<br />固定假設權重 {result.context.weightDate} · {result.config.quantity} 口 · 停損 {result.config.stopPoints} 點 / {result.config.targetR}R · 每邊手續費 ${result.config.feePerSide} / 滑價 {result.config.slippagePoints} 點 / 稅率 {result.config.taxRate}</p>
        <h3 className={s.subhead}>同規則比較 · 開盤區間突破</h3>
        <div className={s.tableScroll}><table className={s.table}><thead><tr><th>版本</th><th>淨損益 NT$</th><th>平均每筆淨損益</th><th>平均贏／輸</th><th>獲利因子</th><th>成本</th><th>最大回撤</th><th>筆數</th><th>淨勝率</th></tr></thead>
            <tbody>{([['baseline', '基準'], ['filtered', '加入權值股濾網']] as const).map(([key, name]) => {
                const r = result[key];
                const stats = researchTradeStats(r.trades);
                const amount = (n: number | null) => n === null ? '—' : cash(n);
                return <tr key={key}><td>{name}</td><td>{cash(r.net)}</td><td>{amount(stats.meanNet)}</td><td>{amount(stats.averageWin)} / {amount(stats.averageLoss)}</td><td>{stats.profitFactor === null ? '—' : stats.profitFactor.toFixed(2)}</td><td>{cash(r.costs)}</td><td>{cash(r.maxDrawdown)}</td><td>{r.trades.length}</td><td>{r.winRate === null ? '—' : `${(r.winRate * 100).toFixed(1)}%`}</td></tr>;
            })}</tbody></table></div>
        <p className={s.muted}>金額單位 NT$；平均值與勝率只描述這份歷史樣本。獲利因子＝淨獲利總額／淨虧損總額，無虧損樣本時不計算。</p>
        <EquityChart result={result} />
        <p className={s.muted}>完整日 {result.diagnostics.completeDays}；排除缺段日 {result.diagnostics.excludedDays.length}；權值股缺資料時點 {result.diagnostics.missingBasketTimes}；濾網拒絕 {result.diagnostics.filterRejected} 次。</p>
        {result.diagnostics.excludedDays.length > 0 && <p className={s.muted}>缺段日期：{result.diagnostics.excludedDays.join('、')}</p>}
        <details><summary>假設與驗證範圍</summary><ul>{result.warnings.map(w => <li key={w}>{w}</li>)}</ul></details>
        <div className={s.actions}><Button size="compact" variant={variant === 'baseline' ? 'secondary' : 'outline'} onClick={() => setVariant('baseline')}>基準明細</Button><Button size="compact" variant={variant === 'filtered' ? 'secondary' : 'outline'} onClick={() => setVariant('filtered')}>濾網明細</Button></div>
        <div className={s.tableScroll}><table className={s.table}><thead><tr><th>方向／進場</th><th>出場</th><th>進／出價</th><th>淨損益</th><th>原因</th></tr></thead><tbody>
            {result[variant].trades.map((t, i) => <tr key={i}><td>{t.side === 'long' ? '多' : '空'} {dateTime(t.entryTime)}</td><td>{dateTime(t.exitTime)}</td><td>{t.entry.toFixed(2)} / {t.exit.toFixed(2)}</td><td>{cash(t.net)}</td><td>{t.reason}</td></tr>)}
            {!result[variant].trades.length && <tr><td colSpan={5}>此設定沒有成交；可檢查資料完整度與進場條件。</td></tr>}
        </tbody></table></div>
    </section>;
}

export function IntradayResearchPanel() {
    const id = useId();
    const [product, setProduct] = useState('TMF');
    const [month, setMonth] = useState(day().slice(0, 7).replace('-', ''));
    const [start, setStart] = useState(day(10)), [end, setEnd] = useState(day(1));
    const [basket, setBasket] = useState('2330,40\n2454,4\n2317,2\n2881,1');
    const [weightDate, setWeightDate] = useState(day());
    const [config, setConfig] = useState<ResearchConfig>({ ...DEFAULT_RESEARCH_CONFIG });
    const [dataset, setDataset] = useState<ResearchDataset | null>(null);
    const [result, setResult] = useState<ResearchComparison | null>(null);
    const [stats, setStats] = useState<DatabaseStats | null>(null);
    const [records, setRecords] = useState<SavedRun[]>([]);
    const [latest, setLatest] = useState<Latest | null>(null);
    const [busy, setBusy] = useState(''), [error, setError] = useState('');
    const worker = useRef<Worker | null>(null);
    const alive = useRef(true);
    const refreshRecords = async () => {
        const [db, runs] = await Promise.all([apiGet<DatabaseStats>('/api/v1/research/database'), apiGet<SavedRun[]>('/api/v1/research/runs')]);
        if (alive.current) { setStats(db); setRecords(runs); }
    };
    useEffect(() => { alive.current = true; void refreshRecords().catch(e => { if (alive.current) setError(message(e)); }); return () => { alive.current = false; worker.current?.terminate(); }; }, []);
    const invalidate = () => { setDataset(null); setResult(null); setLatest(null); };
    const load = async (offline = false, refresh = false) => {
        setBusy(offline ? '讀取本地資料庫…' : '下載並保存歷史資料…'); setError(''); setResult(null); setDataset(null); setLatest(null);
        try {
            const data = await researchPost<ResearchDataset>('/api/v1/research/history', { product, contract_month: month, start, end, basket: parseBasket(basket), weight_date: weightDate, offline, refresh }, 120_000);
            if (!alive.current) return;
            setDataset(data); await refreshRecords();
        } catch (e) { if (alive.current) setError(message(e)); }
        finally { if (alive.current) setBusy(''); }
    };
    const analyze = async () => {
        if (!dataset) return;
        setBusy('查詢本地資料庫…'); setError('');
        try { const value = await researchPost<Latest>('/api/v1/research/latest', { datasetId: dataset.id }); if (alive.current) setLatest(value); }
        catch (e) { if (alive.current) setError(message(e)); }
        finally { if (alive.current) setBusy(''); }
    };
    const run = () => {
        if (!dataset) return;
        setBusy('本地回測中…'); setError(''); setResult(null);
        try {
            const w = new Worker(new URL('../lib/intraday-research-worker.ts', import.meta.url), { type: 'module' });
            worker.current = w;
            w.onerror = () => { w.terminate(); if (alive.current) { setBusy(''); setError('回測執行失敗，請重新執行'); } };
            w.onmessage = async (event: MessageEvent<{ result?: ResearchComparison; error?: string }>) => {
                w.terminate(); worker.current = null;
                if (!alive.current) return;
                if (event.data.error || !event.data.result) { setError(event.data.error ?? '沒有回測結果'); setBusy(''); return; }
                setResult(event.data.result);
                try { await researchPost('/api/v1/research/runs', { datasetId: dataset.id, result: event.data.result }); await refreshRecords(); }
                catch (e) { if (alive.current) setError(`結果已計算，但保存失敗：${message(e)}`); }
                finally { if (alive.current) setBusy(''); }
            };
            w.postMessage({ dataset, config });
        } catch (e) { setError(message(e)); setBusy(''); }
    };
    const exportData = () => {
        if (!dataset) return;
        const url = URL.createObjectURL(new Blob([JSON.stringify({ dataset, result }, null, 2)], { type: 'application/json' }));
        const link = document.createElement('a'); link.href = url; link.download = `intraday-${dataset.product}-${dataset.start}-${dataset.end}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    };
    return <div className={s.wrap} aria-label="日內回測研究">
        <div className={s.heading}><h2 className={s.title}>權值股 × 微台 · 日內研究</h2><span className={s.muted}>SQLite 本地資料庫</span></div>
        <p className={s.muted}>以歷史 1 分 K 比較「單看期貨」與「加入權值股方向」。先載入資料，再離線判讀與回測。</p>
        <div className={s.notice}>起始規則：09:00–09:15 開盤區間，5 分收盤突破，下一根 1 分開盤模擬進場；13:10 後不開新倉，13:20 平倉。兩組皆使用權值股資料可用的共同時點。</div>
        <fieldset disabled={!!busy} style={{ border: 0, padding: 0, margin: 0 }}>
            <div className={s.grid}>
                <label className={s.field}>期貨商品<SelectControl aria-label="期貨商品" wrapperClassName="w-full" disabled={!!busy} className={s.input} value={product} onValueChange={selectedValue => { setProduct(selectedValue); invalidate(); }}><SelectOption value="TMF">微台 TMF · 每點 $10</SelectOption><SelectOption value="MXF">小台 MXF · 每點 $50</SelectOption><SelectOption value="TXF">大台 TXF · 每點 $200</SelectOption></SelectControl></label>
                <label className={s.field}>具體合約月份<Input value={month} maxLength={6} placeholder="202611" onChange={e => { setMonth(e.target.value); invalidate(); }} /></label>
                <label className={s.field}>開始日期<Input type="date" value={start} max={day(1)} onChange={e => { setStart(e.target.value); invalidate(); }} /></label>
                <label className={s.field}>結束日期<Input type="date" value={end} max={day(1)} onChange={e => { setEnd(e.target.value); invalidate(); }} /></label>
            </div>
            <label className={s.field} htmlFor={`${id}-weights`}>固定假設權重 · 每行「股票代碼,百分比」<Textarea id={`${id}-weights`} rows={4} value={basket} onChange={e => { setBasket(e.target.value); invalidate(); }} /></label>
            <p className={s.muted}>預填數字只是假設範例，不是官方歷史權重。資料庫會保存版本；過去成分與權重尚未驗證，因此結果屬探索性情境。</p>
            <label className={s.field} style={{ maxWidth: 200 }}>權重版本日期<Input type="date" value={weightDate} onChange={e => { setWeightDate(e.target.value); invalidate(); }} /></label>
            <div className={s.actions}><Button size="compact" onClick={() => void load()}>下載／載入資料</Button><Button size="compact" variant="outline" onClick={() => void load(true)}>只讀本地資料庫</Button><Button size="compact" variant="ghost" onClick={() => void load(false, true)}>重新下載</Button></div>
            <div className={s.grid}>{([
                ['stopPoints', '停損點數', 1], ['targetR', '停利 R 倍數', .5], ['quantity', '口數', 1],
                ['feePerSide', '每口單邊手續費 NT$', 1], ['slippagePoints', '每邊不利滑價點數', 1], ['taxRate', '每邊期交稅率', .00001],
            ] as const).map(([key, label, step]) => <label className={s.field} key={key}>{label}<Input type="number" step={step} min={key === 'quantity' || key === 'stopPoints' || key === 'targetR' ? step : 0} value={Number.isFinite(config[key]) ? config[key] : ''} onChange={e => { setConfig(old => ({ ...old, [key]: e.target.value === '' ? NaN : Number(e.target.value) })); setResult(null); }} /></label>)}</div>
            <p className={s.muted}>成本欄為試算假設，請依實際費率調整；不含保證金與市場衝擊。</p>
            <div className={s.actions}><Button size="compact" disabled={!dataset} onClick={run}>比較回測</Button><Button size="compact" variant="outline" disabled={!dataset} onClick={() => void analyze()}>快速判讀本地資料</Button><Button size="compact" variant="outline" disabled={!dataset} onClick={exportData}>匯出資料與結果</Button></div>
        </fieldset>
        {busy && <p role="status">{busy}</p>}
        {error && <p role="alert" className={s.error}>{error}</p>}
        {stats && <p className={s.muted}>本地保存 {stats.bars.toLocaleString()} 根 K 棒 · {stats.weights} 個權重版本 · {stats.runs} 份回測 · {stats.signals} 個決策時點</p>}
        {dataset && <div className={s.notice}>{dataset.source === 'synthetic' ? '合成展示資料：僅驗證流程，不代表真實績效。' : `富邦歷史資料（${dataset.source}）`}<br />{dataset.product} {dataset.contractMonth} · {dataset.start}～{dataset.end} · {dataset.futures.length.toLocaleString()} 根期貨 K 棒 · 快取命中 {dataset.cacheHits}/{dataset.assetCount}<br />資料版本 {dataset.id.slice(0, 12)}</div>}
        {latest && <div className={s.notice}><strong>歷史資料判讀 · 不是即時訊號</strong><br />資料時間 {dateTime(latest.time)} · 期貨 {latest.price.toFixed(0)}<br />{latest.weightedReturn === null ? `資料不足：${latest.missing.join('、')}` : `權值股近 5 分鐘加權變化 ${(latest.weightedReturn * 100).toFixed(4)}%（固定籃子對指數的估計貢獻）`}<br />本地讀取與計算 {latest.elapsedMs} ms</div>}
        {result && <Results result={result} />}
        <h3 className={s.subhead}>最近保存的回測</h3>
        <div className={s.records}>{records.map(r => <Button size="compact" className={s.recordButton} variant="outline" key={r.id} disabled={!!busy} onClick={() => { setResult(r.result); setDataset(null); setLatest(null); setError(''); }}>{new Date(r.createdAt).toLocaleString('zh-TW')} · 基準 {cash(r.result.baseline.net)} / 濾網 {cash(r.result.filtered.net)}</Button>)}{!records.length && <p className={s.muted}>完成比較後會自動保存結果，重新開啟仍可查看。</p>}</div>
    </div>;
}
