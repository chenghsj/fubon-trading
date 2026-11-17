/** Presentation model only: retain source shares and unknowns. */
export const institutions = [
    { key: 'total', label: '三大法人合計' },
    { key: 'foreign.net', label: '外資及陸資' },
    { key: 'trust.net', label: '投信' },
    { key: 'dealer.net', label: '自營商' },
] as const;
export type InstitutionKey = typeof institutions[number]['key'];
export type ShareUnit = 'shares' | 'lots';
export const shareUnitLabel = (unit: ShareUnit) => unit === 'lots' ? '張' : '股';
export function shareNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
export function formatShares(value: unknown, unit: ShareUnit, signed = false): string {
    const number = shareNumber(value);
    if (number === null) return '—';
    return new Intl.NumberFormat('zh-TW', {
        maximumFractionDigits: unit === 'lots' ? 3 : 0,
        signDisplay: signed ? 'exceptZero' : 'auto',
    }).format(number / (unit === 'lots' ? 1000 : 1));
}
export function formatShareTick(value: number, unit: ShareUnit): string {
    const displayed = value / (unit === 'lots' ? 1000 : 1);
    return new Intl.NumberFormat('zh-TW', {
        notation: 'compact', maximumFractionDigits: Math.abs(displayed) < 0.01 ? 4 : 2,
    }).format(displayed);
}
export function institutionalRows(rows: Record<string, unknown>[]): (Record<string, unknown> & { date: string })[] {
    return rows.filter(row => typeof row.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(row.date))
        .map(row => ({ ...row, date: row.date as string }))
        .sort((a, b) => a.date.localeCompare(b.date));
}
export function institutionalTotal(rows: Record<string, unknown>[], key: InstitutionKey): number | null {
    if (!rows.length) return null;
    let total = 0;
    for (const row of rows) {
        const value = shareNumber(row[key]);
        if (value === null) return null;
        total += value;
    }
    return total;
}
export function institutionalSeries(rows: Record<string, unknown>[], key: InstitutionKey, cumulative: boolean) {
    let running: number | null = 0;
    return rows.map(row => {
        const value = shareNumber(row[key]);
        running = running === null || value === null ? null : running + value;
        return cumulative ? running : value;
    });
}

export const institutionalColumns = [
    { key: 'foreign.buy', label: '外資買進' }, { key: 'foreign.sell', label: '外資賣出' },
    { key: 'foreign.net', label: '外資買賣超' },
    { key: 'trust.buy', label: '投信買進' }, { key: 'trust.sell', label: '投信賣出' },
    { key: 'trust.net', label: '投信買賣超' },
    { key: 'dealer.buy', label: '自營商買進' }, { key: 'dealer.sell', label: '自營商賣出' },
    { key: 'dealer.net', label: '自營商買賣超' }, { key: 'total', label: '法人合計買賣超' },
] as const;
