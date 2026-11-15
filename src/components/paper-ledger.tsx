import { useEffect, useState } from 'react';
import { apiGet } from '../lib/api';
import { Alert, AlertDescription } from './ui/alert';
import { Button } from './ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './ui/table';
import * as s from './auto-trading.css';

type SavedOrder = {
    order: { id: string; action: string; account: { account_id: string } };
    contract: { code: string };
    status: { status: string; deal_quantity: number };
    paper: { fee: number; tax: number; cost: { fee_per_side: number; fee_source: string; configured: boolean } };
};
interface Ledger {
    persistent: boolean; costsComplete: boolean; realizedGross: number; realizedNet: number; fee: number; tax: number;
    orders: SavedOrder[];
    positions: { account_id: string; code: string; signed_qty: number; price: number }[];
}
const money = (n: number) => n.toLocaleString('zh-TW', { maximumFractionDigits: 2 });

function SavedPositions({ positions }: { positions: Ledger['positions'] }) {
    return <Table className={s.table} containerClassName={s.scroll} aria-label="Paper 保存持倉">
        <TableHeader><TableRow><TableHead>模擬帳戶／合約</TableHead><TableHead>方向／數量</TableHead><TableHead>平均成本</TableHead></TableRow></TableHeader>
        <TableBody>{positions.map(p => <TableRow key={`${p.account_id}:${p.code}`}><TableCell>{p.account_id}<br />{p.code}</TableCell><TableCell>{p.signed_qty > 0 ? '多' : '空'} {Math.abs(p.signed_qty)}</TableCell><TableCell>{money(p.price)}</TableCell></TableRow>)}
            {!positions.length && <TableRow><TableCell colSpan={3}>沒有保存中的持倉。</TableCell></TableRow>}</TableBody>
    </Table>;
}

function SavedOrders({ orders }: { orders: SavedOrder[] }) {
    return <Table className={s.table} containerClassName={s.scroll} aria-label="Paper 保存委託">
        <TableHeader><TableRow><TableHead>模擬帳戶／合約</TableHead><TableHead>方向／狀態</TableHead><TableHead>成交量</TableHead><TableHead>手續費／稅</TableHead><TableHead>凍結單邊費率</TableHead></TableRow></TableHeader>
        <TableBody>{orders.slice(-20).reverse().map(o => <TableRow key={o.order.id}><TableCell>{o.order.account.account_id}<br />{o.contract.code}</TableCell><TableCell>{o.order.action === 'Buy' ? '買' : '賣'}／{o.status.status}</TableCell><TableCell>{o.status.deal_quantity}</TableCell><TableCell>{money(o.paper.fee)}／{money(o.paper.tax)}</TableCell><TableCell>{o.paper.cost.configured ? `$${money(o.paper.cost.fee_per_side)} · ${o.paper.cost.fee_source === 'statement' ? '已核對' : '假設'}` : '費稅未設定'}</TableCell></TableRow>)}
            {!orders.length && <TableRow><TableCell colSpan={5}>尚無 paper 委託。</TableCell></TableRow>}</TableBody>
    </Table>;
}

export function PaperLedger() {
    const [ledger, setLedger] = useState<Ledger | null>(null), [error, setError] = useState('');
    const [reload, setReload] = useState(0);
    useEffect(() => {
        let alive = true, timer: ReturnType<typeof setTimeout>;
        const load = async () => {
            try { const next = await apiGet<Ledger>('/api/v1/paper/state'); if (alive) { setLedger(next); setError(''); } }
            catch (e) { if (alive) setError(e instanceof Error ? e.message : String(e)); }
            finally { if (alive) timer = setTimeout(load, 3000); }
        };
        void load();
        return () => { alive = false; clearTimeout(timer); };
    }, [reload]);
    return <section aria-label="Paper 持久模擬帳簿">
        <div className={s.header}><h3 className={s.heading}>Paper 本機帳簿</h3><Button size="compact" variant="outline" onClick={() => setReload(n => n + 1)}>更新模擬帳簿</Button></div>
        <p className={s.muted}>委託、持倉與成交費稅保存於本機資料庫，重啟後保留。手動使用 PAPER-F，策略使用獨立 PAPER-AUTO-F。新委託沿用本機商品費率，舊單成本固定。</p>
        {error && <Alert variant="destructive"><AlertDescription>帳簿更新失敗：{error}。目前畫面可能是舊資料。</AlertDescription></Alert>}
        {!ledger && !error && <p role="status">讀取保存中的模擬帳簿…</p>}
        {ledger && <>
            <div className={s.metrics}><div className={s.metric}>累計已實現毛損益<strong className={s.number}>${money(ledger.realizedGross)}</strong></div><div className={s.metric}>已付手續費／期交稅<strong className={s.number}>${money(ledger.fee)}／${money(ledger.tax)}</strong></div><div className={s.metric}>扣已付成本淨額<strong className={s.number}>${money(ledger.realizedNet)}</strong></div></div>
            {!ledger.costsComplete && <p className={s.warning}>有商品尚未設定費稅，淨額僅扣除已知成本。內建費稅適用臺指／小台／微台。</p>}
            <details><summary>已保存的委託與持倉（委託顯示最近20筆）</summary><SavedPositions positions={ledger.positions} /><SavedOrders orders={ledger.orders} /></details>
        </>}
        <p className={s.muted}>部位面板為未實現毛損益，帳務另扣成交費稅；此處不估計浮盈虧。每日損益按台北曆日歸屬，夜盤跨午夜分日。撮合未模擬排隊、部分成交、市場衝擊或保證金占用。</p>
    </section>;
}
