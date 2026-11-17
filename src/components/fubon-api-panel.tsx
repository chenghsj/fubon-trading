import { useState } from 'react';
import { LockKeyhole, ExternalLink } from 'lucide-react';
import { Button } from './ui/button';
import { FUBON_API_PANELS, type FubonApiPanelType } from '../lib/fubon-api-panels';
import * as s from './fubon-api-panel.css';

type Field = { label: string; type?: 'date' | 'number' | 'text'; options?: string[]; placeholder?: string };
type View = { title: string; path: string; fields: Field[]; columns: string[]; metrics?: string[]; note: string; action?: string };
const stock: Field = { label: '股票代號', placeholder: '例如 2330' };
const account: Field = { label: '券商帳戶', options: ['尚未接入券商帳戶選擇'] };
const range: Field[] = [{ label: '開始日期', type: 'date' }, { label: '結束日期', type: 'date' }];
const market: Field = { label: '市場', options: ['上市', '上櫃'] };
const base = 'https://www.fbs.com.tw/TradeAPI/docs/';
const views: Record<FubonApiPanelType, View[]> = {
    fuboncredit: [
        { title: '資券額度', path: 'trading/library/python/trade/MarginQuota/', fields: [account, stock], metrics: ['融資可用額度', '融券可用額度', '融資／融券成數'], columns: ['商品', '融資配額', '融券配額', '融資成數', '融券成數'], note: '配額未取得時保留未知；無上限與可用額度為零會分開顯示。' },
        { title: '當沖資格', path: 'trading/library/python/trade/DaytradeAndStockInfo/', fields: [account, stock], metrics: ['現沖配額', '預收券數', '交易狀態'], columns: ['商品', '可當沖狀態', '配額', '預收券數', '處置狀態'], note: '資格、配額與處置限制分開核對；此處不代表已開通信用交易。' },
    ],
    fubonaccount: [
        { title: '交割明細', path: 'trading/library/python/accountManagement/QuerySettlement/', fields: [account, { label: '查詢範圍', options: ['近三日', '本日'] }], metrics: ['買進交割款', '賣出交割款', '交割淨額'], columns: ['資料日期', '買進款項', '賣出款項', '交割總額'], note: '呈現券商原始交割明細；交易資料日期不會直接當成銀行扣款日期。Paper 帳簿另於持倉面板查看。' },
        { title: '證券已實現', path: 'trading/library/python/accountManagement/RealizedPnLDetail/', fields: [account, ...range], columns: ['日期', '股票', '成交股數', '成交價', '已實現損益'], note: '日期篩選僅作用於來源實際回傳範圍；接通後會顯示資料涵蓋日期。' },
        { title: '期權平倉紀錄', path: 'trading-future/library/python/accountManagement/ClosePositionRecord/', fields: [account, ...range], columns: ['日期', '契約', '方向', '原始口數', '價格', '手續費', '稅'], note: '平倉紀錄未提供配對開倉價，這裡不推造逐筆實現損益。' },
        { title: '信用維持率', path: 'trading/library/python/accountManagement/Maintenance/', fields: [account], metrics: ['整戶維持率', '融資市值', '融券市值'], columns: ['股票', '融資／融券', '市值', '維持率'], note: '與 Paper 權益分開呈現，僅使用券商核定的信用帳務資料。' },
    ],
    fuboncondition: [
        { title: '單一／多條件', path: 'smart-condition/library/python/MultiCondition/', fields: [account, stock, { label: '條件模式', options: ['多條件（原生規則待核對）'] }, { label: '有效日期', type: 'date' }], columns: ['條件單號', '商品', '觸發條件', '有效期間', '狀態'], note: '此為券商條件單草稿；尚未建立、啟用任何自動保護。', action: '建立條件單' },
        { title: '停損停利', path: 'smart-condition/library/python/SingleConditionTPSL/', fields: [account, stock, { label: '停損觸發價', type: 'number' }, { label: '停利觸發價', type: 'number' }], columns: ['條件單號', '商品', '停損價', '停利價', '委託狀態'], note: '觸發與委託執行為不同階段；未送出前沒有停損停利保護。', action: '送出停損停利' },
        { title: '移動鎖利', path: 'smart-condition/library/python/trailprofit/TrailOrder/', fields: [account, stock, { label: '啟動價', type: 'number' }, { label: '回撤價差', type: 'number' }], columns: ['條件單號', '商品', '啟動價', '回撤設定', '追蹤狀態'], note: '先編輯參數；券商條件單 API 尚未連接。', action: '建立移動鎖利' },
        { title: '期貨條件單', path: 'smart-condition-future/introduction/', fields: [account, { label: '具體月份契約', placeholder: '例如 TMFK6' }, { label: '觸發價', type: 'number' }, { label: '有效日期', type: 'date' }], columns: ['條件單號', '契約', '方向', '觸發價', '狀態'], note: '期貨條件單與證券條件單各自管理；本版未接受或代簽券商使用同意書。', action: '建立期貨條件單' },
    ],
    fubonownership: [
        { title: '三大法人', path: 'market-data/http-api/ownership/institutional-trades/', fields: [stock, ...range], metrics: ['外資買賣超（股）', '投信買賣超（股）', '自營商買賣超（股）'], columns: ['日期', '法人別', '買進股數', '賣出股數', '買賣超股數'], note: '保留官方股數單位；未回傳資料不會顯示為零。' },
        { title: '董監持股', path: 'market-data/http-api/ownership/director-holdings/', fields: [stock, ...range], columns: ['資料月份', '身分', '持股股數', '設質股數'], note: '以每月持股與設質明細檢視內部人持股。' },
        { title: 'ETF 成分', path: 'market-data/http-api/ownership/etf-holdings/', fields: [{ label: 'ETF 代號', placeholder: '例如 0050' }, { label: '資料日期', type: 'date' }], columns: ['成分股', '持股股數', '權重', '較前次變動'], note: '檢視指定 ETF 的每日成分股與權重，不與指數權重混用。' },
        { title: '集保分布', path: 'market-data/http-api/ownership/tdcc-distribution/', fields: [stock, { label: '資料日期', type: 'date' }], columns: ['持股級距', '股東人數', '持股股數', '占比'], note: '依集保資料期別檢視各級距，未載入時不畫占比。' },
    ],
    fuboncorporate: [
        { title: '除權息', path: 'market-data/http-api/corporate-actions/dividends/', fields: [market, stock], columns: ['股票', '除權息日', '現金股利', '每千股無償配股（股）'], note: '選擇月份查看除權息事件；尚未載入不代表當月沒有事件。' },
        { title: '資本變動', path: 'market-data/http-api/corporate-actions/captital-changes/', fields: [market, stock], columns: ['股票', '變動日期', '變動類型', '變動說明'], note: '分開呈現面額變更、減資與分割事件。' },
        { title: '上市櫃申請', path: 'market-data/http-api/corporate-actions/listing-applicants/', fields: [market, ...range], columns: ['公司', '申請日期', '審議日期', '董事會通過日', '契約核准／備查日', '掛牌日期'], note: '各里程碑依來源保留；尚未核准與未取得資料會分開呈現。' },
    ],
    fubontechnical: [
        ...['SMA', 'RSI', 'MACD', 'KDJ', 'BBANDS'].map(indicator => ({ title: indicator, path: `market-data/http-api/technical/${indicator.toLowerCase()}/`,
            fields: [stock, { label: 'K 線週期', options: ['日 K', '週 K', '月 K', '1 分 K', '5 分 K', '15 分 K', '60 分 K'] }, ...range,
                ...(indicator === 'MACD' ? ['快線週期', '慢線週期', '信號線週期'] : indicator === 'KDJ' ? ['RSV 週期', 'K 週期', 'D 週期'] : ['計算週期']).map(label => ({ label, type: 'number' as const }))],
            columns: indicator === 'MACD' ? ['日期', 'MACD', '信號線'] : indicator === 'KDJ' ? ['日期', 'K', 'D', 'J'] : indicator === 'BBANDS' ? ['日期', '上軌', '中軌', '下軌'] : ['日期', indicator],
            note: '富邦官方指標 API；與本機圖表計算分開。分 K 來源僅回近 30 日，日期區間適用日／週／月 K。' })),
        { title: '52 週統計', path: 'market-data/http-api/historical/stats/', fields: [stock], metrics: ['52 週最高', '52 週最低'], columns: ['股票', '52 週最高', '52 週最低'], note: '使用官方統計資料，不以目前圖上可見範圍冒充 52 週資料。' },
    ],
    fubonhistory: [
        { title: '歷史日行情', path: 'market-data-future/http-api/historical/daily/', fields: [{ label: '商品代號', placeholder: 'TXF、TXO…' }, { label: '交易日', type: 'date' }, { label: '契約月份', placeholder: 'YYYYMM，留白查全部' }, { label: '盤別', options: ['日盤', '夜盤'] }], columns: ['契約月份', '履約價', '買賣權', '開盤', '最高', '最低', '收盤', '成交量', '未平倉量'], note: '同一商品可涵蓋多月份、選擇權履約價與價差；逐筆與分 K 不混在這裡。' },
        { title: '選擇權歷史 K', path: 'market-data-future/http-api/historical/candles/', fields: [{ label: '商品代號', placeholder: '例如 TXO' }, { label: '契約月份', placeholder: 'YYYYMM' }, { label: '履約價', type: 'number' }, { label: '買賣權', options: ['買權 C', '賣權 P'] }, ...range], columns: ['時間', '開盤', '最高', '最低', '收盤', '成交量'], note: '依月份、履約價與買賣權指定歷史契約；不使用連續期貨推代選擇權。' },
    ],
    fubonindices: [
        { title: '指數清單', path: 'market-data/http-api/intraday/tickers/', fields: [market, { label: '名稱或代碼', placeholder: '搜尋指數' }], columns: ['指數代號', '名稱', '市場'], note: '接通後從官方 INDEX 商品清單載入，指數行情不提供可交易委託。' },
        { title: '即時指數', path: 'market-data/websocket-api/market-data-channels/indices/', fields: [{ label: '指數代號', placeholder: '輸入官方指數代號' }], metrics: ['最新指數', '漲跌', '更新時間'], columns: ['時間', '指數值'], note: '僅為官方指數串流；不推造個股指數貢獻或自算指數。', action: '訂閱指數' },
    ],
    fubonadvanced: [
        { title: '期權複式單', path: 'trading-future/library/python/trade/PlaceOrder/', fields: [account, { label: '第一腳契約', placeholder: '具體契約代碼' }, { label: '第一腳方向', options: ['買進', '賣出'] }, { label: '第二腳契約', placeholder: '具體契約代碼' }, { label: '第二腳方向', options: ['賣出', '買進'] }, { label: '共同口數', type: 'number' }, { label: '價差', type: 'number' }], columns: ['第一腳', '第二腳', '口數', '委託價差', '狀態'], note: '兩腳、等口數的原生委託版面；未拆成兩張單腳委託送出。', action: '送出複式單' },
        { title: '批次委託', path: 'trading/library/python/trade/batchOrder/BatchPlaceOrder/', fields: [account, stock, { label: '買賣方向', options: ['買進', '賣出'] }, { label: '數量（股）', type: 'number' }, { label: '限價', type: 'number' }], columns: ['商品', '方向', '股數', '價格', '檢核狀態'], note: '原生批次委託 API 尚未接入；不會以逐筆送出冒充原子批次交易。', action: '送出批次委託' },
        { title: '委託歷程', path: 'trading/library/python/trade/OrderHistory/', fields: [account, ...range], columns: ['委託時間', '委託單號', '商品', '狀態', '價格', '數量'], note: '歷史券商委託、成交與即時本機委託分開查閱。' },
    ],
};

function QueryField({ field }: { field: Field }) {
    return <label className={s.label}>{field.label}{field.options
        ? <select className={s.input} defaultValue={field.options[0]}>{field.options.map(option => <option key={option}>{option}</option>)}</select>
        : <input className={s.input} type={field.type ?? 'text'} placeholder={field.placeholder} step={field.type === 'number' ? 'any' : undefined} />}
    </label>;
}

function ConditionDraft() {
    const [rows, setRows] = useState([0]);
    const [nextId, setNextId] = useState(1);
    return <section className={s.section} aria-label='觸發條件草稿'>
        <strong>觸發條件</strong>
        {rows.map((id, index) => <div className={s.condition} key={id}>
            <QueryField field={{ label: `條件 ${index + 1}`, options: ['成交價', '成交量'] }} />
            <QueryField field={{ label: '比較', options: ['≥', '≤'] }} />
            <QueryField field={{ label: '門檻', type: 'number' }} />
            <Button size='compact' variant='ghost' aria-label={`刪除條件 ${index + 1}`} disabled={rows.length === 1} onClick={() => setRows(rows.filter(row => row !== id))}>移除</Button>
        </div>)}
        <Button size='compact' variant='outline' onClick={() => { setRows([...rows, nextId]); setNextId(nextId + 1); }}>新增條件</Button>
        <p className={s.muted}>僅編輯畫面草稿，未儲存至券商；接通後仍須檢核條件種類與數量限制。</p>
    </section>;
}

function EventCalendar() {
    const [month, setMonth] = useState(() => new Date(new Date().getFullYear(), new Date().getMonth(), 1));
    const year = month.getFullYear(), m = month.getMonth();
    const days = new Date(year, m + 1, 0).getDate(), offset = month.getDay();
    return <section className={s.section} aria-label='股務月份行事曆'>
        <div className={s.actions}>
            <Button size='compact' variant='outline' onClick={() => setMonth(new Date(year, m - 1, 1))}>上個月</Button>
            <strong>{year} 年 {m + 1} 月</strong>
            <Button size='compact' variant='outline' onClick={() => setMonth(new Date(year, m + 1, 1))}>下個月</Button>
        </div>
        <div className={s.calendar}>{['日', '一', '二', '三', '四', '五', '六'].map(day => <span className={s.day} key={day}>{day}</span>)}
            {Array.from({ length: offset + days }, (_, i) => <span className={s.day} key={i}>{i < offset ? '' : i - offset + 1}</span>)}
        </div>
        <span className={s.muted}>尚未載入股務事件；格內空白不代表當日沒有事件。</span>
    </section>;
}

/** Intentionally no hooks for accounts, quotes, subscriptions or mutations.
 * Local form editing works; every remote operation remains disabled. */
export function FubonApiPanel({ type }: { type: FubonApiPanelType }) {
    const [tab, setTab] = useState(0);
    const tabs = views[type], view = tabs[tab] ?? tabs[0]!;
    return <div className={s.root} data-api-panel={type}>
        <div className={s.notice} role='status'><LockKeyhole size={15} /><div>
            <span className={s.badge}>版面已備妥 · API 尚未接通</span>
            <div className={s.muted}>可編輯查詢條件；資料查詢、訂閱與送出操作暫停使用。</div>
        </div></div>
        <nav className={s.tabs} aria-label={`${FUBON_API_PANELS[type].label}功能`}>
            {tabs.map((item, index) => <Button key={item.title} size='compact' variant={index === tab ? 'secondary' : 'ghost'} aria-pressed={index === tab} onClick={() => setTab(index)}>{item.title}</Button>)}
        </nav>
        <div className={s.fields} key={view.title}>{view.fields.map((field, index) => <QueryField key={`${view.title}:${index}`} field={field} />)}</div>
        {type === 'fuboncondition' && <section className={s.section} aria-label='觸發後委託草稿'><strong>觸發後委託</strong><div className={s.fields}>
            {[{ label: '買賣方向', options: ['買進', '賣出'] }, { label: tab === 3 ? '口數' : '股數', type: 'number' as const }, { label: '委託價格', type: 'number' as const }].map(field => <QueryField key={field.label} field={field} />)}
        </div></section>}
        {type === 'fuboncondition' && tab === 0 && <ConditionDraft />}
        {type === 'fuboncorporate' && <EventCalendar />}
        {view.metrics && <div className={s.metrics}>{view.metrics.map(metric => <div className={s.metric} key={metric}>
            <span>{metric}</span><span className={s.value} aria-label={`${metric}尚未取得`}>—</span><span className={s.muted}>尚未取得</span>
        </div>)}</div>}
        {(type === 'fubontechnical' || (type === 'fubonindices' && tab === 1)) && <div className={s.chart}>接通後呈現日期與數值走勢</div>}
        <p className={s.muted}>{view.note}</p>
        <div className={s.tableWrap}><table className={s.table} aria-label={`${view.title}資料`}>
            <thead><tr>{view.columns.map(column => <th scope='col' key={column}>{column}</th>)}</tr></thead>
            <tbody><tr><td colSpan={view.columns.length}>資料尚未接入</td></tr></tbody>
        </table></div>
        <div className={s.actions}>
            <Button size='sm' disabled title='API 尚未接通'>{view.action ?? '查詢資料'}</Button>
            <a className={s.muted} href={base + view.path} target='_blank' rel='noreferrer'>官方文件 <ExternalLink size={11} style={{ display: 'inline' }} /></a>
        </div>
    </div>;
}
