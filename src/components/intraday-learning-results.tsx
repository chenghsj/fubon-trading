import type { LearningReport } from '../lib/learning';
import { SESSION_LABEL } from '../lib/strategy-session';
import * as s from './intraday-research.css';

const amount = (v: number) => v.toLocaleString('zh-TW', { maximumFractionDigits: 0 });
const span = (dates: string[]) => dates.length ? `${dates[0]}～${dates.at(-1)}` : '沒有日期';
export function IntradayLearningResults({ report }: { report: LearningReport }) {
    return <section aria-label="LightGBM 訓練結果">
        <div className={s.notice}><strong>{({ insufficient: '資料不足，未建立模型', diagnostic: '已訓練，未取得採用資格', research_candidate: '通過數值比較，保留研究候選' })[report.status]}</strong><br />
            {SESSION_LABEL[report.strategySession ?? 'cash']} · 版本 {report.id.slice(0, 12)} · {report.source} · LightGBM {report.packages.lightgbm}<br />
            單邊費用 ${report.config.feePerSide}（{report.config.feeSource === 'statement' ? '對帳單核對' : '假設'}）· 滑價 {report.config.slippagePoints} 點 · 每口每邊稅額取整<br />
            數值比較：{report.metricsPassed ? '通過，來源與前測資格仍待核對' : '未通過／資料不足'}。模型未核准正式交易；可手動選入 Paper／Sandbox 實驗，分數未校準為未來勝率。</div>
        <p className={s.muted}>以下日期為實際開盤日，跨午夜仍算同一盤。訓練 {report.counts.train} 筆（{span(report.split.trainDates)}）；驗證 {report.counts.validation} 筆（{span(report.split.validationDates)}）；封存測試 {report.counts.test} 筆（{span(report.split.testDates)}）。跨界標籤排除 {report.split.purged.reduce((a, b) => a + b, 0)} 筆。</p>
        <p className={s.muted}>可標記事件 {report.diagnostics.labeledEvents}；股票不同步跳過 {report.diagnostics.missingStockEvents}；一般情境風控跳過 {report.diagnostics.riskRejectedEvents}。20分鐘事件出場，與上方日內回測的出場期限不同。</p>
        <ul>{report.reasons.map(reason => <li key={reason}>{reason}</li>)}</ul>
        {report.selection && <><h4>滾動驗證候選（測試期不參與選擇）</h4><p className={s.muted}>已固定 {report.selection.selected.kind === 'net_return' ? '淨收益預測' : '分類'}／門檻 {report.selection.selected.threshold}；{report.selection.passed ? '通過三段滾動門檻，仍需核對最終測試與新日期前測。' : '沒有候選通過全部滾動門檻，此版本僅供研究診斷。'}</p><div className={s.tableScroll}><table className={s.table}><thead><tr><th>模型／門檻</th><th>滾動淨損益</th><th>最大回撤</th><th>成交數</th><th>壓力淨損益</th><th>三段門檻</th></tr></thead><tbody>{report.selection.candidates.map(c => <tr key={`${c.kind}-${c.threshold}`}><td>{c.kind === 'net_return' ? '淨收益 NT$' : '分類 '}{c.threshold}</td><td>{amount(c.normal.net)}</td><td>{amount(c.normal.maxDrawdown)}</td><td>{c.normal.count}</td><td>{amount(c.stress.net)}</td><td>{c.passed ? '通過' : '未通過'}</td></tr>)}</tbody></table></div></>}
        {Object.keys(report.comparisons).length > 0 && <div className={s.tableScroll}><table className={s.table}>
            <thead><tr><th>期間／版本</th><th>淨損益 NT$</th><th>最大回撤</th><th>筆數</th><th>額外滑價壓力淨值</th></tr></thead>
            <tbody>{Object.entries(report.comparisons).sort(([a], [b]) => a === b ? 0 : a === 'validation' ? -1 : 1).flatMap(([name, result]) => [
                { key: 'baseline', label: '事件基準', value: result.baseline, stress: result.stressBaseline },
                { key: 'filtered', label: 'LightGBM 濾網', value: result.filtered, stress: result.stressFiltered },
            ].map(r => <tr key={`${name}-${r.key}`}><td>{name === 'validation' ? '驗證' : '封存測試'}／{r.label}</td><td>{amount(r.value.net)}</td><td>{amount(r.value.maxDrawdown)}</td><td>{r.value.count}</td><td>{amount(r.stress.net)}</td></tr>))}</tbody>
        </table></div>}
        {report.model && <p className={s.muted}>模型 {(report.model.bytes / 1024).toFixed(1)} KB · 雜湊 {report.model.hash.slice(0, 12)} · 原生 LightGBM 文字格式保存本機。</p>}
        {report.predictions.length > 0 && <details><summary>封存期間訊號分數與歷史標籤</summary><div className={s.tableScroll}><table className={s.table}><thead><tr><th>時間</th><th>方向</th><th>{report.modelKind === 'net_return' ? '預估淨收益 NT$' : '模型分數'}</th><th>歷史淨收益為正</th></tr></thead><tbody>
            {report.predictions.map(p => <tr key={p.time}><td>{new Date(p.time * 1000).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' })}</td><td>{p.side === 'Buy' ? '多' : '空'}</td><td>{p.score.toFixed(3)}</td><td>{p.label ? '是' : '否'}</td></tr>)}
        </tbody></table></div></details>}
    </section>;
}
