import type { ResearchConfig } from './intraday-research';
import type { StrategySession } from './strategy-session';

export interface LearningDataset {
    id: string; source: string; product: string; start: string; end: string;
    futuresBars: number; stockBars: Record<string, number>; completeDays: number;
    excludedDays: string[]; absentWeekdays: string[]; contracts: string[];
    strategySession?: StrategySession; openingStart?: string; openingEnd?: string;
}
export interface LearningJob { id: string; action: 'collect' | 'train'; status: 'running' | 'completed' | 'failed' | 'interrupted'; message: string; progress: number; resultId: string | null }
export interface LearningRun { id: string; createdAt: string; datasetId: string; status: string; metricsPassed: boolean; modelBytes: number; strategySession?: StrategySession }
export interface LearningOverview { datasets: LearningDataset[]; runs: LearningRun[]; jobs: LearningJob[]; databaseBytes: number }
interface Performance { net: number; maxDrawdown: number; count: number; profitFactor: number | null }
export interface LearningReport {
    id: string; datasetId: string; source: string; status: 'insufficient' | 'diagnostic' | 'research_candidate'; config: ResearchConfig;
    counts: { train: number; validation: number; test: number }; reasons: string[]; metricsPassed: boolean; executionEnabled: false; adoptionAllowed: false;
    diagnostics: LearningDataset & { labeledEvents: number; missingStockEvents: number; riskRejectedEvents: number };
    split: { trainDates: string[]; validationDates: string[]; testDates: string[]; purged: number[] };
    comparisons: Record<string, { baseline: Performance; filtered: Performance; stressBaseline: Performance; stressFiltered: Performance; accuracy: number | null; brier: number | null }>;
    model: { hash: string; bytes: number; importance: Record<string, number> } | null;
    predictions: { time: number; side: string; score: number; label: number }[];
    packages: { lightgbm: string; numpy: string };
    strategySession?: StrategySession;
    researchMethod?: 'fixed' | 'walkforward'; modelKind?: 'binary' | 'net_return'; entryThreshold?: number;
    selection?: { passed: boolean; selected: { kind: string; threshold: number }; candidates: { kind: string; threshold: number; passed: boolean; normal: Performance; stress: Performance }[] };
}
