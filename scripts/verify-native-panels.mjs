// Isolated real CLI + HTTP + browser acceptance. Only native market clients are
// synthetic fixtures. Never uses the user's services, credentials or accounts.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';

const root = fileURLToPath(new URL('../', import.meta.url));
const uiPort = 6188, apiPort = 22988, origin = `http://localhost:${uiPort}`;
const temporary = await mkdtemp(path.join(tmpdir(), 'fubon-native-panels-'));
const artifacts = process.env.NATIVE_PANEL_ARTIFACT_DIR || path.join(temporary, 'artifacts');
const launch = randomBytes(32).toString('base64url');
const children = [], results = [], pageErrors = [], blocked = [], mutations = [], watchlistMutations = [], responses = [], apiRequests = [], sourceErrors = [];
const unavailableTypes = ['warrants', 'combo', 'combolist', 'conditional', 'oddspread',
    'heatmap', 'chainmap', 'holdingmap', 'pulse', 'signals', 'assistant', 'optchain'];
const newPanelTypes = ['fuboncredit', 'fubonaccount', 'fuboncondition', 'fubonownership', 'fuboncorporate',
    'fubontechnical', 'fubonhistory', 'fubonindices', 'fubonadvanced'];
const unavailableRoutes = /\/data\/(?:credit_enquire|short_stock_sources|regulatory_punish|index_components|contracts\/(?:warrants|combo|options))|\/order\/combotrades|\/stream\/(?:subscribe|unsubscribe)\/(?:calculated_index|index_components|scanner)|\/(?:conditional|agent)(?:\/|$)/;
let browser, page, childLogs = '', delayServerInfo = false;
await mkdir(artifacts, { recursive: true });

const stocks = [['2330','台積電',100],['2454','聯發科',200],['2303','聯電',50],['1802','台玻',20]].map(([symbol,name,referencePrice])=>({symbol,name,referencePrice,market:'TSE'}));
const taipeiToday = new Date(Date.now()+8*3600_000).toISOString().slice(0,10);
const fixture = {source:'Synthetic native read SDK and public native-shaped market examples; no real account'};
const nativeIds = {};
const draftFailures = [];
function run(command, args, extra = {}) {
    const env = Object.fromEntries(['PATH', 'TMPDIR', 'TMP', 'TEMP', 'LANG'].filter(key => process.env[key]).map(key => [key, process.env[key]]));
    const child = spawn(command, args, { cwd: temporary, detached: true, env: { ...env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { childLogs = (childLogs + chunk).slice(-40000); });
    children.push(child);
}
async function free(port) {
    await new Promise((resolve, reject) => { const probe = net.createServer(); probe.once('error', reject);
        probe.listen(port, '127.0.0.1', () => probe.close(resolve)); });
}
async function ready(url) {
    await expect.poll(async () => { try { return (await fetch(url)).status; } catch { return 0; } }, { timeout: 30000 }).toBe(200);
}
async function qa(body={}) { return page.evaluate(async body => {const r=await fetch('/api/v1/qa/native-panels',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});if(!r.ok)throw Error('QA '+r.status);return r.json();},body); }
async function workspace() { return page.evaluate(async () => (await import('/src/lib/workspace.ts')).loadWorkspace()); }
const panel = id => page.locator(`[data-block-id="${id}"]`);
const header = id => panel(id).locator('[data-slot="card-header"]').first();
async function frame() { await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); }
async function exposeApi() { await page.evaluate(async () => { window.qaPanels = { api: await import('/src/lib/shioaji.ts') }; }); }
async function addPanel(label, type) {
    const before = (await workspace()).blocks.map(block => block.id);
    await page.getByRole('button', { name: /新增面板/ }).click();
    const library = page.getByRole('dialog', { name: '新增面板', exact: true });
    await library.getByPlaceholder('搜尋面板（名稱或用途）', { exact: true }).fill(label);
    await library.getByRole('button', { name: new RegExp('^' + label) }).click();
    await expect(library).toBeHidden();
    await expect.poll(async () => (await workspace()).blocks.length).toBe(before.length + 1);
    const added = (await workspace()).blocks.find(block => !before.includes(block.id));
    expect(added.type).toBe(type); await panel(added.id).scrollIntoViewIfNeeded(); return added.id;
}
async function selectGlobal(query, code) {
    await page.getByRole('button', { name: /^搜尋商品(?:\s|$)/ }).click();
    const dialog = page.getByRole('dialog', { name: '搜尋商品與面板', exact: true });
    await dialog.getByRole('combobox').fill(query);
    const option = dialog.getByRole('option').filter({ hasText: new RegExp('^' + code) });
    await expect(option).toBeVisible({ timeout: 20000 }); await option.click(); await expect(dialog).toBeHidden();
    if(await panel('chart-0').count())await expect(header('chart-0')).toContainText(code);
}
async function noWatchlistChange(before, writeCount) {
    await frame(); expect(await page.evaluate(() => window.qaPanels.api.fetchWatchlists())).toEqual(before);
    expect(watchlistMutations.length).toBe(writeCount); expect(mutations).toEqual([]);
}
async function unavailablePanelChecks() {
    const original = await workspace();
    const metadata = await page.evaluate(async types => {
        const { BLOCK_META } = await import('/src/lib/workspace.ts');
        return types.map(type => ({ type, label: BLOCK_META[type].label }));
    }, unavailableTypes);
    const requestStart = apiRequests.length;
    for (const { type, label } of metadata) {
        await page.getByRole('button', { name: /新增面板/ }).click();
        const library = page.getByRole('dialog', { name: '新增面板', exact: true });
        const input = library.getByPlaceholder('搜尋面板（名稱或用途）', { exact: true });
        await input.fill(type);
        const card = library.locator('button[data-idx]').filter({ hasText: label }).first();
        await expect(card).toBeVisible(); await expect(card).toBeDisabled();
        await expect(card).toContainText('未支援'); await expect(card).toHaveAttribute('title', /^未支援：/);
        const geometry = await card.boundingBox();
        await page.mouse.move(geometry.x + geometry.width / 2, geometry.y + geometry.height / 2);
        await page.mouse.click(geometry.x + geometry.width / 2, geometry.y + geometry.height / 2);
        await frame(); expect(await workspace()).toEqual(original); await expect(library).toBeVisible();
        await input.press('Enter'); await frame(); expect(await workspace()).toEqual(original); await expect(library).toBeVisible();
        await input.press('Shift+Enter'); await frame(); expect(await workspace()).toEqual(original); await expect(library).toBeVisible();
        // A schematic is allowed; the actual unsupported component must never
        // be offered as a live preview or mounted after keyboard activation.
        await expect(library.getByRole('button', { name: '即時預覽', exact: true })).toHaveCount(0);
        const liveClass = await page.evaluate(async () => (await import('/src/components/panel-library.css.ts')).livePreviewCanvas);
        await expect(library.locator('.' + liveClass)).toHaveCount(0);
        if (type === 'chips' || type === 'pulse') await library.screenshot({ path: path.join(artifacts, `disabled-library-${type}.png`), animations: 'disabled' });
        await input.press('Escape'); await expect(library).toBeHidden();
        results.push({ check: 'unavailable-library-card-blocks-mouse-enter-shift-enter-no-live-preview', type, label });
    }
    expect(apiRequests.slice(requestStart).filter(row => unavailableRoutes.test(row.path))).toEqual([]);
    // Simulate a previously saved workspace in this temporary browser only.
    // Keep the unsupported blocks present: the app must render its gate before
    // mounting each body, rather than silently losing the user's saved layout.
    await page.evaluate(async types => {
        const { saveWorkspace, GRID_COLS } = await import('/src/lib/workspace.ts');
        saveWorkspace({ blocks: types.map(type => ({ id: 'qa-unavailable-' + type, type, pin: '2330' })),
            layout: types.map((type, index) => ({ i: 'qa-unavailable-' + type, x: 0, y: index * 7, w: GRID_COLS, h: 7 })) });
    }, unavailableTypes);
    const restoreStart = apiRequests.length;
    // Force the previously confirmed startup race instead of depending on the
    // relative speed of the bundle and localhost /info response.
    delayServerInfo = true;
    await page.reload();
    await expect(page.getByRole('button', { name: '交易模式設定', exact: true })).toBeVisible({ timeout: 30000 });
    await exposeApi();
    for (const { type } of metadata) {
        const scope = panel('qa-unavailable-' + type); await scope.scrollIntoViewIfNeeded();
        await expect(scope.locator(`[data-panel-unavailable="${type}"]`)).toContainText('未支援：');
    }
    await frame();
    expect((await workspace()).blocks.map(block => block.type)).toEqual(unavailableTypes);
    const restoredRequests = apiRequests.slice(restoreStart);
    delayServerInfo = false;
    expect(restoredRequests.filter(row => unavailableRoutes.test(row.path))).toEqual([]);
    expect(restoredRequests.filter(row => row.path === '/api/v1/stream/subscribe' && row.body?.intraday_odd)).toEqual([]);
    expect(restoredRequests.filter(row => row.path === '/api/v1/stream/subscribe' && row.body?.security_type === 'OPT')).toEqual([]);
    await panel('qa-unavailable-warrants').screenshot({ path: path.join(artifacts, 'disabled-restored-placeholder.png'), animations: 'disabled' });
    results.push({ check: 'restored-unavailable-panels-preserved-gated-no-unsupported-api', types: unavailableTypes, requests: restoredRequests });
    await page.evaluate(async saved => (await import('/src/lib/workspace.ts')).saveWorkspace(saved), original);
    await page.reload();
    await expect(page.getByRole('button', { name: '交易模式設定', exact: true })).toBeVisible({ timeout: 30000 });
    await exposeApi();
}

const nativeOperations={fuboncredit:['credit_margin','credit_daytrade'],fubonaccount:['settlements','realized','close_records','maintenance'],fuboncondition:['conditions','conditions','trails','conditions'],fubonownership:['institutional','director','etf','tdcc'],fuboncorporate:['dividends','capital','listings'],fubontechnical:['sma','rsi','macd','kdj','bb','stats'],fubonhistory:['daily','option_candles'],fubonindices:['indices','index_quote'],fubonadvanced:['order_history','batch_lists','order_history']};
const nativeActions={fuboncondition:['condition_create','condition_tpsl','trail_create','condition_create'],fubonadvanced:['dualleg_place','batch_place']};
function dayOffset(n){return new Date(Date.parse(taipeiToday+'T00:00:00Z')+n*86400_000).toISOString().slice(0,10);}
const nativeScope=type=>panel(nativeIds[type]).locator(`[data-api-panel="${type}"]`);
async function nativeFields(scope,type,tab){
 const account=scope.getByLabel('券商查詢帳戶');
 if(['fuboncredit','fubonaccount','fuboncondition','fubonadvanced'].includes(type))expect(await account.count()).toBe(1);
 if(await account.count()){await expect(account).toContainText('NATIVE-',{timeout:20000});await account.selectOption('0');expect(await account.locator('option:checked').innerText()).toContain('NATIVE-');}
 for(const input of await scope.locator('input').all()){
  const label=await input.evaluate(node=>[...node.closest('label').childNodes].filter(child=>child.nodeType===Node.TEXT_NODE).map(child=>child.textContent).join('').trim());
  const kind=await input.getAttribute('type');let value;
  if(kind==='date')value=label==='有效開始日'?taipeiToday:label==='有效日期'?dayOffset(1):label==='開始日期'?dayOffset(-1):taipeiToday;
  else if(kind==='number')value=({'快線週期':'12','慢線週期':'26','信號線週期':'9','RSV 週期':'9','K 週期':'3','D 週期':'3','計算週期':'20','履約價':'40000','共同口數':'1','口數':'1','股數':'1000','數量（股）':'1000','加減檔數':'0','追蹤距離（%）':'5','停損觸發價':'90','停利觸發價':'110','門檻':'100'})[label]??'100';
  else value=({'股票代號':type==='fuboncorporate'&&tab===1?'0050':'2330','ETF 代號':'0050','商品代號':tab===0?'TXF':'TXO','具體月份契約':'TMFK6','指數代號':'IX0001','契約月份':taipeiToday.slice(0,7).replace('-',''),'第一腳契約':'TXFK6','第二腳契約':'TXFL6','條件單號':'QA-GUID','批次序號':'QA-BATCH-1','名稱或代碼':''})[label]??'';
  await input.fill(value);
 }
 if(type==='fubonhistory'&&tab===0)await scope.getByLabel('盤別').selectOption({label:'夜盤'});
}
async function nativeQuery(scope,operation,status=200,button){
 const waiting=page.waitForResponse(response=>{if(new URL(response.url()).pathname!=='/api/v1/native/query')return false;try{return response.request().postDataJSON().operation===operation;}catch{return false;}});
 await (button??scope.getByRole('button',{name:/^(查詢資料|查詢券商紀錄)$/})).click();
 const response=await waiting,payload=await response.json();expect(response.status(),operation+': '+JSON.stringify(payload)).toBe(status);
 if(status===200){expect(payload.operation).toBe(operation);expect(payload.source).toBe('fubon');await expect(scope.getByRole('region',{name:'富邦查詢結果',exact:true})).toBeVisible();}
 return payload;
}
async function nativeQueryChecks(){
 const metadata=await page.evaluate(async types=>{const {BLOCK_META}=await import('/src/lib/workspace.ts');return types.map(type=>({type,label:BLOCK_META[type].label}));},newPanelTypes);
 for(const {type,label}of metadata)nativeIds[type]=await addPanel(label,type);
 await page.evaluate(async ids=>{const m=await import('/src/lib/workspace.ts'),w=m.loadWorkspace(),keep=new Set(Object.values(ids));m.saveWorkspace({...w,blocks:w.blocks.filter(b=>keep.has(b.id)),layout:w.layout.filter(l=>keep.has(l.i))});},nativeIds);
 await page.reload();await expect(nativeScope('fuboncredit')).toBeVisible({timeout:30000});await exposeApi();
 const trading=await page.evaluate(()=>window.qaPanels.api.fetchAccounts());expect(trading.every(a=>a.broker_id==='LOCAL')).toBe(true);
 const native=await page.evaluate(async()=> (await fetch('/api/v1/native/accounts')).json());expect(native.map(a=>a.account_id).sort()).toEqual(['NATIVE-F','NATIVE-S']);
 results.push({check:'native-read-accounts-distinct-from-local-paper-trading',trading,native});
 for(const {type,label}of metadata){
  const scope=nativeScope(type),nav=scope.getByRole('navigation',{name:label+'功能',exact:true}),tabs=await nav.getByRole('button').allTextContents();
  expect(tabs.length).toBe(nativeOperations[type].length);
  for(let tab=0;tab<tabs.length;tab++){
   await nav.getByRole('button',{name:tabs[tab],exact:true}).click();await nativeFields(scope,type,tab);
   const operation=nativeOperations[type][tab],payload=await nativeQuery(scope,operation),view=scope.getByRole('region',{name:'富邦查詢結果',exact:true});
   expect(payload.rows.length,operation+' native rows').toBeGreaterThan(0);
   if(operation==='credit_margin'){await expect(view).toContainText('無上限');await expect(view).toContainText('停券');expect(payload.rows[0].margin_tradable_quota).toBe(0);}
   if(operation==='credit_daytrade')await expect(view).toContainText('不需預收');
   if(operation==='settlements'){expect(payload.rows[0].buy_settlement).toBe(0);expect(payload.rows[0].sell_settlement).toBeNull();await expect(view).toContainText('—');}
   if(operation==='realized')expect(payload.rows[0].filled_qty).toBe(500);
   if(operation==='close_records'){expect(payload.rows[0].orig_lots).toBe(2);expect(payload.rows[0]).not.toHaveProperty('pnl');}
   if(['conditions','trails'].includes(operation)){expect(payload.rows[0].parent_guid).toBeNull();await expect(view).toContainText('未生效(W)');await view.locator('summary').first().click();await expect(view.locator('pre').first()).toContainText('QA-CHILD');}
   if(operation==='etf'){expect(payload.rows[0].components[0].weight).toBe(58.82);expect(payload.rows[0].components[0].quantityChange).toBeNull();}
   if(operation==='tdcc')expect(payload.rows[0].distributions[0].proportion).toBe(84.67);
   if(['sma','rsi','macd','kdj','bb'].includes(operation)){expect(Object.values(payload.rows[0]).some(value=>value===null)).toBe(true);await expect(view.getByRole('img',{name:'富邦來源資料走勢'})).toBeVisible();}
   if(['daily','option_candles'].includes(operation)){expect(payload.rows[0].volume).toBe(0);expect(Object.hasOwn(payload.rows[0],'open')?payload.rows[0].open:payload.rows[0].openPrice).toBeNull();}
   if(nativeActions[type]?.[tab]){
    await expect(scope.getByRole('button',{name:'核對券商送出內容',exact:true})).toBeDisabled();
    const waiting=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/v1/native/draft/validate');
    await scope.getByRole('button',{name:'檢核草稿',exact:true}).click();const response=await waiting,checked=await response.json();
    if(response.status()!==200)draftFailures.push({type,tab,operation:nativeActions[type][tab],status:response.status(),checked});
    else expect(checked.submitted).toBe(false);
    if(type==='fuboncondition')await expect(scope.getByRole('button',{name:'核對取消條件單',exact:true})).toBeDisabled();
    results.push({check:'paper-native-write-disabled-draft-validated',type,tab,operation:nativeActions[type][tab],checked});
   }
   await scope.screenshot({path:path.join(artifacts,`${type}-${tab}-1600.png`),animations:'disabled'});
   results.push({check:'actual-native-tab-query',type,tab,title:tabs[tab],payload});
  }
 }
 await page.setViewportSize({width:390,height:844});
 for(const {type}of metadata){const scope=nativeScope(type);await scope.scrollIntoViewIfNeeded();const geometry=await scope.evaluate(n=>({client:n.clientWidth,scroll:n.scrollWidth}));expect(geometry.scroll,type+' narrow overflow').toBeLessThanOrEqual(geometry.client+1);await scope.screenshot({path:path.join(artifacts,`${type}-390.png`),animations:'disabled'});results.push({check:'native-panel-narrow-layout',type,geometry});}
 await page.setViewportSize({width:1600,height:1100});
}
async function nativeErrorChecks(){
 const scope=nativeScope('fubontechnical');await scope.getByRole('button',{name:'SMA',exact:true}).click();await nativeFields(scope,'fubontechnical',0);
 let payload=await nativeQuery(scope,'sma');expect(payload.metadata.symbol).toBe('2330');
 await scope.getByLabel('股票代號',{exact:true}).fill('2454');payload=await nativeQuery(scope,'sma');expect(payload.metadata.symbol).toBe('2454');expect(payload.rows.at(-1).sma).toBe(201.25);await expect(scope.getByRole('cell',{name:'201.25',exact:true})).toBeVisible();
 await qa({fail:'technical.sma'});await scope.getByLabel('股票代號',{exact:true}).fill('9999');const error=await nativeQuery(scope,'sma',502);expect(JSON.stringify(error)).not.toContain('QA-private-token');await expect(scope.getByRole('alert')).toContainText(/502|富邦服務請求失敗/);expect(await scope.innerText()).not.toContain('QA-private-token');
 await scope.getByLabel('股票代號',{exact:true}).fill('2330');await nativeQuery(scope,'sma');await expect(scope.getByRole('alert')).toHaveCount(0);
 results.push({check:'different-symbol-results-and-bounded-sanitized-error-recovery'});
}
async function nativeIndexChecks(){
 const scope=nativeScope('fubonindices');await scope.getByRole('button',{name:'指數清單',exact:true}).click();await nativeFields(scope,'fubonindices',0);await nativeQuery(scope,'indices');await scope.getByRole('button',{name:'查看指數',exact:true}).first().click();await expect(scope.getByLabel('指數代號',{exact:true})).toHaveValue('IX0001');await nativeQuery(scope,'index_quote');
 const before=await qa(),indexCalls=value=>value.calls.filter(c=>c.method==='ws.subscribe'&&c.params.channel==='indices').length;
 await scope.getByRole('button',{name:'訂閱指數',exact:true}).click();const live=scope.getByRole('region',{name:'最新指數事件',exact:true});await expect(live).toContainText('41,123.5');await qa({price:41234.5});await expect(live).toContainText('41,234.5');
 const secondId=await addPanel('富邦指數行情','fubonindices'),second=panel(secondId).locator('[data-api-panel]');await second.getByRole('button',{name:'即時指數',exact:true}).click();await second.getByLabel('指數代號',{exact:true}).fill('IX0001');await second.getByRole('button',{name:'訂閱指數',exact:true}).click();await expect.poll(async()=>Object.keys((await qa()).leases).length).toBe(2);expect(indexCalls(await qa())-indexCalls(before)).toBe(1);
 await scope.getByRole('button',{name:'停止訂閱',exact:true}).click();await expect.poll(async()=>Object.keys((await qa()).leases).length).toBe(1);await qa({price:41333.25});await expect(second.getByRole('region',{name:'最新指數事件',exact:true})).toContainText('41,333.25');await expect(live).toHaveCount(0);
 const prior=indexCalls(await qa());await qa({disconnect:true});await page.clock.runFor(30005);await expect.poll(async()=>indexCalls(await qa()),{timeout:10000}).toBe(prior+1);await qa({price:41444.5});await expect(second.getByRole('region',{name:'最新指數事件',exact:true})).toContainText('41,444.5');
 await second.getByRole('button',{name:'停止訂閱',exact:true}).click();await expect.poll(async()=>Object.keys((await qa()).leases).length).toBe(0);await qa({price:41555});await expect(second.getByRole('region',{name:'最新指數事件',exact:true})).toHaveCount(0);
 results.push({check:'native-index-ack-sse-shared-lease-stop-and-reconnect-renew',final:await qa()});
}
async function nativePrivacyChecks(){
 const scope=nativeScope('fubonaccount');await scope.getByRole('button',{name:'證券已實現',exact:true}).click();await nativeFields(scope,'fubonaccount',1);await nativeQuery(scope,'realized');
 const view=scope.getByRole('region',{name:'富邦查詢結果',exact:true});await expect(view.getByRole('cell',{name:'500',exact:true})).toBeVisible();
 async function toggle(on){await page.getByRole('button',{name:'設定',exact:true}).click();const settings=page.getByRole('dialog',{name:'設定',exact:true});await settings.getByRole('tab',{name:'音效與隱私',exact:true}).click();for(const name of ['帳號遮蔽','金額遮蔽']){const control=settings.getByRole('switch',{name,exact:true});if(await control.getAttribute('aria-checked')!==String(on))await control.click();await expect(control).toHaveAttribute('aria-checked',String(on));}await page.keyboard.press('Escape');await expect(settings).toBeHidden();}
 await toggle(true);expect(await scope.getByLabel('券商查詢帳戶').locator('option:checked').innerText()).not.toContain('NATIVE-S');await expect(view.getByRole('cell',{name:'500',exact:true})).toHaveCount(0);await expect(view).toContainText('•••••');await scope.screenshot({path:path.join(artifacts,'native-account-privacy-money.png'),animations:'disabled'});
 await toggle(false);await expect(view.getByRole('cell',{name:'500',exact:true})).toBeVisible();results.push({check:'actual-settings-privacy-account-and-money-toggle-on-native-results'});
}
async function chipsAndHistoryChecks(){
 await selectGlobal('2330','2330');
 const id=await addPanel('籌碼資訊','chips'),card=panel(id),chip=card.locator('[data-api-panel="fubonownership"]');
 await expect(chip.getByLabel('股票代號',{exact:true})).toHaveValue('2330');
 let result=await nativeQuery(chip,'institutional');expect(result.metadata.symbol).toBe('2330');
 results.push({check:'chips-actual-stock-initial-symbol-native-query',symbol:'2330'});
 await chip.getByLabel('股票代號',{exact:true}).fill('2303');
 await selectGlobal('2454','2454');await expect(header(id)).toContainText('2454');
 await expect(chip.getByLabel('股票代號',{exact:true})).toHaveValue('2454');
 await expect(chip.getByRole('region',{name:'富邦查詢結果',exact:true})).toHaveCount(0);
 result=await nativeQuery(chip,'institutional');expect(result.metadata.symbol).toBe('2454');
 results.push({check:'chips-global-stock-switch-resets-edited-symbol-and-old-result',symbol:'2454'});
 await chip.getByRole('button',{name:'ETF 成分',exact:true}).click();
 await expect(chip.getByLabel('ETF 代號',{exact:true})).toHaveValue('0050');
 result=await nativeQuery(chip,'etf');expect(result.metadata.symbol).toBe('0050');
 results.push({check:'chips-etf-tab-default-remains-independent-0050'});
 for(const [code,stock]of [['CDFK6','2330'],['DVFK6','2454']]){
  await selectGlobal(code,code);await expect(header(id)).toContainText(code);
  await expect(chip.getByLabel('股票代號',{exact:true})).toHaveValue(stock);
  const info=await page.evaluate(code=>window.qaPanels.api.fetchContractInfo(code,'FUT'),code);
  expect(info).toMatchObject({underlying_kind:'S',underlying_code:stock});
  result=await nativeQuery(chip,'institutional');expect(result.metadata.symbol).toBe(stock);
  results.push({check:'chips-stock-future-uses-actual-broker-product-underlying',code,stock,info});
 }
 for(const code of ['TXFK6','IYFK6','SYFK6']){
  const before=apiRequests.filter(r=>r.path==='/api/v1/native/query').length;
  await selectGlobal(code,code);await expect(header(id)).toContainText(code);
  await expect(card).toContainText('請選擇股票或具有股票標的的期貨');await expect(chip).toHaveCount(0);await frame();
  expect(apiRequests.filter(r=>r.path==='/api/v1/native/query').length).toBe(before);
  results.push({check:'chips-non-stock-or-invalid-underlying-never-queries',code});
 }
 const history=nativeScope('fubonhistory');await history.getByRole('button',{name:'選擇權歷史 K',exact:true}).click();await nativeFields(history,'fubonhistory',1);
 await history.getByLabel('盤別').selectOption({label:'夜盤'});await history.getByLabel('K 線週期').selectOption({label:'5 分 K'});await history.getByLabel('買賣權').selectOption({label:'賣權 P'});
 const before=(await qa()).calls.length;await nativeQuery(history,'option_candles');
 const calls=(await qa()).calls.slice(before).filter(c=>c.method==='historical.candles');
 expect(calls).toHaveLength(1);expect(calls[0].params).toMatchObject({product:'TXO',contractMonth:taipeiToday.slice(0,7).replace('-',''),strikePrice:40000,callPut:'PUT',session:'afterhours',timeframe:'5'});
 await history.screenshot({path:path.join(artifacts,'history-options-night-five-minute.png'),animations:'disabled'});
 expect(apiRequests.filter(r=>/\/data\/(credit_enquire|short_stock_sources|regulatory_punish)/.test(r.path))).toEqual([]);
 results.push({check:'option-history-night-timeframe-right-reach-native-vendor',calls});
}
try {
    await free(uiPort); await free(apiPort);
    const backend=path.join(temporary,"backend.py");
    await writeFile(backend,`import json,os,socket,sys,threading,runpy,time
from pathlib import Path
from copy import deepcopy
from datetime import timedelta
from types import SimpleNamespace as NS,ModuleType
import fubon_bridge.__main__ as entry
import fubon_bridge.app as app_module
from fubon_bridge.app import create_app as real_create_app
from fubon_bridge.config import Config
from fubon_bridge.keychain import Keychain
from fubon_bridge.passkeys import PasskeyStore
from fubon_bridge.research import ResearchStore
from fubon_bridge.mapping import now
root=Path(os.environ['PANEL_TEMP']);(root/'server').mkdir()
repo=Path(${JSON.stringify(root)})
counts=dict(sdkCalls=0,sdkTransactions=0,keychainCalls=0,outboundCalls=0,sdkWrites=0,dtoCalls=0,sdkReads=0,marketCalls=0,wsConnect=0,wsSubscribe=0,wsUnsubscribe=0)
calls=[];lock=threading.RLock();control={};today=now().date();day=today.isoformat()
def count(key,method=None,params=None):
    with lock:
        counts[key]+=1
        if method:calls.append(dict(method=method,params=params or {}))
def forbidden(key):
    def no(*a,**kw):count(key);raise AssertionError('QA forbids '+key)
    return no
no_sdk=forbidden('sdkCalls');Keychain.read=forbidden('keychainCalls')
socket.socket.connect=forbidden('outboundCalls');socket.socket.connect_ex=forbidden('outboundCalls')
sdk_module=ModuleType('fubon_neo.sdk');sdk_module.FubonSDK=no_sdk;sys.modules['fubon_neo.sdk']=sdk_module
examples=runpy.run_path(str(repo/'server/tests/test_native_panel_market.py'))
futures=json.loads((repo/'server/tests/fixtures/future-search-2026-11-17.json').read_text())
for symbol,kind,underlying in [('IYF','I','2330'),('SYF','S','IX0001')]:
    futures['products'].append(dict(symbol=symbol,type='FUTURE',contractType=kind,underlyingSymbol=underlying,contractSize=1,tradingCurrency='TWD',name='Synthetic negative relationship '+symbol))
    futures['tickers'].append(dict(symbol=symbol+'K6',type='FUTURE',contractType=kind,name='Synthetic negative contract '+symbol,referencePrice=100,settlementDate=(today+timedelta(days=10)).isoformat(),limitUpPrice=110,limitDownPrice=90))
stocks=[dict(symbol=code,name=name,referencePrice=price,market='TSE',limitUpPrice=price*1.1,limitDownPrice=price*.9) for code,name,price in [('2330','台積電',100),('2454','聯發科',200),('2303','聯電',50),('1802','台玻',20)]]
def fresh(value):
    if isinstance(value,list):return [fresh(x) for x in value]
    if isinstance(value,dict):
        return {k:(day if k in {'date','exDividendDate','applicationDate','effectiveDate'} and isinstance(v,str) and len(v)==10 else day[:7] if k=='date' and isinstance(v,str) and len(v)==7 else fresh(v)) for k,v in value.items()}
    return value
def ok(value):return NS(is_success=True,data=value,message=None)
def read_payload(method,args,kw):
    symbol=args[1] if len(args)>1 and isinstance(args[1],str) else '2330'
    if method=='margin_quota':return NS(stock_no=symbol,margin_orig_quota=None,margin_tradable_quota=0 if symbol=='2330' else 1000,shortsell_orig_quota=0,shortsell_tradable_quota=0,margin_ratio=60,short_ratio=None)
    if method=='daytrade_and_stock_info':return NS(stock_no=symbol,daytrade_orig_quota=0,daytrade_tradable_quota=0,precollect_single=None,precollect_accumulate=None,status=15,disposition_status='QA-public-shape')
    if method=='query_settlement':return NS(details=[NS(date=day,settlement_date=(today+timedelta(days=2)).isoformat(),buy_settlement=0,sell_settlement=None,total_settlement_amount=None,currency='TWD')])
    if method=='realized_gains_and_loses':return [NS(date=day,stock_no='2330',filled_qty=500,filled_price=100,realized_profit=30,realized_loss=0)]
    if method=='maintenance':return NS(date=day,maintenance_summary=NS(maintenance_ratio=200,margin_value=1000,shortsell_value=0,collateral=None),maintenance_detail=[NS(stock_no='2330',quantity=1000,maintenance_ratio=200,margin_interest=None)])
    if method=='close_position_record':return [NS(date=day,symbol='FITX',orig_lots=2,price=40000,transaction_fee=40,tax=20,strike_price=None,call_put=None)]
    if method=='batch_order_lists':return [NS(function_type=0,date=day,branch_no='QA-S',account='NATIVE-S',batch_seq_no='QA-BATCH-1')]
    if method=='batch_order_detail':return [NS(order_no='QA-BATCH-ORDER',status=90,error_message='fixture-native-per-order-rejection')]
    if method=='order_history':return [NS(order_no='QA-ORDER',symbol='2330',quantity=1000,filled_qty=0,price=100,status=10,details=[dict(function_type=15,before_qty=1000,after_qty=1000)])]
    return [NS(guid='QA-GUID',status='未生效(W)',condition_price='100元(ROD)',condition_volume='1張',parent_guid=None,detail_records=[dict(guid='QA-CHILD',condition_volume='1張',error_message=None)])]
reads={'stock':{'margin_quota','daytrade_and_stock_info','get_condition_order','get_condition_history','get_condition_order_by_id','get_trail_order','get_trail_history','order_history','batch_order_lists','batch_order_detail'},'futopt':{'get_condition_order','get_condition_history','get_condition_order_by_id','get_trail_order','get_trail_history','order_history'},'accounting':{'query_settlement','realized_gains_and_loses','maintenance'},'futopt_accounting':{'close_position_record'}}
class ReadGroup:
    def __init__(self,name):self.name=name
    def __getattr__(self,method):
        if method in {'place_order','batch_place_order','multi_condition','trail_profit','cancel_condition_orders'}:return forbidden('sdkWrites')
        if method not in reads[self.name]:count('sdkTransactions');raise AssertionError('Unapproved SDK method '+method)
        def call(*args,**kw):
            count('sdkReads',self.name+'.'+method,dict(args=[getattr(x,'marker',str(x)) for x in args],kwargs=kw))
            return ok(read_payload(method,args,kw))
        return call
market_map={('ownership','institutional_trades'):'INSTITUTIONAL',('ownership','director_holdings'):'DIRECTOR',('ownership','etf_holdings'):'ETF',('ownership','tdcc_distribution'):'TDCC',('corporate_actions','dividends'):'DIVIDENDS',('corporate_actions','capital_changes'):'CAPITAL',('corporate_actions','listing_applicants'):'LISTINGS',('historical','stats'):'STATS',('historical','daily'):'DAILY'}
class MarketGroup:
    def __init__(self,namespace):self.namespace=namespace
    def __getattr__(self,method):
        def call(**kw):
            count('marketCalls',self.namespace+'.'+method,kw)
            if control.get('fail')==self.namespace+'.'+method:
                control.pop('fail');raise RuntimeError('QA-private-token-must-never-reach-browser')
            if self.namespace=='technical':
                symbol=kw.get('symbol');value=101.25 if symbol=='2330' else 201.25
                values={'sma':dict(sma=value),'rsi':dict(rsi=56.2),'macd':dict(macdLine=2.1,signalLine=1.5),'kdj':dict(k=50,d=45,j=60),'bb':dict(upper=120,middle=110,lower=100)}[method]
                return dict(symbol=symbol,timeframe=kw.get('timeframe','D'),data=[dict(date=(today-timedelta(days=1)).isoformat(),**{k:None for k in values}),dict(date=day,**values)])
            if (self.namespace,method) in market_map:
                payload=fresh(deepcopy(examples[market_map[(self.namespace,method)]]))
                if kw.get('symbol'):payload['symbol']=kw['symbol']
                if self.namespace=='corporate_actions':payload.update(start_date=kw['start_date'],end_date=kw['end_date'])
                if method=='daily':
                    payload['session']=kw.get('session','regular').upper()
                    for row in payload['data']:row['contractMonth']=kw.get('contractMonth') or day[:7].replace('-','')
                return payload
            if self.namespace=='historical' and method=='candles':
                if kw.get('strikePrice'):
                    value=fresh(deepcopy(examples['OPTION_CANDLES']));value['contractMonth']=kw.get('contractMonth')
                    for row in value['data']:row['contractMonth']=kw.get('contractMonth')
                    return value
                return dict(data=[])
            count('sdkTransactions');raise AssertionError('Unapproved market fixture '+self.namespace+'.'+method)
        return call
class Market:
    def __init__(self,stock=False):
        self.stock=stock;self.intraday=self
        for namespace in ('ownership','corporate_actions','technical','historical'):setattr(self,namespace,MarketGroup(namespace))
    def products(self,**kw):count('marketCalls','products',kw);return dict(data=deepcopy(futures['products']))
    def tickers(self,**kw):
        count('marketCalls','tickers',kw)
        if kw.get('type')=='INDEX':return dict(date=day,type='INDEX',data=[dict(symbol='IX0001',name='發行量加權股價指數'),dict(symbol='IX0043',name='櫃買指數')])
        return dict(date=day,data=deepcopy([x for x in stocks if x['market']==kw.get('market')] if self.stock else futures['tickers']))
    def ticker(self,symbol,**kw):
        count('marketCalls','ticker',dict(symbol=symbol,**kw))
        if symbol.startswith('IX'):return dict(type='INDEX',symbol=symbol,name='原生QA指數',previousClose=41000,date=day)
        rows=stocks if self.stock else futures['tickers'];row=next((r for r in rows if r['symbol']==symbol),None)
        if row is None and symbol.endswith('!'):row=next((r for r in rows if r['symbol'].startswith(symbol[:-2])),None)
        if row is None:raise ValueError('Unknown fixture symbol '+symbol)
        return deepcopy(row)
    def quote(self,symbol,**kw):
        count('marketCalls','quote',dict(symbol=symbol,**kw))
        if symbol.startswith('IX'):return dict(type='INDEX',symbol=symbol,lastPrice=41100.25,change=60.17,lastUpdated=int(now().timestamp()*1e6),date=day)
        row=self.ticker(symbol);p=row['referencePrice'];at=int(now().timestamp()*1e6)
        return dict(symbol=row['symbol'],exchange='TWSE' if self.stock else 'TAIFEX',previousClose=p,lastUpdated=at,lastTrade=dict(time=at,price=p,bid=p-1,ask=p+1,size=1),openPrice=p,highPrice=p+1,lowPrice=p-1,total=dict(tradeVolume=1000))
    def candles(self,**kw):return dict(data=[])
    def trades(self,**kw):return dict(date=day,data=[])
class Socket:
    def __init__(self):self.handlers={};self.ids={};self.serial=0
    def on(self,event,callback):self.handlers.setdefault(event,[]).append(callback)
    def emit(self,event,value=None):
        for callback in list(self.handlers.get(event,[])):callback(value)
    def connect(self):count('wsConnect')
    def subscribe(self,params):
        count('wsSubscribe','ws.subscribe',params)
        if params.get('channel')=='indices':
            self.serial+=1;ident='qa-index-'+str(self.serial);symbol=params['symbol'];self.ids[ident]=symbol
            def ack():
                self.emit('message',dict(event='subscribed',data=dict(channel='indices',symbol=symbol,id=ident)))
                self.emit('message',dict(event='snapshot',channel='indices',data=dict(symbol=symbol,price=41123.5,amount=None)))
            timer=threading.Timer(.03,ack);timer.daemon=True;timer.start()
    def unsubscribe(self,params):count('wsUnsubscribe','ws.unsubscribe',params);self.ids.pop(params['id'],None)
    def disconnect(self):self.ids.clear();self.emit('disconnect')
class LocalSDK:
    def __init__(self):
        self.marketdata=NS(rest_client=NS(stock=Market(True),futopt=Market()),websocket_client=NS(stock=Socket(),futopt=Socket()))
        for name in reads:setattr(self,name,ReadGroup(name))
    def shutdown(self):pass
    def __getattr__(self,key):count('sdkTransactions');raise AssertionError('Unapproved SDK access '+key)
class NoCredentials:
    def available(self):return False
entry.ROOT=root;app_module.ROOT=root;Config.from_env=classmethod(lambda cls:Config(mode='paper',port=int(os.environ['PANEL_API_PORT'])))
def create_app(config,**kwargs):
    kwargs['launch_token']=os.environ['PANEL_LAUNCH']
    assert kwargs['watchlist_store'].path==root/'server'/'.watchlists.json','QA watchlists must stay temporary'
    app=real_create_app(config,sdk_factory=no_sdk,passkey_store=PasskeyStore(root/'passkeys.sqlite3'),research_store=ResearchStore(root/'research.sqlite3'),credential_store=NoCredentials(),**kwargs)
    broker=app.state.broker;native=app.state.native_panels
    def dto(kind,group,value):
        if kind=='dto':count('dtoCalls');raise AssertionError('Paper must not construct write DTOs')
        return group+'.'+value
    native.dto_loader=dto
    def connect():
        broker.sdk=LocalSDK();broker.error=None
        broker.accounts_raw={('S','QA-S','NATIVE-S'):NS(marker='raw-native-s'),('F','QA-F','NATIVE-F'):NS(marker='raw-native-f')}
    broker.connect=connect
    @app.post('/api/v1/qa/native-panels')
    def qa(body:dict):
        if body.get('fail'):control['fail']=body['fail']
        stock=broker.sockets.get('stock')
        if body.get('disconnect') and stock:stock.disconnect()
        if 'price' in body and stock:stock.emit('message',dict(event='data',channel='indices',data=dict(symbol='IX0001',price=body['price'],amount=None)))
        return dict(counts=deepcopy(counts),calls=deepcopy(calls),ledger=broker.paper.overview(),leases=deepcopy(native.leases),index_ids=deepcopy(native.index_ids))
    app.router.routes.insert(0,app.router.routes.pop());return app
entry.create_app=create_app;sys.argv=['fixture','--ui-url',os.environ['PANEL_ORIGIN'],'--no-browser'];entry.main()
`);
    const viteFile = path.join(temporary, 'vite.mjs');
    await writeFile(viteFile, `import{createServer,loadConfigFromFile}from ${JSON.stringify(path.join(root, 'node_modules/vite/dist/node/index.js'))};
globalThis.fetch=async()=>{throw new Error('QA forbids metadata upstream');};
const loaded=await loadConfigFromFile({command:'serve',mode:'development'},${JSON.stringify(path.join(root, 'vite.config.ts'))},process.cwd());
process.chdir(${JSON.stringify(root)});
const server=await createServer({...loaded.config,configFile:false,root:${JSON.stringify(root)},envDir:${JSON.stringify(temporary)},cacheDir:${JSON.stringify(path.join(temporary, 'vite-cache'))},server:{...loaded.config.server,host:'127.0.0.1',port:${uiPort},strictPort:true,fs:{...loaded.config.server.fs,allow:[...loaded.config.server.fs.allow,${JSON.stringify(root)},${JSON.stringify(await realpath(path.join(root, 'node_modules')))}]}}});await server.listen();`);
    run(path.join(root, 'server/.venv/bin/python'), [backend], { PYTHONPATH: path.join(root, 'server'), PANEL_TEMP: temporary, PANEL_API_PORT: String(apiPort), PANEL_ORIGIN: origin, PANEL_LAUNCH: launch });
    run(process.execPath, [viteFile], { VITE_API_TARGET: `http://127.0.0.1:${apiPort}`, VITE_API_BASE: '', VITE_STREAM_BASE: origin, VITE_DEV_SERVER_PORT: '' });
    await ready(`http://127.0.0.1:${apiPort}/api/v1/passkeys/status`); await ready(origin);
    browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true });
    const context = await browser.newContext({ viewport: { width: 1600, height: 1100 } });
    await context.route('**/*', async route => {
        const request = route.request(), url = new URL(request.url());
        if (url.origin === origin && /^\/api\/v1\/(order\/(place|cancel|update|reserve)|automation\/start|native\/action)/.test(url.pathname)) {
            mutations.push({ method: request.method(), path: url.pathname }); return route.abort('blockedbyclient');
        }
        if (url.origin === origin && url.pathname.startsWith('/metadata/')) {
            const payload = /(?:tse|otc)-companies$/.test(url.pathname) ? stocks.map(row => ({ 公司代號: row.symbol, 公司簡稱: row.name, 公司名稱: row.name + 'QA股份有限公司', 出表日期: '1151117' })) : [];
            return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(payload) });
        }
        if (url.origin === origin && url.pathname === '/api/v1/info' && delayServerInfo) await new Promise(resolve => setTimeout(resolve, 500));
        if (url.origin === origin) return route.continue();
        blocked.push(url.origin + url.pathname); return route.abort('blockedbyclient');
    });
    page = await context.newPage(); await page.clock.install(); page.on('pageerror', error => pageErrors.push(error.message));
    page.on('request', request => { const url = new URL(request.url());
        if (url.pathname.startsWith('/api/v1/')) {
            let body = null; try { body = request.postDataJSON(); } catch { /* non-JSON request */ }
            apiRequests.push({ method: request.method(), path: url.pathname, query: url.search, body });
        }
        if (url.pathname.startsWith('/api/v1/watchlist') && ['POST', 'PUT', 'DELETE'].includes(request.method())) watchlistMutations.push({ method: request.method(), path: url.pathname });
    });
    page.on('response', response => { const url = new URL(response.url());
        if (url.pathname.startsWith('/src/') && response.status() >= 400) sourceErrors.push({ path: url.pathname, status: response.status() });
        if (url.pathname.startsWith('/api/v1/native/')) responses.push({path:url.pathname,status:response.status()});
        if (/^\/api\/v1\/data\/(scanner|volumes|contracts\/options)/.test(url.pathname)) responses.push({ path: url.pathname + url.search, status: response.status() });
    });
    const cdp = await context.newCDPSession(page); await cdp.send('WebAuthn.enable');
    await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true,
        hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
    await page.goto(origin + '/#fubon-launch=' + launch);
    await page.getByRole('button', { name: '建立 Passkey 並解鎖', exact: true }).click();
    await expect(page.getByRole('button', { name: '交易模式設定', exact: true })).toBeVisible({ timeout: 30000 });
    await exposeApi();
    await expect(page.locator('[data-code="2330"]')).toBeVisible({ timeout: 20000 });
    await unavailablePanelChecks();
    await nativeQueryChecks(); await nativeErrorChecks(); await nativeIndexChecks(); await nativePrivacyChecks(); await chipsAndHistoryChecks();
    expect(draftFailures,'Native draft validations must all succeed').toEqual([]);
    const final=await qa();
    for(const key of ['sdkCalls','sdkTransactions','keychainCalls','outboundCalls','sdkWrites','dtoCalls'])expect(final.counts[key],key).toBe(0);
    expect(final.counts.sdkReads).toBeGreaterThan(0);expect(final.counts.marketCalls).toBeGreaterThan(0);
    expect(final.ledger.orders).toEqual([]);expect(final.ledger.positions).toEqual([]);
    expect(final.leases).toEqual({});expect(mutations).toEqual([]);expect(watchlistMutations).toEqual([]);
    expect(pageErrors).toEqual([]);expect(sourceErrors).toEqual([]);
    expect(responses.filter(r=>r.path.startsWith('/api/v1/native/')&&r.status===501)).toEqual([]);
    expect(blocked.filter(url=>url!=='https://fonts.googleapis.com/css2')).toEqual([]);
    await writeFile(path.join(artifacts,'summary.json'),JSON.stringify({passed:true,results,final,apiRequests,responses,sourceErrors,pageErrors,mutations,watchlistMutations,blocked,temporary,fixture},null,2));
    console.log(JSON.stringify({passed:true,checks:results.length,counts:final.counts,artifacts,temporary},null,2));
} catch (error) {
    const diagnostic = await qa().catch(() => undefined);
    await writeFile(path.join(artifacts, 'failure.log'), childLogs);
    await writeFile(path.join(artifacts, 'summary.json'), JSON.stringify({ passed: false, error: String(error), diagnostic, draftFailures, results, responses, apiRequests, sourceErrors, pageErrors, mutations, watchlistMutations, blocked, temporary }, null, 2));
    await page?.screenshot({ path: path.join(artifacts, 'failure.png'), fullPage: true }).catch(() => undefined);
    console.error(JSON.stringify({ passed: false, artifacts, temporary })); throw error;
} finally {
    await browser?.close().catch(() => undefined);
    for (const child of children.reverse()) {
        if (child.exitCode !== null || child.signalCode) continue;
        const ended = new Promise(resolve => child.once('exit', resolve));
        try { process.kill(-child.pid, 'SIGTERM'); } catch { continue; }
        let timeout; await Promise.race([ended, new Promise(resolve => { timeout = setTimeout(resolve, 8000); })]); clearTimeout(timeout);
        if (child.exitCode === null && !child.signalCode) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already stopped */ } await ended; }
    }
}
