"""Read-only, two-stage refinement study; never creates a broker or orders."""
import argparse
from dataclasses import asdict
import hashlib
import json
from pathlib import Path
import sqlite3
import zlib

from fubon_bridge.learning_data import quality
from fubon_bridge.mapping import now
from fubon_bridge.regime_refinement import (BASELINE, CANDIDATES, POLICY,
    build_candidates, compare, select)
from fubon_bridge.research import canonical, digest

ROOT = Path(__file__).resolve().parents[1]
ARTIFACTS = ROOT/'.fubon-dev/reports/refinement-v1-verified'


def datasets(path):
    with sqlite3.connect(f'file:{path}?mode=ro', uri=True) as db:
        states = [json.loads(r[0]) for r in db.execute('SELECT payload FROM research_auto_runs')]
        if any(s.get('status') in {'running','stopping'} or s.get('pending') or s.get('position') for s in states):
            raise ValueError('請先停止策略並確認沒有持倉或待確認委託')
        rows = [(ident,json.loads(summary),payload) for ident,summary,payload in db.execute('SELECT id,summary,payload FROM research_learning_datasets')]
    output = {}
    for session in ('regular','afterhours'):
        choices = [r for r in rows if r[1]['source']=='fubon-paper' and r[1].get('strategySession')==session]
        ident, summary, payload = max(choices,key=lambda r:(r[1]['end'],r[1]['completeDays']))
        data = json.loads(zlib.decompress(payload))
        if digest(data) != ident:
            raise ValueError('歷史快照雜湊不符')
        output[session] = (ident,data,quality(data)['completeDates'])
    return output


def hashes():
    names = ['regime_refinement.py','regime_strategy.py','learning_features.py','intraday_strategy.py',
        'strategy_session.py','learning_data.py','learning_multiframe.py','mapping.py','research.py']
    base = ROOT/'server/fubon_bridge'
    return {name:hashlib.sha256((base/name).read_bytes()).hexdigest() for name in names} | {
        'refine-regime.py':hashlib.sha256(Path(__file__).read_bytes()).hexdigest()}


def save(name, value):
    ARTIFACTS.mkdir(parents=True, exist_ok=True)
    path = ARTIFACTS/name
    if path.exists():
        raise ValueError(f'保留既有研究紀錄；請先檢查 {path}')
    path.write_text(json.dumps(value,ensure_ascii=False,indent=2))
    return path


def compact(comparison):
    return {name:{key:result[key] for key in ('count','net','maxDrawdown','byRegime')} for name,result in comparison.items()}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--stage',choices=['development','evaluation'],required=True)
    parser.add_argument('--database',type=Path,default=ROOT/'server/.research.sqlite3')
    args=parser.parse_args()
    sources=datasets(args.database)
    version=hashes()
    if args.stage=='development':
        frozen = dict(createdAt=now().isoformat(),policy=POLICY,implementation=version,sessions={})
        for session,(ident,data,dates) in sources.items():
            cuts=[int(len(dates)*f) for f in POLICY['developmentFractions']]
            # The latest 40% is excluded entirely, including event generation.
            raw=build_candidates(data,dates[:cuts[-1]])
            folds={c.name:[] for c in (*CANDIDATES,BASELINE)}
            for c in (*CANDIDATES,BASELINE):
                for a,b in zip(cuts,cuts[1:]):
                    selected=dates[a:b]; eligible=set(selected)
                    events=[e for e in raw[c.name] if e['day'] in eligible]
                    folds[c.name].append(compare(events,c,selected,session))
                print(json.dumps(dict(session=session,candidate=c.name,folds=[compact(f) for f in folds[c.name]]),ensure_ascii=False),flush=True)
            selection=select(folds)
            report=dict(datasetId=ident,developmentDates=dates[:cuts[-1]],folds=folds,selection=selection)
            save(f'{session}-development.json',report)
            frozen['sessions'][session]=dict(datasetId=ident,developmentEnd=dates[cuts[-1]-1],
                dateSplit=dict(development=dates[:cuts[-1]],validation=dates[cuts[-1]:int(len(dates)*.8)],
                    historical_reused_test=dates[int(len(dates)*.8):]),
                candidate=asdict(next(c for c in CANDIDATES if c.name==selection['chosen']['name'])),selection=selection)
            print(json.dumps(dict(session=session,selection=selection),ensure_ascii=False),flush=True)
        frozen['id']=digest(frozen)
        print(save('frozen.json',frozen),flush=True)
    else:
        frozen=json.loads((ARTIFACTS/'frozen.json').read_text())
        if digest({k:v for k,v in frozen.items() if k!='id'})!=frozen['id'] or frozen['implementation']!=version or frozen['policy']!=POLICY:
            raise ValueError('凍結候選、程式或規格已改變，拒絕沿用挑選結果')
        for session,(ident,data,dates) in sources.items():
            spec=frozen['sessions'][session]
            if spec['datasetId']!=ident:
                raise ValueError('資料版本與凍結時不同')
            chosen=next(c for c in CANDIDATES if c.name==spec['candidate']['name'])
            n=len(dates); a=int(n*.6); b=int(n*.8)
            if spec['dateSplit']!=dict(development=dates[:a],validation=dates[a:b],historical_reused_test=dates[b:]):
                raise ValueError('完整日期或分割與凍結時不同')
            raw=build_candidates(data,dates[a:],(chosen,BASELINE))
            results={}
            for period,selected in (('validation',dates[a:b]),('historical_reused_test',dates[b:])):
                allowed=set(selected); results[period]={}
                for c in (chosen,BASELINE):
                    events=[e for e in raw[c.name] if e['day'] in allowed]
                    comparison=compare(events,c,selected,session)
                    results[period][c.name]=comparison
                    print(json.dumps(dict(session=session,period=period,candidate=c.name,result=compact(comparison)),ensure_ascii=False),flush=True)
            save(f'{session}-evaluation.json',dict(frozenId=frozen['id'],datasetId=ident,selection=spec,
                results=results,executionEnabled=False,adoptionAllowed=False,
                limitations=['重用已看過歷史，不是全新樣本外證據','費率仍為假設','回撤以分鐘收盤估值，不代表逐筆最低浮虧']))


if __name__=='__main__':
    main()
