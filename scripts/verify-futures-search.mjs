// Actual app/Broker/search UI; only vendor market clients and public name feed
// are fixtures. No host credentials, brokerage connection, or order mutation.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';

const root = fileURLToPath(new URL('../', import.meta.url));
const uiPort = 6190, apiPort = 22990, origin = `http://localhost:${uiPort}`;
const temporary = await mkdtemp(path.join(tmpdir(), 'fubon-futures-search-'));
const artifacts = process.env.FUTURES_SEARCH_ARTIFACT_DIR || path.join(temporary, 'artifacts');
const launch = randomBytes(32).toString('base64url'), children = [], results = [], pageErrors = [], blocked = [], mutations = [], marketRequests = [], watchlistMutations = [];
// Accessible selectors confirmed with the product-navigation implementation.
const navigationUi = { button: '搜尋商品', dialog: '搜尋商品與面板', chart: 'chart-0', depth: 'depth-0' };
const stocks = [
    ['2330', '台積電', 2209], ['2454', '聯發科', 3745], ['2303', '聯電', 94.4], ['1802', '台玻', 55],
    ['2881', '富邦金', 80], ['0050', '元大台灣50', 50], ['6153', '嘉聯益', 40], ['3081', '聯亞', 100],
    ...Array.from({ length: 12 }, (_, i) => [String(6001 + i), `聯合QA${String(i + 1).padStart(2, '0')}`, 50 + i]),
].map(([symbol, name, price]) => ({ symbol, name, referencePrice: price, limitUpPrice: price * 1.1, limitDownPrice: price * .9, exchange: 'TWSE' }));
let browser, page, childLogs = '';
await mkdir(artifacts, { recursive: true });
function run(command, args, extra = {}) {
    const env = Object.fromEntries(['PATH', 'TMPDIR', 'TMP', 'TEMP', 'LANG'].filter(key => process.env[key]).map(key => [key, process.env[key]]));
    const child = spawn(command, args, { cwd: temporary, detached: true, env: { ...env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { childLogs = (childLogs + chunk).slice(-30000); });
    children.push(child);
}
async function free(port) { await new Promise((resolve, reject) => { const probe = net.createServer(); probe.once('error', reject); probe.listen(port, '127.0.0.1', () => probe.close(resolve)); }); }
async function ready(url) { await expect.poll(async () => { try { return (await fetch(url)).status; } catch { return 0; } }, { timeout: 30000 }).toBe(200); }
async function qa(body = {}) {
    return page.evaluate(async body => {
        const response = await fetch('/api/v1/qa/futures-search', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        if (!response.ok) throw new Error('QA status ' + response.status);
        return response.json();
    }, body);
}
const palette = () => page.getByRole('dialog', { name: navigationUi.dialog, exact: true });
const panelHeader = id => page.locator(`[data-block-id="${id}"]`).locator('[data-slot="card-header"]').first();
async function workspace() { return page.evaluate(async () => (await import('/src/lib/workspace.ts')).loadWorkspace()); }
async function watchlists() { return page.evaluate(() => window.qaSearch.api.fetchWatchlists()); }
async function stableFrame() { await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); }
async function unchangedWatchlists(before, writes) {
    await stableFrame(); expect(await watchlists()).toEqual(before); expect(watchlistMutations.length).toBe(writes);
}
async function controlledOptions(input) {
    await expect(input).toHaveAttribute('aria-controls', /.+/);
    const id = await input.getAttribute('aria-controls');
    return page.locator(`[id=${JSON.stringify(id)}]`).getByRole('option');
}
async function expectedOptions(input, codes) {
    const options = await controlledOptions(input);
    await expect.poll(async () => {
        const rows = await options.allTextContents();
        return codes.every(code => rows.some(row => row.startsWith(code)));
    }, { timeout: 20000, message: 'Expected navigation suggestions: ' + codes.join(', ') }).toBe(true);
    return options;
}
async function keyboardCycle(input, label) {
    const options = await controlledOptions(input);
    const ids = await options.evaluateAll(rows => rows.map(row => row.id));
    expect(ids.length).toBeGreaterThan(1);
    let index = ids.indexOf(await input.getAttribute('aria-activedescendant'));
    expect(index).toBeGreaterThanOrEqual(0);
    const start = index;
    for (const [key, step] of [['Control+n', 1], ['Control+p', -1]]) {
        for (let i = 0; i < ids.length; i++) {
            index = (index + step + ids.length) % ids.length; await input.press(key);
            await expect(input).toHaveAttribute('aria-activedescendant', ids[index]);
            await expect(page.locator(`[id=${JSON.stringify(ids[index])}]`)).toHaveAttribute('aria-selected', 'true');
        }
        expect(index).toBe(start);
    }
    await input.press('Control+n'); await input.press('Control+p');
    await expect(input).toHaveAttribute('aria-activedescendant', ids[start]);
    results.push({ check: 'ctrl-n-p-cycles-and-wraps', label, optionCount: ids.length, immediateNextPreviousReturns: true });
    // Exercise the real DOM handlers with IME-translated keys, including legacy
    // 229 outside composition; this is not a claim about a specific installed IME.
    for (const ime of [{ key: 'Process', keyCode: 229 }, { key: 'ㄙ', keyCode: 0 }]) {
        for (const [code, step] of [['KeyN', 1], ['KeyP', -1]]) {
            index = (index + step + ids.length) % ids.length;
            const prevented = await input.evaluate((element, init) => {
                const event = new KeyboardEvent('keydown', { ...init, ctrlKey: true, bubbles: true, cancelable: true });
                element.dispatchEvent(event);
                return event.defaultPrevented;
            }, { ...ime, code });
            expect(prevented, label + ' IME Ctrl+' + code).toBe(true);
            await expect(input).toHaveAttribute('aria-activedescendant', ids[index]);
            await expect(page.locator(`[id=${JSON.stringify(ids[index])}]`)).toHaveAttribute('aria-selected', 'true');
        }
    }
    const composingPrevented = await input.evaluate(element => {
        const event = new KeyboardEvent('keydown', { key: 'Process', code: 'KeyN', keyCode: 229,
            ctrlKey: true, isComposing: true, bubbles: true, cancelable: true });
        element.dispatchEvent(event);
        return event.defaultPrevented;
    });
    expect(composingPrevented, label + ' active IME composition stays native').toBe(false);
    await expect(input).toHaveAttribute('aria-activedescendant', ids[start]);
    results.push({ check: 'ime-ctrl-n-p-navigation-and-composition-guard', label, translatedKeyVariants: 2 });
}
async function resultColumns(options, label) {
    const rows = await options.evaluateAll(rows => rows.flatMap(row => {
        const badge = row.querySelector('[data-slot="badge"]'); if (!badge) return [];
        const meta = badge.parentElement, style = getComputedStyle(meta);
        const b = badge.getBoundingClientRect(), detail = badge.nextElementSibling, d = detail?.getBoundingClientRect();
        return [{ text: row.textContent, badge: badge.textContent, badgeX: b.x, badgeWidth: b.width,
            detailX: d?.x ?? null, hiddenMetadata: style.clipPath !== 'none' || style.display === 'none' }];
    }));
    const visible = rows.filter(row => !row.hiddenMetadata);
    if (visible.length > 1) {
        const xs = visible.map(row => row.badgeX), widths = visible.map(row => row.badgeWidth);
        expect(Math.max(...xs) - Math.min(...xs), label + ' badge column x').toBeLessThanOrEqual(1);
        expect(Math.max(...widths) - Math.min(...widths), label + ' badge widths').toBeLessThanOrEqual(1);
        const details = visible.filter(row => row.detailX !== null).map(row => row.detailX);
        if (details.length > 1) expect(Math.max(...details) - Math.min(...details), label + ' detail column x').toBeLessThanOrEqual(1);
    }
    results.push({ check: 'search-badge-detail-columns-aligned', label, visibleRows: visible.length, rows });
}
async function openPalette() {
    const trigger = page.getByRole('button', { name: new RegExp('^' + navigationUi.button + '(?:\\s|$)') });
    await expect(trigger).toBeVisible(); await trigger.click(); await expect(palette()).toBeVisible();
    const input = palette().getByRole('combobox'); await expect(input).toBeFocused(); return input;
}
async function closePalette() {
    await palette().getByRole('combobox').press('Escape'); await expect(palette()).toBeHidden(); await stableFrame();
}
async function theme(name) {
    await page.getByRole('button', { name: '設定', exact: true }).click();
    const settings = page.getByRole('dialog', { name: '設定', exact: true });
    await settings.getByRole('tab', { name: '外觀', exact: true }).click();
    await settings.getByRole('radio', { name, exact: true }).click();
    await page.keyboard.press('Escape'); await expect(settings).toBeHidden(); await stableFrame();
}
async function paletteGeometry(label) {
    const measured = await palette().evaluate(dialog => {
        const r = dialog.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom,
            scroll: dialog.scrollWidth, client: dialog.clientWidth, viewport: { width: innerWidth, height: innerHeight },
            rem: parseFloat(getComputedStyle(document.documentElement).fontSize) };
    });
    const target = Math.min(32 * measured.rem, measured.viewport.width - 32);
    expect(Math.abs(measured.width - target), 'Palette should be approximately 32rem and stay inside narrow viewports.').toBeLessThanOrEqual(8);
    expect(Math.abs(measured.x + measured.width / 2 - measured.viewport.width / 2)).toBeLessThanOrEqual(2);
    // The palette retains its top inset (up to 18vh); horizontal centering is
    // independent of content height and short-window internal scrolling.
    expect(measured.y).toBeLessThanOrEqual(Math.max(8, measured.viewport.height * .2) + 2);
    expect(measured.x).toBeGreaterThanOrEqual(7); expect(measured.right).toBeLessThanOrEqual(measured.viewport.width - 7);
    expect(measured.y).toBeGreaterThanOrEqual(7); expect(measured.bottom).toBeLessThanOrEqual(measured.viewport.height - 7);
    expect(measured.scroll).toBeLessThanOrEqual(measured.client + 1);
    const input = palette().getByRole('combobox'); await expect(input).toBeFocused();
    const focusStyle = await input.evaluate(input => {
        const style = getComputedStyle(input);
        return { boxShadow: style.boxShadow, borderRadius: style.borderRadius, borderTop: style.borderTopWidth,
            borderLeft: style.borderLeftWidth, borderRight: style.borderRightWidth, borderBottom: style.borderBottomWidth };
    });
    expect(focusStyle.boxShadow).toBe('none'); expect(focusStyle.borderRadius).toBe('0px');
    expect(focusStyle.borderTop).toBe('0px'); expect(focusStyle.borderLeft).toBe('0px'); expect(focusStyle.borderRight).toBe('0px');
    await resultColumns(await controlledOptions(input), 'palette-' + label);
    results.push({ check: 'palette-32rem-centered-contained-focus-bottom-line', label, measured, focusStyle });
}
async function setLinkMode(id, label) {
    const header = panelHeader(id), menu = header.locator('button[aria-haspopup="menu"]');
    if (await menu.count() === 0) {
        // Ordinary panels use the direct link/pin toggle; group menus belong
        // to the actual flash panels. Exercise both existing entry points.
        if (label === '鎖定目前商品') await header.getByRole('button', { name: '連動', exact: true }).click();
        else if (label === '連動') await header.getByRole('button', { name: '鎖定', exact: true }).click();
        else throw new Error('Group selection needs a flash panel.');
        await stableFrame(); return;
    }
    await menu.click();
    await page.getByRole('menuitemradio', { name: new RegExp('^' + label) }).click(); await stableFrame();
}
async function addFlashPanels() {
    const ids = [];
    for (let index = 0; index < 2; index++) {
        const before = (await workspace()).blocks.map(block => block.id);
        await page.getByRole('button', { name: /新增面板/ }).click();
        const library = page.getByRole('dialog', { name: '新增面板', exact: true });
        await library.getByPlaceholder('搜尋面板（名稱或用途）', { exact: true }).fill('閃電下單');
        await library.getByRole('button', { name: /^閃電下單/ }).click(); await expect(library).toBeHidden();
        await expect.poll(async () => (await workspace()).blocks.length).toBe(before.length + 1);
        const block = (await workspace()).blocks.find(block => !before.includes(block.id));
        expect(block.type).toBe('flash'); ids.push(block.id);
    }
    return ids;
}
async function panelSuggestion(id, query, code) {
    const input = panelHeader(id).getByRole('combobox'); await expect(input).toBeVisible(); await input.fill(query);
    const options = await expectedOptions(input, [code]);
    await resultColumns(options, 'panel-' + id + '-' + query);
    expect(await options.first().evaluate((row, id) => !document.querySelector(`[data-block-id="${id}"]`).contains(row), id), 'Inline suggestions must use a portal outside the clipped panel.').toBe(true);
    await options.filter({ hasText: new RegExp('^' + code) }).click();
    await expect(input).toHaveValue(code); return input;
}
async function compositionCannotApply(input, snapshot, label, modal = false) {
    const headerText = await panelHeader(navigationUi.chart).innerText();
    await input.dispatchEvent('compositionstart', { data: '聯' }); await input.fill('聯發科');
    const composingActive = await input.getAttribute('aria-activedescendant');
    for (const key of ['n', 'p']) {
        const prevented = await input.evaluate((node, key) => {
            const event = new KeyboardEvent('keydown', { key, code: 'Key' + key.toUpperCase(), ctrlKey: true, isComposing: true, keyCode: 229, bubbles: true, cancelable: true });
            node.dispatchEvent(event); return event.defaultPrevented;
        }, key);
        expect(prevented, 'IME Ctrl+' + key + ' must not be intercepted.').toBe(false);
        expect(await input.getAttribute('aria-activedescendant')).toBe(composingActive);
    }
    await input.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true, keyCode: 229, which: 229 });
    await input.dispatchEvent('keydown', { key: 'Escape', code: 'Escape', isComposing: true, keyCode: 229, which: 229 });
    if (modal) await expect(palette()).toBeVisible();
    expect(await workspace()).toEqual(snapshot);
    if (modal || label === 'watchlist') expect(await panelHeader(navigationUi.chart).innerText()).toBe(headerText);
    await input.dispatchEvent('compositionend', { data: '聯發科' }); await input.press('Escape');
    if (modal) await expect(palette()).toBeHidden();
    await stableFrame(); expect(await workspace()).toEqual(snapshot);
    if (modal || label === 'watchlist') expect(await panelHeader(navigationUi.chart).innerText()).toBe(headerText);
    expect(mutations).toEqual([]);
    results.push({ check: 'ime-enter-escape-no-apply-or-trade', label });
}
async function navigationChecks() {
    const baselineLists = await watchlists(), baselineWrites = watchlistMutations.length;
    const jumps = [
        { query: '2330', codes: ['2330', 'CDFK6', 'QFFK6'], pick: '2330' },
        { query: '聯發科', codes: ['2454', 'DVFK6', 'PUFK6'], pick: 'DVFK6' },
        { query: '2454', codes: ['2454', 'DVFK6', 'PUFK6', 'DVFL6', 'PUFL6'], pick: 'PUFK6' },
        { query: 'CDFL6', codes: ['CDFL6'], pick: 'CDFL6' },
    ];
    for (const jump of jumps) {
        const input = await openPalette(); await input.fill(jump.query);
        const options = await expectedOptions(input, jump.codes);
        await resultColumns(options, 'palette-query-' + jump.query);
        await options.filter({ hasText: new RegExp('^' + jump.pick) }).click(); await expect(palette()).toBeHidden();
        await expect(panelHeader(navigationUi.chart)).toContainText(jump.pick);
        await unchangedWatchlists(baselineLists, baselineWrites);
        results.push({ check: 'visible-header-search-select-only-switches', ...jump });
    }
    for (const color of ['深色', '淺色']) {
        for (const size of [{ width: 1440, height: 1050 }, { width: 390, height: 844 }, { width: 320, height: 480 }, { width: 640, height: 320 }]) {
            await page.setViewportSize(size); await theme(color);
            const input = await openPalette(); await input.fill('2454');
            await expectedOptions(input, ['2454', 'DVFK6', 'PUFK6', 'DVFL6', 'PUFL6']);
            if (color === '深色' && size.width === 1440) await keyboardCycle(input, 'command-palette');
            await input.press('ArrowUp');
            const selected = palette().getByRole('option', { selected: true });
            await expect(selected).toBeVisible();
            const row = await selected.boundingBox(); expect(row.y).toBeGreaterThanOrEqual(0); expect(row.y + row.height).toBeLessThanOrEqual(size.height);
            await paletteGeometry(`${color}-${size.width}x${size.height}`);
            await page.screenshot({ path: path.join(artifacts, `palette-${color}-${size.width}x${size.height}.png`), fullPage: true, animations: 'disabled' });
            await closePalette(); await unchangedWatchlists(baselineLists, baselineWrites);
        }
    }
    await page.setViewportSize({ width: 1440, height: 1050 }); await theme('深色');
    const composingPalette = await openPalette();
    await compositionCannotApply(composingPalette, await workspace(), 'command-palette', true);
    await unchangedWatchlists(baselineLists, baselineWrites);

    await setLinkMode(navigationUi.chart, '鎖定目前商品');
    const pinned = await panelSuggestion(navigationUi.chart, '聯發科', 'DVFL6');
    expect((await workspace()).blocks.find(block => block.id === navigationUi.chart).pin).toBe('DVFL6');
    const width = (await pinned.boundingBox()).width; expect(width).toBeGreaterThanOrEqual(96); expect(width).toBeLessThanOrEqual(180);
    await pinned.fill('2454'); await expectedOptions(pinned, ['2454', 'DVFK6', 'PUFK6']); await keyboardCycle(pinned, 'pinned-inline'); await pinned.press('Escape');
    await compositionCannotApply(pinned, await workspace(), 'pinned-inline');
    await unchangedWatchlists(baselineLists, baselineWrites);
    results.push({ check: 'inline-pin-name-select-and-moderate-width', width, code: 'DVFL6' });

    await setLinkMode(navigationUi.chart, '連動');
    const [groupOne, groupTwo] = await addFlashPanels();
    await setLinkMode(groupOne, '群組 A'); await setLinkMode(groupTwo, '群組 A');
    await panelSuggestion(groupOne, '2454', 'PUFK6');
    expect((await workspace()).linkGroups.A).toBe('PUFK6');
    await expect(panelHeader(groupTwo).getByRole('combobox')).toHaveValue('PUFK6');
    const groupedInput = panelHeader(groupTwo).getByRole('combobox');
    await compositionCannotApply(groupedInput, await workspace(), 'grouped-inline');
    await unchangedWatchlists(baselineLists, baselineWrites);
    results.push({ check: 'inline-group-stock-code-related-future-switches-whole-group', code: 'PUFK6' });

    const depth = page.locator(`[data-block-id="${groupTwo}"]`);
    const priorStyle = await depth.getAttribute('style');
    try {
        for (const panelWidth of [320, 240, 200, 135]) {
            await depth.evaluate((node, width) => node.style.setProperty('width', width + 'px', 'important'), panelWidth);
            const input = panelHeader(groupTwo).getByRole('combobox');
            if (panelWidth !== 320) await expect(input).toHaveValue('2330');
            await input.click(); await expect(input).toHaveAttribute('aria-expanded', 'true'); await input.fill('2330');
            const options = await expectedOptions(input, ['2330', 'CDFK6', 'QFFK6']);
            const bounds = await input.boundingBox();
            expect(bounds.width).toBeGreaterThanOrEqual(64); expect(bounds.width).toBeLessThanOrEqual(180);
            const popup = await options.first().evaluate(row => {
                const list = row.closest('[role="listbox"]'), r = list.getBoundingClientRect();
                return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, scroll: list.scrollWidth, width: list.clientWidth, inPanel: !!list.closest('[data-block-id]') };
            });
            expect(popup.inPanel).toBe(false); expect(popup.x).toBeGreaterThanOrEqual(0); expect(popup.right).toBeLessThanOrEqual(1440);
            expect(popup.y).toBeGreaterThanOrEqual(0); expect(popup.bottom).toBeLessThanOrEqual(1050); expect(popup.scroll).toBeLessThanOrEqual(popup.width + 1);
            await page.screenshot({ path: path.join(artifacts, `inline-panel-${panelWidth}.png`), fullPage: true, animations: 'disabled' });
            await input.press('Escape'); await expect(input).toHaveAttribute('aria-expanded', 'false'); expect((await workspace()).linkGroups.A).toBe('PUFK6');
            results.push({ check: 'narrow-panel-portal-contained-escape-no-apply', panelWidth, sameValueClickReopens: panelWidth !== 320, input: bounds, popup });
        }
    } finally { await depth.evaluate((node, value) => value === null ? node.removeAttribute('style') : node.setAttribute('style', value), priorStyle); }
    for (const id of [groupOne, groupTwo]) await panelHeader(id).getByRole('button', { name: '移除此面板', exact: true }).click();
    await unchangedWatchlists(baselineLists, baselineWrites); expect(mutations).toEqual([]);
}
async function neutralRemoveButton(code) {
    for (const color of ['深色', '淺色']) {
        await theme(color);
        const row = page.locator(`[data-code="${code}"]`); await row.hover();
        const button = row.getByTitle('從清單移除', { exact: true }); await expect(button).toBeVisible();
        await expect.poll(() => button.evaluate(node => getComputedStyle(node).opacity)).toBe('1');
        const style = await button.evaluate(node => {
            const s = getComputedStyle(node), svg = node.querySelector('svg'), icon = getComputedStyle(svg);
            return { background: s.backgroundColor, color: s.color, fill: icon.fill, stroke: icon.stroke, iconClass: svg.getAttribute('class'), width: svg.getBoundingClientRect().width, height: svg.getBoundingClientRect().height };
        });
        expect(style.iconClass).toContain('lucide-x'); expect(style.fill).toBe('none'); expect(style.stroke).not.toBe(style.background);
        expect(style.width).toBeGreaterThan(0); expect(style.height).toBeGreaterThan(0);
        const channels = style.background.match(/[\d.]+/g).map(Number);
        expect(channels[0] - Math.max(channels[1], channels[2]), 'Remove button must not have a red fill.').toBeLessThan(40);
        await row.screenshot({ path: path.join(artifacts, `watchlist-remove-${color}.png`), animations: 'disabled' });
        results.push({ check: 'watchlist-remove-neutral-background-visible-x', color, style });
    }
    await theme('深色');
}
try {
    await free(uiPort); await free(apiPort);
    const marketFixture = path.join(root, 'server/tests/fixtures/future-search-2026-11-17.json');
    await readFile(marketFixture, 'utf8');
    await writeFile(path.join(temporary, 'stocks.json'), JSON.stringify(stocks));
    const backend = path.join(temporary, 'backend.py');
    await writeFile(backend, `import json,os,re,socket,sys,threading
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
root=Path(os.environ['SEARCH_TEMP']);(root/'server').mkdir()
fixture=json.loads(Path(os.environ['SEARCH_FIXTURE']).read_text());stocks=json.loads((root/'stocks.json').read_text())
counts=dict(sdkCalls=0,sdkTransactions=0,keychainCalls=0,outboundCalls=0,products=0,tickers=0,ticker=0,quote=0,websocket=0);lock=threading.Lock()
def count(key):
    with lock: counts[key]+=1
def no_sdk(*args,**kwargs):count('sdkCalls');raise AssertionError('QA forbids SDK construction')
def no_keychain(*args,**kwargs):count('keychainCalls');raise AssertionError('QA forbids Keychain')
def no_outbound(*args,**kwargs):count('outboundCalls');raise AssertionError('QA forbids outbound sockets')
Keychain.read=no_keychain;socket.socket.connect=no_outbound;socket.socket.connect_ex=no_outbound
sdk_module=ModuleType('fubon_neo.sdk');sdk_module.FubonSDK=no_sdk;sys.modules['fubon_neo.sdk']=sdk_module
class Market:
    def __init__(self,stock=False):self.stock=stock;self.intraday=self;self.historical=self
    def products(self,**kwargs):count('products');return dict(data=deepcopy(fixture['products']))
    def tickers(self,**kwargs):
        count('tickers')
        return dict(data=deepcopy(stocks if kwargs.get('market')=='TSE' else [] if self.stock else fixture['tickers']))
    def ticker(self,symbol,**kwargs):
        count('ticker');rows=stocks if self.stock else fixture['tickers']
        match=next((r for r in rows if r['symbol']==symbol),None)
        if match is None and symbol.endswith('!'):match=next((r for r in rows if r['symbol'].startswith(symbol[:-2])),None)
        if match is None:raise ValueError('Unknown public QA market symbol')
        return deepcopy(match)
    def quote(self,symbol,**kwargs):
        count('quote');row=self.ticker(symbol);price=row['referencePrice']
        return dict(symbol=row['symbol'],exchange='TWSE' if self.stock else 'TAIFEX',previousClose=price,lastUpdated=int(now().timestamp()*1e6),lastTrade=dict(time=int(now().timestamp()*1e6),price=price,bid=price-1,ask=price+1,size=1),openPrice=price,highPrice=price+1,lowPrice=price-1,total=dict(tradeVolume=1000))
    def candles(self,**kwargs):return dict(data=[])
    def trades(self,**kwargs):return dict(data=[])
    def __getattr__(self,key):count('sdkTransactions');raise AssertionError('Unknown market fixture method '+key)
class Socket:
    def on(self,*args):pass
    def connect(self):count('websocket')
    def subscribe(self,*args):pass
    def disconnect(self):pass
class LocalSDK:
    def __init__(self):self.marketdata=SimpleNamespace(rest_client=SimpleNamespace(stock=Market(True),futopt=Market()),websocket_client=SimpleNamespace(stock=Socket(),futopt=Socket()))
    def shutdown(self):pass
    def __getattr__(self,key):count('sdkTransactions');raise AssertionError('QA forbids transaction access '+key)
class NoCredentials:
    def available(self):return False
entry.ROOT=root
Config.from_env=classmethod(lambda cls:Config(mode='paper',port=int(os.environ['SEARCH_API_PORT'])))
def create_app(config,**kwargs):
    kwargs['launch_token']=os.environ['SEARCH_LAUNCH']
    app=real_create_app(config,sdk_factory=no_sdk,passkey_store=PasskeyStore(root/'passkeys.sqlite3'),research_store=ResearchStore(root/'research.sqlite3'),credential_store=NoCredentials(),**kwargs)
    broker=app.state.broker
    def connect():broker.sdk=LocalSDK();broker.error=None
    broker.connect=connect
    @app.post('/api/v1/qa/futures-search')
    def qa(body:dict):
        if body.get('cold'):
            # Isolated cache reset proves Info without relying on a prior roots request.
            broker.future_product_catalog=None
        return dict(counts=deepcopy(counts),ledger=broker.paper.overview(),productWarm=broker.future_product_catalog is not None)
    app.router.routes.insert(0,app.router.routes.pop())
    return app
entry.create_app=create_app;sys.argv=['fixture','--ui-url',os.environ['SEARCH_ORIGIN'],'--no-browser'];entry.main()
`);
    const viteFile = path.join(temporary, 'vite.mjs');
    await writeFile(viteFile, `import{createServer,loadConfigFromFile}from ${JSON.stringify(path.join(root, 'node_modules/vite/dist/node/index.js'))};
globalThis.fetch=async()=>{throw new Error('QA forbids public metadata upstream');};
const loaded=await loadConfigFromFile({command:'serve',mode:'development'},${JSON.stringify(path.join(root, 'vite.config.ts'))},process.cwd());
// Resolve the real Tailwind content globs from the checkout, after its Vite
// config's loadEnv has already run in the empty temporary directory.
process.chdir(${JSON.stringify(root)});
const server=await createServer({...loaded.config,configFile:false,root:${JSON.stringify(root)},envDir:${JSON.stringify(temporary)},cacheDir:${JSON.stringify(path.join(temporary, 'vite-cache'))},server:{...loaded.config.server,host:'127.0.0.1',port:${uiPort},strictPort:true,fs:{...loaded.config.server.fs,allow:[...loaded.config.server.fs.allow,${JSON.stringify(root)},${JSON.stringify(await realpath(path.join(root, 'node_modules')))}]}}});await server.listen();`);
    run(path.join(root, 'server/.venv/bin/python'), [backend], { PYTHONPATH: path.join(root, 'server'), SEARCH_TEMP: temporary, SEARCH_FIXTURE: marketFixture, SEARCH_API_PORT: String(apiPort), SEARCH_ORIGIN: origin, SEARCH_LAUNCH: launch });
    run(process.execPath, [viteFile], { VITE_API_TARGET: `http://127.0.0.1:${apiPort}`, VITE_API_BASE: '', VITE_STREAM_BASE: origin, VITE_DEV_SERVER_PORT: '' });
    await ready(`http://127.0.0.1:${apiPort}/api/v1/passkeys/status`); await ready(origin);
    browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1050 } });
    await context.route('**/*', route => {
        const req = route.request(), url = new URL(req.url());
        if (url.origin === origin && /^\/api\/v1\/order\/(place|cancel|update|reserve)/.test(url.pathname)) { mutations.push({ method: req.method(), path: url.pathname }); return route.abort('blockedbyclient'); }
        if (url.origin === origin && url.pathname.startsWith('/metadata/')) {
            const payload = url.pathname === '/metadata/equity/tse-companies' ? stocks.filter(row => /^[1-9]\d{3}$/.test(row.symbol)).map(row => ({ 公司代號: row.symbol, 公司簡稱: row.name, 公司名稱: row.name + 'QA股份有限公司', 出表日期: '1151117' })) : [];
            return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(payload) });
        }
        if (url.origin === origin) return route.continue();
        blocked.push(url.origin + url.pathname); return route.abort('blockedbyclient');
    });
    page = await context.newPage(); page.on('pageerror', error => pageErrors.push(error.message));
    page.on('request', request => {
        const url = new URL(request.url());
        if (url.pathname.startsWith('/api/v1/watchlist') && ['POST', 'PUT', 'DELETE'].includes(request.method())) watchlistMutations.push({ method: request.method(), path: url.pathname });
    });
    page.on('response', response => { const url = new URL(response.url()); if (url.pathname.startsWith('/api/v1/data/contracts/futures')) marketRequests.push({ path: url.pathname + url.search, status: response.status() }); });
    const cdp = await context.newCDPSession(page); await cdp.send('WebAuthn.enable');
    await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
    await page.goto(origin + '/#fubon-launch=' + launch); await page.getByRole('button', { name: '建立 Passkey 並解鎖', exact: true }).click();
    await expect(page.getByRole('button', { name: '交易模式設定', exact: true })).toBeVisible({ timeout: 30000 });
    await page.evaluate(async () => {
        window.qaSearch = { api: await import('/src/lib/shioaji.ts') };
        (await import('/src/lib/stock-runtime-catalog.ts')).ensureEquityNamesFresh();
    });
    await expect.poll(() => page.evaluate(async () => (await import('/src/lib/stock-runtime-catalog.ts')).equityNameForLive('TSE', '2454')?.name)).toBe('聯發科');
    const input = page.getByPlaceholder('股票、期貨或指數（如 台積電期）', { exact: true });
    await expect(page.getByRole('combobox', { name: '自選清單', exact: true })).toContainText('台指期與股票');
    await expect(page.locator('[data-code="2330"]')).toBeVisible(); await expect(input).toBeEnabled();
    await qa({ cold: true });
    const coldInfo = await page.evaluate(() => window.qaSearch.api.fetchContractInfo('DVFK6', 'FUT'));
    expect(coldInfo).toMatchObject({ code: 'DVFK6', root: 'DVF', underlying_code: '2454', multiplier: 2000, currency: 'TWD' });
    results.push({ check: 'cold-public-info-loads-products', info: coldInfo });
    await navigationChecks();
    await page.getByTitle('建立新清單', { exact: true }).click();
    await page.getByPlaceholder('新清單名稱', { exact: true }).fill('QA futures search');
    await page.getByPlaceholder('新清單名稱', { exact: true }).press('Enter');
    await expect(page.getByRole('combobox', { name: '自選清單', exact: true })).toContainText('QA futures search');
    const cases = [
        { query: '聯', select: 'CCFK6', broad: true },
        { query: '聯發科', codes: ['2454', 'DVFK6', 'DVFL6', 'PUFK6', 'PUFL6'], select: 'DVFK6' },
        { query: '2454', codes: ['2454', 'DVFK6', 'DVFL6', 'PUFK6', 'PUFL6'], select: 'PUFL6' },
        { query: '2330', codes: ['2330', 'CDFK6', 'CDFL6', 'QFFK6', 'QFFL6'], select: 'QFFK6' },
        { query: 'DVF', codes: ['DVFK6', 'DVFL6'], select: 'DVFL6' },
        { query: 'CDF', codes: ['CDFK6', 'CDFL6'], select: 'CDFL6' },
    ];
    for (const scenario of cases) {
        await expect(input).toBeEnabled(); await input.fill(scenario.query);
        const options = page.getByRole('listbox', { name: '搜尋結果', exact: true }).getByRole('option');
        await expect.poll(async () => {
            const rows = await options.allTextContents();
            return scenario.broad ? rows.filter(row => /^[A-Z]+[A-L]\d/.test(row)).length >= 2 : scenario.codes.every(code => rows.some(row => row.startsWith(code)));
        }, { timeout: 20000, message: 'Expected stock/futures search identities for ' + scenario.query }).toBe(true);
        const rows = await options.allTextContents();
        await resultColumns(options, 'watchlist-query-' + scenario.query);
        expect(rows.length).toBeLessThanOrEqual(10);
        if (scenario.broad) { expect(rows.some(row => /^\d{4}/.test(row))).toBe(true); expect(rows.some(row => row.includes('聯'))).toBe(true); }
        if (scenario.query === '2454' || scenario.query === '2330') { expect(rows.some(row => row.includes('202611'))).toBe(true); expect(rows.some(row => row.includes('202612'))).toBe(true); }
        if (scenario.query === '2454') {
            await keyboardCycle(input, 'watchlist');
            const beforeIme = await watchlists(), beforeImeWrites = watchlistMutations.length;
            await compositionCannotApply(input, await workspace(), 'watchlist');
            await unchangedWatchlists(beforeIme, beforeImeWrites);
            await input.fill('2454'); await expectedOptions(input, scenario.codes);
        }
        await page.screenshot({ path: path.join(artifacts, `search-${scenario.query}.png`), fullPage: true, animations: 'disabled' });
        await options.filter({ hasText: new RegExp('^' + scenario.select) }).click();
        await expect(input).toHaveValue(''); await expect(page.locator(`[data-code="${scenario.select}"]`)).toBeVisible();
        results.push({ check: 'rendered-search-select-add', ...scenario, rows });
    }
    await page.getByRole('button', { name: '重新讀取清單', exact: true }).click();
    await expect(page.getByRole('button', { name: '重新讀取清單', exact: true })).toHaveAttribute('aria-busy', 'false');
    const lists = await page.evaluate(() => window.qaSearch.api.fetchWatchlists());
    const selectedList = lists.find(list => list.name === 'QA futures search');
    expect(selectedList.contracts.map(contract => contract.code)).toEqual(cases.map(scenario => scenario.select));
    await neutralRemoveButton(cases[0].select);
    const final = await qa(); expect(final.ledger.orders).toEqual([]); expect(final.ledger.positions).toEqual([]);
    for (const key of ['sdkCalls', 'sdkTransactions', 'keychainCalls', 'outboundCalls']) expect(final.counts[key], key).toBe(0);
    expect(final.counts.products).toBeGreaterThan(0); expect(final.counts.tickers).toBeGreaterThan(0);
    expect(mutations).toEqual([]); expect(pageErrors).toEqual([]); expect(blocked.filter(url => url !== 'https://fonts.googleapis.com/css2')).toEqual([]);
    await writeFile(path.join(artifacts, 'summary.json'), JSON.stringify({ passed: true, results, final, selectedList, pageErrors, mutations, watchlistMutations, blocked, marketRequests, temporary, marketFixture }, null, 2));
    console.log(JSON.stringify({ passed: true, checks: results.length, counts: final.counts, artifacts, temporary }, null, 2));
} catch (error) {
    await writeFile(path.join(artifacts, 'failure.log'), childLogs);
    await writeFile(path.join(artifacts, 'summary.json'), JSON.stringify({ passed: false, error: String(error), results, pageErrors, mutations, watchlistMutations, blocked, marketRequests, temporary }, null, 2));
    await page?.screenshot({ path: path.join(artifacts, 'failure.png'), fullPage: true }).catch(() => undefined);
    console.error(JSON.stringify({ passed: false, artifacts, temporary })); throw error;
} finally {
    await browser?.close().catch(() => undefined);
    for (const child of children.reverse()) {
        if (child.exitCode !== null || child.signalCode) continue;
        const ended = new Promise(resolve => child.once('exit', resolve));
        try { process.kill(-child.pid, 'SIGTERM'); } catch { continue; }
        let timeout; await Promise.race([ended, new Promise(resolve => { timeout = setTimeout(resolve, 8000); })]); clearTimeout(timeout);
        if (child.exitCode === null && !child.signalCode) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* stopped */ } await ended; }
    }
}
