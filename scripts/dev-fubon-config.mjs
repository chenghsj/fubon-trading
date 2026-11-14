import { createHash } from 'node:crypto';
import { lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';

function port(value, name) {
    if (!/^\d+$/.test(String(value)) || !Number.isInteger(Number(value)) || Number(value) < 1024 || Number(value) > 65535) {
        throw new Error(`${name} 必須是 1024–65535 的整數`);
    }
    return Number(value);
}

export function launchConfig(root, argv = [], env = process.env) {
    const options = {};
    for (let i = 0; i < argv.length; i++) {
        const name = argv[i];
        if (name === '--') continue;
        if (name === '--no-browser' || name === '--help') { options[name] = true; continue; }
        if (name !== '--ui-port' && name !== '--api-port') throw new Error(`未知啟動參數：${name}`);
        options[name] = port(argv[++i], name);
    }
    let worktree = false;
    try { worktree = lstatSync(path.join(root, '.git')).isFile(); } catch { /* Source archive. */ }
    const slot = createHash('sha256').update(realpathSync(root)).digest().readUInt32BE(0) % 1000;
    const uiPort = port(options['--ui-port'] ?? env.FUBON_UI_PORT ?? (worktree ? 5200 + slot : 5179), 'UI port');
    const apiPort = port(options['--api-port'] ?? env.FUBON_PORT ?? (worktree ? 22000 + slot : 21323), 'API port');
    if (uiPort === apiPort) throw new Error('UI 與 API 必須使用不同的埠');
    return { uiPort, apiPort, origin: `http://localhost:${uiPort}`, noBrowser: !!options['--no-browser'], help: !!options['--help'] };
}
