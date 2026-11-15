// Isolated UI acceptance: virtual WebAuthn, temporary SQLite, FakeGateway only.
// The real Broker remains in demo mode; the brokerage SDK factory must never run.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';

const root = fileURLToPath(new URL('../', import.meta.url));
const uiPort = Number(process.env.AUTO_UI_PORT || 6188);
const apiPort = Number(process.env.AUTO_API_PORT || 22988);
const origin = `http://localhost:${uiPort}`;
const temporary = await mkdtemp('/private/tmp/fubon-auto-fixture-');
const artifacts = process.env.AUTO_ARTIFACT_DIR || '/private/tmp/fubon-auto-qa-20261115';
await mkdir(artifacts, { recursive: true });
const launch = randomBytes(32).toString('base64url');
const children = [], pageErrors = [], mutations = [], readonlyOrderPaths = [], scenarios = [];
let browser, page, logs = '', closing;
const panel = () => page.getByRole('region', { name: 'Sandbox 自動交易', exact: true });
const button = name => panel().getByRole('button', { name, exact: true });

function run(command, args, env = {}) {
    const child = spawn(command, args, { cwd: root, detached: process.platform !== 'win32',
        env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', data => { logs = (logs + data).slice(-24000); });
    child.stderr.on('data', data => { logs = (logs + data).slice(-24000); });
    child.on('error', error => { logs += error.message; });
    children.push(child);
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
        if (children.some(child => child.exitCode !== null && child.exitCode !== 0)) throw new Error('Isolated QA server exited.');
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
            try { process.kill(process.platform === 'win32' ? child.pid : -child.pid, 'SIGTERM'); } catch { /* Exited. */ }
        }
    })();
}
for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
    process.once(signal, () => { void cleanup().finally(() => process.exit(code)); });
}
async function request(endpoint, body, token) {
    // The app intentionally overwrites browser fetch Authorization with its own
    // session. Use the isolated context request client for a separate viewer.
    if (token) {
        const response = await page.request.fetch(`${origin}${endpoint}`, { method: body === undefined ? 'GET' : 'POST',
            headers: { Authorization: `Bearer ${token}` }, ...(body === undefined ? {} : { data: body }) });
        return { status: response.status(), data: await response.json() };
    }
    return page.evaluate(async ({ endpoint, body, token }) => {
        const session = token || sessionStorage.getItem('fubon-trading-session');
        const response = await fetch(endpoint, { method: body === undefined ? 'GET' : 'POST',
            headers: { Authorization: `Bearer ${session}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        return { status: response.status, data: await response.json() };
    }, { endpoint, body, token });
}
async function fixture(body = {}) {
    const result = await request('/api/v1/qa/advance', body);
    expect(result.status).toBe(200);
    expect(result.data.sdkCalls).toBe(0);
    return result.data;
}
async function state() { return (await fixture()).state; }
async function see(text) { await expect(panel().getByText(text, { exact: true }).first()).toBeVisible({ timeout: 12000 }); }
async function screenshot(name) { await panel().screenshot({ animations: 'disabled', path: path.join(artifacts, `${name}.png`) }); }
async function prepare() {
    await panel().getByLabel('微台具體合約', { exact: true }).fill('TMFK6');
    await panel().getByLabel('單次交易日期', { exact: true }).fill('2026-11-13');
    await expect(button('啟動／恢復 sandbox 策略')).toBeEnabled({ timeout: 12000 });
}
async function start() {
    await prepare();
    await button('啟動／恢復 sandbox 策略').click();
    await see('策略執行中');
    await expect(panel().getByRole('combobox', { name: '期貨測試帳戶', exact: true })).toBeDisabled();
    await expect(panel().getByRole('combobox', { name: '策略版本', exact: true })).toBeDisabled();
    expect((await state()).status).toBe('running');
}
async function enterAndFill() {
    await start();
    const pending = await fixture({ at: '2026-11-13T09:20:01+08:00', ticks: 1 });
    expect(pending.requests).toHaveLength(1);
    expect(pending.state.pending).toBeTruthy();
    expect(pending.state.position).toBeNull();
    await see('委託待確認');
    await expect(panel().getByRole('table')).toContainText('AwaitingConfirmation');
    await screenshot('pending');
    const filled = await fixture({ fill: 25022, ticks: 1 });
    expect(filled.state.position.entryPrice).toBe(25022);
    expect(filled.state.position.quantity).toBe(1);
    await see('多 1 口');
    await expect(panel().getByRole('table')).toContainText('Filled');
    await screenshot('filled');
    return filled.state;
}
async function setTheme(name) {
    await page.getByRole('button', { name: '設定', exact: true }).click();
    const settings = page.getByRole('dialog', { name: '設定', exact: true });
    await settings.getByRole('tab', { name: '外觀', exact: true }).click();
    await settings.getByRole('radio', { name, exact: true }).click();
    await page.keyboard.press('Escape');
    await expect(settings).toBeHidden();
}
async function reset() {
    await fixture({ reset: true });
    await page.reload();
    await see('尚未啟動');
    await expect(panel().getByRole('alert')).toBeHidden();
}

try {
    await free(uiPort); await free(apiPort);
    const backend = path.join(temporary, 'backend.py');
    await writeFile(backend, `import os,sys
from pathlib import Path
from datetime import datetime
from types import SimpleNamespace
import uvicorn
from fastapi import Request
from fubon_bridge.app import create_app
from fubon_bridge.auto_store import AutoStore
from fubon_bridge.auto_trading import SandboxAutoTrader,empty_state
from fubon_bridge.config import Config
from fubon_bridge.mapping import TAIPEI
from fubon_bridge.passkeys import PasskeyStore
from fubon_bridge.research import ResearchStore
sys.path.insert(0,str(Path(os.environ['PYTHONPATH'])/'tests'))
from test_auto_trading import FakeGateway,ACCOUNT
class QAGateway(FakeGateway):
    def __init__(self,clock):
        super().__init__(clock)
        self.quote_failed=False
    def quote(self,contract):
        if self.quote_failed: raise TimeoutError('QA quote unavailable')
        return super().quote(contract)
clock=SimpleNamespace(at=datetime(2026,11,13,9,19,tzinfo=TAIPEI),mono=0)
gateway=QAGateway(clock)
sdk_calls=0
def no_sdk():
    global sdk_calls
    sdk_calls+=1
    raise AssertionError('QA must never initialize brokerage SDK')
class ManualTrader(SandboxAutoTrader):
    def tick(self):
        pass # Product background loop cannot advance this fixture.
    def manual_tick(self):
        super().tick()
def factory(broker,research,authorize):
    broker.account_rows=lambda:[dict(ACCOUNT,signed=True,person_id='',username='QA fake account')]
    return ManualTrader(gateway,AutoStore(research),authorize,clock=lambda:clock.at,monotonic=lambda:clock.mono)
app=create_app(Config(mode='demo',port=int(os.environ['AUTO_UI_PORT'])),sdk_factory=no_sdk,
    launch_token=os.environ['AUTO_LAUNCH'],public_origin=os.environ['AUTO_ORIGIN'],
    passkey_store=PasskeyStore(os.environ['AUTO_PASSKEY_DATABASE']),research_store=ResearchStore(os.environ['AUTO_DATABASE']),automation_factory=factory)
trader=app.state.automation
@app.post('/api/v1/qa/advance')
def advance(request:Request,body:dict):
    with trader.lock:
        if body.get('reset'):
            trader.store.release(trader.writer)
            with trader.store.research.connect() as db:
                db.execute('DELETE FROM research_auto_events')
                db.execute('DELETE FROM research_auto_runs')
            clock.at=datetime(2026,11,13,9,19,tzinfo=TAIPEI)
            clock.mono=0
            gateway.__init__(clock)
            trader.state=empty_state()
            trader.owner=None
            trader.lease_until=0
        if 'at' in body: clock.at=datetime.fromisoformat(body['at'])
        if 'mono' in body: clock.mono=body['mono']
        if 'price' in body: gateway.price=body['price']
        if 'unknown' in body: gateway.unknown=body['unknown']
        if 'quoteFailure' in body: gateway.quote_failed=body['quoteFailure']
        if 'fill' in body: gateway.fill(body['fill'])
        if body.get('restart'):
            trader.shutdown()
            restored=ManualTrader(gateway,trader.store,trader.authorize,clock=lambda:clock.at,monotonic=lambda:clock.mono)
            trader.__dict__.update(restored.__dict__)
        for _ in range(body.get('ticks',0)): trader.manual_tick()
        result=dict(state=trader.snapshot(request.headers.get('authorization','')),requests=gateway.requests,cancels=gateway.cancels,sdkCalls=sdk_calls)
        if body.get('viewer'): result['viewerToken']=app.state.session.issue()
        return result
app.router.routes.insert(0,app.router.routes.pop()) # QA route must precede the product unsupported-API fallback.
uvicorn.run(app,host='127.0.0.1',port=int(os.environ['AUTO_API_PORT']),access_log=False)
`);
    run(process.env.AUTO_PYTHON || path.join(root, 'server', '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'), [backend], {
        PYTHONPATH: path.join(root, 'server'), AUTO_UI_PORT: String(uiPort), AUTO_API_PORT: String(apiPort),
        AUTO_LAUNCH: launch, AUTO_ORIGIN: origin, AUTO_PASSKEY_DATABASE: path.join(temporary, 'passkeys.sqlite3'), AUTO_DATABASE: path.join(temporary, 'research.sqlite3'),
    });
    run(process.execPath, [path.join(root, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(uiPort), '--strictPort'], {
        VITE_API_TARGET: `http://127.0.0.1:${apiPort}`, VITE_API_BASE: '', VITE_STREAM_BASE: origin, VITE_DEV_SERVER_PORT: '',
    });
    await ready(`http://127.0.0.1:${apiPort}/api/v1/passkeys/status`); await ready(origin);
    browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true, ignoreDefaultArgs: ['--hide-scrollbars'] });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1050 } });
    page = await context.newPage();
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.route('**/api/v1/order/**', async route => {
        const pathname = new URL(route.request().url()).pathname;
        if (route.request().method() !== 'GET' && !/\/(trades|trade_cache_health)$/.test(pathname)) {
            mutations.push(pathname);
            return route.abort('blockedbyclient');
        }
        readonlyOrderPaths.push(pathname);
        return route.continue();
    });
    const cdp = await context.newCDPSession(page);
    await cdp.send('WebAuthn.enable');
    await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
    await page.goto(`${origin}/#fubon-launch=${launch}`);
    await page.getByRole('button', { name: '建立 Passkey 並解鎖' }).click();
    await expect(page.getByText('LIVE', { exact: true })).toBeVisible({ timeout: 30000 });
    await page.getByRole('button', { name: /新增面板/ }).first().click();
    const picker = page.getByRole('dialog', { name: '新增面板', exact: true });
    await picker.getByPlaceholder('搜尋面板（名稱或用途）').fill('自動交易');
    await picker.locator('button[data-idx]').filter({ hasText: '自動交易' }).click();
    await expect(panel()).toBeVisible();
    await page.evaluate(() => {
        const workspace = JSON.parse(localStorage.getItem('sj-pro-workspace-v3'));
        const block = workspace.blocks.find(b => b.type === 'autotrade');
        localStorage.setItem('sj-pro-workspace-v3', JSON.stringify({ ...workspace, blocks: [block], layout: [{ i: block.id, x: 0, y: 0, w: 288, h: 24, minW: 96, minH: 8 }] }));
    });
    await page.reload();
    await see('尚未啟動');
    await prepare();
    await expect(panel().locator('select:not([aria-hidden="true"])')).toHaveCount(0);
    const accountChoice = panel().getByRole('combobox', { name: '期貨測試帳戶', exact: true });
    await accountChoice.click();
    await page.screenshot({ path: path.join(artifacts, 'auto-select-open.png') });
    await page.getByRole('option', { name: 'TEST-AUTO', exact: true }).click();
    await expect(accountChoice).toHaveText('TEST-AUTO');
    const strategyChoice = panel().getByRole('combobox', { name: '策略版本', exact: true });
    await strategyChoice.focus(); await page.keyboard.press('Enter');
    await expect(page.getByRole('option', { name: '開盤區間突破', exact: true })).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(page.getByRole('option', { name: '突破＋權值股方向濾網', exact: true })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(strategyChoice).toHaveText('突破＋權值股方向濾網');
    await expect(panel().getByLabel(/固定假設權重/)).toBeVisible();
    await strategyChoice.click(); await page.getByRole('option', { name: '開盤區間突破', exact: true }).click();
    await expect(strategyChoice).toHaveText('開盤區間突破');
    // Loading and backend validation errors travel through the real start route.
    await panel().getByLabel('單次交易日期', { exact: true }).fill('2026-11-14');
    await button('啟動／恢復 sandbox 策略').click();
    await expect(panel().getByRole('alert')).toContainText('平日');
    await screenshot('validation-error');
    await prepare();
    const delayStart = async route => { await new Promise(resolve => setTimeout(resolve, 800)); await route.continue(); };
    await page.route('**/api/v1/automation/start', delayStart);
    await button('啟動／恢復 sandbox 策略').click();
    await expect(panel().getByText('正在啟動…', { exact: true })).toBeVisible();
    await expect(button('啟動／恢復 sandbox 策略')).toBeDisabled();
    await screenshot('loading');
    await see('策略執行中');
    await page.unroute('**/api/v1/automation/start', delayStart);
    await button('停止新倉').click();
    await see('新倉已暫停');
    expect((await fixture({ ticks: 2 })).requests).toHaveLength(0);
    // Resuming at 09:19 still processes only a new 09:20 signal.
    const filled = await enterAndFill();
    const viewer = (await fixture({ viewer: true })).viewerToken;
    expect(viewer).toBeTruthy();
    expect((await request('/api/v1/automation/state', undefined, viewer)).data.owned).toBe(false);
    const viewerHeartbeat = await request('/api/v1/automation/heartbeat', { run_id: filled.id, entries_allowed: true, execution_allowed: true }, viewer);
    expect(viewerHeartbeat.status).toBe(400);
    expect(viewerHeartbeat.data.detail).toContain('控制者');
    const stopLoss = await fixture({ price: 24990, ticks: 1 });
    expect(stopLoss.requests.map(row => row.role)).toEqual(['entry', 'exit']);
    expect(stopLoss.state.exitReason).toBe('策略停損');
    await expect(panel().getByRole('table')).toContainText('退出 / 賣', { timeout: 12000 });
    const flat = await fixture({ fill: 24988, ticks: 1 });
    expect(flat.state.position).toBeNull();
    expect(flat.state.pending).toBeNull();
    expect(flat.state.realizedNet).toBeLessThan(0);
    await button('停止並退出').click();
    expect((await fixture({ ticks: 1 })).state.status).toBe('stopped');
    await see('已停止');
    await page.reload();
    await see('已停止');
    await expect(panel().getByRole('table').getByRole('row')).toHaveCount(3);
    scenarios.push({ name: 'stoploss-and-persistence', requests: flat.requests, realizedNet: flat.state.realizedNet, viewerHeartbeatStatus: viewerHeartbeat.status });

    for (const theme of ['深色', '淺色']) {
        await setTheme(theme);
        for (const width of [1440, 390]) {
            await page.setViewportSize({ width, height: 1050 });
            expect(await panel().evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
            for (const name of ['啟動／恢復 sandbox 策略', '停止新倉', '停止並退出', '重新對帳與接管監控']) {
                const control = button(name);
                await control.scrollIntoViewIfNeeded();
                expect(await control.evaluate(el => {
                    const p = el.closest('[aria-label="Sandbox 自動交易"]').getBoundingClientRect(), r = el.getBoundingClientRect();
                    return r.left >= p.left && r.right <= p.right && r.height >= 24 && r.height <= 32;
                })).toBe(true);
            }
            await panel().evaluate(el => { el.scrollTop = 0; });
            await screenshot(`auto-${theme === '深色' ? 'dark' : 'light'}-${width}-controls`);
            await panel().getByRole('table').scrollIntoViewIfNeeded();
            await screenshot(`auto-${theme === '深色' ? 'dark' : 'light'}-${width}-orders`);
        }
    }
    const touch = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, storageState: await context.storageState() });
    const session = await page.evaluate(() => sessionStorage.getItem('fubon-trading-session'));
    await touch.addInitScript(value => sessionStorage.setItem('fubon-trading-session', value), session);
    try {
        const touchPage = await touch.newPage(); await touchPage.goto(origin);
        const touchPanel = touchPage.getByRole('region', { name: 'Sandbox 自動交易', exact: true });
        await expect(touchPanel).toBeVisible();
        expect(await touchPage.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true);
        for (const control of await touchPanel.locator('button, input').all()) {
            const geometry = await control.evaluate(el => ({ height: el.getBoundingClientRect().height, element: el.outerHTML.slice(0, 360) }));
            expect(geometry.height, JSON.stringify(geometry)).toBeGreaterThanOrEqual(44);
        }
        await touchPanel.screenshot({ path: path.join(artifacts, 'auto-touch-390-controls.png') });
    } finally { await touch.close(); }
    await page.setViewportSize({ width: 1440, height: 1050 });
    await setTheme('深色');
    await reset();
    await enterAndFill();
    const restored = await fixture({ restart: true, price: 24990, ticks: 3 });
    expect(restored.requests).toHaveLength(1);
    expect(restored.state.monitoring).toBe(false);
    expect(restored.state.position.quantity).toBe(1);
    await see('需要處理');
    await fixture({ price: 25020 });
    await button('重新對帳與接管監控').click();
    expect((await state()).monitoring).toBe(true);
    await see('新倉已暫停');
    await page.getByRole('button', { name: '風控', exact: true }).click();
    await expect.poll(async () => (await state()).executionBlocked).toBe(true);
    await button('停止並退出').click();
    const blocked = await fixture({ ticks: 2 });
    expect(blocked.requests).toHaveLength(1);
    expect(blocked.state.position.quantity).toBe(1);
    expect(blocked.state.reason).toContain('退出受阻');
    await expect(panel().getByText(/風控鎖定也會阻擋自動退出/)).toBeVisible();
    await screenshot('kill-blocks-exit');
    await page.getByRole('button', { name: '風控鎖定', exact: true }).click();
    await expect.poll(async () => (await state()).executionBlocked).toBe(false);
    const unlocked = await fixture({ ticks: 1 });
    expect(unlocked.requests.map(row => row.role)).toEqual(['entry', 'exit']);
    const exited = await fixture({ fill: 25018, ticks: 1 });
    expect(exited.state.position).toBeNull();
    expect(exited.state.pending).toBeNull();
    scenarios.push({ name: 'kill-blocks-then-unlock-exits', requests: exited.requests });

    await reset();
    await start();
    const completed = await fixture({ at: '2026-11-13T13:46:00+08:00', ticks: 1 });
    expect(completed.state.status).toBe('completed');
    expect(completed.requests).toHaveLength(0);
    await see('本次日盤已結束');
    const nextDate = panel().getByLabel('單次交易日期', { exact: true });
    await expect(nextDate).toBeEnabled();
    await nextDate.fill('2026-11-16');
    await expect(nextDate).toHaveValue('2026-11-16');
    await expect(button('啟動／恢復 sandbox 策略')).toBeEnabled();
    scenarios.push({ name: 'completed-next-date-editable', nextDate: await nextDate.inputValue() });

    await reset();
    await start();
    await fixture({ at: '2026-11-13T09:20:01+08:00', ticks: 1 });
    const quoteFailed = await fixture({ fill: 25022, quoteFailure: true, ticks: 1 });
    expect(quoteFailed.state.position.quantity).toBe(1);
    expect(quoteFailed.state.orders[0].filled).toBe(1);
    expect(quoteFailed.requests).toHaveLength(1);
    await see('多 1 口');
    await see('需要處理');
    await screenshot('filled-while-quote-fails');
    await fixture({ quoteFailure: false });
    await button('停止並退出').click();
    const quoteRecovered = await fixture({ ticks: 1 });
    expect(quoteRecovered.requests.map(row => row.role)).toEqual(['entry', 'exit']);
    await fixture({ fill: 25018, ticks: 1 });
    await see('已停止');
    scenarios.push({ name: 'filled-exposure-survives-quote-failure-then-stop-exits', requests: quoteRecovered.requests });

    await reset();
    await start();
    const unknown = await fixture({ unknown: true, at: '2026-11-13T09:20:01+08:00', ticks: 1 });
    expect(unknown.requests).toHaveLength(1);
    expect(unknown.state.orders[0].status).toBe('Unknown');
    const repeated = await fixture({ ticks: 5 });
    expect(repeated.requests).toHaveLength(1);
    expect(repeated.state.pending).toBeTruthy();
    await see('需要處理');
    await expect(panel().getByRole('table')).toContainText('Unknown');
    await screenshot('unknown-not-retried');
    scenarios.push({ name: 'unknown-not-retried', attemptsAfterSixTicks: repeated.requests.length });
    const syncFailure = async route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ detail: 'QA temporarily unavailable' }) });
    await page.route('**/api/v1/automation/state', syncFailure);
    await expect(panel().getByRole('alert')).toContainText('狀態更新失敗', { timeout: 12000 });
    await screenshot('state-error');
    await page.unroute('**/api/v1/automation/state', syncFailure);
    await expect(panel().getByRole('alert')).toBeHidden({ timeout: 12000 });
    await panel().getByText('已人工處理：封存本次追蹤', { exact: true }).click();
    await panel().getByLabel('輸入「已確認測試委託與部位」', { exact: true }).fill('已確認測試委託與部位');
    await button('確認並封存').click();
    await see('已人工封存');
    await expect(nextDate).toBeEnabled();
    await nextDate.fill('2026-11-16');
    await expect(nextDate).toHaveValue('2026-11-16');
    const stale = await request('/api/v1/automation/control', { run_id: repeated.state.id, command: 'pause', acknowledgement: '', execution_allowed: true });
    expect(stale.status).toBe(400);
    const archived = await fixture({ ticks: 3 });
    expect(archived.state.status).toBe('archived');
    expect(archived.requests).toHaveLength(1);
    scenarios.push({ name: 'archived-next-date-editable-and-stale-control-rejected', nextDate: await nextDate.inputValue(), staleControlStatus: stale.status });

    expect((await fixture()).sdkCalls).toBe(0);
    expect(mutations).toEqual([]);
    expect(pageErrors).toEqual([]);
    const nativeUserControls = await panel().locator('select:not([aria-hidden="true"])').count();
    expect(nativeUserControls).toBe(0);
    const summary = { passed: true, fixture: 'demo Broker + injected FakeGateway sandbox; manual clock/ticks only', scenarios, sdkCalls: 0, nativeUserControls, directTradingMutations: mutations, readonlyOrderPaths: [...new Set(readonlyOrderPaths)], pageErrors, artifacts };
    await writeFile(path.join(artifacts, 'summary.json'), JSON.stringify(summary, null, 2));
    console.log(JSON.stringify(summary, null, 2));
} catch (error) {
    await page?.screenshot({ path: path.join(artifacts, 'failure.png'), fullPage: true }).catch(() => undefined);
    await writeFile(path.join(artifacts, 'failure.log'), `${error.stack || error}\n\n${logs}`);
    console.error(`${error.stack || error}\nArtifacts: ${artifacts}\n${logs.slice(-5000)}`);
    process.exitCode = 1;
} finally {
    await cleanup();
}
