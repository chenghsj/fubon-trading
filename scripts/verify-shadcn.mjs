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
    await page.screenshot({ animations: 'disabled', path: path.join(artifacts, 'terminal-dark.png') });

    const settingsButton = page.getByRole('button', { name: '設定', exact: true });
    await settingsButton.click();
    const settings = page.getByRole('dialog', { name: '設定', exact: true });
    const frame = await settings.boundingBox();
    const tab = await settings.getByRole('tab', { name: '外觀' }).boundingBox();
    expect(tab.y).toBeGreaterThanOrEqual(frame.y);
    expect(tab.y + tab.height).toBeLessThanOrEqual(frame.y + frame.height);
    await settings.getByRole('tab', { name: '外觀' }).focus(); await page.keyboard.press('ArrowDown');
    await expect(settings.getByRole('tab', { name: '音效與隱私' })).toHaveAttribute('aria-selected', 'true');
    await settings.getByRole('switch', { name: '帳號遮蔽' }).click();
    await expect(settings.getByRole('switch', { name: '帳號遮蔽' })).toHaveAttribute('aria-checked', 'true');
    await settings.getByRole('tab', { name: '風控' }).click();
    const confirm = settings.getByRole('switch', { name: '手動下單確認' });
    if (await confirm.getAttribute('aria-checked') !== 'true') await confirm.click();
    await settings.getByRole('tab', { name: '外觀' }).click();
    await settings.getByText('淺色', { exact: true }).click();
    await expect(settings.getByText('淺色', { exact: true })).toHaveAttribute('data-state', 'on');
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--background').trim())).toBe('#eef0f3');
    await expect.poll(() => settings.getByText('淺色', { exact: true }).evaluate(el => getComputedStyle(el).color)).toBe('rgb(28, 36, 51)');
    await page.screenshot({ animations: 'disabled', path: path.join(artifacts, 'settings-light.png') });
    await settings.getByText('自訂', { exact: true }).click();
    const accent = settings.getByLabel('強調色顏色');
    await accent.fill('#c080ff');
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--primary').trim())).toBe('#c080ff');
    await settings.getByText('深色', { exact: true }).click();
    await expect(settings.getByText('深色', { exact: true })).toHaveAttribute('data-state', 'on');
    await page.keyboard.press('Escape'); await expect(settings).toBeHidden();
    await expect(settingsButton).toBeFocused();

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

    await page.getByRole('button', { name: '自訂報價欄位' }).first().click();
    const quote = page.getByRole('dialog', { name: '報價欄位設定' });
    await expect(quote).toBeVisible();
    await quote.getByRole('tab', { name: '指數' }).click();
    await expect(quote.getByRole('tab', { name: '指數' })).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('Escape'); await expect(quote).toBeHidden();

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
