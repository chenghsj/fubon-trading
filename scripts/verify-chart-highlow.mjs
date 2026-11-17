// Real lightweight-charts + HighLowLayer geometry acceptance. No app, auth, or API.
// Baseline is pinned Git source; current source is imported without modification.
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';

const root = fileURLToPath(new URL('../', import.meta.url));
const baseline = process.env.CHART_HIGHLOW_BASELINE || '12ccac3fb67d181285023ee89c5fd07087f7e98d';
const phase = process.env.CHART_HIGHLOW_PHASE || 'acceptance';
const port = Number(process.env.CHART_HIGHLOW_PORT || 6191), origin = `http://localhost:${port}`;
const temporary = await mkdtemp(path.join(tmpdir(), 'fubon-chart-highlow-'));
const artifacts = process.env.CHART_HIGHLOW_ARTIFACT_DIR || path.join(temporary, 'artifacts');
const results = [], pageErrors = [], blocked = [];
let browser, page, child, logs = '';
await mkdir(artifacts, { recursive: true });

async function free() {
    if (!Number.isInteger(port) || port < 1024 || port > 65535 || [5179, 21323, 5784, 22584].includes(port)) throw new Error('Unsafe chart QA port.');
    await new Promise((resolve, reject) => { const probe = net.createServer(); probe.once('error', reject); probe.listen(port, '127.0.0.1', () => probe.close(resolve)); });
}
async function settle() {
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}
async function capture(name, variant, required = true, expectHidden = false) {
    await settle();
    const geometry = await page.evaluate(() => window.qa.geometry());
    const violations = [];
    for (const box of geometry.boxes) {
        if (box.left < 3 || box.right > geometry.pane.width - 3 || box.top < 3 || box.bottom > geometry.pane.height - 3) violations.push(`${box.kind} outside pane`);
        if (box.kind === 'high' && (geometry.inverted ? box.top < geometry.extrema.high + 1 : box.bottom > geometry.extrema.high - 1)) violations.push('high label enters visible candle range');
        if (box.kind === 'low' && (geometry.inverted ? box.bottom > geometry.extrema.low - 1 : box.top < geometry.extrema.low + 1)) violations.push('low label enters visible candle range');
        if (box.kind !== 'high' && box.kind !== 'low') violations.push('unidentified label');
        for (const wick of geometry.wicks) {
            if (wick.x + 0.5 >= box.left && wick.x - 0.5 <= box.right && wick.bottom >= box.top && wick.top <= box.bottom) violations.push(`${box.kind} overlaps wick ${wick.index}`);
        }
    }
    const screenshot = path.join(artifacts, `${variant}-${name}.png`);
    await page.locator('#fixture').screenshot({ path: screenshot, animations: 'disabled' });
    const result = { name, variant, violations, screenshot, ...geometry };
    results.push(result);
    if (required) {
        expect(violations, JSON.stringify(result, null, 2)).toEqual([]);
        if (expectHidden) expect(geometry.boxes, 'No-space fixture must hide labels instead of clamping them onto candles.').toEqual([]);
    }
    return result;
}
async function mount(variant, theme = 'dark', width = 1180, height = 540, range = { from: 38, to: 82 }) {
    await page.evaluate(options => window.qa.mount(options), { variant, theme, width, height, range });
    await settle();
}
async function mutate(method, arg) { await page.evaluate(({ method, arg }) => window.qa[method](arg), { method, arg }); await settle(); }
async function mainPane() { return page.locator('#chart table tr').first().locator('td').nth(1).boundingBox(); }
async function changes(read, operation, description) {
    const before = await page.evaluate(read); await operation();
    await expect.poll(() => page.evaluate(read), { message: description }).not.toEqual(before);
    await settle();
}

try {
    await free();
    const baselineSource = execFileSync('git', ['show', `${baseline}:src/lib/chart-highlow.ts`], { cwd: root, encoding: 'utf8' });
    await writeFile(path.join(temporary, 'chart-highlow-before.ts'), baselineSource);
    const library = '/@fs/' + await realpath(path.join(root, 'node_modules/lightweight-charts/dist/lightweight-charts.standalone.development.mjs'));
    const current = '/@fs/' + path.join(root, 'src/lib/chart-highlow.ts');
    await writeFile(path.join(temporary, 'index.html'), `<!doctype html><meta charset="utf-8"><title>High low isolated chart QA</title>
<style>body{margin:0;padding:20px;background:#10131a;color:#c7ccd6;font:13px system-ui}#fixture{display:inline-block}h1{font-size:16px;font-weight:600;margin:0 0 8px}p{font-size:12px;margin:0 0 12px;color:#9299a5}#chart{position:relative}</style>
<section id="fixture"><h1 id="caption"></h1><p>Synthetic adjacent candles · no trading session · no API</p><div id="chart"></div></section>
<script type="module">
import { createChart, CandlestickSeries } from ${JSON.stringify(library)};
import { HighLowLayer as Before } from './chart-highlow-before.ts';
import { HighLowLayer as After } from ${JSON.stringify(current)};
const colors={dark:{bg:'#10131a',text:'#c7ccd6',grid:'#1f2633',labelBg:'#181f2b',border:'#465062',highColor:'#f23645',lowColor:'#16b389'},light:{bg:'#ffffff',text:'#273246',grid:'#e8ebf0',labelBg:'#ffffff',border:'#8b96a7',highColor:'#d72a39',lowColor:'#008b69'}};
const bars=()=>Array.from({length:120},(_,index)=>{
  const base=39930+Math.round(Math.sin(index/5)*12);
  const b={time:1794877200+index*60,open:base+3,close:base-4,high:base+14,low:base-14};
  const special={57:{open:40005,close:40000,high:40020,low:39985},58:{open:39995,close:40005,high:40018,low:39982},59:{open:39994,close:40003,high:40017,low:39980},60:{open:39995,close:39996,high:40016,low:39979},61:{open:39875,close:39880,high:39893,low:39858},62:{open:39874,close:39878,high:39891,low:39859},63:{open:39877,close:39884,high:39896,low:39861},64:{open:39879,close:39883,high:39896,low:39860}}[index];
  return {...b,...special};
});
let chart,series,layer,data,frame,serial=0;
function observeRenderer(){
  for(const view of layer.paneViews()){
    const original=view.renderer.bind(view);
    view.renderer=()=>{
      const renderer=original();
      return {draw(target){
        const next={serial:++serial,boxes:[],marks:layer.marks(),media:null};
        let points=[],corners=0,arcs=0,lastDotColor=null;
        const observedTarget=new Proxy(target,{get(t,key){
          if(key!=='useMediaCoordinateSpace'){const value=t[key];return typeof value==='function'?value.bind(t):value;}
          return callback=>t.useMediaCoordinateSpace(scope=>{
            next.media={...scope.mediaSize};
            const ctx=scope.context;
            const proxy=new Proxy(ctx,{get(c,key){
              const value=Reflect.get(c,key,c);
              if(typeof value!=='function')return value;
              return (...args)=>{
                if(key==='beginPath'){points=[];corners=0;arcs=0;}
                if(key==='moveTo'||key==='lineTo')points.push([args[0],args[1]]);
                if(key==='arcTo'){corners++;points.push([args[0],args[1]],[args[2],args[3]]);}
                if(key==='arc')arcs++;
                if(key==='fill'&&arcs)lastDotColor=c.fillStyle;
                if(key==='fill'&&corners===4&&!arcs&&points.length){
                  const xs=points.map(p=>p[0]),ys=points.map(p=>p[1]);
                  next.boxes.push({kind:lastDotColor===layer.style.highColor?'high':lastDotColor===layer.style.lowColor?'low':'unknown',left:Math.min(...xs),right:Math.max(...xs),top:Math.min(...ys),bottom:Math.max(...ys),color:lastDotColor,text:[]});
                }
                if(key==='fillText'&&next.boxes.length)next.boxes.at(-1).text.push(String(args[0]));
                return Reflect.apply(value,c,args);
              };
            },set(c,key,value){return Reflect.set(c,key,value,c);}});
            return callback({...scope,context:proxy});
          });
        }});
        renderer.draw(observedTarget);frame=next;
      }};
    };
  }
}
window.qa={
  mount({variant,theme,width,height,range}){
    chart?.remove();frame=null;data=bars();
    const c=colors[theme];document.body.style.background=c.bg;document.body.style.color=c.text;
    const host=document.querySelector('#chart');host.style.width=width+'px';host.style.height=height+'px';
    document.querySelector('#caption').textContent=variant+' · '+theme+' · '+width+'×'+height+' · lowest 39,858';
    chart=createChart(host,{width,height,layout:{background:{type:'solid',color:c.bg},textColor:c.text,attributionLogo:false},grid:{vertLines:{color:c.grid},horzLines:{color:c.grid}},rightPriceScale:{borderColor:c.border,scaleMargins:{top:.18,bottom:.18}},timeScale:{borderColor:c.border,timeVisible:true,secondsVisible:false},crosshair:{vertLine:{visible:false},horzLine:{visible:false}},handleScroll:{mouseWheel:true,pressedMouseMove:true},handleScale:{axisPressedMouseMove:{price:true,time:true},mouseWheel:true,pinch:true}});
    series=chart.addSeries(CandlestickSeries,{upColor:c.highColor,downColor:c.lowColor,borderUpColor:c.highColor,borderDownColor:c.lowColor,wickUpColor:c.highColor,wickDownColor:c.lowColor,priceLineVisible:false,lastValueVisible:false});
    layer=new(variant==='before'?Before:After)({visible:true,highColor:c.highColor,lowColor:c.lowColor,labelBg:c.labelBg,border:c.border,mutedText:c.text,format:p=>p.toLocaleString('en-US')});
    observeRenderer();series.attachPrimitive(layer);series.setData(data);chart.timeScale().setVisibleLogicalRange(range);
  },
  range(range){chart.timeScale().setVisibleLogicalRange(range);},
  tight(){series.priceScale().applyOptions({autoScale:false,scaleMargins:{top:0,bottom:0}});series.priceScale().setVisibleRange({from:39860,to:40018});},
  clipped(){series.priceScale().applyOptions({autoScale:false,scaleMargins:{top:0,bottom:0}});series.priceScale().setVisibleRange({from:39870,to:40008});},
  manual(){series.priceScale().applyOptions({autoScale:false});},
  invert(){series.priceScale().applyOptions({invertScale:true});},
  flat(){data=[{time:1794877200,open:100,close:100,high:100,low:100},{time:1794877260,open:100,close:100,high:100,low:100}];series.setData(data);chart.timeScale().setVisibleLogicalRange({from:-2,to:3});},
  latest(){chart.timeScale().setVisibleLogicalRange({from:90,to:123});const next={...data.at(-1),high:40080,low:39810,open:39920,close:39975};data[data.length-1]=next;series.update(next);},
  append(){const next={time:data.at(-1).time+60,open:39975,close:39980,high:40110,low:39780};data.push(next);series.update(next);},
  state(){return{range:chart.timeScale().getVisibleLogicalRange(),highY:series.priceToCoordinate(40020),lowY:series.priceToCoordinate(39858),serial};},
  geometry(){
    const range=chart.timeScale().getVisibleLogicalRange();
    const inverted=series.priceScale().options().invertScale;
    const pane=document.querySelector('#chart table tr').cells[1].getBoundingClientRect();
    const wicks=[];
    for(let index=Math.max(0,Math.floor(range.from));index<=Math.ceil(range.to);index++){
      const bar=series.dataByIndex(index);if(!bar||!Number.isFinite(bar.high)||!Number.isFinite(bar.low))continue;
      const x=chart.timeScale().timeToCoordinate(bar.time),top=series.priceToCoordinate(bar.high),bottom=series.priceToCoordinate(bar.low);
      if(x===null||top===null||bottom===null)continue;
      wicks.push({index,x,top:Math.min(top,bottom),bottom:Math.max(top,bottom),highY:top,lowY:bottom,high:bar.high,low:bar.low});
    }
    return{range,inverted,pane:{x:pane.x,y:pane.y,width:pane.width,height:pane.height},extrema:{high:(inverted?Math.max:Math.min)(...wicks.map(w=>w.highY)),low:(inverted?Math.min:Math.max)(...wicks.map(w=>w.lowY))},wicks,boxes:frame?.boxes??[],marks:frame?.marks??[],serial:frame?.serial??0,media:frame?.media??null};
  }
};
window.ready=true;
</script>`);
    const viteFile = path.join(temporary, 'vite.mjs');
    await writeFile(viteFile, `import { createServer } from ${JSON.stringify(path.join(root, 'node_modules/vite/dist/node/index.js'))};
globalThis.fetch=async()=>{throw new Error('QA forbids outbound fetch');};
const server=await createServer({configFile:false,root:process.cwd(),envDir:process.cwd(),cacheDir:${JSON.stringify(path.join(temporary, 'vite-cache'))},server:{host:'127.0.0.1',port:${port},strictPort:true,fs:{allow:[process.cwd(),${JSON.stringify(root)},${JSON.stringify(await realpath(path.join(root, 'node_modules')))}]}},optimizeDeps:{noDiscovery:true}});await server.listen();`);
    const env = Object.fromEntries(['PATH', 'TMPDIR', 'TMP', 'TEMP', 'LANG'].filter(key => process.env[key]).map(key => [key, process.env[key]]));
    child = spawn(process.execPath, [viteFile], { cwd: temporary, detached: true, env, stdio: ['ignore', 'pipe', 'pipe'] });
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { logs = (logs + chunk).slice(-30000); });
    await expect.poll(async () => { try { return (await fetch(origin)).status; } catch { return 0; } }, { timeout: 30000 }).toBe(200);
    browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true });
    const context = await browser.newContext({ viewport: { width: 1360, height: 900 }, deviceScaleFactor: 1 });
    await context.route('**/*', route => {
        const url = new URL(route.request().url());
        if (url.origin === origin && !url.pathname.startsWith('/api/') && !url.pathname.startsWith('/metadata/')) return route.continue();
        blocked.push({ method: route.request().method(), url: url.origin + url.pathname });
        return route.abort('blockedbyclient');
    });
    page = await context.newPage(); page.on('pageerror', error => pageErrors.push(error.message));
    await page.goto(origin); await page.waitForFunction(() => window.ready === true);
    await mount('before'); const reproduced = await capture('adjacent-wicks-dark-wide', 'before', false);
    expect(reproduced.violations.some(item => item.includes('overlaps wick')), 'Pinned baseline must reproduce actual label/wick collision.').toBe(true);
    if (phase !== 'baseline') {
        for (const theme of ['dark', 'light']) {
            for (const width of [1180, 390]) {
                await mount('after', theme, width); const normal = await capture(`adjacent-wicks-${theme}-${width}`, 'after');
                expect(normal.boxes).toHaveLength(2);
                await mutate('range', { from: 56.8, to: 80.8 }); await capture(`left-edge-${theme}-${width}`, 'after');
                await mutate('range', { from: 38.2, to: 62.2 }); await capture(`right-edge-${theme}-${width}`, 'after');
            }
            await mount('after', theme); await mutate('tight'); await capture(`no-space-${theme}`, 'after', true, true);
            await mount('after', theme); await mutate('clipped'); await capture(`extrema-outside-pane-${theme}`, 'after', true, true);
            await mount('after', theme, 390, 85); await capture(`short-pane-${theme}`, 'after');
            await mount('after', theme); await mutate('invert'); const inverted = await capture(`inverted-${theme}`, 'after');
            expect(inverted.boxes).toHaveLength(2);
            await mutate('flat'); const flat = await capture(`inverted-flat-${theme}`, 'after');
            expect(flat.boxes).toHaveLength(2); expect(flat.extrema.high).toBe(flat.extrema.low);
            await mount('after', theme); const pane = await mainPane();
            await changes(() => window.qa.state().highY, async () => {
                await page.mouse.move(pane.x + pane.width + 25, pane.y + pane.height * .35); await page.mouse.down();
                await page.mouse.move(pane.x + pane.width + 25, pane.y + pane.height * .65, { steps: 12 }); await page.mouse.up();
            }, 'Real right-price-axis drag must change scale.');
            await capture(`price-axis-scale-${theme}`, 'after');
            await mutate('manual');
            await changes(() => window.qa.state().highY, async () => {
                await page.mouse.move(pane.x + pane.width * .5, pane.y + pane.height * .5); await page.mouse.down();
                await page.mouse.move(pane.x + pane.width * .5, pane.y + pane.height * .5 + 55, { steps: 12 }); await page.mouse.up();
            }, 'Real chart drag must move manual price range.');
            await capture(`price-pan-${theme}`, 'after');
            await mount('after', theme); const timePane = await mainPane();
            await changes(() => window.qa.state().range, async () => {
                await page.mouse.move(timePane.x + timePane.width * .5, timePane.y + timePane.height * .5); await page.mouse.wheel(0, -400);
            }, 'Real wheel gesture must zoom time.');
            await capture(`time-zoom-${theme}`, 'after');
            await changes(() => window.qa.state().range, async () => {
                await page.mouse.move(timePane.x + timePane.width * .6, timePane.y + timePane.height * .5); await page.mouse.down();
                await page.mouse.move(timePane.x + timePane.width * .35, timePane.y + timePane.height * .5, { steps: 12 }); await page.mouse.up();
            }, 'Real horizontal gesture must pan time.');
            await capture(`time-pan-${theme}`, 'after');
            await mount('after', theme); await mutate('latest'); const live = await capture(`live-update-${theme}`, 'after');
            expect(live.marks.map(mark => mark.value)).toEqual(['40,080', '39,810']);
            await mutate('append'); const appended = await capture(`live-append-${theme}`, 'after');
            expect(appended.marks.map(mark => mark.value)).toEqual(['40,110', '39,780']);
        }
    }
    expect(pageErrors).toEqual([]); expect(blocked).toEqual([]);
    await writeFile(path.join(artifacts, 'summary.json'), JSON.stringify({ passed: true, phase, baseline, actualSource: 'src/lib/chart-highlow.ts', results, pageErrors, blocked, temporary, origin }, null, 2));
    console.log(JSON.stringify({ passed: true, phase, baseline, checks: results.length, baselineViolations: reproduced.violations, artifacts, temporary }, null, 2));
} catch (error) {
    await writeFile(path.join(artifacts, 'failure.log'), logs);
    await writeFile(path.join(artifacts, 'summary.json'), JSON.stringify({ passed: false, phase, baseline, error: String(error), results, pageErrors, blocked, temporary }, null, 2));
    await page?.screenshot({ path: path.join(artifacts, 'failure.png'), fullPage: true }).catch(() => undefined);
    console.error(JSON.stringify({ passed: false, artifacts, temporary })); throw error;
} finally {
    await browser?.close().catch(() => undefined);
    if (child && child.exitCode === null && !child.signalCode) {
        const ended = new Promise(resolve => child.once('exit', resolve));
        try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already stopped */ }
        let timeout; await Promise.race([ended, new Promise(resolve => { timeout = setTimeout(resolve, 8000); })]); clearTimeout(timeout);
        if (child.exitCode === null && !child.signalCode) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already stopped */ } await ended; }
    }
}
