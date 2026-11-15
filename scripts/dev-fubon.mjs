// Controls only the verified services for this checkout and explicit port pair.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import net from 'node:net';
import { launchConfig } from './dev-fubon-config.mjs';
import { inspectServices, printStatus, claimServices, stopServices } from './dev-fubon-processes.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const children = [];
let stopping = false;
let release;
function stop(code = 0) {
    if (stopping) return;
    stopping = true;
    for (const child of children) {
        if (!child.pid || child.exitCode !== null || child.signalCode !== null) continue;
        try { process.kill(process.platform === 'win32' ? child.pid : -child.pid, 'SIGTERM'); }
        catch { /* the child has already stopped */ }
    }
    process.exitCode = code;
}
process.on('exit', () => release?.());
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => stop());
async function requireFreePort(port) {
    const probe = net.createServer();
    probe.listen(port, '127.0.0.1');
    await once(probe, 'listening');
    await new Promise(resolve => probe.close(resolve));
}
function run(command, args, env = {}) {
    const child = spawn(command, args, { cwd: root, stdio: 'inherit',
        detached: process.platform !== 'win32', env: { ...process.env, ...env } });
    children.push(child);
    child.on('error', error => { console.error(error.message); stop(1); });
    child.on('exit', code => { if (!stopping) stop(code || 1); });
    return child;
}
async function start({ uiPort, apiPort, origin, noBrowser }) {
    // These are deliberate per-worktree endpoints, never fallback/adoption.
    await requireFreePort(apiPort);
    await requireFreePort(uiPort);
    if (stopping) return;
    const vite = fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url));
    run(process.execPath, [vite, '--host', '127.0.0.1', '--port', String(uiPort), '--strictPort'], {
        VITE_API_TARGET: `http://127.0.0.1:${apiPort}`, VITE_API_BASE: '', VITE_STREAM_BASE: origin,
        VITE_DEV_SERVER_PORT: '',
    });
    // Wait for this launch's UI before the backend opens its single-use URL.
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
        if (stopping) break;
        try {
            const response = await fetch(`http://127.0.0.1:${uiPort}`, { signal: AbortSignal.timeout(1000) });
            if (response.ok) { ready = true; break; }
        } catch { /* UI is still starting. */ }
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (stopping) return;
    if (!ready) throw new Error('前端啟動逾時');
    run('uv', ['run', '--directory', 'server', '--extra', 'learning', 'fubon-bridge', '--ui-url', origin, ...(noBrowser ? ['--no-browser'] : [])], { FUBON_PORT: String(apiPort) });
    console.log(`\nFubon Trading：${origin}（API 127.0.0.1:${apiPort}）\n沿用本機共用 Passkey；請以既有 Passkey 解鎖。${noBrowser ? '' : '將在預設瀏覽器開啟。'}\n`);
}
try {
    const args = process.argv.slice(2).filter(arg => arg !== '--');
    const action = ['start', 'status', 'stop', 'restart'].includes(args[0]) ? args.shift() : 'start';
    const config = launchConfig(root, args);
    if (config.help) {
        console.log('pnpm start／status／stop／restart [--ui-port 5189] [--api-port 21429] [--no-browser]\n主 checkout 使用 5179/21323；worktree 依路徑分配固定獨立埠。所有 worktree 沿用本機共用 Passkey。\n重複 start 只顯示現有服務；stop／restart 只操作已確認屬於目前專案的程序。');
    } else if (action === 'status') {
        printStatus(await inspectServices(root, config));
    } else if (action === 'stop') {
        await stopServices(root, config);
    } else if (process.platform === 'win32' && action === 'start') {
        // Preserve the original Windows start path; process controls need POSIX identity checks.
        await start(config);
    } else {
        if (action === 'restart') {
            console.log('正在明確重啟：目前工作階段將斷線，paper 模擬狀態會重設。');
            await stopServices(root, config);
        }
        const status = await inspectServices(root, config);
        if (status.state === 'running' || status.state === 'starting') {
            printStatus(status);
        } else if (status.state !== 'stopped') {
            printStatus(status);
            throw new Error('現有服務不完整、未就緒或由其他程序占用；請先使用上方查詢／停止指令。');
        } else {
            release = await claimServices(root, config);
            if (!release) {
                const concurrent = await inspectServices(root, config);
                printStatus(concurrent);
                if (concurrent.state === 'stopped') throw new Error('另一個啟動程序尚未就緒，請稍後重新查詢。');
            }
            else await start(config);
        }
    }
} catch (error) {
    console.error(`服務操作失敗：${error.message.replace(/[。.]$/, '')}。\n可用 pnpm status 查詢；自訂埠請帶上同一組 --ui-port／--api-port。`);
    stop(1);
}
