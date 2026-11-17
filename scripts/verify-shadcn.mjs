// Isolated browser acceptance: demo quotes, a temporary Passkey database and a
// virtual authenticator. Never reads Keychain or contacts a broker.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, writeFile, readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';
import { workspaceRulerChecks } from './verify-workspace-rulers.mjs';
import { indicatorSettingsChecks } from './verify-indicator-settings.mjs';
import { maLegendChecks } from './verify-ma-legend.mjs';
import { workspaceResizeChecks } from './verify-workspace-resize.mjs';
import { workspaceScrollChecks } from './verify-workspace-scroll.mjs';
import { workspaceDragAlignmentChecks } from './verify-workspace-drag-alignment.mjs';
import { chartPaneChecks } from './verify-chart-panes.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const uiPort = Number(process.env.SHADCN_UI_PORT || 5186);
const apiPort = Number(process.env.SHADCN_API_PORT || 21426);
const origin = `http://localhost:${uiPort}`;
const temporary = await mkdtemp(path.join(tmpdir(), 'fubon-shadcn-'));
const artifacts = process.env.SHADCN_ARTIFACT_DIR || temporary;
await mkdir(artifacts, { recursive: true });
const token = randomBytes(32).toString('base64url');
const children = [];
let browser;
let page;
let logs = '';
const mutations = [];
async function selectChoice(trigger, label) {
    await trigger.click();
    await page.getByRole('option', { name: label, exact: true }).click();
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await expect(trigger).toHaveText(label);
}
function run(command, args, env) {
    const child = spawn(command, args, { cwd: root, detached: process.platform !== 'win32', env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', data => { logs = (logs + data).slice(-12000); });
    child.stderr.on('data', data => { logs = (logs + data).slice(-12000); });
    child.on('error', error => { logs += error.message; });
    children.push(child);
    return child;
}
async function free(port) {
    await new Promise((resolve, reject) => {
        const probe = net.createServer(); probe.once('error', reject);
        probe.listen(port, '127.0.0.1', () => probe.close(resolve));
    });
}
async function ready(url) {
    for (let attempt = 0; attempt < 200; attempt++) {
        if (children.some(child => child.exitCode !== null && child.exitCode !== 0)) throw new Error('An isolated test server exited.');
        try { const response = await fetch(url, { signal: AbortSignal.timeout(500) }); if (response.status < 500) return; } catch { /* Starting. */ }
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`Test server did not start: ${url}`);
}
async function textContrast(locator, { property = 'color', behindBar = false } = {}) {
    return locator.evaluate((el, { property, behindBar }) => {
        const rgba = value => value.match(/[\d.]+/g).map(Number);
        const layers = [];
        let opacity = 1;
        for (let node = el; node; node = node.parentElement) {
            layers.unshift(getComputedStyle(node).backgroundColor);
            opacity *= Number(getComputedStyle(node).opacity);
        }
        // The depth bar is an absolutely positioned sibling behind its price.
        if (behindBar) layers.push(getComputedStyle(el.previousElementSibling).backgroundColor);
        let background = [255, 255, 255];
        for (const layer of layers) {
            const [r, g, b, alpha = 1] = rgba(layer);
            background = [r, g, b].map((v, i) => v * alpha + background[i] * (1 - alpha));
        }
        const luminance = channels => channels.slice(0, 3).map(v => v / 255)
            .map(v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
            .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
        const [r, g, b, alpha = 1] = rgba(getComputedStyle(el)[property]);
        const foreground = [r, g, b].map((v, i) => v * alpha * opacity + background[i] * (1 - alpha * opacity));
        const foregroundLuminance = luminance(foreground);
        const backgroundLuminance = luminance(background);
        return (Math.max(foregroundLuminance, backgroundLuminance) + 0.05) / (Math.min(foregroundLuminance, backgroundLuminance) + 0.05);
    }, { property, behindBar });
}
async function tradeContrast(ticket) {
    for (const [name, variant] of [['賣出 Sell', 'sell'], ['買進 Buy', 'buy']]) {
        const control = ticket.getByRole('button', { name, exact: true });
        await control.click();
        await expect(control).toHaveAttribute('data-variant', variant);
        await expect.poll(() => textContrast(control)).toBeGreaterThanOrEqual(4.5);
    }
}
async function panelGeometry(page) {
    return page.locator('[data-slot="card"]').evaluateAll(cards => cards.map(card => {
        const { x, y, width, height } = card.getBoundingClientRect();
        return [x, y, width, height].map(Math.round);
    }));
}
async function panelHeaders(page) {
    const headers = await page.locator('[data-slot="card-header"][data-layout="panel"]').all();
    expect(headers.length).toBeGreaterThanOrEqual(6);
    for (const header of headers) {
        const layout = await header.evaluate(el => {
            const style = getComputedStyle(el);
            return { direction: style.flexDirection, padding: parseFloat(style.paddingTop), height: el.getBoundingClientRect().height };
        });
        expect(layout.direction).toBe('row');
        expect(layout.padding).toBe(7);
        expect(layout.height).toBeLessThan(52);
    }
}
async function switchGeometry(settings) {
    for (const control of await settings.getByRole('switch').all()) {
        await expect.poll(() => control.evaluate(el => {
            const track = el.getBoundingClientRect();
            const thumb = el.querySelector('span').getBoundingClientRect();
            return thumb.left >= track.left && thumb.right <= track.right && thumb.top >= track.top && thumb.bottom <= track.bottom;
        })).toBe(true);
    }
}
async function settingsPreferenceLayout(settings, narrow = false) {
    const limits = settings.getByRole('radiogroup', { name: /自選清單漲跌停/ });
    const buttons = await limits.getByRole('radio').all();
    const frames = await Promise.all(buttons.map(button => button.boundingBox()));
    expect(frames).toHaveLength(4);
    expect(new Set(frames.map(frame => Math.round(frame.y))).size).toBe(narrow ? 2 : 1);
    for (const button of buttons) await expect.poll(() => textBounds(button)).toBe(true);
    const panel = settings.getByRole('tabpanel');
    expect(await panel.evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
    const header = settings.locator('[data-slot="field-set"]');
    const list = settings.locator('[data-slot="field-group"]').first();
    expect(Math.abs((await header.boundingBox()).x - (await list.boundingBox()).x)).toBeLessThan(1);
    const close = settings.getByRole('button', { name: '關閉設定', exact: true });
    const closeFrame = await close.boundingBox();
    expect(Math.abs(closeFrame.height - closeFrame.width)).toBeLessThan(1);
}
async function compactFormControls(page, artifacts) {
    const settingsButton = page.getByRole('button', { name: '設定', exact: true });
    const settings = page.getByRole('dialog', { name: '設定', exact: true });
    const watch = page.locator('[data-slot="card"]').filter({ hasText: '自選清單' }).first();
    const dock = page.locator('[data-slot="card"]').filter({ hasText: '持倉/委託/帳務' }).first();
    const ticket = page.locator('[data-slot="card"]').filter({ hasText: '下單面板' }).first();
    for (const theme of ['深色', '淺色']) {
        for (const scale of ['小', '標準', '大']) {
            await settingsButton.click();
            await settings.getByRole('tab', { name: '外觀' }).click();
            await settings.getByRole('radio', { name: theme, exact: true }).click();
            await settings.getByRole('radio', { name: scale, exact: true }).first().click();
            await settingsPreferenceLayout(settings);
            if (scale === '標準') await settings.screenshot({ animations: 'disabled', path: path.join(artifacts, `settings-layout-${theme === '淺色' ? 'light' : 'dark'}.png`) });
            await page.keyboard.press('Escape');
            const rootSize = await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize));
            const list = watch.getByRole('combobox', { name: '自選清單', exact: true });
            const add = watch.getByPlaceholder('股票、期貨或指數（如 台積電期）');
            const account = dock.getByRole('combobox', { name: '帳戶範圍（選個別帳戶會同步下單面板）', exact: true });
            const sort = dock.getByTitle('排序', { exact: true });
            const compactHeight = Math.max(24, 1.5 * rootSize);
            for (const [control, font] of [[list, .72], [add, .76], [account, .66], [sort, .66]]) {
                await expect(control).toHaveCSS('font-size', `${Number((font * rootSize).toFixed(3))}px`);
                const frame = await control.boundingBox();
                expect(Math.abs(frame.height - compactHeight)).toBeLessThan(.02);
                expect(frame.width).toBeGreaterThan(0);
            }
            expect((await list.boundingBox()).width).toBeGreaterThan(100);
            // Numeric trade fields retain their deliberate, larger type size.
            const price = ticket.locator('[data-slot="input"]').first();
            expect(await price.evaluate(el => parseFloat(getComputedStyle(el).fontSize))).toBeCloseTo(.92 * rootSize, 2);
            const equalRows = [
                [account, dock.getByRole('button', { name: '合併', exact: true }), dock.getByRole('button', { name: '分帳戶', exact: true })],
                [sort, dock.getByRole('button', { name: '平倉', exact: true })],
                [add, add.locator('..').getByRole('button', { name: '新增商品', exact: true })],
                await price.locator('..').locator('input, button').all(),
            ];
            for (const controls of equalRows) {
                const frames = await Promise.all(controls.map(control => control.boundingBox()));
                for (const frame of frames) {
                    expect(Math.abs(frame.height - frames[0].height)).toBeLessThan(.02);
                    // Wrapped groups may occupy separate lines at larger scales.
                    if (Math.abs(frame.y - frames[0].y) < frames[0].height) expect(Math.abs(frame.y - frames[0].y)).toBeLessThan(.02);
                }
            }
            await selectChoice(sort, '代碼');
            await selectChoice(sort, '預設排序');
            // The empty option is a real selectable item, including after a
            // nonempty account value; Radix's hidden form select is not a UI.
            await account.click();
            const individual = page.getByRole('option').filter({ hasText: /\[證\]/ }).first();
            await individual.click();
            await selectChoice(account, '全部帳戶');
            if (scale === '標準') {
                const suffix = theme === '淺色' ? 'light' : 'dark';
                await page.screenshot({ animations: 'disabled', path: path.join(artifacts, `compact-controls-${suffix}.png`) });
                await account.locator('..').locator('..').screenshot({ animations: 'disabled', path: path.join(artifacts, `equal-height-account-${suffix}.png`) });
            }
        }
    }
    await settingsButton.click();
    await settings.getByRole('radio', { name: '深色', exact: true }).click();
    await settings.getByRole('radio', { name: '標準', exact: true }).first().click();
    await page.keyboard.press('Escape');
}
async function flatThemeList(page, selectedName) {
    await expect(page.locator('[cmdk-group-heading]')).toHaveCount(0);
    await expect(page.locator('[cmdk-item][data-value="default"]')).toHaveCount(0);
    await expect(page.getByRole('option', { name: '預設', exact: true })).toHaveCount(0);
    await expect(page.locator('[cmdk-item][data-value="Absolutely"]')).toHaveCount(1);
    if (selectedName) await expect(page.locator(`[cmdk-item][data-value="${selectedName}"] .lucide-check`)).toHaveCount(1);
}
async function themeControls(page, settings, artifacts) {
    const trigger = settings.getByRole('combobox', { name: '主題', exact: true });
    const appearance = settings.getByRole('region', { name: '視覺風格', exact: true });
    const accent = settings.getByLabel('強調色顏色');
    const source = settings.getByRole('combobox', { name: '強調色來源', exact: true });
    await source.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('listbox')).toBeVisible();
    const presetOption = page.getByRole('option', { name: '主題預設', exact: true });
    expect(await presetOption.evaluate(el => {
        const r = el.getBoundingClientRect(), hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return hit === el || el.contains(hit);
    })).toBe(true);
    await page.screenshot({ path: path.join(artifacts, 'settings-select-popup.png') });
    await page.keyboard.press('Escape');
    await expect(page.getByRole('listbox')).toBeHidden();
    await expect(settings).toBeVisible();
    await expect(source).toBeFocused();
    const cssToken = name => page.evaluate(name => getComputedStyle(document.documentElement).getPropertyValue(name).trim(), name);
    async function choosePreset(name, query = name) {
        await trigger.click();
        await page.getByRole('combobox', { name: '搜尋主題', exact: true }).fill(query);
        await page.locator(`[cmdk-item][data-value="${name}"]`).click();
        await expect(trigger).toHaveAttribute('aria-expanded', 'false');
        await expect(trigger).toBeFocused();
    }
    await expect(trigger).toHaveText('AaAbsolutely');
    await trigger.click();
    await flatThemeList(page, 'Absolutely');
    await page.getByRole('combobox', { name: '搜尋主題', exact: true }).fill('Raycast');
    await expect(page.locator('[cmdk-item][data-value="Raycast"]')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(settings).toBeVisible();
    await expect(trigger).toBeFocused();
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');

    async function expectModeThemes(colorScheme, selectedName) {
        await trigger.click();
        await flatThemeList(page, selectedName);
        await expect(page.locator('[cmdk-item][data-value="Proof"]')).toHaveCount(colorScheme === 'light' ? 1 : 0);
        await expect(page.locator('[cmdk-item][data-value="Dracula"]')).toHaveCount(colorScheme === 'dark' ? 1 : 0);
        await expect(page.getByText('Codex 主題', { exact: true })).toHaveCount(0);
        await page.keyboard.press('Escape');
        await expect(trigger).toBeFocused();
    }

    // Named themes and the preferred mode are separate selections. A system
    // change updates CSS tokens and the saved mode remains system.
    await settings.getByRole('radio', { name: '深色', exact: true }).click();
    await choosePreset('GitHub', 'github dark');
    await expect.poll(() => cssToken('--background')).toBe('#0d1117');
    await expectModeThemes('dark');
    await settings.getByRole('radio', { name: '淺色', exact: true }).click();
    await expect.poll(() => cssToken('--background')).toBe('#ffffff');
    await expectModeThemes('light');
    await expect(trigger).toHaveText('AaGitHub');
    await settings.getByRole('radio', { name: '跟隨系統', exact: true }).click();
    for (const [colorScheme, background] of [['dark', '#0d1117'], ['light', '#ffffff']]) {
        await page.emulateMedia({ colorScheme });
        await expect.poll(() => cssToken('--background')).toBe(background);
        await expect.poll(() => page.evaluate(() => document.documentElement.style.colorScheme)).toBe(colorScheme);
        await expect(settings.getByRole('radio', { name: '跟隨系統', exact: true })).toHaveAttribute('aria-checked', 'true');
        await expectModeThemes(colorScheme);
    }
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('sj-pro-theme')))).toMatchObject({ mode: 'system', preset: 'GitHub' });

    await settings.getByRole('radio', { name: '淺色', exact: true }).click();
    await choosePreset('Proof');
    await expect.poll(() => cssToken('--background')).toBe('#f5f3ed');
    await accent.fill('#3d755d');
    await expect(source).toHaveText('自訂');
    await expect.poll(() => cssToken('--primary')).toBe('#3d755d');
    await expect(trigger).toHaveText('AaProof');
    await selectChoice(source, '主題預設');
    await expect(accent).toHaveValue('#3b715a');
    await expect.poll(() => cssToken('--primary')).toBe('#3b715a');
    await accent.fill('#3d755d');

    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
    await settings.getByRole('button', { name: '複製主題', exact: true }).click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText()).then(text => JSON.parse(text))).toMatchObject({ base: 'light', background: '#f5f3ed', accent: '#3d755d' });
    const copied = page.locator('[data-sonner-toast]').filter({ hasText: '已複製主題配色' });
    await expect(copied).toBeVisible();
    await expect(copied).toBeHidden({ timeout: 10000 });
    const downloadPromise = page.waitForEvent('download');
    await settings.getByRole('button', { name: '匯出主題', exact: true }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe('fubon-theme-Proof-light.json');
    const exported = path.join(artifacts, download.suggestedFilename());
    await download.saveAs(exported);
    expect(JSON.parse(await readFile(exported, 'utf8'))).toMatchObject({ base: 'light', background: '#f5f3ed', accent: '#3d755d' });

    for (const [width, height, suffix] of [[1440, 1000, 'desktop'], [390, 844, 'narrow']]) {
        await page.setViewportSize({ width, height });
        await appearance.scrollIntoViewIfNeeded();
        expect(await settings.getByRole('tabpanel').evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
        for (const control of await appearance.locator('button, input').all()) {
            const within = await control.evaluate(el => {
                const rect = el.getBoundingClientRect();
                const region = el.closest('section').getBoundingClientRect();
                return rect.left >= region.left - 1 && rect.right <= region.right + 1;
            });
            expect(within).toBe(true);
        }
        await appearance.screenshot({ animations: 'disabled', path: path.join(artifacts, `theme-controls-${suffix}.png`) });
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await settings.getByRole('radio', { name: '深色', exact: true }).click();
    await expect(settings.getByRole('status').filter({ hasText: '沒有深色版本' })).toBeVisible();
    await expect(trigger).toHaveText('AaAbsolutely');
    await expect.poll(() => cssToken('--background')).toBe('#2d2d2b');
    await expectModeThemes('dark', 'Absolutely');
    await settings.getByRole('radio', { name: '淺色', exact: true }).click();
    await expect.poll(() => cssToken('--background')).toBe('#f5f3ed');
    await expect(trigger).toHaveText('AaProof');
    await choosePreset('Absolutely');
    await settings.getByRole('radio', { name: '淺色', exact: true }).click();
    await expect(trigger).toHaveText('AaAbsolutely');
    await expect.poll(() => cssToken('--background')).toBe('#f9f9f7');
    await expect(source).toHaveText('自訂');
    await expect(accent).toHaveValue('#3d755d');
    await expect.poll(() => cssToken('--primary')).toBe('#3d755d');
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('sj-pro-theme')).accent)).toBe('#3d755d');
    await selectChoice(source, '主題預設');
    await expect.poll(() => cssToken('--primary')).toBe('#9e5035');
    expect((await page.evaluate(() => JSON.parse(localStorage.getItem('sj-pro-theme')))).preset).toBeUndefined();
    for (const [width, height, suffix] of [[1440, 1000, 'desktop'], [390, 844, 'narrow']]) {
        await page.setViewportSize({ width, height });
        await appearance.scrollIntoViewIfNeeded();
        await trigger.click();
        await flatThemeList(page, 'Absolutely');
        await expect(page.locator('[cmdk-item][data-value="Proof"]')).toBeVisible();
        await expect(page.locator('[cmdk-item][data-value="Dracula"]')).toHaveCount(0);
        await settings.screenshot({ animations: 'disabled', path: path.join(artifacts, `theme-menu-${suffix}.png`) });
        await page.keyboard.press('Escape');
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.emulateMedia({ colorScheme: null });
}
async function resizeCorners(page, artifacts, theme) {
    const item = page.locator('.react-grid-item').filter({ has: page.locator('[data-slot="card-header"][data-layout="panel"]').filter({ hasText: 'K 線圖' }) }).first();
    const handle = item.locator('.react-resizable-handle-se');
    await handle.scrollIntoViewIfNeeded();
    const frame = await handle.boundingBox();
    const pointer = { x: frame.x + frame.width / 2, y: frame.y + frame.height / 2 };
    await page.mouse.move(pointer.x, pointer.y);
    await page.mouse.down();
    try {
        // Shrink within its cell so collision compaction does not move neighbours.
        await page.mouse.move(pointer.x - 40, pointer.y - 32, { steps: 5 });
        await expect(item).toHaveClass(/\bresizing\b/);
        const placeholder = page.locator('.react-grid-placeholder');
        await expect(placeholder).toBeVisible();
        const radius = await item.locator('[data-slot="card"]').evaluate(el => getComputedStyle(el).borderRadius);
        expect(parseFloat(radius)).toBeGreaterThan(0);
        await expect(item).toHaveCSS('border-radius', radius);
        await expect(placeholder).toHaveCSS('border-radius', radius);
        await expect(item).not.toHaveCSS('box-shadow', 'none');
        const active = await item.boundingBox();
        await page.screenshot({ animations: 'disabled', path: path.join(artifacts, `resize-${theme}.png`), clip: {
            x: active.x + active.width - 100, y: active.y + active.height - 80, width: 130, height: 110,
        } });
    } finally {
        // Restore the fixture's size so the theme/layout comparisons stay meaningful.
        await page.mouse.move(pointer.x, pointer.y, { steps: 5 });
        await page.mouse.up();
    }
    await expect(item).not.toHaveClass(/\bresizing\b/);
    await expect(page.locator('.react-grid-placeholder')).toHaveCount(0);
}
async function textBounds(locator, { clamp = false } = {}) {
    return locator.evaluate((el, clamp) => {
        const bounds = el.getBoundingClientRect();
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        for (let node; (node = walker.nextNode());) {
            if (!node.textContent.trim()) continue;
            const range = document.createRange(); range.selectNodeContents(node);
            for (const line of range.getClientRects()) {
                if (line.left < bounds.left - 1 || line.right > bounds.right + 1 ||
                    (!clamp && (line.top < bounds.top - 1 || line.bottom > bounds.bottom + 1))) return false;
            }
        }
        return true;
    }, clamp);
}
async function panelPickerLayout(page, artifacts) {
    for (const [width, columns] of [[1440, 3], [640, 2], [390, 1]]) {
        await page.setViewportSize({ width, height: 1000 });
        await page.getByRole('button', { name: /新增面板/ }).first().click();
        const picker = page.getByRole('dialog', { name: '新增面板', exact: true });
        const frame = await picker.boundingBox();
        expect(frame.width).toBeCloseTo(Math.min(760, width - 32), 0);
        expect(frame.y).toBeCloseTo(100, 0);
        const search = picker.getByPlaceholder('搜尋面板（名稱或用途）');
        expect((await search.boundingBox()).width).toBeGreaterThan(200);
        const cards = picker.locator('button[data-idx]');
        const count = await cards.count();
        expect(count).toBeGreaterThan(20);
        expect(await cards.first().evaluate(el => getComputedStyle(el.parentElement).gridTemplateColumns.split(' ').length)).toBe(columns);
        for (const card of await cards.all()) {
            await expect(card).toHaveCSS('display', 'grid');
            await expect(card).toHaveCSS('text-align', 'left');
            expect(await card.evaluate(el => {
                const bounds = el.getBoundingClientRect();
                const [icon, text, go] = [...el.children].map(child => child.getBoundingClientRect());
                return icon.left >= bounds.left && icon.right <= text.left && text.right <= bounds.right && (!go || text.right <= go.left);
            })).toBe(true);
        }
        if (width === 1440) await picker.screenshot({ path: path.join(artifacts, 'panel-picker-light.png') });
        const category = picker.locator('button[aria-expanded]').first();
        await category.click();
        await expect(category).toHaveAttribute('aria-expanded', 'false');
        expect(await cards.count()).toBeLessThan(count);
        await category.click();
        await expect(cards).toHaveCount(count);
        await search.fill('K 線圖');
        await expect(cards).toHaveCount(1);
        await page.keyboard.press('ArrowDown');
        await page.keyboard.press('Escape');
        await expect(picker).toBeHidden();
    }
}
async function settingsScrollbarSpacing(page, artifacts) {
    for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: 1000 });
        await page.getByRole('button', { name: '設定', exact: true }).click();
        const settings = page.getByRole('dialog', { name: '設定', exact: true });
        for (const name of ['外觀', '音效與隱私', '帳號', '風控', 'Agent', '版面']) {
            const tab = settings.getByRole('tab', { name, exact: true });
            await tab.focus(); await tab.click();
            if (name === '外觀') {
                await settingsPreferenceLayout(settings, width <= 640);
                if (width === 390) await settings.screenshot({ animations: 'disabled', path: path.join(artifacts, 'settings-layout-narrow.png') });
            }
            const spacing = await settings.getByRole('tabpanel').evaluate(el => {
                const rect = el.getBoundingClientRect();
                const style = getComputedStyle(el);
                const gutter = el.offsetWidth - el.clientWidth - parseFloat(style.borderLeftWidth) - parseFloat(style.borderRightWidth);
                const scrollbar = parseFloat(getComputedStyle(el, '::-webkit-scrollbar').width) || 0;
                const overlay = el.scrollHeight > el.clientHeight ? Math.max(0, scrollbar - gutter) : 0;
                const edges = [...el.children].map(child => child.getBoundingClientRect()).filter(r => r.width > 0);
                const right = Math.max(...edges.map(r => r.right));
                return { gap: rect.left + el.clientLeft + el.clientWidth - overlay - right, horizontalOverflow: el.scrollWidth - el.clientWidth };
            });
            expect(spacing.gap).toBeGreaterThanOrEqual(8);
            expect(spacing.horizontalOverflow).toBeLessThanOrEqual(1);
            if (name === '風控' && width === 1440) await settings.screenshot({ path: path.join(artifacts, 'settings-risk-spacing.png') });
        }
        await page.keyboard.press('Escape');
        await expect(settings).toBeHidden();
    }
}
async function notificationHeaderClearance(page) {
    const settingsButton = page.getByRole('button', { name: '設定', exact: true });
    const settings = page.getByRole('dialog', { name: '設定', exact: true });
    for (const [width, scale] of [[1440, '標準'], [390, '大']]) {
        await page.setViewportSize({ width, height: 1000 });
        await settingsButton.click();
        await settings.getByRole('tab', { name: '外觀', exact: true }).click();
        await settings.getByRole('radio', { name: scale, exact: true }).first().click();
        await page.keyboard.press('Escape');
        await page.getByRole('button', { name: '版面', exact: true }).click();
        const library = page.getByRole('dialog', { name: '版面庫', exact: true });
        await library.getByPlaceholder('儲存目前版面 — 輸入名稱').fill(`通知位置驗收 ${width}`);
        await library.getByRole('button', { name: '儲存', exact: true }).click();
        await page.keyboard.press('Escape');
        const notice = page.locator('[data-sonner-toast]').filter({ hasText: '版面已儲存' }).last();
        await expect(notice).toBeVisible();
        await expect.poll(async () => {
            const header = await page.locator('header').boundingBox();
            const bounds = await notice.boundingBox();
            return bounds.y - header.y - header.height;
        }).toBeGreaterThanOrEqual(7);
        // A visible notification must not defer the click until it expires.
        await settingsButton.click({ timeout: 2000 });
        await expect(settings).toBeVisible();
        await page.keyboard.press('Escape');
        await notice.locator('[data-close-button]').click();
    }
}
async function multilineButtons(page, artifacts) {
    // Exercise the same long unsigned-account copy as the reported screenshot.
    // The account response belongs only to this temporary browser context.
    await page.route('**/api/v1/auth/accounts', async route => {
        const response = await route.fetch();
        const accounts = (await response.json()).map(account => ({ ...account, signed: false, username: '富邦行情／本機模擬帳戶' }));
        await route.fulfill({ response, json: accounts });
    });
    const settingsButton = page.getByRole('button', { name: '設定', exact: true });
    const settings = page.getByRole('dialog', { name: '設定', exact: true });
    await settingsButton.click();
    await settings.getByRole('tab', { name: '音效與隱私' }).click();
    const privacy = settings.getByRole('switch', { name: '帳號遮蔽' });
    if (await privacy.getAttribute('aria-checked') === 'true') await privacy.click();
    for (const theme of ['深色', '淺色']) {
        for (const scale of ['標準', '大']) {
            for (const width of [720, 390]) {
                await page.setViewportSize({ width, height: 1000 });
                await settings.getByRole('tab', { name: '外觀' }).focus();
                await page.keyboard.press('Home');
                await settings.getByRole('tab', { name: '外觀' }).click();
                await settings.getByRole('radio', { name: theme, exact: true }).click();
                await settings.getByRole('radio', { name: scale, exact: true }).first().click();
                await settings.getByRole('tab', { name: '帳號', exact: true }).click();
                const dialogLayout = await settings.evaluate(el => {
                    const bounds = el.getBoundingClientRect();
                    const rootSize = parseFloat(getComputedStyle(document.documentElement).fontSize);
                    return { width: bounds.width, expected: innerWidth <= 640 ? innerWidth - 24 : Math.min(50 * rootSize, innerWidth - 32), center: bounds.top + bounds.height / 2, viewportCenter: innerHeight / 2, padding: parseFloat(getComputedStyle(el.querySelector('[role="tabpanel"]')).paddingTop) };
                });
                expect(dialogLayout.width).toBeCloseTo(dialogLayout.expected, 0);
                expect(dialogLayout.center).toBeCloseTo(dialogLayout.viewportCenter, 0);
                expect(dialogLayout.padding).toBeGreaterThan(0);
                await settings.getByRole('button', { name: '重新整理帳號', exact: true }).click();
                const accounts = settings.locator('button[aria-pressed]');
                await expect(accounts).toHaveCount(2);
                for (const account of await accounts.all()) {
                    await expect(account.locator(':scope > span')).toHaveCount(2);
                    await expect.poll(() => textBounds(account)).toBe(true);
                }
                if (theme === '淺色' && scale === '大' && width === 720) await settings.screenshot({ path: path.join(artifacts, 'accounts-light.png') });
                await page.keyboard.press('Escape');
                await expect(settings).toBeHidden();
                await page.getByRole('button', { name: '版面', exact: true }).click();
                const library = page.getByRole('dialog', { name: '版面庫', exact: true });
                expect((await library.boundingBox()).width).toBeCloseTo(Math.min(680, width - 32), 0);
                const cards = library.locator('button[title^="套用預設版面"]');
                expect(await cards.count()).toBeGreaterThan(10);
                for (const card of await cards.all()) {
                    await expect(card).toHaveCSS('flex-direction', 'column');
                    await expect.poll(() => textBounds(card, { clamp: true })).toBe(true);
                    await expect(card.locator(':scope > span').last()).toHaveCSS('white-space', 'normal');
                }
                if (theme === '淺色' && scale === '大' && width === 720) await library.screenshot({ path: path.join(artifacts, 'layouts-light.png') });
                await page.keyboard.press('Escape');
                await expect(library).toBeHidden();
                await settingsButton.click();
            }
        }
    }
    await page.keyboard.press('Escape');
    await page.unroute('**/api/v1/auth/accounts');
}
async function selectPrimitiveChecks(context, coarse = false) {
    // Load the actual source component in an isolated Vite page. This covers
    // edge values absent from the demo account data without changing product code.
    const fixture = await context.newPage();
    try {
        const session = await page.evaluate(() => sessionStorage.getItem('fubon-trading-session'));
        await fixture.addInitScript(value => sessionStorage.setItem('fubon-trading-session', value), session);
        await fixture.goto(origin);
        await fixture.waitForFunction(() => !!document.querySelector('[data-slot="card"]'));
        await fixture.evaluate(async () => {
            const reactModule = await import('/node_modules/.vite/deps/react.js');
            const React = reactModule.default ?? reactModule;
            const domModule = await import('/node_modules/.vite/deps/react-dom_client.js');
            const createRoot = domModule.createRoot ?? domModule.default.createRoot;
            const { SelectControl, SelectOption, SelectOptionGroup } = await import('/src/components/ui/select-control.tsx');
            const h = React.createElement;
            window.__qaSelectChanges = [];
            window.__qaTicketActions = [];
            window.addEventListener('sj-ticket-action', event => window.__qaTicketActions.push(event.detail));
            function Harness() {
                const [value, setValue] = React.useState(0);
                return h('div', { id: 'qa-select-fixture', tabIndex: 0, style: { position: 'fixed', inset: 20, padding: 20, background: 'var(--background)', zIndex: 1 } },
                    h(SelectControl, { 'aria-label': 'QA 月份', value, onValueChange: next => { window.__qaSelectChanges.push(next); setValue(next); } },
                        h(SelectOption, { value: '' }, '跟隨主畫面'),
                        h(SelectOptionGroup, { label: '到期月份' },
                            h(SelectOption, { value: 0 }, '近月'), h(SelectOption, { value: 202612 }, '十二月'))),
                    h(SelectControl, { 'aria-label': 'QA 長商品選單', defaultValue: 0 },
                        Array.from({ length: 70 }, (_, i) => h(SelectOption, { key: i, value: i, disabled: i === 1 }, `商品 ${i}`))),
                    h(SelectControl, { 'aria-label': 'QA 禁用帳戶', disabled: true, value: 'F' }, h(SelectOption, { value: 'F' }, '期貨')));
            }
            const mount = document.createElement('div'); document.body.append(mount); createRoot(mount).render(h(Harness));
        });
        const month = fixture.getByRole('combobox', { name: 'QA 月份', exact: true });
        await expect(month).toHaveText('近月');
        expect(await month.evaluate(el => el.tagName)).toBe('BUTTON');
        expect((await month.boundingBox()).height).toBeGreaterThanOrEqual(coarse ? 44 : 24);
        await month.click();
        await expect(fixture.getByRole('group', { name: '到期月份', exact: true })).toBeVisible();
        await fixture.getByRole('option', { name: '十二月', exact: true }).click();
        await expect(month).toHaveText('十二月');
        await month.click(); await fixture.getByRole('option', { name: '跟隨主畫面', exact: true }).click();
        await expect(month).toHaveText('跟隨主畫面');
        expect(await fixture.evaluate(() => window.__qaSelectChanges)).toEqual(['202612', '']);
        const long = fixture.getByRole('combobox', { name: 'QA 長商品選單', exact: true });
        await long.focus(); await fixture.keyboard.press('Enter');
        await expect(fixture.getByRole('option', { name: '商品 0', exact: true })).toBeFocused();
        await expect(fixture.getByRole('option', { name: '商品 1', exact: true })).toHaveAttribute('data-disabled');
        await fixture.keyboard.press('ArrowDown');
        await expect(fixture.getByRole('option', { name: '商品 2', exact: true })).toBeFocused();
        await fixture.keyboard.press('Enter');
        await expect(long).toHaveText('商品 2');
        await long.focus(); await fixture.keyboard.press('Enter');
        await expect(fixture.getByRole('listbox')).toBeVisible();
        await fixture.keyboard.press('b'); await fixture.keyboard.press('s');
        expect(await fixture.evaluate(() => window.__qaTicketActions)).toEqual([]);
        await fixture.keyboard.press('End');
        const last = fixture.getByRole('option', { name: '商品 69', exact: true });
        await expect(last).toBeInViewport();
        expect(await fixture.locator('[data-radix-select-viewport]').evaluate(el => el.scrollTop)).toBeGreaterThan(0);
        expect((await last.boundingBox()).height).toBeGreaterThanOrEqual(coarse ? 44 : 24);
        await fixture.screenshot({ path: path.join(artifacts, `select-long-${coarse ? 'touch' : 'desktop'}.png`) });
        await fixture.keyboard.press('Enter'); await expect(long).toHaveText('商品 69');
        await long.click(); await fixture.keyboard.press('Escape'); await expect(long).toBeFocused();
        const disabled = fixture.getByRole('combobox', { name: 'QA 禁用帳戶', exact: true });
        await expect(disabled).toBeDisabled();
        await disabled.dispatchEvent('pointerdown');
        await expect(fixture.getByRole('listbox')).toBeHidden();
        await expect(fixture.locator('select:not([aria-hidden="true"])')).toHaveCount(0);
        // Confirm this page has the real global hotkey handler before asserting
        // that a focused Select consumes the same alphabetic key.
        await fixture.locator('#qa-select-fixture').focus(); await fixture.keyboard.press('b');
        expect(await fixture.evaluate(() => window.__qaTicketActions)).toEqual([{ action: 'Buy' }]);
        await fixture.evaluate(() => { window.__qaTicketActions = []; });
        await long.focus(); await fixture.keyboard.press('s');
        expect(await fixture.evaluate(() => window.__qaTicketActions)).toEqual([]);
    } catch (error) {
        await fixture.screenshot({ path: path.join(artifacts, `select-failure-${coarse ? 'touch' : 'desktop'}.png`) });
        throw error;
    } finally { await fixture.close(); }
}
let cleanupPromise;
function cleanup() {
    return cleanupPromise ??= (async () => {
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
try {
    await free(uiPort); await free(apiPort);
    const backend = path.join(temporary, 'backend.py');
    await writeFile(backend, `import os,json\nfrom pathlib import Path\nimport uvicorn\nfrom fubon_bridge.app import create_app\nfrom fubon_bridge.config import Config\nfrom fubon_bridge.passkeys import PasskeyStore\nfrom fubon_bridge.research import ResearchStore\ncount=Path(os.environ['SHADCN_SDK_COUNT'])\ncount.write_text('0')\ndef no_sdk():\n    count.write_text(str(int(count.read_text())+1))\n    raise AssertionError('QA must not initialize brokerage SDK')\napp = create_app(Config(mode='demo', port=int(os.environ['SHADCN_UI_PORT'])), sdk_factory=no_sdk, launch_token=os.environ['SHADCN_LAUNCH'], public_origin=os.environ['SHADCN_ORIGIN'], passkey_store=PasskeyStore(os.environ['SHADCN_DATABASE']), research_store=ResearchStore(os.environ['SHADCN_RESEARCH_DATABASE']))\nuvicorn.run(app, host='127.0.0.1', port=int(os.environ['SHADCN_API_PORT']), access_log=False)\n`);
    run(process.env.SHADCN_PYTHON || path.join(root, 'server', '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'), [backend], {
        PYTHONPATH: path.join(root, 'server'), SHADCN_UI_PORT: String(uiPort), SHADCN_API_PORT: String(apiPort),
        SHADCN_LAUNCH: token, SHADCN_ORIGIN: origin, SHADCN_DATABASE: path.join(temporary, 'passkeys.sqlite3'),
        SHADCN_RESEARCH_DATABASE: path.join(temporary, 'research.sqlite3'), SHADCN_SDK_COUNT: path.join(temporary, 'sdk-count'),
    });
    run(process.execPath, [path.join(root, 'node_modules/vite/bin/vite.js'), '--host' , '127.0.0.1', '--port', String(uiPort), '--strictPort'], {
        VITE_API_TARGET: `http://127.0.0.1:${apiPort}`, VITE_API_BASE: '', VITE_STREAM_BASE: origin,
        VITE_DEV_SERVER_PORT: '',
    });
    await ready(`http://127.0.0.1:${apiPort}/api/v1/passkeys/status`); await ready(origin);
    // Keep scrollbars visible so spacing and screenshots include their real gutter.
    browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true, ignoreDefaultArgs: ['--hide-scrollbars'] });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    page = await context.newPage();
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.route('**/api/v1/order/**', async route => {
        const pathname = new URL(route.request().url()).pathname;
        if (route.request().method() !== 'GET' && !/\/(trades|trade_cache_health)$/.test(pathname)) {
            mutations.push(pathname); return route.abort('blockedbyclient');
        }
        return route.continue();
    });
    const cdp = await context.newCDPSession(page);
    await cdp.send('WebAuthn.enable');
    await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
    await page.goto(`${origin}/#fubon-launch=${token}`);
    // A cold Vite transform can outlast the default assertion timeout.
    await expect(page.getByRole('button', { name: '建立 Passkey 並解鎖' })).toBeVisible({ timeout: 30000 });
    expect(await page.locator('[data-slot="card-header"][data-layout="default"]').evaluate(el => getComputedStyle(el).flexDirection)).toBe('column');
    await page.screenshot({ animations: 'disabled', path: path.join(artifacts, 'passkey.png') });
    await page.getByRole('button', { name: '建立 Passkey 並解鎖' }).click();
    await expect(page.getByRole('status').filter({ hasText: '展示模式' })).toBeVisible({ timeout: 30000 });
    await expect(page.getByText('LIVE', { exact: true })).toBeVisible();
    await workspaceRulerChecks(page, artifacts);
    await workspaceResizeChecks(browser, page, origin, artifacts);
    await workspaceScrollChecks(browser, page, origin, artifacts);
    await workspaceDragAlignmentChecks(browser, page, origin, artifacts);
    await chartPaneChecks(browser, page, origin, artifacts);
    const indicatorContext = await browser.newContext({ viewport: { width: 1100, height: 850 } });
    try { await indicatorSettingsChecks(await indicatorContext.newPage(), origin, artifacts); }
    finally { await indicatorContext.close(); }
    await maLegendChecks(browser, page, origin, artifacts);
    await selectPrimitiveChecks(context);
    const touch = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    await selectPrimitiveChecks(touch, true); await touch.close();
    await expect(page.locator('select:not([aria-hidden="true"])')).toHaveCount(0);
    // Guard the visible shadcn treatment, rather than only checking imports.
    expect(await page.locator('[data-slot="card"]').count()).toBeGreaterThanOrEqual(6);
    // Reproduce HMR loading utility CSS after the panel's vanilla-extract CSS.
    // Real utility rules are replayed so default CardHeader layout cannot win
    // merely because a stylesheet was loaded last.
    await page.evaluate(() => {
        const lateRules = new Set();
        const visit = rules => {
            for (const rule of rules) {
                if (['.flex-col', '.inline-flex', '.p-6', '.p-0', '.w-full', '.items-center', '.justify-center', '.whitespace-nowrap', '.h-9', '.px-3', '.py-1', '.py-2', '.pr-9', '.text-sm', '.text-base'].includes(rule.selectorText) || rule.selectorText?.startsWith('.top-')) lateRules.add(rule.cssText);
                if (rule.cssRules) visit(rule.cssRules);
            }
        };
        for (const sheet of document.styleSheets) {
            try { visit(sheet.cssRules); } catch { /* External font sheet. */ }
        }
        if (lateRules.size < 2) throw new Error('Missing utility CSS for load-order regression check.');
        const style = document.createElement('style');
        style.textContent = [...lateRules].join('\n');
        document.head.append(style);
    });
    await panelHeaders(page);
    const addButton = page.getByRole('button', { name: /新增面板/ }).first();
    await expect(addButton).toHaveAttribute('data-variant', 'default');
    // Preserve the existing dense desktop toolbar instead of enlarging it.
    expect((await addButton.boundingBox()).height).toBeLessThan(30);
    const ticket = page.locator('[data-slot="card"]').filter({ hasText: '下單面板' }).first();
    const priceInput = ticket.locator('[data-slot="input"]').first();

    await expect(ticket.getByRole('button', { name: '買進 Buy', exact: true })).toHaveAttribute('data-variant', 'buy');
    await tradeContrast(ticket);
    await expect(priceInput).toHaveValue(/\d/);
    await compactFormControls(page, artifacts);
    const geometry = await panelGeometry(page);
    await resizeCorners(page, artifacts, 'dark');
    await expect.poll(() => panelGeometry(page)).toEqual(geometry);
    const resize = page.locator('.react-resizable-handle-se').first();
    expect(await resize.boundingBox()).toMatchObject({ width: 20, height: 20 });
    const corner = await resize.evaluate(el => {
        const handle = getComputedStyle(el, '::after');
        const panel = getComputedStyle(el.parentElement.querySelector('[data-slot="card"]'));
        return { inset: parseFloat(handle.right), radius: parseFloat(handle.borderBottomRightRadius), panelRadius: parseFloat(panel.borderBottomRightRadius) };
    });
    expect(corner.inset + corner.radius).toBeCloseTo(corner.panelRadius, 1);
    const watch = page.locator('[data-slot="card"]').filter({ hasText: '自選清單' }).first();
    const deleteList = watch.locator('button[data-variant="destructive"]:visible').first();
    expect(await deleteList.evaluate(el => getComputedStyle(el).backgroundColor)).not.toBe('rgba(0, 0, 0, 0)');
    expect(await textContrast(deleteList)).toBeGreaterThanOrEqual(4.5);
    await watch.getByTitle('調整順序（拖曳或上下移，存回伺服器）').click();
    const row = watch.locator('[data-code]').first();
    const rowFrame = await row.boundingBox();
    for (const name of ['上移', '下移']) {
        const frame = await row.getByTitle(name, { exact: true }).boundingBox();
        expect(frame.height).toBe(15);
        expect(frame.y).toBeGreaterThanOrEqual(rowFrame.y);
        expect(frame.y + frame.height).toBeLessThanOrEqual(rowFrame.y + rowFrame.height);
    }
    await watch.getByTitle('完成調整').click();
    // Dense dark labels, control boundaries and prices must remain readable in
    // their real composited states, including the depth bar behind each price.
    await expect.poll(() => textContrast(ticket.getByText('價格', { exact: true }))).toBeGreaterThanOrEqual(4.5);
    expect(await textContrast(priceInput, { property: 'borderTopColor' })).toBeGreaterThanOrEqual(3);
    const depth = page.locator('[data-slot="card"]').filter({ hasText: '五檔' }).first();
    const depthRow = depth.getByText('BID', { exact: true }).locator('..').locator('xpath=following-sibling::div[1]');
    await depthRow.hover();
    for (const price of await depthRow.locator(':scope > div > span').all()) {
        await expect.poll(() => textContrast(price, { behindBar: true })).toBeGreaterThanOrEqual(4.5);
    }
    await addButton.hover();
    await page.screenshot({ animations: 'disabled', path: path.join(artifacts, 'terminal-dark.png') });

    const settingsButton = page.getByRole('button', { name: '設定', exact: true });
    await settingsButton.click();
    const settings = page.getByRole('dialog', { name: '設定', exact: true });
    const frame = await settings.boundingBox();
    const tab = await settings.getByRole('tab', { name: '外觀' }).boundingBox();
    expect(tab.y).toBeGreaterThanOrEqual(frame.y);
    expect(tab.y + tab.height).toBeLessThanOrEqual(frame.y + frame.height);
    await expect(settings.getByRole('tab', { name: '外觀' })).toHaveAttribute('aria-selected', 'true');
    expect(await settings.getByRole('tab', { name: '外觀' }).evaluate(el => getComputedStyle(el).boxShadow)).not.toBe('none');
    await page.screenshot({ animations: 'disabled', path: path.join(artifacts, 'settings-dark.png') });
    for (const label of ['小', '大', '標準']) {
        await settings.getByRole('radio', { name: label, exact: true }).first().click();
        await switchGeometry(settings);
    }
    await settings.getByRole('tab', { name: '外觀' }).focus();
    await page.keyboard.press('ArrowDown');
    await expect(settings.getByRole('tab', { name: '音效與隱私' })).toHaveAttribute('aria-selected', 'true');
    await expect.poll(() => settings.getByRole('tab', { name: '音效與隱私' }).evaluate(el => getComputedStyle(el).boxShadow)).toContain('rgb(224, 161, 132)');
    await settings.getByRole('switch', { name: '帳號遮蔽' }).click();
    await expect(settings.getByRole('switch', { name: '帳號遮蔽' })).toHaveAttribute('aria-checked', 'true');
    await switchGeometry(settings);
    await settings.getByRole('tab', { name: '風控' }).click();
    const confirm = settings.getByRole('switch', { name: '手動下單確認' });
    if (await confirm.getAttribute('aria-checked') !== 'true') await confirm.click();
    await settings.getByRole('tab', { name: '外觀' }).click();
    await settings.getByRole('radio', { name: '淺色', exact: true }).click();
    await expect(settings.getByRole('radio', { name: '淺色', exact: true })).toHaveAttribute('data-state', 'on');
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--background').trim())).toBe('#f9f9f7');
    await expect.poll(() => settings.getByRole('radio', { name: '淺色', exact: true }).evaluate(el => getComputedStyle(el).color)).toBe('rgb(45, 45, 43)');
    await page.screenshot({ animations: 'disabled', path: path.join(artifacts, 'settings-light.png') });
    await page.keyboard.press('Escape'); await expect(settings).toBeHidden();
    await tradeContrast(ticket);
    await expect.poll(() => panelGeometry(page)).toEqual(geometry);
    await page.screenshot({ animations: 'disabled', path: path.join(artifacts, 'terminal-light.png') });
    await panelHeaders(page);
    const chartHeader = page.locator('[data-slot="card-header"][data-layout="panel"]').filter({ hasText: 'K 線圖' }).first();
    await chartHeader.screenshot({ animations: 'disabled', path: path.join(artifacts, 'panel-header.png') });
    await resizeCorners(page, artifacts, 'light');
    await expect.poll(() => panelGeometry(page)).toEqual(geometry);
    await settingsButton.click();
    await themeControls(page, settings, artifacts);
    await settings.getByRole('button', { name: '進階配色', exact: true }).click();
    const accent = settings.getByLabel('強調色顏色');
    await accent.fill('#c080ff');
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--primary').trim())).toBe('#c080ff');
    // Native form controls must follow the chosen text color even if the custom
    // base remains dark and the user chooses a white panel.
    await settings.getByLabel('背景顏色').fill('#ffffff');
    await settings.getByLabel('面板顏色').fill('#ffffff');
    await settings.getByLabel('文字顏色').fill('#171717');
    await expect.poll(() => priceInput.evaluate(el => getComputedStyle(el).color)).toBe('rgb(23, 23, 23)');
    await settings.getByRole('radio', { name: '深色', exact: true }).click();
    await settings.getByRole('button', { name: '重設為預設配色', exact: true }).click();
    await expect(settings.getByRole('radio', { name: '深色', exact: true })).toHaveAttribute('data-state', 'on');
    await expect(settings.getByRole('combobox', { name: '主題', exact: true })).toHaveText('AaAbsolutely');
    await settings.getByRole('combobox', { name: '主題', exact: true }).click();
    await flatThemeList(page, 'Absolutely');
    await expect(page.locator('[cmdk-item][data-value="Dracula"]')).toBeVisible();
    await expect(page.locator('[cmdk-item][data-value="Proof"]')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape'); await expect(settings).toBeHidden();
    await expect(settingsButton).toBeFocused();

    const expandQuote = page.getByRole('button', { name: '報價統計', exact: true }).first();
    if (await expandQuote.getAttribute('aria-expanded') !== 'true') await expandQuote.click();
    await page.getByRole('button', { name: '自訂報價欄位' }).first().click();
    const quote = page.getByRole('dialog', { name: '報價欄位設定' });
    await expect(quote).toBeVisible();
    await quote.getByRole('tab', { name: '指數' }).click();
    await expect(quote.getByRole('tab', { name: '指數' })).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('Escape'); await expect(quote).toBeHidden();

    await page.getByRole('button', { name: /新增面板/ }).first().click();
    const library = page.getByRole('dialog', { name: '新增面板', exact: true });
    await library.getByPlaceholder('搜尋面板（名稱或用途）').fill('閃電下單');
    await library.getByRole('button', { name: /閃電下單/ }).first().click();
    await expect(library).toBeHidden();
    await page.getByTitle('跟隨自選清單選擇', { exact: true }).first().click();
    const linkMenu = page.getByRole('menu').filter({ has: page.getByRole('menuitemradio', { name: /群組 A/ }) });
    await expect(linkMenu).toBeVisible();
    await linkMenu.getByRole('menuitemradio', { name: /群組 A/ }).click();
    await expect(linkMenu).toBeHidden();

    await page.getByRole('button', { name: '買進下單', exact: true }).click();
    await page.getByRole('button', { name: /^確認買進 / }).click();
    const order = page.getByRole('dialog', { name: '委託確認', exact: true });
    await expect(order).toBeVisible();
    await expect(order.getByRole('button', { name: '取消', exact: true })).toBeFocused();
    await page.keyboard.press('Escape'); await expect(order).toBeHidden();
    // The verification opens and cancels a confirmation; it never confirms an order.
    await expect(page.getByRole('button', { name: /委託 Orders \[0\/0\]/ })).toBeVisible();

    await multilineButtons(page, artifacts);
    await settingsScrollbarSpacing(page, artifacts);
    await panelPickerLayout(page, artifacts);
    await page.setViewportSize({ width: 390, height: 844 });
    await settingsButton.click(); await expect(settings).toBeVisible();
    const mobileFrame = await settings.boundingBox();
    expect(mobileFrame.x).toBeGreaterThanOrEqual(0);
    expect(mobileFrame.x + mobileFrame.width).toBeLessThanOrEqual(391);
    await page.screenshot({ animations: 'disabled', path: path.join(artifacts, 'settings-narrow.png') });
    await page.keyboard.press('Escape');
    await notificationHeaderClearance(page);
    expect(errors).toEqual([]);
    const sdkCalls = Number(await readFile(path.join(temporary, 'sdk-count'), 'utf8'));
    expect(sdkCalls).toBe(0); expect(mutations).toEqual([]);
    const nativeUserControls = await page.locator('select:not([aria-hidden="true"])').count();
    expect(nativeUserControls).toBe(0);
    await writeFile(path.join(artifacts, 'summary.json'), JSON.stringify({ passed: true, sdkCalls, nativeUserControls, mutations, errors, artifacts }, null, 2));
    console.log(`UI acceptance passed: Passkey, LIVE demo stream, themes, focus, tabs, menus, order cancellation and narrow layout.\nScreenshots: ${artifacts}`);
} catch (error) {
    await page?.screenshot({ animations: 'disabled', path: path.join(artifacts, 'failure.png') }).catch(() => undefined);
    console.error(`Artifacts: ${artifacts}`);
    console.error(error);
    console.error(logs.replaceAll(token, '[redacted]'));
    process.exitCode = 1;
} finally {
    await cleanup();
}
