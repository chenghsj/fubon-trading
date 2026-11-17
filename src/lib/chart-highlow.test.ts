import { describe, expect, it, vi } from 'vitest';
import { barsAt, HighLowLayer, layoutMark, visibleHighLow } from './chart-highlow';

const bar = (high: number, low: number) => ({ high, low });

describe('visibleHighLow (#240)', () => {
    const bars = [bar(10, 5), bar(14, 9), bar(12, 3), bar(14, 8), bar(11, 6)];
    const at = barsAt(bars);
    it('finds the highest and lowest bar inside the visible logical range', () => {
        expect(visibleHighLow(at, 0, 4)).toEqual({ high: { index: 3, price: 14 }, low: { index: 2, price: 3 } });
    });
    it('ties pick the most recent bar; partially visible edge bars count (floor/ceil like lightweight-charts)', () => {
        expect(visibleHighLow(at, -3.5, 0.6)).toEqual({ high: { index: 1, price: 14 }, low: { index: 0, price: 5 } });
        expect(visibleHighLow(at, 2.8, 99)).toEqual({ high: { index: 3, price: 14 }, low: { index: 2, price: 3 } });
        expect(visibleHighLow(at, 3.2, 3.9)).toEqual({ high: { index: 3, price: 14 }, low: { index: 4, price: 6 } });
    });
    it('skips whitespace / missing logical indices (logical index ≠ array position)', () => {
        const sparse = new Map([[0, bar(10, 5)], [2, bar(12, 4)], [3, bar(11, 7)]]);
        expect(visibleHighLow((i) => sparse.get(i), 2, 3)).toEqual({ high: { index: 2, price: 12 }, low: { index: 2, price: 4 } });
        expect(visibleHighLow((i) => sparse.get(i), 1, 1)).toBeNull();
    });
    it('needs at least two visible bars and finite numbers', () => {
        expect(visibleHighLow(at, 4, 4)).toBeNull();
        expect(visibleHighLow(barsAt([]), 0, 10)).toBeNull();
        expect(visibleHighLow(at, Number.NaN, 3)).toBeNull();
        expect(visibleHighLow(barsAt([bar(Number.NaN, 1), bar(2, 1), bar(3, 2)]), 0, 2)).toEqual({ high: { index: 2, price: 3 }, low: { index: 1, price: 1 } });
    });
});

describe('layoutMark (#240)', () => {
    const pane = { width: 400, height: 200 };
    it('puts the label to the right of the bar with a leader line', () => {
        const l = layoutMark(100, 50, 60, pane);
        expect(l.side).toBe('right');
        expect(l.leaderFrom).toBeGreaterThan(100);
        expect(l.boxX).toBe(l.leaderTo);
        expect(l.boxY + l.boxH / 2).toBe(50);
    });
    it('flips to the left near the right edge and never leaves the pane', () => {
        const l = layoutMark(390, 50, 60, pane);
        expect(l.side).toBe('left');
        expect(l.boxX + l.boxW).toBeLessThanOrEqual(l.leaderTo + 0.001);
        expect(l.boxX).toBeGreaterThanOrEqual(4);
        expect(l.boxX + l.boxW).toBeLessThanOrEqual(396);
    });
    it('clamps vertically while the leader still starts at the wick tip', () => {
        const top = layoutMark(100, 1, 60, pane);
        expect(top.boxY).toBe(4);
        expect(top.tipY).toBe(1);
        const bottom = layoutMark(100, 199, 60, pane);
        expect(bottom.boxY + bottom.boxH).toBe(196);
    });
    it('very narrow panes keep the label inside', () => {
        const l = layoutMark(100, 50, 100, { width: 120, height: 80 });
        expect(l.boxX).toBeGreaterThanOrEqual(4);
        expect(l.boxX + l.boxW).toBeLessThanOrEqual(116);
    });
});

describe('HighLowLayer (#240)', () => {
    const data = [
        { time: 100, high: 10, low: 5 },
        { time: 160, high: 18.5, low: 9 },
        { time: 220, high: 12, low: 2.25 },
    ];
    function attach(range: { from: number; to: number } | null, coordinate = (p: number) => 180 - p * 8, invertScale = false, rows = data, paneHeight = 200) {
        const requestUpdate = vi.fn();
        const layer = new HighLowLayer({
            visible: true, highColor: '#f23645', lowColor: '#16b389', labelBg: '#10131a', border: '#1a1f29', mutedText: '#7e8798',
            format: (p) => p.toFixed(2),
        });
        const series = { dataByIndex: (i: number) => rows[i] ?? null, priceToCoordinate: coordinate,
            priceScale: () => ({ options: () => ({ invertScale, scaleMargins: {top:0.2,bottom:0.1} }) }),
            getPane: () => ({ getHeight: () => paneHeight }) };
        const chart = { timeScale: () => ({ getVisibleLogicalRange: () => range, timeToCoordinate: (t: number) => t }) };
        layer.attached({ series, chart, requestUpdate } as never);
        return { layer, requestUpdate };
    }

    it('marks the visible high (up colour) and low (down colour) with Traditional Chinese words', () => {
        const { layer } = attach({ from: 0, to: 2 });
        expect(layer.marks()).toEqual([
            { word: '最高', value: '18.50', color: '#f23645', x: 160, y: 32, labelY: 21 },
            { word: '最低', value: '2.25', color: '#16b389', x: 220, y: 162, labelY: 173 },
        ]);
    });

    it('follows the visible range; hidden or no range draws nothing', () => {
        const { layer, requestUpdate } = attach({ from: 2.2, to: 2.4 });
        expect(layer.marks()).toEqual([]);
        layer.setStyle({ visible: false });
        expect(requestUpdate).toHaveBeenCalled();
        expect(attach(null).layer.marks()).toEqual([]);
        const hidden = attach({ from: 0, to: 2 }).layer;
        hidden.setStyle({ visible: false });
        expect(hidden.marks()).toEqual([]);
    });

    it('follows an inverted price scale even when flat bars share one wick price', () => {
        const { layer } = attach({from:0,to:1}, () => 100, true,
            [{time:100,high:100,low:100},{time:160,high:100,low:100}]);
        const [high, low] = layer.marks();
        expect(high!.labelY).toBeGreaterThan(high!.y);
        expect(low!.labelY).toBeLessThan(low!.y);
    });

    it('does not reserve margins that would collapse a short pane price range', () => {
        const {layer} = attach({from:0,to:2}, p => 180-p*8, false, data, 40);
        expect(layer.autoscaleInfo()).toBeNull();
    });

    it('omits labels during a degenerate scale projection instead of drawing over candles', () => {
        expect(attach({from:0,to:2}, p => 20+p*0.7).layer.marks()).toEqual([]);
    });

    it('draws a leader, a dot, a label box and both texts per mark', () => {
        const { layer } = attach({ from: 0, to: 2 });
        const texts: [string, string][] = [];
        const ctx: any = new Proxy({}, {
            get: (t: any, p) => {
                if (p === 'measureText') return (s: string) => ({ width: s.length * 6 });
                if (p === 'fillText') return (s: string) => texts.push([s, t.fillStyle]);
                if (p in t) return t[p];
                return () => {};
            },
            set: (t: any, p, v) => { t[p] = v; return true; },
        });
        const view = layer.paneViews()[0]!;
        expect(view.zOrder?.()).toBe('top');
        view.renderer()!.draw({ useMediaCoordinateSpace: (f: any) => f({ context: ctx, mediaSize: { width: 400, height: 200 } }) } as never);
        expect(texts).toEqual([['最高', '#7e8798'], ['18.50', '#f23645'], ['最低', '#7e8798'], ['2.25', '#16b389']]);
        // 窄面板：放不下字樣就只畫數值
        texts.length = 0;
        view.renderer()!.draw({ useMediaCoordinateSpace: (f: any) => f({ context: ctx, mediaSize: { width: 56, height: 200 } }) } as never);
        expect(texts.map(t => t[0])).toEqual(['18.50', '2.25']);
    });

    it('keeps the filled high/low labels outside every visible candle wick', () => {
        const { layer } = attach({ from: 0, to: 2 }, p => 180 - p * 8);
        const boxes: { top: number; bottom: number }[] = [];
        let ys: number[] = [], rounded = false;
        const ctx: any = new Proxy({}, {
            get: (target: any, property) => {
                if (property === 'measureText') return (text: string) => ({ width: text.length * 6 });
                if (property === 'beginPath') return () => { ys = []; rounded = false; };
                if (property === 'moveTo' || property === 'lineTo') return (_x: number, y: number) => ys.push(y);
                if (property === 'arcTo') return (_x: number, y: number, _x2: number, y2: number) => { rounded = true; ys.push(y, y2); };
                if (property === 'fill') return () => { if (rounded) boxes.push({ top: Math.min(...ys), bottom: Math.max(...ys) }); };
                return property in target ? target[property] : () => {};
            },
            set: (target: any, property, value) => { target[property] = value; return true; },
        });
        layer.paneViews()[0]!.renderer()!.draw({ useMediaCoordinateSpace: (draw: any) => draw({
            context: ctx, mediaSize: { width: 400, height: 200 },
        }) } as never);
        expect(boxes).toHaveLength(2);
        const [high, low] = layer.marks();
        // Every visible candle is inside these extrema. The opaque label
        // rectangles must stay outside them, including their full height.
        expect(boxes[0]!.bottom).toBeLessThanOrEqual(high!.y - 3);
        expect(boxes[1]!.top).toBeGreaterThanOrEqual(low!.y + 3);
    });
});
