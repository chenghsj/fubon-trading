// Real LightGBM acceptance with synthetic market reads, temporary SQLite and
// virtual WebAuthn. Never initializes the brokerage SDK or starts automation.
import { spawn } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';

const root = fileURLToPath(new URL('../', import.meta.url));
const uiPort = Number(process.env.LEARNING_UI_PORT || 6193);
const apiPort = Number(process.env.LEARNING_API_PORT || 22993);
const origin = `http://localhost:${uiPort}`;
const temporary = await mkdtemp(path.join(tmpdir(), 'fubon-learning-qa-'));
const artifacts = process.env.LEARNING_ARTIFACT_DIR || '/private/tmp/fubon-learning-qa-20261115';
await mkdir(artifacts, { recursive: true });
const token = randomBytes(32).toString('base64url');
const children = [], pageErrors = [], transactions = [], automationWrites = [], progress = [];
let browser, page, logs = '', closing;
const wrap = () => page.getByLabel('日內回測研究', { exact: true });
const learning = () => page.getByRole('region', { name: 'LightGBM 模型研究', exact: true });
const result = () => learning().getByRole('region', { name: 'LightGBM 訓練結果', exact: true });

function run(command, args, env = {}) {
    const child = spawn(command, args, { cwd: root, detached: process.platform !== 'win32', env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', data => { logs = (logs + data).slice(-22000); });
    child.stderr.on('data', data => { logs = (logs + data).slice(-22000); });
    child.on('error', error => { logs += error.message; }); children.push(child);
}
async function free(port) {
    await new Promise((resolve, reject) => {
        const probe = net.createServer(); probe.once('error', reject);
        probe.listen(port, '127.0.0.1', () => probe.close(resolve));
    });
}
async function ready(url) {
    for (let i = 0; i < 300; i++) {
        if (children.some(child => child.exitCode !== null && child.exitCode !== 0)) throw new Error('Isolated learning QA server exited.');
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
for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]]) process.once(signal, () => { void cleanup().finally(() => process.exit(code)); });
async function api(endpoint, body) {
    return page.evaluate(async ({ endpoint, body }) => {
        const response = await fetch(endpoint, { method: body === undefined ? 'GET' : 'POST',
            headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        return { status: response.status, data: await response.json() };
    }, { endpoint, body });
}
async function overview() {
    const response = await api('/api/v1/research/learning'); expect(response.status).toBe(200); return response.data;
}
async function stats() {
    const response = await api('/api/v1/qa/learning-stats'); expect(response.status).toBe(200);
    expect(response.data.sdkCalls).toBe(0); expect(response.data.paperOrders).toBe(0); return response.data;
}
async function waitJob(job) {
    let latest;
    await expect.poll(async () => {
        latest = (await overview()).jobs.find(item => item.id === job.id);
        if (latest) progress.push({ action: latest.action, status: latest.status, progress: latest.progress, message: latest.message });
        return latest?.status;
    }, { timeout: 180000, intervals: [200, 500, 1000] }).not.toBe('running');
    expect(latest?.status, JSON.stringify(latest)).toBe('completed'); return latest;
}
async function collect(start, end) {
    await learning().getByLabel('訓練歷史開始日期', { exact: true }).fill(start);
    await learning().getByLabel('訓練歷史結束日期', { exact: true }).fill(end);
    const response = page.waitForResponse(r => r.url().endsWith('/api/v1/research/learning/collect') && r.request().method() === 'POST');
    await learning().getByRole('button', { name: '分批下載歷史資料', exact: true }).click();
    const accepted = await response; expect(accepted.status()).toBe(200);
    return accepted.json();
}
async function train() {
    const response = page.waitForResponse(r => r.url().endsWith('/api/v1/research/learning/train') && r.request().method() === 'POST');
    await learning().getByRole('button', { name: '訓練／重新驗證', exact: true }).click();
    const accepted = await response; expect(accepted.status()).toBe(200); return accepted.json();
}
async function selectVersion(name, ident, hostPage = page, scope = learning()) {
    const trigger = scope.getByRole('combobox', { name, exact: true }); await trigger.click();
    await hostPage.getByRole('option').filter({ hasText: ident.slice(0, 8) }).click();
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
}
async function capture(name, target = learning()) {
    await target.evaluate(el => {
        const parent = el.closest('[aria-label="日內回測研究"]');
        parent.scrollTop += el.getBoundingClientRect().top - parent.getBoundingClientRect().top;
    });
    await wrap().screenshot({ animations: 'disabled', path: path.join(artifacts, `${name}.png`) });
}
async function setTheme(name) {
    await page.getByRole('button', { name: '設定', exact: true }).click();
    const settings = page.getByRole('dialog', { name: '設定', exact: true });
    await settings.getByRole('tab', { name: '外觀', exact: true }).click();
    await settings.getByRole('radio', { name, exact: true }).click(); await page.keyboard.press('Escape');
    await expect(settings).toBeHidden();
}

try {
    await free(uiPort); await free(apiPort);
    const backend = path.join(temporary, 'backend.py');
    await writeFile(backend, `import os,time,threading
from datetime import date,datetime,timedelta
from copy import deepcopy
import uvicorn,lightgbm as lgb,traceback
import fubon_bridge.learning_service as service
from fubon_bridge.app import create_app
from fubon_bridge.broker import Broker
from fubon_bridge.config import Config
from fubon_bridge.mapping import TAIPEI
from fubon_bridge.passkeys import PasskeyStore
from fubon_bridge.research import ResearchStore
counts=dict(sdkCalls=0,lightgbmCalls=0,marketCalls=[])
lock=threading.Lock()
original_train=lgb.train
def counted_train(*args,**kwargs):
    with lock: counts['lightgbmCalls']+=1
    return original_train(*args,**kwargs)
lgb.train=counted_train
def no_sdk():
    with lock: counts['sdkCalls']+=1
    raise AssertionError('Learning QA must never initialize brokerage SDK')
def candles(self,kind,symbol,start,end):
    with lock: counts['marketCalls'].append(dict(kind=kind,symbol=symbol,start=start,end=end))
    time.sleep(.12)
    first,last=date.fromisoformat(start),date.fromisoformat(end)
    rows=[]
    for i in range((last-first).days+1):
        day=first+timedelta(days=i)
        if day.weekday()>=5 or day.isoformat()=='2026-07-14': continue
        stamp=int(datetime.combine(day,datetime.min.time(),TAIPEI).timestamp())+9*3600
        previous=25000
        for minute in range(1,261):
            if kind=='FUT':
                if day.isoformat()=='2026-06-15' and minute==3: continue
                close=25000 if minute<20 else 25020 if day.toordinal()%2 else 25020+2*min(max(0,minute-20),20)
                high,low=max(previous,close)+2,min(previous,close)-2
                if minute<20: high,low=25010,24990
                if day.toordinal()%2 and minute==22: low=24980
                row=dict(time=stamp+minute*60,open=previous,high=high,low=low,close=close,volume=100,contractMonth=day.strftime('%Y%m'))
                previous=close
            else:
                if day.isoformat()=='2026-09-07' and symbol=='2881' and minute==20: continue
                base=600+int(symbol)%100
                close=base+int(minute>=20)
                row=dict(time=stamp+minute*60,open=base,high=close+1,low=base-1,close=close,volume=100)
            row['date']=datetime.fromtimestamp(stamp+(minute-1)*60,TAIPEI).isoformat()
            rows.append(row)
    return rows
Broker.learning_candles=candles
original_collect=service.collect
def traced_collect(*args,**kwargs):
    try: return original_collect(*args,**kwargs)
    except Exception:
        traceback.print_exc()
        raise
service.collect=traced_collect
original_learning_train=service.train
def traced_train(*args,**kwargs):
    try: return original_learning_train(*args,**kwargs)
    except Exception:
        traceback.print_exc()
        raise
service.train=traced_train
app=create_app(Config(mode='demo',port=int(os.environ['LEARNING_UI_PORT'])),sdk_factory=no_sdk,
    launch_token=os.environ['LEARNING_LAUNCH'],public_origin=os.environ['LEARNING_ORIGIN'],
    passkey_store=PasskeyStore(os.environ['LEARNING_PASSKEY_DATABASE']),research_store=ResearchStore(os.environ['LEARNING_DATABASE']))
@app.get('/api/v1/qa/learning-stats')
def qa_stats():
    with lock: result=deepcopy(counts)
    result['paperOrders']=len(app.state.broker.paper.orders)
    result['automation']=app.state.automation.snapshot()
    return result
app.router.routes.insert(0,app.router.routes.pop())
uvicorn.run(app,host='127.0.0.1',port=int(os.environ['LEARNING_API_PORT']),access_log=False)
`);
    run(process.env.LEARNING_PYTHON || path.join(root, 'server', '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'), [backend], {
        PYTHONPATH: path.join(root, 'server'), LEARNING_UI_PORT: String(uiPort), LEARNING_API_PORT: String(apiPort),
        LEARNING_LAUNCH: token, LEARNING_ORIGIN: origin, LEARNING_PASSKEY_DATABASE: path.join(temporary, 'passkeys.sqlite3'), LEARNING_DATABASE: path.join(temporary, 'research.sqlite3'),
    });
    run(process.execPath, [path.join(root, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(uiPort), '--strictPort'], {
        VITE_API_TARGET: `http://127.0.0.1:${apiPort}`, VITE_API_BASE: '', VITE_STREAM_BASE: origin, VITE_DEV_SERVER_PORT: '',
    });
    await ready(`http://127.0.0.1:${apiPort}/api/v1/passkeys/status`); await ready(origin);
    browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true, ignoreDefaultArgs: ['--hide-scrollbars'] });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1050 } });
    page = await context.newPage(); page.on('pageerror', error => pageErrors.push(error.message));
    await page.route('**/api/v1/order/**', async route => {
        const pathname = new URL(route.request().url()).pathname;
        if (route.request().method() !== 'GET' && !/\/(trades|trade_cache_health)$/.test(pathname)) {
            transactions.push(pathname); return route.abort('blockedbyclient');
        }
        return route.continue();
    });
    await page.route('**/api/v1/automation/**', async route => {
        if (route.request().method() !== 'GET') { automationWrites.push(new URL(route.request().url()).pathname); return route.abort('blockedbyclient'); }
        return route.continue();
    });
    const cdp = await context.newCDPSession(page); await cdp.send('WebAuthn.enable');
    await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
    await page.goto(`${origin}/#fubon-launch=${token}`); await page.getByRole('button', { name: '建立 Passkey 並解鎖' }).click();
    await expect(page.getByText('LIVE', { exact: true })).toBeVisible({ timeout: 30000 });
    await page.getByRole('button', { name: /新增面板/ }).first().click();
    const picker = page.getByRole('dialog', { name: '新增面板', exact: true });
    await picker.getByPlaceholder('搜尋面板（名稱或用途）').fill('策略回測');
    await picker.locator('button[data-idx]').filter({ hasText: '策略回測' }).click();
    await page.evaluate(() => {
        const workspace = JSON.parse(localStorage.getItem('sj-pro-workspace-v3'));
        const block = workspace.blocks.find(b => b.type === 'backtest');
        localStorage.setItem('sj-pro-workspace-v3', JSON.stringify({ ...workspace, blocks: [block], layout: [{ i: block.id, x: 0, y: 0, w: 288, h: 24, minW: 96, minH: 8 }] }));
    });
    await page.reload(); await expect(learning()).toBeVisible();
    const originalRange = await learning().getByLabel('訓練歷史開始日期', { exact: true }).inputValue();
    expect((Date.now() - Date.parse(originalRange)) / 86400000).toBeGreaterThan(170);
    expect((Date.now() - Date.parse(originalRange)) / 86400000).toBeLessThan(190);
    await wrap().getByLabel('每口單邊手續費 NT$', { exact: true }).fill('12');
    await wrap().getByRole('button', { name: '依對帳單保存費率', exact: true }).click();

    const longJob = await collect('2026-05-01', '2026-10-30');
    expect(longJob.status).toBe('running');
    await expect(learning().getByRole('button', { name: '分批下載歷史資料', exact: true })).toBeDisabled();
    await expect(learning().getByRole('combobox', { name: '訓練資料版本', exact: true })).toBeDisabled();
    const concurrent = await api('/api/v1/research/learning/collect', { start: '2026-05-01', end: '2026-10-30' });
    expect(concurrent.status).toBe(400); expect(concurrent.data.detail).toContain('已有研究工作');
    await capture('learning-download-progress');
    const downloaded = await waitJob(longJob);
    await selectVersion('訓練資料版本', downloaded.resultId);
    const data = (await overview()).datasets.find(item => item.id === downloaded.resultId);
    expect(data.completeDays).toBeGreaterThanOrEqual(80);
    expect(data.contracts.length).toBeGreaterThan(1);
    expect(data.excludedDays).toEqual(['2026-06-15']); expect(data.absentWeekdays).toEqual(['2026-07-14']);
    await learning().getByText('資料品質明細', { exact: true }).click();
    await expect(learning().getByText(/缺段日期：2026-06-15/)).toBeVisible();
    await expect(learning().getByText(/股票K棒：/)).toBeVisible();
    await expect(learning().getByText(/股票K棒：/)).toContainText(/2330 \d+/);
    const firstStats = await stats();
    expect(firstStats.marketCalls.length).toBeGreaterThan(5);
    expect(firstStats.marketCalls.every(call => (Date.parse(call.end) - Date.parse(call.start)) / 86400000 <= 30)).toBe(true);
    const cached = await waitJob(await collect('2026-05-01', '2026-10-30'));
    expect(cached.resultId).toBe(downloaded.resultId);
    expect((await stats()).marketCalls).toEqual(firstStats.marketCalls);

    const trained = await waitJob(await train());
    await selectVersion('模型研究版本', trained.resultId);
    await expect(result()).toContainText('單邊費用 $12');
    const reportResponse = await api(`/api/v1/research/learning/runs/${trained.resultId}`); expect(reportResponse.status).toBe(200);
    const report = reportResponse.data;
    expect(report.status).toBe('diagnostic'); expect(report.model.bytes).toBeGreaterThan(1000);
    expect(report.counts.train).toBeGreaterThanOrEqual(60); expect(report.counts.validation).toBeGreaterThanOrEqual(20); expect(report.counts.test).toBeGreaterThanOrEqual(20);
    expect(report.split.trainDates.at(-1) < report.split.validationDates[0]).toBe(true);
    expect(report.split.validationDates.at(-1) < report.split.testDates[0]).toBe(true);
    expect(report.config.feePerSide).toBe(12); expect(report.config.feeSource).toBe('statement');
    expect(report.executionEnabled).toBe(false); expect(report.adoptionAllowed).toBe(false);
    expect(report.diagnostics.missingStockEvents).toBe(1);
    await expect(result().getByRole('table').first()).toContainText('封存測試／LightGBM 濾網');
    await expect(result()).toContainText('模型沒有核准自動交易');
    const realTraining = await stats(); expect(realTraining.lightgbmCalls).toBe(1);
    const modelResponse = page.waitForResponse(r => r.url().endsWith(`/api/v1/research/learning/models/${report.id}`));
    const modelDownload = page.waitForEvent('download');
    await learning().getByRole('button', { name: '匯出本機模型', exact: true }).click();
    expect((await (await modelResponse).json()).format).toBe('lightgbm-text');
    const downloadedModel = await modelDownload;
    const modelPath = path.join(artifacts, downloadedModel.suggestedFilename());
    await downloadedModel.saveAs(modelPath);
    const exportedModelHash = createHash('sha256').update(await readFile(modelPath)).digest('hex');
    expect(exportedModelHash).toBe(report.model.hash);
    const repeat = await waitJob(await train()); expect(repeat.resultId).toBe(trained.resultId);
    expect((await overview()).runs).toHaveLength(1); expect((await stats()).lightgbmCalls).toBe(1);
    await wrap().getByLabel('每口單邊手續費 NT$', { exact: true }).fill('16');
    await wrap().getByRole('button', { name: '依對帳單保存費率', exact: true }).click();
    await expect(result()).toContainText('單邊費用 $12');
    await page.reload(); await expect(learning()).toBeVisible();
    await selectVersion('模型研究版本', trained.resultId); await expect(result()).toContainText('單邊費用 $12');
    await expect(learning().getByText(/本次單邊費率 \$16/)).toBeVisible();

    const shortData = await waitJob(await collect('2026-10-26', '2026-10-30'));
    await selectVersion('訓練資料版本', shortData.resultId);
    const insufficient = await waitJob(await train());
    await selectVersion('模型研究版本', insufficient.resultId);
    await expect(result()).toContainText('資料不足，未建立模型');
    const shortReport = (await api(`/api/v1/research/learning/runs/${insufficient.resultId}`)).data;
    expect(shortReport.status).toBe('insufficient'); expect(shortReport.model).toBeNull();
    expect((await stats()).lightgbmCalls).toBe(1);
    await capture('learning-insufficient', result());
    const product = wrap().getByRole('combobox', { name: '期貨商品', exact: true });
    await product.click(); await page.getByRole('option', { name: '小台 MXF · 每點 $50', exact: true }).click();
    await expect(learning()).toHaveCount(0);
    await product.click(); await page.getByRole('option', { name: '微台 TMF · 每點 $10', exact: true }).click();
    await expect(learning()).toBeVisible();
    await selectVersion('訓練資料版本', downloaded.resultId); await selectVersion('模型研究版本', trained.resultId);
    await expect(result()).toContainText('單邊費用 $12');
    for (const theme of ['深色', '淺色']) {
        await setTheme(theme);
        for (const width of [1440, 390]) {
            await page.setViewportSize({ width, height: 1050 });
            await expect.poll(() => wrap().evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
            for (const control of await learning().getByRole('combobox').all()) {
                const height = (await control.boundingBox()).height; expect(height).toBeGreaterThanOrEqual(24); expect(height).toBeLessThanOrEqual(32);
            }
            const suffix = `${theme === '深色' ? 'dark' : 'light'}-${width}`;
            await capture(`learning-${suffix}-controls`); await capture(`learning-${suffix}-results`, result());
        }
    }
    const touch = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, storageState: await context.storageState() });
    const session = await page.evaluate(() => sessionStorage.getItem('fubon-trading-session'));
    await touch.addInitScript(value => sessionStorage.setItem('fubon-trading-session', value), session);
    try {
        const touchPage = await touch.newPage(); await touchPage.goto(origin);
        const touchLearning = touchPage.getByRole('region', { name: 'LightGBM 模型研究', exact: true });
        await expect(touchLearning).toBeVisible(); expect(await touchPage.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true);
        for (const control of await touchLearning.locator('button, input').all()) expect((await control.boundingBox()).height).toBeGreaterThanOrEqual(44);
        await touchLearning.scrollIntoViewIfNeeded();
        await touchPage.getByLabel('日內回測研究', { exact: true }).screenshot({ path: path.join(artifacts, 'learning-touch-390.png') });
    } finally { await touch.close(); }
    const finalStats = await stats();
    expect(finalStats.automation.status).toBe('idle'); expect(finalStats.automation.orders).toEqual([]);
    expect(transactions).toEqual([]); expect(automationWrites).toEqual([]); expect(pageErrors).toEqual([]);
    expect(progress.some(item => item.status === 'running' && item.progress > 0 && item.progress < 1)).toBe(true);
    const summary = { passed: true, sdkCalls: finalStats.sdkCalls, lightgbmCalls: finalStats.lightgbmCalls, marketReadCount: finalStats.marketCalls.length,
        dataset: data, report: { id: report.id, status: report.status, counts: report.counts, split: report.split, config: report.config, model: report.model, packages: report.packages },
        cachedDatasetId: cached.resultId, deduplicatedRunId: repeat.resultId, insufficientRunId: insufficient.resultId, exportedModelHash, transactions, automationWrites, pageErrors, progress, artifacts };
    await writeFile(path.join(artifacts, 'summary.json'), JSON.stringify(summary, null, 2));
    console.log(JSON.stringify({ ...summary, progress: `${progress.length} observations`, dataset: { ...data, completeDates: undefined }, report: { ...summary.report, split: undefined } }, null, 2));
} catch (error) {
    await page?.screenshot({ path: path.join(artifacts, 'failure.png'), fullPage: true }).catch(() => undefined);
    await writeFile(path.join(artifacts, 'failure.log'), `${error.stack || error}\n\n${logs}`);
    console.error(`${error.stack || error}\nArtifacts: ${artifacts}\n${logs.slice(-8000)}`); process.exitCode = 1;
} finally { await cleanup(); }
