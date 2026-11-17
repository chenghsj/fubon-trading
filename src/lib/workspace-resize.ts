import type { Layout, LayoutItem } from 'react-grid-layout';

export type PanelResizeHandle = 'e' | 's' | 'se';

/** Snap to real edges, stopping at side neighbors and letting lower cards flow down. */
export function resizeWorkspacePanel(original: LayoutItem, layout: Layout, proposed: { w: number; h: number },
    handle: PanelResizeHandle, cols: number, steps: { x: number; y: number }, pixels: { x: number; y: number }) {
    const others = layout.filter(item => item.i !== original.i);
    const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
    const minW = Math.min(original.w, original.minW ?? 1);
    const minH = Math.min(original.h, original.minH ?? 1);
    const maxW = Math.min(cols - original.x, Math.max(original.w, original.maxW ?? Infinity));
    const maxH = Math.max(original.h, original.maxH ?? Infinity);
    const snap = (value: number, start: number, step: number, edges: number[], pixel: number, min: number, max: number) => {
        // A pointer-down or a stationary axis must never change the layout.
        if (Math.abs(value - start) < 1e-6) return start;
        const near = edges.filter(edge => edge >= min && edge <= max && Math.abs(edge - value) * pixel <= 8)
            .sort((a, b) => Math.abs(a - value) - Math.abs(b - value));
        return clamp(near[0] ?? start + Math.round((value - start) / step) * step, min, max);
    };
    let w = handle === 's' ? original.w : snap(proposed.w, original.w, steps.x,
        others.flatMap(item => [item.x - original.x, item.x + item.w - original.x]), pixels.x, minW, maxW);
    const h = handle === 'e' ? original.h : snap(proposed.h, original.h, steps.y,
        others.flatMap(item => [item.y - original.y, item.y + item.h - original.y]), pixels.y, minH, maxH);
    // Width is bounded by cards beside the original panel. Height may grow:
    // RGL's vertical compactor moves lower cards down without moving side cards.
    for (const other of others) {
        if (other.x >= original.x + original.w && other.y < original.y + Math.min(original.h, h)
            && other.y + other.h > original.y) w = Math.min(w, other.x - original.x);
    }
    return { w, h };
}

export function resizePointer(event?: Event) {
    if (!event) return undefined;
    const pointer = event as MouseEvent | TouchEvent;
    const touch = 'touches' in pointer ? pointer.touches[0] ?? pointer.changedTouches[0] : pointer;
    return touch && Number.isFinite(touch.clientX) && Number.isFinite(touch.clientY)
        ? { x: touch.clientX, y: touch.clientY } : undefined;
}

export function panelResizeHandle(event: Event): PanelResizeHandle | undefined {
    const target = event.target as HTMLElement | null;
    const name = target?.closest?.('.react-resizable-handle')?.className;
    return typeof name === 'string' ? name.match(/react-resizable-handle-(se|e|s)(?:\s|$)/)?.[1] as PanelResizeHandle | undefined : undefined;
}
