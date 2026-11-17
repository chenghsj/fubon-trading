import { expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

/** Native e/s/se gestures in isolated demo storage, including fractional edges. */
export async function workspaceResizeChecks(browser, source, origin, artifacts) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage();
    const errors = [];
    const results = [];
    page.on('pageerror', error => errors.push(error.message));
    const key = 'sj-pro-workspace-v3';
    const precisionKey = 'fubon-workspace-ruler-precision';
    const stored = () => page.evaluate(key => JSON.parse(localStorage.getItem(key)), key);
    const cell = id => page.locator(`[data-block-id="${id}"]`);
    const item = (workspace, id) => workspace.layout.find(item => item.i === id);
    const fixture = layout => ({ preciseGrid: true, blocks: layout.map(item => ({ id: item.i, type: 'depth', pin: null })), layout });
    const horizontal = () => fixture([
        { i: 'resize-a', x: 0, y: 0, w: 140, h: 8.25, minH: 4 },
        { i: 'resize-b', x: 153, y: 0, w: 135, h: 8.25, minH: 4 },
    ]);
    const seed = async (workspace, precision = 'finest') => {
        await page.evaluate(({ key, precisionKey, workspace, precision }) => {
            localStorage.setItem(key, JSON.stringify(workspace));
            localStorage.setItem(precisionKey, precision);
        }, { key, precisionKey, workspace, precision });
        await page.reload();
        await expect(page.getByText('LIVE', { exact: true })).toBeVisible();
        await expect(cell(workspace.blocks[0].id)).toBeVisible();
        await expect.poll(async () => (await stored()).layout).toEqual(workspace.layout);
        // A mount first projects the unmeasured grid, then RGL synchronizes it
        // in a passive effect. Wait for the stored geometry, not that first DOM.
        await expect.poll(() => page.evaluate(async layout => {
            const { calcGridItemPosition } = await import('/node_modules/.vite/deps/react-grid-layout.js');
            const grid = document.querySelector('.react-grid-layout').getBoundingClientRect();
            return layout.filter(item => {
                const actual = document.querySelector(`[data-block-id="${item.i}"]`).getBoundingClientRect();
                const expected = calcGridItemPosition({ containerWidth: grid.width, cols: 72, rowHeight: 30,
                    margin: [6, 6], containerPadding: [6, 6], maxRows: Infinity }, item.x / 4, item.y, item.w / 4, item.h);
                return Math.abs(actual.x - grid.x - expected.left) > 0.5 || Math.abs(actual.y - grid.y - expected.top) > 0.5
                    || Math.abs(actual.width - expected.width) > 0.5 || Math.abs(actual.height - expected.height) > 0.5;
            }).map(item => item.i);
        }, workspace.layout)).toEqual([]);
    };
    const begin = async (id, handle) => {
        const target = cell(id).locator(`.react-resizable-handle-${handle}`);
        await cell(id).hover();
        const rect = await target.boundingBox();
        const pointer = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
        await page.mouse.move(pointer.x, pointer.y);
        await page.mouse.down();
        await expect(cell(id)).toHaveClass(/\bresizing\b/);
        return pointer;
    };
    const move = async (pointer, dx, dy = 0) => page.mouse.move(pointer.x + dx, pointer.y + dy, { steps: 8 });
    const drag = async (id, handle, dx, dy = 0) => {
        const pointer = await begin(id, handle);
        await move(pointer, dx, dy);
        await page.mouse.up();
        await expect(cell(id)).not.toHaveClass(/\bresizing\b/);
    };
    const columnStep = async () => ((await page.locator('.react-grid-layout').boundingBox()).width - 6) / 72;
    try {
        const session = await source.evaluate(() => sessionStorage.getItem('fubon-trading-session'));
        await context.addInitScript(session => sessionStorage.setItem('fubon-trading-session', session), session);
        await page.goto(origin);
        await expect(page.getByText('LIVE', { exact: true })).toBeVisible();

        for (const precision of ['standard', 'fine', 'finest']) {
            await seed(horizontal(), precision);
            const step = await columnStep();
            const neighborY = (await cell('resize-b').boundingBox()).y;
            const pointer = await begin('resize-a', 'e');
            await move(pointer, (38.25 - 35) * step);
            // The native preview must not compact the adjacent panel down.
            await expect.poll(async () => (await cell('resize-b').boundingBox()).y).toBe(neighborY);
            await page.mouse.up();
            await expect.poll(async () => item(await stored(), 'resize-a').w).toBe(153);
            const saved = await stored();
            expect(item(saved, 'resize-a').h).toBe(8.25); // e preserves the untouched fractional axis.
            expect(item(saved, 'resize-b')).toEqual(item(horizontal(), 'resize-b'));
            const overshoot = await begin('resize-a', 'e');
            await move(overshoot, 60);
            await expect.poll(() => page.evaluate(() => {
                const a = document.querySelector('[data-block-id="resize-a"]').getBoundingClientRect();
                const b = document.querySelector('[data-block-id="resize-b"]').getBoundingClientRect();
                return Math.abs(b.x - a.right - 6);
            })).toBeLessThanOrEqual(1); // The actual panel preview also stops at the shared edge.
            if (precision === 'finest') await page.screenshot({ path: path.join(artifacts, 'workspace-native-resize-preview.png'), animations: 'disabled' });
            await page.mouse.up();
            await expect(page.locator('[data-workspace-resizing]')).toHaveCount(0);
            expect((await stored()).layout).toEqual(saved.layout);
            await page.reload();
            await expect(page.getByText('LIVE', { exact: true })).toBeVisible();
            expect((await stored()).layout).toEqual(saved.layout);
            results.push({ case: `native e / ${precision}`, layout: saved.layout });
        }

        await seed(horizontal());
        await drag('resize-a', 'se', (38.25 - 35) * await columnStep(), 9);
        const corner = await stored();
        expect(item(corner, 'resize-a')).toMatchObject({ w: 153, h: 8.5 });
        expect(item(corner, 'resize-b')).toEqual(item(horizontal(), 'resize-b'));
        await page.screenshot({ path: path.join(artifacts, 'workspace-native-resize-aligned.png'), animations: 'disabled' });
        results.push({ case: 'native se / finest', layout: corner.layout });

        const stacked = () => fixture([
            { i: 'resize-a', x: 0, y: 0, w: 144, h: 8.25, minH: 4 },
            { i: 'resize-b', x: 144, y: 0, w: 144, h: 20, minH: 4 },
            { i: 'resize-c', x: 0, y: 8.25, w: 144, h: 4, minH: 4 },
            { i: 'resize-d', x: 0, y: 12.25, w: 144, h: 4, minH: 4 },
        ]);
        for (const precision of ['standard', 'fine', 'finest']) {
            for (const handle of ['s', 'se']) {
                await seed(stacked(), precision);
                const sideBefore = await cell('resize-b').boundingBox();
                const pointer = await begin('resize-a', handle);
                await move(pointer, handle === 'se' ? 60 : 0, 108);
                await expect.poll(async () => (await cell('resize-a').boundingBox()).height).toBe(399);
                // The lower stack follows the resized card while the side
                // column stays aligned, including when the corner overshoots.
                await expect.poll(async () => (await cell('resize-c').boundingBox()).y - (await cell('resize-a').boundingBox()).y).toBe(405);
                const sideDuring = await cell('resize-b').boundingBox();
                // RGL's mount transition can still be finishing within half
                // a CSS pixel; a real relocation changes whole rows/columns.
                for (const dimension of ['x', 'y', 'width', 'height']) expect(Math.abs(sideDuring[dimension] - sideBefore[dimension])).toBeLessThanOrEqual(0.5);
                expect((await stored()).layout).toEqual(stacked().layout);
                await page.mouse.up();
                await expect.poll(async () => item(await stored(), 'resize-a').h).toBe(11.25);
                const expanded = await stored();
                expect(item(expanded, 'resize-a').w).toBe(144);
                expect(item(expanded, 'resize-c').y).toBe(11.25);
                expect(item(expanded, 'resize-d').y).toBe(15.25);
                expect(item(expanded, 'resize-b')).toEqual(item(stacked(), 'resize-b'));
                if (precision === 'finest' && handle === 'se') await page.screenshot({ path: path.join(artifacts, 'workspace-native-resize-down.png'), animations: 'disabled' });
                await page.reload();
                await expect(page.getByText('LIVE', { exact: true })).toBeVisible();
                expect((await stored()).layout).toEqual(expanded.layout);
                await drag('resize-a', handle, 0, -108);
                await expect.poll(async () => (await stored()).layout).toEqual(stacked().layout);
                results.push({ case: `native ${handle} / ${precision} / lower stack flows down and back`, layout: expanded.layout });
            }
        }

        // A bottom-only gesture preserves the exact fractional column width.
        await seed(fixture([{ i: 'resize-a', x: 0, y: 0, w: 147, h: 8.25, minH: 4, maxH: 9 }]));
        await drag('resize-a', 's', 0, 9);
        expect(item(await stored(), 'resize-a')).toMatchObject({ w: 147, h: 8.5 });
        await drag('resize-a', 's', 0, 100);
        expect(item(await stored(), 'resize-a').h).toBe(9);
        await drag('resize-a', 's', 0, -200);
        expect(item(await stored(), 'resize-a').h).toBe(4);
        await drag('resize-a', 'e', (72 - 147 / 4) * await columnStep() + 10);
        expect(item(await stored(), 'resize-a').w).toBe(288);
        results.push({ case: 'native s preserves width / minH / maxH / column bound', layout: (await stored()).layout });

        // Pointer-to-grid calculations stay in the gesture's starting viewport.
        await seed(horizontal());
        const step = await columnStep();
        const neighborBefore = await cell('resize-b').boundingBox();
        const pointer = await begin('resize-a', 'e');
        await page.setViewportSize({ width: 1910, height: 1000 });
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        const neighborDuring = await cell('resize-b').boundingBox();
        expect(neighborDuring.x).toBe(neighborBefore.x);
        expect(neighborDuring.width).toBe(neighborBefore.width);
        await move(pointer, (38.25 - 35) * step);
        await page.mouse.up();
        await expect.poll(async () => item(await stored(), 'resize-a').w).toBe(153);
        expect(item(await stored(), 'resize-b').y).toBe(0);
        await page.setViewportSize({ width: 1440, height: 1000 });
        results.push({ case: 'native resize viewport freeze', layout: (await stored()).layout });

        // Nearby ruler hit targets form one junction, without covering each other.
        const grouped = fixture([
            { i: 'resize-a', x: 0, y: 0, w: 147, h: 8, minH: 4 },
            { i: 'resize-b', x: 147, y: 0, w: 141, h: 8, minH: 4 },
            { i: 'resize-c', x: 0, y: 8, w: 149, h: 8, minH: 4 },
            { i: 'resize-d', x: 149, y: 8, w: 139, h: 8, minH: 4 },
        ]);
        await seed(grouped);
        const junction = page.getByRole('separator', { name: '整欄分界 1', exact: true });
        await expect(page.locator('[role="separator"][data-axis="x"]')).toHaveCount(1);
        expect(await junction.evaluate(el => {
            const rect = el.getBoundingClientRect();
            return document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)?.closest('[role="separator"]') === el;
        })).toBe(true);
        const start = await junction.boundingBox();
        const junctionPointer = { x: start.x + start.width / 2, y: start.y + start.height / 2 };
        await page.mouse.move(junctionPointer.x, junctionPointer.y); await page.mouse.down();
        await move(junctionPointer, 15);
        await expect(page.locator('[data-ruler-dragging]')).toHaveCount(1);
        expect((await stored()).layout).toEqual(grouped.layout);
        await page.keyboard.press('Escape'); await page.mouse.up();
        await expect(page.locator('[data-ruler-dragging]')).toHaveCount(0);
        expect((await stored()).layout).toEqual(grouped.layout);
        await junction.focus(); await page.keyboard.press('ArrowRight');
        await expect.poll(async () => item(await stored(), 'resize-a').w).toBe(150);
        expect(item(await stored(), 'resize-c').w).toBe(152);
        expect(item(await stored(), 'resize-b').x).toBe(150);
        expect(item(await stored(), 'resize-d').x).toBe(152);
        results.push({ case: 'grouped ruler / cancel and coupled commit', layout: (await stored()).layout });
        await page.screenshot({ path: path.join(artifacts, 'workspace-ruler-grouped.png'), animations: 'disabled' });
        expect(errors).toEqual([]);
        await writeFile(path.join(artifacts, 'workspace-resize-summary.json'), JSON.stringify({ passed: true, results, errors }, null, 2));
    } catch (error) {
        await page.screenshot({ path: path.join(artifacts, 'workspace-resize-failure.png'), animations: 'disabled' }).catch(() => {});
        await writeFile(path.join(artifacts, 'workspace-resize-summary.json'), JSON.stringify({ passed: false, results, errors }, null, 2));
        throw error;
    } finally { await context.close(); }
}
