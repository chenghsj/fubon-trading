import { outputStyle, DEF_BY_TYPE, type IndicatorInstance } from './indicator-defs';

export const MAX_MA_BACKFILL_PAGES = 6;
export interface HistoryPaging { busy: boolean; error: boolean; exhausted: boolean }
export type MAHistoryPhase = 'loading' | 'error' | 'exhausted' | 'paused';
export interface MAHistoryStatus { required: number; available: number; phase: MAHistoryPhase }

export function requiredMABars(instances: readonly IndicatorInstance[], timeframe: number): number {
    let required = 0;
    for (const instance of instances) {
        if (!['sma', 'ema', 'wma'].includes(instance.type) || instance.hidden || (instance.visibleTf && !instance.visibleTf.includes(timeframe))) continue;
        const def = DEF_BY_TYPE.get(instance.type)!;
        if (!outputStyle(instance, def, 'line').visible) continue;
        const period = instance.params.period ?? def.params[0]!.def;
        if (Number.isInteger(period) && period > 0 && period <= 500) required = Math.max(required, period);
    }
    return required;
}
