// @vitest-environment jsdom
import { createElement, type ComponentProps } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { DEFAULT_RESEARCH_CONFIG } from '../lib/intraday-research';
import type { LearningDataset } from '../lib/learning';

const api=vi.hoisted(() => ({get:vi.fn(),post:vi.fn()}));
vi.mock('../lib/api',() => ({apiGet:api.get}));
vi.mock('../lib/fubon-api-detail',() => ({fubonPost:api.post}));
vi.mock('./ui/select-control',() => ({
    SelectControl:({onValueChange,wrapperClassName:_wrapper,...props}:Omit<ComponentProps<'select'>,'onChange'> & {onValueChange?:(value:string)=>void;wrapperClassName?:string}) => createElement('select',{...props,onChange:event=>onValueChange?.(event.currentTarget.value)}),
    SelectOption:(props:ComponentProps<'option'>)=>createElement('option',props),
}));
import { RegimeResearchPanel } from './regime-research-panel';

afterEach(() => { cleanup(); vi.clearAllMocks(); });
const dataset=(session:'cash'|'regular'):LearningDataset => ({id:(session==='cash'?'a':'b').repeat(64),source:'fubon-paper',product:'TMF',start:'2026-01-01',end:'2026-11-16',futuresBars:60000,stockBars:{},completeDays:200,excludedDays:[],absentWeekdays:[],contracts:['202611'],strategySession:session});

it('uses a complete futures dataset and launches research without starting automation',async()=>{
    api.get.mockResolvedValue([]); api.post.mockResolvedValue({id:'job',action:'regime',status:'running'});
    render(<RegimeResearchPanel config={DEFAULT_RESEARCH_CONFIG} datasets={[dataset('cash'),dataset('regular')]} jobs={[]} />);
    const input=screen.getByLabelText('區間／順勢資料版本') as HTMLSelectElement;
    await waitFor(()=>expect(input.value).toBe('b'.repeat(64)));
    expect(Array.from(input.options,o=>o.value)).toEqual(['','b'.repeat(64)]);
    fireEvent.click(screen.getByRole('button',{name:'比較區間／順勢與滑價壓力'}));
    await waitFor(()=>expect(api.post).toHaveBeenCalledExactlyOnceWith('/api/v1/research/regime/run',{dataset_id:'b'.repeat(64),config:DEFAULT_RESEARCH_CONFIG}));
});
