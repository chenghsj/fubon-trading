import { chromium, expect } from '@playwright/test';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const legacy = [
    { id: 'qa-pane-ma', type: 'sma', params: { period: 5 }, colors: {} },
    { id: 'qa-pane-macd', type: 'macd', params: { fast: 12, slow: 26, signal: 9 }, colors: {} },
];

function historyFixture() {
    const result = { datetime: [], Open: [], High: [], Low: [], Close: [], Volume: [] };
    const start = Date.UTC(2026, 10, 13, 9, 0);
    for (let index = 0; index < 240; index++) {
        const price = 100 + Math.sin(index / 10) * 3 + index / 50;
        result.datetime.push(new Date(start + index * 60_000).toISOString().slice(0, 19));
        result.Open.push(price); result.High.push(price + 1); result.Low.push(price - 1);
        result.Close.push(price + Math.sin(index / 3) * 0.8);
        result.Volume.push(index % 23 === 0 ? 0 : 100 + index % 70 * 20);
    }
    return result;
}

async function installFixture(context, requests) {
    const history = historyFixture();
    // No request in this context reaches a brokerage, even if a guard regresses.
    await context.route('**/api/**', async route => {
        const request = route.request();
        const pathname = new URL(request.url()).pathname;
        requests.push({ method: request.method(), pathname });
        let body = {};
        if (pathname.endsWith('/kbars')) body = history;
        else if (pathname.includes('/accounts')) body = [];
        else if (pathname.includes('/passkeys/')) body = { registered: true };
        else if (pathname.endsWith('/info')) body = { broker: 'fubon', mode: 'demo', simulation: true, connected: true, market_connected: true, name: 'Chart pane fixture', version: 'qa' };
        else if (pathname.endsWith('/health')) body = { status: 'ok', mode: 'demo' };
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    });
    await context.addInitScript(legacy => {
        // Seed only once; subsequent reloads exercise the actual migrated v3.
        if (!localStorage.getItem('qa-chart-panes-seeded')) {
            localStorage.setItem('sj-pro-indicators-v2', JSON.stringify(legacy));
            localStorage.setItem('qa-chart-panes-seeded', '1');
        }
        // A stationary feed keeps history deterministic. No live session is copied.
        window.EventSource = class extends EventTarget {
            static CONNECTING = 0; static OPEN = 1; static CLOSED = 2;
            CONNECTING = 0; OPEN = 1; CLOSED = 2; readyState = 1;
            onopen = null; onerror = null; onmessage = null;
            constructor(url) { super(); this.url = String(url); queueMicrotask(() => this.onopen?.(new Event('open'))); }
            close() { this.readyState = 2; }
        };
    }, legacy);
}

async function mountFixture(page, origin) {
    await page.goto(origin);
    await page.waitForSelector('[data-slot="card"]');
    await page.evaluate(async () => {
        const React = (await import('/node_modules/.vite/deps/react.js')).default;
        const dom = await import('/node_modules/.vite/deps/react-dom_client.js');
        const { CandleChart } = await import('/src/components/candle-chart.tsx');
        const { primeContract } = await import('/src/lib/contracts-cache.ts');
        const contract = { security_type: 'STK', exchange: 'TSE', code: '2330', region: 'TW', name: 'QA 台積電', day_trade: 'Yes', reference: 100 };
        primeContract(contract);
        document.getElementById('root').style.display = 'none';
        const mount = document.createElement('div');
        mount.id = 'qa-chart-panes';
        mount.style.cssText = 'position:fixed;inset:10px;display:flex;flex-direction:column;';
        document.body.append(mount);
        (dom.createRoot ?? dom.default.createRoot)(mount).render(React.createElement(CandleChart, { contract, interval: '1m', showHighLow: false }));
    });
    await expect(page.locator('[data-chart-canvas] table')).toBeVisible();
    await expect(page.locator('[data-ma-period="5"]')).not.toContainText('—');
}

async function geometry(page) {
    return page.locator('[data-chart-canvas]').evaluate(host => {
        const rect = element => { const box = element.getBoundingClientRect(); return { x: box.x, y: box.y, width: box.width, height: box.height, bottom: box.bottom }; };
        const rows = [...host.querySelector('table').children].filter(row => row.cells.length === 3 && row.cells[1].querySelector('canvas') && row.getBoundingClientRect().height >= 30);
        return {
            host: rect(host), main: rect(document.querySelector('[data-chart-readouts="main"]')),
            mainOutside: !host.contains(document.querySelector('[data-chart-readouts="main"]')),
            rows: rows.map(row => rect(row.cells[1])),
            headers: [...host.querySelectorAll('[data-chart-readouts="pane"]')].map(element => ({
                type: element.dataset.paneIndicator, ...rect(element),
                background: getComputedStyle(element).backgroundColor, opacity: getComputedStyle(element).opacity,
            })),
        };
    });
}

async function expectGeometry(page, types, headerHeight = 28) {
    await expect.poll(async () => {
        const measured = await geometry(page);
        if (measured.rows.length !== types.length + 1 || measured.headers.length !== types.length) return false;
        if (measured.rows.some(row => row.width > measured.host.width || row.bottom > measured.host.bottom)) return false;
        return types.every((type, index) => {
            const header = measured.headers.find(header => header.type === type);
            return header && Math.abs(header.y - measured.rows[index + 1].y) <= 1 && Math.abs(header.width - measured.rows[index + 1].width) <= 1;
        });
    }, { message: 'Each information strip must follow its actual native pane, including after deferred chart layout.' }).toBe(true);
    const measured = await geometry(page);
    expect(measured.mainOutside).toBe(true);
    expect(measured.main.bottom).toBeLessThanOrEqual(measured.host.y + 1);
    for (const header of measured.headers) {
        expect(header.height).toBe(headerHeight);
        expect(header.width).toBeLessThanOrEqual(measured.rows[1].width + 1);
        expect(header.opacity).toBe('1');
        const channels = header.background.match(/[\d.]+/g).map(Number);
        expect(channels.length === 3 || channels[3] === 1).toBe(true);
    }
    return measured;
}

async function coloredInsets(page) {
    return page.locator('[data-chart-canvas]').evaluate(host => {
        const rows = [...host.querySelector('table').children].filter(row => row.cells.length === 3 && row.cells[1].querySelector('canvas') && row.getBoundingClientRect().height >= 30);
        return rows.slice(1).map(row => {
            const canvas = row.cells[1].querySelector('canvas');
            const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
            let firstColoredRow = null;
            for (let y = 0; y < canvas.height && firstColoredRow === null; y++) {
                for (let x = 2; x < canvas.width - 2; x += 2) {
                    const index = (y * canvas.width + x) * 4;
                    if (data[index + 3] > 100 && Math.max(data[index], data[index + 1], data[index + 2]) - Math.min(data[index], data[index + 1], data[index + 2]) > 30) { firstColoredRow = y; break; }
                }
            }
            return firstColoredRow === null ? null : firstColoredRow / (canvas.height / row.getBoundingClientRect().height);
        });
    });
}

const saved = page => page.evaluate(() => JSON.parse(localStorage.getItem('sj-pro-indicators-v3')));
const rowsCount = page => page.locator('[data-chart-canvas] table > tr').evaluateAll(rows => rows.filter(row => row.cells.length === 3 && row.cells[1].querySelector('canvas') && row.getBoundingClientRect().height >= 30).length);

/** Scrolling must not shrink Motion's available drag range or offset a new grab. */
async function scrolledIndicatorDragCheck(browser, origin, artifacts) {
    const context = await browser.newContext({ viewport: { width: 1000, height: 700 } });
    await installFixture(context, []);
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    try {
        await page.goto(origin);
        await page.waitForSelector('[data-slot="card"]');
        await page.evaluate(async () => {
            const React = (await import('/node_modules/.vite/deps/react.js')).default;
            const dom = await import('/node_modules/.vite/deps/react-dom_client.js');
            const { IndicatorManager } = await import('/src/components/indicator-manager.tsx');
            const { reorderIndicatorCategory } = await import('/src/lib/indicator-order.ts');
            const initial = [5, 10, 20].map((period, index) => ({ id: `scroll-ma-${index}`, type: 'sma', params: { period }, colors: {} }));
            window.__qaScrollWrites = [];
            function Harness() {
                const [instances, setInstances] = React.useState(initial);
                return React.createElement(IndicatorManager, { instances, onAdd() {}, management: {
                    timeframe: 1, onSettings() {}, onToggle() {}, onDuplicate() {}, onRemove() {},
                    onReorder(id, order) {
                        window.__qaScrollWrites.push([...order]);
                        setInstances(list => reorderIndicatorCategory(list, id, order));
                    },
                } });
            }
            document.getElementById('root').style.display = 'none';
            const mount = document.createElement('div');
            mount.id = 'qa-indicator-scroll';
            mount.style.cssText = 'position:fixed;top:10px;left:10px;width:600px;height:180px;display:flex;flex-direction:column;';
            document.body.append(mount);
            (dom.createRoot ?? dom.default.createRoot)(mount).render(React.createElement(Harness));
        });
        const list = page.locator('[aria-label="已加入的主圖指標"]').locator('..');
        const rows = page.locator('[data-managed-indicator]');
        const order = () => rows.evaluateAll(elements => elements.map(element => element.dataset.managedIndicator));
        const writes = () => page.evaluate(() => window.__qaScrollWrites);
        const settle = () => expect.poll(() => rows.evaluateAll(elements => elements.every(element => {
            const matrix = new DOMMatrixReadOnly(getComputedStyle(element).transform === 'none' ? undefined : getComputedStyle(element).transform);
            return Math.abs(matrix.m42) < 0.2 && Math.abs(matrix.a - 1) < 0.001;
        }))).toBe(true);
        await expect(rows).toHaveCount(3);
        const begin = async (id, delta) => {
            await settle();
            await list.evaluate(element => { element.scrollTop = 50; });
            await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
            expect(await list.evaluate(element => element.scrollTop)).toBe(50);
            const row = page.locator(`[data-managed-indicator="${id}"]`);
            const before = await row.boundingBox();
            const grip = await page.locator(`[data-reorder-handle="${id}"]`).boundingBox();
            const x = grip.x + grip.width / 2, y = grip.y + grip.height / 2;
            await page.mouse.move(x, y); await page.mouse.down();
            await page.mouse.move(x, y + delta, { steps: 8 });
            await expect(row).toHaveAttribute('data-indicator-dragging', 'true');
            await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
            const displacement = (await row.boundingBox()).y - before.y;
            expect(Math.abs(displacement - delta), 'A scrolled row must follow the pointer without subtracting scrollTop or jumping at pickup').toBeLessThan(2);
            return displacement;
        };
        const down = await begin('scroll-ma-1', 40);
        await expect.poll(order).toEqual(['scroll-ma-0', 'scroll-ma-2', 'scroll-ma-1']);
        expect(await writes()).toEqual([]);
        await page.keyboard.press('Escape'); await page.mouse.up();
        await expect.poll(order).toEqual(['scroll-ma-0', 'scroll-ma-1', 'scroll-ma-2']);
        expect(await writes()).toEqual([]);
        const up = await begin('scroll-ma-2', -10);
        await page.keyboard.press('Escape'); await page.mouse.up();
        expect(await writes()).toEqual([]);
        await begin('scroll-ma-1', 40);
        await page.mouse.up();
        await expect.poll(writes).toEqual([['scroll-ma-0', 'scroll-ma-2', 'scroll-ma-1']]);
        await settle();
        await page.locator('#qa-indicator-scroll').screenshot({ path: path.join(artifacts, 'indicator-drag-scrolled.png'), animations: 'disabled' });
        expect(errors).toEqual([]);
        return { check: 'scrolled-indicator-handle-follows-pointer-cancel-and-commit', down, up, writes: await writes() };
    } catch (error) {
        await page.screenshot({ path: path.join(artifacts, 'indicator-drag-scrolled-failure.png') }).catch(() => {});
        throw error;
    } finally { await context.close(); }
}

/** Real CandleChart and storage migration; separate storage plus fully mocked APIs. */
export async function chartPaneChecks(browser, source, origin, artifacts) {
    // source deliberately supplies no authenticated storage to this component fixture.
    void source;
    const context = await browser.newContext({ viewport: { width: 1250, height: 900 } });
    const requests = [], errors = [], results = [];
    results.push(await scrolledIndicatorDragCheck(browser, origin, artifacts));
    await installFixture(context, requests);
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    try {
        await mountFixture(page, origin);
        const initial = await saved(page);
        expect(initial.map(instance => instance.type)).toEqual(['sma', 'volume', 'macd']);
        expect(await page.evaluate(() => JSON.parse(localStorage.getItem('sj-pro-indicators-v2')))).toEqual(legacy);
        const volumeId = initial.find(instance => instance.type === 'volume').id;
        const migration = await page.evaluate(async () => {
            const { initializeIndicatorPanels, IndicatorInstanceService } = await import('/src/lib/indicator-instance-service.ts');
            let workspace = initializeIndicatorPanels({ blocks: [{ id: 'old-chart', type: 'chart', pin: null, indicatorState: { revision: 'old', instances: [] } }], layout: [] });
            const first = structuredClone(workspace.blocks[0].indicatorState);
            const service = new IndicatorInstanceService({ getWorkspace: () => workspace, updateWorkspace: next => { workspace = initializeIndicatorPanels(next); } });
            service.remove('old-chart', first.instances[0].id, first.revision);
            const reloaded = initializeIndicatorPanels(structuredClone(workspace));
            return { first, after: reloaded.blocks[0].indicatorState, stable: initializeIndicatorPanels(reloaded) === reloaded };
        });
        expect(migration.first).toMatchObject({ schemaVersion: 2, instances: [{ type: 'volume' }] });
        expect(migration.after).toMatchObject({ schemaVersion: 2, instances: [] });
        expect(migration.stable).toBe(true);
        results.push({ check: 'global-v2-and-panel-migration-once', volumeId });

        await page.getByRole('button', { name: '指標', exact: true }).click();
        const manager = page.getByRole('dialog', { name: '技術指標', exact: true });
        await expect(manager.getByRole('tab', { name: '已加入（3）' })).toHaveAttribute('aria-selected', 'true');
        await expect(manager.locator('[data-managed-indicator]')).toHaveCount(3);
        await manager.getByRole('button', { name: '成交量 更多操作', exact: true }).click();
        await expect(page.getByRole('menu')).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(page.getByRole('menu')).toHaveCount(0);
        await expect(manager).toBeVisible();
        await expect(manager.getByRole('button', { name: '成交量 更多操作', exact: true })).toBeFocused();
        await manager.getByRole('button', { name: '成交量 隱藏', exact: true }).click();
        await expect(manager.getByText('已隱藏', { exact: true })).toBeVisible();
        expect((await saved(page)).find(instance => instance.type === 'volume').hidden).toBe(true);
        await manager.getByRole('button', { name: '成交量 顯示', exact: true }).click();
        const macdId = initial.find(instance => instance.type === 'macd').id;
        const dragManaged = async (id, target) => {
            const handle = manager.locator(`[data-reorder-handle="${id}"]`);
            const sourceBox = await handle.boundingBox();
            const targetBox = await manager.locator(`[data-managed-indicator="${target}"]`).boundingBox();
            await page.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2);
            await page.mouse.down();
            await page.mouse.move(sourceBox.x + sourceBox.width / 2, targetBox.y + targetBox.height * 0.75, { steps: 12 });
            await expect(manager.locator(`[data-managed-indicator="${id}"]`)).toHaveAttribute('data-indicator-dragging', 'true');
        };
        const paneOrder = () => manager.locator('[aria-label="已加入的副圖指標"] [data-managed-indicator]').evaluateAll(rows => rows.map(row => row.dataset.managedIndicator));
        await expect(manager.getByRole('button', { name: /上移|下移/ })).toHaveCount(0);
        const beforeDrag = await saved(page);
        await dragManaged(volumeId, macdId);
        await expect.poll(paneOrder).toEqual([macdId, volumeId]);
        expect(await saved(page)).toEqual(beforeDrag);
        const animation = await manager.locator(`[data-managed-indicator="${macdId}"]`).evaluate(async row => {
            const samples = [];
            for (let index = 0; index < 5; index++) {
                samples.push(getComputedStyle(row).transform);
                await new Promise(resolve => requestAnimationFrame(resolve));
            }
            return samples;
        });
        expect(animation.some(transform => transform !== 'none')).toBe(true);
        expect(new Set(animation).size).toBeGreaterThan(1);
        await manager.screenshot({ path: path.join(artifacts, 'indicator-manager-dragging.png'), animations: 'allow' });
        await page.mouse.up();
        await expect.poll(async () => (await saved(page)).map(instance => instance.type)).toEqual(['sma', 'macd', 'volume']);
        await expect(manager.locator('[data-indicator-dragging]')).toHaveCount(0);
        // Cancelled previews leave both storage and the open manager intact.
        await dragManaged(volumeId, macdId);
        await expect.poll(paneOrder).toEqual([volumeId, macdId]);
        await page.keyboard.press('Escape'); await page.mouse.up();
        await expect(manager).toBeVisible();
        await expect.poll(paneOrder).toEqual([macdId, volumeId]);
        expect((await saved(page)).map(instance => instance.type)).toEqual(['sma', 'macd', 'volume']);
        await manager.getByRole('button', { name: '成交量 拖曳排序', exact: true }).focus();
        await page.keyboard.press('Space'); await page.keyboard.press('ArrowUp');
        expect((await saved(page)).map(instance => instance.type)).toEqual(['sma', 'macd', 'volume']);
        await page.keyboard.press('Enter');
        await expect.poll(async () => (await saved(page)).map(instance => instance.type)).toEqual(['sma', 'volume', 'macd']);
        results.push({ check: 'animated-handle-drag-preview-release-cancel-keyboard', animation });
        for (const mode of ['dark', 'light']) {
            await page.evaluate(async mode => (await import('/src/lib/theme-store.ts')).setThemeSettings({ mode }), mode);
            await manager.screenshot({ path: path.join(artifacts, `indicator-manager-${mode}.png`), animations: 'disabled' });
        }
        await page.setViewportSize({ width: 390, height: 844 });
        expect(await manager.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
        await manager.screenshot({ path: path.join(artifacts, 'indicator-manager-narrow.png'), animations: 'disabled' });
        await page.setViewportSize({ width: 1250, height: 900 });
        await manager.getByRole('button', { name: 'MACD(12,26,9) 設定', exact: true }).click();
        await expect(manager).not.toBeVisible();
        const manageSettings = page.getByRole('dialog', { name: '指標設定', exact: true });
        const fast = manageSettings.getByRole('spinbutton').first();
        await fast.fill('7');
        await manageSettings.getByRole('button', { name: '取消', exact: true }).click();
        expect((await saved(page)).find(instance => instance.type === 'macd').params.fast).toBe(12);
        await page.getByRole('button', { name: '指標', exact: true }).click();
        await manager.getByRole('button', { name: 'MACD(12,26,9) 設定', exact: true }).click();
        await fast.fill('7');
        await manageSettings.getByRole('button', { name: '確定', exact: true }).click();
        expect((await saved(page)).find(instance => instance.type === 'macd').params.fast).toBe(7);
        await page.getByRole('button', { name: '指標', exact: true }).click();
        await manager.getByRole('button', { name: 'MACD(7,26,9) 設定', exact: true }).click();
        await fast.fill('12');
        await manageSettings.getByRole('button', { name: '確定', exact: true }).click();
        results.push({ check: 'indicator-manager-visibility-order-settings-cancel-commit-responsive' });

        for (const mode of ['dark', 'light']) {
            await page.evaluate(async mode => (await import('/src/lib/theme-store.ts')).setThemeSettings({ mode }), mode);
            const measured = await expectGeometry(page, ['volume', 'macd']);
            await expect.poll(async () => (await coloredInsets(page)).every(inset => inset !== null && inset >= 31)).toBe(true);
            results.push({ check: `opaque-aligned-inset-${mode}`, measured, firstColoredRows: await coloredInsets(page) });
            await page.locator('#qa-chart-panes').screenshot({ path: path.join(artifacts, `chart-panes-${mode}.png`), animations: 'disabled' });
        }
        await page.evaluate(async () => (await import('/src/lib/theme-store.ts')).setThemeSettings({ mode: 'dark' }));
        const beforeResize = await geometry(page);
        const splitter = page.locator('[data-chart-canvas] div[style*="position: absolute"][style*="cursor: row-resize"]').first();
        const splitterBox = await splitter.boundingBox();
        await page.mouse.move(splitterBox.x + splitterBox.width / 2, splitterBox.y + splitterBox.height / 2);
        await page.mouse.down();
        await page.mouse.move(splitterBox.x + splitterBox.width / 2, splitterBox.y + splitterBox.height / 2 - 45, { steps: 8 });
        await page.mouse.up();
        await expect.poll(async () => Math.abs((await geometry(page)).rows[0].height - beforeResize.rows[0].height)).toBeGreaterThan(30);
        results.push({ check: 'native-pane-splitter', measured: await expectGeometry(page, ['volume', 'macd']) });
        await page.locator('#qa-chart-panes').screenshot({ path: path.join(artifacts, 'chart-panes-resized.png'), animations: 'disabled' });

        await page.setViewportSize({ width: 390, height: 844 });
        results.push({ check: 'narrow', measured: await expectGeometry(page, ['volume', 'macd']) });
        await page.locator('#qa-chart-panes').screenshot({ path: path.join(artifacts, 'chart-panes-narrow.png'), animations: 'disabled' });
        await page.setViewportSize({ width: 1250, height: 900 });
        await expectGeometry(page, ['volume', 'macd']);

        // Crosshair time readouts stay synchronized; subpane coordinates never become prices.
        await page.evaluate(async () => (await import('/src/lib/chart-price-prefs.ts')).setChartHoverPricePick(true));
        let measured = await geometry(page);
        const x = measured.rows[0].x + measured.rows[0].width * 0.34;
        const mainReadouts = page.locator('[data-chart-readouts="main"]');
        const latestValues = await mainReadouts.innerText();
        await page.mouse.move(x, measured.rows[0].y + measured.rows[0].height / 2);
        await expect.poll(() => mainReadouts.innerText()).not.toBe(latestValues);
        await expect.poll(() => mainReadouts.innerText()).not.toContain('—');
        const mainValues = await mainReadouts.innerText();
        const pickedBefore = await page.evaluate(async () => (await import('/src/lib/price-sync.ts')).getPickedPrice());
        expect(pickedBefore).not.toBeNull();
        for (const pane of measured.rows.slice(1)) {
            await page.mouse.move(x, pane.y + pane.height * 0.7);
            await expect.poll(() => mainReadouts.innerText()).toBe(mainValues);
            await page.mouse.click(x, pane.y + pane.height * 0.7);
            expect(await page.evaluate(async () => (await import('/src/lib/price-sync.ts')).getPickedPrice())).toEqual(pickedBefore);
        }
        expect(await page.locator('[data-indicator-readout="volume"] [data-indicator-output]').innerText()).toMatch(/^\d[\d,]*$/);
        await page.getByRole('button', { name: '點價買', exact: true }).click();
        const armedHint = page.getByText(/交易模式 ·/);
        await expect(armedHint).toBeVisible();
        await page.mouse.click(x, measured.rows[1].y + measured.rows[1].height * 0.7);
        await expect(armedHint).toBeVisible();
        await page.getByRole('button', { name: '點價買', exact: true }).click();
        await page.mouse.click(x, measured.rows[0].y + measured.rows[0].height / 2);
        await page.keyboard.press('Alt+h');
        const horizontal = page.getByRole('button', { name: /：水平線$/ });
        await expect(horizontal).toHaveAttribute('aria-pressed', 'true');
        for (const pane of measured.rows.slice(1)) await page.mouse.click(x, pane.y + pane.height * 0.7);
        expect(await page.evaluate(async () => (await import('/src/lib/chart-drawings.ts')).getDrawings('2330').length)).toBe(0);
        await expect(horizontal).toHaveAttribute('aria-pressed', 'true');
        await page.mouse.click(x, measured.rows[0].y + measured.rows[0].height / 2);
        await expect.poll(() => page.evaluate(async () => (await import('/src/lib/chart-drawings.ts')).getDrawings('2330').length)).toBe(1);
        await page.evaluate(async () => (await import('/src/lib/chart-drawings.ts')).clearDrawings('2330'));
        results.push({ check: 'crosshair-subpane-price-order-drawing-guards', mainValues, pickedBefore });

        let volume = page.locator('[data-indicator-readout="volume"]');
        await volume.hover();
        await volume.getByTitle('隱藏', { exact: true }).click();
        await expect(page.locator('[data-pane-indicator="volume"]')).toHaveCount(0);
        await expect.poll(() => rowsCount(page)).toBe(2);
        expect((await saved(page)).find(instance => instance.id === volumeId).hidden).toBe(true);
        await mountFixture(page, origin);
        await expect(page.locator('[data-pane-indicator="volume"]')).toHaveCount(0);
        volume = page.locator('[data-chart-readouts="main"] [data-indicator-readout="volume"]');
        await expect(volume).toBeVisible();
        await volume.hover();
        await volume.getByTitle('顯示', { exact: true }).click();
        await expectGeometry(page, ['volume', 'macd']);
        volume = page.locator('[data-pane-indicator="volume"] [data-indicator-readout="volume"]');
        await volume.hover();
        await volume.getByTitle('更多', { exact: true }).click();
        await page.getByRole('menuitem', { name: '下移（視覺順序）', exact: true }).click();
        await page.mouse.click(5, 5);
        await expectGeometry(page, ['macd', 'volume']);
        await mountFixture(page, origin);
        expect((await saved(page)).map(instance => instance.type)).toEqual(['sma', 'macd', 'volume']);
        expect((await saved(page)).find(instance => instance.type === 'volume').id).toBe(volumeId);
        await expectGeometry(page, ['macd', 'volume']);
        results.push({ check: 'volume-hide-show-reorder-reload', volumeId });

        volume = page.locator('[data-pane-indicator="volume"] [data-indicator-readout="volume"]');
        await volume.hover();
        await volume.getByTitle('更多', { exact: true }).click();
        await page.getByRole('menuitem', { name: '移除', exact: true }).click();
        await expect.poll(() => rowsCount(page)).toBe(2);
        await mountFixture(page, origin);
        await expect(page.locator('[data-indicator-readout="volume"]')).toHaveCount(0);
        await expect.poll(() => rowsCount(page)).toBe(2);
        expect((await saved(page)).map(instance => instance.type)).toEqual(['sma', 'macd']);
        await page.getByRole('button', { name: '指標', exact: true }).click();
        const picker = page.getByRole('dialog', { name: '技術指標', exact: true });
        await picker.getByRole('tab', { name: '新增指標', exact: true }).click();
        await picker.getByPlaceholder('搜尋指標（名稱、縮寫、中英文都可以）').fill('成交量');
        await picker.getByRole('button', { name: /^成交量 / }).click();
        const settings = page.getByRole('dialog', { name: '指標設定', exact: true });
        await settings.getByRole('button', { name: '確定', exact: true }).click();
        await expectGeometry(page, ['macd', 'volume']);
        await mountFixture(page, origin);
        await expectGeometry(page, ['macd', 'volume']);
        expect((await saved(page)).filter(instance => instance.type === 'volume')).toHaveLength(1);
        await page.locator('#qa-chart-panes').screenshot({ path: path.join(artifacts, 'chart-panes-managed-volume.png'), animations: 'disabled' });
        results.push({ check: 'volume-remove-readd-reload-no-duplicate' });
        const coarseContext = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
        try {
            await installFixture(coarseContext, requests);
            const coarse = await coarseContext.newPage();
            coarse.on('pageerror', error => errors.push(error.message));
            await mountFixture(coarse, origin);
            await expect.poll(() => coarse.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true);
            await coarse.getByRole('button', { name: '指標', exact: true }).click();
            const coarseManager = coarse.getByRole('dialog', { name: '技術指標', exact: true });
            await expect(coarseManager.locator('[data-managed-indicator]')).toHaveCount(3);
            const targets = await coarseManager.locator('[data-managed-indicator] button').evaluateAll(buttons => buttons.map(button => {
                const rect = button.getBoundingClientRect(); return { width: rect.width, height: rect.height };
            }));
            expect(targets.every(target => target.width >= 44 && target.height >= 44)).toBe(true);
            expect(await coarseManager.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
            await coarseManager.screenshot({ path: path.join(artifacts, 'indicator-manager-coarse.png'), animations: 'disabled' });
            await coarse.setViewportSize({ width: 320, height: 740 });
            expect(await coarseManager.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
            const compactNames = await coarseManager.locator('[data-managed-indicator] > button[aria-label$=" 設定"]').evaluateAll(buttons => buttons.map(button => {
                const rect = button.getBoundingClientRect(); return { width: rect.width, height: rect.height };
            }));
            expect(compactNames.every(target => target.width >= 150 && target.height <= 70)).toBe(true);
            await coarseManager.screenshot({ path: path.join(artifacts, 'indicator-manager-coarse-320.png'), animations: 'disabled' });
            await coarse.setViewportSize({ width: 390, height: 844 });
            await coarseManager.getByRole('button', { name: '關閉技術指標', exact: true }).click();
            results.push({ check: 'coarse-pointer-44px-headers', measured: await expectGeometry(coarse, ['volume', 'macd'], 44) });
            await coarse.locator('#qa-chart-panes').screenshot({ path: path.join(artifacts, 'chart-panes-coarse.png'), animations: 'disabled' });
            const lastSplitter = coarse.locator('[data-chart-canvas] div[style*="position: absolute"][style*="cursor: row-resize"]').last();
            const lastBox = await lastSplitter.boundingBox();
            await coarse.mouse.move(lastBox.x + 80, lastBox.y + lastBox.height / 2);
            await coarse.mouse.down();
            await coarse.mouse.move(lastBox.x + 80, lastBox.y + lastBox.height / 2 + 300, { steps: 10 });
            await coarse.mouse.up();
            await expect.poll(async () => (await geometry(coarse)).rows.at(-1).height).toBe(30);
            await coarse.locator('#qa-chart-panes').screenshot({ path: path.join(artifacts, 'chart-panes-coarse-collapsed.png'), animations: 'disabled' });
            await expect.poll(async () => {
                const measured = await geometry(coarse);
                return measured.headers.every((header, index) => header.y >= measured.rows[index + 1].y - 1 && header.bottom <= measured.rows[index + 1].bottom + 1);
            }, { message: 'A collapsed pane header must stay inside its native pane and leave the time axis visible.' }).toBe(true);
            results.push({ check: 'coarse-minimum-pane-header-containment', measured: await geometry(coarse) });

        } finally { await coarseContext.close(); }
        expect(requests.filter(request => request.pathname.startsWith('/api/v1/order/'))).toEqual([]);
        expect(errors).toEqual([]);
        await writeFile(path.join(artifacts, 'chart-panes-summary.json'), JSON.stringify({ passed: true, results, errors, requests }, null, 2));
        return results;
    } catch (error) {
        await page.screenshot({ path: path.join(artifacts, 'chart-panes-failure.png'), animations: 'disabled' });
        await writeFile(path.join(artifacts, 'chart-panes-summary.json'), JSON.stringify({ passed: false, error: String(error), results, errors, requests }, null, 2));
        throw error;
    } finally { await context.close(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const origin = process.env.CHART_PANES_ORIGIN || 'http://localhost:5624';
    const artifacts = process.env.CHART_PANES_ARTIFACT_DIR || await mkdtemp(path.join(tmpdir(), 'fubon-chart-panes-'));
    await mkdir(artifacts, { recursive: true });
    const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true });
    try {
        const results = await chartPaneChecks(browser, null, origin, artifacts);
        console.log(JSON.stringify({ passed: true, artifacts, checks: results.map(result => result.check) }, null, 2));
    } catch (error) { console.error(JSON.stringify({ passed: false, artifacts, error: String(error), stack: error.stack }, null, 2)); process.exitCode = 1; }
    finally { await browser.close(); }
}
