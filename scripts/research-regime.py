"""Reproduce the fixed local-history experiment; never connects to the broker."""
import argparse
import json
from pathlib import Path
import time

from fubon_bridge.auto_store import AutoStore
from fubon_bridge.learning_service import LearningService
from fubon_bridge.learning_store import LearningStore
from fubon_bridge.learning_train import TrainingRequest
from fubon_bridge.regime_research import RegimeReports, RegimeRequest
from fubon_bridge.research import ResearchStore

ROOT = Path(__file__).resolve().parents[1]


class SavedAutomation:
    def __init__(self, research):
        self.research = research
        AutoStore(research, 'paper').latest()

    def snapshot(self):
        with self.research.connect() as db:
            states = [json.loads(row[0]) for row in db.execute('SELECT payload FROM research_auto_runs')]
        return dict(position=any(s.get('position') for s in states), pending=any(s.get('pending') for s in states),
            status='running' if any(s.get('status') in {'running', 'stopping'} for s in states) else 'idle')


def completed(service, action, request):
    job = service.start(action, request)
    previous = None
    while True:
        state = next(j for j in service.overview()['jobs'] if j['id'] == job['id'])
        if (state['message'], state['progress']) != previous:
            print(json.dumps(dict(action=action, message=state['message'], progress=state['progress']), ensure_ascii=False), flush=True)
            previous = state['message'], state['progress']
        if state['status'] == 'completed':
            return state['resultId']
        if state['status'] in {'failed', 'interrupted'}:
            raise RuntimeError(state['message'])
        time.sleep(.2)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--session', choices=['regular', 'afterhours', 'both'], default='both')
    parser.add_argument('--database', type=Path, default=ROOT/'server/.research.sqlite3')
    args = parser.parse_args()
    if not args.database.is_file():
        raise SystemExit('請先在研究面板保存富邦完整日／夜盤歷史資料')
    research = ResearchStore(args.database)
    store = LearningStore(research)
    reports = RegimeReports(research)
    service = LearningService(None, store, SavedAutomation(research))
    config = dict(stopPoints=30, targetR=2, quantity=1, feePerSide=20, feeSource='assumed', slippagePoints=2, taxRate=.00002)
    sessions = ['regular', 'afterhours'] if args.session == 'both' else [args.session]
    try:
        for session in sessions:
            choices = [d for d in store.overview()['datasets'] if d.get('strategySession') == session and d.get('source') == 'fubon-paper']
            if not choices:
                raise ValueError(f'缺少{session}的富邦歷史資料版本')
            data = max(choices, key=lambda d: (d['end'], d['completeDays']))
            print(json.dumps(dict(session=session, dataset=data['id'], completeDays=data['completeDays']), ensure_ascii=False), flush=True)
            ident = completed(service, 'regime', RegimeRequest(dataset_id=data['id'], config=config))
            rules = reports.get(ident)
            ident = completed(service, 'train', TrainingRequest(dataset_id=data['id'], config=config,
                method='walkforward', feature_set='regime_1_3_15'))
            model = store.run(ident)
            output = ROOT/'.fubon-dev/reports'/f'regime-{session}-2026-11-18.json'
            output.parent.mkdir(parents=True, exist_ok=True)
            output.write_text(json.dumps(dict(rules=rules, model=model), ensure_ascii=False, indent=2))
            print(json.dumps(dict(session=session, rulesId=rules['id'], modelId=model['id'],
                rulesPassed=rules['metricsPassed'], modelPassed=model['metricsPassed'],
                selected=model.get('selection', {}).get('selected'),
                comparisons={period: {key: {k: value[key][k] for k in ('count', 'net', 'maxDrawdown')}
                    for key in ('baseline', 'filtered', 'stressFiltered')} for period, value in model['comparisons'].items()},
                artifact=str(output)), ensure_ascii=False), flush=True)
    finally:
        service.shutdown()
        service.executor.shutdown(wait=True)


if __name__ == '__main__':
    main()
