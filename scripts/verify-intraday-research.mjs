// Focused, isolated UI acceptance. Uses synthetic data and temporary SQLite /
// Passkey stores only. Does not access Keychain or contact a brokerage.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';

const root = fileURLToPath(new URL('../', import.meta.url));
const uiPort = Number(process.env.RESEARCH_UI_PORT || 6187);
const apiPort = Number(process.env.RESEARCH_API_PORT || 22987);
const origin = `http://localhost:${uiPort}`;
const temporary = await mkdtemp('/private/tmp/fubon-intraday-qa-');
const artifacts = process.env.RESEARCH_ARTIFACT_DIR || temporary;
await mkdir(artifacts, { recursive: true });
const token = randomBytes(32).toString('base64url');
const countsFile = path.join(temporary, 'history-count.json');
const children = [];
let browser;
let page;
let logs = '';
let closing;
const transactionPaths = [];
const readonlyOrderPaths = [];
const pageErrors = [];
const databaseReadResponses = [];

function run(command, args, env = {}) {
    const child = spawn(command, args, {
        cwd: root, detached: process.platform !== 'win32',
        env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', data => { logs = (logs + data).slice(-16000); });
    child.stderr.on('data', data => { logs = (logs + data).slice(-16000); });
    child.on('error', error => { logs += error.message; });
    children.push(child);
    return child;
}
async function free(port) {
    await new Promise((resolve, reject) => {
        const probe = net.createServer();
        probe.once('error', reject);
        probe.listen(port, '127.0.0.1', () => probe.close(resolve));
    });
}
async function ready(url) {
    for (let i = 0; i < 300; i++) {
        if (children.some(child => child.exitCode !== null && child.exitCode !== 0)) throw new Error('An isolated QA server exited.');
        try { if ((await fetch(url, { signal: AbortSignal.timeout(500) })).status < 500) return; } catch { /* Starting. */ }
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`QA server not ready: ${url}`);
}
async function cleanup() {
    return closing ??= (async () => {
        await browser?.close().catch(() => undefined);
        for (const child of children) {
            if (child.exitCode !== null) continue;
            try { process.kill(process.platform === 'win32' ? child.pid : -child.pid, 'SIGTERM'); } catch { /* Already exited. */ }
        }
    })();
}
for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
    process.once(signal, () => { void cleanup().finally(() => process.exit(code)); });
}
const historyCalls = async () => JSON.parse(await readFile(countsFile, 'utf8')).historyCalls;
const panel = () => page.getByLabel('日內回測研究', { exact: true });
async function finishLoading() {
    await expect(panel().getByRole('button', { name: '下載／載入資料', exact: true })).toBeEnabled({ timeout: 60000 });
}
async function setDates(start = '2026-11-02', end = '2026-11-04') {
    await panel().getByLabel('開始日期', { exact: true }).fill(start);
    await panel().getByLabel('結束日期', { exact: true }).fill(end);
}
async function dbStats() {
    return page.evaluate(async () => {
        const token = sessionStorage.getItem('fubon-trading-session');
        const response = await fetch('/api/v1/research/database', { headers: { Authorization: `Bearer ${token}` } });
        if (!response.ok) throw new Error(`Database status ${response.status}`);
        return response.json();
    });
}
async function assertPanelFits() {
    const layout = await panel().evaluate(el => ({ width: el.clientWidth, overflow: el.scrollWidth - el.clientWidth }));
    expect(layout.width).toBeGreaterThan(250);
    expect(layout.overflow).toBeLessThanOrEqual(1);
    for (const name of ['下載／載入資料', '只讀本地資料庫', '比較回測', '快速判讀本地資料']) {
        const control = panel().getByRole('button', { name, exact: true });
        await control.scrollIntoViewIfNeeded();
        const fit = await control.evaluate(el => {
            const p = el.closest('[aria-label="日內回測研究"]').getBoundingClientRect();
            const r = el.getBoundingClientRect();
            return r.left >= p.left - 1 && r.right <= p.right + 1 && r.width > 30 && r.height >= 24;
        });
        expect(fit).toBe(true);
    }
}
async function setTheme(name) {
    await page.getByRole('button', { name: '設定', exact: true }).click();
    const settings = page.getByRole('dialog', { name: '設定', exact: true });
    await settings.getByRole('tab', { name: '外觀', exact: true }).click();
    await settings.getByRole('radio', { name, exact: true }).click();
    await page.keyboard.press('Escape');
    await expect(settings).toBeHidden();
}

try {
    await free(uiPort); await free(apiPort);
    await writeFile(countsFile, JSON.stringify({ historyCalls: 0, sdkCalls: 0 }));
    const backend = path.join(temporary, 'backend.py');
    await writeFile(backend, `import os, json
from pathlib import Path
import uvicorn
from fubon_bridge.app import create_app
from fubon_bridge.broker import Broker
from fubon_bridge.config import Config
from fubon_bridge.passkeys import PasskeyStore
from fubon_bridge.research import ResearchStore
counter = Path(os.environ['RESEARCH_COUNT_FILE'])
original = Broker.research_candles
def counted(self, *args, **kwargs):
    data = json.loads(counter.read_text())
    data['historyCalls'] += 1
    counter.write_text(json.dumps(data))
    return original(self, *args, **kwargs)
Broker.research_candles = counted
def no_sdk():
    data = json.loads(counter.read_text())
    data['sdkCalls'] += 1
    counter.write_text(json.dumps(data))
    raise AssertionError('Synthetic QA must never initialize brokerage SDK')
app = create_app(Config(mode='demo', port=int(os.environ['RESEARCH_UI_PORT'])),
    sdk_factory=no_sdk, launch_token=os.environ['RESEARCH_LAUNCH'], public_origin=os.environ['RESEARCH_ORIGIN'],
    passkey_store=PasskeyStore(os.environ['RESEARCH_PASSKEY_DATABASE']), research_store=ResearchStore(os.environ['RESEARCH_DATABASE']))
uvicorn.run(app, host='127.0.0.1', port=int(os.environ['RESEARCH_API_PORT']), access_log=False)
`);
    run(process.env.RESEARCH_PYTHON || path.join(root, 'server', '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'), [backend], {
        PYTHONPATH: path.join(root, 'server'), RESEARCH_UI_PORT: String(uiPort), RESEARCH_API_PORT: String(apiPort),
        RESEARCH_LAUNCH: token, RESEARCH_ORIGIN: origin, RESEARCH_COUNT_FILE: countsFile,
        RESEARCH_PASSKEY_DATABASE: path.join(temporary, 'passkeys.sqlite3'), RESEARCH_DATABASE: path.join(temporary, 'research.sqlite3'),
    });
    run(process.execPath, [path.join(root, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(uiPort), '--strictPort'], {
        VITE_API_TARGET: `http://127.0.0.1:${apiPort}`, VITE_API_BASE: '', VITE_STREAM_BASE: origin, VITE_DEV_SERVER_PORT: '',
    });
    await ready(`http://127.0.0.1:${apiPort}/api/v1/passkeys/status`);
    await ready(origin);
    browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true, ignoreDefaultArgs: ['--hide-scrollbars'] });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1050 } });
    page = await context.newPage();
    page.on('pageerror', error => pageErrors.push(error.message));
    page.on('response', response => {
        const pathname = new URL(response.url()).pathname;
        if (response.request().method() === 'GET' && /^\/api\/v1\/research\/(database|runs)$/.test(pathname)) {
            databaseReadResponses.push({ path: pathname, status: response.status() });
        }
    });
    await page.route('**/api/v1/order/**', async route => {
        const pathname = new URL(route.request().url()).pathname;
        if (/\/(?:place_order|place_comboorder|cancel_order|cancel_comboorder|update_price|update_qty|reserve_stock|reserve_earmarking)$/.test(pathname)) {
            transactionPaths.push(pathname);
            return route.abort('blockedbyclient');
        }
        readonlyOrderPaths.push(pathname);
        return route.continue();
    });
    const cdp = await context.newCDPSession(page);
    await cdp.send('WebAuthn.enable');
    await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
    await page.goto(`${origin}/#fubon-launch=${token}`);
    await page.getByRole('button', { name: '建立 Passkey 並解鎖' }).click();
    await expect(page.getByRole('status').filter({ hasText: '展示模式' })).toBeVisible({ timeout: 30000 });
    await expect(page.getByText('LIVE', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: /新增面板/ }).first().click();
    const picker = page.getByRole('dialog', { name: '新增面板', exact: true });
    await picker.getByPlaceholder('搜尋面板（名稱或用途）').fill('策略回測');
    const coldReads = Promise.all(['database', 'runs'].map(endpoint => page.waitForResponse(response =>
        response.request().method() === 'GET' && response.url().endsWith(`/api/v1/research/${endpoint}`))));
    await picker.locator('button[data-idx]').filter({ hasText: '策略回測' }).click();
    await expect(panel()).toBeVisible();
    const coldStartReadStatuses = (await coldReads).map(response => response.status());
    expect(coldStartReadStatuses).toEqual([200, 200]);
    await expect(panel().getByText(/本地保存 0 根 K 棒/)).toBeVisible();
    await expect(panel().getByRole('alert')).toBeHidden();
    const coldStartStats = await dbStats();
    expect(coldStartStats).toEqual({ bars: 0, datasets: 0, weights: 0, runs: 0, signals: 0 });
    // A legitimate single-panel workspace isolates the feature from unrelated terminal panels.
    await page.evaluate(() => {
        const workspace = JSON.parse(localStorage.getItem('sj-pro-workspace-v3'));
        const block = workspace.blocks.find(b => b.type === 'backtest');
        localStorage.setItem('sj-pro-workspace-v3', JSON.stringify({ ...workspace, blocks: [block], layout: [{ i: block.id, x: 0, y: 0, w: 288, h: 24, minW: 96, minH: 8 }] }));
    });
    await page.reload();
    await expect(panel()).toBeVisible();
    const productChoice = panel().getByRole('combobox', { name: '期貨商品', exact: true });
    await productChoice.focus(); await page.keyboard.press('Enter');
    await expect(page.getByRole('option', { name: '微台 TMF · 每點 $10', exact: true })).toBeFocused();
    await page.screenshot({ path: path.join(artifacts, 'research-select-open.png') });
    await page.keyboard.press('ArrowDown');
    await expect(page.getByRole('option', { name: '小台 MXF · 每點 $50', exact: true })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(productChoice).toHaveText('小台 MXF · 每點 $50');
    await productChoice.click(); await page.getByRole('option', { name: '微台 TMF · 每點 $10', exact: true }).click();
    await expect(productChoice).toHaveText('微台 TMF · 每點 $10');
    await expect(panel().locator('select:not([aria-hidden="true"])')).toHaveCount(0);
    await panel().getByLabel('具體合約月份', { exact: true }).fill('202611');
    await setDates();

    // Miss path has a useful message; no synthetic / broker request is made.
    await panel().getByRole('button', { name: '只讀本地資料庫', exact: true }).click();
    await finishLoading();
    await expect(panel().getByRole('alert')).toContainText('本地資料庫缺少');
    expect(await historyCalls()).toBe(0);
    await page.route('**/api/v1/research/history', async route => { await new Promise(resolve => setTimeout(resolve, 400)); await route.continue(); }, { times: 1 });
    const firstResponse = page.waitForResponse(response => response.url().endsWith('/api/v1/research/history') && response.request().postDataJSON()?.offline === false);
    await panel().getByRole('button', { name: '下載／載入資料', exact: true }).click();
    await expect(productChoice).toBeDisabled();
    expect((await firstResponse).status()).toBe(200);
    await finishLoading();
    await expect(panel().getByText(/合成展示資料：僅驗證流程，不代表真實績效。/)).toBeVisible();
    await expect(panel().getByText(/預填數字只是假設範例/)).toBeVisible();
    const initialStats = await dbStats();
    expect(initialStats.bars).toBeGreaterThan(0);
    expect(initialStats.datasets).toBe(1);
    expect(initialStats.weights).toBe(1);
    expect(initialStats.signals).toBe(141); // 47 five-minute decision points per trading day.
    await expect(panel().getByText(/141 個決策時點/)).toBeVisible();
    const downloads = await historyCalls();
    expect(downloads).toBe(5);

    await panel().getByRole('button', { name: '只讀本地資料庫', exact: true }).click();
    await finishLoading();
    await expect(panel().getByText(/快取命中 5\/5/)).toBeVisible();
    expect(await historyCalls()).toBe(downloads);
    expect(await dbStats()).toEqual(initialStats);

    await panel().getByRole('button', { name: '比較回測', exact: true }).click();
    await expect(panel().getByRole('region', { name: '回測結果' })).toBeVisible({ timeout: 30000 });
    await finishLoading();
    expect((await dbStats()).runs).toBe(1);
    const comparisonTable = panel().getByRole('table').first();
    await expect(comparisonTable).toContainText('加入權值股濾網');
    for (const name of ['平均每筆淨損益', '平均贏／輸', '獲利因子']) {
        await expect(comparisonTable.getByRole('columnheader', { name, exact: true })).toBeVisible();
    }
    const storedRun = await page.evaluate(async () => {
        const session = sessionStorage.getItem('fubon-trading-session');
        const response = await fetch('/api/v1/research/runs', { headers: { Authorization: `Bearer ${session}` } });
        if (!response.ok) throw new Error(`Saved runs status ${response.status}`);
        return (await response.json())[0];
    });
    const sampleMetrics = {};
    for (const [index, key] of ['baseline', 'filtered'].entries()) {
        const trades = storedRun.result[key].trades;
        const wins = trades.map(t => t.net).filter(n => n > 0);
        const losses = trades.map(t => -t.net).filter(n => n > 0);
        const sum = values => values.reduce((total, value) => total + value, 0);
        const amount = value => value === null ? '—' : value.toLocaleString('zh-TW', { maximumFractionDigits: 0 });
        const mean = trades.length ? sum(trades.map(t => t.net)) / trades.length : null;
        const win = wins.length ? sum(wins) / wins.length : null;
        const loss = losses.length ? sum(losses) / losses.length : null;
        const factor = losses.length ? sum(wins) / sum(losses) : null;
        const cells = comparisonTable.getByRole('row').nth(index + 1).getByRole('cell');
        await expect(cells.nth(2)).toHaveText(amount(mean));
        await expect(cells.nth(3)).toHaveText(`${amount(win)} / ${amount(loss)}`);
        await expect(cells.nth(4)).toHaveText(factor === null ? '—' : factor.toFixed(2));
        sampleMetrics[key] = { trades: trades.length, meanNet: mean, averageWin: win, averageLoss: loss, profitFactor: factor };
    }
    await panel().getByText('假設與驗證範圍', { exact: true }).click();
    await expect(panel().getByText(/權重為固定假設版本/)).toBeVisible();
    const latestResponse = page.waitForResponse(response => response.url().endsWith('/api/v1/research/latest'));
    const latestStarted = performance.now();
    await panel().getByRole('button', { name: '快速判讀本地資料', exact: true }).click();
    const latest = await (await latestResponse).json();
    await finishLoading();
    await expect(panel().getByText('歷史資料判讀 · 不是即時訊號', { exact: true })).toBeVisible();
    const latestUiElapsedMs = Math.round((performance.now() - latestStarted) * 100) / 100;
    expect(latest.historical).toBe(true);
    expect(Number.isFinite(latest.weightedReturn)).toBe(true);
    expect(latest.missing).toEqual([]);
    expect(latest.elapsedMs).toBeLessThan(1000);
    await expect(panel().getByText(new RegExp(`本地讀取與計算 ${latest.elapsedMs} ms`))).toBeVisible();
    await panel().screenshot({ animations: 'disabled', path: path.join(artifacts, 'research-latest.png') });
    expect(await historyCalls()).toBe(downloads);

    // Persisted results are loaded from SQLite after a real remount/reload.
    await page.reload();
    await expect(panel()).toBeVisible();
    const saved = panel().getByRole('button').filter({ hasText: /基準 .* \/ 濾網/ });
    await expect(saved).toHaveCount(1);
    await saved.click();
    await expect(panel().getByRole('region', { name: '回測結果' })).toBeVisible();
    await expect(panel().getByRole('region', { name: '回測結果' })).toContainText('TMF 202611');
    await expect(panel().getByRole('region', { name: '回測結果' })).toContainText('2026-11-02～2026-11-04');
    await expect(panel().getByRole('region', { name: '回測結果' })).toContainText('每邊手續費 $20');
    await expect(panel().getByRole('button', { name: '匯出資料與結果', exact: true })).toBeDisabled();
    expect((await dbStats()).runs).toBe(1);

    for (const theme of ['深色', '淺色']) {
        await setTheme(theme);
        for (const width of [1440, 390]) {
            await page.setViewportSize({ width, height: 1050 });
            await assertPanelFits();
            await panel().evaluate(el => { el.scrollTop = 0; });
            await panel().screenshot({ animations: 'disabled', path: path.join(artifacts, `research-${theme === '深色' ? 'dark' : 'light'}-${width}-controls.png`) });
            await panel().getByRole('region', { name: '回測結果' }).scrollIntoViewIfNeeded();
            await panel().screenshot({ animations: 'disabled', path: path.join(artifacts, `research-${theme === '深色' ? 'dark' : 'light'}-${width}-results.png`) });
            if (width === 390) {
                const factor = panel().getByRole('columnheader', { name: '獲利因子', exact: true });
                await factor.scrollIntoViewIfNeeded();
                const horizontal = await factor.evaluate(el => {
                    const viewport = el.closest('table').parentElement;
                    const r = el.getBoundingClientRect(), p = viewport.getBoundingClientRect();
                    return { scrollLeft: viewport.scrollLeft, visible: r.left >= p.left && r.right <= p.right };
                });
                expect(horizontal.scrollLeft).toBeGreaterThan(0);
                expect(horizontal.visible).toBe(true);
                await panel().screenshot({ animations: 'disabled', path: path.join(artifacts, `research-${theme === '深色' ? 'dark' : 'light'}-${width}-metrics.png`) });
                await comparisonTable.evaluate(el => { el.parentElement.scrollLeft = 0; });
            }
        }
    }
    const touch = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, storageState: await context.storageState() });
    const session = await page.evaluate(() => sessionStorage.getItem('fubon-trading-session'));
    await touch.addInitScript(value => sessionStorage.setItem('fubon-trading-session', value), session);
    try {
        const touchPage = await touch.newPage(); await touchPage.goto(origin);
        const touchPanel = touchPage.getByLabel('日內回測研究', { exact: true });
        await expect(touchPanel).toBeVisible();
        expect(await touchPage.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true);
        for (const control of await touchPanel.locator('button, input').all()) {
            const geometry = await control.evaluate(el => ({ height: el.getBoundingClientRect().height, element: el.outerHTML.slice(0, 360) }));
            expect(geometry.height, JSON.stringify(geometry)).toBeGreaterThanOrEqual(44);
        }
        await touchPanel.screenshot({ path: path.join(artifacts, 'research-touch-390-controls.png') });
    } finally { await touch.close(); }
    await page.setViewportSize({ width: 1440, height: 1050 });
    await setTheme('深色');

    // A non-trading day gives an explicit empty-data error, never a fabricated success.
    await setDates('2026-11-07', '2026-11-07');
    await panel().getByRole('button', { name: '下載／載入資料', exact: true }).click();
    await finishLoading();
    await expect(panel().getByRole('alert')).toContainText('沒有分 K');
    await panel().getByLabel(/固定假設權重/).fill('bad');
    await panel().getByRole('button', { name: '下載／載入資料', exact: true }).click();
    await finishLoading();
    await expect(panel().getByRole('alert')).toContainText('每行請輸入股票代碼');

    expect(transactionPaths).toEqual([]);
    expect(pageErrors).toEqual([]);
    expect(databaseReadResponses.every(response => response.status === 200)).toBe(true);
    const sdkCalls = JSON.parse(await readFile(countsFile, 'utf8')).sdkCalls;
    expect(sdkCalls).toBe(0);
    const nativeUserControls = await panel().locator('select:not([aria-hidden="true"])').count();
    expect(nativeUserControls).toBe(0);
    const summary = { passed: true, coldStartReadStatuses, coldStartStats, databaseReadResponses, initialStats, sampleMetrics, latest, latestUiElapsedMs, sdkCalls, nativeUserControls, historyCallsAfterCachedRead: downloads, tradingMutations: transactionPaths.length, transactionPaths, readonlyOrderQueries: readonlyOrderPaths.length, readonlyOrderPaths: [...new Set(readonlyOrderPaths)], pageErrors, artifacts };
    await writeFile(path.join(artifacts, 'summary.json'), JSON.stringify(summary, null, 2));
    console.log(JSON.stringify(summary, null, 2));
} catch (error) {
    await page?.screenshot({ path: path.join(artifacts, 'failure.png'), fullPage: true }).catch(() => undefined);
    await writeFile(path.join(artifacts, 'failure.log'), `${error.stack || error}\n\n${logs}`);
    console.error(`${error.stack || error}\nQA artifacts: ${artifacts}\n${logs.slice(-5000)}`);
    process.exitCode = 1;
} finally {
    await cleanup();
}
