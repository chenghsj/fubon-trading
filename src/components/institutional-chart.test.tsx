import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NativeResult } from '../lib/native-panels';
import { InstitutionalChart } from './institutional-chart';
import { SelectControl } from './ui/select-control';
import { ToggleGroup } from './ui/toggle-group';

// Source shape is the native flattened response; figures are synthetic.
const data: NativeResult = { operation: 'institutional', source: 'fubon', fetched_at: '2026-11-17',
    columns: [], detail_keys: [], summary: {}, metadata: { symbol: '2330' }, note: '', rows: [
        { date: '2026-11-10', 'foreign.buy': 2000, 'foreign.sell': 500, 'foreign.net': 1500, 'trust.net': 100, 'dealer.net': -200, total: 1400 },
        { date: '2026-11-11', 'foreign.net': -1000, 'trust.net': 0, 'dealer.net': 500, total: -500 },
    ] };
const text = (node: ReactTestInstance | string): string => typeof node === 'string' ? node : node.children.map(text).join('');
let view: ReactTestRenderer;
beforeEach(() => vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true));
afterEach(() => { if (view) act(() => view.unmount()); vi.unstubAllGlobals(); });

describe('法人圖表與每日明細', () => {
    it('切換法人、累計和單位時，圖表、明細、摘要同步更新', () => {
        act(() => { view = create(<InstitutionalChart data={data}/>); });
        const root = () => view.root;
        const select = () => root().findAllByType(SelectControl);
        const group = () => root().findAllByType(ToggleGroup);
        const button = (label: string) => root().findAllByType('button').find(node => text(node).startsWith(label))!;
        expect(text(button('三大法人合計'))).toContain('+0.9 張');
        const chart = () => root().findAllByType('svg').find(node => node.props.role === 'img')!;
        expect(chart().props['aria-label']).toContain('單位張');
        expect(text(root().findByType('table'))).toContain('外資買進（張）');
        act(() => group()[0]!.props.onValueChange('foreign.net'));
        expect(text(root().findByType('output'))).toContain('-1 張');
        act(() => group()[1]!.props.onValueChange('cumulative'));
        expect(text(root().findByType('output'))).toContain('+0.5 張');
        act(() => select()[0]!.props.onValueChange('shares'));
        expect(text(root().findByType('output'))).toContain('+500 股');
        expect(text(root().findByType('table'))).toContain('外資買進（股）');
        act(() => select()[1]!.props.onValueChange('2026-11-10'));
        expect(text(root().findByType('output'))).toContain('+1,500 股');
        expect(chart().findAll(node => Object.values(node.props).some(value => typeof value === 'number' && !Number.isFinite(value)))).toHaveLength(0);
    });
    it('無資料與全缺值顯示未知，沒有虛構零值或失效圖形', () => {
        act(() => { view = create(<InstitutionalChart data={{ ...data, rows: [] }}/>); });
        expect(view.root.findAllByType('svg')).toHaveLength(0);
        expect(text(view.root)).toContain('來源未回傳符合條件的資料');
        act(() => view.update(<InstitutionalChart data={{ ...data, rows: [{ date: '2026-11-17', total: null }] }}/>));
        expect(text(view.root.findByType('output'))).toContain('— 張');
        expect(text(view.root)).toContain('目前走勢有 1 筆未知值');
        const svg = view.root.findAllByType('svg').find(node => node.props.role === 'img')!;
        expect(svg.findAll(node => Object.values(node.props).some(value => typeof value === 'number' && !Number.isFinite(value)))).toHaveLength(0);
    });
});
