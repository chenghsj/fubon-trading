"""Read saved fills and refit nothing; identify loss mechanisms before new study."""
import hashlib
import json
from pathlib import Path

from fubon_bridge.loss_diagnostics import decompose,matched_latency
from fubon_bridge.research import digest

ROOT=Path(__file__).resolve().parents[1]
SOURCE=ROOT/'.fubon-dev/reports/opportunity-actions-v1'
OUTPUT=ROOT/'.fubon-dev/reports/opportunity-loss-audit-v1.json'
NAMES=['small-raw-0-hybrid','flexible-raw-0-hybrid','flexible-raw-0-scalp','flexible-raw-0-swing']


def main():
    frozen=json.loads((SOURCE/'frozen.json').read_text())
    if digest({k:v for k,v in frozen.items() if k!='id'})!=frozen['id']:
        raise ValueError('研究凍結雜湊不符')
    output=dict(sourceFrozen=frozen['id'],descriptiveOnly=True,
        accounting='fixed fills; cost add-back is not a zero-cost replay',sessions={})
    for session in frozen['sessions']:
        source=json.loads((SOURCE/f'{session}-evaluation.json').read_text())
        if source['frozenId']!=frozen['id']:
            raise ValueError('評估來源與凍結不符')
        records={}
        for name in NAMES:
            records[name]={}
            for period,comparison in source['results'][name].items():
                normal=comparison['normal']['trades'];late=comparison['delayed']['trades']
                records[name][period]=dict(accounting=decompose(normal),
                    latency=matched_latency(normal,late),
                    byPlan={p:decompose([t for t in normal if t['plan']==p]) for p in ('scalp','swing')})
        output['sessions'][session]=records
    output['implementation']={p.name:hashlib.sha256(p.read_bytes()).hexdigest()
        for p in (Path(__file__),ROOT/'server/fubon_bridge/loss_diagnostics.py')}
    if OUTPUT.exists():
        raise ValueError('保留既有虧損稽核，不覆寫')
    OUTPUT.write_text(json.dumps(output,ensure_ascii=False,indent=2))
    for session,records in output['sessions'].items():
        for name,periods in records.items():
            for period,result in periods.items():
                print(json.dumps(dict(session=session,policy=name,period=period,**result),ensure_ascii=False),flush=True)


if __name__=='__main__':
    main()
