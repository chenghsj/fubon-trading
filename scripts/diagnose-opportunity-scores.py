"""Audit frozen fit versus calibration predictions; no refit or policy choice."""
import hashlib
from importlib import import_module
import json
from pathlib import Path

import lightgbm as lgb
import numpy as np

from fubon_bridge.loss_diagnostics import distribution
from fubon_bridge.opportunity_models import labels
from fubon_bridge.opportunity_research import build
from fubon_bridge.research import digest

base=import_module('refine-regime')
ROOT=Path(__file__).resolve().parents[1]
SOURCE=ROOT/'.fubon-dev/reports/opportunity-actions-v1'
OUTPUT=ROOT/'.fubon-dev/reports/opportunity-score-audit-v1.json'


def summary(rows,predictions):
    y=np.asarray([v for _,v in rows]);p=np.asarray(predictions)
    mask=p>0
    def group(chosen):
        return dict(actions=int(chosen.sum()),days=len({a.day for (a,_),ok in zip(rows,chosen) if ok}),
            predicted=distribution(list(map(float,p[chosen]))),actual=distribution(list(map(float,y[chosen]))))
    residual=float(np.square(y-p).sum());total=float(np.square(y-y.mean()).sum())
    return dict(all=group(np.ones(len(y),dtype=bool)),positive=group(mask),
        correlation=float(np.corrcoef(y,p)[0,1]) if np.std(p)>0 else None,
        r2=1-residual/total if total else None)


def main():
    frozen=json.loads((SOURCE/'frozen.json').read_text())
    if digest({k:v for k,v in frozen.items() if k!='id'})!=frozen['id']:
        raise ValueError('研究雜湊不符')
    output=dict(sourceFrozen=frozen['id'],descriptiveOnly=True,sessions={})
    for session,(ident,data,dates) in base.datasets(ROOT/'server/.research.sqlite3').items():
        spec=frozen['sessions'][session]
        if ident!=spec['datasetId']:
            raise ValueError('資料快照不符')
        actions,_=build(data,spec['dateSplit']['development'])
        output['sessions'][session]={}
        for name,meta in spec['models'].items():
            text=(SOURCE/f'{session}-{name}-model.txt').read_text()
            if hashlib.sha256(text.encode()).hexdigest()!=meta['hash']:
                raise ValueError('模型雜湊不符')
            model=lgb.Booster(model_str=text);records={}
            for phase,selected in (('fit',meta['metadata']['fitDates']),('calibration',meta['metadata']['calibrationDates'])):
                allowed=set(selected);rows=labels(a for a in actions if a.day in allowed)
                scores=model.predict(np.asarray([a.x for a,_ in rows],dtype=np.float32),num_threads=2)
                records[phase]=summary(rows,scores)
            output['sessions'][session][name]=records
            print(json.dumps(dict(session=session,model=name,**records)),flush=True)
    if OUTPUT.exists():
        raise ValueError('保留既有分數稽核')
    OUTPUT.write_text(json.dumps(output,ensure_ascii=False,indent=2))


if __name__=='__main__':
    main()
