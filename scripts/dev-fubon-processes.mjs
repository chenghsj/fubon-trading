import { execFile, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, lstatSync, unlinkSync, realpathSync, existsSync, readlinkSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const options = { encoding: 'utf8', timeout: 3000, maxBuffer: 128 * 1024, env: { ...process.env, LC_ALL: 'C' } };
const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

async function output(command, args) {
    try { return (await exec(command, args, options)).stdout.trim(); }
    catch (error) {
        if (error.code === 1 && !error.stdout?.trim()) return '';
        if (error.code === 'ENOENT') throw new Error('程序查詢需要 lsof 與 ps（目前支援 macOS／Linux）。');
        throw new Error(`無法查詢程序（${command}）；保留現有服務。`);
    }
}

/** Never use a bare PID as stop authority: include its owner, birth time, cwd and command. */
async function processIdentity(pid) {
    const [stamp, command, executable, cwdLines] = await Promise.all([
        output('ps', ['-p', String(pid), '-o', 'uid=,lstart=']),
        output('ps', ['-p', String(pid), '-o', 'command=']),
        output('ps', ['-p', String(pid), '-o', 'comm=']),
        output('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn']),
    ]);
    const cwd = cwdLines.split('\n').find(line => line.startsWith('n'))?.slice(1);
    const uid = Number(stamp.match(/^\d+/)?.[0]);
    if (!stamp || !command || !cwd || !Number.isInteger(uid)) return undefined;
    let executablePath = executable;
    // procps comm on Linux is only a name; never resolve it relative to the checkout.
    if (!path.isAbsolute(executablePath)) {
        try { executablePath = readlinkSync(`/proc/${pid}/exe`); }
        catch {
            const text = await output('lsof', ['-a', '-p', String(pid), '-d', 'txt', '-Fn']);
            const candidates = [...new Set(text.split('\n').filter(line => line.startsWith('n')).map(line => line.slice(1)))]
                .filter(file => path.basename(file) === executable);
            if (candidates.length !== 1) return undefined;
            executablePath = candidates[0];
        }
    }
    const fingerprint = createHash('sha256').update(`${stamp}\0${command}\0${cwd}`).digest('hex');
    return { pid, command, executable: path.basename(executablePath), executablePath, cwd, uid, fingerprint };
}

function executesScript(identity, script) {
    const index = identity.command.indexOf(` ${script}`);
    if (index < 0) return false;
    const remaining = identity.command.slice(index + script.length + 1);
    if (remaining && !remaining.startsWith(' ')) return false;
    const binary = identity.command.slice(0, index);
    if (binary === identity.executable) return true;
    // A path with spaces is still one executable if it resolves to ps's executable.
    if (!path.isAbsolute(binary)) return false;
    try { return realpathSync(binary) === realpathSync(identity.executablePath); }
    catch { return false; }
}

async function listeners(port) {
    const text = await output('lsof', ['-nP', '-a', '-iTCP:' + port, '-sTCP:LISTEN', '-t']);
    return [...new Set(text.split(/\s+/).filter(Boolean).map(Number))];
}

function belongsTo(root, config, role, process) {
    if (!process || process.uid !== processUid()) return false;
    const { command, executable, cwd } = process;
    if (role === 'ui') {
        return cwd === root && /^(node|bun)$/.test(executable) &&
            [path.join(root, 'node_modules/vite/bin/vite.js'), 'node_modules/vite/bin/vite.js', './node_modules/vite/bin/vite.js'].some(script => executesScript(process, script));
    }
    const bridge = path.join(root, 'server/.venv/bin/fubon-bridge');
    return cwd === path.join(root, 'server') && /^(python(?:\d+(?:\.\d+)*)?|fubon-bridge)$/i.test(executable) &&
        [bridge, '-m fubon_bridge'].some(script => executesScript(process, script)) &&
        new RegExp(`(?:^|\\s)--ui-url\\s+${escape(config.origin)}(?:\\s|$)`).test(command);
}

const processUid = () => process.getuid?.() ?? -1;
const recordPath = (root, config) => path.join(root, '.fubon-dev', `${config.uiPort}-${config.apiPort}.json`);

function readRecord(root, config) {
    try {
        const file = recordPath(root, config);
        const stat = lstatSync(file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== processUid()) return undefined;
        const record = JSON.parse(readFileSync(file, 'utf8'));
        return record.root === root && record.uiPort === config.uiPort && record.apiPort === config.apiPort ? record : undefined;
    } catch { return undefined; }
}

async function recordOwner(root, record) {
    if (!Number.isInteger(record?.pid) || record.pid <= 0) return undefined;
    const owner = await processIdentity(record.pid);
    if (owner?.uid !== processUid() || owner.cwd !== root || owner.fingerprint !== record.fingerprint || !/^(node|bun)$/.test(owner.executable)) return undefined;
    return [path.join(root, 'scripts/dev-fubon.mjs'), 'scripts/dev-fubon.mjs', './scripts/dev-fubon.mjs'].some(script => executesScript(owner, script)) ? owner : undefined;
}

export function configuredMode(root) {
    // The backend applies the checkout's saved selection after environment config.
    try {
        const saved = JSON.parse(readFileSync(path.join(root, 'server/.mode-settings.json'), 'utf8'));
        if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return 'unknown';
        const liveEnabled = 'live_enabled' in saved ? saved.live_enabled : false;
        return Object.keys(saved).every(key => ['mode', 'live_enabled'].includes(key)) &&
            ['demo', 'paper', 'sandbox', 'live'].includes(saved.mode) &&
            typeof liveEnabled === 'boolean' && liveEnabled === (saved.mode === 'live') ? saved.mode : 'unknown';
    } catch (error) {
        if (error.code !== 'ENOENT') return 'unknown';
    }
    let value = process.env.FUBON_MODE;
    if (value === undefined) {
        let text = '';
        try { text = readFileSync(path.join(root, '.env'), 'utf8'); } catch { /* New worktree defaults to demo. */ }
        const line = [...text.matchAll(/^\s*(?:export\s+)?FUBON_MODE\s*=\s*(.*)$/gm)].at(-1)?.[1]?.trim();
        value = line?.startsWith('"') ? line.match(/^"([^"]*)"/)?.[1]
            : line?.startsWith("'") ? line.match(/^'([^']*)'/)?.[1] : line?.split('#')[0]?.trim();
    }
    return value === undefined ? 'demo' : ['demo', 'paper', 'sandbox', 'live'].includes(value) ? value : 'unknown';
}

export async function inspectServices(inputRoot, config) {
    const root = realpathSync(inputRoot);
    if (process.platform === 'win32') throw new Error('status／stop／restart 目前支援 macOS／Linux，需要 lsof 與 ps。');
    const record = readRecord(root, config);
    const [uiPids, apiPids, owner] = await Promise.all([listeners(config.uiPort), listeners(config.apiPort), recordOwner(root, record)]);
    const describe = async (role, pids, port) => ({ role, port, processes: await Promise.all(pids.map(async pid => {
        const identity = await processIdentity(pid);
        return { pid, identity, owned: belongsTo(root, config, role, identity) };
    })) });
    const [ui, api] = await Promise.all([describe('ui', uiPids, config.uiPort), describe('api', apiPids, config.apiPort)]);
    const all = [...ui.processes, ...api.processes];
    let state = all.length ? 'partial' : owner ? 'starting' : 'stopped';
    let mode;
    if (all.some(p => !p.owned)) state = 'foreign';
    else if (ui.processes.length === 1 && api.processes.length === 1) {
        try {
            const [page, bridge] = await Promise.all([
                fetch(`http://127.0.0.1:${config.uiPort}`, { redirect: 'error', signal: AbortSignal.timeout(1500) }),
                fetch(`http://127.0.0.1:${config.apiPort}/api/v1/passkeys/status`, { redirect: 'error', signal: AbortSignal.timeout(1500) }),
            ]);
            const passkeys = await bridge.json();
            await page.body?.cancel();
            state = page.ok && bridge.ok && typeof passkeys.enrolled === 'boolean' && passkeys.origin === config.origin ? 'running' : 'unhealthy';
            if (state === 'running' && ['demo', 'paper', 'sandbox', 'live'].includes(passkeys.mode)) mode = passkeys.mode;
        } catch { state = 'unhealthy'; }
    }
    if (owner && ['partial', 'unhealthy'].includes(state) && Date.now() - record.createdAt < 15000) state = 'starting';
    return { root, config, state, ui, api, owner, record, mode, configuredMode: configuredMode(root) };
}

export function printStatus(status) {
    const names = { running: '已在執行', stopped: '未執行', starting: '正在啟動', partial: '僅部分服務執行中', foreign: '埠由其他程序占用', unhealthy: '服務未就緒' };
    console.log(`Fubon Trading：${names[status.state]}\n專案：${status.root}`);
    console.log(`模式：${status.mode ?? `未記錄（目前設定：${status.configuredMode}）`}`);
    for (const service of [status.ui, status.api]) {
        const pids = service.processes.map(p => `${p.pid}${p.owned ? '' : '（其他／無法確認）'}`).join(', ') || '—';
        console.log(`${service.role === 'ui' ? '前端' : 'API'}：127.0.0.1:${service.port} · PID ${pids}`);
    }
    console.log(`網址：${status.config.origin}`);
    const args = ` -- --ui-port ${status.config.uiPort} --api-port ${status.config.apiPort}`;
    console.log(`查詢：pnpm status${args}\n停止：pnpm stop${args}\n重啟：pnpm restart${args}`);
}

// flock is released by the kernel even if either process crashes. Never unlink its
// file: replacing that inode would allow two callers to acquire different locks.
const flockScript = `import fcntl,os,stat,sys
fd=os.open(sys.argv[1],os.O_CREAT|os.O_RDWR|getattr(os,'O_NOFOLLOW',0),0o600)
info=os.fstat(fd)
if not stat.S_ISREG(info.st_mode) or info.st_uid!=os.getuid(): raise RuntimeError('Invalid lock owner')
fcntl.flock(fd,fcntl.LOCK_EX)
print('locked',flush=True)
sys.stdin.buffer.read()
`;

async function lockClaims(root, file) {
    const python = path.join(root, 'server/.venv/bin/python');
    const commands = existsSync(python) ? [[python, ['-u', '-c', flockScript, file]]]
        : [['python3', ['-u', '-c', flockScript, file]], ['uv', ['run', '--directory', 'server', 'python', '-u', '-c', flockScript, file]]];
    for (const [command, args] of commands) {
        const child = spawn(command, args, { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
        try {
            await new Promise((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error('等待啟動鎖逾時，未啟動額外服務。')), 10000);
                const done = (error) => { clearTimeout(timer); error ? reject(error) : resolve(); };
                child.once('error', done);
                child.once('exit', () => done(new Error('無法取得啟動鎖；請確認 Python／uv 可使用。')));
                let text = '';
                child.stdout.on('data', chunk => { text += chunk; if (text.includes('locked\n')) done(); });
                child.stderr.resume();
            });
            return () => child.stdin.end();
        } catch (error) {
            child.stdin.destroy();
            if (child.pid) child.kill('SIGTERM');
            if (error.code === 'ENOENT') continue;
            throw error;
        }
    }
    throw new Error('需要 Python 或 uv 才能安全取得啟動鎖。');
}

/** Reserve one launcher per checkout/port pair before spawning either child. */
export async function claimServices(inputRoot, config) {
    const root = realpathSync(inputRoot);
    const directory = path.join(root, '.fubon-dev');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const directoryStat = lstatSync(directory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink() || directoryStat.uid !== processUid()) throw new Error('啟動記錄目錄無法安全使用。');
    const file = recordPath(root, config);
    const unlock = await lockClaims(root, file + '.lock');
    try {
        const previous = readRecord(root, config);
        if (await recordOwner(root, previous)) return undefined;
        // A record is internal bookkeeping; remove it only while both ports are free.
        if ((await listeners(config.uiPort)).length || (await listeners(config.apiPort)).length) throw new Error('埠已被占用；請先執行 pnpm status。');
        if (previous) {
            const current = readRecord(root, config);
            if (current?.id !== previous.id) return undefined;
            unlinkSync(file);
        }
        const identity = await processIdentity(process.pid);
        if (!identity) throw new Error('無法記錄啟動程序身分。');
        const record = { id: randomUUID(), createdAt: Date.now(), root, pid: process.pid, fingerprint: identity.fingerprint, uiPort: config.uiPort, apiPort: config.apiPort };
        try { writeFileSync(file, JSON.stringify(record), { flag: 'wx', mode: 0o600 }); }
        catch (error) {
            if (error.code === 'EEXIST' && await recordOwner(root, readRecord(root, config))) return undefined;
            if (error.code === 'EEXIST') throw new Error('啟動記錄未就緒或損壞，未啟動額外服務；請執行 pnpm status 檢查。');
            throw error;
        }
        return () => {
            if (readRecord(root, config)?.id === record.id) {
                try { unlinkSync(file); } catch { /* Another cleanup may have finished. */ }
            }
        };
    } finally { unlock(); }
}

export async function stopServices(root, config) {
    const status = await inspectServices(root, config);
    const processes = [...status.ui.processes, ...status.api.processes];
    if (processes.some(p => !p.owned)) throw new Error('包含其他專案或無法確認的程序，未停止任何服務；請用 pnpm status 查看 PID。');
    const targets = status.owner ? [status.owner] : processes.map(p => p.identity);
    // Revalidate the entire set before the first signal; PID reuse is not authority.
    const current = await Promise.all(targets.map(p => processIdentity(p.pid)));
    if (current.some((p, i) => !p || p.fingerprint !== targets[i].fingerprint)) throw new Error('程序身分已變更，未停止服務；請重新查詢。');
    for (const target of current) {
        try { process.kill(target.pid, 'SIGTERM'); }
        catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
        const [ui, api, owner] = await Promise.all([listeners(config.uiPort), listeners(config.apiPort), recordOwner(status.root, status.record)]);
        if (!ui.length && !api.length && !owner) {
            console.log('目前專案的前端與 API 已停止。');
            return;
        }
        await pause(100);
    }
    throw new Error('服務尚未完成停止，未強制終止；請執行 pnpm status 檢查。');
}
