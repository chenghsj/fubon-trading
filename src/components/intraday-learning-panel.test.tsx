// @vitest-environment jsdom
import { createElement, type ComponentProps } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LearningDataset, LearningOverview } from '../lib/learning';
import type { ResearchConfig } from '../lib/intraday-research';

const fixture = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), overview: {} as LearningOverview }));
vi.mock('../lib/api', () => ({ apiGet: fixture.get }));
vi.mock('../lib/fubon-api-detail', () => ({ fubonPost: fixture.post }));
// Test the real panel's selection and request contract while native selects
// avoid introducing Radix positioning/layout into a data-identity regression.
vi.mock('./ui/select-control', () => ({
    SelectControl: ({ onValueChange, wrapperClassName: _wrapper, ...props }: Omit<ComponentProps<'select'>, 'onChange'> & {
        onValueChange?: (value: string) => void; wrapperClassName?: string;
    }) => createElement('select', { ...props, onChange: event => onValueChange?.(event.currentTarget.value) }),
    SelectOption: (props: ComponentProps<'option'>) => createElement('option', props),
}));

import { IntradayLearningPanel } from './intraday-learning-panel';

const IDS = { cash: 'a'.repeat(64), regular: 'b'.repeat(64), afterhours: 'c'.repeat(64) };
const CONFIG: ResearchConfig = {
    stopPoints: 30, targetR: 2, quantity: 1, feeSource: 'statement',
    feePerSide: 14, slippagePoints: 1, taxRate: .00002, taxRounding: 'per-contract-yuan',
};
const dataset = (session: 'cash' | 'regular' | 'afterhours'): LearningDataset => ({
    id: IDS[session], source: 'fubon-paper', product: 'TMF', start: '2026-03-02', end: '2026-11-16',
    futuresBars: 72000, stockBars: {}, completeDays: 200, excludedDays: [], absentWeekdays: [],
    contracts: ['202611'], ...(session === 'cash' ? {} : { strategySession: session }),
});

beforeEach(() => {
    fixture.get.mockReset(); fixture.post.mockReset();
    // The first server dataset intentionally belongs to the legacy cash model.
    // A default regular panel must not silently train this first item.
    fixture.overview = { datasets: [dataset('cash'), dataset('afterhours'), dataset('regular')], runs: [], jobs: [], databaseBytes: 1024 };
    fixture.get.mockImplementation(async (path: string) => {
        if (path === '/api/v1/research/learning') return fixture.overview;
        throw new Error(`Unexpected read ${path}`);
    });
    fixture.post.mockResolvedValue({ id: 'job-1', action: 'train', status: 'running', message: '訓練中', progress: 0, resultId: null });
});
afterEach(cleanup);

const sessionInput = () => screen.getByLabelText('研究盤別') as HTMLSelectElement;
const datasetInput = () => screen.getByLabelText('訓練資料版本') as HTMLSelectElement;
const methodInput = () => screen.getByLabelText('訓練方法') as HTMLSelectElement;
const trainButton = () => screen.getByRole('button', { name: '訓練／重新驗證' }) as HTMLButtonElement;
const datasetValues = () => Array.from(datasetInput().options, option => option.value);

async function open() {
    render(<IntradayLearningPanel config={CONFIG} />);
    await waitFor(() => expect(datasetInput().value).toBe(IDS.regular));
}

describe('learning panel dataset identity follows the research session', () => {
    it('defaults to regular and selects only the matching dataset even when cash is listed first', async () => {
        await open();
        expect(sessionInput().value).toBe('regular');
        expect(methodInput().value).toBe('walkforward');
        expect((screen.getByLabelText('特徵與判斷頻率') as HTMLSelectElement).value).toBe('mtf_1_3_15');
        expect(datasetValues()).toEqual(['', IDS.regular]);
        expect(trainButton().disabled).toBe(false);
        expect(fixture.post).not.toHaveBeenCalled();
    });

    it('switches to the night dataset and supports legacy cash records without a session field', async () => {
        await open();
        fireEvent.change(sessionInput(), { target: { value: 'afterhours' } });
        await waitFor(() => expect(datasetInput().value).toBe(IDS.afterhours));
        expect(datasetValues()).toEqual(['', IDS.afterhours]);
        expect(trainButton().disabled).toBe(false);
        fireEvent.change(sessionInput(), { target: { value: 'cash' } });
        await waitFor(() => expect(datasetInput().value).toBe(IDS.cash));
        expect(datasetValues()).toEqual(['', IDS.cash]);
        expect(trainButton().disabled).toBe(false);
    });

    it('clears selection and disables training when no dataset matches the selected session', async () => {
        fixture.overview.datasets = [dataset('cash'), dataset('regular')];
        await open();
        fireEvent.change(sessionInput(), { target: { value: 'afterhours' } });
        await waitFor(() => expect(datasetInput().value).toBe(''));
        expect(datasetValues()).toEqual(['']);
        expect(trainButton().disabled).toBe(true);
        fireEvent.click(trainButton());
        expect(fixture.post).not.toHaveBeenCalled();
    });

    it.each(['regular', 'afterhours'] as const)('posts the %s dataset and the default walkforward method', async session => {
        await open();
        if (session !== 'regular') fireEvent.change(sessionInput(), { target: { value: session } });
        await waitFor(() => expect(datasetInput().value).toBe(IDS[session]));
        fireEvent.click(trainButton());
        await waitFor(() => expect(fixture.post).toHaveBeenCalledWith('/api/v1/research/learning/train', {
            dataset_id: IDS[session], config: CONFIG, method: 'walkforward', feature_set: 'mtf_1_3_15',
        }));
        expect(fixture.post).toHaveBeenCalledTimes(1);
    });

    it('posts fixed only when the user explicitly changes the training method', async () => {
        await open();
        fireEvent.change(sessionInput(), { target: { value: 'afterhours' } });
        await waitFor(() => expect(datasetInput().value).toBe(IDS.afterhours));
        fireEvent.change(methodInput(), { target: { value: 'fixed' } });
        fireEvent.click(trainButton());
        await waitFor(() => expect(fixture.post).toHaveBeenCalledWith('/api/v1/research/learning/train', {
            dataset_id: IDS.afterhours, config: CONFIG, method: 'fixed', feature_set: 'mtf_1_3_15',
        }));
    });

    it('can explicitly train the original five-minute comparison version', async () => {
        await open();
        fireEvent.change(screen.getByLabelText('特徵與判斷頻率'), { target: { value: 'base' } });
        fireEvent.click(trainButton());
        await waitFor(() => expect(fixture.post).toHaveBeenCalledWith('/api/v1/research/learning/train', {
            dataset_id: IDS.regular, config: CONFIG, method: 'walkforward', feature_set: 'base',
        }));
    });
});
