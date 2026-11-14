import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { launchConfig } from './dev-fubon-config.mjs';

const roots: string[] = [];
function checkout(worktree = false) {
    const root = mkdtempSync(path.join(tmpdir(), 'fubon-launch-'));
    roots.push(root);
    if (worktree) writeFileSync(path.join(root, '.git'), 'gitdir: /unused/test-fixture');
    else mkdirSync(path.join(root, '.git'));
    return root;
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it('keeps the main checkout ports and gives worktrees stable isolated pairs', () => {
    expect(launchConfig(checkout(), [], {})).toMatchObject({ uiPort: 5179, apiPort: 21323 });
    const root = checkout(true);
    const config = launchConfig(root, [], {});
    expect(launchConfig(root, [], {})).toEqual(config);
    expect(config.uiPort).toBeGreaterThanOrEqual(5200);
    expect(config.uiPort).toBeLessThan(6200);
    expect(config.apiPort).toBe(config.uiPort + 16800);
    expect(config.origin).toBe(`http://localhost:${config.uiPort}`);
});

it('supports explicit ports and no-browser without changing checkout state', () => {
    const config = launchConfig(checkout(true), ['--', '--ui-port', '5189', '--api-port', '21429', '--no-browser'], { FUBON_UI_PORT: '5190', FUBON_PORT: '21430' });
    expect(config).toMatchObject({ uiPort: 5189, apiPort: 21429, origin: 'http://localhost:5189', noBrowser: true });
});

it.each([['--ui-port'], ['--ui-port', '0'], ['--api-port', '70000'], ['--api-port', '21323.1'], ['--unknown'], ['--ui-port', '5189', '--api-port', '5189']])('rejects invalid launch options %j', (...args) => {
    expect(() => launchConfig(checkout(true), args, {})).toThrow();
});
