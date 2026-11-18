import { useEffect, useRef, useState } from 'react';
import { apiGet } from '../lib/api';
import { fubonPost } from '../lib/fubon-api-detail';
import type { ResearchConfig } from '../lib/intraday-research';
import type { LearningDataset, LearningJob } from '../lib/learning';
import type { RegimeReport, RegimeRun } from '../lib/regime-research';
import { SESSION_LABEL } from '../lib/strategy-session';
import { Button } from './ui/button';
import { SelectControl, SelectOption } from './ui/select-control';
import * as s from './intraday-research.css';

const amount = (n: number) => n.toLocaleString('zh-TW', { maximumFractionDigits: 0 });
const periods = { development: '前60%開發期', validation: '中20%驗證期', test: '後20%歷史測試' } as const;
const variants = { hybrid: '區間＋順勢', range: '僅區間（診斷）', trend: '僅順勢（診斷）' } as const;

export function RegimeResearchPanel({ config, datasets, jobs }: {
    config: ResearchConfig; datasets: LearningDataset[]; jobs: LearningJob[];
}) {
    const [datasetId, setDatasetId] = useState(''), [runId, setRunId] = useState('');
    const [runs, setRuns] = useState<RegimeRun[]>([]), [report, setReport] = useState<RegimeReport | null>(null);
    const [error, setError] = useState(''), [submitting, setSubmitting] = useState(false);
    const seen = useRef('');
    const choices = datasets.filter(d => d.strategySession === 'regular' || d.strategySession === 'afterhours');
    useEffect(() => { setDatasetId(old => choices.some(d => d.id === old) ? old : choices[0]?.id ?? ''); }, [datasets]);
    useEffect(() => {
        let disposed = false, timer: ReturnType<typeof setTimeout>;
        const poll = async () => {
            try {
                const values = await apiGet<RegimeRun[]>('/api/v1/research/regime/runs');
                if (!disposed) { setRuns(values); setRunId(old => old || values[0]?.id || ''); }
            } catch (e) { if (!disposed) setError(e instanceof Error ? e.message : String(e)); }
            finally { if (!disposed) timer = setTimeout(() => void poll(), 5000); }
        };
        void poll(); return () => { disposed = true; clearTimeout(timer); };
    }, []);
    useEffect(() => {
        const job = jobs.find(j => j.action === 'regime');
        if (job?.status === 'completed' && job.resultId && seen.current !== job.id) {
            seen.current = job.id; setRunId(job.resultId);
        }
    }, [jobs]);
    useEffect(() => {
        if (!runId) return;
        let disposed = false; setReport(null);
        void apiGet<RegimeReport>(`/api/v1/research/regime/runs/${runId}`).then(value => {
            if (!disposed) setReport(value);
        }).catch(e => { if (!disposed) setError(e instanceof Error ? e.message : String(e)); });
        return () => { disposed = true; };
    }, [runId]);
    const busy = submitting || jobs.some(j => j.status === 'running');
    const launch = async () => {
        setSubmitting(true); setError('');
        try { await fubonPost('/api/v1/research/regime/run', { dataset_id: datasetId, config }); }
        catch (e) { setError(e instanceof Error ? e.message : String(e)); }
        finally { setSubmitting(false); }
    };
    const job = jobs.find(j => j.action === 'regime');
    return <section aria-label="區間與順勢策略研究">
        <h3 className={s.subhead}>V3 · 1m／3m／15m 區間與順勢</h3>
        <p className={s.notice}>15分K判斷盤整／趨勢，3分K建立滾動結構，1分收盤確認進場。盤整從區間邊緣返回內側、以中線為目標；趨勢沿15分方向交易18分鐘結構的新突破。盤勢不明或成本空間不足時跳過。這是固定規則候選，尚未證明具有獲利優勢。</p>
        <p className={s.muted}>當盤需135分鐘暖身；單口、每方向每盤一次意圖、合計最多兩次、1000元損失預算。先前已看過的歷史重新使用，不能當作全新樣本。舊的開盤突破LightGBM不適用此候選。</p>
        <label className={s.field}>區間／順勢資料版本<SelectControl aria-label="區間／順勢資料版本" value={datasetId} onValueChange={setDatasetId} disabled={busy} wrapperClassName="w-full"><SelectOption value="">選擇完整期貨盤資料</SelectOption>{choices.map(d => <SelectOption key={d.id} value={d.id}>{SESSION_LABEL[d.strategySession ?? 'regular']} · {d.completeDays}完整盤 · {d.id.slice(0, 8)}</SelectOption>)}</SelectControl></label>
        <Button size="compact" disabled={busy || !datasetId || config.quantity !== 1} onClick={() => void launch()}>比較區間／順勢與滑價壓力</Button>
        {job && <p className={s.muted} role="status">{job.message} · {Math.round(job.progress*100)}%</p>}
        {error && <p className={s.error} role="alert">{error}</p>}
        <label className={s.field}>區間／順勢研究紀錄<SelectControl aria-label="區間／順勢研究紀錄" value={runId} onValueChange={setRunId} wrapperClassName="w-full"><SelectOption value="">選擇保存結果</SelectOption>{runs.map(r => <SelectOption key={r.id} value={r.id}>{SESSION_LABEL[r.strategySession]} · {r.metricsPassed ? '通過歷史數值門檻' : '未通過歷史數值門檻'} · {r.id.slice(0, 8)}</SelectOption>)}</SelectControl></label>
        {report && <>
            <p className={s.notice}><strong>{report.metricsPassed ? '通過歷史數值門檻，仍需新日期前測' : '未通過歷史數值門檻，尚無獲利證據'}</strong><br />{SESSION_LABEL[report.strategySession]} · {report.diagnostics.completeDays}完整盤 · 單邊費用 ${report.config.feePerSide}（{report.config.feeSource === 'statement' ? '已核對' : '假設'}）· 每邊滑價{report.config.slippagePoints}點。研究完成不會啟動或替換策略。</p>
            <ul>{report.reasons.map(reason => <li key={reason}>{reason}</li>)}</ul>
            <div className={s.tableScroll}><table className={s.table}><thead><tr><th>期間／候選</th><th>淨損益 NT$</th><th>最大回撤</th><th>成交數</th><th>額外滑價淨額</th><th>區間／順勢淨額</th></tr></thead><tbody>
                {(Object.keys(periods) as (keyof typeof periods)[]).flatMap(period => (Object.keys(variants) as (keyof typeof variants)[]).map(variant => {
                    const { normal, stress } = report.comparisons[period][variant];
                    return <tr key={`${period}-${variant}`}><td>{periods[period]}／{variants[variant]}</td><td>{amount(normal.net)}</td><td>{amount(normal.maxDrawdown)}</td><td>{normal.count}</td><td>{amount(stress.net)}</td><td>{amount(normal.byRegime?.range.net ?? 0)}／{amount(normal.byRegime?.trend.net ?? 0)}</td></tr>;
                }))}
            </tbody></table></div>
        </>}
    </section>;
}
