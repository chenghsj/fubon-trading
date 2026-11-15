import { runIntradayComparison, type ResearchConfig, type ResearchDataset } from './intraday-research';
self.onmessage = (event: MessageEvent<{ dataset: ResearchDataset; config: ResearchConfig }>) => {
    try { self.postMessage({ result: runIntradayComparison(event.data.dataset, event.data.config) }); }
    catch (error) { self.postMessage({ error: error instanceof Error ? error.message : String(error) }); }
};
