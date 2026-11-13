// Starts only this fork's two processes. Never adopts or stops another server.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import net from 'node:net';

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
try {
    // Keep one known isolated endpoint for REST and SSE. Refuse conflicts.
    await requireFreePort(21323);
    await requireFreePort(5179);
    run('pnpm', ['exec', 'vite', '--host', '127.0.0.1', '--port', '5179', '--strictPort'], {
        VITE_API_TARGET: 'http://127.0.0.1:21323', VITE_API_BASE: '', VITE_STREAM_BASE: '',
    });
    // Wait for this launch's UI before the backend opens its single-use URL.
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
        if (stopping) break;
        try {
            const response = await fetch('http://127.0.0.1:5179', { signal: AbortSignal.timeout(1000) });
            if (response.ok) { ready = true; break; }
        } catch { /* UI is still starting. */ }
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (!ready) throw new Error('前端啟動逾時');
    run('uv', ['run', '--directory', 'server', 'fubon-bridge', '--ui-url', 'http://localhost:5179'], { FUBON_PORT: '21323' });
    console.log('\nFubon Trading 將自動開啟授權視窗；請使用該視窗操作。\n');
} catch (error) {
    console.error(`無法啟動：${error.message}。保留現有程序，請先確認 21323 / 5179 埠。`);
    stop(1);
}
