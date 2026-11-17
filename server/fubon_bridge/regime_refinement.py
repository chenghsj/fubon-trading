"""Bounded, research-only V3 refinements; no broker or execution integration."""
from collections import defaultdict
from dataclasses import asdict, dataclass
from statistics import mean, median, pstdev

from .learning_features import outcome, simulate
from .regime_strategy import RegimeStream, VERSION
from .strategy_session import opening_date, schedule

PROTOCOL = 'regime-refinement-development-only-v1'
CONFIG = dict(stopPoints=30, targetR=2, quantity=1, feePerSide=20,
    feeSource='assumed', slippagePoints=2, taxRate=.00002, taxRounding='per-contract-yuan')


@dataclass(frozen=True)
class Candidate:
    name: str
    trend: str = 'breakout'
    range_target: str = 'midpoint'
    horizon: int = 20
    minimum_net_rr: float = 1.


# Freeze the entire family before evaluating any new results. The original
# baseline is reported separately and cannot win the refinement selection.
CANDIDATES = (
    Candidate('quality_20'),
    Candidate('quality_40', horizon=40),
    Candidate('pullback_40', trend='pullback', horizon=40),
    Candidate('pullback_60', trend='pullback', horizon=60),
    Candidate('far_edge_pullback_40', trend='pullback', range_target='far_edge', horizon=40),
    Candidate('bands_pullback_40', trend='pullback', range_target='bands', horizon=40),
    Candidate('far_edge_breakout_40', range_target='far_edge', horizon=40),
)
BASELINE = Candidate('original_v3', minimum_net_rr=0.)
POLICY = dict(protocol=PROTOCOL, candidates=[asdict(c) for c in CANDIDATES],
    baseline=asdict(BASELINE), config=CONFIG, warmupMinutes=135,
    rangeNetRewardRisk=1, farEdgeFraction=.8, bandCandles3m=20, bandStandardDeviations=2,
    pullbackAverageCandles3m=5, pullbackSlopeCandles3m=1,
    selection='eligible first; maximize worst-fold stress net, then total stress net minus half normal close-mark drawdown',
    developmentFractions=[.3, .4, .5, .6],
    eligibility=dict(eachFoldTrades=20, aggregateBranchTrades=15,
        allFoldNormalAndStressPositive=True, bothBranchesStressPositive=True),
    evaluationScenes=['normal', 'extra_2pt_slippage', 'one_minute_delayed'],
    executionEnabled=False, adoptionAllowed=False)


def _signal(stream, original, prior_threes, prior_atr, candidate):
    signal = dict(original)
    if signal['regime'] not in {'range', 'trend'}:
        return None
    bar, previous = stream.minutes[-1], stream.minutes[-2]
    if signal['regime'] == 'trend' and candidate.trend == 'pullback':
        signal['side'] = None
        if len(prior_threes) < 6:
            return None
        average = mean(b['close'] for b in prior_threes[-5:])
        old_average = mean(b['close'] for b in prior_threes[-6:-1])
        if signal['direction'] == 'up' and average > old_average and previous['close'] <= average < bar['close'] and bar['low'] <= average:
            signal.update(side='Buy', trigger=average)
        elif signal['direction'] == 'down' and average < old_average and previous['close'] >= average > bar['close'] and bar['high'] >= average:
            signal.update(side='Sell', trigger=average)
    elif signal['regime'] == 'range':
        if candidate.range_target == 'bands':
            signal['side'] = None
            if len(prior_threes) < 20:
                return None
            rows = prior_threes[-20:]
            center = mean(b['close'] for b in rows)
            deviation = pstdev(b['close'] for b in rows)
            lower, upper = center-2*deviation, center+2*deviation
            if deviation > 0 and previous['close'] <= lower < bar['close'] < center and bar['low'] <= lower:
                signal.update(side='Buy', trigger=lower, targetLevel=center,
                    stopLevel=min(b['low'] for b in rows)-.25*prior_atr)
            elif deviation > 0 and previous['close'] >= upper > bar['close'] > center and bar['high'] >= upper:
                signal.update(side='Sell', trigger=upper, targetLevel=center,
                    stopLevel=max(b['high'] for b in rows)+.25*prior_atr)
            signal.update(low=min(b['low'] for b in rows), high=max(b['high'] for b in rows))
        elif candidate.range_target == 'far_edge' and signal['side']:
            width = signal['high']-signal['low']
            signal['targetLevel'] = signal['low']+width*(.8 if signal['side']=='Buy' else .2)
    if not signal['side']:
        return None
    signal.update(atr=prior_atr, features=stream.features(signal))
    return signal


def build_candidates(data, dates, candidates=(*CANDIDATES, BASELINE)):
    """Only requested opening dates enter the stream or event construction."""
    session, selected = data['strategySession'], set(dates)
    spec = schedule(session)
    grouped = defaultdict(list)
    for bar in data['futures']:
        day = opening_date(bar['time'], session)
        if day in selected:
            start = int(spec.window(day)[0].timestamp())
            if start < bar['time'] <= start+spec.duration*60:
                grouped[day].append(bar)
    results = {c.name: [] for c in candidates}
    for day, bars in sorted(grouped.items()):
        start = int(spec.window(day)[0].timestamp())
        stream = RegimeStream(start, session)
        for i, bar in enumerate(bars):
            prior_threes, prior_atr = stream.threes[:], stream.atr3
            original = stream.push(bar)
            if bar['time'] > start+spec.last_entry*60 or original['regime'] == 'warming':
                continue
            for candidate in candidates:
                signal = _signal(stream, original, prior_threes, prior_atr, candidate)
                if signal is None:
                    continue
                path = [b for b in bars[i+1:i+1+candidate.horizon] if b['time'] <= start+spec.exit_minute*60]
                if path:
                    results[candidate.name].append(dict(day=day, time=bar['time'], side=signal['side'],
                        signal=signal, x=signal['features'], path=path, labelEnd=path[-1]['time'],
                        month=bar['month'], strategyVersion=VERSION, strategySession=session,
                        horizonMinutes=candidate.horizon))
    return results


def accepted_events(events, candidate, extra_slippage=0, delay=0):
    """Admission uses delayed entry prices; the original deadline never moves."""
    from .intraday_strategy import entry_plan, futures_tax
    from .regime_strategy import protection
    kept = []
    slip = CONFIG['slippagePoints']+extra_slippage
    cfg = dict(strategy_version=VERSION, stop_points=CONFIG['stopPoints'],
        target_points=CONFIG['stopPoints']*CONFIG['targetR'], slippage_points=slip,
        fee_per_side=CONFIG['feePerSide'], tax_rate=CONFIG['taxRate'], loss_limit=1000)
    for source in events:
        event = source if not delay else source | dict(path=source['path'][delay:])
        if not event['path']:
            continue
        spec = schedule(event['strategySession'])
        start = int(spec.window(event['day'])[0].timestamp())
        if event['path'][0]['time']-60 > start+spec.last_entry*60:
            continue
        side = 1 if event['side']=='Buy' else -1
        raw = event['path'][0]['open']
        fill = raw+side*slip
        plan, _ = entry_plan(cfg, event['signal'], event['side'], fill, raw, 0)
        if plan is None:
            continue
        _, target = protection(cfg, plan, event['side'], fill)
        exit_price = target-side*slip
        reward = (exit_price-fill)*side*10-2*CONFIG['feePerSide']-futures_tax(fill,10,CONFIG['taxRate'])-futures_tax(max(1,exit_price),10,CONFIG['taxRate'])
        if event['signal']['regime'] == 'range' and reward < candidate.minimum_net_rr*plan['estimatedRisk']:
            continue
        kept.append(event)
    return kept


def summarize(result, dates):
    trades = result['trades']
    values = [t['net'] for t in trades]
    days = dict.fromkeys(dates, 0.)
    for trade in trades:
        day = opening_date(trade['time'], result['strategySession'])
        days[day] += trade['net']
    gross = sum((t['exit']-t['entry'])*(1 if t['side']=='Buy' else -1)*10 for t in trades)
    return dict(result, mean=mean(values) if values else None, median=median(values) if values else None,
        grossAfterSlippage=gross, winRate=sum(v>0 for v in values)/len(values) if values else None,
        averageWin=mean([v for v in values if v>0]) if any(v>0 for v in values) else None,
        averageLoss=mean([v for v in values if v<0]) if any(v<0 for v in values) else None,
        dates=days, withoutBestDay=result['net']-max(days.values(),default=0),
        byRegime={regime: dict(count=sum(t['regime']==regime for t in trades),
            net=sum(t['net'] for t in trades if t['regime']==regime)) for regime in ('range','trend')})


def compare(events, candidate, dates, session):
    output = {}
    for name, extra, delay in (('normal',0,0), ('stress',2,0), ('delayed',0,1)):
        eligible = accepted_events(events, candidate, extra, delay)
        result = simulate(eligible, CONFIG, extra_slippage=extra)
        for trade in result['trades']:
            if trade['reason'] == '20分鐘／日內期限':
                trade['reason'] = f'{candidate.horizon}分鐘／日內期限'
        output[name] = summarize(dict(result, strategySession=session), dates)
    return output


def select(development):
    """Takes development folds only. Final evaluation is a separate command."""
    rankings = []
    for candidate in CANDIDATES:
        folds = development[candidate.name]
        normal, stress = [f['normal'] for f in folds], [f['stress'] for f in folds]
        branches = {regime: dict(count=sum(f['byRegime'][regime]['count'] for f in stress),
            net=sum(f['byRegime'][regime]['net'] for f in stress)) for regime in ('range','trend')}
        eligible = all(n['count']>=20 and n['net']>0 and s['net']>0 for n,s in zip(normal,stress)) and all(
            b['count']>=15 and b['net']>0 for b in branches.values())
        rankings.append(dict(name=candidate.name, eligible=eligible, branches=branches,
            worstFoldStressNet=min(f['net'] for f in stress),
            score=sum(f['net'] for f in stress)-.5*max(f['maxDrawdown'] for f in normal)))
    chosen = max(rankings, key=lambda r:(r['eligible'],r['worstFoldStressNet'],r['score']))
    return dict(chosen=chosen, rankings=rankings, eligible=chosen['eligible'],
        evaluationUsed=False, executionEnabled=False, adoptionAllowed=False)
