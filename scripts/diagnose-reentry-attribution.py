"""Separate changed exits, newly admitted trades and lock's broader opportunity cost."""
import argparse
from importlib import import_module
import json
from pathlib import Path

from fubon_bridge.loss_diagnostics import decompose
from fubon_bridge.recovery_lock import SCENARIOS

audit=import_module('summarize-recovery-lock')


def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--source',type=Path,default=audit.study.ARTIFACTS)
    args=parser.parse_args();frozen,_=audit.load_frozen(args.source)
    result=dict(frozenId=frozen['id'],postmortemOnly=True,selectionChanged=False,sessions={})
    key=lambda t:(t['time'],t['side'],t['plan'])
    for session,spec in frozen['sessions'].items():
        report=json.loads((args.source/f'{session}-evaluation.json').read_text());records={}
        if report['frozenId']!=frozen['id'] or report['datasetId']!=spec['datasetId']:
            raise ValueError('再次進場歸因來源不符')
        for source in ('confirmed','paired'):
            for family in ('mean','protected'):
                for entry in ('rule','cash'):
                    for phase in ('validation','historical_reused_test'):
                        for scenario,extra,delay in SCENARIOS:
                            lookup=lambda p:report['results'][p]['raw'][phase][scenario]
                            fixed=lookup(f'{source}-fixed-{entry}-free');free=lookup(f'{source}-{family}-{entry}-free');locked=lookup(f'{source}-{family}-{entry}-lock')
                            left={key(t):t for t in fixed['trades']};right={key(t):t for t in free['trades']};kept={key(t):t for t in locked['trades']}
                            if not kept.keys()<=right.keys() or any(right[k]!=v for k,v in kept.items()):
                                raise ValueError('鎖倉非原free交易子集')
                            shared=left.keys()&right.keys();added=[t for k,t in right.items() if k not in left];removed=[t for k,t in left.items() if k not in right]
                            changed=sum(right[k]['net']-left[k]['net'] for k in shared)
                            if abs(free['net']-fixed['net']-changed-sum(t['net'] for t in added)+sum(t['net'] for t in removed))>1e-7:
                                raise ValueError('退出／新交易歸因無法對帳')
                            blocked=[t for k,t in right.items() if k not in kept];old_blocked=[t for t in blocked if key(t) in left];new_blocked=[t for t in blocked if key(t) not in left]
                            if abs(locked['net']-free['net']+sum(t['net'] for t in blocked))>1e-7:
                                raise ValueError('進場鎖差額無法對帳')
                            records[f'{source}-{family}-{entry}-{phase}-{scenario}']=dict(
                                fixedNet=fixed['net'],freeNet=free['net'],lockedNet=locked['net'],sharedTrades=len(shared),sharedExitDifference=changed,
                                entryModelAlsoChanged=entry=='cash',newTrades=decompose(added,2+extra),newTradeDetails=added,
                                missingFixedTrades=decompose(removed,2+extra),missingFixedTradeDetails=removed,
                                lockDifference=locked['net']-free['net'],lockRemovedAlsoInFixed=decompose(old_blocked,2+extra),
                                lockRemovedNewToFixed=decompose(new_blocked,2+extra),lockRemovedDetails=blocked)
        result['sessions'][session]=records
    with (args.source/'reentry-attribution.json').open('x') as stream:
        json.dump(result,stream,ensure_ascii=False,indent=2,allow_nan=False)
    print(json.dumps(dict(frozenId=frozen['id'],rows=sum(len(v) for v in result['sessions'].values()))))


if __name__=='__main__':
    main()
