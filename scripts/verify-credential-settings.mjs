// Real browser/WebAuthn and CLI restart loop. Synthetic secrets only; no host Keychain or SDK.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';

const root = fileURLToPath(new URL('../', import.meta.url));
const uiPort = 6194, apiPort = 22994, origin = `http://localhost:${uiPort}`;
const temporary = await mkdtemp(path.join(tmpdir(), 'fubon-credential-qa-'));
const artifacts = process.env.CREDENTIAL_ARTIFACT_DIR || '/private/tmp/fubon-credential-qa';
const python = process.env.CREDENTIAL_PYTHON || path.join(root, 'server/.venv/bin/python');
const launch = randomBytes(32).toString('base64url');
const children = [], pageErrors = [], scenarios = [];
let browser, page, logs = '';
await mkdir(artifacts, { recursive: true });
function run(command, args, env) {
    const child = spawn(command, args, { cwd: root, detached: true, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { logs = (logs + data).slice(-20000); });
    children.push(child);
}
async function ready(url) {
    await expect.poll(async () => { try { return (await fetch(url)).status; } catch { return 0; } }, { timeout: 30000 }).toBe(200);
}
const dialog = () => page.getByRole('dialog', { name: '富邦連線設定', exact: true });
const key = () => dialog().getByLabel('API Key', { exact: true });
const save = () => dialog().getByRole('button', { name: '驗證並儲存連線設定', exact: true });
async function open() { await page.getByRole('button', { name: '富邦連線設定', exact: true }).click(); await expect(key()).toBeVisible(); }
async function unlock(first = false) {
    if (first) await page.goto(origin + '/#fubon-launch=' + launch);
    await page.getByRole('button', { name: first ? '建立 Passkey 並解鎖' : '使用 Passkey 解鎖', exact: true }).click();
    await expect(page.getByRole('button', { name: '富邦連線設定', exact: true })).toBeVisible({ timeout: 30000 });
}
async function qa(body = {}) {
    return page.evaluate(async body => (await fetch('/api/v1/qa/credentials', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json(), body);
}
async function fillInitial(value) {
    await key().fill(value);
    await dialog().getByLabel('身分證字號', { exact: true }).fill('fixture-id');
    await dialog().getByLabel('本機憑證完整路徑', { exact: true }).fill(path.join(temporary, 'test.pfx'));
    await dialog().getByLabel('憑證密碼', { exact: true }).fill('fixture-password');
}
async function storedSecrets() {
    return page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }));
}
try {
    for (const port of [uiPort, apiPort]) await new Promise((resolve, reject) => {
        const probe = net.createServer(); probe.once('error', reject); probe.listen(port, '127.0.0.1', () => probe.close(resolve));
    });
    const backend = path.join(temporary, 'backend.py');
    await writeFile(backend, `
import os,sys
from pathlib import Path
from copy import deepcopy
import fubon_bridge.__main__ as entry
from fubon_bridge.app import create_app as real_create_app
from fubon_bridge.config import Config
from fubon_bridge.passkeys import PasskeyStore
from fubon_bridge.research import ResearchStore
from fubon_bridge.credential_settings import CredentialSettings
root=Path(os.environ['CREDENTIAL_TEMP'])
(root/'server').mkdir()
cert=root/'test.pfx'; cert.write_text('synthetic certificate'); cert.chmod(0o600)
entry.ROOT=root
entry.Config.from_env=lambda:Config(port=int(os.environ['CREDENTIAL_API_PORT']))
entry.secrets.token_urlsafe=lambda _:os.environ['CREDENTIAL_LAUNCH']
class MemoryKeychain:
    value=None
    writes=0
    fail=False
    def read(self): return deepcopy(self.value)
    def write(self,value):
        if self.fail: raise RuntimeError('fixture secret exception must not escape')
        self.value=deepcopy(value); self.writes+=1
memory=MemoryKeychain()
service=CredentialSettings(lambda:memory)
service.available=lambda:True
def create_app(config,**kwargs):
    app=real_create_app(config,passkey_store=PasskeyStore(root/'passkeys.db'),research_store=ResearchStore(root/'research.db'),credential_store=service,**kwargs)
    @app.post('/api/v1/qa/credentials')
    def qa(body:dict):
        if 'fail' in body: memory.fail=body['fail']
        if 'monitoring' in body: app.state.automation.monitoring=body['monitoring']
        value=memory.value or {}
        return dict(writes=memory.writes,configured=bool(value),keyUpdated=value.get('api_key')=='fixture-key-second',detailsPreserved=all(value.get(k)==v for k,v in dict(personal_id='fixture-id',cert_path=str(cert.resolve()),cert_password='fixture-password').items()),instance_id=app.state.broker.instance_id,mode=app.state.broker.config.mode)
    app.router.routes.insert(0,app.router.routes.pop())
    return app
entry.create_app=create_app
sys.argv=['fixture','--ui-url',os.environ['CREDENTIAL_ORIGIN'],'--no-browser']
entry.main()
`);
    run(python, [backend], { PYTHONPATH: path.join(root, 'server'), CREDENTIAL_TEMP: temporary, CREDENTIAL_API_PORT: String(apiPort), CREDENTIAL_ORIGIN: origin, CREDENTIAL_LAUNCH: launch });
    run(process.execPath, [path.join(root, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(uiPort), '--strictPort'], {
        VITE_API_TARGET: `http://127.0.0.1:${apiPort}`, VITE_API_BASE: '', VITE_STREAM_BASE: origin, VITE_DEV_SERVER_PORT: '',
    });
    await ready(`http://127.0.0.1:${apiPort}/api/v1/passkeys/status`); await ready(origin);
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } }); page = await context.newPage();
    page.on('pageerror', error => pageErrors.push(error.message));
    const cdp = await context.newCDPSession(page); await cdp.send('WebAuthn.enable');
    await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
    await unlock(true); await open(); await expect(dialog()).toContainText('首次使用請設定 API Key');
    await fillInitial('fixture-key-cancelled'); await page.keyboard.press('Escape'); await open(); await expect(key()).toHaveValue('');
    expect((await qa()).writes).toBe(0); scenarios.push('cancel discards secret inputs without writes');
    await fillInitial('fixture-key-first'); await dialog().screenshot({ path: path.join(artifacts, 'initial-dark.png') });
    const original = await qa(), oldToken = await page.evaluate(() => sessionStorage.getItem('fubon-trading-session'));
    await save().click();
    await expect(page.getByRole('button', { name: '使用 Passkey 解鎖', exact: true })).toBeVisible({ timeout: 35000 });
    expect((await context.request.get(origin + '/api/v1/info', { headers: { Authorization: 'Bearer ' + oldToken } })).status()).toBe(401);
    await unlock(); let state = await qa(); expect(state.writes).toBe(1); expect(state.detailsPreserved).toBe(true); expect(state.mode).toBe('demo'); expect(state.instance_id).not.toBe(original.instance_id);
    expect(await storedSecrets()).not.toMatch(/fixture-(key|password|id)/); scenarios.push('initial setup verifies Passkey, saves, restarts real CLI and revokes old session');
    await open(); await dialog().getByText('帳號與憑證（選填更新）', { exact: true }).click();
    await expect(dialog().getByLabel('本機憑證完整路徑', { exact: true })).toHaveValue(await realpath(path.join(temporary, 'test.pfx')));
    await expect(dialog().getByLabel('身分證字號', { exact: true })).toHaveValue('');
    await expect(dialog().getByLabel('憑證密碼', { exact: true })).toHaveValue('');
    await page.keyboard.press('Escape'); scenarios.push('saved certificate path is filled automatically; identity and password remain empty');
    await qa({ monitoring: true }); await open(); await key().fill('fixture-key-blocked'); await save().click();
    await expect(dialog().getByRole('alert')).toContainText('請先停止策略'); await expect(key()).toHaveValue('');
    expect((await qa()).writes).toBe(1); await page.keyboard.press('Escape'); await qa({ monitoring: false }); scenarios.push('active strategy blocks writes and clears inputs');
    await open(); await key().fill('fixture-key-cancelled-passkey');
    await page.evaluate(() => { window.qaGet = navigator.credentials.get.bind(navigator.credentials); navigator.credentials.get = async () => { throw new DOMException('cancel', 'NotAllowedError'); }; });
    await save().click(); await expect(dialog().getByRole('alert')).toContainText('Passkey 驗證已取消'); await expect(key()).toHaveValue(''); expect((await qa()).writes).toBe(1);
    await page.evaluate(() => { navigator.credentials.get = window.qaGet; }); await page.keyboard.press('Escape'); scenarios.push('Passkey cancellation never saves');
    await open(); await expect(dialog()).toContainText('連線資料已儲存在 Keychain'); await key().fill('fixture-key-second'); await save().click();
    await expect(page.getByRole('button', { name: '使用 Passkey 解鎖', exact: true })).toBeVisible({ timeout: 35000 });
    await unlock(); state = await qa(); expect(state.writes).toBe(2); expect(state.keyUpdated).toBe(true); expect(state.detailsPreserved).toBe(true);
    expect(await storedSecrets()).not.toMatch(/fixture-(key|password|id)/); scenarios.push('key-only update preserves account/certificate; no secret browser storage');
    for (const mode of ['深色', '淺色']) {
        await page.getByRole('button', { name: '設定', exact: true }).click(); const settings = page.getByRole('dialog', { name: '設定', exact: true });
        await settings.getByRole('tab', { name: '外觀', exact: true }).click(); await settings.getByRole('radio', { name: mode, exact: true }).click(); await page.keyboard.press('Escape');
        for (const width of [1440, 390]) {
            await page.setViewportSize({ width, height: 844 }); await open();
            await dialog().getByText('帳號與憑證（選填更新）', { exact: true }).click();
            const box = await dialog().evaluate(el => ({ scroll: el.scrollWidth, width: el.clientWidth })); expect(box.scroll).toBeLessThanOrEqual(box.width + 1);
            await save().scrollIntoViewIfNeeded(); const bounds = await save().boundingBox(); expect(bounds.y + bounds.height).toBeLessThanOrEqual(844);
            await dialog().screenshot({ path: path.join(artifacts, `credentials-${mode}-${width}.png`) }); await page.keyboard.press('Escape');
        }
    }
    scenarios.push('desktop/mobile, dark/light and scrollable expanded form verified');
    await qa({ fail: true }); await open(); await key().fill('fixture-key-failed'); await save().click();
    await expect(dialog().getByRole('alert')).toContainText('無法確認'); await expect(save()).toBeDisabled(); await expect(key()).toHaveValue('');
    expect((await qa()).writes).toBe(2); scenarios.push('storage failure does not restart or leak secrets; uncertain result prevents resubmission');
    expect(pageErrors).toEqual([]);
    await writeFile(path.join(artifacts, 'summary.json'), JSON.stringify({ passed: true, scenarios, pageErrors }, null, 2));
    console.log(JSON.stringify({ passed: true, scenarios, artifacts }, null, 2));
} catch (error) {
    await writeFile(path.join(artifacts, 'failure.log'), logs);
    await page?.screenshot({ path: path.join(artifacts, 'failure.png'), fullPage: true }).catch(() => undefined);
    throw error;
} finally {
    await browser?.close();
    for (const child of children.reverse()) {
        if (child.exitCode !== null) continue;
        const ended = new Promise(resolve => child.once('exit', resolve));
        try { process.kill(-child.pid, 'SIGTERM'); } catch { continue; }
        await Promise.race([ended, new Promise(resolve => setTimeout(resolve, 5000))]);
        if (child.exitCode === null) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already stopped */ } }
    }
}
