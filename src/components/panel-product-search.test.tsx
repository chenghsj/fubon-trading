import { createElement, createContext, useContext, useState, type ReactNode } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PRODUCT_SEARCH_DEBOUNCE_MS } from '../lib/search-request';
import { PanelProductSearch } from './panel-product-search';

const mocks = vi.hoisted(() => ({ search: vi.fn(), ensure: vi.fn(), prime: vi.fn() }));
vi.mock('../lib/product-search', () => ({ searchProducts: mocks.search }));
vi.mock('../lib/contracts-cache', () => ({ ensureContract: mocks.ensure, primeContract: mocks.prime }));
// State contracts here; the real Radix portal and focus are exercised in browser QA.
vi.mock('./ui/popover', () => {
    const Open = createContext(false);
    return {
        Popover: ({ children, open }: { children: ReactNode; open: boolean }) => createElement(Open.Provider, { value: open }, children),
        PopoverAnchor: ({ children }: { children: ReactNode }) => children,
        PopoverContent: ({ children }: { children: ReactNode }) => useContext(Open) ? createElement('div', null, children) : null,
    };
});

const suggestions = [
    { code: '2330', name: '台積電', security_type: 'STK', exchange: 'TSE', detail: '股票' },
    { code: 'CDFK6', name: '台積電期貨', security_type: 'FUT', exchange: 'TAIFEX', detail: '202611' },
];
const mounted: ReactTestRenderer[] = [];
function render() {
    const select = vi.fn();
    function Harness() {
        const [value, setValue] = useState('2330');
        return createElement(PanelProductSearch, { value, onChange: setValue, onSelect: select, label: '搜尋鎖定商品', className: '' });
    }
    let view!: ReactTestRenderer;
    act(() => { view = create(createElement(Harness)); });
    mounted.push(view);
    return { view, select };
}
const input = (view: ReactTestRenderer) => view.root.findByType('input');
const active = (view: ReactTestRenderer) => view.root.findAllByType('button').find(node => node.props['aria-selected']);
function key(view: ReactTestRenderer, name: string, ctrlKey = false) {
    const event = { key: name, ctrlKey, preventDefault: vi.fn(), stopPropagation: vi.fn() };
    act(() => input(view).props.onKeyDown(event));
    return event;
}
async function query(view: ReactTestRenderer, value: string) {
    act(() => input(view).props.onChange({ target: { value } }));
    await act(async () => { await vi.advanceTimersByTimeAsync(PRODUCT_SEARCH_DEBOUNCE_MS); });
}
beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.useFakeTimers();
    mocks.search.mockReset().mockResolvedValue(suggestions);
    mocks.ensure.mockReset().mockImplementation(async (code: string) => ({ code }));
    mocks.prime.mockReset();
});
afterEach(() => {
    for (const view of mounted.splice(0)) act(() => view.unmount());
    vi.useRealTimers(); vi.unstubAllGlobals();
});

it('名稱搜尋可用 Ctrl+N/P 循環選取，套用正確期貨型別', async () => {
    const { view, select } = render();
    await query(view, '台積電');
    expect(key(view, 'n', true).preventDefault).toHaveBeenCalled();
    expect(active(view)?.props.id).toContain('CDFK6');
    key(view, 'n', true); expect(active(view)?.props.id).toContain('2330');
    key(view, 'p', true); expect(active(view)?.props.id).toContain('CDFK6');
    await act(async () => { key(view, 'Enter'); });
    expect(mocks.ensure).toHaveBeenCalledWith('CDFK6', 'FUT');
    expect(select).toHaveBeenCalledExactlyOnceWith('CDFK6');
});

it.each([
    { key: 'Process', keyCode: 229 },
    { key: 'ㄙ', keyCode: 0 },
])('圖表搜尋支援中文輸入法的實體 Ctrl+N/P（$key）', async (ime) => {
    const { view, select } = render();
    await query(view, '台積電');
    const press = (code: string, nativeComposing = false) => {
        const event = { ...ime, code, ctrlKey: true, nativeEvent: { isComposing: nativeComposing }, preventDefault: vi.fn() };
        act(() => input(view).props.onKeyDown(event));
        return event;
    };
    expect(press('KeyN').preventDefault).toHaveBeenCalledOnce();
    expect(active(view)?.props.id).toContain('CDFK6');
    expect(press('KeyP').preventDefault).toHaveBeenCalledOnce();
    expect(active(view)?.props.id).toContain('2330');
    expect(press('KeyN', true).preventDefault).not.toHaveBeenCalled();
    expect(active(view)?.props.id).toContain('2330');
    expect(select).not.toHaveBeenCalled();
    act(() => input(view).props.onCompositionStart());
    expect(press('KeyN').preventDefault).not.toHaveBeenCalled();
    expect(press('KeyP').preventDefault).not.toHaveBeenCalled();
});

it('Esc 後仍留在輸入框的中文組字，不會被重新開啟搜尋清掉', async () => {
    const { view, select } = render();
    await query(view, '台積電'); key(view, 'Escape');
    act(() => input(view).props.onCompositionStart());
    await query(view, '聯');
    expect(key(view, 'n', true).preventDefault).not.toHaveBeenCalled();
    expect(key(view, 'p', true).preventDefault).not.toHaveBeenCalled();
    key(view, 'Enter');
    expect(select).not.toHaveBeenCalled();
    expect(mocks.ensure).not.toHaveBeenCalled();
    act(() => input(view).props.onCompositionEnd({ currentTarget: { value: '聯發科' } }));
    await act(async () => { await vi.advanceTimersByTimeAsync(PRODUCT_SEARCH_DEBOUNCE_MS); });
    expect(mocks.search).toHaveBeenLastCalledWith('聯發科', 10, expect.any(Object));
});

it('商品解析晚到時，關閉或新的輸入不會套用舊商品', async () => {
    let finish!: (value: { code: string }) => void;
    mocks.ensure.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const { view, select } = render();
    await query(view, '台積電');
    key(view, 'Enter');
    key(view, 'Escape');
    await query(view, '2454');
    await act(async () => { finish({ code: '2330' }); });
    expect(select).not.toHaveBeenCalled();
    expect(input(view).props.value).toBe('2454');
});

it('舊解析尚未完成時仍可選新商品，晚到的舊結果不覆蓋新選擇', async () => {
    let finishOld!: (value: { code: string }) => void;
    mocks.ensure.mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve; }))
        .mockResolvedValueOnce({ code: 'CDFK6' });
    const { view, select } = render();
    await query(view, '台積電'); key(view, 'Enter');
    key(view, 'Escape');
    await query(view, '期貨'); key(view, 'n', true);
    await act(async () => { key(view, 'Enter'); });
    expect(select).toHaveBeenCalledExactlyOnceWith('CDFK6');
    await act(async () => { finishOld({ code: '2330' }); });
    expect(select).toHaveBeenCalledExactlyOnceWith('CDFK6');
    expect(input(view).props.value).toBe('CDFK6');
});

it('沒有搜尋建議時仍可直接解析連續期貨代碼', async () => {
    mocks.search.mockResolvedValue([]);
    const { view, select } = render();
    await query(view, 'txf1!');
    await act(async () => { key(view, 'Enter'); });
    expect(mocks.ensure).toHaveBeenCalledWith('TXF1!', undefined);
    expect(select).toHaveBeenCalledExactlyOnceWith('TXF1!');
});

it('名稱沒有搜尋結果時不能當作鎖定代碼套用', async () => {
    mocks.search.mockResolvedValue([]);
    const { view, select } = render();
    await query(view, '不存在的公司'); key(view, 'Enter');
    expect(select).not.toHaveBeenCalled(); expect(mocks.ensure).not.toHaveBeenCalled();
    expect(view.root.findAll(node => node.props.role === 'alert')).toHaveLength(1);
});
