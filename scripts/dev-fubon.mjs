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
    run('uv', ['run', '--directory', 'server', 'fubon-bridge'], { FUBON_PORT: '21323' });
    run('pnpm', ['exec', 'vite', '--host', '127.0.0.1', '--port', '5179', '--strictPort'], {
        VITE_API_TARGET: 'http://127.0.0.1:21323', VITE_API_BASE: '', VITE_STREAM_BASE: '',
    });
    console.log('\nFubon Trading: http://127.0.0.1:5179\n');
} catch (error) {
    console.error(`無法啟動：${error.message}。保留現有程序，請先確認 21323 / 5179 埠。`);
    stop(1);
}
