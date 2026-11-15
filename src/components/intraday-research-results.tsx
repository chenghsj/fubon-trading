import { useState } from 'react';
import { Button } from './ui/button';
import { researchTradeStats, type ResearchComparison, type ResearchRun } from '../lib/intraday-research';
import * as s from './intraday-research.css';

const cash = (n: number) => n.toLocaleString('zh-TW', { maximumFractionDigits: 0 });
const dateTime = (t: number) => new Date(t * 1000).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false });

function EquityChart({ result }: { result: ResearchComparison }) {
    const all = [...result.baseline.equity, ...result.filtered.equity, ...(result.revision?.run.equity ?? [])].map(p => p.value);
    const lo = Math.min(0, ...all), hi = Math.max(1, ...all);
    const points = (run: ResearchRun) => run.equity.map((p, i) => ({ ...p, i }))
        .filter(p => p.i % Math.max(1, Math.floor(run.equity.length / 1000)) === 0 || p.i === run.equity.length - 1)
        .map(p => `${10 + p.i / Math.max(1, run.equity.length - 1) * 780},${130 - (p.value - lo) / (hi - lo) * 115}`).join(' ');
    return <><p className={s.muted}>累計損益：灰線＝基準，實線強調色＝權值股濾網{result.revision ? '，虛線＝V2 候選' : ''}。縱軸範圍 NT$ {cash(lo)}～{cash(hi)}。</p>
        <svg className={s.chart} viewBox="0 0 800 150" role="img" aria-label="各版本累計損益比較">
            <polyline className={s.baseLine} points={points(result.baseline)} />
            <polyline className={s.filterLine} points={points(result.filtered)} />
            {result.revision && <polyline className={s.revisionLine} points={points(result.revision.run)} />}
        </svg></>;
}

export function IntradayResearchResults({ result }: { result: ResearchComparison }) {
    const [variant, setVariant] = useState('filtered');
    const rows = [{ key: 'baseline', name: 'V1 固定停損基準', run: result.baseline }, { key: 'filtered', name: 'V1 權值股濾網', run: result.filtered },
        ...(result.revision ? [{ key: 'revised', name: 'V2 波動風控候選', run: result.revision.run }] : [])];
    const selected = rows.find(r => r.key === variant) ?? rows[0]!;
    return <section aria-label="回測結果">
        <p className={s.notice}>{result.context.source === 'synthetic' ? '合成展示結果' : '富邦歷史情境回測'} · {result.context.product} {result.context.contractMonth} · {result.context.start}～{result.context.end}<br />固定假設權重 {result.context.weightDate} · {result.config.quantity} 口 · 停損 {result.config.stopPoints} 點 / {result.config.targetR}R · 每口單邊手續費 ${result.config.feePerSide}（{result.config.feeSource === 'statement' ? '對帳單核對' : '假設'}） / 滑價 {result.config.slippagePoints} 點 / 稅率 {result.config.taxRate}（{result.config.taxRounding ? '每口每邊取整' : '舊版未取整'}）</p>
        <h3 className={s.subhead}>開盤區間突破 · 策略版本比較</h3>
        <div className={s.tableScroll}><table className={s.table}><thead><tr><th>版本</th><th>淨損益 NT$</th><th>平均每筆淨損益</th><th>平均贏／輸</th><th>獲利因子</th><th>成本</th><th>最大回撤</th><th>筆數</th><th>淨勝率</th></tr></thead>
            <tbody>{rows.map(({ key, name, run: r }) => {
                const stats = researchTradeStats(r.trades);
                const amount = (n: number | null) => n === null ? '—' : cash(n);
                return <tr key={key}><td>{name}</td><td>{cash(r.net)}</td><td>{amount(stats.meanNet)}</td><td>{amount(stats.averageWin)} / {amount(stats.averageLoss)}</td><td>{stats.profitFactor === null ? '—' : stats.profitFactor.toFixed(2)}</td><td>{cash(r.costs)}</td><td>{cash(r.maxDrawdown)}</td><td>{r.trades.length}</td><td>{r.winRate === null ? '—' : `${(r.winRate * 100).toFixed(1)}%`}</td></tr>;
            })}</tbody></table></div>
        <p className={s.muted}>金額單位 NT$；平均值與勝率只描述這份歷史樣本。獲利因子＝淨獲利總額／淨虧損總額，無虧損樣本時不計算。</p>
        {result.revision && <div className={s.notice} aria-label="V2 驗證狀態">
            <strong>研究候選 · {result.revision.stressRevised.net <= 0 ? '成本壓力後仍虧損，未通過穩健性檢查' : '仍待獨立樣本外與盤中前測'}</strong>
            <p className={s.muted}>V2：1 分 Wilder ATR14 × 1.5（設定停損為下限）、停利沿用 R 倍數；訊號偏離逾 10 點或單次含成本風險超出當日剩餘 $1,000 預算時不進場。進場後不放寬距離。沒有自動調參或切換策略。</p>
            <p className={s.muted}>V2 跳過：{Object.entries(result.revision.rejected).map(([key, count]) => `${({ budget: '風險預算', drift: '偏離訊號', breakout: '突破失效', warmup: 'ATR 資料不足' } as Record<string, string>)[key] ?? key} ${count} 次`).join('、') || '0 次'}。</p>
            <p className={s.muted}>固定壓力情境：每邊滑價再增加 2 點，重新模擬成交與風控，筆數可能改變；OHLC 無法驗證 IOC 排隊與部分成交。</p>
            <div className={s.tableScroll}><table className={s.table}><thead><tr><th>壓力情境</th><th>淨損益 NT$</th><th>最大回撤</th><th>筆數</th></tr></thead><tbody>
                {[{ name: 'V1 基準', run: result.revision.stressBaseline }, { name: 'V2 候選', run: result.revision.stressRevised }].map(({ name, run: r }) => <tr key={name}><td>{name}</td><td>{cash(r.net)}</td><td>{cash(r.maxDrawdown)}</td><td>{r.trades.length}</td></tr>)}
            </tbody></table></div>
        </div>}
        <EquityChart result={result} />
        <p className={s.muted}>完整日 {result.diagnostics.completeDays}；排除缺段日 {result.diagnostics.excludedDays.length}；權值股缺資料時點 {result.diagnostics.missingBasketTimes}；濾網拒絕 {result.diagnostics.filterRejected} 次。</p>
        {result.diagnostics.excludedDays.length > 0 && <p className={s.muted}>缺段日期：{result.diagnostics.excludedDays.join('、')}</p>}
        <details><summary>假設與驗證範圍</summary><ul>{result.warnings.map(w => <li key={w}>{w}</li>)}</ul></details>
        <div className={s.actions}>{rows.map(r => <Button key={r.key} size="compact" variant={selected.key === r.key ? 'secondary' : 'outline'} onClick={() => setVariant(r.key)}>{r.name}明細</Button>)}</div>
        <div className={s.tableScroll}><table className={s.table}><thead><tr><th>方向／進場</th><th>出場</th><th>進／出價</th><th>淨損益</th><th>原因</th></tr></thead><tbody>
            {selected.run.trades.map((t, i) => <tr key={i}><td>{t.side === 'long' ? '多' : '空'} {dateTime(t.entryTime)}</td><td>{dateTime(t.exitTime)}</td><td>{t.entry.toFixed(2)} / {t.exit.toFixed(2)}</td><td>{cash(t.net)}</td><td>{t.reason}</td></tr>)}
            {!selected.run.trades.length && <tr><td colSpan={5}>此設定沒有成交；可檢查資料完整度與進場條件。</td></tr>}
        </tbody></table></div>
    </section>;
}

