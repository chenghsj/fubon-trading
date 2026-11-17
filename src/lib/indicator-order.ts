import { DEF_BY_TYPE, type IndicatorInstance } from './indicator-defs';

/** Main-chart overlays and sub-panes have independent visual orders. */
export function indicatorPeers(instances: readonly IndicatorInstance[], id: string) {
    const category = DEF_BY_TYPE.get(instances.find(instance => instance.id === id)?.type ?? '')?.category;
    return instances.filter(instance => DEF_BY_TYPE.get(instance.type)?.category === category);
}

export function moveIndicatorInCategory(instances: IndicatorInstance[], id: string, direction: -1 | 1) {
    const peers = indicatorPeers(instances, id);
    const target = peers[peers.findIndex(instance => instance.id === id) + direction];
    const from = instances.findIndex(instance => instance.id === id);
    if (!target || from < 0) return instances;
    const to = instances.findIndex(instance => instance.id === target.id);
    const next = [...instances];
    [next[from], next[to]] = [next[to]!, next[from]!];
    return next;
}

/** Reorder only the category's existing slots; reject stale or mixed-category drops. */
export function reorderIndicatorCategory(instances: IndicatorInstance[], id: string, order: readonly string[]) {
    const source = instances.find(instance => instance.id === id);
    if (!source) return instances;
    const peers = indicatorPeers(instances, id);
    const byId = new Map(peers.map(instance => [instance.id, instance]));
    if (order.length !== peers.length || new Set(order).size !== peers.length || order.some(key => !byId.has(key))) return instances;
    if (peers.every((instance, index) => instance.id === order[index])) return instances;
    let index = 0;
    return instances.map(instance => byId.has(instance.id) ? byId.get(order[index++]!)! : instance);
}
