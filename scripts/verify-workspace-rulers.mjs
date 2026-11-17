import { expect } from '@playwright/test';
import path from 'node:path';
import { calcGridItemPosition } from 'react-grid-layout';

/** Called only by the isolated demo/virtual-Passkey browser harness. */
export async function workspaceRulerChecks(page, artifacts) {
    // These assertions compare layout geometry, not transition animation.
    // A keyboard resize can schedule its CSS transition a frame after keyup.
    await page.addStyleTag({ content: '.react-grid-item { transition: none !important; }' });
    const key = 'sj-pro-workspace-v3';
    const stored = () => page.evaluate(key => JSON.parse(localStorage.getItem(key)), key);
    const geometry = () => page.locator('[data-block-id]').evaluateAll(items => items.map(item => ({
        id: item.dataset.blockId, width: item.getBoundingClientRect().width,
        height: item.getBoundingClientRect().height, x: item.getBoundingClientRect().x, y: item.getBoundingClientRect().y,
    })));
    const guide = page.locator('[data-ruler-dragging]');
    const column = page.getByRole('separator', { name: '整欄分界 1', exact: true });
    const row = page.getByRole('separator', { name: '整列分界 2', exact: true });
    await expect(column).toBeVisible();
    // A first visit uses DEFAULT_WORKSPACE in memory until the first edit.
    if (!await stored()) {
        await column.focus(); await page.keyboard.press('ArrowRight');
        await column.focus(); await page.keyboard.press('ArrowLeft');
    }
    const before = await stored();
    // RGL also synchronizes controlled layout in a passive effect. Wait for
    // the saved geometry, rather than sampling the preceding keyboard frame.
    const grid = await page.locator('.react-grid-layout').boundingBox();
    const original = before.layout.map(item => {
        const position = calcGridItemPosition({ containerWidth: grid.width, cols: 24, rowHeight: 30,
            margin: [6, 6], containerPadding: [6, 6], maxRows: Infinity }, item.x / 12, item.y, item.w / 12, item.h);
        return { id: item.i, width: position.width, height: position.height, x: grid.x + position.left, y: grid.y + position.top };
    });
    await expect.poll(geometry).toEqual(original);
    const frame = await column.boundingBox();
    await page.mouse.move(frame.x + frame.width / 2, frame.y + frame.height / 2);
    await page.mouse.down();
    await page.mouse.move(frame.x + frame.width / 2 + 62, frame.y + frame.height / 2, { steps: 5 });
    await expect(guide).toHaveAttribute('data-ruler-dragging', 'x');
    expect(await stored()).toEqual(before);
    await page.screenshot({ path: path.join(artifacts, 'workspace-ruler-preview.png'), animations: 'disabled' });
    await page.keyboard.press('Escape');
    await page.mouse.up();
    await expect(guide).toHaveCount(0);
    await expect.poll(geometry).toEqual(original);
    expect(await stored()).toEqual(before);

    // One keyboard step changes every panel sharing x=4, including chart/dock
    // on different rows, while the far-right column remains fixed.
    await column.focus();
    await page.keyboard.press('ArrowRight');
    await expect.poll(stored).not.toEqual(before);
    const columnSaved = await stored();
    const item = (workspace, id) => workspace.layout.find(item => item.i === id);
    expect(item(columnSaved, 'watchlist-0').w).toBe(item(before, 'watchlist-0').w + 12);
    for (const id of ['chart-0', 'dock-0']) {
        expect(item(columnSaved, id).x).toBe(item(before, id).x + 12);
        expect(item(columnSaved, id).w).toBe(item(before, id).w - 12);
    }
    expect(item(columnSaved, 'ticket-0')).toEqual(item(before, 'ticket-0'));

    // y=16 grows the chart and shrinks the dock; panels spanning this cut stay put.
    await row.focus();
    await page.keyboard.press('ArrowDown');
    const rowSaved = await stored();
    expect(item(rowSaved, 'chart-0').h).toBe(item(before, 'chart-0').h + 1);
    expect(item(rowSaved, 'dock-0').y).toBe(item(before, 'dock-0').y + 1);
    expect(item(rowSaved, 'dock-0').h).toBe(item(before, 'dock-0').h - 1);
    expect(item(rowSaved, 'watchlist-0')).toEqual(item(columnSaved, 'watchlist-0'));
    await page.reload();
    await expect(page.getByText('LIVE', { exact: true })).toBeVisible();
    await expect(column).toHaveAttribute('aria-valuenow', '5');
    expect(await stored()).toEqual(rowSaved);
    await page.screenshot({ path: path.join(artifacts, 'workspace-rulers-dark.png'), animations: 'disabled' });

    // Restore the initial demo arrangement for the harness's other checks.
    await column.focus(); await page.keyboard.press('ArrowLeft');
    await row.focus(); await page.keyboard.press('ArrowUp');
    await expect.poll(stored).toEqual(before);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(column).toBeHidden();
    expect(await stored()).toEqual(before);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await expect(column).toBeVisible();

    const settings = page.getByRole('button', { name: '尺標精細度', exact: true });
    const choosePrecision = async name => {
        await settings.click();
        await page.getByRole('radio', { name, exact: true }).click();
        await page.keyboard.press('Escape');
    };
    await choosePrecision('極細');
    expect(await stored()).toEqual(before); // Changing the snap interval never moves panels.
    await column.focus(); await page.keyboard.press('ArrowRight');
    await row.focus(); await page.keyboard.press('ArrowDown');
    const fine = await stored();
    expect(item(fine, 'watchlist-0').w).toBe(item(before, 'watchlist-0').w + 3);
    expect(item(fine, 'chart-0').h).toBe(item(before, 'chart-0').h + 0.25);
    expect(item(fine, 'dock-0').y).toBe(item(before, 'dock-0').y + 0.25);
    expect(fine.preciseGrid).toBe(true);
    await page.reload();
    await expect(page.getByText('LIVE', { exact: true })).toBeVisible();
    await expect(settings).toHaveAttribute('title', '尺標精細度：極細');
    expect(await stored()).toEqual(fine);
    await choosePrecision('標準');
    expect(await stored()).toEqual(fine);
    for (const width of [1910, 3000, 4200, 390, 1440]) await page.setViewportSize({ width, height: 1000 });
    expect(await stored()).toEqual(fine);
    await page.reload();
    await expect(page.getByText('LIVE', { exact: true })).toBeVisible();
    await expect(settings).toHaveAttribute('title', '尺標精細度：標準');
    expect(await stored()).toEqual(fine);
    await settings.click();
    await page.screenshot({ path: path.join(artifacts, 'workspace-ruler-precision.png'), animations: 'disabled' });
    await page.keyboard.press('Escape');
    // Keep the broader harness on its original demo fixture, including metadata.
    await page.evaluate(({ key, before }) => localStorage.setItem(key, JSON.stringify(before)), { key, before });
    await page.reload();
    await expect(page.getByText('LIVE', { exact: true })).toBeVisible();
}
