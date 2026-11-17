import { knownServerInfo } from './server-info-store';
import type { ServerInfo } from './shioaji';
import type { BlockType } from './workspace';
import { isFubonApiPanel } from './fubon-api-panels';

export const FUBON_AUTOMATION_UNAVAILABLE = '富邦成交驅動的自動交易尚未支援；請手動管理部位，未建立自動停損停利保護';
export function isFubonBroker() { return knownServerInfo()?.broker === 'fubon'; }

// These panels depend on adapters absent from this fork. Keep the same gate
// for every entry point and for restored workspaces; don't mount their feeds.
const unavailable: Partial<Record<BlockType, string>> = {
    warrants: '尚未轉接完整權證清單與標的篩選',
    combo: '尚未轉接複式單解析與原子委託',
    combolist: '尚未轉接組合商品清單與報價',
    conditional: '尚未支援富邦觸價單與成交後自動停損停利',
    oddspread: '尚未支援零股即時行情與兩腳自動執行',
    heatmap: '尚未轉接完整指數成分與貢獻資料',
    chainmap: '尚未轉接產業鏈所需的即時分 K 資金流',
    holdingmap: '尚未轉接持股族群所需的即時資金流',
    pulse: '尚未轉接自算指數與成分股貢獻',
    signals: '尚未轉接市場訊號訂閱',
    assistant: '此 Web 版本未提供 AI Agent 模組',
    optchain: '選擇權清單已接入；完整 T 字的訂閱釋放、速率控制與交易級距尚未完成',
};

const limitations: Partial<Record<BlockType, string>> = {
    tape: '市場最新交易日逐筆；非個人券商成交紀錄',
    replay: '僅提供行情來源目前交易日逐筆，最多 50,000 筆',
    volprofile: '原生分價量；期貨來源未提供內外盤分類',
    depthmap: '自開啟起累積五檔，沒有歷史委託簿回補',
    company: '外部公開公司資料，非富邦 API',
    optpnl: '本機到期損益試算，非券商帳務',
    backtest: '本機日內研究與回測',
    grid: '多筆個別委託，沒有原子批次保證',
    dock: '帳務部分支援；未轉接的欄位會停用',
};

export function panelUnavailable(type: BlockType, info = knownServerInfo()): string | undefined {
    if (isFubonApiPanel(type) && info?.broker !== 'fubon') return '此功能需要富邦 API 服務';
    if (isFubonApiPanel(type) && info?.native_panel_api !== 1) return '後端尚未更新至原生面板 API 版本';
    if (info?.broker !== 'fubon') return undefined;
    if (type === 'chips' && info.native_panel_api !== 1) return '籌碼查詢需要新版富邦原生面板 API';
    if (type === 'pnl' && info.mode !== 'paper' && info.mode !== 'demo') {
        return '尚未支援完整的券商證券／期貨歷史損益；請使用券商帳務查詢';
    }
    if (type === 'autotrade' && info.mode !== 'paper' && info.mode !== 'sandbox') {
        return '自動交易只支援 Paper／Sandbox';
    }
    return unavailable[type];
}

export function panelLimitation(type: BlockType, info: ServerInfo | undefined): string | undefined {
    if (isFubonApiPanel(type)) return type==='fuboncondition'||type==='fubonadvanced'
        ? '原生查詢與草稿檢核；Paper 不送出券商委託'
        : '富邦原生 API 資料查詢';
    if (info?.broker !== 'fubon') return undefined;
    if (type === 'chips') return '富邦盤後籌碼：法人、董監、ETF 與集保分布；非帳戶資券配額';
    if (type === 'pnl') return '本機平均成本平倉損益，費稅依模擬設定';
    if (type === 'autotrade') return '本機 Paper／Sandbox 策略，不支援正式自動交易';
    return limitations[type];
}
