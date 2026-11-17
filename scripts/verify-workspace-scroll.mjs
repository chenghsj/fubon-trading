import { chromium, expect } from '@playwright/test';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Real RGL, hook and integration CSS in fresh storage; no live session or API traffic. */
export async function workspaceScrollChecks(browser, source, origin, artifacts) {
    void source;
    const context = await browser.newContext({ viewport: { width: 1100, height: 700 } });
    const page = await context.newPage();
    const results = [], errors = [], requests = [];
    let pending;
    page.on('pageerror', error => errors.push(error.message));
    await context.route('**/api/**', async route => {
        requests.push({ method: route.request().method(), path: new URL(route.request().url()).pathname });
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ registered: true }) });
    });
    const cell = () => page.locator('#qa-workspace-scroll-fixture [data-block-id="target"]');
    const host = () => page.locator('#qa-workspace-scroll');
    const snapshot = () => page.evaluate(() => {
        const host = document.getElementById('qa-workspace-scroll');
        const target = host.querySelector('[data-block-id="target"]');
        const rect = element => { const box = element.getBoundingClientRect(); return { x: box.x, y: box.y, width: box.width, height: box.height, bottom: box.bottom, right: box.right }; };
        return { scrollTop: host.scrollTop, scrollHeight: host.scrollHeight, clientHeight: host.clientHeight,
            overflowAnchor: getComputedStyle(host).overflowAnchor, host: rect(host), target: rect(target),
            stored: window.__qaScrollWorkspace.layout, writes: window.__qaScrollWrites };
    });
    const seed = async (mode = 'bottom', maxH) => {
        await page.evaluate(({ mode, maxH }) => window.__qaScrollSeed(mode, maxH), { mode, maxH });
        await expect.poll(async () => (await snapshot()).target.height).toBe(354);
        await expect(page.locator('#qa-workspace-scroll-fixture [data-workspace-resizing]')).toHaveCount(0);
        await expect.poll(() => page.evaluate(async () => {
            const { calcGridItemPosition } = await import('/node_modules/.vite/deps/react-grid-layout.js');
            const grid = document.querySelector('#qa-workspace-scroll-fixture .react-grid-layout').getBoundingClientRect();
            return window.__qaScrollWorkspace.layout.flatMap(item => {
                const actual = document.querySelector(`#qa-workspace-scroll-fixture [data-block-id="${item.i}"]`).getBoundingClientRect();
                const expected = calcGridItemPosition({ containerWidth: grid.width, cols: 72, rowHeight: 30,
                    margin: [6, 6], containerPadding: [6, 6], maxRows: Infinity }, item.x / 4, item.y, item.w / 4, item.h);
                const valid = Math.abs(actual.x - grid.x - expected.left) <= 0.5 && Math.abs(actual.y - grid.y - expected.top) <= 0.5
                    && Math.abs(actual.width - expected.width) <= 0.5 && Math.abs(actual.height - expected.height) <= 0.5;
                return valid ? [] : [{ id: item.i, gridWidth: grid.width, actual: { x: actual.x - grid.x, y: actual.y - grid.y, width: actual.width, height: actual.height }, expected }];
            });
        })).toEqual([]);
    };
    const begin = async handle => {
        const target = cell().locator(`.react-resizable-handle-${handle}`);
        const rect = await target.boundingBox();
        const pointer = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
        expect(await page.evaluate(({ pointer, handle }) => !!document.elementFromPoint(pointer.x, pointer.y)
            ?.closest(`.react-resizable-handle-${handle}`), { pointer, handle })).toBe(true);
        await page.mouse.move(pointer.x, pointer.y);
        await page.mouse.down();
        await expect(cell()).toHaveClass(/\bresizing\b/);
        return pointer;
    };
    const stopAndCheck = async (release = () => page.mouse.up()) => {
        const beforeRelease = await snapshot();
        await release();
        await expect(cell()).not.toHaveClass(/\bresizing\b/);
        await expect(page.locator('#qa-workspace-scroll-fixture [data-workspace-resizing]')).toHaveCount(0);
        await expect.poll(async () => (await snapshot()).writes).toBe(1);
        const released = await snapshot();
        // Releasing removes the precise preview before RGL's 200ms height
        // transition finishes. Freeze the saved geometry as our target; never
        // chase a later size that an accidentally running RAF might produce.
        const geometry = await page.evaluate(async stored => {
            const { calcGridItemPosition } = await import('/node_modules/.vite/deps/react-grid-layout.js');
            const grid = document.querySelector('#qa-workspace-scroll-fixture .react-grid-layout').getBoundingClientRect();
            const item = stored.find(item => item.i === 'target');
            const expected = calcGridItemPosition({ containerWidth: grid.width, cols: 72, rowHeight: 30,
                margin: [6, 6], containerPadding: [6, 6], maxRows: Infinity }, item.x / 4, item.y, item.w / 4, item.h);
            const target = document.querySelector('#qa-workspace-scroll-fixture [data-block-id="target"]');
            const style = getComputedStyle(target);
            return { expectedHeight: expected.height, transitionProperty: style.transitionProperty, transitionDuration: style.transitionDuration };
        }, released.stored);
        if (pending) pending.release = { beforeRelease, released, ...geometry };
        expect(Math.abs(geometry.expectedHeight - beforeRelease.target.height)).toBeLessThanOrEqual(36);
        await expect.poll(async () => {
            const current = await snapshot();
            return { height: current.target.height, stored: current.stored, writes: current.writes };
        }).toEqual({ height: geometry.expectedHeight, stored: released.stored, writes: 1 });
        const stopped = await snapshot();
        await page.waitForTimeout(160);
        const later = await snapshot();
        expect(later.target.height).toBe(stopped.target.height);
        expect(later.stored).toEqual(stopped.stored);
        expect(later.writes).toBe(1);
        return stopped;
    };
    try {
        await page.goto(origin);
        await page.waitForSelector('[data-slot="card"]');
        await page.evaluate(async () => {
            const React = (await import('/node_modules/.vite/deps/react.js')).default;
            const dom = await import('/node_modules/.vite/deps/react-dom_client.js');
            await import('/node_modules/react-grid-layout/css/styles.css?import');
            const { GridLayout } = await import('/node_modules/.vite/deps/react-grid-layout.js');
            const { useWorkspaceGrid } = await import('/src/hooks/use-workspace-grid.ts');
            const { WorkspaceRulers } = await import('/src/components/workspace-rulers.tsx');
            const grid = await import('/src/grid.css.ts');
            localStorage.setItem('fubon-workspace-ruler-precision', 'finest');
            const layouts = {
                bottom: [{ i: 'top', x: 0, y: 0, w: 288, h: 14, minH: 4 }, { i: 'target', x: 0, y: 14, w: 288, h: 10, minH: 4 }],
                side: [{ i: 'top', x: 0, y: 0, w: 144, h: 14, minH: 4 }, { i: 'target', x: 0, y: 14, w: 144, h: 10, minH: 4 }, { i: 'side', x: 144, y: 0, w: 144, h: 40, minH: 4 }],
            };
            const fixture = (mode, maxH) => ({ preciseGrid: true,
                layout: structuredClone(layouts[mode]).map(item => item.i === 'target' && maxH !== undefined ? { ...item, maxH } : item),
                blocks: layouts[mode].map(item => ({ id: item.i, type: 'depth', pin: null })) });
            window.__qaScrollWrites = 0;
            function Harness() {
                const [workspace, setWorkspace] = React.useState(() => fixture('bottom'));
                const [width, setWidth] = React.useState(1032);
                const latest = React.useRef(workspace), scrollRef = React.useRef(null), contentRef = React.useRef(null);
                latest.current = workspace;
                React.useLayoutEffect(() => {
                    const element = contentRef.current;
                    if (!element) return;
                    const measure = () => setWidth(element.getBoundingClientRect().width);
                    const observer = new ResizeObserver(measure); observer.observe(element); measure();
                    return () => observer.disconnect();
                }, []);
                window.__qaScrollWorkspace = workspace;
                window.__qaScrollSeed = (mode, maxH) => {
                    window.__qaScrollWrites = 0;
                    const next = fixture(mode, maxH); latest.current = next; setWorkspace(next);
                };
                const updateWorkspace = React.useCallback(next => {
                    window.__qaScrollWrites++; latest.current = next; setWorkspace(next);
                }, []);
                const { renderLayout, renderCols, renderWidth, gridProps, rulerProps } = useWorkspaceGrid({
                    workspace, workspaceRef: latest, width, updateWorkspace, scrollRef,
                });
                window.__qaScrollSetPrecision = rulerProps.onPrecisionChange;
                return React.createElement('div', { ref: scrollRef, id: 'qa-workspace-scroll', className: grid.gridWrap },
                    React.createElement(WorkspaceRulers, { ...rulerProps, containerRef: contentRef },
                        React.createElement(GridLayout, { layout: renderLayout, width: renderWidth,
                            gridConfig: { cols: renderCols, rowHeight: 30, margin: [6, 6], containerPadding: [6, 6] }, ...gridProps },
                        workspace.blocks.map(block => React.createElement('div', { key: block.id, 'data-block-id': block.id, className: grid.cell },
                            React.createElement('div', { style: { background: '#444', border: '1px solid #777', padding: 12 } }, block.id))))));
            }
            document.getElementById('root').style.display = 'none';
            const mount = document.createElement('div'); mount.id = 'qa-workspace-scroll-fixture';
            mount.style.cssText = 'position:fixed;top:60px;left:20px;right:20px;bottom:0;display:flex;flex-direction:column;';
            document.body.append(mount);
            (dom.createRoot ?? dom.default.createRoot)(mount).render(React.createElement(Harness));
        });
        await expect(cell()).toBeVisible();
        for (const precision of ['finest', 'standard']) {
        for (const handle of ['s', 'se']) {
            await page.evaluate(precision => window.__qaScrollSetPrecision(precision), precision);
            await seed();
            await host().evaluate(element => element.scrollTop = element.scrollHeight);
            const before = await snapshot();
            const pointer = await begin(handle);
            await page.mouse.move(pointer.x, 699, { steps: 4 });
            await page.waitForTimeout(520);
            const preview = await snapshot();
            pending = { check: `viewport-bottom-${handle}-${precision}-tiny-move-keeps-growing`, before, preview, pointer };
            expect(preview.writes).toBe(0);
            expect(preview.stored).toEqual(before.stored);
            expect(preview.target.height - before.target.height, 'Holding the bottom handle at the viewport edge must keep growing the card.').toBeGreaterThan(60);
            expect(preview.target.height - before.target.height, 'Native text selection must not compete with bounded edge scrolling.').toBeLessThan(500);
            await page.screenshot({ path: path.join(artifacts, `workspace-scroll-bottom-${handle}-${precision}.png`), animations: 'disabled' });
            if (precision === 'finest' && handle === 's') {
                await page.mouse.move(pointer.x, preview.host.bottom - 48, { steps: 6 });
                await page.waitForTimeout(120);
                const reversed = await snapshot(); pending.reversed = reversed;
                expect(preview.target.height - reversed.target.height, 'Reversing 48px must shrink smoothly, without collapsing through multiple scroll-clamp feedback pulses.').toBeGreaterThanOrEqual(18);
                expect(preview.target.height - reversed.target.height).toBeLessThanOrEqual(100);
            }
            const stopped = await stopAndCheck();
            results.push({ ...pending, stopped }); pending = undefined;
        }
        }
        await page.evaluate(() => window.__qaScrollSetPrecision('finest'));
        for (const handle of ['s', 'se']) {
            await seed('side');
            // Keep the pointer away from the edge: this case measures only scroll compensation.
            await host().evaluate(element => {
                const row = element.querySelector('[data-block-id="target"]');
                const host = element.getBoundingClientRect();
                element.scrollTop += row.getBoundingClientRect().bottom - (host.top + host.height * 0.65);
            });
            const before = await snapshot();
            await begin(handle);
            await host().evaluate(element => element.scrollTop += 108);
            pending = { check: `stationary-pointer-scroll-compensation-${handle}`, before };
            await expect.poll(async () => (await snapshot()).target.height, { message: 'Scrolling 108px with a held resize handle must grow its height by the same 108px.' }).toBe(before.target.height + 108);
            const preview = await snapshot();
            expect(preview.scrollTop - before.scrollTop).toBe(108);
            expect(preview.writes).toBe(0);
            expect(preview.stored).toEqual(before.stored);
            const stopped = await stopAndCheck();
            expect(stopped.stored.find(item => item.i === 'target').h).toBe(13);
            results.push({ ...pending, preview, stopped }); pending = undefined;
        }
        await seed('bottom', 11);
        await host().evaluate(element => element.scrollTop = element.scrollHeight);
        const beforeMax = await snapshot();
        const maxPointer = await begin('s');
        await page.mouse.move(maxPointer.x, 699, { steps: 4 });
        await page.waitForTimeout(520);
        const maxPreview = await snapshot();
        pending = { check: 'maxH-stops-edge-growth', before: beforeMax, preview: maxPreview };
        expect(maxPreview.target.height).toBe(390);
        expect(maxPreview.writes).toBe(0);
        await page.mouse.move(maxPointer.x, maxPreview.host.bottom - 60, { steps: 6 });
        await page.waitForTimeout(100);
        const maxReversed = await snapshot(); pending.reversed = maxReversed;
        expect(maxPreview.target.height - maxReversed.target.height).toBeGreaterThanOrEqual(18);
        expect(maxPreview.target.height - maxReversed.target.height).toBeLessThanOrEqual(100);
        const maxStopped = await stopAndCheck();
        expect(maxStopped.stored.find(item => item.i === 'target').h).toBeLessThan(11);
        results.push({ ...pending, stopped: maxStopped }); pending = undefined;

        await seed();
        await host().evaluate(element => element.scrollTop = element.scrollHeight);
        const beforeEast = await snapshot();
        const eastPointer = await begin('e');
        await page.mouse.move(eastPointer.x, 699, { steps: 4 });
        await page.waitForTimeout(520);
        const eastPreview = await snapshot();
        pending = { check: 'east-handle-never-starts-vertical-edge-scroll', before: beforeEast, preview: eastPreview };
        expect(eastPreview.scrollTop).toBe(beforeEast.scrollTop);
        expect(eastPreview.target.height).toBe(beforeEast.target.height);
        expect(eastPreview.writes).toBe(0);
        await page.mouse.up();
        await expect(cell()).not.toHaveClass(/\bresizing\b/);
        await page.waitForTimeout(160);
        expect((await snapshot()).stored).toEqual(beforeEast.stored);
        expect((await snapshot()).writes).toBe(0);
        results.push(pending); pending = undefined;

        const touch = await context.newCDPSession(page);
        await touch.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
        await seed();
        await host().evaluate(element => element.scrollTop = element.scrollHeight);
        const beforeTouch = await snapshot();
        const touchBox = await cell().locator('.react-resizable-handle-s').boundingBox();
        const touchPoint = { x: touchBox.x + touchBox.width / 2, y: touchBox.y + touchBox.height / 2, id: 7 };
        await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [touchPoint] });
        await expect(cell()).toHaveClass(/\bresizing\b/);
        await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ ...touchPoint, y: 699 }] });
        await page.waitForTimeout(520);
        const touchPreview = await snapshot();
        pending = { check: 'trusted-touch-bottom-hold', before: beforeTouch, preview: touchPreview };
        expect(touchPreview.target.height - beforeTouch.target.height).toBeGreaterThan(60);
        expect(touchPreview.target.height - beforeTouch.target.height).toBeLessThan(500);
        expect(touchPreview.writes).toBe(0);
        const touchStopped = await stopAndCheck(() => touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }));
        results.push({ ...pending, stopped: touchStopped }); pending = undefined;
        await touch.detach();
        expect(errors).toEqual([]);
        await writeFile(path.join(artifacts, 'workspace-scroll-summary.json'), JSON.stringify({ passed: true, results, errors, requests }, null, 2));
        return results;
    } catch (error) {
        await page.mouse.up().catch(() => {});
        await page.screenshot({ path: path.join(artifacts, 'workspace-scroll-failure.png'), animations: 'disabled' }).catch(() => {});
        await writeFile(path.join(artifacts, 'workspace-scroll-summary.json'), JSON.stringify({ passed: false, error: String(error), results, pending, errors, requests }, null, 2));
        throw error;
    } finally { await context.close(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const origin = process.env.WORKSPACE_SCROLL_ORIGIN || 'http://localhost:5624';
    const artifacts = process.env.WORKSPACE_SCROLL_ARTIFACT_DIR || await mkdtemp(path.join(tmpdir(), 'fubon-workspace-scroll-'));
    await mkdir(artifacts, { recursive: true });
    const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true });
    try {
        const results = await workspaceScrollChecks(browser, null, origin, artifacts);
        console.log(JSON.stringify({ passed: true, artifacts, checks: results.map(result => result.check) }, null, 2));
    } catch (error) { console.error(JSON.stringify({ passed: false, artifacts, error: String(error) }, null, 2)); process.exitCode = 1; }
    finally { await browser.close(); }
}
