import { useEffect, useId, useState, type Dispatch, type SetStateAction } from 'react';
import { apiGet } from '../lib/api';
import type { AutoConfig } from '../lib/auto-trading';
import { nextAutoTradeDate } from '../lib/auto-trading';
import { SESSION_LABEL, type StrategySession } from '../lib/strategy-session';
import { FEATURE_SET_LABEL, type LearningFeatureSet } from '../lib/learning';
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from './ui/field';
import { SelectControl, SelectOption } from './ui/select-control';

interface ModelChoice {
    id: string; source: string; status: string; metricsPassed: boolean; reasons: string[];
    dataEnd: string; targetR: number; splitCount?: number; blocked: string | null;
    strategySession?: StrategySession;
    modelKind?: 'binary' | 'net_return'; threshold?: number;
    featureSet?: LearningFeatureSet; decisionMinutes?: 1 | 5;
    settings: Pick<AutoConfig, 'strategy_version' | 'strategy_session' | 'decision_minutes' | 'use_basket' | 'stop_points' | 'target_points' | 'slippage_points' | 'fee_per_side' | 'fee_source' | 'tax_rate' | 'max_entries' | 'loss_limit'>;
}

export function AutoModelField({ draft, setDraft, editable }: {
    draft: AutoConfig; setDraft: Dispatch<SetStateAction<AutoConfig>>; editable: boolean;
}) {
    const [models, setModels] = useState<ModelChoice[]>([]);
    const [error, setError] = useState('');
    const controlId = useId();
    useEffect(() => {
        let disposed = false, timer: ReturnType<typeof setTimeout>;
        const poll = async () => {
            try {
                const result = await apiGet<ModelChoice[]>('/api/v1/automation/models');
                if (!disposed) { setModels(result); setError(''); }
            } catch (e) {
                if (!disposed) setError(`模型清單讀取失敗：${e instanceof Error ? e.message : String(e)}`);
            } finally { if (!disposed) timer = setTimeout(() => void poll(), 10000); }
        };
        void poll();
        return () => { disposed = true; clearTimeout(timer); };
    }, []);
    const selected = models.find(model => model.id === draft.model_run_id);
    const choices = models.filter(model => (model.settings.strategy_version === 'regime_mtf_v3') === (draft.strategy_version === 'regime_mtf_v3'));
    return <FieldGroup>
        <Field data-disabled={!editable}>
            <FieldLabel htmlFor={controlId}>LightGBM 進場濾網</FieldLabel>
            <SelectControl id={controlId} aria-label="進場模型" disabled={!editable} value={draft.model_run_id ?? ''} wrapperClassName="w-full" onValueChange={id => {
                const model = models.find(item => item.id === id);
                if (!id) setDraft(old => ({ ...old, model_run_id: null, decision_minutes: old.strategy_version === 'regime_mtf_v3' ? 1 : 5 }));
                else if (model && !model.blocked) setDraft(old => ({ ...old, ...model.settings, decision_minutes: model.settings.decision_minutes ?? 5, strategy_session: model.strategySession ?? 'cash', trade_date: nextAutoTradeDate(Date.now(), model.strategySession ?? 'cash'), model_run_id: id }));
            }}>
                <SelectOption value="">不使用模型</SelectOption>
                {choices.map(model => <SelectOption key={model.id} value={model.id} disabled={!!model.blocked}>
                    {SESSION_LABEL[model.strategySession ?? 'cash']} · {FEATURE_SET_LABEL[model.featureSet ?? 'base']} · {model.id.slice(0, 12)} · 資料截至 {model.dataEnd} · {model.blocked ? '需重新訓練' : model.splitCount === 0 ? '固定分數，需補資料' : model.metricsPassed ? '通過數值比較' : '實驗前測'}
                </SelectOption>)}
                {draft.model_run_id && !selected && <SelectOption value={draft.model_run_id} disabled>{draft.model_run_id.slice(0, 12)} · 尚未讀取模型</SelectOption>}
            </SelectControl>
            <FieldDescription>先在「策略回測 → LightGBM」訓練，再選擇本機模型。選取時套用相符策略、盤別、費稅、滑價與損失預算；達該模型門檻才保留{draft.strategy_version === 'regime_mtf_v3' ? '區間／順勢' : '開盤突破'}訊號，訊號後20分鐘請求退出。啟動／恢復策略後才會執行。</FieldDescription>
            {selected && <FieldDescription>{selected.modelKind === 'net_return' ? '預估成本後淨收益門檻 NT$' : '分類分數門檻 '}{selected.threshold ?? .5}；門檻來自保存的研究版本。</FieldDescription>}
            {selected && <FieldDescription>{FEATURE_SET_LABEL[selected.featureSet ?? 'base']}，僅使用當時已收盤資料；模型與執行頻率固定一致。</FieldDescription>}
            {selected && <FieldDescription>版本 {selected.id.slice(0, 12)} · {selected.source} · {draft.strategy_version === 'regime_mtf_v3' ? `順勢${selected.targetR}R／區間中線` : `固定${selected.targetR}R`} · {selected.metricsPassed ? '數值比較通過，持續前測仍待驗證。' : '數值比較未通過或資料不足，僅供 Paper／Sandbox 實驗。'} {selected.splitCount === 0 ? '模型尚無有效分裂，只輸出固定分數，需補充訓練資料。' : '分數未校準為勝率。'}</FieldDescription>}
            {!!selected?.reasons.length && <details><summary>查看模型研究限制</summary>{selected.reasons.map(reason => <FieldDescription key={reason}>{reason}</FieldDescription>)}</details>}
            <FieldError>{error || selected?.blocked || (selected && draft.trade_date <= selected.dataEnd ? '交易日期必須晚於模型全部資料日期。' : '')}</FieldError>
        </Field>
    </FieldGroup>;
}
