import { useEffect, useRef, useState } from 'react';
import { Radio, ExternalLink } from 'lucide-react';
import { Button } from './ui/button';
import { FUBON_API_PANELS, type FubonApiPanelType } from '../lib/fubon-api-panels';
import * as s from './fubon-api-panel.css';
import { fetchNativeAccounts, queryNative, validateNativeDraft, submitNativeAction, subscribeNativeIndex, unsubscribeNativeIndex, fetchNativeAttempts, reconcileNativeAttempt, nativeAccountKey, type PendingNativeAttempt, type NativeAccount, type NativeResult } from '../lib/native-panels';
import { useServerInfo } from '../lib/server-info-store';
import { onStreamEvent } from '../lib/stream';
import { todayStr } from '../lib/utils/date';
import { usePrivacyMode, usePrivacyMoney, maskAccountId, revealText } from '../lib/privacy';
import { nativeDisplay } from '../lib/native-display';
import { useNativeAttempt, forgetNativeAttempt } from '../lib/native-attempts';

type Field = { label: string; type?: 'date' | 'number' | 'text'; options?: string[]; placeholder?: string };
type View = { title: string; path: string; fields: Field[]; columns: string[]; metrics?: string[]; note: string; action?: string };
const stock: Field = { label: '股票代號', placeholder: '例如 2330' };
const account: Field = { label: '券商帳戶', options: ['請選擇券商查詢帳戶'] };
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
        { title: '證券已實現', path: 'trading/library/python/accountManagement/RealizedPnLDetail/', fields: [account, ...range], columns: ['日期', '股票', '成交股數', '成交價', '已實現損益'], note: '日期篩選僅作用於來源實際回傳範圍，不保證涵蓋所有歷史。' },
        { title: '期權平倉紀錄', path: 'trading-future/library/python/accountManagement/ClosePositionRecord/', fields: [account, ...range], columns: ['日期', '契約', '方向', '原始口數', '價格', '手續費', '稅'], note: '平倉紀錄未提供配對開倉價，這裡不推造逐筆實現損益。' },
        { title: '信用維持率', path: 'trading/library/python/accountManagement/Maintenance/', fields: [account], metrics: ['整戶維持率', '融資市值', '融券市值'], columns: ['股票', '融資／融券', '市值', '維持率'], note: '與 Paper 權益分開呈現，僅使用券商核定的信用帳務資料。' },
    ],
    fuboncondition: [
        { title: '單一／多條件', path: 'smart-condition/library/python/MultiCondition/', fields: [account, stock, { label: '條件模式', options: ['多條件（原生規則待核對）'] }, { label: '有效日期', type: 'date' }], columns: ['條件單號', '商品', '觸發條件', '有效期間', '狀態'], note: '此為券商條件單草稿；尚未建立、啟用任何自動保護。', action: '建立條件單' },
        { title: '停損停利', path: 'smart-condition/library/python/SingleConditionTPSL/', fields: [account, stock, { label: '停損觸發價', type: 'number' }, { label: '停利觸發價', type: 'number' }], columns: ['條件單號', '商品', '停損價', '停利價', '委託狀態'], note: '觸發與委託執行為不同階段；未送出前沒有停損停利保護。', action: '送出停損停利' },
        { title: '移動鎖利', path: 'smart-condition/library/python/trailprofit/TrailOrder/', fields: [account, stock, { label: '啟動價', type: 'number' }, { label: '回撤價差', type: 'number' }], columns: ['條件單號', '商品', '啟動價', '回撤設定', '追蹤狀態'], note: '先編輯並檢核草稿；送出後須查詢券商實際生效狀態。', action: '建立移動鎖利' },
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
        { title: '指數清單', path: 'market-data/http-api/intraday/tickers/', fields: [market, { label: '名稱或代碼', placeholder: '搜尋指數' }], columns: ['指數代號', '名稱', '市場'], note: '從官方 INDEX 商品清單載入，指數行情不提供可交易委託。' },
        { title: '即時指數', path: 'market-data/websocket-api/market-data-channels/indices/', fields: [{ label: '指數代號', placeholder: '輸入官方指數代號' }], metrics: ['最新指數', '漲跌', '更新時間'], columns: ['時間', '指數值'], note: '僅為官方指數串流；不推造個股指數貢獻或自算指數。', action: '訂閱指數' },
    ],
    fubonadvanced: [
        { title: '期權複式單', path: 'trading-future/library/python/trade/PlaceOrder/', fields: [account, { label: '第一腳契約', placeholder: '具體契約代碼' }, { label: '第一腳方向', options: ['買進', '賣出'] }, { label: '第二腳契約', placeholder: '具體契約代碼' }, { label: '第二腳方向', options: ['賣出', '買進'] }, { label: '共同口數', type: 'number' }, { label: '價差', type: 'number' }], columns: ['第一腳', '第二腳', '口數', '委託價差', '狀態'], note: '兩腳、等口數的原生委託版面；未拆成兩張單腳委託送出。', action: '送出複式單' },
        { title: '批次委託', path: 'trading/library/python/trade/batchOrder/BatchPlaceOrder/', fields: [account, stock, { label: '買賣方向', options: ['買進', '賣出'] }, { label: '數量（股）', type: 'number' }, { label: '限價', type: 'number' }], columns: ['商品', '方向', '股數', '價格', '檢核狀態'], note: '使用原生批次請求，逐筆顯示結果；不保證整批原子成交。', action: '送出批次委託' },
        { title: '委託歷程', path: 'trading/library/python/trade/OrderHistory/', fields: [account, ...range], columns: ['委託時間', '委託單號', '商品', '狀態', '價格', '數量'], note: '歷史券商委託、成交與即時本機委託分開查閱。' },
    ],
};

const operations: Record<FubonApiPanelType,string[]> = {
 fuboncredit:['credit_margin','credit_daytrade'],fubonaccount:['settlements','realized','close_records','maintenance'],
 fuboncondition:['conditions','conditions','trails','conditions'],fubonownership:['institutional','director','etf','tdcc'],
 fuboncorporate:['dividends','capital','listings'],fubontechnical:['sma','rsi','macd','kdj','bb','stats'],
 fubonhistory:['daily','option_candles'],fubonindices:['indices','index_quote'],fubonadvanced:['order_history','batch_lists','order_history'],
};
const fieldKeys: Record<string,string> = {
 '股票代號':'symbol','ETF 代號':'symbol','商品代號':'symbol','具體月份契約':'symbol','指數代號':'symbol',
 '開始日期':'start','結束日期':'end','有效開始日':'start','有效日期':'end','交易日':'date','資料日期':'date',
 '市場':'market','盤別':'session','契約月份':'month','履約價':'strike','買賣權':'right','K 線週期':'timeframe',
 '計算週期':'period','快線週期':'fast','慢線週期':'slow','信號線週期':'signal','RSV 週期':'r_period','K 週期':'k_period','D 週期':'d_period',
 '查詢範圍':'settlement_range','名稱或代碼':'search','停損觸發價':'stop_loss','停利觸發價':'take_profit','啟動價':'price',
 '回撤價差':'trail_percentage','買賣方向':'side','股數':'quantity','口數':'quantity','委託價格':'price','限價':'price',
 '第一腳契約':'leg1','第二腳契約':'leg2','第一腳方向':'side1','第二腳方向':'side2','共同口數':'quantity','價差':'price',
 '數量（股）':'quantity','條件單號':'guid','批次序號':'batch_id','追蹤方向':'direction','加減檔數':'price_diff','倉別':'order_type',
};
const choices: Record<string,string> = {'上市':'TSE','上櫃':'OTC','日盤':'regular','夜盤':'afterhours','買權 C':'C','賣權 P':'P','日 K':'D','週 K':'W','月 K':'M','1 分 K':'1','5 分 K':'5','15 分 K':'15','60 分 K':'60','買進':'Buy','賣出':'Sell','近三日':'3d','本日':'0d','向下回撤':'Down','向上回升':'Up','新倉':'New','平倉':'Close'};
const numericKeys=new Set(['strike','period','fast','slow','signal','r_period','k_period','d_period','quantity','price','stop_loss','take_profit','trail_percentage','price_diff']);
const queryKeys=new Set(['symbol','search','start','end','date','market','session','month','right','strike','timeframe','period','fast','slow','signal','r_period','k_period','d_period','settlement_range','guid','batch_id']);
const defaultNums: Record<string,string>={period:'20',fast:'12',slow:'26',signal:'9',r_period:'9',k_period:'3',d_period:'3',quantity:'1000',price_diff:'0',trail_percentage:'5'};
function offsetDate(n:number){const d=new Date(todayStr()+'T12:00:00');d.setDate(d.getDate()+n);return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;}
function text(value:unknown,key='',op=''):string {
 if(value===null&&op==='credit_margin'){if(key.includes('quota'))return '無上限';if(key==='margin_ratio')return '停資';if(key==='short_ratio')return '停券';}
 if(value===null&&op==='credit_daytrade'&&key.startsWith('precollect_'))return '不需預收';
 if(value===null||value===undefined)return '—';
 if(typeof value==='number')return value.toLocaleString('zh-TW',{maximumFractionDigits:8});
 return typeof value==='object'?JSON.stringify(value):String(value);
}
function QueryField({field,value,onChange}:{field:Field;value:string;onChange:(value:string)=>void}){
 return <label className={s.label}>{field.label}{field.options?<select className={s.input} value={value} onChange={e=>onChange(e.target.value)}>{field.options.map(item=><option key={item}>{item}</option>)}</select>:<input className={s.input} value={value} type={field.type??'text'} step={field.type==='number'?'any':undefined} placeholder={field.placeholder} onChange={e=>onChange(e.target.value)}/>}</label>;
}
function Results({data,onIndex,accountScoped}:{data:NativeResult;onIndex?:(symbol:string)=>void;accountScoped:boolean}){
 const priv=usePrivacyMode(),money=usePrivacyMoney();
 const display=(value:unknown,key:string)=>text(nativeDisplay(value,key,priv,money,accountScoped),key,data.operation);
 const seriesKeys=['sma','rsi','macdLine','signalLine','k','d','j','upper','middle','lower','close'].filter(key=>data.rows.some(row=>typeof row[key]==='number'));
 const points=data.rows.slice(-200),all=points.flatMap(row=>seriesKeys.flatMap(key=>typeof row[key]==='number'?[row[key] as number]:[]));
 const min=Math.min(...all),max=Math.max(...all),colors=['currentColor','#b87826','#178e7d','#b65f60','#8872a7'];
 return <section className={s.section} aria-label='富邦查詢結果'><div className={s.muted}>富邦 · 擷取 {data.fetched_at} · {data.rows.length} 筆</div>{data.note&&<p className={s.muted}>{data.note}</p>}
 {Object.keys(data.summary).length>0&&<div className={s.metrics}>{Object.entries(data.summary).map(([key,value])=><div className={s.metric} key={key}><span>{data.columns.find(c=>c.key===key)?.label??key}</span><strong>{display(value,key)}</strong></div>)}</div>}
 {seriesKeys.length>0&&<figure><figcaption className={s.muted}>來源走勢 · 最近 {points.length} 筆 · {seriesKeys.join(' / ')} · {text(min)}～{text(max)}</figcaption><svg viewBox='0 0 600 130' role='img' aria-label='富邦來源資料走勢' style={{width:'100%',minHeight:100}}>{seriesKeys.map((key,n)=><polyline key={key} fill='none' stroke={colors[n%colors.length]} strokeWidth={1.5} points={points.flatMap((row,i)=>typeof row[key]==='number'?[`${5+i/Math.max(1,points.length-1)*590},${120-((row[key] as number)-min)/(max-min||1)*110}`]:[]).join(' ')}/>)}</svg></figure>}
 <div className={s.tableWrap}><table className={s.table}><thead><tr>{data.columns.map(col=><th key={col.key} scope='col'>{col.label}</th>)}{data.detail_keys.length>0&&<th>父子／詳細紀錄</th>}{onIndex&&<th>查看</th>}</tr></thead><tbody>{data.rows.length?data.rows.map((row,i)=><tr key={i}>{data.columns.map(col=><td key={col.key}>{display(row[col.key],col.key)}</td>)}{data.detail_keys.length>0&&<td>{data.detail_keys.map(key=><details key={key}><summary>{key}</summary><pre>{JSON.stringify(nativeDisplay(row[key],key,priv,money,accountScoped),null,2)}</pre></details>)}</td>}{onIndex&&<td><Button size='compact' variant='outline' onClick={()=>onIndex(String(row.symbol))}>查看指數</Button></td>}</tr>):<tr><td colSpan={Math.max(1,data.columns.length)}>來源未回傳符合條件的資料</td></tr>}</tbody></table></div></section>;
}
function Calendar({data}:{data:NativeResult|null}){
 const [month,setMonth]=useState(()=>new Date(todayStr()+'T12:00:00')),year=month.getFullYear(),m=month.getMonth();
 const days=new Date(year,m+1,0).getDate(),offset=new Date(year,m,1).getDay(),events=new Map<string,string[]>();
 for(const row of data?.rows??[]){const date=Object.entries(row).find(([key,value])=>/^(exDividendDate|exRightsAndDividendDate|effectiveDate|applicationDate|date)$/.test(key)&&typeof value==='string')?.[1];if(typeof date==='string')events.set(date.slice(0,10),[...(events.get(date.slice(0,10))??[]),String(row.symbol??row.name??'事件')]);}
 return <section className={s.section} aria-label='股務月份行事曆'><div className={s.actions}><Button size='compact' variant='outline' onClick={()=>setMonth(new Date(year,m-1,1))}>上個月</Button><strong>{year} 年 {m+1} 月</strong><Button size='compact' variant='outline' onClick={()=>setMonth(new Date(year,m+1,1))}>下個月</Button></div><div className={s.calendar}>{['日','一','二','三','四','五','六'].map(day=><span className={s.day} key={day}>{day}</span>)}{Array.from({length:offset+days},(_,i)=>{const day=i-offset+1,key=`${year}-${String(m+1).padStart(2,'0')}-${String(day).padStart(2,'0')}`;return <span className={s.day} key={i}>{i>=offset&&<>{day}{events.get(key)?.map((value,n)=><small key={n} style={{display:'block'}}>{value}</small>)}</>}</span>;})}</div><span className={s.muted}>{data?'僅標示本次已查詢區間內的事件；其他日期未查詢。':'請先查詢股務事件；空白不代表當日沒有事件。'}</span></section>;
}
type Trigger={id:string;trigger:string;comparison:string;value:string};
function NativeView({type,tab,view,indexCode,onIndex,conditionMarket,initialSymbol}:{type:FubonApiPanelType;tab:number;view:View;indexCode:string;onIndex:(code:string)=>void;conditionMarket:'S'|'F';initialSymbol?:string}){
 const info=useServerInfo(),op=operations[type][tab]!;
 const priv=usePrivacyMode(),money=usePrivacyMoney();
 const action=type==='fuboncondition'?['condition_create','condition_tpsl','trail_create','condition_create'][tab]:type==='fubonadvanced'&&tab<2?['dualleg_place','batch_place'][tab]:undefined;
 const kind=type==='fuboncredit'?'S':type==='fubonaccount'?(tab===2?'F':'S'):type==='fuboncondition'?(tab===3?'F':conditionMarket):type==='fubonadvanced'?(tab===0?'F':tab===1?'S':'any'):undefined;
 let fields=view.fields.filter(field=>field.label!=='券商帳戶'&&fieldKeys[field.label]);
 if(type==='fuboncorporate'&&tab<2)fields=[...fields,...range];
 if(op==='option_candles')fields=[...fields,{label:'盤別',options:['日盤','夜盤']},{label:'K 線週期',options:['日 K','週 K','月 K','1 分 K','5 分 K','15 分 K','60 分 K']}];
 if(type==='fuboncondition')fields=[...fields,{label:'有效開始日',type:'date'},{label:'買賣方向',options:['買進','賣出']},{label:kind==='F'?'口數':'股數',type:'number'},...(tab!==2?[{label:'委託價格',type:'number'}] satisfies Field[]:[]),...(kind==='F'?[{label:'盤別',options:tab===2?['日盤']:['日盤','夜盤']},{label:'倉別',options:['新倉','平倉']}] satisfies Field[]:[]),...(tab===2?[{label:'追蹤方向',options:['向下回撤','向上回升']},{label:'加減檔數',type:'number'}] satisfies Field[]:[])];
 if(type==='fuboncondition'&&kind==='F')fields=fields.map(field=>field.label==='股票代號'?{...field,label:'具體月份契約'}:field);
 if(type==='fuboncondition'&&!fields.some(field=>fieldKeys[field.label]==='end'))fields=[...fields,{label:'有效日期',type:'date'}];
 const [values,setValues]=useState<Record<string,string>>(()=>Object.fromEntries(fields.map(field=>{
  const key=fieldKeys[field.label]!;
  let value=field.options?.[0]??'';
  if(key==='session'&&!action)value=info?.session==='afterhours'?'夜盤':'日盤';
  else if(field.type==='date')value=key==='start'?(action?todayStr():offsetDate(-7)):key==='end'&&action?offsetDate(7):todayStr();
  else if(!field.options)value=(key==='quantity'&&kind==='F'?'1':defaultNums[key])??(key==='symbol'?(op==='daily'?'TXF':op==='option_candles'?'TXO':op==='index_quote'?indexCode:op==='etf'?'0050':initialSymbol??(type==='fuboncorporate'||kind==='F'?'':'2330')):'');
  return [key,value];
 })));
 const [accounts,setAccounts]=useState<NativeAccount[]>([]),[accountIndex,setAccountIndex]=useState('');
 const [triggers,setTriggers]=useState<Trigger[]>(()=>[{id:crypto.randomUUID(),trigger:'MatchedPrice',comparison:'GreaterThanOrEqual',value:''}]);
 const [batch,setBatch]=useState<Record<string,unknown>[]>([]),[data,setData]=useState<NativeResult|null>(null);
 const [error,setError]=useState(''),[notice,setNotice]=useState(''),[loading,setLoading]=useState(false),[sending,setSending]=useState(false);
 const [liveSource,setLiveSource]=useState<'snapshot'|'stream'>('snapshot');
 const [review,setReview]=useState<Record<string,unknown>|null>(null),[live,setLive]=useState(false),[liveData,setLiveData]=useState<Record<string,unknown>|null>(null),[guid,setGuid]=useState('');
 const lease=useRef(crypto.randomUUID()),pending=useRef<AbortController|null>(null);
 const selected=accountIndex!==''?accounts[Number(accountIndex)]:undefined,modeWrites=info?.mode==='sandbox'||info?.mode==='live';
 const accountKey=selected?nativeAccountKey(selected,info?.mode??'paper'):'';
 const localAttempt=useNativeAttempt(accountKey);
 const [serverAttempts,setServerAttempts]=useState<PendingNativeAttempt[]>([]),[attemptLoading,setAttemptLoading]=useState(false),[attemptError,setAttemptError]=useState(''),[checked,setChecked]=useState(false);
 const blockedAttempts=[...serverAttempts,...(localAttempt&&!serverAttempts.some(row=>row.request_id===localAttempt.request_id)?[{...localAttempt,status:'uncertain'}]:[])];
 const canWrite=modeWrites&&!!selected&&!blockedAttempts.length&&!attemptLoading&&!attemptError;
 useEffect(()=>{if(!selected){setServerAttempts([]);return;}let active=true;setAttemptLoading(true);setAttemptError('');setChecked(false);void fetchNativeAttempts(selected).then(rows=>{if(active)setServerAttempts(rows);}).catch(reason=>{if(active)setAttemptError(String(reason));}).finally(()=>{if(active)setAttemptLoading(false);});return()=>{active=false;};},[accountKey,localAttempt?.request_id]);
 useEffect(()=>{if(!kind)return;const controller=new AbortController();void fetchNativeAccounts(controller.signal).then(rows=>setAccounts(rows.filter(row=>kind==='any'||row.account_type===kind))).catch(reason=>{if(!controller.signal.aborted)setError(String(reason));});return()=>controller.abort();},[kind,info?.instance_id]);
 useEffect(()=>()=>pending.current?.abort(),[]);
 const invalidate=()=>{pending.current?.abort();setLoading(false);setData(null);setNotice('');setError('');};
 const change=(key:string,value:string)=>{invalidate();if(key==='symbol'){setLive(false);setLiveData(null);}setValues(old=>({...old,[key]:value}));setReview(null);};
 const accountBody=()=>{if(!kind)return undefined;if(!selected)throw new Error('請選擇券商查詢帳戶');return {account_type:selected.account_type,broker_id:selected.broker_id,account_id:selected.account_id};};
 const convert=(key:string,value:string)=>numericKeys.has(key)?Number(value):choices[value]??(key==='symbol'?value.trim().toUpperCase():value);
 const queryBody=(operation=op)=>{
  const body:Record<string,unknown>={operation};if(kind)body.account=accountBody();
  for(const [key,value]of Object.entries(values))if(queryKeys.has(key)&&value!=='')body[key]=convert(key,value);
  if(action&&operation!=='condition_history'&&operation!=='trail_history'){delete body.start;delete body.end;}
  if(operation==='order_history'&&action){body.start=offsetDate(-1);body.end=todayStr();}
  if(operation==='condition_by_id')body.guid=guid;
  return body;
 };
 const query=async(operation=op)=>{setError('');setNotice('');pending.current?.abort();const controller=new AbortController();pending.current=controller;setLoading(true);try{const result=await queryNative(queryBody(operation),controller.signal);if(!controller.signal.aborted)setData(result);}catch(reason){if(!controller.signal.aborted)setError(reason instanceof Error?reason.message:String(reason));}finally{if(!controller.signal.aborted)setLoading(false);}};
 const actionBody=(operation=action)=>{
  if(!operation)throw new Error('未指定券商操作');
  const body:Record<string,unknown>={operation,account:accountBody(),instance_id:info?.instance_id,request_id:crypto.randomUUID()};
  const ids=['symbol','start','end','side','quantity','price','stop_loss','take_profit','trail_percentage','direction','price_diff','session','order_type'];
  for(const key of ids)if(values[key]!==undefined&&values[key]!=='')body[key]=convert(key,values[key]!);
  if(kind==='F')body.quantity=Number(values.quantity||'1');
  if(operation==='trail_create'&&kind==='F'){body.trail_ticks=Number(values.trail_percentage);delete body.trail_percentage;}
  if(operation==='condition_create'||operation==='condition_tpsl')body.triggers=triggers.map(row=>({trigger:row.trigger,comparison:row.comparison,value:Number(row.value)}));
  if(operation==='dualleg_place')body.legs=[{symbol:values.leg1?.trim().toUpperCase(),side:choices[values.side1??'買進'],quantity:body.quantity},{symbol:values.leg2?.trim().toUpperCase(),side:choices[values.side2??'賣出'],quantity:body.quantity}];
  if(operation==='batch_place')body.legs=batch.length?batch:[{symbol:String(body.symbol??''),side:body.side??'Buy',quantity:Number(body.quantity),price:Number(body.price)}];
  if(operation==='condition_cancel'){body.guid=guid;for(const key of ids)delete body[key];}
  return body;
 };
 const validate=async()=>{setError('');try{setNotice((await validateNativeDraft(actionBody())).message);}catch(reason){setError(reason instanceof Error?reason.message:String(reason));}};
 const prepare=(operation=action)=>{setError('');try{setReview(actionBody(operation));}catch(reason){setError(String(reason));}};
 const send=async()=>{if(!review||!canWrite)return;const body=review;setReview(null);setSending(true);setError('');try{setData(await submitNativeAction(body,info?.mode??'paper'));setNotice('券商已回覆，請重新查詢後續狀態；送出回覆不代表已成交。');}catch(reason){setError(reason instanceof Error?reason.message:String(reason));}finally{setSending(false);}};
 const symbol=(values.symbol??'').trim().toUpperCase();
 useEffect(()=>{if(!live)return;let active=true,received=false;const id=lease.current;
  const off=onStreamEvent('fubon_index',raw=>{try{const result=JSON.parse(raw) as Record<string,unknown>;if(active&&result.symbol===symbol){received=true;setLiveData(result);setLiveSource('stream');}}catch{if(active)setError('指數事件格式錯誤');}});
  const offError=onStreamEvent('fubon_index_error',()=>{if(active)setError('指數訂閱回應不完整，請停止後重新訂閱');});
  const renew=()=>void subscribeNativeIndex(id,symbol).then(result=>{if(active&&!received&&result.baseline){setLiveData(result.baseline);setLiveSource('snapshot');}}).catch(reason=>{if(active){setError(String(reason));setLive(false);}});renew();const timer=setInterval(renew,30_000);
  return()=>{active=false;clearInterval(timer);off();offError();void unsubscribeNativeIndex(id,symbol).catch(()=>{});};
 },[live,symbol]);
 return <>
 <div className={s.notice} role='status'><Radio size={15}/><div><strong>富邦原生 API</strong><div className={s.muted}>{kind?'本面板的券商帳戶獨立選擇，不改動主下單面板帳戶。':'查詢富邦原始資料，缺值保留未知。'}{action&&!modeWrites?' Paper／展示模式只可查詢與檢核草稿，不送出券商委託。':''}</div></div></div>
 {kind&&<label className={s.label}>券商查詢帳戶<select className={s.input} value={accountIndex} disabled={sending} onChange={e=>{invalidate();setAccountIndex(e.target.value);setData(null);setReview(null);}}><option value=''>請選擇券商帳戶</option>{accounts.map((row,index)=><option key={`${row.account_type}:${row.broker_id}:${row.account_id}`} value={index}>{row.account_type==='S'?'證券':'期權'} {maskAccountId(row.broker_id,priv)}-{maskAccountId(row.account_id,priv)}{row.environment==='sandbox'?' · 共用測試帳戶':''}</option>)}</select></label>}
 {attemptError&&<div role='alert'>送出結果核對狀態載入失敗，已停止券商送出；請重新選擇帳戶或重新連線。</div>}
 {blockedAttempts.length>0&&<section className={s.notice} aria-label='送出結果待核對'><div><strong>送出結果尚待核對，已鎖住此帳戶的券商送出</strong><p>請先查詢券商委託／條件單紀錄；不要以新識別碼重送相同意圖。</p>{blockedAttempts.map(row=><div key={row.request_id}>{row.operation} · {row.request_id} · {row.created_at}</div>)}<label><input type='checkbox' checked={checked} onChange={e=>setChecked(e.target.checked)}/> 我已於券商核對以上請求的實際結果</label><Button size='sm' variant='outline' disabled={!checked||sending} onClick={()=>{void (async()=>{try{for(const row of blockedAttempts){await reconcileNativeAttempt({account:accountBody(),request_id:row.request_id,instance_id:info?.instance_id,acknowledgement:'已於券商核對此請求'});forgetNativeAttempt(accountKey,row.request_id);}setServerAttempts([]);setChecked(false);setNotice('已記錄人工核對；未重新送出任何券商委託。');}catch(reason){setError(String(reason));}})();}}>記錄核對並解除鎖定</Button></div></section>}
 <div className={s.fields}>{fields.map((field,index)=>{const key=fieldKeys[field.label]!;return <QueryField key={field.label+index} field={{...field,...(field.label==='回撤價差'?{label:kind==='F'?'追蹤檔數':'追蹤距離（%）'}:{})}} value={values[key]??''} onChange={value=>change(key,value)}/>;})}</div>
 {type==='fuboncondition'&&tab!==2&&<section className={s.section} aria-label='觸發條件草稿'><strong>觸發條件</strong>{triggers.map((row,index)=><div className={s.condition} key={row.id}><QueryField field={{label:`條件 ${index+1}`,options:['成交價','累計成交量']}} value={row.trigger==='MatchedPrice'?'成交價':'累計成交量'} onChange={value=>{setTriggers(old=>old.map(item=>item.id===row.id?{...item,trigger:value==='成交價'?'MatchedPrice':'TotalQuantity'}:item));setReview(null);}}/><QueryField field={{label:'比較',options:['≥','≤','>','<']}} value={Object.entries({GreaterThanOrEqual:'≥',LessThanOrEqual:'≤',GreaterThan:'>',LessThan:'<'}).find(([key])=>key===row.comparison)?.[1]??'≥'} onChange={value=>{setTriggers(old=>old.map(item=>item.id===row.id?{...item,comparison:({'≥':'GreaterThanOrEqual','≤':'LessThanOrEqual','>':'GreaterThan','<':'LessThan'}[value]??'GreaterThanOrEqual')}:item));setReview(null);}}/><QueryField field={{label:'門檻',type:'number'}} value={row.value} onChange={value=>{setTriggers(old=>old.map(item=>item.id===row.id?{...item,value}:item));setReview(null);}}/><Button size='compact' variant='ghost' disabled={triggers.length===1} aria-label={`刪除條件 ${index+1}`} onClick={()=>{setTriggers(triggers.filter(item=>item.id!==row.id));setReview(null);}}>移除</Button></div>)}<Button size='compact' variant='outline' disabled={triggers.length>=5} onClick={()=>{setTriggers([...triggers,{id:crypto.randomUUID(),trigger:'MatchedPrice',comparison:'GreaterThanOrEqual',value:''}]);setReview(null);}}>新增條件</Button><span className={s.muted}>使用券商原生多條件規則；未提供未確認的 AND／OR 選項。</span></section>}
 {action==='batch_place'&&<section className={s.section} aria-label='批次委託草稿'><Button size='compact' variant='outline' disabled={batch.length>=50} onClick={()=>{setBatch([...batch,{symbol:symbol,side:choices[values.side??'買進'],quantity:Number(values.quantity),price:Number(values.price)}]);setReview(null);}}>加入本機批次草稿</Button>{batch.map((row,i)=><div key={i}>{String(row.symbol)} · {row.side==='Buy'?'買進':'賣出'} · {text(nativeDisplay(row.quantity,'quantity',priv,money,true))} 股 · {text(nativeDisplay(row.price,'price',priv,money,true))} 元 <Button size='compact' variant='ghost' onClick={()=>{setBatch(batch.filter((_,index)=>index!==i));setReview(null);}}>移除此筆</Button></div>)}<span className={s.muted}>批次不保證全成全敗；每筆券商回應個別保留。</span></section>}
 <div className={s.actions}><Button size='sm' variant='outline' disabled={loading||sending||info?.mode==='demo'||!info?.connected} title={info?.mode==='demo'?'展示模式無券商資料，請先連接 Paper 行情':undefined} onClick={()=>void query()}>{loading?'查詢中…':action?'查詢券商紀錄':'查詢資料'}</Button>
 {op==='index_quote'&&<Button size='sm' variant={live?'secondary':'outline'} disabled={!symbol} onClick={()=>{setError('');setLiveData(null);setLive(!live);}}>{live?'停止訂閱':'訂閱指數'}</Button>}
 {action&&<><Button size='sm' variant='outline' disabled={sending} onClick={()=>void validate()}>檢核草稿</Button><Button size='sm' disabled={!canWrite||sending} title={canWrite?'先核對再送出':'Paper／展示模式不送券商'} onClick={()=>prepare()}>核對券商送出內容</Button></>}
 <a className={s.muted} href={base+view.path} target='_blank' rel='noreferrer'>官方文件 <ExternalLink size={11} style={{display:'inline'}}/></a></div>
 {type==='fuboncondition'&&<div className={s.section}><QueryField field={{label:'條件單號'}} value={guid} onChange={value=>{invalidate();setGuid(value);setReview(null);}}/><div className={s.actions}><Button size='compact' variant='outline' onClick={()=>void query('condition_by_id')}>依單號查詢</Button><Button size='compact' variant='outline' onClick={()=>void query(tab===2?'trail_history':'condition_history')}>查詢建立日期歷史</Button><Button size='compact' variant='outline' disabled={!canWrite||!guid||sending} title={!canWrite?'Paper／展示模式不取消券商條件單':undefined} onClick={()=>prepare('condition_cancel')}>核對取消條件單</Button></div></div>}
 {type==='fubonadvanced'&&tab===1&&<div className={s.actions}><QueryField field={{label:'批次序號'}} value={values.batch_id??''} onChange={value=>change('batch_id',value)}/><Button size='compact' variant='outline' onClick={()=>void query('batch_detail')}>查詢批次執行明細</Button></div>}
 {review&&<section className={s.notice} aria-label='券商送出前核對'><div><strong>{info?.mode==='sandbox'?'官方 Sandbox 測試請求':'正式券商請求'} · 最後核對</strong><p>{selected?`${selected.account_type==='S'?'證券':'期權'} ${maskAccountId(selected.broker_id,priv)}-${maskAccountId(selected.account_id,priv)}`:''} · 請核對商品、股／口數、價格與有效期間。</p><pre style={{whiteSpace:'pre-wrap'}}>{JSON.stringify(nativeDisplay(review,'',priv,money,true),null,2)}</pre><Button size='sm' variant='destructive' disabled={sending||!canWrite} onClick={()=>void send()}>確認送出至券商</Button><Button size='sm' variant='ghost' onClick={()=>setReview(null)}>返回編輯</Button></div></section>}
 {sending&&<div role='status'>等待券商回覆，請勿重複送出…</div>}{error&&<div role='alert'>{money&&kind?'查詢或送出失敗；券商原始訊息已依遮金額設定隱藏。':revealText(error,{priv,privMoney:money,accountIds:accounts.flatMap(row=>[row.account_id,row.broker_id])})}</div>}{notice&&<div role='status'>{notice}</div>}
 {liveData&&<section aria-label='最新指數事件'><strong>{liveSource==='snapshot'?'富邦指數快照':'最新原生指數事件'}</strong><div className={s.metrics}>{Object.entries(liveData).filter(([,value])=>value===null||typeof value!=='object').map(([key,value])=><div className={s.metric} key={key}><span>{key}</span><strong>{text(value)}</strong></div>)}</div></section>}
 {type==='fuboncorporate'&&<Calendar data={data}/>}{data?<Results data={data} accountScoped={!!kind} onIndex={op==='indices'?onIndex:undefined}/>:<div className={s.muted}>請設定條件後查詢；來源回傳前不顯示範例數字。</div>}
 </>;
}
export function FubonApiPanel({type,initialSymbol}:{type:FubonApiPanelType;initialSymbol?:string}){
 const info=useServerInfo(),[tab,setTab]=useState(0),[indexCode,setIndexCode]=useState(''),[conditionMarket,setConditionMarket]=useState<'S'|'F'>('S'),tabs=views[type],view=tabs[tab]??tabs[0]!;
 if(info?.broker!=='fubon'||info.native_panel_api!==1)return <div className={s.root} role='status'>原生面板需要新版富邦 API 服務，請先更新服務後重新連線。</div>;
 return <div className={s.root} data-api-panel={type}><nav className={s.tabs} aria-label={`${FUBON_API_PANELS[type].label}功能`}>{tabs.map((item,index)=><Button key={item.title} size='compact' variant={tab===index?'secondary':'ghost'} aria-pressed={tab===index} onClick={()=>setTab(index)}>{item.title}</Button>)}</nav>{type==='fuboncondition'&&tab!==3&&<label className={s.label}>條件商品<select className={s.input} value={conditionMarket} onChange={e=>setConditionMarket(e.target.value as 'S'|'F')}><option value='S'>股票</option><option value='F'>期貨</option></select></label>}<NativeView key={`${type}:${tab}:${conditionMarket}:${info?.instance_id}:${initialSymbol??''}`} initialSymbol={initialSymbol} conditionMarket={conditionMarket} type={type} tab={tab} view={view} indexCode={indexCode} onIndex={code=>{setIndexCode(code);setTab(1);}}/></div>;
}
