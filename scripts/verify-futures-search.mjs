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
const launch = randomBytes(32).toString('base64url'), children = [], results = [], pageErrors = [], blocked = [], mutations = [], marketRequests = [];
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
const server=await createServer({...loaded.config,configFile:false,root:${JSON.stringify(root)},envDir:process.cwd(),cacheDir:${JSON.stringify(path.join(temporary, 'vite-cache'))},server:{...loaded.config.server,host:'127.0.0.1',port:${uiPort},strictPort:true,fs:{...loaded.config.server.fs,allow:[...loaded.config.server.fs.allow,${JSON.stringify(root)},${JSON.stringify(await realpath(path.join(root, 'node_modules')))}]}}});await server.listen();`);
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
        expect(rows.length).toBeLessThanOrEqual(10);
        if (scenario.broad) { expect(rows.some(row => /^\d{4}/.test(row))).toBe(true); expect(rows.some(row => row.includes('聯'))).toBe(true); }
        if (scenario.query === '2454' || scenario.query === '2330') { expect(rows.some(row => row.includes('202611'))).toBe(true); expect(rows.some(row => row.includes('202612'))).toBe(true); }
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
    const final = await qa(); expect(final.ledger.orders).toEqual([]); expect(final.ledger.positions).toEqual([]);
    for (const key of ['sdkCalls', 'sdkTransactions', 'keychainCalls', 'outboundCalls']) expect(final.counts[key], key).toBe(0);
    expect(final.counts.products).toBeGreaterThan(0); expect(final.counts.tickers).toBeGreaterThan(0);
    expect(mutations).toEqual([]); expect(pageErrors).toEqual([]); expect(blocked.filter(url => url !== 'https://fonts.googleapis.com/css2')).toEqual([]);
    await writeFile(path.join(artifacts, 'summary.json'), JSON.stringify({ passed: true, results, final, selectedList, pageErrors, mutations, blocked, marketRequests, temporary, marketFixture }, null, 2));
    console.log(JSON.stringify({ passed: true, checks: results.length, counts: final.counts, artifacts, temporary }, null, 2));
} catch (error) {
    await writeFile(path.join(artifacts, 'failure.log'), childLogs);
    await writeFile(path.join(artifacts, 'summary.json'), JSON.stringify({ passed: false, error: String(error), results, pageErrors, mutations, blocked, marketRequests, temporary }, null, 2));
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
