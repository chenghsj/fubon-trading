from collections import defaultdict
from importlib import import_module
import json
from pathlib import Path
from statistics import mean
from fubon_bridge.direction_execution import build,compare,rule_scores,prepare
from fubon_bridge.loss_diagnostics import decompose,distribution
base=import_module('refine-regime');root=Path.cwd();result={}
for session,(ident,data,dates) in base.datasets(root/'server/.research.sqlite3').items():
 chosen=dates[:int(len(dates)*.6)];events,_=build(data,chosen);outputs={}
 for variant in ('confirmed-fixed','paired-fixed'):
  candidates=events[variant];lookup={a.key:a for a in candidates};metrics=compare(candidates,rule_scores(candidates),chosen,'hybrid')['normal'];records=[]
  for t in metrics['trades']:
   side=1 if t['side']=='Buy' else -1;a=lookup[(t['time'],side,t['plan'])];_,fill,_=prepare(a)
   stop=t['risk'];bars=a.bars;future={}
   for h in (3,15,30):
    j=min(a.index+h,a.end);future[str(h)]=(bars[j]['close']-bars[fill['first']]['open'])*side*10
   exits=next(i for i,b in enumerate(bars) if b['time']==t['exitTime']);before=bars[fill['first']:exits]
   record=dict(trade=t,side=t['side'],plan=t['plan'],signedReturnNTD=future,
    favorableBeforeExit=max([0]+[(b['high' if side>0 else 'low']-t['entry'])*side for b in before]),
    extension=abs(a.context[2]),efficiency=a.context[0],signalBody=a.context[4])
   records.append(record)
  groups={}
  for field,values in [('side',('Buy','Sell')),('plan',('range','trend'))]:
   groups[field]={value:decompose([r['trade'] for r in records if r[field]==value]) for value in values}
  groups['extension']={label:decompose([r['trade'] for r in records if (r['extension']<limit if lower is None else lower<=r['extension']<limit)]) for label,lower,limit in [('below1',None,1),('1to2',1,2),('2plus',2,1e9)]}
  outputs[variant]=dict(accounting=decompose(metrics['trades']),favorableBeforeExit=distribution([r['favorableBeforeExit'] for r in records]),
    forwardGross={h:distribution([r['signedReturnNTD'][h] for r in records]) for h in ('3','15','30')},groups=groups)
 result[session]=dict(datasetId=ident,period='first60-development-only',dates=[chosen[0],chosen[-1]],policies=outputs)
 print(json.dumps(dict(session=session,results=outputs),ensure_ascii=False),flush=True)
path=root/'.fubon-dev/reports/entry-quality-dev-audit-v1.json'
with path.open('x') as f:json.dump(result,f,ensure_ascii=False,indent=2)
