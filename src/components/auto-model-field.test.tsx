// @vitest-environment jsdom
import { createElement, useState, type ComponentProps } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { initialAutoConfig } from '../lib/auto-trading';

const api = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('../lib/api', () => ({ apiGet: api.get }));
vi.mock('./ui/select-control', () => ({
    SelectControl: ({ onValueChange, wrapperClassName: _wrapper, ...props }: Omit<ComponentProps<'select'>, 'onChange'> & {
        onValueChange?: (value: string) => void; wrapperClassName?: string;
    }) => createElement('select', { ...props, onChange: event => onValueChange?.(event.currentTarget.value) }),
    SelectOption: (props: ComponentProps<'option'>) => createElement('option', props),
}));
import { AutoModelField } from './auto-model-field';

afterEach(cleanup);
function Harness() {
    const [draft,setDraft] = useState(initialAutoConfig);
    return <><AutoModelField draft={draft} setDraft={setDraft} editable /><output aria-label="策略設定">{JSON.stringify(draft)}</output></>;
}
it('pins the selected model cadence and restores five minutes when removing the model', async () => {
    api.get.mockResolvedValue([['a','mtf_1_3_15',1],['b','base',5]].map(([key,featureSet,decisionMinutes]) => ({
        id: String(key).repeat(64),source:'fubon-paper',status:'diagnostic',metricsPassed:false,reasons:[],
        dataEnd:'2026-11-16',targetR:2,blocked:null,featureSet,decisionMinutes,strategySession:'afterhours',
        settings:{strategy_version:'orb_atr_v2',decision_minutes:decisionMinutes,use_basket:false},
    })));
    render(<Harness />);
    const select = screen.getByLabelText('進場模型');
    await waitFor(() => expect((select as HTMLSelectElement).options.length).toBe(3));
    const config = () => JSON.parse(screen.getByLabelText('策略設定').textContent!);
    fireEvent.change(select,{target:{value:'a'.repeat(64)}});
    expect(config()).toMatchObject({model_run_id:'a'.repeat(64),decision_minutes:1,strategy_session:'afterhours'});
    expect(screen.getByText(/僅使用當時已收盤資料/).textContent).toContain('每1分鐘判斷');
    fireEvent.change(select,{target:{value:''}});
    expect(config()).toMatchObject({model_run_id:null,decision_minutes:5});
    fireEvent.change(select,{target:{value:'b'.repeat(64)}});
    expect(config()).toMatchObject({model_run_id:'b'.repeat(64),decision_minutes:5});
});
