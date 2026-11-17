import { useEffect, useRef, useState } from 'react';
import { apiGet } from '../lib/api';
import { fubonPost } from '../lib/fubon-api-detail';
import type { ResearchConfig } from '../lib/intraday-research';
import type { LearningOverview, LearningReport, LearningJob } from '../lib/learning';
import { FEATURE_SET_LABEL, type LearningFeatureSet } from '../lib/learning';
import { SESSION_LABEL, SESSION_RULE, type StrategySession } from '../lib/strategy-session';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { SelectControl, SelectOption } from './ui/select-control';
import { IntradayLearningResults } from './intraday-learning-results';
import * as s from './intraday-research.css';

const day = (offset: number) => new Date(Date.now() + 8 * 3600000 - offset * 86400000).toISOString().slice(0, 10);
const describe = (e: unknown) => e instanceof Error ? e.message : String(e);
export function IntradayLearningPanel({ config }: { config: ResearchConfig }) {
    const [session, setSession] = useState<StrategySession>('regular');
    const [method, setMethod] = useState<'fixed' | 'walkforward'>('walkforward');
    const [featureSet, setFeatureSet] = useState<LearningFeatureSet>('mtf_1_3_15');
    const [start, setStart] = useState(day(180)), [end, setEnd] = useState(day(1));
    const [overview, setOverview] = useState<LearningOverview | null>(null);
    const [datasetId, setDatasetId] = useState(''), [runId, setRunId] = useState('');
    const [report, setReport] = useState<LearningReport | null>(null);
    const [error, setError] = useState(''), [submitting, setSubmitting] = useState(false);
    const seenJob = useRef('');
    useEffect(() => {
        let disposed = false, timer: ReturnType<typeof setTimeout>;
        const poll = async () => {
            try {
                const data = await apiGet<LearningOverview>('/api/v1/research/learning');
                if (disposed) return;
                setOverview(data);
                setDatasetId(old => old || data.datasets[0]?.id || '');
                setRunId(old => old || data.runs[0]?.id || '');
                const job = data.jobs[0];
                if (job?.status === 'completed' && job.resultId && seenJob.current !== job.id) {
                    seenJob.current = job.id;
                    if (job.action === 'collect') setDatasetId(job.resultId);
                    else setRunId(job.resultId);
                }
                timer = setTimeout(() => void poll(), 2000);
            } catch (e) { if (!disposed) { setError(`研究狀態更新失敗：${describe(e)}`); timer = setTimeout(() => void poll(), 10000); } }
        };
        void poll();
        return () => { disposed = true; clearTimeout(timer); };
    }, []);
    useEffect(() => {
        if (!runId) return;
        let disposed = false;
        setReport(null);
        void apiGet<LearningReport>(`/api/v1/research/learning/runs/${runId}`).then(value => { if (!disposed) setReport(value); }).catch(e => { if (!disposed) setError(describe(e)); });
        return () => { disposed = true; };
    }, [runId]);
    const running = submitting || !!overview?.jobs.some(j => j.status === 'running');
    const dataset = overview?.datasets.find(d => d.id === datasetId);
    const sessionDatasets = overview?.datasets.filter(d => (d.strategySession ?? 'cash') === session) ?? [];
    useEffect(() => {
        setDatasetId(old => sessionDatasets.some(d => d.id === old) ? old : sessionDatasets[0]?.id ?? '');
    }, [overview, session]);
    const launch = async (action: 'collect' | 'train') => {
        setSubmitting(true); setError('');
        try {
            const job = await fubonPost<LearningJob>(`/api/v1/research/learning/${action}`, action === 'collect' ? { start, end, session } : { dataset_id: datasetId, config, method, feature_set: featureSet });
            setOverview(old => old ? { ...old, jobs: [job, ...old.jobs.filter(j => j.id !== job.id)].slice(0, 6) } : { datasets: [], runs: [], jobs: [job], databaseBytes: 0 });
        } catch (e) { setError(describe(e)); }
        finally { setSubmitting(false); }
    };
    const exportModel = async () => {
        if (!report?.model) return;
        try {
            const data = await apiGet<{ model: string }>(`/api/v1/research/learning/models/${report.id}`);
            const url = URL.createObjectURL(new Blob([data.model], { type: 'text/plain' }));
            const link = document.createElement('a'); link.href = url; link.download = `lightgbm-${report.id.slice(0, 12)}.txt`; link.click();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
        } catch (e) { setError(describe(e)); }
    };
    return <section aria-label="LightGBM 模型研究">
        <h3 className={s.subhead}>LightGBM · 微台訊號研究</h3>
        <label className={s.field}>研究盤別<SelectControl aria-label="研究盤別" value={session} onValueChange={value => setSession(value as StrategySession)} disabled={running} wrapperClassName="w-full">{Object.entries(SESSION_LABEL).map(([key,label]) => <SelectOption key={key} value={key}>{label}</SelectOption>)}</SelectControl></label>
        <p className={s.muted}>{SESSION_RULE[session]}{session === 'cash' ? '使用四檔股票同步特徵。' : '使用期貨價量與波動特徵，不依賴同步現貨。'}</p>
        <label className={s.field}>訓練方法<SelectControl aria-label="訓練方法" value={method} onValueChange={value => setMethod(value as typeof method)} disabled={running} wrapperClassName="w-full"><SelectOption value="walkforward">滾動研究：分類／淨收益與6個固定門檻</SelectOption><SelectOption value="fixed">固定分類：0.5門檻</SelectOption></SelectControl></label>
        <label className={s.field}>特徵與判斷頻率<SelectControl aria-label="特徵與判斷頻率" value={featureSet} onValueChange={value => setFeatureSet(value as LearningFeatureSet)} disabled={running} wrapperClassName="w-full">{Object.entries(FEATURE_SET_LABEL).map(([key,label]) => <SelectOption key={key} value={key}>{label}</SelectOption>)}</SelectControl></label>
        <p className={s.muted}>{featureSet === 'mtf_1_3_15' ? '由既有1分K聚合1／3／15分特徵，從各盤開盤時間對齊，只取已收盤K棒；每1分鐘判斷突破。回測與Paper使用相同資料與頻率。' : '保留原版5分突破與5／15分鐘報酬特徵，供獨立對照。'} 此設定會保存於模型版本。</p>
        <p className={s.notice}>以完整開盤日按60/20/20訓練／驗證／測試；滾動研究只在前80%內做三段因果驗證、比較6個預定候選，再固定候選並用前60%訓練最終模型。測試期不參與選擇；全部嘗試保存。重訓不啟動或替換自動交易策略。</p>
        <div className={s.grid}>
            <label className={s.field}>訓練歷史開始日期<Input type="date" min="2024-07-29" max={end} disabled={running} value={start} onChange={e => setStart(e.target.value)} /></label>
            <label className={s.field}>訓練歷史結束日期<Input type="date" min={start} max={day(1)} disabled={running} value={end} onChange={e => setEnd(e.target.value)} /></label>
        </div>
        <div className={s.actions}><Button size="compact" disabled={running} onClick={() => void launch('collect')}>分批下載歷史資料</Button></div>
        <p className={s.muted}>TMF近月連續合約；每批最多31天，整段最多1096天，自2024-07-29上市日起。起訖日期為官方查詢交易日，夜盤歸屬次一交易日；報告切分以實際開盤日分組。保留逐根實際月份，缺漏不補價，快取可續傳。</p>
        <label className={s.field}>訓練資料版本<SelectControl aria-label="訓練資料版本" value={datasetId} onValueChange={setDatasetId} disabled={running} className={s.input} wrapperClassName="w-full"><SelectOption value="">選擇已保存資料</SelectOption>{sessionDatasets.map(d => <SelectOption value={d.id} key={d.id}>{SESSION_LABEL[d.strategySession ?? 'cash']} · {d.start}～{d.end} · {d.completeDays}完整盤 · {d.id.slice(0, 8)}</SelectOption>)}</SelectControl></label>
        {dataset && <div className={s.notice}>{SESSION_LABEL[dataset.strategySession ?? 'cash']} · {dataset.source} · {dataset.futuresBars.toLocaleString()} 根期貨K · {dataset.completeDays}完整盤<br />實際開盤日 {dataset.openingStart ?? dataset.start}～{dataset.openingEnd ?? dataset.end}<br />實際月份 {dataset.contracts.join('、')} · 缺段盤 {dataset.excludedDays.length} · 整日無資料平日 {dataset.absentWeekdays.length}（休市未自動核對）</div>}
        {dataset && <details><summary>資料品質明細</summary><p className={s.muted}>缺段日期：{dataset.excludedDays.join('、') || '無'}<br />整日無資料平日（待核對休市）：{dataset.absentWeekdays.join('、') || '無'}<br />股票K棒：{Object.entries(dataset.stockBars).map(([code, count]) => `${code} ${count}`).join('、')}</p></details>}
        <p className={s.muted}>沿用上方微台單口成本／停損／R設定，本次單邊費率 ${config.feePerSide}。資料不足會保存原因；模型分數未校準為勝率。</p>
        <div className={s.actions}><Button size="compact" disabled={running || !datasetId || (dataset?.strategySession ?? 'cash') !== session || config.quantity !== 1} onClick={() => void launch('train')}>訓練／重新驗證</Button></div>
        {overview?.jobs.slice(0, 1).map(job => <p className={s.notice} role="status" key={job.id}>{job.message} · {Math.round(job.progress * 100)}%{job.status === 'failed' || job.status === 'interrupted' ? ' · 可重試' : ''}</p>)}
        {error && <p className={s.error} role="alert">{error}</p>}
        <label className={s.field}>模型研究版本<SelectControl aria-label="模型研究版本" value={runId} onValueChange={setRunId} className={s.input} wrapperClassName="w-full"><SelectOption value="">選擇研究紀錄</SelectOption>{overview?.runs.map(r => <SelectOption key={r.id} value={r.id}>{SESSION_LABEL[r.strategySession ?? 'cash']} · {FEATURE_SET_LABEL[r.featureSet ?? 'base']} · {new Date(r.createdAt).toLocaleString('zh-TW')} · {r.status === 'insufficient' ? '資料不足' : r.status === 'research_candidate' ? '研究候選' : '研究診斷'} · {r.id.slice(0, 8)}</SelectOption>)}</SelectControl></label>
        {report && <IntradayLearningResults report={report} />}
        {report?.model && <Button size="compact" variant="outline" onClick={() => void exportModel()}>匯出本機模型</Button>}
        {overview && <p className={s.muted}>整個研究資料庫 {(overview.databaseBytes / 1048576).toFixed(1)} MiB；下載與訓練均保存在本機。</p>}
    </section>;
}
