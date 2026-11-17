import { useEffect, useRef, useState } from 'react';
import type { NativeResult } from '../lib/native-panels';
import { formatShares, formatShareTick, institutions, institutionalColumns, institutionalRows, institutionalSeries, institutionalTotal, shareNumber, shareUnitLabel, type InstitutionKey, type ShareUnit } from '../lib/institutional';
import { vars } from '../theme.css';
import { Button } from './ui/button';
import * as s from './institutional-chart.css';
import * as panel from './fubon-api-panel.css';

function valueColor(value: unknown) {
    const number = shareNumber(value);
    return number === null || number === 0 ? vars.color.foreground : number > 0 ? vars.color.upControl : vars.color.downControl;
}

export function InstitutionalChart({ data }: { data: NativeResult }) {
    const [unit, setUnit] = useState<ShareUnit>('lots');
    const [institution, setInstitution] = useState<InstitutionKey>('total');
    const [cumulative, setCumulative] = useState(false);
    const [date, setDate] = useState('');
    const scrollRef = useRef<HTMLDivElement>(null);
    const [viewportWidth, setViewportWidth] = useState(600);
    useEffect(() => {
        const element = scrollRef.current;
        if (!element) return;
        const observer = new ResizeObserver(entries => {
            const entry = entries[0];
            if (entry) setViewportWidth(Math.round(entry.contentRect.width));
        });
        observer.observe(element);
        return () => observer.disconnect();
    }, [data]);
    const rows = institutionalRows(data.rows);
    const values = institutionalSeries(rows, institution, cumulative);
    const activeIndex = rows.some(row => row.date === date) ? rows.findIndex(row => row.date === date) : rows.length - 1;
    const active = rows[activeIndex];
    const label = institutions.find(item => item.key === institution)!.label;
    const unitLabel = shareUnitLabel(unit);
    const limit = Math.max(1, ...values.map(value => Math.abs(value ?? 0)));
    const width = Math.max(600, viewportWidth, rows.length * 14 + 100);
    const left = 82, right = width - 16, top = 24, baseline = 122, bottom = 220;
    const step = (right - left) / Math.max(1, rows.length);
    const x = (index: number) => left + (index + 0.5) * step;
    const y = (value: number) => baseline - value / limit * (baseline - top);
    const tickEvery = Math.max(1, Math.ceil(80 / step));
    const showDate = (index: number) => index % tickEvery === 0 && (index === rows.length - 1 || rows.length - 1 - index >= tickEvery / 2) || index === rows.length - 1;
    const missing = values.filter(value => value === null).length;
    return <section className={s.root} aria-label='三大法人籌碼圖表'>
        <div className={s.toolbar}>
            <div><strong>{String(data.metadata.symbol ?? '')} 三大法人買賣超</strong><div className={panel.muted}>{rows.length ? `${rows[0]!.date} ～ ${rows.at(-1)!.date} · ${rows.length} 個資料日` : '本次查詢無資料'}</div></div>
            <label className={s.unit}>顯示單位<select aria-label='顯示單位' className={panel.input} value={unit} onChange={event => setUnit(event.target.value as ShareUnit)}><option value='lots'>張</option><option value='shares'>股</option></select></label>
        </div>
        <div className={s.metrics} aria-label='區間買賣超累計'>
            {institutions.map(item => {
                const total = institutionalTotal(rows, item.key);
                return <button key={item.key} type='button' className={s.metric} aria-pressed={institution === item.key} onClick={() => setInstitution(item.key)}>
                    <span>{item.label}</span><strong style={{ color: valueColor(total) }}>{formatShares(total, unit, true)} <small>{unitLabel}</small></strong>
                    <span className={panel.muted}>{total === null ? '資料不足，無法完整加總' : '區間累計'} · 點選查看走勢</span>
                </button>;
            })}
        </div>
        <div className={s.toolbar}>
            <div className={panel.tabs} role='group' aria-label='買賣超圖表模式'><Button size='compact' variant={!cumulative ? 'secondary' : 'ghost'} aria-pressed={!cumulative} onClick={() => setCumulative(false)}>每日買賣超</Button><Button size='compact' variant={cumulative ? 'secondary' : 'ghost'} aria-pressed={cumulative} onClick={() => setCumulative(true)}>區間累計走勢</Button></div>
            <span className={panel.muted}>＋ 買超 ／ − 賣超 · {unitLabel}</span>
        </div>
        {rows.length ? <>
            <figure className={s.figure}>
                <figcaption>{label} · {cumulative ? '區間累計' : '每日買賣超'}（{unitLabel}）</figcaption>
                <div className={s.scroll} ref={scrollRef}>
                    <svg viewBox='0 0 82 255' className={s.axis} aria-hidden='true'>{[limit, limit / 2, 0, -limit / 2, -limit].map(tick => <text key={tick} x={74} y={y(tick) + 4} textAnchor='end' fill={vars.color.mutedForeground} fontSize={11}>{formatShareTick(tick, unit)}</text>)}</svg>
                    <svg viewBox={`0 0 ${width} 255`} className={s.chart} style={{ width }} role='img' aria-label={`${label}${cumulative ? '區間累計' : '每日買賣超'}長條圖，單位${unitLabel}；數值可由日期選單與每日明細查看`}>
                        {[limit, limit / 2, 0, -limit / 2, -limit].map(tick => <line key={tick} x1={left} x2={right} y1={y(tick)} y2={y(tick)} stroke={tick === 0 ? vars.color.mutedForeground : vars.color.border} strokeDasharray={tick === 0 ? undefined : '3 4'} />)}
                        {values.map((value, index) => <g key={rows[index]!.date} onMouseEnter={() => setDate(rows[index]!.date)}>
                            <rect x={left + index * step} y={top} width={step} height={bottom - top} fill={activeIndex === index ? vars.color.accentDim : 'transparent'} />
                            {value === null ? <text x={x(index)} y={baseline + 5} textAnchor='middle' fill={vars.color.mutedForeground} fontSize={12}>?</text> : <rect x={x(index) - Math.min(36, step * 0.65) / 2} y={Math.min(y(value), baseline)} width={Math.min(36, step * 0.65)} height={Math.max(value === 0 ? 1 : 2, Math.abs(y(value) - baseline))} fill={valueColor(value)}><title>{rows[index]!.date} {formatShares(value, unit, true)} {unitLabel}</title></rect>}
                            {showDate(index) && <text x={x(index)} y={244} textAnchor='middle' fill={vars.color.mutedForeground} fontSize={11}>{rows[index]!.date.slice(5)}</text>}
                        </g>)}
                    </svg>
                </div>
                <div className={s.toolbar}>
                    <label className={s.date}>查看日期<select aria-label='查看日期' className={panel.input} value={active?.date ?? ''} onChange={event => setDate(event.target.value)}>{rows.map(row => <option key={row.date} value={row.date}>{row.date}</option>)}</select></label>
                    <output className={s.readout} aria-live='polite'>{label} {cumulative ? '累計' : '買賣超'} <strong style={{ color: valueColor(values[activeIndex]) }}>{formatShares(values[activeIndex], unit, true)} {unitLabel}</strong></output>
                </div>
            </figure>
            <details className={s.details}><summary>每日買賣明細（{unitLabel}）</summary><div className={panel.tableWrap}><table className={panel.table}><thead><tr><th scope='col'>日期</th>{institutionalColumns.map(col => <th scope='col' key={col.key}>{col.label}（{unitLabel}）</th>)}</tr></thead><tbody>{rows.map(row => <tr key={row.date}><th scope='row'>{row.date}</th>{institutionalColumns.map(col => <td key={col.key} style={col.key.endsWith('.net') || col.key === 'total' ? { color: valueColor(row[col.key]) } : undefined}>{formatShares(row[col.key], unit, col.key.endsWith('.net') || col.key === 'total')}</td>)}</tr>)}</tbody></table></div></details>
        </> : <p className={s.empty} role='status'>來源未回傳符合條件的資料，請調整股票代號或日期區間後重新查詢。</p>}
        <p className={panel.muted}>1 張＝1,000 股，張數保留至小數第 3 位。來源缺值顯示「—」，不補零；區間累計僅涵蓋本次回傳的資料日。{missing > 0 && `目前走勢有 ${missing} 筆未知值。`}</p>
    </section>;
}
