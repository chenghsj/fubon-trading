import { useCallback, useEffect } from 'react';
import { useQuery } from '../hooks/use-query';
import { fetchVolumeProfile } from '../lib/shioaji';
import { useMarketSessionVersion } from '../lib/market-session';
import type { ContractBase } from '../lib/types/contract';
import { fmtInt, fmtPrice } from '../lib/utils/format';
import { AsyncStatus } from './async-status';
import { RefreshButton } from './refresh-button';
import * as panel from './panel.css';
import * as styles from './vol-profile.css';

/** Official session-to-date distribution, not a sample of the last 500 ticks. */
export function FubonVolProfile({ contract }: { contract: ContractBase }) {
    const marketSession = useMarketSessionVersion(contract.code);
    const query = useQuery(useCallback(() => fetchVolumeProfile(contract), [contract]),
        `fubon-volumes:${contract.security_type}:${contract.code}:${marketSession}`, true);
    useEffect(() => {
        const timer = setInterval(() => void query.refresh(), 15_000);
        return () => clearInterval(timer);
    }, [query.refresh]);
    const rows = query.data?.levels ?? [];
    const total = rows.reduce((sum, row) => sum + row.volume, 0);
    const buy = rows.reduce((sum, row) => sum + (row.buy_volume ?? 0), 0);
    const sell = rows.reduce((sum, row) => sum + (row.sell_volume ?? 0), 0);
    const unknown = Math.max(0, total - buy - sell);
    const max = Math.max(1, ...rows.map(row => row.volume));
    return <div className={styles.wrap}>
        <div className={panel.refreshToolbar}>
            <span>{query.data ? `${query.data.date} · ${query.data.source === 'demo' ? '展示' : `富邦${query.data.session === 'afterhours' ? '夜盤' : '日盤'}`}分價量` : '富邦分價量'}</span>
            <RefreshButton label='更新分價量' loading={query.loading} onClick={() => void query.refresh()} />
        </div>
        {query.error && <AsyncStatus phase='error' text={`分價量查詢失敗：${query.error}`} />}
        {total > 0 && <div className={styles.ratioRow}>
            {buy + sell > 0 ? <>
                <span className={panel.dirText.up}>外盤 {(buy / total * 100).toFixed(1)}%</span>
                <span className={panel.dirText.down}>內盤 {(sell / total * 100).toFixed(1)}%</span>
                {unknown > 0 && <span>未分類 {(unknown / total * 100).toFixed(1)}%</span>}
            </> : <span>來源未提供內外盤分類，僅顯示真實總量</span>}
        </div>}
        {query.loading && !query.data ? <AsyncStatus phase='loading' text='載入分價量…' />
            : !rows.length && !query.error ? <AsyncStatus phase='empty' text='此時段尚無分價量資料' /> : null}
        <div className={styles.list}>{rows.map(row => {
            const buy = row.buy_volume ?? 0, sell = row.sell_volume ?? 0;
            const unknown = Math.max(0, row.volume - buy - sell);
            return <div className={styles.row} key={row.price}>
                <span className={styles.price}>{fmtPrice(row.price)}</span>
                <div className={styles.barTrack}>
                    <div className={styles.barBuy} style={{ width: `${buy / max * 100}%` }} />
                    <div className={styles.barSell} style={{ width: `${sell / max * 100}%` }} />
                    <div className={styles.barUnknown} style={{ width: `${unknown / max * 100}%` }} />
                </div>
                <span className={styles.vol}>{fmtInt(row.volume)}</span>
            </div>;
        })}</div>
    </div>;
}
