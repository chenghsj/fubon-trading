// Starts only this fork's two processes. Never adopts or stops another server.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import net from 'node:net';
import { launchConfig } from './dev-fubon-config.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const children = [];
let stopping = false;
function stop(code = 0) {
    if (stopping) return;
    stopping = true;
    for (const child of children) {
        if (child.exitCode !== null) continue;
        try { process.kill(process.platform === 'win32' ? child.pid : -child.pid, 'SIGTERM'); }
        catch { /* the child has already stopped */ }
    }
    process.exitCode = code;
}
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
    if (!ready) throw new Error('前端啟動逾時');
    run('uv', ['run', '--directory', 'server', 'fubon-bridge', '--ui-url', origin, ...(noBrowser ? ['--no-browser'] : [])], { FUBON_PORT: String(apiPort) });
    console.log(`\nFubon Trading：${origin}（API 127.0.0.1:${apiPort}）\n沿用本機共用 Passkey；請以既有 Passkey 解鎖。${noBrowser ? '' : '將在預設瀏覽器開啟。'}\n`);
}
try {
    const config = launchConfig(root, process.argv.slice(2));
    if (config.help) {
        console.log('pnpm start [--ui-port 5189] [--api-port 21429] [--no-browser]\n主 checkout 使用 5179/21323；worktree 依路徑分配固定獨立埠。所有 worktree 沿用本機共用 Passkey。');
    } else {
        await start(config);
    }
} catch (error) {
    console.error(`無法啟動：${error.message}。保留現有程序；若埠被占用，請用 --ui-port / --api-port 明確指定另一組埠。`);
    stop(1);
}
