import { expect } from '@playwright/test';
import path from 'node:path';

/** Separate demo browser storage: never changes the user's or other QA panels. */
export async function maLegendChecks(browser, source, origin, artifacts) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    try {
        const session = await source.evaluate(() => sessionStorage.getItem('fubon-trading-session'));
        await context.addInitScript(session => {
            sessionStorage.setItem('fubon-trading-session', session);
            const periods = [200, 5, 10, 20, 60, 120, 240];
            const colors = ['#e0a43c', '#ec853c', '#19b6c9', '#ecc93c', '#b06fff', '#1fd286', '#ff4d6a'];
            localStorage.setItem('sj-pro-indicators-v2', JSON.stringify(periods.map((period, index) => ({
                id: `qa-ma-${period}`, type: 'sma', params: { period }, colors: {}, styles: { line: { color: colors[index] } },
            }))));
        }, session);
        await page.goto(origin);
        await expect(page.getByText('LIVE', { exact: true })).toBeVisible();
        const row = page.locator('[data-ma-legend="row"]');
        const items = row.locator('[data-ma-period]');
        await expect(items).toHaveCount(7);
        await expect(row.locator('[data-ma-direction]').first()).toBeVisible();
        const oneLine = async () => {
            const rects = await items.evaluateAll(items => items.map(item => item.getBoundingClientRect().y));
            expect(Math.max(...rects) - Math.min(...rects)).toBeLessThanOrEqual(1);
            expect((await row.boundingBox()).height).toBeLessThanOrEqual(40);
        };
        await oneLine();
        for (const item of await items.all()) expect(await item.textContent()).toMatch(/^\(\d+\)[\d,.—]+[▲▼→]?$/);
        for (const arrow of await row.locator('[data-ma-direction]').all()) {
            const direction = Number(await arrow.getAttribute('data-ma-direction'));
            await expect(arrow).toHaveText(direction === 1 ? '▲' : direction === -1 ? '▼' : '→');
        }
        await row.locator('[data-ma-period="5"]').click();
        const settings = page.getByRole('dialog', { name: '指標設定', exact: true });
        await expect(settings).toBeVisible();
        await settings.getByRole('button', { name: '取消', exact: true }).click();
        const ma5 = row.locator('[data-ma-period="5"]');
        await row.getByRole('button', { name: '管理移動平均線', exact: true }).click();
        await page.getByRole('menuitem', { name: 'MA(5)', exact: true }).hover();
        await page.getByRole('menuitem', { name: '隱藏', exact: true }).click();
        await expect(ma5).toHaveAttribute('data-dimmed', 'true');
        await expect(ma5).toHaveText('(5)');
        await row.getByRole('button', { name: '管理移動平均線', exact: true }).click();
        await page.getByRole('menuitem', { name: 'MA(5) · 已隱藏', exact: true }).hover();
        await page.getByRole('menuitem', { name: '顯示', exact: true }).click();
        await expect(ma5).toHaveAttribute('data-dimmed', 'false');
        const chart = page.locator('[data-block-id="chart-0"]');
        await chart.screenshot({ path: path.join(artifacts, 'ma-legend-dark.png'), animations: 'disabled' });
        await page.evaluate(async () => (await import('/src/lib/theme-store.ts')).setThemeSettings({ mode: 'light' }));
        await chart.screenshot({ path: path.join(artifacts, 'ma-legend-light.png'), animations: 'disabled' });
        await page.setViewportSize({ width: 390, height: 844 });
        await chart.scrollIntoViewIfNeeded();
        await oneLine();
        const scroll = row.getByRole('group', { name: '均線數值，可左右捲動', exact: true });
        await expect.poll(() => scroll.evaluate(el => el.scrollWidth > el.clientWidth)).toBe(true);
        await scroll.focus();
        await page.keyboard.press('End');
        // Keyboard navigation can reach the last average without expanding vertically.
        await items.last().focus();
        await expect(items.last()).toBeInViewport();
        await chart.screenshot({ path: path.join(artifacts, 'ma-legend-narrow.png'), animations: 'disabled' });
        expect(errors).toEqual([]);
    } catch (error) {
        await page.screenshot({ path: path.join(artifacts, 'ma-legend-failure.png'), animations: 'disabled' });
        throw error;
    } finally { await context.close(); }
}
