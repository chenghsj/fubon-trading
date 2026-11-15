// Offline only: runs the same pure TypeScript engine as the research worker.
import { readFile, writeFile } from 'node:fs/promises';
import ts from 'typescript';

const [input, output, configFile] = process.argv.slice(2);
if (!input || !output) throw new Error('Usage: node scripts/evaluate-strategy-revision.mjs dataset.json result.json [config.json]');
const modules = new Map();
for (const name of ['futures-costs', 'intraday-policy', 'intraday-research']) {
    const source = await readFile(new URL(`../src/lib/${name}.ts`, import.meta.url), 'utf8');
    const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
    const exports = {};
    new Function('require', 'exports', code)(key => {
        const module = modules.get(key.replace('./', ''));
        if (!module) throw new Error(`Unexpected engine dependency: ${key}`);
        return module;
    }, exports);
    modules.set(name, exports);
}
const data = JSON.parse(await readFile(input, 'utf8'));
const engine = modules.get('intraday-research');
const result = engine.runIntradayComparison(data, configFile ? { ...engine.DEFAULT_RESEARCH_CONFIG, ...JSON.parse(await readFile(configFile, 'utf8')) } : engine.DEFAULT_RESEARCH_CONFIG);
await writeFile(output, JSON.stringify(result, null, 2));
const summary = run => ({ trades: run.trades.length, net: run.net, drawdown: run.maxDrawdown, ...engine.researchTradeStats(run.trades) });
console.log(JSON.stringify({ dataset: result.context, completeDays: result.diagnostics.completeDays, excludedDays: result.diagnostics.excludedDays,
    baseline: summary(result.baseline), filtered: summary(result.filtered), revised: summary(result.revision.run),
    stressBaseline: summary(result.revision.stressBaseline), stressRevised: summary(result.revision.stressRevised), rejected: result.revision.rejected,
    independentOutOfSample: false, ownSandboxFillsUsed: 0 }, null, 2));
