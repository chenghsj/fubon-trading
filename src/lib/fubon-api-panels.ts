/** Function screens for documented native APIs whose adapters are not ready.
 * These definitions contain no requests and no fabricated response values. */
export const FUBON_API_PANELS = {
    fuboncredit: { label: '資券與當沖配額', description: '融資、融券額度與個股當沖資格' },
    fubonaccount: { label: '券商交割與損益', description: '交割明細、已實現損益與期權平倉紀錄' },
    fuboncondition: { label: '富邦智慧條件單', description: '編輯券商觸發條件、停損停利與移動鎖利' },
    fubonownership: { label: '法人與股權分布', description: '三大法人、董監、ETF 持股與集保分布' },
    fuboncorporate: { label: '股務行事曆', description: '除權息與資本變動的日期檢視' },
    fubontechnical: { label: '富邦指標與統計', description: '官方 SMA、RSI、MACD、KDJ 與布林通道' },
    fubonhistory: { label: '期權歷史日行情', description: '依商品、契約月份與盤別查詢歷史日行情' },
    fubonindices: { label: '富邦指數行情', description: '上市櫃指數清單與指數即時訂閱' },
    fubonadvanced: { label: '進階委託工作台', description: '複式單、批次委託與委託歷程' },
} as const;

export type FubonApiPanelType = keyof typeof FUBON_API_PANELS;
export function isFubonApiPanel(type: string): type is FubonApiPanelType {
    return Object.hasOwn(FUBON_API_PANELS, type);
}
function meta(type: FubonApiPanelType) {
    return { ...FUBON_API_PANELS[type], category: 'brokerapi' as const,
        pinnable: false, singleton: false, defaultSize: { w: 9, h: 16, minW: 5, minH: 10 } };
}
export const FUBON_API_BLOCK_META = {
    fuboncredit: meta('fuboncredit'), fubonaccount: meta('fubonaccount'),
    fuboncondition: meta('fuboncondition'), fubonownership: meta('fubonownership'),
    fuboncorporate: meta('fuboncorporate'), fubontechnical: meta('fubontechnical'),
    fubonhistory: meta('fubonhistory'), fubonindices: meta('fubonindices'),
    fubonadvanced: meta('fubonadvanced'),
};
