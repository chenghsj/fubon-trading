import type { ResearchConfig } from './intraday-research';
import type { LearningDataset } from './learning';
import type { StrategySession } from './strategy-session';

export interface RegimeRun {
    id: string; createdAt: string; datasetId: string; strategySession: StrategySession;
    metricsPassed: boolean; source: string;
}
interface RegimePerformance {
    net: number; maxDrawdown: number; count: number; profitFactor: number | null;
    byRegime?: Record<'range' | 'trend', { count: number; net: number }>;
}
export interface RegimeReport extends RegimeRun {
    config: ResearchConfig; diagnostics: LearningDataset & { events: number; regimeMinutes: Record<string, number> };
    split: { trainDates: string[]; validationDates: string[]; testDates: string[] };
    adoptionAllowed: false; executionEnabled: false; reasons: string[];
    comparisons: Record<'development' | 'validation' | 'test', Record<'hybrid' | 'range' | 'trend', {
        normal: RegimePerformance; stress: RegimePerformance;
    }>>;
}
