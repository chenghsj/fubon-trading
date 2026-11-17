import { resizePointer } from './workspace-resize';

/** Scroll coordinates belong to the resize gesture, just like its frozen grid. */
export class WorkspaceResizeScroll {
    private readonly startTop: number;
    private actualTop: number;
    private targetTop: number;
    private source: Event;
    private replaying = false;

    constructor(private readonly host: HTMLElement, event: Event) {
        this.startTop = this.actualTop = this.targetTop = host.scrollTop;
        this.source = event;
    }

    get delta() {
        this.syncScroll();
        return this.targetTop - this.startTop;
    }

    get isReplaying() { return this.replaying; }

    private syncScroll() {
        // Include wheel/touchpad scrolling, without counting our own scroll twice.
        this.targetTop += this.host.scrollTop - this.actualTop;
        this.actualTop = this.host.scrollTop;
    }

    start(isCurrent: () => boolean, maxGrowth: number): () => void {
        const host = this.host;
        const doc = host.ownerDocument;
        const view = doc.defaultView!;
        const origin = resizePointer(this.source)!;
        const anchor = host.style.getPropertyValue('overflow-anchor');
        const anchorPriority = host.style.getPropertyPriority('overflow-anchor');
        host.style.setProperty('overflow-anchor', 'none');
        let stopped = false;
        let moved = false;
        let frame = 0;
        let previousTime: number | undefined;
        let previousDelta = 0;
        const track = (event: Event) => {
            if (this.replaying) return;
            this.source = event;
            const pointer = resizePointer(event);
            // At the viewport edge there may be only one pixel left to move.
            moved ||= !!pointer && pointer.y !== origin.y;
        };
        const stop = () => { stopped = true; view.cancelAnimationFrame(frame); };
        const visibility = () => { if (doc.hidden) stop(); };
        const replay = () => {
            // RGL exposes no scroll-only resize callback. Replay the active
            // pointer through react-resizable's document listener so its layout,
            // placeholder and lower-card compaction advance together.
            const pointer = resizePointer(this.source);
            if (!pointer) return;
            // A same-coordinate move is suppressed by react-resizable when the
            // coarse grid has not grown yet. Give its sensor the scroll delta;
            // the hook keeps the real pointer and applies that delta only once.
            const offset = this.delta;
            const eventAt = (offset: number) => {
                const shiftTouch = (touch: Touch) => new view.Touch({ identifier: touch.identifier, target: touch.target,
                    clientX: touch.clientX, clientY: touch.clientY + offset, pageX: touch.pageX, pageY: touch.pageY + offset,
                    screenX: touch.screenX, screenY: touch.screenY + offset });
                return 'touches' in this.source
                    ? new view.TouchEvent('touchmove', {
                        touches: Array.from((this.source as TouchEvent).touches, shiftTouch),
                        changedTouches: Array.from((this.source as TouchEvent).changedTouches, shiftTouch),
                        bubbles: true, cancelable: true,
                    })
                    : new view.MouseEvent('mousemove', { clientX: pointer.x, clientY: pointer.y + offset, buttons: 1,
                        bubbles: true, cancelable: true, view });
            };
            this.replaying = true;
            try {
                // Reset the sensor before applying scroll, including after its
                // native max constraint clamped the previous virtual movement.
                doc.dispatchEvent(eventAt(0));
                doc.dispatchEvent(eventAt(offset));
            } finally { this.replaying = false; }
        };
        const tick = (time: number) => {
            if (stopped || !isCurrent()) return;
            const elapsed = Math.min(32, previousTime === undefined ? 16 : time - previousTime);
            previousTime = time;
            // The preceding pulse has rendered the extra grid height. Scroll
            // into it now, even when the gesture started at the very last card.
            this.syncScroll();
            host.scrollTop = this.targetTop;
            this.actualTop = host.scrollTop;
            const pointer = resizePointer(this.source);
            if (moved && pointer) {
                const bounds = host.getBoundingClientRect();
                const bottom = Math.min(bounds.bottom, view.innerHeight);
                const direction = pointer.y > bottom - 32 ? Math.min(1, (pointer.y - bottom + 32) / 32)
                    : 0;
                // 480px/s at the edge; retain sub-step distance for coarse grids.
                const limit = this.startTop + maxGrowth - (pointer.y - origin.y);
                this.targetTop = Math.min(this.targetTop + direction * elapsed * 0.48, Math.max(this.targetTop, limit));
            }
            const delta = this.delta;
            if (delta !== previousDelta) {
                previousDelta = delta;
                replay();
            }
            frame = view.requestAnimationFrame(tick);
        };
        view.addEventListener('mousemove', track, true);
        view.addEventListener('touchmove', track, true);
        view.addEventListener('blur', stop);
        view.addEventListener('touchcancel', stop);
        view.addEventListener('pointercancel', stop);
        doc.addEventListener('visibilitychange', visibility);
        frame = view.requestAnimationFrame(tick);
        return () => {
            stop();
            view.removeEventListener('mousemove', track, true);
            view.removeEventListener('touchmove', track, true);
            view.removeEventListener('blur', stop);
            view.removeEventListener('touchcancel', stop);
            view.removeEventListener('pointercancel', stop);
            doc.removeEventListener('visibilitychange', visibility);
            host.scrollTop = this.targetTop;
            if (anchor) host.style.setProperty('overflow-anchor', anchor, anchorPriority);
            else host.style.removeProperty('overflow-anchor');
        };
    }
}
