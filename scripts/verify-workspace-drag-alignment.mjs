import { chromium, expect } from '@playwright/test';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Real RGL gestures in fresh storage with mocked APIs, never the user's session. */
export async function workspaceDragAlignmentChecks(browser, source, origin, artifacts) {
    void source;
    const context = await browser.newContext({ viewport: { width: 1100, height: 1000 } });
    const page = await context.newPage();
    const root = '#qa-workspace-drag-alignment';
    const errors = [], results = [];
    let pending;
    page.on('pageerror', error => errors.push(error.message));
    await context.route('**/api/**', route => route.fulfill({ status: 200, contentType: 'application/json', body: '{"registered":true}' }));
    const cell = id => page.locator(`${root} [data-block-id="${id}"]`);
    const state = () => page.evaluate(() => ({ workspace: window.__qaAlignmentWorkspace, writes: window.__qaAlignmentWrites }));
    const rectangle = async id => cell(id).boundingBox();
    const layout = (edge = 57, leftHeight = 20) => [
        { i: 'left', x: 0, y: 0, w: edge, h: leftHeight, minH: 4 },
        { i: 'chart', x: 60, y: 0, w: 170, h: 8, minH: 4 },
    ];
    const mount = async () => page.evaluate(async () => {
        const React = (await import('/node_modules/.vite/deps/react.js')).default;
        const dom = await import('/node_modules/.vite/deps/react-dom_client.js');
        await import('/node_modules/react-grid-layout/css/styles.css?import');
        const { GridLayout } = await import('/node_modules/.vite/deps/react-grid-layout.js');
        const { useWorkspaceGrid } = await import('/src/hooks/use-workspace-grid.ts');
        const { WorkspaceRulers } = await import('/src/components/workspace-rulers.tsx');
        const grid = await import('/src/grid.css.ts');
        const key = 'qa-workspace-drag-alignment';
        const initial = { preciseGrid: true, blocks: [{ id: 'left', type: 'watchlist', pin: null }, { id: 'chart', type: 'chart', pin: null }],
            layout: [{ i: 'left', x: 0, y: 0, w: 57, h: 20, minH: 4 }, { i: 'chart', x: 60, y: 0, w: 170, h: 8, minH: 4 }] };
        function Harness() {
            const [workspace, setWorkspace] = React.useState(() => JSON.parse(localStorage.getItem(key) || 'null') || initial);
            const [width, setWidth] = React.useState(1032);
            const latest = React.useRef(workspace), content = React.useRef(null), scrollRef = React.useRef(null);
            latest.current = workspace; window.__qaAlignmentWorkspace = workspace;
            React.useLayoutEffect(() => {
                const measure = () => setWidth(content.current.getBoundingClientRect().width);
                const observer = new ResizeObserver(measure); observer.observe(content.current); measure();
                return () => observer.disconnect();
            }, []);
            const updateWorkspace = React.useCallback(next => {
                window.__qaAlignmentWrites++; latest.current = next; localStorage.setItem(key, JSON.stringify(next)); setWorkspace(next);
            }, []);
            const props = useWorkspaceGrid({ workspace, workspaceRef: latest, width, updateWorkspace, scrollRef });
            window.__qaAlignmentSeed = (layout, precision) => {
                props.rulerProps.onPrecisionChange(precision);
                const next = { ...initial, layout };
                window.__qaAlignmentWrites = 0; latest.current = next; localStorage.setItem(key, JSON.stringify(next)); setWorkspace(next);
            };
            const children = workspace.blocks.map(block => React.createElement('div', { key: block.id, 'data-block-id': block.id, className: grid.cell },
                React.createElement('div', { style: { background: '#444', border: '1px solid #777', padding: 12 } },
                    React.createElement('div', { className: 'drag-handle', style: { height: 32, background: '#555' } }, `${block.id} header`))));
            return React.createElement('div', { ref: scrollRef, className: grid.gridWrap },
                React.createElement(WorkspaceRulers, { ...props.rulerProps, containerRef: content },
                    React.createElement(GridLayout, { layout: props.renderLayout, width: props.renderWidth,
                        gridConfig: { cols: props.renderCols, rowHeight: 30, margin: [6, 6], containerPadding: [6, 6] }, ...props.gridProps }, children)));
        }
        window.__qaAlignmentWrites = 0;
        document.getElementById('root').style.display = 'none';
        const node = document.createElement('div'); node.id = 'qa-workspace-drag-alignment';
        node.style.cssText = 'position:fixed;top:60px;left:20px;right:20px;bottom:20px;display:flex;flex-direction:column;';
        document.body.append(node); (dom.createRoot ?? dom.default.createRoot)(node).render(React.createElement(Harness));
    });
    const settled = async () => expect.poll(() => page.evaluate(async () => {
        const { calcGridItemPosition } = await import('/node_modules/.vite/deps/react-grid-layout.js');
        const grid = document.querySelector('#qa-workspace-drag-alignment .react-grid-layout')?.getBoundingClientRect();
        if (!grid || !window.__qaAlignmentWorkspace) return ['mount'];
        return window.__qaAlignmentWorkspace.layout.flatMap(item => {
            const actual = document.querySelector(`#qa-workspace-drag-alignment [data-block-id="${item.i}"]`).getBoundingClientRect();
            const expected = calcGridItemPosition({ containerWidth: grid.width, cols: 72, rowHeight: 30,
                margin: [6, 6], containerPadding: [6, 6], maxRows: Infinity }, item.x / 4, item.y, item.w / 4, item.h);
            return Math.abs(actual.x - grid.x - expected.left) <= 0.5 && Math.abs(actual.y - grid.y - expected.top) <= 0.5
                && Math.abs(actual.width - expected.width) <= 0.5 && Math.abs(actual.height - expected.height) <= 0.5 ? [] : [item.i];
        });
    })).toEqual([]);
    const seed = async (items, precision = 'finest') => {
        await page.evaluate(({ items, precision }) => window.__qaAlignmentSeed(items, precision), { items, precision });
        await settled(); expect((await state()).writes).toBe(0);
    };
    const start = async () => {
        const rect = await cell('chart').locator('.drag-handle').boundingBox();
        const pointer = { x: rect.x + 120, y: rect.y + 16 };
        await page.mouse.move(pointer.x, pointer.y); await page.mouse.down();
        return pointer;
    };
    const clean = async () => {
        await expect(page.locator(`${root} [data-workspace-dragging]`)).toHaveCount(0);
        expect(await cell('chart').evaluate(node => [node.style.getPropertyValue('--workspace-drag-left'), node.style.getPropertyValue('--workspace-drag-top')])).toEqual(['', '']);
    };
    const step = async () => ((await page.locator(`${root} .react-grid-layout`).boundingBox()).width - 6) / 72;
    const finish = async (before, preview, expectedX) => {
        await page.mouse.up();
        await expect.poll(async () => (await state()).writes).toBe(before.writes + 1);
        await settled(); await clean();
        const after = await state(), actual = await rectangle('chart');
        expect(after.workspace.layout.find(item => item.i === 'chart').x).toBe(expectedX);
        expect(after.workspace.layout.find(item => item.i === 'left').y).toBe(0);
        expect(Math.abs(actual.x - preview.x)).toBeLessThanOrEqual(0.5);
        expect(Math.abs(actual.y - preview.y)).toBeLessThanOrEqual(0.5);
        return after;
    };
    try {
        await page.goto(origin); await page.waitForSelector('[data-slot="card"]'); await mount(); await settled();
        // A single move crosses RGL's threshold: do not hide first-batch errors
        // behind a second event or a React effect before checking the preview.
        for (const width of [1100, 2020]) {
            await page.setViewportSize({ width, height: 1000 });
            for (const precision of ['standard', 'fine', 'finest']) {
                for (const edge of [57, 58, 59]) {
                    await seed(layout(edge), precision);
                    const before = await state(), left = await rectangle('left'), pointer = await start();
                    const dx = (edge - 60) / 4 * await step();
                    pending = { check: `align/${width}/${precision}/${edge}`, before, dx };
                    await page.mouse.move(pointer.x + dx, pointer.y);
                    await expect(cell('chart')).toHaveClass(/\breact-draggable-dragging\b/);
                    await expect(cell('chart')).toHaveAttribute('data-workspace-dragging', 'true');
                    await expect.poll(async () => Math.abs((await rectangle('chart')).x - left.x - left.width - 6)).toBeLessThanOrEqual(1);
                    expect(await state()).toEqual(before);
                    expect((await rectangle('left')).y).toBe(left.y);
                    const preview = await rectangle('chart');
                    const after = await finish(before, preview, edge);
                    results.push({ ...pending, preview, after }); pending = undefined;
                }
            }
        }
        await page.screenshot({ path: path.join(artifacts, 'workspace-drag-aligned.png'), animations: 'disabled' });
        const persisted = (await state()).workspace;
        await page.reload(); await page.waitForSelector('[data-slot="card"]'); await mount(); await settled();
        expect((await state()).workspace).toEqual(persisted);
        results.push({ check: 'alignment-reload-preserves-fractional-position', workspace: persisted });

        await page.setViewportSize({ width: 1100, height: 1000 }); await seed(layout());
        const clickBefore = await state(), clickBox = await rectangle('chart'), pointer = await start();
        await page.mouse.move(pointer.x + 1, pointer.y);
        expect((await state()).workspace).toEqual(clickBefore.workspace);
        await page.mouse.up(); await clean(); await settled();
        expect(await state()).toEqual(clickBefore);
        expect((await rectangle('chart')).x).toBe(clickBox.x);
        results.push({ check: 'below-threshold-click-does-not-write', before: clickBefore, after: await state() });

        await seed(layout());
        const collisionBefore = await state(), collisionPointer = await start();
        await page.mouse.move(collisionPointer.x - 9 * await step(), collisionPointer.y, { steps: 8 });
        expect(await state()).toEqual(collisionBefore);
        await page.mouse.up(); await settled(); await clean();
        const collisionAfter = await state();
        expect(collisionAfter.writes).toBe(1);
        expect(collisionAfter.workspace.layout.find(item => item.i === 'left').y).toBe(8);
        expect(collisionAfter.workspace.layout.find(item => item.i === 'chart').x).toBeLessThan(57);
        results.push({ check: 'intentional-overlap-keeps-native-push', before: collisionBefore, after: collisionAfter });
        await page.screenshot({ path: path.join(artifacts, 'workspace-drag-intentional-push.png'), animations: 'disabled' });

        await seed(layout(57, 8));
        const vacantBefore = await state(), vacantPointer = await start();
        await page.mouse.move(vacantPointer.x, vacantPointer.y + 8 * 36, { steps: 8 });
        await page.mouse.move(vacantPointer.x - 15 * await step(), vacantPointer.y + 8 * 36, { steps: 10 });
        expect(await state()).toEqual(vacantBefore);
        await page.mouse.up(); await settled(); await clean();
        const vacantAfter = await state();
        expect(vacantAfter.writes).toBe(1);
        expect(vacantAfter.workspace.layout.find(item => item.i === 'chart')).toMatchObject({ x: 0, y: 8 });
        expect(vacantAfter.workspace.layout.find(item => item.i === 'left').y).toBe(0);
        results.push({ check: 'vacant-drop-still-moves-and-saves', before: vacantBefore, after: vacantAfter });

        const client = await context.newCDPSession(page);
        await client.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
        // Coarse pointers enlarge the ruler rail; let its ResizeObserver
        // finish before taking the touch start coordinates.
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        await seed(layout());
        pending = { check: 'trusted-touch-aligns-and-saves-once' };
        const touchBefore = await state(), touchLeft = await rectangle('left');
        const touchBox = await cell('chart').locator('.drag-handle').boundingBox();
        const touchStart = { x: touchBox.x + 120, y: touchBox.y + 16 };
        const touchEnd = { x: touchStart.x - 0.75 * await step(), y: touchStart.y };
        await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...touchStart, id: 1 }] });
        await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ ...touchEnd, id: 1 }] });
        await expect(cell('chart')).toHaveAttribute('data-workspace-dragging', 'true');
        await expect.poll(async () => Math.abs((await rectangle('chart')).x - touchLeft.x - touchLeft.width - 6)).toBeLessThanOrEqual(1);
        expect(await state()).toEqual(touchBefore);
        const touchPreview = await rectangle('chart');
        await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        await expect.poll(async () => (await state()).writes).toBe(1);
        await settled(); await clean();
        const touchAfter = await state();
        expect(touchAfter.workspace.layout.find(item => item.i === 'chart').x).toBe(57);
        expect(touchAfter.workspace.layout.find(item => item.i === 'left').y).toBe(0);
        expect(Math.abs((await rectangle('chart')).x - touchPreview.x)).toBeLessThanOrEqual(0.5);
        results.push({ check: 'trusted-touch-aligns-and-saves-once', before: touchBefore, preview: touchPreview, after: touchAfter });
        await page.screenshot({ path: path.join(artifacts, 'workspace-drag-touch-aligned.png'), animations: 'disabled' });
        pending = undefined; await client.detach();
        expect(errors).toEqual([]);
        await writeFile(path.join(artifacts, 'workspace-drag-alignment-summary.json'), JSON.stringify({ passed: true, results, errors }, null, 2));
        return results;
    } catch (error) {
        await page.mouse.up().catch(() => {});
        await page.screenshot({ path: path.join(artifacts, 'workspace-drag-alignment-failure.png'), animations: 'disabled' }).catch(() => {});
        await writeFile(path.join(artifacts, 'workspace-drag-alignment-summary.json'), JSON.stringify({ passed: false, error: String(error), results, pending, errors }, null, 2));
        throw error;
    } finally { await context.close(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const artifacts = process.env.WORKSPACE_DRAG_ALIGNMENT_ARTIFACT_DIR || await mkdtemp(path.join(tmpdir(), 'fubon-workspace-drag-alignment-'));
    await mkdir(artifacts, { recursive: true });
    const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true });
    try {
        const results = await workspaceDragAlignmentChecks(browser, null, process.env.WORKSPACE_DRAG_ALIGNMENT_ORIGIN || 'http://localhost:5624', artifacts);
        console.log(JSON.stringify({ passed: true, artifacts, checks: results.map(result => result.check) }, null, 2));
    } catch (error) { console.error(JSON.stringify({ passed: false, artifacts, error: String(error) }, null, 2)); process.exitCode = 1; }
    finally { await browser.close(); }
}
