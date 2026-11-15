// Mode settings acceptance with the real CLI restart loop and isolated WebAuthn/SQLite.
// Every market value is synthetic. Never reads Keychain or initializes the vendor SDK.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';

const root = fileURLToPath(new URL('../', import.meta.url));
const uiPort = Number(process.env.MODE_UI_PORT || 6193), apiPort = Number(process.env.MODE_API_PORT || 22993);
const origin = `http://localhost:${uiPort}`, temporary = await mkdtemp(path.join(tmpdir(), 'fubon-mode-fixture-'));
const artifacts = process.env.MODE_ARTIFACT_DIR || '/private/tmp/fubon-mode-qa-20261116';
const launch = randomBytes(32).toString('base64url'), children = [], scenarios = [], screenshots = [], pageErrors = [], orderRequests = [];
const passkeyGeometry = [];
let browser, context, page, logs = '', closing;
const dialog = () => page.locator('[role="dialog"]').filter({ hasText: '選擇行情來源與委託執行環境。' });
const apply = () => dialog().getByRole('button', { name: '套用並重新連線', exact: true });
await mkdir(artifacts, { recursive: true });
function run(command, args, env = {}) {
    const child = spawn(command, args, { cwd: root, detached: process.platform !== 'win32',
        env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { logs = (logs + data).slice(-40000); });
    child.on('error', error => { logs += error.message; }); children.push(child); return child;
}
async function free(port) {
    await new Promise((resolve, reject) => { const probe = net.createServer(); probe.once('error', reject);
        probe.listen(port, '127.0.0.1', () => probe.close(resolve)); });
}
async function ready(url) {
    for (let i = 0; i < 250; i++) {
        if (children.some(child => child.exitCode !== null && child.exitCode !== 0)) throw new Error('QA service exited.');
        try { if ((await fetch(url, { signal: AbortSignal.timeout(500) })).status < 500) return; } catch { /* starting */ }
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('QA service did not become ready.');
}
async function stop(child) {
    if (!child || child.exitCode !== null || child.signalCode) return;
    const exited = new Promise(resolve => child.once('exit', resolve));
    try { process.kill(process.platform === 'win32' ? child.pid : -child.pid, 'SIGTERM'); } catch { return; }
    let timeout;
    try { await Promise.race([exited, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('QA process did not stop.')), 15000); })]); }
    finally { clearTimeout(timeout); }
}
async function cleanup() {
    return closing ??= (async () => { await browser?.close().catch(() => undefined);
        for (const child of [...children].reverse()) await stop(child); })();
}
for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]]) process.once(signal, () => { void cleanup().finally(() => process.exit(code)); });
async function request(endpoint, body, token) {
    if (token) {
        const response = await context.request.fetch(origin + endpoint, { method: body === undefined ? 'GET' : 'POST',
            headers: { Authorization: `Bearer ${token}` }, ...(body === undefined ? {} : { data: body }) });
        return { status: response.status(), data: await response.json() };
    }
    return page.evaluate(async ({ endpoint, body }) => {
        const response = await fetch(endpoint, { method: body === undefined ? 'GET' : 'POST',
            ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
        return { status: response.status, data: await response.json() };
    }, { endpoint, body });
}
async function settings() { const response = await request('/api/v1/settings/mode'); expect(response.status).toBe(200); return response.data; }
async function qa(body = {}) { const response = await request('/api/v1/qa/mode', body); expect(response.status, JSON.stringify(response)).toBe(200); return response.data; }
async function open() { await page.getByRole('button', { name: '交易模式設定', exact: true }).click(); await expect(dialog().getByRole('combobox')).toBeVisible(); }
async function select(label) { await dialog().getByRole('combobox').click(); await page.getByRole('option', { name: label, exact: true }).click(); }
async function shot(name) { const filename = path.join(artifacts, name + '.png'); await dialog().screenshot({ path: filename, animations: 'disabled' }); screenshots.push(filename); }
async function unlock(first = false) {
    if (first) await page.goto(origin + '/#fubon-launch=' + launch);
    await page.getByRole('button', { name: first ? '建立 Passkey 並解鎖' : '使用 Passkey 解鎖', exact: true }).click();
    await expect(page.getByRole('button', { name: '交易模式設定', exact: true })).toBeVisible({ timeout: 30000 });
}
async function switchMode(label, expected, live = false) {
    const before = await settings(), oldToken = await page.evaluate(() => sessionStorage.getItem('fubon-trading-session'));
    await open(); await select(label);
    if (live) {
        await dialog().getByRole('switch', { name: '允許正式下單', exact: true }).click();
        await dialog().getByLabel('輸入「確認啟用正式下單」', { exact: true }).fill('確認啟用正式下單');
        await dialog().getByRole('button', { name: '確認並啟用正式下單', exact: true }).click();
    } else await apply().click();
    await expect(page.getByRole('button', { name: '使用 Passkey 解鎖', exact: true })).toBeVisible({ timeout: 35000 });
    expect((await request('/api/v1/info', undefined, oldToken)).status).toBe(401);
    await unlock(); const after = await settings(); expect(after.mode).toBe(expected); expect(after.instance_id).not.toBe(before.instance_id);
    expect(after.live_enabled).toBe(live); return after;
}
async function theme(name) {
    await page.getByRole('button', { name: '設定', exact: true }).click();
    const settingsDialog = page.getByRole('dialog', { name: '設定', exact: true });
    await settingsDialog.getByRole('tab', { name: '外觀', exact: true }).click();
    await settingsDialog.getByRole('radio', { name, exact: true }).click(); await page.keyboard.press('Escape'); await expect(settingsDialog).toBeHidden();
}

async function passkeyAppearance(mode, scale) {
    await page.evaluate(async ({ mode, scale }) => {
        const themeStore = await import('/src/lib/theme-store.ts');
        themeStore.setThemeSettings({ mode, convention: 'tw', fontScale: scale });
    }, { mode, scale });
}
async function passkeyShot(name) {
    const card = page.locator('[data-slot="card"][aria-labelledby="passkey-title"]');
    await expect(card).toBeVisible();
    const geometry = await card.evaluate(el => {
        const bounds = el.getBoundingClientRect(), main = el.closest('main'), button = el.querySelector('button'), heading = el.querySelector('h1'), icon = el.querySelector('svg');
        const [header, content, footer] = el.children;
        return { width: innerWidth, height: innerHeight, cardWidth: bounds.width, cardHeight: bounds.height,
            client: el.clientWidth, scroll: el.scrollWidth, mainClient: main.clientHeight, mainScroll: main.scrollHeight,
            headingFont: getComputedStyle(heading).fontSize, iconWidth: icon.getBoundingClientRect().width,
            headerPadding: getComputedStyle(header).padding, contentPadding: getComputedStyle(content).padding, footerPadding: getComputedStyle(footer).padding,
            descriptionFont: getComputedStyle(header.lastElementChild).fontSize,
            buttonHeight: button.getBoundingClientRect().height, coarse: matchMedia('(pointer: coarse)').matches };
    });
    expect(geometry.cardWidth).toBeLessThanOrEqual(Math.min(380, geometry.width - 32));
    expect(geometry.scroll).toBeLessThanOrEqual(geometry.client + 1); expect(geometry.iconWidth).toBe(24);
    expect(geometry.headerPadding).toBe('16px'); expect(geometry.contentPadding).toBe('0px 16px 12px'); expect(geometry.footerPadding).toBe('0px 16px 16px');
    const expectedScale = name.endsWith('scale1.3') ? 1.3 : 1;
    expect(Math.abs(Number.parseFloat(geometry.descriptionFont) - 12 * expectedScale)).toBeLessThan(.01);
    expect(geometry.buttonHeight).toBeGreaterThanOrEqual(geometry.coarse ? 44 : 32);
    const button = card.getByRole('button'); await button.scrollIntoViewIfNeeded();
    const action = await button.boundingBox(); expect(action.y).toBeGreaterThanOrEqual(0); expect(action.y + action.height).toBeLessThanOrEqual(geometry.height);
    passkeyGeometry.push({ name, ...geometry });
    const filename = path.join(artifacts, name + '.png'); await card.screenshot({ path: filename, animations: 'disabled' }); screenshots.push(filename);
}
async function passkeyViews(kind) {
    for (const width of [320, 390, 1440]) for (const mode of ['dark', 'light']) for (const scale of [1, 1.3]) {
        await page.setViewportSize({ width, height: width === 1440 ? 900 : 844 });
        await passkeyAppearance(mode, scale); await passkeyShot(`passkey-${kind}-${mode}-${width}-scale${scale}`);
    }
    await page.setViewportSize({ width: 320, height: 480 }); await passkeyAppearance('dark', 1.3);
    let release;
    const responseReady = new Promise(resolve => { release = resolve; });
    const endpoint = `**/api/v1/passkeys/${kind === 'register' ? 'register' : 'authenticate'}/options`;
    const handler = async route => { await responseReady; await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ detail: 'Synthetic QA failure' }) }); };
    await page.route(endpoint, handler);
    await page.getByRole('button', { name: kind === 'register' ? '建立 Passkey 並解鎖' : '使用 Passkey 解鎖', exact: true }).click();
    await expect(page.getByRole('button', { name: '等待裝置驗證…', exact: true })).toBeDisabled();
    await passkeyShot(`passkey-${kind}-waiting-dark-320x480-scale1.3`);
    release(); await expect(page.getByRole('alert')).toContainText('驗證未完成');
    await passkeyShot(`passkey-${kind}-error-dark-320x480-scale1.3`); await page.unroute(endpoint, handler);
    await page.setViewportSize({ width: 1440, height: 1050 }); await passkeyAppearance('dark', 1.15);
}

try {
    await free(uiPort); await free(apiPort);
    const countFile = path.join(temporary, 'counts.json'), backendFile = path.join(temporary, 'backend.py');
    await writeFile(countFile, JSON.stringify({ boots: 0, sdkCalls: 0, keychainCalls: 0, sdkTransactions: 0, sdkReadFixtures: 0, marketReads: 0 }));
    await writeFile(path.join(temporary, 'test.p12'), 'QA fixture, never passed to SDK');
    await writeFile(backendFile, `import os,json,sys,threading
from pathlib import Path
from copy import deepcopy
from datetime import timedelta
from types import SimpleNamespace
import fubon_bridge.__main__ as entry
from fubon_bridge.app import create_app as real_create_app
from fubon_bridge.config import Config
from fubon_bridge.keychain import Keychain
from fubon_bridge.passkeys import PasskeyStore
from fubon_bridge.research import ResearchStore
from fubon_bridge.mapping import now,market_events

root=Path(os.environ['MODE_TEMP']); counts_file=root/'counts.json'; count_lock=threading.Lock()
def count(key):
    with count_lock:
        value=json.loads(counts_file.read_text()); value[key]+=1; counts_file.write_text(json.dumps(value))
def no_sdk(*args,**kwargs):
    count('sdkCalls'); raise AssertionError('QA forbids vendor SDK')
def no_keychain(*args,**kwargs):
    count('keychainCalls'); raise AssertionError('QA forbids Keychain')
Keychain.read=no_keychain
class ReadonlyFixtures:
    def result(self,data):
        count('sdkReadFixtures'); return SimpleNamespace(is_success=True,data=data)
    def get_order_results(self,*args): return self.result([])
    def query_single_position(self,*args): return self.result([])
    def inventories(self,*args): return self.result([])
    def unrealized_gains_and_loses(self,*args): return self.result([])
    def query_margin_equity(self,*args): return self.result([dict(currency='NTD')])
    def __getattr__(self,key):
        count('sdkTransactions'); raise AssertionError('QA forbids SDK transaction '+key)
class Sentinel:
    def __init__(self):
        self.futopt=self.stock=self.accounting=self.futopt_accounting=ReadonlyFixtures()
    def shutdown(self): pass
    def __getattr__(self,key):
        count('sdkTransactions'); raise AssertionError('QA forbids SDK access '+key)
research=ResearchStore(root/'research.sqlite3')
with research.connect() as db:
    db.execute('CREATE TABLE qa_evidence (id INTEGER PRIMARY KEY, value TEXT)')
    db.execute("INSERT INTO qa_evidence VALUES (1,'preserve research')")
entry.ROOT=root
Config.from_env=classmethod(lambda cls: Config(mode='paper',port=int(os.environ['MODE_API_PORT']),test_id='QA',test_cert_path=str(root/'test.p12')))
def create_app(config,**kwargs):
    count('boots')
    if json.loads(counts_file.read_text())['boots']==1: kwargs['launch_token']=os.environ['MODE_LAUNCH']
    app=real_create_app(config,sdk_factory=no_sdk,passkey_store=PasskeyStore(root/'passkeys.sqlite3'),research_store=research,**kwargs)
    broker=app.state.broker; trader=app.state.automation; learning=app.state.learning
    broker._demo_catalog()
    for c in broker.catalog.values():
        c['name']='QA 合成行情 '+c['code']
        if c['security_type']=='FUT': c['delivery_date']=(now().date()+timedelta(days=10)).isoformat()
    def contract(key,**kw):
        count('marketReads'); c=broker.catalog.get(key['code'])
        if c is None: raise ValueError('Unknown QA contract')
        return deepcopy(c)
    broker.contract=contract
    broker.contracts=lambda kind:[deepcopy(c) for c in broker.catalog.values() if c['security_type']==kind and not c.get('target_code')]
    def quote(c):
        count('marketReads'); price=25000 if c['security_type']=='FUT' else c['reference']
        return dict(code=c['code'],exchange=c['exchange'],datetime=now().isoformat(),reference=c['reference'],open=price,high=price+10,low=price-10,close=price,average_price=price,buy_price=price,sell_price=price,buy_volume=10,sell_volume=10,volume=10,total_volume=1000,amount=0,total_amount=0,change_price=0,change_rate=0,change_type='',tick_type='0',volume_ratio=0,yesterday_volume=0)
    broker.quote=quote
    def subscribe(key,kind):
        c=contract(key); broker.subscriptions[(c['code'],kind)]=dict(contract=c,kind='stock' if c['security_type']=='STK' else 'futopt',channel='trades' if kind=='Tick' else 'books')
    broker.subscribe=subscribe; broker.unsubscribe=lambda *a:None
    def connect():
        broker.sdk=Sentinel(); broker.error=None; broker.connected_sockets.update({'stock','futopt'})
        if config.broker_orders:
            broker.accounts_raw={('F','QA','MODE-F'):SimpleNamespace(name='QA 合成帳戶')}
    broker.connect=connect
    broker.kbars=lambda *args,**kwargs:dict(datetime=[],Open=[],High=[],Low=[],Close=[],Volume=[])
    broker.ticks=lambda *args,**kwargs:dict(ts=[],close=[],volume=[],bid_price=[],ask_price=[])
    def events():
        for sub in list(broker.subscriptions.values()):
            c=sub['contract']; q=quote(c)
            raw=dict(symbol=c['code'],type='EQUITY' if c['security_type']=='STK' else 'FUTURE',time=int(now().timestamp()*1e6),trades=[dict(price=q['close'],size=1)],total=dict(tradeVolume=1000),bids=[dict(price=q['close']-i,size=10) for i in range(5)],asks=[dict(price=q['close']+i,size=10) for i in range(5)])
            for event,payload in market_events(sub['channel'],raw,c['code'],q): broker.emit(event,payload)
    broker.demo_events=events
    @app.post('/api/v1/qa/mode')
    def qa(body:dict):
        if 'research' in body: learning.current=dict(status='running') if body['research'] else None
        if 'monitoring' in body: trader.monitoring=body['monitoring']
        if body.get('seed') or body.get('position') or body.get('flatten') or body.get('order'):
            if config.mode!='paper': raise ValueError('QA local book only')
            c=contract(dict(code='TMFK6')); account=dict(account_type='F',broker_id='LOCAL',account_id='PAPER-F')
            def place(action,price=0,policy='IOC'):
                return broker.paper.place(c,dict(action=action,price=price,quantity=1,price_type='MKT' if not price else 'LMT',order_type=policy,octype='Auto'),account,quote(c),cost=dict(fee_per_side=12,tax_rate=.00002,fee_source='statement'))
            if body.get('seed'): place('Buy'); place('Sell')
            if body.get('position'): place('Buy')
            if body.get('flatten'): place('Sell')
            if body.get('order'): place('Buy',24000,'ROD')
        if body.get('cancel'):
            for trade in broker.paper.overview()['orders']:
                if trade['status']['status']=='Submitted': broker.paper.cancel(trade['order']['id'])
        with research.connect() as db: evidence=db.execute('SELECT value FROM qa_evidence WHERE id=1').fetchone()[0]
        return dict(counts=json.loads(counts_file.read_text()),ledger=broker.paper.overview(),evidence=evidence)
    app.router.routes.insert(0,app.router.routes.pop())
    return app
entry.create_app=create_app
sys.argv=['fixture','--ui-url',os.environ['MODE_ORIGIN'],'--no-browser']
entry.main()
`);
    run(process.env.MODE_PYTHON || path.join(root, 'server/.venv/bin/python'), [backendFile], {
        PYTHONPATH: path.join(root, 'server'), MODE_TEMP: temporary, MODE_API_PORT: String(apiPort), MODE_LAUNCH: launch, MODE_ORIGIN: origin,
    });
    run(process.execPath, [path.join(root, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(uiPort), '--strictPort'], {
        VITE_API_TARGET: `http://127.0.0.1:${apiPort}`, VITE_API_BASE: '', VITE_STREAM_BASE: origin, VITE_DEV_SERVER_PORT: '',
    });
    await ready(`http://127.0.0.1:${apiPort}/api/v1/passkeys/status`); await ready(origin);
    browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true });
    context = await browser.newContext({ viewport: { width: 1440, height: 1050 } }); page = await context.newPage();
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.route('**/api/v1/order/**', async route => {
        const endpoint = new URL(route.request().url()).pathname;
        if (!/\/(trades|trade_cache_health)$/.test(endpoint)) orderRequests.push(endpoint);
        return route.continue();
    });
    const cdp = await context.newCDPSession(page); await cdp.send('WebAuthn.enable');
    await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
    if (process.env.MODE_PASSKEY_QA === '1') {
        await page.goto(origin + '/#fubon-launch=' + launch); await expect(page.getByRole('button', { name: '建立 Passkey 並解鎖', exact: true })).toBeVisible();
        await passkeyViews('register');
        await page.getByRole('button', { name: '建立 Passkey 並解鎖', exact: true }).click();
        await expect(page.getByRole('button', { name: '交易模式設定', exact: true })).toBeVisible({ timeout: 30000 });
        await page.getByRole('button', { name: '鎖定介面', exact: true }).click();
        await expect(page.getByRole('button', { name: '使用 Passkey 解鎖', exact: true })).toBeVisible();
        await passkeyViews('authenticate'); await unlock();
        scenarios.push('compact Passkey registration/unlock at 320/390/1440, dark/light, scales 1/1.3; waiting/error at 320x480 scroll safely with reachable action');
    } else await unlock(true);
    const initial = await settings(); expect(initial.mode).toBe('paper'); expect(initial.live_enabled).toBe(false);
    await page.evaluate(() => {
        localStorage.setItem('fubon.contract-fees.v1', JSON.stringify({ TMF: { product: 'TMF', feePerSide: 12, source: 'statement', updatedAt: '2026-11-16T00:00:00Z' } }));
        localStorage.setItem('sj-pro-risk', JSON.stringify({ enabled: false, locked: false, confirmManualOrders: false }));
    });
    const seeded = await qa({ seed: true }); expect(seeded.ledger.orders).toHaveLength(2); expect(seeded.ledger.positions).toEqual([]);
    const body = { mode: 'live', live_enabled: true, instance_id: initial.instance_id, acknowledgement: '' };
    expect((await request('/api/v1/settings/mode', body)).status).toBe(400);
    expect((await request('/api/v1/settings/mode', { ...body, live_enabled: false, acknowledgement: '確認啟用正式下單' })).status).toBe(422);
    expect((await request('/api/v1/settings/mode', { ...body, instance_id: 'stale', acknowledgement: '確認啟用正式下單' })).status).toBe(409);
    expect((await settings()).mode).toBe('paper'); scenarios.push('backend rejects missing confirmation, disabled permission and stale instance');
    await open(); await expect(apply()).toBeDisabled();
    await dialog().getByRole('combobox').click(); await expect(page.getByRole('option')).toHaveCount(4); await shot('mode-select-dark-1440');
    await page.getByRole('option', { name: '正式交易', exact: true }).click();
    const liveButton = () => dialog().getByRole('button', { name: '確認並啟用正式下單', exact: true });
    await expect(dialog().getByRole('switch', { name: '允許正式下單', exact: true })).not.toBeChecked(); await expect(liveButton()).toBeDisabled();
    await dialog().getByRole('switch', { name: '允許正式下單', exact: true }).click();
    await dialog().getByLabel('輸入「確認啟用正式下單」', { exact: true }).fill('確認'); await expect(liveButton()).toBeDisabled();
    await dialog().getByLabel('輸入「確認啟用正式下單」', { exact: true }).fill('確認啟用正式下單'); await expect(liveButton()).toBeEnabled();
    await select('展示模式'); await select('正式交易');
    await expect(dialog().getByRole('switch', { name: '允許正式下單', exact: true })).not.toBeChecked();
    await expect(dialog().getByLabel('輸入「確認啟用正式下單」', { exact: true })).toHaveValue('');
    await shot('mode-live-dark-1440'); await page.keyboard.press('Escape');
    expect((await settings()).mode).toBe('paper'); scenarios.push('four shared Select choices, fresh live switch/text required; cancel never applies');
    for (const [kind, clear, detail] of [
        [{ research: true }, { research: false }, '研究工作執行中'],
        [{ monitoring: true }, { monitoring: false }, '請先停止策略'],
        [{ order: true }, { cancel: true }, '模擬帳簿仍有持倉或未完成委託'],
        [{ position: true }, { flatten: true }, '模擬帳簿仍有持倉或未完成委託'],
    ]) {
        await qa(kind); await open(); await select('展示模式'); await apply().click();
        await expect(dialog().getByRole('alert')).toContainText(detail); await page.keyboard.press('Escape');
        expect((await settings()).instance_id).toBe(initial.instance_id); await qa(clear);
    }
    scenarios.push('research, strategy monitoring, pending paper order and paper position each block UI switching');
    await switchMode('展示模式', 'demo'); await switchMode('Paper 模擬交易', 'paper');
    const restored = await qa(); expect(restored.ledger.orders).toHaveLength(5); expect(restored.ledger.positions).toEqual([]);
    expect(restored.evidence).toBe('preserve research');
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('fubon.contract-fees.v1')).TMF.feePerSide)).toBe(12);
    scenarios.push('real CLI restarts paper/demo/paper; instance changes, old session 401, re-unlock required; paper book/research/fee preserved');
    await switchMode('富邦 Sandbox', 'sandbox'); await switchMode('正式交易', 'live', true);
    await page.getByRole('button', { name: '設定', exact: true }).click();
    const riskDialog = page.getByRole('dialog', { name: '設定', exact: true });
    await riskDialog.getByRole('tab', { name: '風控', exact: true }).click();
    await expect(riskDialog.getByRole('switch', { name: '手動下單確認', exact: true })).toBeChecked();
    await expect(riskDialog.getByRole('switch', { name: '手動下單確認', exact: true })).toBeDisabled();
    await page.keyboard.press('Escape');
    const ticket = page.locator('[data-slot="card"]').filter({ hasText: '下單面板' }).first();
    await ticket.getByRole('button', { name: 'MKT', exact: true }).click();
    await expect(ticket.getByRole('button', { name: '買進下單', exact: true })).toBeEnabled();
    await ticket.getByRole('button', { name: '買進下單', exact: true }).click();
    await ticket.getByRole('button', { name: /^確認買進/ }).click();
    const confirm = page.getByRole('dialog', { name: '委託確認', exact: true });
    await expect(confirm).toBeVisible(); await expect(confirm).toContainText('正式環境');
    const confirmFile = path.join(artifacts, 'live-manual-order-confirm.png'); await confirm.screenshot({ path: confirmFile, animations: 'disabled' }); screenshots.push(confirmFile);
    await confirm.getByRole('button', { name: '取消', exact: true }).click(); await expect(confirm).toBeHidden();
    expect(orderRequests).toEqual([]);
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('sj-pro-risk')).confirmManualOrders)).toBe(false);
    scenarios.push('live forces each manual order confirmation despite stored false preference; disabled setting; cancel sends no order and leaves preference unchanged');
    await switchMode('Paper 模擬交易', 'paper');
    scenarios.push('sandbox and explicitly confirmed live selectable only in isolated no-SDK fixture; returns safely to paper');
    await theme('淺色'); await open(); await select('正式交易'); await shot('mode-live-light-1440'); await page.keyboard.press('Escape');
    await page.setViewportSize({ width: 390, height: 844 }); await open(); await select('正式交易');
    await shot('mode-live-light-390');
    const mobileApply = dialog().getByRole('button', { name: '確認並啟用正式下單', exact: true });
    await mobileApply.scrollIntoViewIfNeeded();
    const mobileAction = await mobileApply.boundingBox();
    expect(mobileAction.y).toBeGreaterThanOrEqual(0); expect(mobileAction.y + mobileAction.height).toBeLessThanOrEqual(844);
    let overflow = await dialog().evaluate(el => ({ width: el.getBoundingClientRect().width, scroll: el.scrollWidth, client: el.clientWidth }));
    expect(overflow.scroll).toBeLessThanOrEqual(overflow.client + 1); expect(overflow.width).toBeLessThanOrEqual(390);
    await page.keyboard.press('Escape'); await theme('深色'); await open(); await select('正式交易'); await shot('mode-live-dark-390');
    const visibleNative = await page.locator('select:visible').count(); expect(visibleNative).toBe(0); await page.keyboard.press('Escape');
    const final = await qa(); expect(final.counts.sdkCalls).toBe(0); expect(final.counts.keychainCalls).toBe(0); expect(final.counts.sdkTransactions).toBe(0);
    expect(pageErrors).toEqual([]); expect(JSON.parse(await readFile(path.join(temporary, 'server/.mode-settings.json'), 'utf8'))).toEqual({ mode: 'paper', live_enabled: false });
    scenarios.push('390/1440 dark/light, no native Select, no dialog overflow or browser exceptions; persisted final mode paper');
    await writeFile(path.join(artifacts, 'summary.json'), JSON.stringify({ passed: true, scenarios, counts: final.counts, pageErrors, orderRequests, screenshots, passkeyGeometry, temporary }, null, 2));
    console.log(JSON.stringify({ passed: true, scenarios, counts: final.counts, pageErrors, artifacts }, null, 2));
} catch (error) {
    await writeFile(path.join(artifacts, 'failure.log'), logs);
    await page?.screenshot({ path: path.join(artifacts, 'failure.png'), fullPage: true }).catch(() => undefined);
    throw error;
} finally { await cleanup(); }
