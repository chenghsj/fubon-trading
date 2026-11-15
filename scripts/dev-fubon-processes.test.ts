import { spawn, execFile, execFileSync, type ChildProcess } from 'node:child_process';
import { mkdtemp, mkdir, copyFile, writeFile, chmod, rm, realpath } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

const exec = promisify(execFile);
const fixtures: { root: string; children: ChildProcess[]; stop?: () => Promise<unknown> }[] = [];
const source = path.dirname(new URL(import.meta.url).pathname);
const supported = process.platform !== 'win32' && (() => {
    try { execFileSync('lsof', ['-v'], { stdio: 'ignore' }); execFileSync('python3', ['--version']); return true; }
    catch { return false; }
})();
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function freePort() {
    const server = net.createServer();
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as net.AddressInfo).port;
    await new Promise<void>(resolve => server.close(() => resolve()));
    return port;
}

async function fixture(ports?: [number, number]) {
    const root = await mkdtemp(path.join(tmpdir(), 'fubon-controls-'));
    const children: ChildProcess[] = [];
    const cleanup = { root, children, stop: undefined as (() => Promise<unknown>) | undefined };
    fixtures.push(cleanup);
    for (const dir of ['scripts', 'bin', 'node_modules/vite/bin', 'server/.venv/bin']) await mkdir(path.join(root, dir), { recursive: true });
    for (const file of ['dev-fubon.mjs', 'dev-fubon-config.mjs', 'dev-fubon-processes.mjs']) {
        if (existsSync(path.join(source, file))) await copyFile(path.join(source, file), path.join(root, 'scripts', file));
    }
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ private: true, scripts: Object.fromEntries(['start', 'status', 'stop', 'restart'].map(action => [action, `node scripts/dev-fubon.mjs ${action}`])) }));
    await writeFile(path.join(root, '.env'), 'FUBON_MODE=demo\n');
    await writeFile(path.join(root, 'node_modules/vite/bin/vite.js'), `require('node:http').createServer((q,s)=>{s.setHeader('Content-Type','application/json');s.end(JSON.stringify({pid:process.pid}));}).listen(Number(process.argv[process.argv.indexOf('--port')+1]),'127.0.0.1');`);
    const python = execFileSync('python3', ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' }).trim();
    await writeFile(path.join(root, 'server/.venv/bin/fubon-bridge'), `import os,sys,json\nfrom http.server import HTTPServer,BaseHTTPRequestHandler\nclass Handler(BaseHTTPRequestHandler):\n def do_GET(self):\n  data={'enrolled':True,'origin':sys.argv[sys.argv.index('--ui-url')+1],'pid':os.getpid()}\n  if not os.environ.get('FUBON_LEGACY_TEST'):data['mode']=os.environ.get('FUBON_MODE','demo')\n  self.send_response(200);self.send_header('Content-Type','application/json');self.end_headers();self.wfile.write(json.dumps(data).encode())\n def log_message(self,*args):pass\nHTTPServer(('127.0.0.1',int(os.environ['FUBON_PORT'])),Handler).serve_forever()\n`);
    await writeFile(path.join(root, 'bin/uv'), `#!${python}\nimport os,sys\nroot=os.path.dirname(os.path.dirname(os.path.realpath(__file__)))\nos.chdir(root+'/server')\nos.execv(sys.executable,[sys.executable,root+'/server/.venv/bin/fubon-bridge']+sys.argv[sys.argv.index('fubon-bridge')+1:])\n`);
    await chmod(path.join(root, 'bin/uv'), 0o700);
    const [uiPort, apiPort] = ports ?? [await freePort(), await freePort()];
    const args = ['--ui-port', String(uiPort), '--api-port', String(apiPort), '--no-browser'];
    const env = { ...process.env, PATH: `${root}/bin:${process.env.PATH}`, FUBON_MODE: 'demo' };
    const command = (action: string) => exec(process.execPath, ['scripts/dev-fubon.mjs', ...(action === 'start' ? [] : [action]), ...args], { cwd: root, env, timeout: 12000 }).then(r => ({ ...r, code: 0 })).catch(e => ({ stdout: e.stdout as string, stderr: e.stderr as string, code: e.code as number }));
    cleanup.stop = () => command('stop');
    const packageCommand = (action: string) => exec('pnpm', [action, ...args], { cwd: root, env, timeout: 12000 }).then(r => ({ ...r, code: 0 })).catch(e => ({ stdout: e.stdout as string, stderr: e.stderr as string, code: e.code as number }));
    const packageStart = (action: string) => { const child = spawn('pnpm', [action, ...args], { cwd: root, env, stdio: 'ignore' }); children.push(child); return child; };
    const start = (action = 'start') => {
        const child = spawn(process.execPath, ['scripts/dev-fubon.mjs', ...(action === 'start' ? [] : [action]), ...args], { cwd: root, env, stdio: 'ignore' });
        children.push(child);
        return child;
    };
    const ready = async () => {
        for (let i = 0; i < 150; i++) {
            try {
                await fetch(`http://127.0.0.1:${uiPort}`).then(r => r.json());
                return await fetch(`http://127.0.0.1:${apiPort}/api/v1/passkeys/status`).then(r => r.json()) as { pid: number };
            } catch { await delay(40); }
        }
        throw new Error('Fixture startup timed out');
    };
    return { root, children, uiPort, apiPort, command, start, ready, env, args, packageCommand, packageStart };
}

afterEach(async () => {
    for (const { root, children, stop } of fixtures.splice(0)) {
        await stop?.();
        for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
        for (let i = 0; i < 100 && children.some(c => c.exitCode === null && c.signalCode === null); i++) await delay(30);
        await rm(root, { recursive: true, force: true });
    }
});

describe.skipIf(!supported)('dev service commands with real isolated processes', () => {
    it('reports the running pair and repeated start exits successfully without replacing either service', async () => {
        const f = await fixture();
        f.start();
        const before = await f.ready();
        const repeated = await f.command('start');
        expect(repeated.code, repeated.stderr).toBe(0);
        expect(repeated.stdout).toContain('已在執行');
        expect(repeated.stdout).toContain('pnpm stop');
        expect((await f.ready()).pid).toBe(before.pid);
        const status = await f.command('status');
        expect(status.code, status.stderr).toBe(0);
        expect(status.stdout).toContain(f.root);
        expect(status.stdout).toContain('demo');
        expect(status.stdout).toContain(String(before.pid));
        expect((await f.command('stop')).code).toBe(0);
        await expect(fetch(`http://127.0.0.1:${f.apiPort}`)).rejects.toThrow();
    }, 25000);

    it('restart replaces only this checkout pair and stop also works after restart', async () => {
        const f = await fixture();
        f.start();
        const before = await f.ready();
        f.start('restart');
        let after = before;
        for (let i = 0; i < 150 && after.pid === before.pid; i++) { await delay(50); try { after = await f.ready(); } catch { /* restarting */ } }
        expect(after.pid).not.toBe(before.pid);
        const stopped = await f.command('stop');
        expect(stopped.code, stopped.stderr).toBe(0);
        expect((await f.command('status')).stdout).toContain('未執行');
    }, 25000);

    it('refuses to stop services from a different checkout even on explicitly selected ports', async () => {
        const first = await fixture();
        first.start();
        const before = await first.ready();
        const other = await fixture([first.uiPort, first.apiPort]);
        const stopped = await other.command('stop');
        expect(stopped.code).not.toBe(0);
        expect(stopped.stderr).toContain('其他');
        expect((await first.ready()).pid).toBe(before.pid);
    }, 25000);

    it('identifies and stops an older pair that has no launcher record', async () => {
        const f = await fixture();
        const ui = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--port', String(f.uiPort)], { cwd: f.root, env: f.env, stdio: 'ignore' });
        const api = spawn('uv', ['run', '--directory', 'server', 'fubon-bridge', '--ui-url', `http://localhost:${f.uiPort}`], { cwd: f.root, env: { ...f.env, FUBON_PORT: String(f.apiPort), FUBON_LEGACY_TEST: '1' }, stdio: 'ignore' });
        f.children.push(ui, api);
        await f.ready();
        expect((await f.command('status')).stdout).toContain('模式：未記錄');
        const stopped = await f.command('stop');
        expect(stopped.code, stopped.stderr).toBe(0);
        await expect(fetch(`http://127.0.0.1:${f.apiPort}`)).rejects.toThrow();
    }, 25000);

    it('keeps an unrelated listener alive and explains a partial startup instead of spawning another API', async () => {
        const f = await fixture();
        const foreign = spawn(process.execPath, ['-e', `require('node:http').createServer((q,s)=>s.end('foreign')).listen(${f.apiPort},'127.0.0.1')`], { cwd: f.root, stdio: 'ignore' });
        f.children.push(foreign);
        for (let i = 0; i < 100; i++) { try { await fetch(`http://127.0.0.1:${f.apiPort}`); break; } catch { await delay(30); } }
        expect((await f.command('start')).code).not.toBe(0);
        expect((await f.command('stop')).code).not.toBe(0);
        expect(await fetch(`http://127.0.0.1:${f.apiPort}`).then(r => r.text())).toBe('foreign');
    }, 25000);

    it('does not start a replacement API for an older UI-only pair, but explicit stop can clean that UI', async () => {
        const f = await fixture();
        const ui = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--port', String(f.uiPort)], { cwd: f.root, env: f.env, stdio: 'ignore' });
        f.children.push(ui);
        for (let i = 0; i < 100; i++) { try { await fetch(`http://127.0.0.1:${f.uiPort}`); break; } catch { await delay(30); } }
        const start = await f.command('start');
        expect(start.code).not.toBe(0);
        expect(start.stdout).toContain('僅部分服務');
        await expect(fetch(`http://127.0.0.1:${f.apiPort}`)).rejects.toThrow();
        expect((await f.command('stop')).code).toBe(0);
    }, 25000);

    it('rejects a stale launcher PID fingerprint and stops only the verified listeners', async () => {
        const f = await fixture();
        f.start();
        await f.ready();
        await writeFile(path.join(f.root, '.fubon-dev', `${f.uiPort}-${f.apiPort}.json`), JSON.stringify({
            id: 'stale', root: await realpath(f.root), pid: process.pid,
            fingerprint: 'a previous process with a reused PID', uiPort: f.uiPort, apiPort: f.apiPort, mode: 'live',
        }));
        const status = await f.command('status');
        expect(status.stdout).toContain('模式：demo');
        expect((await f.command('stop')).code).toBe(0);
        expect(process.kill(process.pid, 0)).toBe(true);
    }, 25000);

    it('concurrent starts leave just one managed pair and both callers avoid a duplicate-port failure', async () => {
        const f = await fixture();
        const first = f.start();
        const second = f.start();
        await f.ready();
        for (let i = 0; i < 100 && first.exitCode === null && second.exitCode === null; i++) await delay(30);
        const completed = [first, second].filter(c => c.exitCode !== null);
        expect(completed).toHaveLength(1);
        expect(completed[0]!.exitCode).toBe(0);
        expect((await f.command('stop')).code).toBe(0);
    }, 25000);

    it('package restart followed by one package stop stays stopped after pnpm finishes its lifecycle', async () => {
        const f = await fixture();
        f.packageStart('start');
        const before = await f.ready();
        const restart = f.packageStart('restart');
        let after = before;
        for (let i = 0; i < 150 && after.pid === before.pid; i++) { await delay(50); try { after = await f.ready(); } catch { /* restarting */ } }
        expect(after.pid).not.toBe(before.pid);
        const stop = await f.packageCommand('stop');
        expect(stop.code, stop.stderr).toBe(0);
        for (let i = 0; i < 100 && restart.exitCode === null; i++) await delay(30);
        expect(restart.exitCode).toBe(0);
        await delay(500);
        expect((await f.packageCommand('status')).stdout).toContain('未執行');
        await expect(fetch(`http://127.0.0.1:${f.apiPort}`)).rejects.toThrow();
    }, 25000);

    it('does not treat inert Vite arguments on a foreign Node program as the executed script', async () => {
        const f = await fixture();
        const foreign = spawn(process.execPath, ['-e', `require('node:http').createServer((q,s)=>s.end('foreign')).listen(${f.uiPort},'127.0.0.1')`, 'node_modules/vite/bin/vite.js'], { cwd: f.root, stdio: 'ignore' });
        f.children.push(foreign);
        for (let i = 0; i < 100; i++) { try { await fetch(`http://127.0.0.1:${f.uiPort}`); break; } catch { await delay(30); } }
        expect((await f.command('stop')).code).not.toBe(0);
        expect(await fetch(`http://127.0.0.1:${f.uiPort}`).then(r => r.text())).toBe('foreign');
    }, 25000);

    it('reports duplicate .env assignments as current configuration without claiming it is a running mode', async () => {
        const f = await fixture();
        await writeFile(path.join(f.root, '.env'), 'FUBON_MODE=demo\nFUBON_MODE=paper\n');
        const env = { ...f.env }; delete env.FUBON_MODE;
        const result = await exec(process.execPath, ['scripts/dev-fubon.mjs', 'status', ...f.args], { cwd: f.root, env });
        expect(result.stdout).toContain('模式：未記錄（目前設定：paper）');
    }, 25000);

    it('serializes stale-record recovery so a paused remover cannot delete a new reservation', async () => {
        const f = await fixture();
        const root = await realpath(f.root);
        const file = path.join(root, '.fubon-dev', `${f.uiPort}-${f.apiPort}.json`);
        await mkdir(path.dirname(file));
        await writeFile(file, JSON.stringify({ id: 'stale', root, uiPort: f.uiPort, apiPort: f.apiPort, pid: 2147483647, fingerprint: 'gone' }));
        const worker = `import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';\nconst root=${JSON.stringify(root)},file=${JSON.stringify(file)};\nif(process.argv[2]==='B'){const unlink=fs.unlinkSync;fs.unlinkSync=(p)=>{if(p===file){fs.writeFileSync(root+'/waiting','');while(!fs.existsSync(root+'/release'))Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);}return unlink(p);};syncBuiltinESMExports();}\nconst {claimServices}=await import('./dev-fubon-processes.mjs');const release=await claimServices(root,{uiPort:${f.uiPort},apiPort:${f.apiPort}});fs.writeFileSync(root+'/'+process.argv[2]+'-result',String(!!release));setInterval(()=>{},1000);process.on('SIGTERM',()=>{release?.();process.exit();});`;
        await writeFile(path.join(root, 'scripts/dev-fubon.mjs'), worker);
        // This fixture temporarily replaces the CLI with claim workers.
        fixtures.find(item => item.root === f.root)!.stop = undefined;
        const run = (name: string) => { const p = spawn(process.execPath, ['scripts/dev-fubon.mjs', name], { cwd: root, env: f.env, stdio: 'ignore' }); f.children.push(p); return p; };
        run('B');
        for (let i = 0; i < 200 && !existsSync(path.join(root, 'waiting')); i++) await delay(20);
        expect(existsSync(path.join(root, 'waiting'))).toBe(true);
        run('A');
        await delay(150);
        await writeFile(path.join(root, 'release'), '');
        for (let i = 0; i < 200 && (!existsSync(path.join(root, 'A-result')) || !existsSync(path.join(root, 'B-result'))); i++) await delay(20);
        const results = await Promise.all(['A', 'B'].map(name => import('node:fs/promises').then(fs => fs.readFile(path.join(root, name + '-result'), 'utf8'))));
        expect(results.sort()).toEqual(['false', 'true']);
    }, 25000);
});
