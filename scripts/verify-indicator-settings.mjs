import { chromium, expect } from '@playwright/test';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

async function contrast(button) {
    return button.evaluate(el => {
        const rgba = color => color.match(/[\d.]+/g).map(Number);
        const style = getComputedStyle(el);
        const brightness = [...style.filter.matchAll(/brightness\(([\d.]+)\)/g)].reduce((value, match) => value * Number(match[1]), 1);
        const filtered = channels => channels.map(channel => Math.min(255, channel * brightness));
        const layers = [];
        for (let node = el; node; node = node.parentElement) {
            const [r, g, b, alpha = 1] = rgba(getComputedStyle(node).backgroundColor);
            layers.unshift([...(node === el ? filtered([r, g, b]) : [r, g, b]), alpha]);
        }
        let background = [255, 255, 255];
        for (const layer of layers) {
            const [r, g, b, alpha = 1] = layer;
            background = [r, g, b].map((channel, index) => channel * alpha + background[index] * (1 - alpha));
        }
        const luminance = color => color.slice(0, 3).map(v => v / 255)
            .map(v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
            .reduce((sum, v, index) => sum + v * [0.2126, 0.7152, 0.0722][index], 0);
        const [r, g, b, alpha = 1] = rgba(style.color);
        const foreground = filtered([r, g, b]).map((channel, index) => channel * alpha + background[index] * (1 - alpha));
        const values = [luminance(foreground), luminance(background)];
        return { ratio: (Math.max(...values) + 0.05) / (Math.min(...values) + 0.05), color: style.color, background: style.backgroundColor, filter: style.filter };
    });
}

async function settle(button) {
    await button.evaluate(async el => {
        getComputedStyle(el).backgroundColor;
        await Promise.all(el.getAnimations().map(animation => animation.finished.catch(() => {})));
    });
}

/** Real indicator settings, theme tokens and utility CSS; no authenticated session or orders. */
export async function indicatorSettingsChecks(page, origin, artifacts) {
    await page.goto(origin);
    await page.waitForSelector('[data-slot="card"]');
    await page.evaluate(async () => {
        const React = (await import('/node_modules/.vite/deps/react.js')).default;
        const dom = await import('/node_modules/.vite/deps/react-dom_client.js');
        const createRoot = dom.createRoot ?? dom.default.createRoot;
        const { IndicatorSettingsModal } = await import('/src/components/indicator-dialog.tsx');
        const { factoryInstance } = await import('/src/lib/indicator-defs.ts');
        window.__qaIndicatorCommits = 0;
        function Harness() {
            const [inst, setInst] = React.useState(() => factoryInstance({ id: 'qa-ma', type: 'sma', params: {}, colors: {} }));
            return React.createElement(IndicatorSettingsModal, {
                inst, timeframes: [{ label: '1m', minutes: 1 }],
                onPatch: patch => setInst(current => ({ ...current, ...patch })),
                onRemove() {}, onCancel() {}, onCommit() { window.__qaIndicatorCommits++; },
            });
        }
        const mount = document.createElement('div');
        document.body.append(mount);
        createRoot(mount).render(React.createElement(Harness));
    });
    const dialog = page.getByRole('dialog', { name: '指標設定', exact: true });
    await dialog.getByRole('tab', { name: '樣式', exact: true }).click();
    await dialog.getByTitle('顏色 / 透明度 / 粗細', { exact: true }).click();
    // Replay the real utility rules after the component CSS, as lazy loading
    // and HMR can do; the label must remain readable in either load order.
    await page.evaluate(() => {
        const selectors = new Set(['.bg-background', '.bg-primary', '.text-primary-foreground', '.bg-destructive-solid', '.text-destructive-foreground', '.border-input', '.hover\\:brightness-110:hover', '.hover\\:bg-accent:hover', '.hover\\:text-accent-foreground:hover']);
        const late = new Set();
        const visit = rules => {
            for (const rule of rules) {
                if (selectors.has(rule.selectorText)) late.add(rule.cssText);
                if (rule.cssRules) visit(rule.cssRules);
            }
        };
        for (const sheet of document.styleSheets) { try { visit(sheet.cssRules); } catch { /* External fonts. */ } }
        if (!late.size) throw new Error('Missing actual utility CSS for the load-order regression.');
        const style = document.createElement('style');
        style.textContent = [...late].join('\n');
        document.head.append(style);
    });
    const confirm = dialog.getByRole('button', { name: '確定', exact: true });
    const remove = dialog.getByRole('button', { name: '移除', exact: true });
    const results = [];
    for (const mode of ['dark', 'light']) {
        await page.evaluate(async mode => {
            const { setThemeSettings } = await import('/src/lib/theme-store.ts');
            setThemeSettings({ mode, custom: undefined, accent: undefined });
        }, mode);
        for (const [name, control] of [['確定', confirm], ['移除', remove]]) {
            await page.mouse.move(5, 5);
            await settle(control);
            await expect(control).toHaveText(name);
            await expect.poll(async () => (await contrast(control)).ratio, { message: `${mode}: ${name}文字必須可讀` }).toBeGreaterThanOrEqual(4.5);
            results.push({ mode, button: name, state: 'normal', ...await contrast(control) });
            await control.hover();
            await settle(control);
            await expect.poll(async () => (await contrast(control)).ratio, { message: `${mode}: ${name} hover文字必須可讀` }).toBeGreaterThanOrEqual(4.5);
            results.push({ mode, button: name, state: 'hover', ...await contrast(control) });
            await control.focus();
            await expect(control).toBeFocused();
            await expect.poll(async () => (await contrast(control)).ratio).toBeGreaterThanOrEqual(4.5);
        }
        await page.screenshot({ path: path.join(artifacts, `indicator-confirm-${mode}.png`), animations: 'disabled' });
    }
    await confirm.click();
    expect(await page.evaluate(() => window.__qaIndicatorCommits)).toBe(1);
    return results;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const origin = process.env.INDICATOR_UI_ORIGIN || 'http://localhost:5624';
    const artifacts = process.env.INDICATOR_ARTIFACT_DIR || await mkdtemp(path.join(tmpdir(), 'fubon-indicator-confirm-'));
    await mkdir(artifacts, { recursive: true });
    const browser = await chromium.launch({ channel: 'chrome', headless: true });
    const page = await browser.newPage({ viewport: { width: 1100, height: 850 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    try {
        const results = await indicatorSettingsChecks(page, origin, artifacts);
        expect(errors).toEqual([]);
        await writeFile(path.join(artifacts, 'summary.json'), JSON.stringify({ passed: true, results, errors }, null, 2));
        console.log(JSON.stringify({ passed: true, results, artifacts }));
    } catch (error) {
        await page.screenshot({ path: path.join(artifacts, 'failure.png'), animations: 'disabled' });
        console.error(`Artifacts: ${artifacts}`);
        throw error;
    } finally { await browser.close(); }
}
