"""Inspect committed capture, freeze inputs and run offline chronological research."""
import argparse
from collections import defaultdict
from datetime import datetime
import hashlib
from importlib.metadata import version
import json
from pathlib import Path
import sqlite3
import sys
import time

from .capture_worker import atomic_json
from .mapping import TAIPEI
from .research import digest

POLICY=dict(version='captured-microstructure-v1',product='TMF',source='fubon-paper',
    warmupMinutes=90,microHistorySeconds=30,quoteTtlSeconds=1,orderLatencySeconds=1,iocLifetimeSeconds=2,
    minuteDecisionDelaySeconds=5,minuteAvailability='closed minute plus fixed five seconds; all used packet arrivals <= decision; execution at least one second later',
    minimumFitDays=20,minimumFitActions=100,dateFractions=[.6,.8],developmentFractions=[.3,.4,.5,.6],
    feePerSide=20,taxRate=.00002,slippagePoints=2,stressAdditionalSlippagePoints=2,delayedAdditionalSeconds=60,
    maximumEntries=2,oncePerSide=True,lossBudget=1000,maximumEntryDriftPoints=10,
    scopes=['range','trend'],automaticTrading=False,adoptionAllowed=False)


def inspect_capture(path,asof_us):
    groups=[]
    with sqlite3.connect(f'file:{path}?mode=ro',uri=True,timeout=3) as db:
        db.execute('BEGIN')
        maximum=db.execute('SELECT COALESCE(MAX(id),0) FROM capture_frames').fetchone()[0]
        rows=db.execute('''SELECT session,opening_day,symbol,month,window_start_us,window_end_us,COUNT(*),MAX(id),
            SUM(CASE WHEN channel='trades' AND valid=1 AND is_trial=0 AND duplicate=0 AND event_type='data' THEN 1 ELSE 0 END),
            SUM(CASE WHEN channel='books' AND valid=1 AND is_trial=0 THEN 1 ELSE 0 END),
            MIN(CASE WHEN channel='books' AND valid=1 AND is_trial=0 THEN received_us END),
            MAX(CASE WHEN channel='books' AND valid=1 AND is_trial=0 THEN received_us END)
            FROM capture_frames WHERE id<=? GROUP BY session,opening_day,symbol,month,window_start_us,window_end_us''',(maximum,)).fetchall()
        for session,day,symbol,month,start,end,count,last,trade_messages,books,first_book,last_book in rows:
            study_start=start+89*60*1_000_000;study_end=end-(5*60-3)*1_000_000
            reasons=[]
            if end+60_000_000>=asof_us:reasons.append('官方交易時段尚未完成')
            if not trade_messages or not books:reasons.append('缺正式成交或有效雙邊五檔')
            if first_book is None or first_book>study_start or last_book<study_end:reasons.append('尚未覆蓋研究決策區間')
            events=db.execute('SELECT at_us,kind,detail FROM capture_audit WHERE at_us BETWEEN ? AND ? ORDER BY at_us',
                (study_start,study_end)).fetchall()
            bad=[dict(atUs=t,kind=k) for t,k,d in events if k in ('capture_loss','capture_hook_error','disabled','clean_shutdown',
                'routing_or_connection_unavailable','unclean_restart','error','unsubscribed') or
                (k=='connection' and json.loads(d).get('state')!='connected')]
            # Older/live writers timestamp a batched loss when it is flushed,
            # not when the packet disappeared. Its true onset is unknown, so
            # conservatively include the whole run-before-audit interval. This
            # also covers control overflow and hook errors discovered later;
            # a marker just after the research/official boundary cannot pass.
            losses=db.execute('''SELECT a.at_us,a.kind,r.started_us FROM capture_audit a
                LEFT JOIN capture_runs r ON r.id=a.run_id
                WHERE a.kind IN ('capture_loss','capture_hook_error') AND a.at_us>=?''',(study_start,)).fetchall()
            for recorded,kind,started in losses:
                if (started is None or started<=study_end) and not any(b['atUs']==recorded and b['kind']==kind for b in bad):
                    bad.append(dict(atUs=recorded,kind=kind,possibleStartUs=started,
                        timing='unknown loss onset; conservatively run start through flush'))
            if bad:reasons.append('研究區間有已知連線、停止或保存缺口')
            # A restarted unclean process leaves a conservative gap from its last
            # committed evidence until the next process starts, not just at reboot.
            runs=db.execute('SELECT id,started_us,ended_us FROM capture_runs ORDER BY started_us').fetchall()
            for i,(run_id,started,ended) in enumerate(runs[:-1]):
                if ended is not None:continue
                safe=db.execute('SELECT MAX(t) FROM (SELECT MAX(received_us) t FROM capture_frames WHERE run_id=? UNION ALL SELECT MAX(at_us) t FROM capture_audit WHERE run_id=?)',(run_id,run_id)).fetchone()[0] or started
                if safe<study_end and runs[i+1][1]>study_start:reasons.append('未正常結束程序的未知缺口與研究區間重疊')
            groups.append(dict(session=session,day=day,symbol=symbol,month=month,startUs=start,endUs=end,
                researchStartUs=study_start,researchEndUs=study_end,frames=count,maximumFrameId=last,
                tradeMessages=trade_messages,bookMessages=books,firstBookReceivedUs=first_book,lastBookReceivedUs=last_book,
                knownGaps=bad,researchCoveragePassed=not reasons,reasons=sorted(set(reasons))))
    return dict(maximumFrameId=maximum,groups=groups,observedAtUs=asof_us,
        qualification='observed coverage only; per-action source age, minute reconciliation and execution checks still required')


def minute_datasets(directory):
    from .learning_data import futures_rows, quality
    output={}
    for session in ('regular','afterhours'):
        candles={};files=[]
        for path in sorted((Path(directory)/'minutes').glob(f'*-{session}.json')):
            value=json.loads(path.read_text())
            if value.get('source')!='fubon-paper' or value.get('session')!=session:
                raise ValueError('研究分鐘來源或盤別不符')
            files.append(dict(file=path.name,sha256=hashlib.sha256(path.read_bytes()).hexdigest()))
            # New provider corrections may replace a minute only in a new frozen
            # run. Old reports and their data fingerprints remain immutable.
            for row in futures_rows(value['rows'],datetime.fromisoformat(value['start']).date(),datetime.fromisoformat(value['end']).date(),session):
                candles[row['time']]=row
        if not candles:
            output[session]=dict(data=None,completeDates=[],files=files);continue
        bars=sorted(candles.values(),key=lambda b:b['time'])
        data=dict(source='fubon-paper',product='TMF',strategySession=session,futures=bars,stocks={},
            start=datetime.fromtimestamp(bars[0]['time'],TAIPEI).date().isoformat(),end=datetime.fromtimestamp(bars[-1]['time'],TAIPEI).date().isoformat())
        output[session]=dict(data=data,completeDates=quality(data)['completeDates'],files=files)
    return output


def eligible_groups(inspection,minutes):
    """Require one unambiguous actual contract and a matching full minute day."""
    from .candle_patterns import future_days
    candidates=defaultdict(list);months={}
    for session,value in minutes.items():
        if value['data'] is not None:
            months[session]={day:{b.get('month') for b in bars}
                for day,_,bars in future_days(value['data'],value['completeDates'])}
    for g in inspection['groups']:candidates[g['session'],g['day']].append(g)
    return [rows[0] for (session,day),rows in candidates.items() if len(rows)==1
        and rows[0]['researchCoveragePassed'] and day in minutes[session]['completeDates']
        and months.get(session,{}).get(day)=={rows[0]['month']}]


def run(database,output):
    output=Path(output);at=time.time_ns()//1000;inspection=inspect_capture(database,at)
    minutes=minute_datasets(output);sessions={};usable=eligible_groups(inspection,minutes)
    for session in ('regular','afterhours'):
        observed=[g for g in inspection['groups'] if g['session']==session]
        eligible=[g for g in usable if g['session']==session]
        dates=sorted({g['day'] for g in eligible});fit_days=int(int(len(dates)*.6)*.8)
        sessions[session]=dict(observedWindows=len(observed),coverageWindows=sum(g['researchCoveragePassed'] for g in observed),
            usableDays=len(dates),fitDays=fit_days,dates=dates,
            state='ready_for_replay' if fit_days>=20 else 'insufficient',
            reason=None if fit_days>=20 else f'有效完整開盤日 {len(dates)}；development內fit上限 {fit_days} 日，未達20日，尚不能訓練／判定獲利')
    paths=[Path(__file__),Path(__file__).with_name('market_capture.py'),Path(__file__).with_name('capture_worker.py')]
    for name in ('capture_models.py','capture_replay.py','candle_patterns.py','learning_data.py','learning_multiframe.py',
        'strategy_session.py','mapping.py','research.py','direction_execution.py','confirmed_execution.py','structured_models.py'):
        p=Path(__file__).with_name(name)
        if p.exists():paths.append(p)
    paths=sorted(set(paths)|set(Path(__file__).parent.glob('*.py')))
    protocol=Path(__file__).resolve().parents[2]/'docs/research/tmf-capture-protocol-v1.md'
    if protocol.exists():paths.append(protocol)
    spec=dict(createdUs=at,policy=POLICY,inspection=inspection,minuteFiles={s:v['files'] for s,v in minutes.items()},
        runtime=dict(python=sys.version,packages={p:version(p) for p in ('numpy','lightgbm')}),
        implementation={p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in paths})
    if any(s['state']=='ready_for_replay' for s in sessions.values()):
        from .capture_models import auxiliary
        _,record=auxiliary(min(int(datetime.fromisoformat(g['day']).replace(tzinfo=TAIPEI).timestamp()) for g in usable))
        spec['auxiliaryRecord']=record
    identity=digest(dict(policy=POLICY,implementation=spec['implementation'],runtime=spec['runtime'],minuteFiles=spec['minuteFiles'],
        eligibleGroups=usable,auxiliary=spec.get('auxiliaryRecord')))
    previous=output/'status.json'
    if previous.exists():
        old=json.loads(previous.read_text())
        if old.get('dataIdentity')==identity and old.get('state')=='completed':
            old['lastCheckedUs']=at;atomic_json(previous,old);return old
    spec['id']=digest(spec)
    folder=output/'runs'/str(at);folder.mkdir(parents=True,exist_ok=False);atomic_json(folder/'frozen.json',spec)
    report=dict(frozenId=spec['id'],sessions=sessions,inspection=inspection,executionAllowed=False,adoptionAllowed=False)
    if any(s['state']=='ready_for_replay' for s in sessions.values()):
        from .capture_models import evaluate
        report['results']=evaluate(database,minutes,inspection,sessions,folder)
    atomic_json(folder/'report.json',report)
    state='completed' if report.get('results') else 'insufficient'
    summary=dict(state=state,message='研究已保存；未啟用任何策略' if state=='completed' else '等待秒級收集與官方1m完整盤；沿用1m／3m／15m及原最低樣本門檻',
        frozenId=spec['id'],sessions=sessions,updatedUs=at,dataIdentity=identity,executionAllowed=False,adoptionAllowed=False)
    atomic_json(output/'status.json',summary)
    return summary


def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--database',required=True,type=Path);parser.add_argument('--output',required=True,type=Path)
    args=parser.parse_args();print(json.dumps(run(args.database,args.output),ensure_ascii=False))


if __name__=='__main__':main()
