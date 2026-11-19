// Isolated acceptance: real PaperGateway/PaperBook, synthetic quotes, temporary SQLite.
// Never initializes any brokerage SDK or reads Keychain; no user runtime is touched.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';

const root = fileURLToPath(new URL('../', import.meta.url));
const uiPort = Number(process.env.PAPER_UI_PORT || 6194), apiPort = Number(process.env.PAPER_API_PORT || 22994);
const origin = `http://localhost:${uiPort}`;
const temporary = await mkdtemp(path.join(tmpdir(), 'fubon-paper-fixture-'));
const artifacts = process.env.PAPER_ARTIFACT_DIR || '/private/tmp/fubon-paper-qa-20261115';
await mkdir(artifacts, { recursive: true });
const launch = randomBytes(32).toString('base64url');
const clockFile = path.join(temporary, 'clock.json'), countFile = path.join(temporary, 'counts.json');
const backendFile = path.join(temporary, 'backend.py');
const manual = { account_type: 'F', broker_id: 'LOCAL', account_id: 'PAPER-F' };
const strategy = { ...manual, account_id: 'PAPER-AUTO-F' };
const cost = { fee_per_side: 12, tax_rate: .00002, fee_source: 'statement' };
const children = [], pageErrors = [], orderRequests = [], scenarios = [], screenshots = [];
let browser, context, page, backend, logs = '', closing;
const panel = () => page.getByRole('region', { name: 'Paper 自動交易', exact: true });
const ledger = () => page.getByRole('region', { name: 'Paper 持久模擬帳簿', exact: true });
const ticket = () => page.locator('[data-slot="card"]').filter({ hasText: '下單面板' }).first();
const button = name => panel().getByRole('button', { name, exact: true });

function run(command, args, env = {}) {
    const child = spawn(command, args, { cwd: root, detached: process.platform !== 'win32',
        env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { logs = (logs + data).slice(-40000); });
    child.on('error', error => { logs += error.message; });
    children.push(child); return child;
}
async function free(port) {
    await new Promise((resolve, reject) => { const probe = net.createServer(); probe.once('error', reject);
        probe.listen(port, '127.0.0.1', () => probe.close(resolve)); });
}
async function ready(url) {
    for (let i = 0; i < 300; i++) {
        if (children.some(child => child.exitCode !== null && child.exitCode !== 0)) throw new Error('QA server exited unexpectedly.');
        try { if ((await fetch(url, { signal: AbortSignal.timeout(500) })).status < 500) return; } catch { /* Starting. */ }
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`QA server did not start: ${url}`);
}
async function stop(child) {
    if (!child || child.exitCode !== null || child.signalCode) return;
    const exited = new Promise(resolve => child.once('exit', resolve));
    try { process.kill(process.platform === 'win32' ? child.pid : -child.pid, 'SIGTERM'); } catch { return; }
    await Promise.race([exited, new Promise((_, reject) => setTimeout(() => reject(new Error('QA process did not stop.')), 15000))]);
}
async function cleanup() {
    return closing ??= (async () => { await browser?.close().catch(() => undefined);
        for (const child of [...children].reverse()) await stop(child); })();
}
for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]]) process.once(signal, () => { void cleanup().finally(() => process.exit(code)); });
async function request(endpoint, body, token) {
    if (token) { const response = await page.request.fetch(`${origin}${endpoint}`, { method: body === undefined ? 'GET' : 'POST',
        headers: { Authorization: `Bearer ${token}` }, ...(body === undefined ? {} : { data: body }) });
        return { status: response.status(), data: await response.json() }; }
    return page.evaluate(async ({ endpoint, body }) => {
        const response = await fetch(endpoint, { method: body === undefined ? 'GET' : 'POST',
            headers: { Authorization: `Bearer ${sessionStorage.getItem('fubon-trading-session')}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        return { status: response.status, data: await response.json() };
    }, { endpoint, body });
}
async function advance(body = {}) {
    const response = await request('/api/v1/qa/paper', body); expect(response.status).toBe(200);
    expect(response.data.counts.sdkCalls).toBe(0); expect(response.data.counts.keychainCalls).toBe(0);
    expect(response.data.counts.sdkTransactions).toBe(0); return response.data;
}
async function paperState() { const result = await request('/api/v1/paper/state'); expect(result.status).toBe(200); return result.data; }
function order(overrides = {}, account = manual, policy = cost) {
    return { contract: { code: 'TMFK6', security_type: 'FUT' }, paper_cost: policy,
        futures_order: { action: 'Buy', price: 0, quantity: 1, price_type: 'MKT', order_type: 'IOC', octype: 'Auto', account, ...overrides } };
}
async function place(overrides = {}, account = manual, policy = cost) {
    const response = await request('/api/v1/order/place_order', order(overrides, account, policy));
    expect(response.status, JSON.stringify(response)).toBe(200); return response.data;
}
async function mutate(kind, trade, value = {}) {
    const response = await request(`/api/v1/order/${kind}`, { trade_id: trade.order.id, ...value });
    expect(response.status, JSON.stringify(response)).toBe(200); return response.data;
}
async function shot(name, target = panel()) {
    const filename = path.join(artifacts, `${name}.png`); await target.screenshot({ animations: 'disabled', path: filename }); screenshots.push(filename);
}
async function theme(name) {
    await page.getByRole('button', { name: '設定', exact: true }).click();
    const settings = page.getByRole('dialog', { name: '設定', exact: true });
    await settings.getByRole('tab', { name: '外觀', exact: true }).click();
    await settings.getByRole('radio', { name, exact: true }).click(); await page.keyboard.press('Escape'); await expect(settings).toBeHidden();
}
async function addPanel(search) {
    await page.getByRole('button', { name: /新增面板/ }).first().click();
    const picker = page.getByRole('dialog', { name: '新增面板', exact: true });
    await picker.getByPlaceholder('搜尋面板（名稱或用途）').fill(search);
    await picker.locator('button[data-idx]').filter({ hasText: search }).first().click();
}
async function workspace(types) {
    await page.evaluate(types => {
        const saved = JSON.parse(localStorage.getItem('sj-pro-workspace-v3'));
        const blocks = types.map(type => ({ ...saved.blocks.find(b => b.type === type), type, id: `qa-paper-${type}`, pin: type === 'ticket' ? 'TMFK6' : null }));
        localStorage.setItem('sj-pro-workspace-v3', JSON.stringify({ ...saved, blocks,
            layout: blocks.map((b, i) => ({ i: b.id, x: 0, y: i * 24, w: 288, h: 24, minW: 96, minH: 8 })) }));
    }, types); await page.reload(); await expect(panel()).toBeVisible();
}
async function refreshLedger() { await ledger().getByRole('button', { name: '更新模擬帳簿', exact: true }).click(); }
async function align(target) {
    await target.evaluate(el => {
        const scroll = el.closest('[aria-label="Paper 自動交易"]');
        scroll.scrollTop += el.getBoundingClientRect().top - scroll.getBoundingClientRect().top;
    });
}
async function unlock(enrolled = false) {
    await page.goto(`${origin}/#fubon-launch=${launch}`);
    await page.getByRole('button', { name: enrolled ? '使用 Passkey 解鎖' : '建立 Passkey 並解鎖', exact: true }).click();
    await expect(page.getByText('LIVE', { exact: true })).toBeVisible({ timeout: 30000 });
}
function startBackend() {
    return run(process.env.PAPER_PYTHON || path.join(root, 'server', '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'), [backendFile], {
        PYTHONPATH: path.join(root, 'server'), PAPER_API_PORT: String(apiPort), PAPER_ORIGIN: origin, PAPER_LAUNCH: launch,
        PAPER_DATABASE: path.join(temporary, 'research.sqlite3'), PAPER_PASSKEY_DATABASE: path.join(temporary, 'passkeys.sqlite3'), PAPER_CLOCK: clockFile, PAPER_COUNTS: countFile,
    });
}

try {
    await free(uiPort); await free(apiPort);
    await writeFile(countFile, JSON.stringify({ sdkCalls: 0, keychainCalls: 0, sdkTransactions: 0, marketReads: 0, boots: 0 }));
    await writeFile(clockFile, JSON.stringify({ at: '2026-11-13T09:19:00+08:00', mono: 0, price: 25000, spread: 0 }));
    await writeFile(backendFile, `import os,json,threading
from pathlib import Path
from copy import deepcopy
from datetime import datetime
from types import SimpleNamespace
import uvicorn
from fastapi import Request
import fubon_bridge.broker as broker_module
from fubon_bridge.app import create_app
from fubon_bridge.auto_gateway import PaperGateway
from fubon_bridge.auto_store import AutoStore
from fubon_bridge.auto_trading import SandboxAutoTrader
from fubon_bridge.config import Config
from fubon_bridge.keychain import Keychain
from fubon_bridge.mapping import TAIPEI,market_events
from fubon_bridge.passkeys import PasskeyStore
from fubon_bridge.research import ResearchStore
counts_file=Path(os.environ['PAPER_COUNTS']); clock_file=Path(os.environ['PAPER_CLOCK'])
count_lock=threading.Lock()
def count(key):
    with count_lock:
        value=json.loads(counts_file.read_text()); value[key]+=1; counts_file.write_text(json.dumps(value))
count('boots')
raw=json.loads(clock_file.read_text())
clock=SimpleNamespace(**dict(raw,at=datetime.fromisoformat(raw['at'])))
broker_module.now=lambda:clock.at
def no_sdk(*args,**kw):
    count('sdkCalls'); raise AssertionError('QA forbids SDK initialization')
def no_keychain(*args,**kw):
    count('keychainCalls'); raise AssertionError('QA forbids Keychain reads')
Keychain.read=no_keychain
class Sentinel:
    def shutdown(self): pass
    def __getattr__(self,key):
        count('sdkTransactions'); raise AssertionError('QA forbids SDK access: '+key)
class ManualTrader(SandboxAutoTrader):
    def tick(self): pass
    def manual_tick(self): super().tick()
def factory(broker,research,authorize):
    return ManualTrader(PaperGateway(broker),AutoStore(research,'paper'),authorize,clock=lambda:clock.at,monotonic=lambda:clock.mono)
app=create_app(Config(mode='paper',session='regular',port=int(os.environ['PAPER_API_PORT'])),sdk_factory=no_sdk,
    launch_token=os.environ['PAPER_LAUNCH'],public_origin=os.environ['PAPER_ORIGIN'],
    passkey_store=PasskeyStore(os.environ['PAPER_PASSKEY_DATABASE']),research_store=ResearchStore(os.environ['PAPER_DATABASE']),automation_factory=factory)
broker=app.state.broker; trader=app.state.automation
broker.paper.clock=lambda:clock.at
broker._demo_catalog()
for contract in broker.catalog.values():
    if contract['security_type']=='FUT': contract['delivery_date']='2026-11-18'
    contract['name']='QA 合成行情 '+contract['code']
broker.catalog['TMFL6']=dict(broker.catalog['TMFK6'],code='TMFL6',target_code=None,delivery_date='2026-12-16',delivery_month='202612')
broker.future_product_catalog={c['root']:dict(symbol=c['root'],name=c['name'],contractSize=c['multiplier'])
    for c in broker.catalog.values() if c['security_type']=='FUT' and not c.get('target_code')}
def contract(key,**kw):
    count('marketReads')
    value=broker.catalog.get(key['code'])
    if not value: raise ValueError('QA fixture contract unavailable')
    return deepcopy(value)
broker.contract=contract
broker.contracts=lambda kind:[deepcopy(c) for c in broker.catalog.values() if c['security_type']==kind and not c.get('target_code')]
def quote(c):
    count('marketReads')
    price=clock.price if c['security_type']=='FUT' else c['reference']
    return dict(code=c['code'],exchange=c['exchange'],datetime=clock.at.isoformat(),reference=c['reference'],
        open=price,high=price+10,low=price-10,close=price,average_price=price,buy_price=price-clock.spread,sell_price=price+clock.spread,
        buy_volume=10,sell_volume=10,volume=10,total_volume=1000,amount=0,total_amount=0,change_price=0,change_rate=0,change_type='',tick_type='0',volume_ratio=0,yesterday_volume=0)
broker.quote=quote
def subscribe(key,kind):
    c=broker.contract(key); broker.subscriptions[(c['code'],kind)]=dict(contract=c,kind='stock' if c['security_type']=='STK' else 'futopt',channel='trades' if kind=='Tick' else 'books')
broker.subscribe=subscribe
broker.unsubscribe=lambda *a:None
def connect():
    broker.sdk=Sentinel(); broker.error=None; broker.connected_sockets.update({'stock','futopt'})
broker.connect=connect
def kbars(key,start,end):
    count('marketReads')
    at=datetime.fromisoformat(start+'T09:00:00+08:00').timestamp()
    bars=[dict(time=int(at+(i+1)*60),open=25000 if i<19 else 25020,high=25010 if i<19 else 25030,low=24990,close=25000 if i<19 else 25020,volume=10) for i in range(260)]
    return dict(datetime=[datetime.fromtimestamp(b['time'],TAIPEI).isoformat() for b in bars],**{col:[b[key] for b in bars] for key,col in [('open','Open'),('high','High'),('low','Low'),('close','Close'),('volume','Volume')]})
broker.kbars=kbars
def events():
    for sub in list(broker.subscriptions.values()):
        c=sub['contract']; q=quote(c)
        raw=dict(symbol=c['code'],type='EQUITY' if c['security_type']=='STK' else 'FUTURE',time=int(clock.at.timestamp()*1e6),trades=[dict(price=q['close'],size=1)],total=dict(tradeVolume=1000),
            bids=[dict(price=q['buy_price']-i,size=10) for i in range(5)],asks=[dict(price=q['sell_price']+i,size=10) for i in range(5)])
        for event,payload in market_events(sub['channel'],raw,c['code'],q): broker.emit(event,payload)
broker.demo_events=events
@app.post('/api/v1/qa/paper')
def qa(request:Request,body:dict):
    with trader.lock:
        for key in ('at','mono','price','spread'):
            if key in body: setattr(clock,key,datetime.fromisoformat(body[key]) if key=='at' else body[key])
        clock_file.write_text(json.dumps(dict(at=clock.at.isoformat(),mono=clock.mono,price=clock.price,spread=clock.spread)))
        if body.get('bookTick'): broker.paper.tick('TMFK6',quote(broker.catalog['TMFK6']))
        for _ in range(body.get('ticks',0)): trader.manual_tick()
        result=dict(state=trader.snapshot(request.headers.get('authorization','')),ledger=broker.paper.overview(),
            manual=broker.paper.overview('PAPER-F'),strategy=broker.paper.overview('PAPER-AUTO-F'),
            daily=broker.paper.overview('PAPER-F',clock.at.date().isoformat()),counts=json.loads(counts_file.read_text()))
        if body.get('viewer'): result['viewerToken']=app.state.session.issue()
        return result
app.router.routes.insert(0,app.router.routes.pop())
uvicorn.run(app,host='127.0.0.1',port=int(os.environ['PAPER_API_PORT']),access_log=False)
`);
    backend = startBackend();
    run(process.execPath, [path.join(root, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(uiPort), '--strictPort'], {
        VITE_API_TARGET: `http://127.0.0.1:${apiPort}`, VITE_API_BASE: '', VITE_STREAM_BASE: origin, VITE_DEV_SERVER_PORT: '',
    });
    await ready(`http://127.0.0.1:${apiPort}/api/v1/passkeys/status`); await ready(origin);
    browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true, ignoreDefaultArgs: ['--hide-scrollbars'] });
    context = await browser.newContext({ viewport: { width: 1440, height: 1050 } }); page = await context.newPage();
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.route('**/api/v1/order/**', async route => {
        const req = route.request(), endpoint = new URL(req.url()).pathname;
        if (req.method() !== 'GET' && !/\/(trades|trade_cache_health)$/.test(endpoint)) {
            const body = req.postDataJSON(); orderRequests.push({ endpoint, body });
            // Only this isolated paper server is allowed; broker mutation defenses are tested below.
            expect(new URL(req.url()).origin).toBe(origin);
        }
        return route.continue();
    });
    const cdp = await context.newCDPSession(page); await cdp.send('WebAuthn.enable');
    await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
    await unlock(); await addPanel('自動交易'); await workspace(['autotrade']);
    await expect(ledger()).toBeVisible(); await expect(ledger()).toContainText('尚無 paper 委託');
    const initial = await advance(); expect(initial.ledger.persistent).toBe(true); expect(initial.ledger.orders).toEqual([]);
    expect(initial.state.mode).toBe('paper'); expect(initial.state.available).toBe(true);
    await panel().getByLabel('每口單邊手續費 NT$', { exact: true }).fill('12'); await button('依對帳單保存費率').click();
    await expect(panel().getByText(/TMF 個人費率：每口單邊 \$12/)).toBeVisible();
    await panel().getByRole('combobox', { name: '策略模擬帳戶', exact: true }).click();
    await expect(page.getByRole('option', { name: 'LOCAL-PAPER-AUTO-F', exact: true })).toBeVisible();
    await expect(page.getByRole('option', { name: 'LOCAL-PAPER-F', exact: true })).toHaveCount(0);
    await page.screenshot({ path: path.join(artifacts, 'paper-select-open.png') }); screenshots.push(path.join(artifacts, 'paper-select-open.png'));
    await page.keyboard.press('Escape');
    await addPanel('下單面板'); await addPanel('持倉/委託/帳務'); await workspace(['autotrade', 'ticket', 'dock']);
    await expect(ticket().getByRole('button', { name: '買進 Buy', exact: true })).toBeVisible();
    await ticket().getByLabel('數量（口）', { exact: true }).fill('1');
    await ticket().locator('input[inputmode="decimal"]').first().fill('26000');
    await ticket().getByRole('button', { name: '買進下單', exact: true }).click();
    await ticket().getByRole('button', { name: /^確認買進 / }).click();
    const confirmation = page.getByRole('dialog', { name: '委託確認', exact: true });
    if (await confirmation.isVisible()) await confirmation.getByRole('button', { name: '確認買進', exact: true }).click();
    await expect.poll(async () => (await paperState()).orders.length).toBe(1);
    const uiOrder = (await paperState()).orders[0];
    expect(uiOrder.status.status).toBe('Filled'); expect(uiOrder.order.account.account_id).toBe('PAPER-F');
    expect(uiOrder.paper.cost).toMatchObject(cost); expect(uiOrder.paper.fee).toBe(12); expect(uiOrder.paper.tax).toBe(5);
    expect(orderRequests.find(r => r.endpoint.endsWith('place_order')).body.paper_cost).toEqual(cost);
    await advance({ price: 25010 }); await place({ action: 'Sell', octype: 'Cover' });
    const roundtrip = await advance(); expect(roundtrip.manual.realizedGross).toBe(100); expect(roundtrip.manual.realizedNet).toBe(66);
    expect(roundtrip.manual.fee).toBe(24); expect(roundtrip.manual.tax).toBe(10);
    scenarios.push({ name: 'real-ticket-personal-fee-and-roundtrip', net: roundtrip.manual.realizedNet, fee: 24, tax: 10 });
    await advance({ price: 27500 }); const boundary = await place({ action: 'Sell', quantity: 2 });
    expect(boundary.paper.fee).toBe(24); expect(boundary.paper.tax).toBe(12);
    await advance({ price: 27490 }); await place({ action: 'Buy', quantity: 2, octype: 'Cover' });
    // Sell 27,500 rounds 5.5 to 6 per contract; buy 27,490 rounds 5.498 to 5.
    expect((await advance()).manual.realizedNet).toBe(196);
    scenarios.push({ name: 'per-contract-half-up-tax', price: 27500, quantity: 2, tax: boundary.paper.tax });
    await advance({ price: 25010 });
    const reduced = await place({ price: 24000, price_type: 'LMT', order_type: 'ROD', quantity: 2 });
    expect(reduced.paper.fee).toBe(0); await mutate('update_qty', reduced, { quantity: 1 });
    const modified = await mutate('update_price', reduced, { price: 25010 });
    expect(modified.status.deal_quantity).toBe(1); expect(modified.paper.fee).toBe(12); expect(modified.paper.tax).toBe(5);
    const cancelled = await place({ price: 24000, price_type: 'LMT', order_type: 'ROD' });
    expect((await mutate('cancel_order', cancelled)).paper.fee).toBe(0);
    const pending = await place({ price: 24000, price_type: 'LMT', order_type: 'ROD' });
    expect((await request('/api/v1/order/place_order', order({}, strategy))).status).toBe(400);
    const invalid = await request('/api/v1/order/place_order', order({}, manual, { ...cost, fee_per_side: -1 })); expect(invalid.status).toBe(422);
    await refreshLedger(); await ledger().getByText('已保存的委託與持倉（委託顯示最近20筆）', { exact: true }).click();
    await expect(ledger().getByRole('table', { name: 'Paper 保存委託' })).toContainText('已核對');
    await expect(ledger().getByRole('table', { name: 'Paper 保存持倉' })).toContainText('PAPER-F');
    await shot('paper-manual-ledger', ledger());
    await page.locator('[data-slot="card"]').filter({ hasText: '持倉/委託/帳務' }).first().screenshot({ path: path.join(artifacts, 'paper-cross-panel.png') }); screenshots.push(path.join(artifacts, 'paper-cross-panel.png'));
    await workspace(['autotrade']);
    await panel().getByRole('combobox', { name: '策略盤別', exact: true }).click();
    await page.getByRole('option', { name: '現貨重疊日盤 09:00–13:20', exact: true }).click();
    await panel().getByLabel('實際開盤日期（夜盤為15:00所在日）', { exact: true }).fill('2026-11-13');
    await panel().getByRole('combobox', { name: '微台具體合約', exact: true }).click();
    await page.getByRole('option', { name: 'TMFK6 · 2026-11-18 到期', exact: true }).click();
    await advance({ price: 25020, spread: 1 });
    await button('啟動／恢復 paper 策略').click(); await expect(panel().getByText('策略執行中', { exact: true })).toBeVisible();
    const intent = await advance({ at: '2026-11-13T09:20:01+08:00', ticks: 1 });
    expect(intent.state.pending).toBeTruthy(); expect(intent.strategy.orders).toHaveLength(1); expect(intent.strategy.orders[0].status.status).toBe('Filled');
    const filled = await advance({ ticks: 1 }); expect(filled.state.position.entryPrice).toBe(25021);
    expect(filled.strategy.positions[0].signed_qty).toBe(1); expect(filled.manual.positions[0].signed_qty).toBe(1);
    await expect(button('依對帳單保存費率')).toBeDisabled();
    expect((await request('/api/v1/order/cancel_order', { trade_id: filled.strategy.orders[0].order.id })).status).toBe(400);
    const viewer = (await advance({ viewer: true })).viewerToken;
    expect((await request('/api/v1/automation/heartbeat', { run_id: filled.state.id, entries_allowed: true, execution_allowed: true }, viewer)).status).toBe(400);
    await refreshLedger(); await expect(ledger()).toContainText('PAPER-AUTO-F');
    await shot('paper-auto-filled');
    const beforeRestart = await advance({ price: 24990 });
    const persistedIds = beforeRestart.ledger.orders.map(o => o.order.id);
    console.log('Paper QA: restarting the isolated backend with held positions and a pending manual order.');
    // Release the browser's long-lived SSE request before Uvicorn graceful shutdown.
    await page.evaluate(() => sessionStorage.removeItem('fubon-trading-session'));
    await page.goto('about:blank');
    await stop(backend); await free(apiPort); backend = startBackend(); await ready(`http://127.0.0.1:${apiPort}/api/v1/passkeys/status`);
    await unlock(true);
    await expect(panel()).toBeVisible();
    const restored = await advance({ ticks: 3 });
    expect(restored.counts.boots).toBe(2); expect(restored.ledger.orders.map(o => o.order.id)).toEqual(persistedIds);
    expect(restored.state.monitoring).toBe(false); expect(restored.state.position.entryPrice).toBe(25021);
    expect(restored.manual.positions[0].signed_qty).toBe(1); expect(restored.strategy.positions[0].signed_qty).toBe(1);
    expect(restored.manual.orders.find(o => o.order.id === pending.order.id).status.status).toBe('Submitted');
    expect(restored.ledger.realizedNet).toBe(beforeRestart.ledger.realizedNet);
    await expect(panel().getByText(/尚未接管退出監控/)).toBeVisible(); await shot('paper-restarted-unarmed');
    scenarios.push({ name: 'actual-backend-restart-persists-and-does-not-arm', beforePid: children[0].pid, afterPid: backend.pid, orderCount: persistedIds.length, monitoring: restored.state.monitoring });
    await button('重新對帳與接管監控').click();
    await page.getByRole('button', { name: '風控', exact: true }).click(); await expect.poll(async () => (await advance()).state.executionBlocked).toBe(true);
    await button('停止並退出').click(); const blocked = await advance({ ticks: 2 }); expect(blocked.strategy.orders).toHaveLength(1); expect(blocked.state.position.quantity).toBe(1);
    await shot('paper-kill-blocks-exit');
    await page.getByRole('button', { name: '風控鎖定', exact: true }).click(); await expect.poll(async () => (await advance()).state.executionBlocked).toBe(false);
    const exited = await advance({ ticks: 3 }); expect(exited.state.position).toBeNull(); expect(exited.strategy.orders).toHaveLength(2);
    expect(exited.strategy.realizedNet).toBe(-354); expect(exited.state.realizedNet).toBe(exited.strategy.realizedNet);
    expect(exited.manual.positions[0].signed_qty).toBe(1);
    if (exited.state.status === 'attention') await button('停止並退出').click();
    expect((await advance()).state.status).toBe('stopped');
    scenarios.push({ name: 'real-paper-gateway-stoploss-account-isolation-kill', strategyNet: exited.strategy.realizedNet, manualQuantity: exited.manual.positions[0].signed_qty });
    await advance({ at: '2026-11-16T09:19:00+08:00', price: 25020, spread: 0, bookTick: true });
    await place({ action: 'Sell', octype: 'Cover' }, manual, { ...cost, fee_per_side: 16 });
    const nextDay = await advance(); expect(nextDay.manual.realizedNet).toBe(258); expect(nextDay.daily.realizedNet).toBe(79);
    expect(nextDay.manual.orders.find(o => o.order.id === pending.order.id).status.status).toBe('Cancelled');
    expect(nextDay.manual.orders.find(o => o.order.id === modified.order.id).paper.cost.fee_per_side).toBe(12);
    const margin = await request('/api/v1/portfolio/margin', manual); expect(margin.status).toBe(200);
    expect(margin.data.today_balance).toBe(1000258); expect(margin.data.yesterday_balance).toBe(1000179);
    expect(margin.data.future_settle_profitloss).toBe(79); expect(margin.data.fee).toBe(16); expect(margin.data.tax).toBe(5);
    await advance({ bookTick: true }); expect((await advance()).manual.realizedNet).toBe(258);
    scenarios.push({ name: 'date-rollover-expiry-frozen-fees-daily-vs-lifetime', manualLifetime: 258, manualDaily: 79, margin: margin.data });
    // A new paper plan may leave a held position across dates; only the explicit
    // recovery button can flatten it using the original contract and a fresh quote.
    await page.reload(); await expect(panel()).toBeVisible();
    await panel().getByLabel('實際開盤日期（夜盤為15:00所在日）', { exact: true }).fill('2026-11-16');
    await advance({ price: 25020, spread: 1 }); await button('啟動／恢復 paper 策略').click();
    await expect(panel().getByText('策略執行中', { exact: true })).toBeVisible();
    const nextEntry = await advance({ at: '2026-11-16T09:20:01+08:00', ticks: 2 }); expect(nextEntry.state.position.entryPrice).toBe(25021);
    const carried = await advance({ at: '2026-11-17T09:20:01+08:00', price: 25090, ticks: 3 });
    expect(carried.state.status).toBe('attention'); expect(carried.state.monitoring).toBe(false); expect(carried.state.position.quantity).toBe(1);
    expect(carried.strategy.orders.length).toBe(nextEntry.strategy.orders.length);
    await page.reload(); await expect(panel()).toBeVisible();
    await expect(button('確認退出保存的 paper 策略部位')).toBeVisible();
    expect((await request('/api/v1/automation/control', { run_id: carried.state.id, command: 'archive', acknowledgement: '已確認測試委託與部位', execution_allowed: true })).status).toBe(400);
    await page.getByRole('button', { name: '風控', exact: true }).click(); await expect(button('確認退出保存的 paper 策略部位')).toBeDisabled();
    await page.getByRole('button', { name: '風控鎖定', exact: true }).click(); await expect(button('確認退出保存的 paper 策略部位')).toBeEnabled();
    await button('確認退出保存的 paper 策略部位').click();
    await expect.poll(async () => (await advance()).state.status).toBe('stopped');
    const recovered = await advance({ ticks: 3 }); expect(recovered.state.position).toBeNull(); expect(recovered.state.monitoring).toBe(false);
    expect(recovered.state.realizedNet).toBe(646); expect(recovered.strategy.positions).toEqual([]);
    const recoveryOrder = recovered.strategy.orders.at(-1);
    expect(recoveryOrder.paper.strategyDay).toBe('2026-11-16'); expect(recoveryOrder.paper.filledDay).toBe('2026-11-17');
    expect(recoveryOrder.contract.code).toBe('TMFK6');
    scenarios.push({ name: 'explicit-cross-date-paper-recovery-no-new-entry', net: 646, strategyDay: recoveryOrder.paper.strategyDay, filledDay: recoveryOrder.paper.filledDay });
    await page.reload(); await expect(panel()).toBeVisible(); await refreshLedger();
    await ledger().getByText('已保存的委託與持倉（委託顯示最近20筆）', { exact: true }).click();
    await expect(ledger()).toContainText('16'); await expect(ledger()).toContainText('12');
    // Explicit error/loading display with isolated read interception only.
    await page.route('**/api/v1/paper/state', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ detail: 'QA 暫時無法讀取模擬帳簿' }) }));
    await refreshLedger(); await expect(ledger().getByRole('alert')).toContainText('503 Service Unavailable');
    await expect(ledger().getByRole('alert')).toContainText('目前畫面可能是舊資料'); await shot('paper-ledger-error', ledger());
    await page.unroute('**/api/v1/paper/state'); await refreshLedger(); await expect(ledger().getByRole('alert')).toHaveCount(0);
    const geometry = [];
    for (const label of ['深色', '淺色']) {
        await theme(label);
        for (const width of [1440, 390]) {
            await page.setViewportSize({ width, height: 1050 });
            await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
            expect(await panel().evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
            for (const control of await panel().locator('form input,form button[role="combobox"]').all()) {
                const h = await control.evaluate(el => el.getBoundingClientRect().height); expect(h).toBeGreaterThanOrEqual(24); expect(h).toBeLessThanOrEqual(32); geometry.push({ width, h });
            }
            await ledger().locator('details').evaluate(el => { el.open = false; });
            await align(ledger()); await shot(`paper-${label === '深色' ? 'dark' : 'light'}-${width}-ledger`, ledger());
            await align(panel().locator('form')); await shot(`paper-${label === '深色' ? 'dark' : 'light'}-${width}-controls`);
            for (const name of ['啟動／恢復 paper 策略', '停止新倉', '停止並退出', '重新對帳與接管監控']) {
                const action = button(name); await action.scrollIntoViewIfNeeded();
                expect(await action.evaluate(el => { const p = el.closest('[aria-label="Paper 自動交易"]').getBoundingClientRect(), r = el.getBoundingClientRect();
                    return r.left >= p.left && r.right <= p.right && r.height >= 24 && r.height <= 32; })).toBe(true);
            }
            if (width === 390) await shot(`paper-${label === '深色' ? 'dark' : 'light'}-${width}-actions`);
        }
    }
    const touch = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, storageState: await context.storageState() });
    const token = await page.evaluate(() => sessionStorage.getItem('fubon-trading-session'));
    await touch.addInitScript(token => sessionStorage.setItem('fubon-trading-session', token), token);
    try {
        const tp = await touch.newPage(); await tp.goto(origin); const p = tp.getByRole('region', { name: 'Paper 自動交易', exact: true }); await expect(p).toBeVisible();
        expect(await tp.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true);
        for (const control of await p.locator('input,button').all()) expect(await control.evaluate(el => el.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
        await p.locator('form').evaluate(el => { const scroll = el.closest('[aria-label="Paper 自動交易"]'); scroll.scrollTop += el.getBoundingClientRect().top - scroll.getBoundingClientRect().top; });
        const filename = path.join(artifacts, 'paper-touch-390-controls.png'); await p.screenshot({ animations: 'disabled', path: filename }); screenshots.push(filename);
        await p.getByRole('button', { name: '啟動／恢復 paper 策略', exact: true }).scrollIntoViewIfNeeded();
        const actionShot = path.join(artifacts, 'paper-touch-390-actions.png'); await p.screenshot({ animations: 'disabled', path: actionShot }); screenshots.push(actionShot);
    } finally { await touch.close(); }
    const counts = JSON.parse(await readFile(countFile, 'utf8'));
    expect(counts.sdkCalls).toBe(0); expect(counts.sdkTransactions).toBe(0); expect(counts.keychainCalls).toBe(0); expect(pageErrors).toEqual([]);
    const nativeUserControls = await page.locator('select:not([aria-hidden="true"])').count(); expect(nativeUserControls).toBe(0);
    const final = await advance();
    const summary = { passed: true, fixture: 'real PaperGateway + PaperBook/PaperStore; synthetic market reads; temporary Passkey/SQLite', scenarios, counts, nativeUserControls, pageErrors, orderRequests, screenshots, desktopGeometry: geometry, finalLedger: final.ledger, artifacts };
    await writeFile(path.join(artifacts, 'summary.json'), JSON.stringify(summary, null, 2));
    await rm(path.join(artifacts, 'failure.log'), { force: true }); await rm(path.join(artifacts, 'failure.png'), { force: true });
    console.log(JSON.stringify({ passed: true, scenarios, counts, nativeUserControls, pageErrors, artifacts }, null, 2));
} catch (error) {
    await page?.screenshot({ path: path.join(artifacts, 'failure.png'), fullPage: true }).catch(() => undefined);
    await writeFile(path.join(artifacts, 'failure.log'), `${error.stack || error}\n\n${logs}`);
    console.error(`${error.stack || error}\nArtifacts: ${artifacts}\n${logs.slice(-5000)}`); process.exitCode = 1;
} finally { await cleanup(); }
