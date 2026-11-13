/** Coalesce reports, but retain an event received during an in-flight read. */
export function createFubonReconciler(refresh: () => Promise<void>, delay = 300) {
    let dirty = false;
    let running = false;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function run() {
        timer = undefined;
        running = true;
        do {
            dirty = false;
            try { await refresh(); }
            catch { /* shared trading state retains the concrete query error */ }
        } while (dirty && !stopped);
        running = false;
    }
    return {
        request() {
            if (stopped) return;
            dirty = true;
            if (!running && timer === undefined) timer = setTimeout(() => { void run(); }, delay);
        },
        stop() { stopped = true; clearTimeout(timer); },
    };
}
