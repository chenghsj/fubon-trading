// Isolated browser acceptance: demo quotes, a temporary Passkey database and a
// virtual authenticator. Never reads Keychain or contacts a broker.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';

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
    await writeFile(backend, `import os\nimport uvicorn\nfrom fubon_bridge.app import create_app\nfrom fubon_bridge.config import Config\nfrom fubon_bridge.passkeys import PasskeyStore\napp = create_app(Config(mode='demo', port=int(os.environ['SHADCN_UI_PORT'])), launch_token=os.environ['SHADCN_LAUNCH'], public_origin=os.environ['SHADCN_ORIGIN'], passkey_store=PasskeyStore(os.environ['SHADCN_DATABASE']))\nuvicorn.run(app, host='127.0.0.1', port=int(os.environ['SHADCN_API_PORT']), access_log=False)\n`);
    run('uv', ['run', '--directory', 'server', 'python', backend], {
        PYTHONPATH: path.join(root, 'server'), SHADCN_UI_PORT: String(uiPort), SHADCN_API_PORT: String(apiPort),
        SHADCN_LAUNCH: token, SHADCN_ORIGIN: origin, SHADCN_DATABASE: path.join(temporary, 'passkeys.sqlite3'),
    });
    const uiEnvironment = { ...process.env, VITE_API_TARGET: `http://127.0.0.1:${apiPort}`, VITE_API_BASE: '', VITE_STREAM_BASE: origin, VITE_DEV_SERVER_PORT: '' };
    const build = run('pnpm', ['exec', 'vite', 'build'], uiEnvironment);
    await new Promise((resolve, reject) => {
        build.once('error', reject);
        build.once('exit', code => code === 0 ? resolve() : reject(new Error('Browser acceptance build failed.')));
    });
    run('pnpm', ['exec', 'vite', 'preview', '--host' , '127.0.0.1', '--port', String(uiPort), '--strictPort'], {
        VITE_API_TARGET: `http://127.0.0.1:${apiPort}`, VITE_API_BASE: '', VITE_STREAM_BASE: origin,
        VITE_DEV_SERVER_PORT: '',
    });
    await ready(`http://127.0.0.1:${apiPort}/api/v1/passkeys/status`); await ready(origin);
    browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    page = await context.newPage();
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    const cdp = await context.newCDPSession(page);
    await cdp.send('WebAuthn.enable');
    await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
    await page.goto(`${origin}/#fubon-launch=${token}`);
    await expect(page.getByRole('button', { name: '建立 Passkey 並解鎖' })).toBeVisible();
    await page.screenshot({ animations: 'disabled', path: path.join(artifacts, 'passkey.png') });
    await page.getByRole('button', { name: '建立 Passkey 並解鎖' }).click();
    await expect(page.getByRole('status').filter({ hasText: '展示模式' })).toBeVisible({ timeout: 30000 });
    await expect(page.getByText('LIVE', { exact: true })).toBeVisible();
    // Guard the visible shadcn treatment, rather than only checking imports.
    expect(await page.locator('[data-slot="card"]').count()).toBeGreaterThanOrEqual(6);
    const addButton = page.getByRole('button', { name: /新增面板/ }).first();
    await expect(addButton).toHaveAttribute('data-variant', 'default');
    // Preserve the existing dense desktop toolbar instead of enlarging it.
    expect((await addButton.boundingBox()).height).toBeLessThan(30);
    const ticket = page.locator('[data-slot="card"]').filter({ hasText: '下單面板' }).first();
    const priceInput = ticket.locator('[data-slot="input"]').first();

    await expect(ticket.getByRole('button', { name: '買進 Buy', exact: true })).toHaveAttribute('data-variant', 'buy');
    await tradeContrast(ticket);
    await expect(priceInput).toHaveValue(/\d/);
    const geometry = await panelGeometry(page);
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
    await expect.poll(() => textContrast(ticket.getByText('價格', { exact: true }))).toBeGreaterThanOrEqual(7);
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
    await settings.getByRole('tab', { name: '外觀' }).focus();
    await page.keyboard.press('ArrowDown');
    await expect(settings.getByRole('tab', { name: '音效與隱私' })).toHaveAttribute('aria-selected', 'true');
    await expect.poll(() => settings.getByRole('tab', { name: '音效與隱私' }).evaluate(el => getComputedStyle(el).boxShadow)).toContain('rgb(244, 244, 245)');
    await settings.getByRole('switch', { name: '帳號遮蔽' }).click();
    await expect(settings.getByRole('switch', { name: '帳號遮蔽' })).toHaveAttribute('aria-checked', 'true');
    await settings.getByRole('tab', { name: '風控' }).click();
    const confirm = settings.getByRole('switch', { name: '手動下單確認' });
    if (await confirm.getAttribute('aria-checked') !== 'true') await confirm.click();
    await settings.getByRole('tab', { name: '外觀' }).click();
    await settings.getByText('淺色', { exact: true }).click();
    await expect(settings.getByText('淺色', { exact: true })).toHaveAttribute('data-state', 'on');
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--background').trim())).toMatch(/^#(?:fff|ffffff)$/);
    await expect.poll(() => settings.getByText('淺色', { exact: true }).evaluate(el => getComputedStyle(el).color)).toBe('rgb(10, 10, 10)');
    await page.screenshot({ animations: 'disabled', path: path.join(artifacts, 'settings-light.png') });
    await page.keyboard.press('Escape'); await expect(settings).toBeHidden();
    await tradeContrast(ticket);
    expect(await panelGeometry(page)).toEqual(geometry);
    await page.screenshot({ animations: 'disabled', path: path.join(artifacts, 'terminal-light.png') });
    await settingsButton.click();
    await settings.getByText('自訂', { exact: true }).click();
    const accent = settings.getByLabel('強調色顏色');
    await accent.fill('#c080ff');
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--primary').trim())).toBe('#c080ff');
    // Native form controls must follow the chosen text color even if the custom
    // base remains dark and the user chooses a white panel.
    await settings.getByLabel('背景顏色').fill('#ffffff');
    await settings.getByLabel('面板顏色').fill('#ffffff');
    await settings.getByLabel('文字顏色').fill('#171717');
    await expect.poll(() => priceInput.evaluate(el => getComputedStyle(el).color)).toBe('rgb(23, 23, 23)');
    await settings.getByText('深色', { exact: true }).click();
    await expect(settings.getByText('深色', { exact: true })).toHaveAttribute('data-state', 'on');
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
    await page.locator('button[aria-haspopup="menu"]').first().click();
    const linkMenu = page.getByRole('menu');
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

    await page.setViewportSize({ width: 390, height: 844 });
    await settingsButton.click(); await expect(settings).toBeVisible();
    const mobileFrame = await settings.boundingBox();
    expect(mobileFrame.x).toBeGreaterThanOrEqual(0);
    expect(mobileFrame.x + mobileFrame.width).toBeLessThanOrEqual(391);
    await page.screenshot({ animations: 'disabled', path: path.join(artifacts, 'settings-narrow.png') });
    await page.keyboard.press('Escape');
    expect(errors).toEqual([]);
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
