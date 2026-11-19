import { useEffect, useMemo, useState, type Dispatch, type SetStateAction } from 'react';
import { apiGet } from '../lib/api';
import type { AutoConfig } from '../lib/auto-trading';
import type { ContractInfo } from '../lib/types/contract';
import { Button } from './ui/button';
import { SelectControl, SelectOption } from './ui/select-control';
import * as s from './auto-trading.css';

export function AutoContractField({ draft, setDraft, editable, onValidityChange }: {
    draft: AutoConfig; setDraft: Dispatch<SetStateAction<AutoConfig>>; editable: boolean;
    onValidityChange: (valid: boolean) => void;
}) {
    const [contracts, setContracts] = useState<ContractInfo[]>([]);
    const [error, setError] = useState(''), [loaded, setLoaded] = useState(false), [reload, setReload] = useState(0);
    useEffect(() => {
        const controller = new AbortController();
        setLoaded(false);
        setError('');
        void apiGet<ContractInfo[]>('/api/v1/data/contracts/futures?root=TMF&region=TW', { signal: controller.signal }).then(rows => {
            if (controller.signal.aborted) return;
            setContracts(rows.filter(row => row.security_type === 'FUT' && !row.target_code && /^TMF[A-L]\d$/.test(row.code)
                && row.multiplier === 10 && /^\d{4}-\d{2}-\d{2}$/.test(row.delivery_date ?? ''))
                .sort((a, b) => a.delivery_date!.localeCompare(b.delivery_date!) || a.code.localeCompare(b.code)));
            setLoaded(true);
        }).catch(e => {
            if (!controller.signal.aborted) setError(`合約清單讀取失敗：${e instanceof Error ? e.message : String(e)}`);
        });
        return () => controller.abort();
    }, [reload]);
    const eligible = useMemo(() => contracts.filter(row => row.delivery_date! > draft.trade_date
        || (draft.strategy_session ?? 'cash') === 'cash' && row.delivery_date === draft.trade_date),
    [contracts, draft.trade_date, draft.strategy_session]);
    const selected = contracts.find(row => row.code === draft.contract_code);
    const valid = loaded && eligible.some(row => row.code === draft.contract_code);
    useEffect(() => onValidityChange(valid), [valid, onValidityChange]);
    useEffect(() => {
        // An empty new plan may use the nearest listed eligible month. Saved
        // plans and user selections always require an explicit month change.
        const nearest = eligible[0];
        if (loaded && editable && !draft.contract_code && nearest) {
            setDraft(old => old.contract_code ? old : { ...old, contract_code: nearest.code });
        }
    }, [loaded, editable, draft.contract_code, eligible, setDraft]);
    const invalid = loaded && draft.contract_code && !valid
        ? selected ? `${selected.code}（${selected.delivery_date} 到期）不適用所選開盤日，請重新選擇月份。`
            : `${draft.contract_code} 不在目前可用合約清單，請重新選擇月份。` : '';
    return <div className={s.field}>
        <label>微台具體合約<SelectControl aria-label="微台具體合約" value={draft.contract_code} disabled={!editable || !loaded} wrapperClassName="w-full"
            onValueChange={code => setDraft(old => ({ ...old, contract_code: code }))}>
            <SelectOption value="">{loaded ? '選擇有效月份' : '正在讀取合約…'}</SelectOption>
            {draft.contract_code && !eligible.some(row => row.code === draft.contract_code) && <SelectOption value={draft.contract_code} disabled>{draft.contract_code} · 需重新選擇</SelectOption>}
            {eligible.map(row => <SelectOption key={row.code} value={row.code}>{row.code} · {row.delivery_date} 到期</SelectOption>)}
        </SelectControl></label>
        <p className={s.muted}>依 API 到期日列出有效月份；舊計畫不自動換月。</p>
        {invalid && <p role="alert" className={s.warning}>{invalid}</p>}
        {loaded && !eligible.length && <p role="alert" className={s.warning}>目前沒有適用所選開盤日的微台具體合約，請確認日期或稍後重試。</p>}
        {error && <><p role="alert" className={s.warning}>{error}</p><Button size="compact" variant="outline" onClick={() => setReload(n => n + 1)}>重試合約清單</Button></>}
    </div>;
}
