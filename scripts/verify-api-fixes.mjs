// Isolated browser acceptance: real frontend modules, local HTTP/SSE, and PaperBook.
// Only the public stock frame is captured data. All accounts/quotes/stores are QA fixtures.
// No vendor SDK, Keychain, repo .env, or existing dev service may be accessed.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';

const root = fileURLToPath(new URL('../', import.meta.url));
const uiPort = Number(process.env.API_FIXES_UI_PORT || 6192);
const apiPort = Number(process.env.API_FIXES_API_PORT || 22992);
const origin = `http://localhost:${uiPort}`;
const temporary = await mkdtemp(path.join(tmpdir(), 'fubon-api-fixes-'));
const artifacts = process.env.API_FIXES_ARTIFACT_DIR || path.join(temporary, 'artifacts');
const launch = randomBytes(32).toString('base64url');
const children = [], scenarios = [], pageErrors = [], blockedRequests = [], metadataFixtures = [], watchlistRequests = [];
const requestEvidence = new Map();
let browser, context, page, logs = '', closing;
await mkdir(artifacts, { recursive: true });

function run(command, args, extra = {}, cwd = temporary) {
    // Do not pass credentials, provider keys, or Vite variables from the host.
    const env = Object.fromEntries(['PATH', 'TMPDIR', 'TMP', 'TEMP', 'LANG'].filter(key => process.env[key]).map(key => [key, process.env[key]]));
    const child = spawn(command, args, { cwd, detached: process.platform !== 'win32', env: { ...env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
    for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { logs = (logs + data).slice(-40000); });
    child.on('error', error => { logs += error.message; });
    children.push(child);
    return child;
}
async function free(port) {
    if (!Number.isInteger(port) || port < 1024 || port > 65535 || [5179, 21323, 5784, 22584].includes(port)) throw new Error('Unsafe QA port.');
    await new Promise((resolve, reject) => { const probe = net.createServer(); probe.once('error', reject); probe.listen(port, '127.0.0.1', () => probe.close(resolve)); });
}
async function ready(url) {
    await expect.poll(async () => {
        if (children.some(child => child.exitCode !== null || child.signalCode)) throw new Error('An isolated QA service exited.');
        try { return (await fetch(url, { signal: AbortSignal.timeout(500) })).status; } catch { return 0; }
    }, { timeout: 30000 }).toBe(200);
}
async function stop(child) {
    if (!child || child.exitCode !== null || child.signalCode) return;
    const ended = new Promise(resolve => child.once('exit', resolve));
    try { process.kill(process.platform === 'win32' ? child.pid : -child.pid, 'SIGTERM'); } catch { return; }
    let timeout;
    try { await Promise.race([ended, new Promise(resolve => { timeout = setTimeout(resolve, 8000); })]); }
    finally { clearTimeout(timeout); }
    if (child.exitCode === null && !child.signalCode) {
        try { process.kill(process.platform === 'win32' ? child.pid : -child.pid, 'SIGKILL'); } catch { /* already stopped */ }
        await ended;
    }
}
async function cleanup() {
    return closing ??= (async () => { await browser?.close().catch(() => undefined); for (const child of [...children].reverse()) await stop(child); })();
}
for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]]) process.once(signal, () => { void cleanup().finally(() => process.exit(code)); });
async function request(endpoint, body) {
    return page.evaluate(async ({ endpoint, body }) => {
        const response = await fetch(endpoint, { method: body === undefined ? 'GET' : 'POST',
            ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
        return { status: response.status, data: await response.json() };
    }, { endpoint, body });
}
async function qa(body = {}) { const response = await request('/api/v1/qa/api-fixes', body); expect(response.status, JSON.stringify(response)).toBe(200); return response.data; }
async function switchMode(label, mode) {
    const before = await request('/api/v1/settings/mode');
    const oldToken = await page.evaluate(() => sessionStorage.getItem('fubon-trading-session'));
    await page.getByRole('button', { name: '交易模式設定', exact: true }).click();
    const dialog = page.locator('[role="dialog"]').filter({ hasText: '選擇行情來源與委託執行環境。' });
    await dialog.getByRole('combobox').click(); await page.getByRole('option', { name: label, exact: true }).click();
    await dialog.getByRole('button', { name: '套用並重新連線', exact: true }).click();
    await expect(page.getByRole('button', { name: '使用 Passkey 解鎖', exact: true })).toBeVisible({ timeout: 35000 });
    expect((await context.request.get(origin + '/api/v1/info', { headers: { Authorization: `Bearer ${oldToken}` } })).status()).toBe(401);
    await page.getByRole('button', { name: '使用 Passkey 解鎖', exact: true }).click();
    await expect(page.getByRole('button', { name: '交易模式設定', exact: true })).toBeVisible({ timeout: 30000 });
    const after = await request('/api/v1/settings/mode');
    expect(after.data.mode).toBe(mode); expect(after.data.instance_id).not.toBe(before.data.instance_id);
}

try {
    await free(uiPort); await free(apiPort);
    const stockFixture = path.join(root, 'server/tests/fixtures/stock-trades-2026-11-17.json');
    const stockFrame = JSON.parse(await readFile(stockFixture, 'utf8'));
    expect(stockFrame.channel).toBe('trades'); expect(stockFrame.data.symbol).toBe('2330');
    expect(stockFrame.data.trades).toBeUndefined(); expect(stockFrame.data.price).toBeGreaterThan(0);
    await writeFile(path.join(temporary, 'counts.json'), JSON.stringify({ boots: 0, sdkCalls: 0, sdkTransactions: 0, keychainCalls: 0, outboundCalls: 0, injectedFrames: 0 }));
    const backendFile = path.join(temporary, 'backend.py');
    await writeFile(backendFile, `import json,os,socket,sys,threading
from pathlib import Path
from copy import deepcopy
from datetime import timedelta
from types import ModuleType
import fubon_bridge.__main__ as entry
from fubon_bridge.app import create_app as real_create_app
from fubon_bridge.config import Config
from fubon_bridge.keychain import Keychain
from fubon_bridge.passkeys import PasskeyStore
from fubon_bridge.research import ResearchStore
from fubon_bridge.mapping import stamp

root=Path(os.environ['API_FIXES_TEMP']); (root/'server').mkdir()
counts_file=root/'counts.json'; count_lock=threading.Lock()
stock_frame=json.loads(Path(os.environ['API_FIXES_FRAME']).read_text())
paper_time=stamp(stock_frame['data']['time'])
assert paper_time.hour < 13 or paper_time.hour==13 and paper_time.minute < 30
def count(key):
    with count_lock:
        counts=json.loads(counts_file.read_text()); counts[key]+=1; counts_file.write_text(json.dumps(counts))
def no_sdk(*args,**kwargs):
    count('sdkCalls'); raise AssertionError('QA forbids vendor SDK construction')
def no_keychain(*args,**kwargs):
    count('keychainCalls'); raise AssertionError('QA forbids host Keychain')
def no_outbound(*args,**kwargs):
    count('outboundCalls'); raise AssertionError('QA forbids outbound sockets')
Keychain.read=no_keychain
socket.socket.connect=no_outbound; socket.socket.connect_ex=no_outbound
sdk_module=ModuleType('fubon_neo.sdk'); sdk_module.FubonSDK=no_sdk
sys.modules['fubon_neo.sdk']=sdk_module
class LocalSDK:
    def shutdown(self): pass
    def __getattr__(self,key):
        count('sdkTransactions'); raise AssertionError('QA forbids SDK access '+key)
class NoCredentials:
    def available(self): return False
entry.ROOT=root
Config.from_env=classmethod(lambda cls:Config(mode='paper',port=int(os.environ['API_FIXES_API_PORT'])))
research=ResearchStore(root/'research.sqlite3')
def create_app(config,**kwargs):
    count('boots')
    if json.loads(counts_file.read_text())['boots']==1: kwargs['launch_token']=os.environ['API_FIXES_LAUNCH']
    app=real_create_app(config,sdk_factory=no_sdk,passkey_store=PasskeyStore(root/'passkeys.sqlite3'),research_store=research,credential_store=NoCredentials(),**kwargs)
    broker=app.state.broker
    broker.paper.clock=lambda:paper_time
    broker._demo_catalog()
    broker.future_product_catalog={c['root']:dict(symbol=c['root'],name='QA synthetic product '+c['root'],contractSize=c.get('multiplier',1),underlyingSymbol='',tradingCurrency='TWD') for c in broker.catalog.values() if c['security_type']=='FUT'}
    broker.catalog['1802']=dict(broker.catalog['2881'],code='1802',root='1802',reference=55,limit_up=60.5,limit_down=49.5)
    for c in broker.catalog.values():
        c['name']='QA fixture '+c['code']
        if c['security_type']=='FUT': c['delivery_date']=(paper_time.date()+timedelta(days=30)).isoformat()
    assert 'TMFK6' in broker.catalog
    broker.catalog['2330'].update(reference=stock_frame['data']['price'],limit_up=3000,limit_down=1000)
    def contract(key,**kwargs):
        c=broker.catalog.get(key['code'])
        if c is None or key.get('security_type') not in {None,c['security_type']}: raise ValueError('Unknown QA contract')
        return deepcopy(c)
    broker.contract=contract
    broker.contracts=lambda kind:[deepcopy(c) for c in broker.catalog.values() if c['security_type']==kind and not c.get('target_code')]
    def quote(c):
        price=25000 if c['security_type']=='FUT' else stock_frame['data']['price']+5 if c['code']=='2330' else c['reference']
        base=dict(code=c['code'],exchange=c['exchange'],datetime=paper_time.isoformat(),is_trial=False,reference=c['reference'],open=price,high=price+10,low=price-10,close=price,average_price=price,buy_price=price-1,sell_price=price+1,buy_volume=10,sell_volume=10,volume=1,total_volume=1000,amount=0,total_amount=0,change_price=0,change_rate=0,change_type='',tick_type='0',volume_ratio=0,yesterday_volume=0)
        return dict(base,**broker.quotes.get(c['code'],{}))
    broker.quote=quote
    def subscribe(key,kind):
        c=contract(key); broker.subscriptions[(c['code'],kind)]=dict(contract=c,kind='stock' if c['security_type']=='STK' else 'futopt',channel='trades' if kind=='Tick' else 'books')
    broker.subscribe=subscribe; broker.unsubscribe=lambda *args:None
    def connect():
        broker.sdk=LocalSDK(); broker.error=None; broker.connected_sockets.update({'stock','futopt'})
    broker.connect=connect
    broker.kbars=lambda *args,**kwargs:dict(datetime=[],Open=[],High=[],Low=[],Close=[],Volume=[])
    broker.ticks=lambda *args,**kwargs:dict(ts=[],close=[],volume=[],bid_price=[],ask_price=[])
    broker.demo_events=lambda:None
    @app.post('/api/v1/qa/api-fixes')
    def qa(body:dict):
        direct=None
        if body.get('frame'):
            if body['frame']=='futures':
                frame=dict(event='data',channel='trades',data=dict(symbol='TMFK6',time=stock_frame['data']['time'],trades=[dict(price=25000,size=2,bid=24999,ask=25000)],total=dict(tradeVolume=88)))
            else:
                frame=deepcopy(stock_frame)
                if body['frame']=='trial': frame['data']['isTrial']=True
            count('injectedFrames'); broker._on_market('futopt' if body['frame']=='futures' else 'stock',json.dumps(frame))
        if body.get('directStockMkp'):
            try:
                broker.place(dict(code='2330',security_type='STK'),dict(action='Buy',price=0,quantity=1,price_type='MKP',order_type='IOC',order_lot='Common',order_cond='Cash',octype='Auto'),broker.account(dict(account_type='S',broker_id='LOCAL',account_id='PAPER-S')))
                direct=dict(rejected=False)
            except ValueError as error: direct=dict(rejected=True,message=str(error))
        return dict(counts=json.loads(counts_file.read_text()),ledger=broker.paper.overview(),quotes=deepcopy(broker.quotes),direct=direct,instance_id=broker.instance_id,mode=broker.config.mode)
    app.router.routes.insert(0,app.router.routes.pop())
    return app
entry.create_app=create_app
sys.argv=['fixture','--ui-url',os.environ['API_FIXES_ORIGIN'],'--no-browser']
entry.main()
`);
    // The actual Vite config calls loadEnv(process.cwd()). Keep that cwd and
    // Vite's own envDir temporary, so neither loader can read repository .env.
    const viteFile = path.join(temporary, 'vite.mjs');
    await writeFile(viteFile, `import { createServer, loadConfigFromFile } from ${JSON.stringify(path.join(root, 'node_modules/vite/dist/node/index.js'))};
globalThis.fetch = async () => { throw new Error('QA forbids metadata upstream access'); };
const loaded = await loadConfigFromFile({command:'serve',mode:'development'}, ${JSON.stringify(path.join(root, 'vite.config.ts'))}, process.cwd());
const server = await createServer({...loaded.config,configFile:false,root:${JSON.stringify(root)},envDir:process.cwd(),cacheDir:${JSON.stringify(path.join(temporary, 'vite-cache'))},server:{...loaded.config.server,host:'127.0.0.1',port:${uiPort},strictPort:true,fs:{...loaded.config.server.fs,allow:[...loaded.config.server.fs.allow,${JSON.stringify(root)},${JSON.stringify(await realpath(path.join(root, 'node_modules')))}]}}});
await server.listen();
`);
    run(process.env.API_FIXES_PYTHON || path.join(root, 'server/.venv/bin/python'), [backendFile], {
        PYTHONPATH: path.join(root, 'server'), API_FIXES_TEMP: temporary, API_FIXES_FRAME: stockFixture,
        API_FIXES_API_PORT: String(apiPort), API_FIXES_LAUNCH: launch, API_FIXES_ORIGIN: origin,
    });
    run(process.execPath, [viteFile], { VITE_API_TARGET: `http://127.0.0.1:${apiPort}`, VITE_API_BASE: '', VITE_STREAM_BASE: origin, VITE_DEV_SERVER_PORT: '' });
    await ready(`http://127.0.0.1:${apiPort}/api/v1/passkeys/status`); await ready(origin);
    browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true });
    context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await context.route('**/*', route => {
        const url = new URL(route.request().url());
        if (url.origin === origin && url.pathname.startsWith('/metadata/')) {
            metadataFixtures.push(url.pathname);
            return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
        }
        if (url.origin === origin) return route.continue();
        blockedRequests.push(url.origin + url.pathname);
        return route.abort('blockedbyclient');
    });
    page = await context.newPage();
    page.on('pageerror', error => pageErrors.push(error.message));
    page.on('request', req => {
        if (!new URL(req.url()).pathname.startsWith('/api/v1/watchlist')) return;
        const evidence = { method: req.method(), path: new URL(req.url()).pathname, headers: { 'content-type': req.headers()['content-type'] }, body: req.postData(), status: null };
        watchlistRequests.push(evidence); requestEvidence.set(req, evidence);
    });
    page.on('response', response => { const evidence = requestEvidence.get(response.request()); if (evidence) evidence.status = response.status(); });
    const cdp = await context.newCDPSession(page); await cdp.send('WebAuthn.enable');
    await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
    await page.goto(origin + '/#fubon-launch=' + launch);
    await page.getByRole('button', { name: '建立 Passkey 並解鎖', exact: true }).click();
    await expect(page.getByRole('button', { name: '交易模式設定', exact: true })).toBeVisible({ timeout: 30000 });
    await switchMode('展示模式', 'demo'); await switchMode('Paper 模擬交易', 'paper');
    scenarios.push('real CLI restarts paper/demo/paper; temporary Passkey re-unlocks each new instance and old sessions return 401');
    await page.evaluate(async () => {
        const shioaji = await import('/src/lib/shioaji.ts');
        const api = await import('/src/lib/api.ts');
        const session = await import('/src/lib/fubon-session.ts');
        const stream = await import('/src/lib/stream.ts');
        window.qa = { shioaji, api, stream, events: [], opened: false };
        const source = session.openFubonEventSource(location.origin + '/api/v1/stream/data');
        source.onopen = () => { window.qa.opened = true; };
        for (const event of ['tick_stk','tick_fop','fubon_reconcile_required']) source.addEventListener(event, message => window.qa.events.push({ event, data: JSON.parse(message.data) }));
        window.qa.source = source;
        stream.ensureStream();
    });
    await expect.poll(() => page.evaluate(() => window.qa.opened)).toBe(true);
    scenarios.push('real CLI, temporary Passkey registration and authenticated browser HTTP/SSE; no host credentials or .env');

    // Exercise the rendered Watchlist and useWatchlist hook, including the
    // per-member routes that a direct create/rename test does not call.
    await page.getByTitle('建立新清單', { exact: true }).click();
    await page.getByPlaceholder('新清單名稱', { exact: true }).fill('QA UI membership');
    await page.getByPlaceholder('新清單名稱', { exact: true }).press('Enter');
    await expect(page.getByRole('combobox', { name: '自選清單', exact: true })).toContainText('QA UI membership');
    const symbolInput = page.getByPlaceholder('股票、期貨或指數（如 台積電期）', { exact: true });
    await expect(symbolInput).toBeEnabled(); await symbolInput.fill('1802');
    const suggestion = page.getByRole('option', { name: /1802/ });
    await expect(suggestion).toBeVisible({ timeout: 15000 }); await suggestion.click();
    const stockRow = page.locator('[data-code="1802"]');
    await expect(stockRow).toBeVisible(); await expect(symbolInput).toHaveValue('');
    const uiAdded = await page.evaluate(async () => (await window.qa.shioaji.fetchWatchlists()).find(list => list.name === 'QA UI membership'));
    expect(uiAdded.contracts).toMatchObject([{ code: '1802', security_type: 'STK', exchange: 'TSE' }]);
    await page.getByRole('button', { name: '重新讀取清單', exact: true }).click();
    await expect(page.getByRole('button', { name: '重新讀取清單', exact: true })).toHaveAttribute('aria-busy', 'false');
    await expect(stockRow).toBeVisible();
    await page.screenshot({ path: path.join(artifacts, 'watchlist-1802-added.png'), fullPage: true, animations: 'disabled' });
    await stockRow.hover(); await stockRow.getByTitle('從清單移除', { exact: true }).click();
    await expect(stockRow).toHaveCount(0);
    // Read by the immutable server ID instead of relying on optimistic hook state.
    const uiAfterRemove = await page.evaluate(async id => (await window.qa.shioaji.fetchWatchlists()).find(list => list.id === id), uiAdded.id);
    expect(uiAfterRemove.contracts).toEqual([]);
    await page.getByRole('button', { name: '重新讀取清單', exact: true }).click();
    await expect(page.getByRole('button', { name: '重新讀取清單', exact: true })).toHaveAttribute('aria-busy', 'false');
    await expect(stockRow).toHaveCount(0);
    await page.getByTitle('重新命名清單', { exact: true }).click();
    await page.getByPlaceholder('清單名稱', { exact: true }).fill('QA UI renamed');
    await page.getByPlaceholder('清單名稱', { exact: true }).press('Enter');
    await expect(page.getByRole('combobox', { name: '自選清單', exact: true })).toContainText('QA UI renamed');
    const uiRenamedLists = await page.evaluate(() => window.qa.shioaji.fetchWatchlists());
    const uiRenamed = uiRenamedLists.find(list => list.name === 'QA UI renamed');
    expect(uiRenamed).toBeTruthy(); expect(uiRenamedLists.some(list => list.id === uiAdded.id)).toBe(false);
    await page.getByTitle('刪除目前清單', { exact: true }).click();
    await page.getByTitle('再按一次確認刪除整個清單', { exact: true }).click();
    await expect(page.getByRole('combobox', { name: '自選清單', exact: true })).not.toContainText('QA UI renamed');
    const uiAfterDelete = await page.evaluate(() => window.qa.shioaji.fetchWatchlists());
    expect(uiAfterDelete.some(list => list.id === uiRenamed.id)).toBe(false);
    const membershipRequests = watchlistRequests.filter(req => req.path.endsWith('/contracts'));
    expect(membershipRequests.map(req => [req.method, req.status])).toEqual([['POST', 200], ['DELETE', 200]]);
    scenarios.push('rendered useWatchlist UI adds fixture 1802 via member POST, reload retains it, row removal DELETE persists and reload stays empty; UI rename/delete succeeds');

    const lists = await page.evaluate(async () => {
        const { createWatchlist, renameWatchlist, deleteWatchlist, fetchWatchlists } = window.qa.shioaji;
        const contracts = [{ code: '2330', security_type: 'STK', exchange: 'TSE', region: 'TW' }, { code: 'TMFK6', security_type: 'FUT', exchange: 'TAIFEX', region: 'TW' }];
        const original = await createWatchlist('QA original', contracts);
        const renamed = await renameWatchlist(original, 'QA renamed');
        const afterRename = await fetchWatchlists();
        await deleteWatchlist(renamed.id);
        return { original, renamed, afterRename, afterDelete: await fetchWatchlists() };
    });
    expect(lists.renamed.name).toBe('QA renamed'); expect(lists.renamed.id).not.toBe(lists.original.id);
    expect(lists.renamed.contracts).toEqual(lists.original.contracts);
    expect(lists.afterRename.filter(list => list.name.startsWith('QA '))).toEqual([lists.renamed]);
    expect(lists.afterRename.some(list => list.id === lists.original.id)).toBe(false);
    expect(lists.afterDelete.some(list => list.id === lists.renamed.id)).toBe(false);
    const deletes = watchlistRequests.filter(req => req.method === 'DELETE' && [lists.original.id, lists.renamed.id].some(id => req.path.endsWith('/' + id)));
    expect(deletes).toHaveLength(2);
    for (const deletion of deletes) { expect(deletion.headers['content-type']).toBe('application/json'); expect(deletion.body).toBeNull(); expect(deletion.status).toBe(200); }
    expect(watchlistRequests.some(req => req.status === 415)).toBe(false);
    scenarios.push('actual shioaji.ts create/rename/delete through api.ts; bodyless DELETE carries JSON type; renamed contracts preserved and old list removed without 415');

    const stockAccount = { account_type: 'S', broker_id: 'LOCAL', account_id: 'PAPER-S' };
    const futureAccount = { account_type: 'F', broker_id: 'LOCAL', account_id: 'PAPER-F' };
    const baseOrder = { action: 'Buy', price: 0, quantity: 1, price_type: 'MKP', order_type: 'IOC', octype: 'Auto', order_lot: 'Common', order_cond: 'Cash', daytrade_short: false };
    const stockKey = { code: '2330', security_type: 'STK', exchange: 'TSE' };
    const futureKey = { code: 'TMFK6', security_type: 'FUT', exchange: 'TAIFEX' };
    await page.evaluate(async ({ stockKey, futureKey }) => {
        await window.qa.api.apiPost('/api/v1/stream/subscribe', { contract: stockKey, quote_type: 'Tick' });
        await window.qa.api.apiPost('/api/v1/stream/subscribe', { contract: futureKey, quote_type: 'Tick' });
    }, { stockKey, futureKey });
    const beforeRejected = (await qa()).ledger;
    const rejected = await request('/api/v1/order/place_order', { contract: stockKey, stock_order: { ...baseOrder, account: stockAccount } });
    expect(rejected.status).toBe(422); expect(JSON.stringify(rejected.data)).toContain('MKP');
    const direct = await qa({ directStockMkp: true }); expect(direct.direct.rejected).toBe(true); expect(direct.ledger).toEqual(beforeRejected);
    scenarios.push('stock MKP rejected by HTTP validation (422) and direct Broker.place; temporary book unchanged');

    const pending = await request('/api/v1/order/place_order', { contract: stockKey, stock_order: { ...baseOrder, price: stockFrame.data.ask, price_type: 'LMT', order_type: 'ROD', account: stockAccount } });
    expect(pending.status).toBe(200); expect(pending.data.status.status).toBe('Submitted');
    let state = await qa({ frame: 'trial' });
    expect(state.ledger.orders.find(trade => trade.order.id === pending.data.order.id).status.status).toBe('Submitted');
    expect(state.ledger.positions).toEqual([]);
    await expect.poll(() => page.evaluate(() => window.qa.events.filter(item => item.event === 'tick_stk' && item.data.simtrade).length)).toBe(1);
    state = await qa({ frame: 'stock' });
    const filled = state.ledger.orders.find(trade => trade.order.id === pending.data.order.id);
    expect(filled.status.status).toBe('Filled'); expect(filled.status.deal_quantity).toBe(1);
    expect(filled.status.deals[0].price).toBe(stockFrame.data.ask);
    expect(state.ledger.positions).toMatchObject([{ account_id: 'PAPER-S', code: '2330', signed_qty: 1000 }]);
    expect(state.quotes['2330']).toMatchObject({ close: stockFrame.data.price, buy_price: stockFrame.data.bid, sell_price: stockFrame.data.ask, is_trial: false });
    await expect.poll(() => page.evaluate(() => window.qa.events.filter(item => item.event === 'tick_stk' && !item.data.simtrade).length)).toBe(1);
    const stockTick = await page.evaluate(() => window.qa.events.find(item => item.event === 'tick_stk' && !item.data.simtrade).data);
    expect(stockTick).toMatchObject({ code: '2330', close: String(stockFrame.data.price), volume: stockFrame.data.size, total_volume: stockFrame.data.volume, simtrade: false });
    await expect.poll(() => page.evaluate(() => window.qa.stream.getQuote('2330')?.tick?.close)).toBe(String(stockFrame.data.price));
    scenarios.push('captured public flat stock trades frame enters real Broker._on_market, reaches browser tick_stk/store and fills pending Paper LMT; trial frame emits simtrade without filling');

    await qa({ frame: 'futures' });
    await expect.poll(() => page.evaluate(() => window.qa.events.filter(item => item.event === 'tick_fop' && item.data.code === 'TMFK6').length)).toBe(1);
    const futuresTick = await page.evaluate(() => window.qa.events.find(item => item.event === 'tick_fop' && item.data.code === 'TMFK6').data);
    expect(futuresTick).toMatchObject({ close: '25000', volume: 2, total_volume: 88 });
    const futureMkp = await request('/api/v1/order/place_order', { contract: futureKey, futures_order: { ...baseOrder, account: futureAccount } });
    expect(futureMkp.status).toBe(200); expect(futureMkp.data.status.status).toBe('Filled');
    expect(futureMkp.data.order.price_type).toBe('MKP');
    scenarios.push('synthetic futures trades[] remains tick_fop; FUT MKP accepted and filled only in local PaperBook');

    const final = await qa();
    expect(final.counts).toEqual({ boots: 3, sdkCalls: 0, sdkTransactions: 0, keychainCalls: 0, outboundCalls: 0, injectedFrames: 3 });
    expect(final.mode).toBe('paper'); expect(final.ledger.orders).toHaveLength(2);
    expect(pageErrors).toEqual([]);
    // The application requests its optional Google Fonts CSS. The browser
    // route aborts that request locally; it never reaches the network.
    expect(blockedRequests.filter(url => url !== 'https://fonts.googleapis.com/css2')).toEqual([]);
    const events = await page.evaluate(() => window.qa.events);
    expect(events.some(item => item.event === 'fubon_reconcile_required' && item.data.reason === 'market_mapping_error')).toBe(false);
    await page.screenshot({ path: path.join(artifacts, 'paper-browser.png'), fullPage: true, animations: 'disabled' });
    await writeFile(path.join(artifacts, 'summary.json'), JSON.stringify({ passed: true, scenarios, counts: final.counts, pageErrors, blockedRequests, metadataFixtures, watchlistRequests, uiMembership: { added: uiAdded, removed: uiAfterRemove, renamed: uiRenamed, afterDelete: uiAfterDelete }, stockTick, futuresTick, events, ledger: final.ledger, temporary, ports: { uiPort, apiPort }, fixture: stockFixture }, null, 2));
    console.log(JSON.stringify({ passed: true, scenarios, counts: final.counts, artifacts, temporary }, null, 2));
} catch (error) {
    await writeFile(path.join(artifacts, 'failure.log'), logs);
    await writeFile(path.join(artifacts, 'failure.json'), JSON.stringify({ passed: false, error: String(error), scenarios, pageErrors, blockedRequests, watchlistRequests, temporary }, null, 2));
    await page?.screenshot({ path: path.join(artifacts, 'failure.png'), fullPage: true }).catch(() => undefined);
    console.error(JSON.stringify({ passed: false, artifacts, temporary }));
    throw error;
} finally { await cleanup(); }
