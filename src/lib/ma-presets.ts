import { factoryInstance, newInstance, type IndicatorInstance } from './indicator-defs';

export const MA_PRESETS = [
    { period: 5, color: '#e0a43c' },
    { period: 10, color: '#19b6c9' },
    { period: 20, color: '#b06fff' },
    { period: 60, color: '#5a89c9' },
    { period: 120, color: '#1fd286' },
    { period: 240, color: '#ff4d6a' },
] as const;

export type MAPeriod = (typeof MA_PRESETS)[number]['period'];
export const MA_PRESET_GROUP = [5, 10, 20, 60] as const satisfies readonly MAPeriod[];

export interface MALinePreset { period: number; color: string }

export function validateMALines(lines: readonly MALinePreset[]) {
    if (!lines.length || lines.length > 12) throw new Error('組合須包含 1–12 條均線');
    const seen = new Set<number>();
    for (const line of lines) {
        if (!Number.isInteger(line.period) || line.period < 1 || line.period > 500) throw new Error('均線週期須為 1–500 的整數');
        if (seen.has(line.period)) throw new Error('同一組合不能有重複週期');
        if (!/^#[0-9a-f]{6}$/i.test(line.color)) throw new Error('請選擇有效的均線顏色');
        seen.add(line.period);
    }
}

/** Explicit built-in presets ignore saved per-type defaults and keep existing lines intact. */
export function addMAPresets(current: IndicatorInstance[], periods: readonly MAPeriod[]): IndicatorInstance[] {
    return addMALines(current, [...new Set(periods)].map(period => MA_PRESETS.find(p => p.period === period)!));
}

export function addMALines(current: IndicatorInstance[], lines: readonly MALinePreset[]): IndicatorInstance[] {
    validateMALines(lines);
    const present = new Set(current.filter(i => i.type === 'sma').map(i => i.params.period));
    const added: IndicatorInstance[] = [];
    for (const { period, color } of lines) {
        if (present.has(period)) continue;
        const instance = factoryInstance(newInstance('sma'));
        instance.params.period = period;
        instance.styles = { line: { color } };
        added.push(instance);
        present.add(period);
    }
    return added.length ? [...current, ...added] : current;
}
