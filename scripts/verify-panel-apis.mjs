// Isolated real CLI + HTTP + browser acceptance. Only native market clients are
// synthetic fixtures. Never uses the user's services, credentials or accounts.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';

const root = fileURLToPath(new URL('../', import.meta.url));
const uiPort = 6189, apiPort = 22989, origin = `http://localhost:${uiPort}`;
const temporary = await mkdtemp(path.join(tmpdir(), 'fubon-panel-apis-'));
const artifacts = process.env.PANEL_API_ARTIFACT_DIR || path.join(temporary, 'artifacts');
const launch = randomBytes(32).toString('base64url');
const children = [], results = [], pageErrors = [], blocked = [], mutations = [], watchlistMutations = [], responses = [], apiRequests = [], sourceErrors = [];
const unavailableTypes = ['chips', 'warrants', 'combo', 'combolist', 'conditional', 'oddspread',
    'heatmap', 'chainmap', 'holdingmap', 'pulse', 'signals', 'assistant', 'optchain'];
const newPanelTypes = ['fuboncredit', 'fubonaccount', 'fuboncondition', 'fubonownership', 'fuboncorporate',
    'fubontechnical', 'fubonhistory', 'fubonindices', 'fubonadvanced'];
const unavailableRoutes = /\/data\/(?:credit_enquire|short_stock_sources|regulatory_punish|index_components|contracts\/(?:warrants|combo|options))|\/order\/combotrades|\/stream\/(?:subscribe|unsubscribe)\/(?:calculated_index|index_components|scanner)|\/(?:conditional|agent)(?:\/|$)/;
let browser, page, childLogs = '', delayServerInfo = false;
await mkdir(artifacts, { recursive: true });

const rankRows = [
    ['2330', '台積電', 106, 6, 6000, 636_000_000, 'TSE'],
    ['2454', '聯發科', 184, -16, 8000, 1_472_000_000, 'TSE'],
    ['2303', '聯電', 50.5, .5, 12000, 606_000_000, 'TSE'],
    ['1802', '台玻', 20.1, .1, 500, 10_050_000, 'TSE'],
    ['3081', '聯亞', 110, 10, 7000, 770_000_000, 'OTC'],
    ['6153', '嘉聯益', 95, -5, 9000, 855_000_000, 'OTC'],
].map(([symbol, name, close, change, tradeVolume, tradeValue, market]) => ({
    symbol, name, market, lastPrice: close, closePrice: close, openPrice: close - change,
    highPrice: close + 2, lowPrice: close - 2, change,
    changePercent: change / (close - change) * 100, tradeVolume, tradeValue,
}));
const stocks = rankRows.map(row => ({ symbol: row.symbol, name: row.name, market: row.market,
    referencePrice: row.closePrice - row.change, limitUpPrice: (row.closePrice - row.change) * 1.1,
    limitDownPrice: (row.closePrice - row.change) * .9, canDayTrade: true }));
// Dates are relative so reruns do not silently discard an expired fixture.
const taipeiToday = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
const futureDay = days => new Date(Date.parse(taipeiToday + 'T00:00:00Z') + days * 86400_000).toISOString().slice(0, 10);
function monthlyExpiry(offset) {
    const current = new Date(taipeiToday + 'T00:00:00Z');
    const first = new Date(Date.UTC(current.getUTCFullYear(), current.getUTCMonth() + offset, 1));
    first.setUTCDate(15 + (3 - first.getUTCDay() + 7) % 7);
    return first.toISOString().slice(0, 10);
}
const weekday = new Date(taipeiToday + 'T00:00:00Z').getUTCDay();
const expiries = [{ root: 'TX1', date: futureDay(7 + (3 - weekday + 7) % 7), weekly: true },
    { root: 'TXO', date: monthlyExpiry(1), weekly: false }, { root: 'TXO', date: monthlyExpiry(2), weekly: false }];
const strikes = Array.from({ length: 12 }, (_, index) => 39800 + index * 100);
const optionProducts = ['TXO', 'TX1'].map(symbol => ({ symbol, type: 'OPTION',
    name: symbol === 'TXO' ? '臺指選擇權' : '臺指選擇權週三', contractType: 'I', contractSize: 50,
    tradingCurrency: 'TWD', underlyingSymbol: 'IX0001', statusCode: 'N', expiryType: symbol === 'TXO' ? 'S' : 'W' }));
const optionTickers = expiries.flatMap(expiry => strikes.flatMap((strike, index) => ['C', 'P'].map(right => {
    const month = Number(expiry.date.slice(5, 7)) - 1;
    const letter = String.fromCharCode((right === 'C' ? 65 : 77) + month);
    return { symbol: `${expiry.root}${strike}${letter}${expiry.date.slice(3, 4)}`, type: 'OPTION',
        name: `臺指選擇權QA;${strike}${right === 'C' ? '買權' : '賣權'}`,
        settlementDate: expiry.date, endDate: expiry.date, referencePrice: 100 + index * 3,
        limitUpPrice: 1000, limitDownPrice: .1 };
})));
const stockLevels = Array.from({ length: 80 }, (_, i) => ({ price: 100 + i * .5, volume: 11 + i,
    volumeAtAsk: Math.floor((11 + i) * .6), volumeAtBid: Math.floor((11 + i) * .25) }));
const futureLevels = Array.from({ length: 80 }, (_, i) => ({ price: 40000 + i, volume: i + 1 }));
const fixture = { provenance: 'Synthetic native-shaped QA market, informed by public 2026-11-17 probe; no account data',
    stocks, rankRows, optionProducts, optionTickers, stockLevels, futureLevels, expiries };

function run(command, args, extra = {}) {
    const env = Object.fromEntries(['PATH', 'TMPDIR', 'TMP', 'TEMP', 'LANG'].filter(key => process.env[key]).map(key => [key, process.env[key]]));
    const child = spawn(command, args, { cwd: temporary, detached: true, env: { ...env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { childLogs = (childLogs + chunk).slice(-40000); });
    children.push(child);
}
async function free(port) {
    await new Promise((resolve, reject) => { const probe = net.createServer(); probe.once('error', reject);
        probe.listen(port, '127.0.0.1', () => probe.close(resolve)); });
}
async function ready(url) {
    await expect.poll(async () => { try { return (await fetch(url)).status; } catch { return 0; } }, { timeout: 30000 }).toBe(200);
}
async function qa() { return page.evaluate(async () => (await fetch('/api/v1/qa/panel-apis')).json()); }
async function workspace() { return page.evaluate(async () => (await import('/src/lib/workspace.ts')).loadWorkspace()); }
const panel = id => page.locator(`[data-block-id="${id}"]`);
const header = id => panel(id).locator('[data-slot="card-header"]').first();
async function frame() { await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); }
async function exposeApi() { await page.evaluate(async () => { window.qaPanels = { api: await import('/src/lib/shioaji.ts') }; }); }
async function addPanel(label, type) {
    const before = (await workspace()).blocks.map(block => block.id);
    await page.getByRole('button', { name: /新增面板/ }).click();
    const library = page.getByRole('dialog', { name: '新增面板', exact: true });
    await library.getByPlaceholder('搜尋面板（名稱或用途）', { exact: true }).fill(label);
    await library.getByRole('button', { name: new RegExp('^' + label) }).click();
    await expect(library).toBeHidden();
    await expect.poll(async () => (await workspace()).blocks.length).toBe(before.length + 1);
    const added = (await workspace()).blocks.find(block => !before.includes(block.id));
    expect(added.type).toBe(type); await panel(added.id).scrollIntoViewIfNeeded(); return added.id;
}
async function selectGlobal(query, code) {
    await page.getByRole('button', { name: /^搜尋商品(?:\s|$)/ }).click();
    const dialog = page.getByRole('dialog', { name: '搜尋商品與面板', exact: true });
    await dialog.getByRole('combobox').fill(query);
    const option = dialog.getByRole('option').filter({ hasText: new RegExp('^' + code) });
    await expect(option).toBeVisible({ timeout: 20000 }); await option.click(); await expect(dialog).toBeHidden();
    await expect(header('chart-0')).toContainText(code);
}
async function noWatchlistChange(before, writeCount) {
    await frame(); expect(await page.evaluate(() => window.qaPanels.api.fetchWatchlists())).toEqual(before);
    expect(watchlistMutations.length).toBe(writeCount); expect(mutations).toEqual([]);
}
async function scannerChecks() {
    const id = await addPanel('排行榜', 'movers'), scope = panel(id);
    const before = await page.evaluate(() => window.qaPanels.api.fetchWatchlists()), writes = watchlistMutations.length;
    const modes = [
        ['漲幅', ['3081', '2330', '2303', '1802', '6153', '2454']],
        ['跌幅', ['2454', '6153', '1802', '2303', '2330', '3081']],
        ['量', ['2303', '6153', '2454', '3081', '2330', '1802']],
        ['額', ['2454', '6153', '3081', '2330', '2303', '1802']],
        ['複選', ['3081', '2330']],
    ];
    const codeClass = await page.evaluate(async () => (await import('/src/components/scanner-panel.css.ts')).scCode);
    const rowCodes = () => scope.locator('.' + codeClass).allTextContents();
    for (const [mode, codes] of modes) {
        await scope.getByRole('button', { name: mode, exact: true }).click();
        await expect.poll(rowCodes, { timeout: 20000, message: 'Rendered ' + mode + ' ranking' }).toEqual(codes);
        expect(await scope.innerText()).not.toContain('排行資料無法取得');
        await scope.getByText(codes[0], { exact: true }).click();
        await expect(header('chart-0')).toContainText(codes[0]); await noWatchlistChange(before, writes);
        await scope.screenshot({ path: path.join(artifacts, `scanner-${mode}.png`), animations: 'disabled' });
        results.push({ check: 'scanner-native-two-markets-ui-mode-pick-no-watchlist', mode, codes });
    }
    await scope.getByRole('button', { name: '放空', exact: true }).click();
    await expect.poll(rowCodes).toEqual(['2454', '6153']);
    await scope.getByRole('button', { name: '做多', exact: true }).click();
    await expect.poll(rowCodes).toEqual(['3081', '2330']);
    await scope.getByLabel('量≥千張', { exact: true }).fill('6.5');
    await expect.poll(rowCodes).toEqual(['3081']);
    await scope.getByLabel('量≥千張', { exact: true }).fill('5');
    await expect.poll(rowCodes).toEqual(['3081', '2330']); await noWatchlistChange(before, writes);
    results.push({ check: 'scanner-multiselect-long-short-and-volume-threshold', long: ['3081', '2330'], short: ['2454', '6153'] });
    const response = await page.evaluate(async date => {
        const r = await fetch('/api/v1/data/scanner', { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ scanner_type: 'VolumeRank', date, count: 20, ascending: true }) });
        return { status: r.status, body: await r.json() };
    }, '2020-01-01');
    expect(response.status).toBe(400);
    const rows = await page.evaluate(() => window.qaPanels.api.fetchScanner('VolumeRank', 20, true));
    expect(rows.map(row => row.code)).not.toContain('6666');
    for (const row of rows) for (const key of ['volume_ratio', 'yesterday_volume', 'tick_type', 'buy_price', 'sell_price']) expect(row[key], key).toBeNull();
    results.push({ check: 'scanner-incomplete-not-zero-filled-history-explicit-error', response });
    return id;
}
async function volumeChecks() {
    const before = await page.evaluate(() => window.qaPanels.api.fetchWatchlists()), writes = watchlistMutations.length;
    await selectGlobal('2330', '2330');
    const id = await addPanel('分價量表', 'volprofile'), scope = panel(id);
    async function bars() {
        return scope.evaluate(async node => {
            const styles = await import('/src/components/vol-profile.css.ts');
            return [...node.querySelectorAll('.' + CSS.escape(styles.row))].map(row => ({
                text: row.textContent,
                bars: [...row.querySelector('.' + CSS.escape(styles.barTrack)).children].map(bar => ({
                    percent: parseFloat(bar.style.width), width: bar.getBoundingClientRect().width,
                })),
            }));
        });
    }
    await expect(scope.getByText(/未分類/)).toBeVisible({ timeout: 20000 });
    await expect.poll(async () => (await bars()).length).toBe(80);
    const stock = await page.evaluate(() => window.qaPanels.api.fetchVolumeProfile({ code: '2330', security_type: 'STK', region: 'TW', exchange: 'TSE' }));
    expect(stock).toMatchObject({ code: '2330', date: taipeiToday, source: 'fubon', session: 'regular' });
    expect(stock.levels).toEqual([...stockLevels].reverse().map(row => ({ price: row.price, volume: row.volume,
        buy_volume: row.volumeAtAsk, sell_volume: row.volumeAtBid })));
    const stockBars = await bars();
    expect(stockBars[0].bars[2].percent).toBeGreaterThan(0);
    expect(stockBars[0].bars[0].percent).not.toBe(stockBars[0].bars[1].percent);
    await scope.screenshot({ path: path.join(artifacts, 'volume-stock-unknown.png'), animations: 'disabled' });
    results.push({ check: 'stock-native-complete-80-levels-unclassified-preserved', profile: stock, displayed: stockBars });
    await selectGlobal('TXF', 'TXFK6'); await scope.scrollIntoViewIfNeeded();
    await expect(scope.getByText('來源未提供內外盤分類，僅顯示真實總量', { exact: true })).toBeVisible({ timeout: 20000 });
    const future = await page.evaluate(() => window.qaPanels.api.fetchVolumeProfile({ code: 'TXFK6', security_type: 'FUT', region: 'TW', exchange: 'TAIFEX' }));
    expect(future.levels).toEqual([...futureLevels].reverse().map(row => ({ ...row, buy_volume: null, sell_volume: null })));
    const futureBars = await bars(); expect(futureBars.length).toBe(80);
    for (const row of futureBars) { expect(row.bars[0].percent).toBe(0); expect(row.bars[1].percent).toBe(0); expect(row.bars[2].percent).toBeGreaterThan(0); }
    expect(await scope.innerText()).not.toMatch(/外盤\s*50|內盤\s*50/);
    await scope.screenshot({ path: path.join(artifacts, 'volume-futures-total-only.png'), animations: 'disabled' });
    await noWatchlistChange(before, writes);
    results.push({ check: 'future-native-complete-80-levels-null-sides-never-half-split', profile: future, displayed: futureBars });
    return id;
}
async function optionChecks() {
    const before = await page.evaluate(() => window.qaPanels.api.fetchWatchlists()), writes = watchlistMutations.length;
    for (const expiry of expiries) {
        const rows = await page.evaluate(root => window.qaPanels.api.fetchOptions(root), expiry.root);
        const selected = rows.filter(row => row.delivery_date === expiry.date);
        for (const right of ['C', 'P']) expect(new Set(selected.filter(row => row.option_right === right).map(row => row.strike_price)).size).toBe(12);
        for (const row of selected) expect(row).toMatchObject({ root: expiry.root, security_type: 'OPT', underlying_code: 'IX0001', multiplier: 50, currency: 'TWD' });
        results.push({ check: 'option-rest-metadata-12-strikes-per-side', expiry, contracts: selected.length });
    }
    const filtered = await page.evaluate(({ root, date, min, max }) => window.qaPanels.api.fetchOptions(root, {
        deliveryMonth: date.slice(0, 7).replace('-', ''), optionRight: 'C', strikeMin: min, strikeMax: max,
    }), { ...expiries[1], min: strikes[3], max: strikes[7] });
    expect(filtered).toHaveLength(5); expect(filtered.every(row => row.option_right === 'C' && row.strike_price >= strikes[3] && row.strike_price <= strikes[7])).toBe(true);
    const selectedCall = optionTickers.find(contract => contract.settlementDate === expiries[2].date
        && contract.name.endsWith(`;${strikes[0]}買權`));
    expect(selectedCall).toBeDefined();
    const resolved = await page.evaluate(code => window.qaPanels.api.resolveContract(code), selectedCall.symbol);
    expect(resolved).toMatchObject({ code: selectedCall.symbol, security_type: 'OPT', strike_price: strikes[0] });
    await noWatchlistChange(before, writes);
    results.push({ check: 'option-rest-filters-and-untyped-resolution', filteredCodes: filtered.map(row => row.code), resolved });
}
async function unavailablePanelChecks() {
    const original = await workspace();
    const metadata = await page.evaluate(async types => {
        const { BLOCK_META } = await import('/src/lib/workspace.ts');
        return types.map(type => ({ type, label: BLOCK_META[type].label }));
    }, unavailableTypes);
    const requestStart = apiRequests.length;
    for (const { type, label } of metadata) {
        await page.getByRole('button', { name: /新增面板/ }).click();
        const library = page.getByRole('dialog', { name: '新增面板', exact: true });
        const input = library.getByPlaceholder('搜尋面板（名稱或用途）', { exact: true });
        await input.fill(type);
        const card = library.locator('button[data-idx]').filter({ hasText: label }).first();
        await expect(card).toBeVisible(); await expect(card).toBeDisabled();
        await expect(card).toContainText('未支援'); await expect(card).toHaveAttribute('title', /^未支援：/);
        const geometry = await card.boundingBox();
        await page.mouse.move(geometry.x + geometry.width / 2, geometry.y + geometry.height / 2);
        await page.mouse.click(geometry.x + geometry.width / 2, geometry.y + geometry.height / 2);
        await frame(); expect(await workspace()).toEqual(original); await expect(library).toBeVisible();
        await input.press('Enter'); await frame(); expect(await workspace()).toEqual(original); await expect(library).toBeVisible();
        await input.press('Shift+Enter'); await frame(); expect(await workspace()).toEqual(original); await expect(library).toBeVisible();
        // A schematic is allowed; the actual unsupported component must never
        // be offered as a live preview or mounted after keyboard activation.
        await expect(library.getByRole('button', { name: '即時預覽', exact: true })).toHaveCount(0);
        const liveClass = await page.evaluate(async () => (await import('/src/components/panel-library.css.ts')).livePreviewCanvas);
        await expect(library.locator('.' + liveClass)).toHaveCount(0);
        if (type === 'chips' || type === 'pulse') await library.screenshot({ path: path.join(artifacts, `disabled-library-${type}.png`), animations: 'disabled' });
        await input.press('Escape'); await expect(library).toBeHidden();
        results.push({ check: 'unavailable-library-card-blocks-mouse-enter-shift-enter-no-live-preview', type, label });
    }
    expect(apiRequests.slice(requestStart).filter(row => unavailableRoutes.test(row.path))).toEqual([]);
    // Simulate a previously saved workspace in this temporary browser only.
    // Keep the unsupported blocks present: the app must render its gate before
    // mounting each body, rather than silently losing the user's saved layout.
    await page.evaluate(async types => {
        const { saveWorkspace, GRID_COLS } = await import('/src/lib/workspace.ts');
        saveWorkspace({ blocks: types.map(type => ({ id: 'qa-unavailable-' + type, type, pin: '2330' })),
            layout: types.map((type, index) => ({ i: 'qa-unavailable-' + type, x: 0, y: index * 7, w: GRID_COLS, h: 7 })) });
    }, unavailableTypes);
    const restoreStart = apiRequests.length;
    // Force the previously confirmed startup race instead of depending on the
    // relative speed of the bundle and localhost /info response.
    delayServerInfo = true;
    await page.reload();
    await expect(page.getByRole('button', { name: '交易模式設定', exact: true })).toBeVisible({ timeout: 30000 });
    await exposeApi();
    for (const { type } of metadata) {
        const scope = panel('qa-unavailable-' + type); await scope.scrollIntoViewIfNeeded();
        await expect(scope.locator(`[data-panel-unavailable="${type}"]`)).toContainText('未支援：');
    }
    await frame();
    expect((await workspace()).blocks.map(block => block.type)).toEqual(unavailableTypes);
    const restoredRequests = apiRequests.slice(restoreStart);
    delayServerInfo = false;
    expect(restoredRequests.filter(row => unavailableRoutes.test(row.path))).toEqual([]);
    expect(restoredRequests.filter(row => row.path === '/api/v1/stream/subscribe' && row.body?.intraday_odd)).toEqual([]);
    expect(restoredRequests.filter(row => row.path === '/api/v1/stream/subscribe' && row.body?.security_type === 'OPT')).toEqual([]);
    await panel('qa-unavailable-chips').screenshot({ path: path.join(artifacts, 'disabled-restored-placeholder.png'), animations: 'disabled' });
    results.push({ check: 'restored-unavailable-panels-preserved-gated-no-unsupported-api', types: unavailableTypes, requests: restoredRequests });
    await page.evaluate(async saved => (await import('/src/lib/workspace.ts')).saveWorkspace(saved), original);
    await page.reload();
    await expect(page.getByRole('button', { name: '交易模式設定', exact: true })).toBeVisible({ timeout: 30000 });
    await exposeApi();
}
async function newFunctionPanelChecks() {
    const metadata = await page.evaluate(async types => {
        const { BLOCK_META } = await import('/src/lib/workspace.ts');
        return types.map(type => ({ type, label: BLOCK_META[type].label }));
    }, newPanelTypes);
    const ids = [];
    for (const { type, label } of metadata) {
        const id = await addPanel(label, type); ids.push(id);
        await expect(panel(id).locator(`[data-api-panel="${type}"]`)).toBeVisible();
    }
    // Retain only the new panels in the temporary workspace so the supported
    // scanner/profile refresh timers cannot be mistaken for a form request.
    await page.evaluate(async ids => {
        const { loadWorkspace, saveWorkspace } = await import('/src/lib/workspace.ts');
        const saved = loadWorkspace(), keep = new Set(ids);
        saveWorkspace({ ...saved, blocks: saved.blocks.filter(block => keep.has(block.id)), layout: saved.layout.filter(item => keep.has(item.i)) });
    }, ids);
    await page.reload(); await expect(panel(ids[0]).locator('[data-api-panel]')).toBeVisible({ timeout: 30000 }); await exposeApi();
    expect((await workspace()).blocks.map(block => block.id)).toEqual(ids);
    // A quiet interval excludes initial global quote/account bootstrap. The
    // app's later /info and Paper bookkeeping reads are recorded separately.
    let last = apiRequests.length, since = Date.now();
    await expect.poll(() => { if (apiRequests.length !== last) { last = apiRequests.length; since = Date.now(); }
        return Date.now() - since; }, { timeout: 10000 }).toBeGreaterThanOrEqual(500);
    const start = apiRequests.length;
    const editField = async field => {
        const tag = await field.evaluate(node => node.tagName);
        if (tag === 'SELECT') {
            const options = await field.locator('option').allTextContents();
            await field.selectOption({ label: options.at(-1) }); await expect(field).toHaveValue(options.at(-1));
        } else {
            const type = await field.getAttribute('type');
            const value = type === 'date' ? taipeiToday : type === 'number' ? '123.5' : '2330';
            await field.fill(value); await expect(field).toHaveValue(value);
        }
    };
    for (const viewport of [{ width: 1600, height: 1100 }, { width: 390, height: 844 }]) {
        await page.setViewportSize(viewport);
        for (let index = 0; index < metadata.length; index++) {
            const { type, label } = metadata[index], scope = panel(ids[index]).locator(`[data-api-panel="${type}"]`);
            await scope.scrollIntoViewIfNeeded(); await expect(scope.getByRole('status')).toContainText('API 尚未接通');
            await expect.poll(() => scope.evaluate(node => getComputedStyle(node).display), { message: 'Native panel stylesheet applied' }).toBe('flex');
            const nav = scope.getByRole('navigation', { name: label + '功能', exact: true });
            const tabs = await nav.getByRole('button').allTextContents();
            if (viewport.width === 1600) for (const field of await scope.locator('input').all()) await expect(field).toHaveValue('');
            for (const tab of tabs) {
                const button = nav.getByRole('button', { name: tab, exact: true }); await button.click(); await expect(button).toHaveAttribute('aria-pressed', 'true');
                const fields = scope.locator('input, select');
                for (const field of await fields.all()) await editField(field);
                await expect(scope.getByRole('table')).toContainText('資料尚未接入');
                const remote = scope.getByTitle('API 尚未接通', { exact: true }); await expect(remote).toBeDisabled();
                await remote.scrollIntoViewIfNeeded();
                const box = await remote.boundingBox(); await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
                const values = await scope.locator('[aria-label$="尚未取得"]').allTextContents(); expect(values.every(value => value === '—')).toBe(true);
            }
            // Exercise local draft behavior independently of the remote forms.
            if (type === 'fuboncondition') {
                await nav.getByRole('button', { name: '單一／多條件', exact: true }).click();
                const draft = scope.getByRole('region', { name: '觸發條件草稿', exact: true });
                await expect(draft.getByRole('button', { name: '刪除條件 1', exact: true })).toBeDisabled();
                await draft.getByRole('button', { name: '新增條件', exact: true }).click();
                await expect(draft.getByRole('button', { name: /^刪除條件/ })).toHaveCount(2);
                await draft.getByLabel('門檻', { exact: true }).nth(1).fill('99');
                await draft.getByRole('button', { name: '刪除條件 1', exact: true }).click();
                await expect(draft.getByLabel('門檻', { exact: true })).toHaveValue('99');
                await expect(draft.getByRole('button', { name: '刪除條件 1', exact: true })).toBeDisabled();
            }
            if (type === 'fuboncorporate') {
                const calendar = scope.getByRole('region', { name: '股務月份行事曆', exact: true });
                const calendarStyle = await calendar.evaluate(node => {
                    const grid = [...node.children].find(child => getComputedStyle(child).display === 'grid');
                    return grid ? getComputedStyle(grid).gridTemplateColumns.split(' ').length : 0;
                });
                expect(calendarStyle).toBe(7);
                const before = await calendar.locator('strong').innerText();
                await calendar.getByRole('button', { name: '下個月', exact: true }).click();
                expect(await calendar.locator('strong').innerText()).not.toBe(before);
                await calendar.getByRole('button', { name: '上個月', exact: true }).click(); await expect(calendar.locator('strong')).toHaveText(before);
            }
            const geometry = await scope.evaluate(node => ({ width: node.clientWidth, scrollWidth: node.scrollWidth,
                fields: [...node.querySelectorAll('input,select')].map(field => ({ width: field.getBoundingClientRect().width, right: field.getBoundingClientRect().right - node.getBoundingClientRect().left })) }));
            expect(geometry.scrollWidth, type + ' panel overflow at ' + viewport.width).toBeLessThanOrEqual(geometry.width + 1);
            expect(geometry.fields.every(field => field.width > 0 && field.right <= geometry.width + 1)).toBe(true);
            await scope.screenshot({ path: path.join(artifacts, `function-${type}-${viewport.width}.png`), animations: 'disabled' });
            results.push({ check: 'native-function-panel-add-persist-edit-local-tabs-disabled-remote', type, viewport, tabs, geometry });
        }
    }
    const observed = apiRequests.slice(start);
    const panelRequests = observed.filter(row => row.path.startsWith('/api/v1/data/') || row.path.startsWith('/api/v1/stream/subscribe') || row.path.startsWith('/api/v1/automation/'));
    expect(panelRequests).toEqual([]); expect(mutations).toEqual([]); expect(watchlistMutations).toEqual([]);
    results.push({ check: 'nine-native-function-panels-no-data-subscribe-submit-requests', types: newPanelTypes, requests: observed });
    await page.setViewportSize({ width: 1600, height: 1100 });
}
async function connectedAuditChecks() {
    const id = await addPanel('診斷 Debug', 'debug'), scope = panel(id);
    await expect(scope.getByRole('status').filter({ hasText: '券商配額與伺服器監控明細尚未轉接' })).toHaveAttribute('aria-disabled', 'true');
    await expect(scope.getByRole('button', { name: '暫停監控', exact: true })).toHaveCount(0);
    await expect(scope).toContainText('SSE');
    await scope.screenshot({ path: path.join(artifacts, 'debug-fubon-monitor-disabled.png'), animations: 'disabled' });
    results.push({ check: 'actual-debug-panel-local-diagnostics-monitor-disabled' });
    // The client must also avoid the optional 501 source before the first
    // /info has populated its cache, not merely after the app is warm.
    const coldNames = await page.evaluate(async () => {
        const store = await import('/src/lib/server-info-store.ts'), runtime = await import('/src/lib/runtime.ts');
        store.forgetServerInfo(runtime.getApiBase());
        return window.qaPanels.api.fetchWarrantUnderlyings();
    });
    expect(coldNames).toEqual([]);
    await expect(scope.getByRole('status').filter({ hasText: '券商配額與伺服器監控明細尚未轉接' })).toBeVisible();
    results.push({ check: 'cold-optional-stock-name-source-loads-info-without-unsupported-route' });
    for (const [query, code] of [['2330', '2330'], ['2454', '2454'], ['聯發科', '2454'], ['2330', '2330']]) {
        await page.getByRole('button', { name: /^搜尋商品(?:\s|$)/ }).click();
        const dialog = page.getByRole('dialog', { name: '搜尋商品與面板', exact: true }), input = dialog.getByRole('combobox');
        await input.fill(query);
        await expect(dialog.getByRole('option').filter({ hasText: new RegExp('^' + code) })).toBeVisible({ timeout: 20000 });
        await expect(dialog.getByText('↑↓ / Ctrl+N、P 選擇 · Enter 切換 · Esc 關閉', { exact: true })).toBeVisible({ timeout: 20000 });
        const rows = await dialog.getByRole('option').allTextContents();
        await input.press('Escape'); await expect(dialog).toBeHidden();
        results.push({ check: 'actual-palette-repeated-catalog-search-completes', query, code, rows });
    }
    const forbidden = apiRequests.filter(row => row.path === '/api/v1/auth/usage' || row.path.startsWith('/api/v1/monitor/')
        || row.path.startsWith('/api/v1/data/contracts/warrants'));
    expect(forbidden).toEqual([]);
    results.push({ check: 'zero-monitor-and-warrant-search-generic-501-requests-entire-run' });
}

try {
    await free(uiPort); await free(apiPort);
    const futures = JSON.parse(await readFile(path.join(root, 'server/tests/fixtures/future-search-2026-11-17.json'), 'utf8'));
    await writeFile(path.join(temporary, 'market.json'), JSON.stringify({ ...fixture, futures }));
    const backend = path.join(temporary, 'backend.py');
    await writeFile(backend, `import json,os,socket,sys,threading
from pathlib import Path
from copy import deepcopy
from types import SimpleNamespace,ModuleType
import fubon_bridge.__main__ as entry
from fubon_bridge.app import create_app as real_create_app
from fubon_bridge.config import Config
from fubon_bridge.keychain import Keychain
from fubon_bridge.passkeys import PasskeyStore
from fubon_bridge.research import ResearchStore
from fubon_bridge.mapping import now
root=Path(os.environ['PANEL_TEMP']);(root/'server').mkdir()
fixture=json.loads((root/'market.json').read_text());requests=[];lock=threading.RLock()
counts=dict(sdkCalls=0,sdkTransactions=0,keychainCalls=0,outboundCalls=0,products=0,tickers=0,ticker=0,quote=0,volumes=0,rank=0,websocket=0)
def count(key,kwargs=None):
    with lock:
        counts[key]+=1
        if kwargs is not None:requests.append(dict(method=key,params=deepcopy(kwargs)))
def no_sdk(*a,**kw):count('sdkCalls');raise AssertionError('QA forbids SDK construction')
def no_keychain(*a,**kw):count('keychainCalls');raise AssertionError('QA forbids Keychain')
def no_outbound(*a,**kw):count('outboundCalls');raise AssertionError('QA forbids outbound sockets')
Keychain.read=no_keychain;socket.socket.connect=no_outbound;socket.socket.connect_ex=no_outbound
sdk_module=ModuleType('fubon_neo.sdk');sdk_module.FubonSDK=no_sdk;sys.modules['fubon_neo.sdk']=sdk_module
class Market:
    def __init__(self,stock=False):self.stock=stock;self.intraday=self;self.historical=self;self.snapshot=self
    def products(self,**kw):
        count('products',kw)
        return dict(data=deepcopy(fixture['optionProducts'] if kw.get('type')=='OPTION' else fixture['futures']['products']))
    def tickers(self,**kw):
        count('tickers',kw)
        rows=([r for r in fixture['stocks'] if r['market']==kw.get('market')] if self.stock else
              [r for r in fixture['optionTickers'] if r['symbol'].startswith(kw.get('product',''))] if kw.get('type')=='OPTION' else fixture['futures']['tickers'])
        return dict(date=now().date().isoformat(),data=deepcopy(rows))
    def ticker(self,symbol,**kw):
        count('ticker',dict(symbol=symbol,**kw));rows=fixture['stocks'] if self.stock else fixture['futures']['tickers']+fixture['optionTickers']
        match=next((r for r in rows if r['symbol']==symbol),None)
        if match is None and symbol.endswith('!'):match=next((r for r in rows if r['symbol'].startswith(symbol[:-2])),None)
        if match is None and symbol=='IX0001':match=dict(symbol=symbol,name='加權指數QA',referencePrice=40000)
        if match is None:raise ValueError('Unknown QA symbol '+symbol)
        return deepcopy(match)
    def quote(self,symbol,**kw):
        count('quote',dict(symbol=symbol,**kw));r=self.ticker(symbol);p=r['referencePrice'];at=int(now().timestamp()*1e6)
        return dict(symbol=r['symbol'],exchange='TWSE' if self.stock else 'TAIFEX',previousClose=p,lastUpdated=at,
                    lastTrade=dict(time=at,price=p,bid=p-1,ask=p+1,size=2),lastPrice=p,openPrice=p,highPrice=p+2,lowPrice=p-2,
                    total=dict(tradeVolume=321,tradeValue=p*321),change=0,changePercent=0)
    def volumes(self,symbol,**kw):
        count('volumes',dict(symbol=symbol,**kw))
        return dict(date=now().date().isoformat(),symbol=symbol,data=deepcopy(fixture['stockLevels'] if self.stock else fixture['futureLevels']))
    def rank(self,method,**kw):
        count('rank',dict(endpoint=method,**kw));rows=[r for r in fixture['rankRows'] if r['market']==kw['market']]
        return dict(date=now().date().isoformat(),data=deepcopy(rows)+[dict(symbol='6666',name='Incomplete QA row')])
    def movers(self,**kw):return self.rank('movers',**kw)
    def actives(self,**kw):return self.rank('actives',**kw)
    def quotes(self,**kw):return self.rank('quotes',**kw)
    def candles(self,**kw):return dict(data=[])
    def trades(self,**kw):return dict(date=now().date().isoformat(),data=[])
    def __getattr__(self,key):count('sdkTransactions');raise AssertionError('Unsupported fixture market method '+key)
class Socket:
    def on(self,*a):pass
    def connect(self):count('websocket')
    def subscribe(self,*a):pass
    def disconnect(self):pass
class LocalSDK:
    def __init__(self):self.marketdata=SimpleNamespace(rest_client=SimpleNamespace(stock=Market(True),futopt=Market()),websocket_client=SimpleNamespace(stock=Socket(),futopt=Socket()))
    def shutdown(self):pass
    def __getattr__(self,key):count('sdkTransactions');raise AssertionError('QA forbids trading/account access '+key)
class NoCredentials:
    def available(self):return False
entry.ROOT=root
Config.from_env=classmethod(lambda cls:Config(mode='paper',port=int(os.environ['PANEL_API_PORT'])))
def create_app(config,**kwargs):
    kwargs['launch_token']=os.environ['PANEL_LAUNCH']
    app=real_create_app(config,sdk_factory=no_sdk,passkey_store=PasskeyStore(root/'passkeys.sqlite3'),research_store=ResearchStore(root/'research.sqlite3'),credential_store=NoCredentials(),**kwargs)
    broker=app.state.broker
    def connect():broker.sdk=LocalSDK();broker.error=None
    broker.connect=connect
    @app.get('/api/v1/qa/panel-apis')
    def qa():return dict(counts=deepcopy(counts),marketRequests=deepcopy(requests),ledger=broker.paper.overview())
    app.router.routes.insert(0,app.router.routes.pop());return app
entry.create_app=create_app;sys.argv=['fixture','--ui-url',os.environ['PANEL_ORIGIN'],'--no-browser'];entry.main()
`);
    const viteFile = path.join(temporary, 'vite.mjs');
    await writeFile(viteFile, `import{createServer,loadConfigFromFile}from ${JSON.stringify(path.join(root, 'node_modules/vite/dist/node/index.js'))};
globalThis.fetch=async()=>{throw new Error('QA forbids metadata upstream');};
const loaded=await loadConfigFromFile({command:'serve',mode:'development'},${JSON.stringify(path.join(root, 'vite.config.ts'))},process.cwd());
process.chdir(${JSON.stringify(root)});
const server=await createServer({...loaded.config,configFile:false,root:${JSON.stringify(root)},envDir:${JSON.stringify(temporary)},cacheDir:${JSON.stringify(path.join(temporary, 'vite-cache'))},server:{...loaded.config.server,host:'127.0.0.1',port:${uiPort},strictPort:true,fs:{...loaded.config.server.fs,allow:[...loaded.config.server.fs.allow,${JSON.stringify(root)},${JSON.stringify(await realpath(path.join(root, 'node_modules')))}]}}});await server.listen();`);
    run(path.join(root, 'server/.venv/bin/python'), [backend], { PYTHONPATH: path.join(root, 'server'), PANEL_TEMP: temporary, PANEL_API_PORT: String(apiPort), PANEL_ORIGIN: origin, PANEL_LAUNCH: launch });
    run(process.execPath, [viteFile], { VITE_API_TARGET: `http://127.0.0.1:${apiPort}`, VITE_API_BASE: '', VITE_STREAM_BASE: origin, VITE_DEV_SERVER_PORT: '' });
    await ready(`http://127.0.0.1:${apiPort}/api/v1/passkeys/status`); await ready(origin);
    browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true });
    const context = await browser.newContext({ viewport: { width: 1600, height: 1100 } });
    await context.route('**/*', async route => {
        const request = route.request(), url = new URL(request.url());
        if (url.origin === origin && /^\/api\/v1\/(order\/(place|cancel|update|reserve)|automation\/start)/.test(url.pathname)) {
            mutations.push({ method: request.method(), path: url.pathname }); return route.abort('blockedbyclient');
        }
        if (url.origin === origin && url.pathname.startsWith('/metadata/')) {
            const payload = /(?:tse|otc)-companies$/.test(url.pathname) ? stocks.map(row => ({ 公司代號: row.symbol, 公司簡稱: row.name, 公司名稱: row.name + 'QA股份有限公司', 出表日期: '1151117' })) : [];
            return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(payload) });
        }
        if (url.origin === origin && url.pathname === '/api/v1/info' && delayServerInfo) await new Promise(resolve => setTimeout(resolve, 500));
        if (url.origin === origin) return route.continue();
        blocked.push(url.origin + url.pathname); return route.abort('blockedbyclient');
    });
    page = await context.newPage(); page.on('pageerror', error => pageErrors.push(error.message));
    page.on('request', request => { const url = new URL(request.url());
        if (url.pathname.startsWith('/api/v1/')) {
            let body = null; try { body = request.postDataJSON(); } catch { /* non-JSON request */ }
            apiRequests.push({ method: request.method(), path: url.pathname, query: url.search, body });
        }
        if (url.pathname.startsWith('/api/v1/watchlist') && ['POST', 'PUT', 'DELETE'].includes(request.method())) watchlistMutations.push({ method: request.method(), path: url.pathname });
    });
    page.on('response', response => { const url = new URL(response.url());
        if (url.pathname.startsWith('/src/') && response.status() >= 400) sourceErrors.push({ path: url.pathname, status: response.status() });
        if (/^\/api\/v1\/data\/(scanner|volumes|contracts\/options)/.test(url.pathname)) responses.push({ path: url.pathname + url.search, status: response.status() });
    });
    const cdp = await context.newCDPSession(page); await cdp.send('WebAuthn.enable');
    await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true,
        hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
    await page.goto(origin + '/#fubon-launch=' + launch);
    await page.getByRole('button', { name: '建立 Passkey 並解鎖', exact: true }).click();
    await expect(page.getByRole('button', { name: '交易模式設定', exact: true })).toBeVisible({ timeout: 30000 });
    await exposeApi();
    await expect(page.locator('[data-code="2330"]')).toBeVisible({ timeout: 20000 });
    const baseline = await qa(); expect(baseline.ledger.orders).toEqual([]); expect(baseline.ledger.positions).toEqual([]);
    await scannerChecks(); await volumeChecks(); await unavailablePanelChecks(); await optionChecks(); await newFunctionPanelChecks(); await connectedAuditChecks();
    const final = await qa(); expect(final.ledger.orders).toEqual([]); expect(final.ledger.positions).toEqual([]);
    for (const key of ['sdkCalls', 'sdkTransactions', 'keychainCalls', 'outboundCalls']) expect(final.counts[key], key).toBe(0);
    for (const key of ['rank', 'volumes', 'products', 'tickers']) expect(final.counts[key], key).toBeGreaterThan(0);
    const markets = new Set(final.marketRequests.filter(row => row.method === 'rank').map(row => row.params.market));
    expect([...markets].sort()).toEqual(['OTC', 'TSE']);
    expect(mutations).toEqual([]); expect(watchlistMutations).toEqual([]); expect(pageErrors).toEqual([]); expect(sourceErrors).toEqual([]);
    expect(blocked.filter(url => url !== 'https://fonts.googleapis.com/css2')).toEqual([]);
    await writeFile(path.join(artifacts, 'summary.json'), JSON.stringify({ passed: true, results, final, responses, apiRequests, sourceErrors, pageErrors, mutations, watchlistMutations, blocked, temporary, fixture }, null, 2));
    console.log(JSON.stringify({ passed: true, checks: results.length, counts: final.counts, artifacts, temporary }, null, 2));
} catch (error) {
    const diagnostic = await qa().catch(() => undefined);
    await writeFile(path.join(artifacts, 'failure.log'), childLogs);
    await writeFile(path.join(artifacts, 'summary.json'), JSON.stringify({ passed: false, error: String(error), diagnostic, results, responses, apiRequests, sourceErrors, pageErrors, mutations, watchlistMutations, blocked, temporary }, null, 2));
    await page?.screenshot({ path: path.join(artifacts, 'failure.png'), fullPage: true }).catch(() => undefined);
    console.error(JSON.stringify({ passed: false, artifacts, temporary })); throw error;
} finally {
    await browser?.close().catch(() => undefined);
    for (const child of children.reverse()) {
        if (child.exitCode !== null || child.signalCode) continue;
        const ended = new Promise(resolve => child.once('exit', resolve));
        try { process.kill(-child.pid, 'SIGTERM'); } catch { continue; }
        let timeout; await Promise.race([ended, new Promise(resolve => { timeout = setTimeout(resolve, 8000); })]); clearTimeout(timeout);
        if (child.exitCode === null && !child.signalCode) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already stopped */ } await ended; }
    }
}
