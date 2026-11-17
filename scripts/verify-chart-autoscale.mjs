// Real CandleChart + lightweight-charts; synthetic history, no authenticated app.
import { chromium, expect } from '@playwright/test';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const temporary = await mkdtemp('/private/tmp/fubon-chart-autoscale-');
const artifacts = temporary;
const port = 6192, origin = `http://localhost:${port}`;
const baseline = process.argv.includes('--baseline');
const requests = [], blocked = [], errors = [], results = [];
let browser, vite, logs = '';
const history = { datetime: [], Open: [], High: [], Low: [], Close: [], Volume: [] };
for (let i = 0; i < 360; i++) {
    const price = i < 260 ? 44000 + Math.sin(i / 9) * 120 : 40150 + Math.sin((i - 260) / 5) * 250;
    history.datetime.push(new Date(Date.UTC(2026, 10, 17, 8, i)).toISOString().slice(0, 19));
    history.Open.push(price - 20); history.High.push(price + 50); history.Low.push(price - 50);
    history.Close.push(price + 20 * Math.sin(i / 3)); history.Volume.push(100 + i % 21 * 45);
}
const inst = (type, params = {}, extra = {}) => ({ id: `qa-${type}-${JSON.stringify(params)}`, type, params, colors: {}, ...extra });
const panes = [inst('volume'), inst('rsi', { period: 14 })];
const cases = [
    ['candles-control', [...panes]],
    ['long-ma200', [inst('sma', { period: 200 }), ...panes]],
    ['short-ma5', [inst('sma', { period: 5 }), ...panes]],
    ['boll200', [inst('boll', { period: 200, mult: 2 }), ...panes]],
    ['far-price-band', [inst('custom:qa-wall'), ...panes]],
    ['long-ma200-area', [inst('sma', { period: 200 }, { styles: { line: { plot: 'area' } } }), ...panes]],
    ['long-ma200-histogram', [inst('sma', { period: 200 }, { styles: { line: { plot: 'histogram' } } }), ...panes]],
    ['combined-overlays', [inst('sma', { period: 200 }), inst('sma', { period: 5 }), inst('boll', { period: 200, mult: 2 }), inst('custom:qa-wall'), ...panes]],
];

async function frames(page) { await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); }
async function measure(page) {
    return page.evaluate(() => {
        const chart = window.__qaCharts.at(-1), all = chart.panes(), candle = all[0].getSeries().find(series => series.seriesType() === 'Candlestick');
        const vr = chart.timeScale().getVisibleLogicalRange(), data = candle.data();
        const visible = data.filter((_, i) => i >= Math.ceil(vr.from) && i <= Math.floor(vr.to));
        const low = Math.min(...visible.map(bar => bar.low)), high = Math.max(...visible.map(bar => bar.high));
        const height = all[0].getHeight(), top = candle.priceToCoordinate(high), bottom = candle.priceToCoordinate(low);
        const series = all.map((pane, index) => ({ index, height: pane.getHeight(), series: pane.getSeries().map(s => {
            const points = s.data(), values = points.filter(p => p.time >= visible[0].time && p.time <= visible.at(-1).time && Number.isFinite(p.value)).map(p => p.value);
            return { type: s.seriesType(), length: points.length, visibleValues: values.length,
                min: values.length ? Math.min(...values) : null, max: values.length ? Math.max(...values) : null,
                values,
                range: [s.coordinateToPrice(0), s.coordinateToPrice(pane.getHeight())] };
        }) }));
        return { visibleLogical: vr, bars: visible.length, low, high, top, bottom, height,
            fraction: Math.abs(bottom - top) / height,
            priceRange: [candle.coordinateToPrice(0), candle.coordinateToPrice(height)], series };
    });
}

async function runCase(name, instances, width) {
    const context = await browser.newContext({ viewport: { width, height: 920 }, serviceWorkers: 'block' });
    await context.addInitScript(() => {
        window.__qaCharts = [];
        window.EventSource = class extends EventTarget {
            static CONNECTING = 0; static OPEN = 1; static CLOSED = 2; readyState = 0;
            constructor(url) { super(); this.url = String(url); } close() { this.readyState = 2; }
        };
    });
    await context.route('**/*', async route => {
        const req = route.request(), u = new URL(req.url());
        if (/^\/api(?:\/|$)/.test(u.pathname)) {
            requests.push({ name, width, method: req.method(), path: u.pathname });
            let body;
            if (u.pathname.endsWith('/kbars')) body = history;
            else if (u.pathname.endsWith('/info')) body = { broker: 'fubon', mode: 'demo', connected: false, market_connected: false, native_panel_api: 1, instance_id: 'chart-qa' };
            else if (u.pathname.endsWith('/health')) body = { status: 'ok', mode: 'demo' };
            else if (u.pathname.includes('/accounts')) body = [];
            else if (/\/stream\/(?:un)?subscribe(?:\/|$)/.test(u.pathname)) body = { subscribed: false };
            else { blocked.push({ method: req.method(), url: req.url() }); return route.abort('blockedbyclient'); }
            return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
        }
        if (u.origin === origin && u.pathname === '/__qa_chart_autoscale') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><script type="module">import R from "/@react-refresh";R.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;window.__qaReady=true;</script></head><body><div id="root" style="position:fixed;inset:8px;display:flex;flex-direction:column"></div></body></html>' });
        if (u.origin === origin && req.method() === 'GET' && /^\/(?:src\/|node_modules\/|@|favicon)/.test(u.pathname)) return route.continue();
        blocked.push({ method: req.method(), url: req.url() }); return route.abort('blockedbyclient');
    });
    const page = await context.newPage(); page.on('pageerror', error => errors.push(String(error)));
    try {
        await page.goto(origin + '/__qa_chart_autoscale'); await page.waitForFunction(() => window.__qaReady);
        await page.evaluate(async instances => {
            await import('/src/index.css');
            const { React, createRoot } = await import('/src/__qa_chart_runtime.ts');
            const custom = await import('/src/lib/custom-indicators.ts');
            custom.saveCustom({ id: 'qa-wall', name: 'QA distant band', short: 'QA band', desc: 'Synthetic band outside recent candles', category: 'overlay', params: [], outputs: [{ key: 'wall', label: 'Wall', kind: 'band', color: '#5a89c9' }], source: "band('wall', 44025, 43975);", updatedAt: 1 });
            localStorage.setItem('sj-pro-indicators-v3', JSON.stringify(instances));
            const theme = await import('/src/lib/theme-store.ts'); theme.setThemeSettings({ mode: 'dark', fontScale: 1 }); theme.initTheme();
            const { primeContract } = await import('/src/lib/contracts-cache.ts');
            const contract = { security_type: 'STK', exchange: 'TSE', code: '9999', region: 'TW', name: 'QA synthetic 40000', day_trade: 'Yes', reference: 40000 };
            primeContract(contract);
            const { CandleChart } = await import('/src/components/candle-chart.tsx');
            createRoot(document.getElementById('root')).render(React.createElement(CandleChart, { contract, interval: '1m', showHighLow: false }));
        }, instances);
        await expect.poll(() => page.evaluate(() => window.__qaCharts.at(-1)?.panes()[0]?.getSeries().find(s => s.seriesType() === 'Candlestick')?.data().length)).toBe(360);
        await expect(page.locator('[data-chart-readouts="pane"]')).toHaveCount(2);
        const ranges = baseline ? [['recent60', 299, 359]] : [['recent60', 299, 359], ['zoom40', 319, 359], ['pan60', 279, 339], ['older60', 160, 220]];
        for (const [view, from, to] of ranges) {
            await page.evaluate(({ from, to }) => { const c = window.__qaCharts.at(-1); c.timeScale().setVisibleLogicalRange({ from, to }); c.panes()[0].getSeries()[0].priceScale().setAutoScale(true); }, { from, to });
            await frames(page);
            const geometry = await measure(page);
            results.push({ name, width, view, ...geometry });
            await page.screenshot({ path: path.join(artifacts, `${name}-${width}-${view}.png`), animations: 'disabled' });
            await writeFile(path.join(artifacts, 'measurements.json'), JSON.stringify(results, null, 2));
            expect(geometry.bars).toBeGreaterThanOrEqual(40);
            expect(geometry.fraction, `${name} ${width} ${view}: visible candle high-low must occupy >50% of main plot`).toBeGreaterThan(0.5);
            expect(geometry.top).toBeGreaterThanOrEqual(-1); expect(geometry.bottom).toBeLessThanOrEqual(geometry.height + 1);
            expect(geometry.series).toHaveLength(3);
            const volume = geometry.series[1].series[0], rsi = geometry.series[2].series[0];
            expect(volume.type).toBe('Histogram'); expect(volume.visibleValues).toBeGreaterThan(30); expect(volume.max).toBeGreaterThan(100);
            expect(volume.range.every(Number.isFinite)).toBe(true);
            expect(Math.min(...volume.range)).toBeLessThanOrEqual(0); expect(Math.max(...volume.range)).toBeGreaterThanOrEqual(volume.max);
            expect(rsi.type).toBe('Line'); expect(rsi.visibleValues).toBeGreaterThan(30); expect(rsi.min).toBeGreaterThanOrEqual(0); expect(rsi.max).toBeLessThanOrEqual(100);
            expect(rsi.range.every(Number.isFinite)).toBe(true);
            expect(Math.min(...rsi.range)).toBeLessThanOrEqual(rsi.min); expect(Math.max(...rsi.range)).toBeGreaterThanOrEqual(rsi.max);
            if (name !== 'candles-control') {
                const control = results.find(result => result.name === 'candles-control' && result.width === width && result.view === view);
                expect(volume.values).toEqual(control.series[1].series[0].values);
                expect(rsi.values).toEqual(control.series[2].series[0].values);
            }
        }
        if (!baseline && name === 'combined-overlays') {
            const before = await page.evaluate(() => {
                const chart = window.__qaCharts.at(-1), scale = chart.panes()[0].getSeries()[0].priceScale();
                scale.setAutoScale(false); scale.setVisibleRange({ from: 39000, to: 45000 });
                return scale.getVisibleRange();
            });
            await frames(page);
            await page.evaluate(async instances => {
                const { saveInstances } = await import('/src/lib/indicator-defs.ts');
                saveInstances([...instances, { id: 'qa-extra-ema', type: 'ema', params: { period: 120 }, colors: {} }]);
                window.__qaCharts.at(-1).timeScale().setVisibleLogicalRange({ from: 299, to: 359 });
            }, instances);
            await frames(page);
            const after = await page.evaluate(() => window.__qaCharts.at(-1).panes()[0].getSeries()[0].priceScale().getVisibleRange());
            expect(after.from).toBeCloseTo(before.from, 3); expect(after.to).toBeCloseTo(before.to, 3);
            await page.screenshot({ path: path.join(artifacts, `${name}-${width}-manual-price-range.png`), animations: 'disabled' });
            results.push({ name, width, view: 'manual-price-range-preserved-after-indicator-change-and-pan', before, after });
        }
    } finally { await context.close(); }
}

try {
    await new Promise((resolve, reject) => { const probe = net.createServer(); probe.once('error', reject); probe.listen(port, '127.0.0.1', () => probe.close(resolve)); });
    const runner = path.join(temporary, 'vite.mjs');
    await writeFile(runner, `import{createServer,loadConfigFromFile}from ${JSON.stringify(path.join(root, 'node_modules/vite/dist/node/index.js'))};
globalThis.fetch=async()=>{throw new Error('QA forbids upstream fetch');};
const loaded=await loadConfigFromFile({command:'serve',mode:'development'},${JSON.stringify(path.join(root, 'vite.config.ts'))},process.cwd());
const observer={name:'qa-chart-observer',enforce:'pre',resolveId(id){if(id==='/src/__qa_chart_runtime.ts')return '\\0qa-chart-runtime';},load(id){if(id==='\\0qa-chart-runtime')return 'export{default as React}from "react";export{createRoot}from "react-dom/client";';},transform(code,id){if(id.endsWith('/src/components/candle-chart.tsx')){if(!code.includes('createChart,'))throw Error('Chart observer seam changed');return code.replace('createChart,','createChart as qaNativeCreateChart,')+'\\nfunction createChart(...args){const chart=qaNativeCreateChart(...args);globalThis.__qaCharts.push(chart);return chart;}';}},configureServer(server){server.middlewares.use((req,res,next)=>{if(req.url.startsWith('/api/')){res.statusCode=503;res.end('QA forbids backend access');}else next();});}};
process.chdir(${JSON.stringify(root)});
const server=await createServer({...loaded.config,plugins:[observer,...loaded.config.plugins],configFile:false,root:${JSON.stringify(root)},envDir:${JSON.stringify(temporary)},cacheDir:${JSON.stringify(path.join(temporary, 'vite-cache'))},server:{...loaded.config.server,proxy:{},host:'127.0.0.1',port:${port},strictPort:true,fs:{...loaded.config.server.fs,allow:[...loaded.config.server.fs.allow,${JSON.stringify(root)},${JSON.stringify(await realpath(path.join(root, 'node_modules')))}]}}});await server.listen();`);
    const env = Object.fromEntries(['PATH', 'TMPDIR', 'TMP', 'TEMP', 'LANG'].filter(key => process.env[key]).map(key => [key, process.env[key]]));
    vite = spawn(process.execPath, [runner], { cwd: temporary, detached: true, env, stdio: ['ignore', 'pipe', 'pipe'] });
    for (const stream of [vite.stdout, vite.stderr]) stream.on('data', chunk => { logs = (logs + chunk).slice(-20000); });
    await expect.poll(async () => { try { return (await fetch(origin + '/@vite/client')).status; } catch { return 0; } }, { timeout: 30000 }).toBe(200);
    const sources = ['src/components/candle-chart.tsx', 'src/lib/chart-indicators.ts', 'src/lib/indicator-defs.ts'];
    await writeFile(path.join(artifacts, 'source.json'), JSON.stringify({ head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), hashes: Object.fromEntries(await Promise.all(sources.map(async file => [file, createHash('sha256').update(await readFile(path.join(root, file))).digest('hex')]))) }, null, 2));
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    for (const width of baseline ? [1440] : [1440, 390]) for (const [name, instances] of cases) await runCase(name, instances, width);
    expect(errors).toEqual([]); expect(blocked).toEqual([]);
    await writeFile(path.join(artifacts, 'summary.json'), JSON.stringify({ passed: true, results, requests, errors, blocked }, null, 2));
    console.log(JSON.stringify({ passed: true, checks: results.length, artifacts }));
} catch (error) {
    await writeFile(path.join(artifacts, 'failure.log'), logs);
    await writeFile(path.join(artifacts, 'summary.json'), JSON.stringify({ passed: false, error: String(error), results, requests, errors, blocked }, null, 2));
    console.error(JSON.stringify({ passed: false, error: String(error), last: results.at(-1), artifacts })); throw error;
} finally {
    await browser?.close();
    if (vite && vite.exitCode === null && !vite.signalCode) {
        const ended = new Promise(resolve => vite.once('exit', resolve));
        try { process.kill(-vite.pid, 'SIGTERM'); } catch { /* already stopped */ }
        let timeout; await Promise.race([ended, new Promise(resolve => { timeout = setTimeout(resolve, 5000); })]); clearTimeout(timeout);
        if (vite.exitCode === null && !vite.signalCode) { try { process.kill(-vite.pid, 'SIGKILL'); } catch { /* already stopped */ } await ended; }
    }
}
