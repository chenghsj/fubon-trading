export type StrategySession = 'cash' | 'regular' | 'afterhours';
export const SESSION_LABEL: Record<StrategySession, string> = {
    cash: '現貨重疊日盤 09:00–13:20',
    regular: '期貨日盤 08:45–13:45',
    afterhours: '期貨夜盤 15:00–次日05:00',
};
export const SESSION_RULE: Record<StrategySession, string> = {
    cash: '09:00–09:15 建立區間，09:20–13:10 判斷訊號，13:20 請求退出。',
    regular: '08:45–09:00 建立區間，09:05–13:20 判斷訊號，13:40 請求退出。',
    afterhours: '15:00–15:15 建立區間，15:20–次日04:35 判斷訊號，04:55 請求退出。午夜不重設額度，僅供 Paper。',
};
