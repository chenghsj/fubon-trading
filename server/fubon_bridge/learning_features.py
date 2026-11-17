"""Cash-session event features and cost labels; all features end at signal time."""
from collections import defaultdict
from datetime import datetime
import math
from .intraday_strategy import opening_signal, entry_plan, futures_tax
from .learning_data import STOCKS, quality
from .mapping import TAIPEI
from .strategy_session import schedule, opening_date
from .learning_multiframe import MTF_FEATURES, decision_minutes, multiframe_features

FEATURES = ['return5','return15','atrRatio','rangeRatio','breakoutAtr','bodyRatio','volumeRatio','sessionTime',*[f'stock{c}Return5' for c in STOCKS]]
POLICY = dict(version='orb-lightgbm-v1',horizonMinutes=20,threshold=.5,lossLimit=1000,atrPeriod=14,atrMultiplier=1.5)


def features_for(session='cash', feature_set='base'):
    decision_minutes(feature_set)
    if feature_set == 'regime_1_3_15':
        from .regime_strategy import FEATURES as REGIME_FEATURES
        if session == 'cash':
            raise ValueError('區間／順勢模型須使用完整期貨日盤或夜盤')
        return REGIME_FEATURES
    base = FEATURES if session == 'cash' else FEATURES[:8]
    return base + MTF_FEATURES if feature_set == 'mtf_1_3_15' else base


def policy_for(session='cash', feature_set='base'):
    interval = decision_minutes(feature_set)
    spec = schedule(session)
    if feature_set == 'regime_1_3_15':
        from .regime_strategy import POLICY as REGIME_POLICY
        features_for(session, feature_set)
        return dict(POLICY, version='regime-lightgbm-v1', strategySession=session,
            featureSet=feature_set, decisionMinutes=1, signalPolicy=REGIME_POLICY,
            startMinute=spec.start_minute, duration=spec.duration, exitMinute=spec.exit_minute, lastEntry=spec.last_entry)
    policy = POLICY if session == 'cash' else dict(POLICY, version='futures-orb-lightgbm-v1', strategySession=session,
        startMinute=spec.start_minute, duration=spec.duration, exitMinute=spec.exit_minute, lastEntry=spec.last_entry)
    if feature_set == 'base':
        return policy
    return dict(policy, version='orb-lightgbm-mtf-v1', featureSet=feature_set,
        timeframes=[1,3,15], decisionMinutes=interval, alignment='session-open',
        completedOnly=True, trendCandles=3, volumeCandles=5, minPeriods=1)


def signal_features(bars, decision, stocks, session='cash', feature_set='base'):
    """Identical closed-bar input for historical training and online inference."""
    if feature_set == 'regime_1_3_15':
        from .regime_strategy import regime_signal
        signal = regime_signal(bars, decision, session)
        values = signal.get('features', [])
        if not signal['side'] or len(values) != len(features_for(session, feature_set)) or not all(math.isfinite(v) for v in values):
            raise ValueError('沒有有效區間／順勢訊號或多週期資料不完整')
        return signal, values
    spec = schedule(session)
    start = int(spec.window(opening_date(decision, session))[0].timestamp())
    closed = [b for b in bars if start < b['time'] <= decision]
    index = {b['time']: b for b in closed}
    count = (decision-start)//60
    interval = decision_minutes(feature_set)
    if decision % (interval*60) or count < 20 or count > spec.last_entry or len(index) != len(closed):
        raise ValueError(f'模型需要所選盤別進場時段的唯一已收盤{interval}分訊號')
    if set(index) != {start+i*60 for i in range(1, count+1)}:
        raise ValueError('模型所需期貨分鐘資料缺漏')
    ordered = [index[start+i*60] for i in range(1, count+1)]
    for b in ordered:
        if (not all(math.isfinite(b[k]) for k in ('open','high','low','close','volume'))
            or min(b[k] for k in ('open','high','low','close')) <= 0 or b['volume'] < 0
            or b['high'] < max(b['open'],b['close']) or b['low'] > min(b['open'],b['close'])):
            raise ValueError('模型期貨分鐘資料無效')
    signal = opening_signal(ordered, decision, session=session, decision_minutes=interval)
    atr = signal.get('atr')
    if not signal['side'] or atr is None or not math.isfinite(atr) or atr <= 0:
        raise ValueError('沒有有效突破或ATR尚未暖身')
    stock_index = {}
    for code in STOCKS if session == 'cash' else ():
        values = [b for b in stocks.get(code, []) if b['time'] in {decision, decision-300}]
        rows = {b['time']: b for b in values}
        if (len(values) != 2 or len(rows) != 2
            or any(not math.isfinite(b['close']) or b['close'] <= 0 for b in values)):
            raise ValueError(f'{code} 缺少模型所需同步收盤資料')
        stock_index[code] = rows
    side = 1 if signal['side'] == 'Buy' else -1
    b = ordered[-1]
    boundary = signal['high'] if side > 0 else signal['low']
    average_volume = sum(row['volume'] for row in ordered[-20:])/20
    x = [side*(b['close']/index[decision-300]['close']-1), side*(b['close']/index[decision-900]['close']-1),
        atr/b['close'], (signal['high']-signal['low'])/b['close'], side*(b['close']-boundary)/atr,
        side*(b['close']-b['open'])/max(1,b['high']-b['low']), b['volume']/max(1,average_volume), count/spec.duration]
    x += [side*(stock_index[c][decision]['close']/stock_index[c][decision-300]['close']-1) for c in STOCKS if session == 'cash']
    if feature_set == 'mtf_1_3_15':
        x += multiframe_features(ordered, start, decision, side)
    if len(x) != len(features_for(session,feature_set)) or not all(math.isfinite(value) for value in x):
        raise ValueError('模型特徵包含無效數值')
    return signal, x


def build_events(data, feature_set='base'):
    if feature_set == 'regime_1_3_15':
        from .regime_research import build_events as build_regime_events
        events, diagnostics = build_regime_events(data)
        return events, dict(diagnostics, missingStockEvents=0)
    session = data.get('strategySession', 'cash')
    spec = schedule(session)
    interval = decision_minutes(feature_set)
    q = quality(data)
    eligible = set(q['completeDates'])
    grouped = defaultdict(list)
    stocks = {code:{b['time']:b for b in data['stocks'][code]} for code in STOCKS}
    for b in data['futures']:
        day = opening_date(b['time'], session)
        start = spec.window(day)[0].timestamp()
        if day in eligible and 0 < b['time']-start <= spec.duration*60:
            grouped[day].append(b)
    events, missing = [], 0
    for day,bars in sorted(grouped.items()):
        for i,b in enumerate(bars):
            start = spec.window(day)[0].timestamp()
            minute = (b['time']-start)//60
            if not 20 <= minute <= spec.last_entry or b['time']%(interval*60):
                continue
            signal = opening_signal(bars[:i+1],b['time'],session=session,decision_minutes=interval)
            if not signal['side']:
                continue
            if session == 'cash' and any(b['time'] not in stocks[c] or b['time']-300 not in stocks[c] for c in STOCKS):
                missing += 1; continue
            try:
                signal, x = signal_features(bars[:i+1], b['time'],
                    {c:[stocks[c][t] for t in (b['time']-300,b['time'])] for c in STOCKS} if session == 'cash' else {}, session, feature_set)
            except ValueError:
                continue
            events.append(dict(day=day,time=b['time'],side=signal['side'],signal=signal,x=x,
                path=[row for row in bars[i+1:min(i+21,len(bars))] if row['time'] <= start+spec.exit_minute*60],month=b['month'],strategySession=session))
    return events,dict(q,events=len(events),missingStockEvents=missing)


def outcome(event, config, extra_slippage=0, day_net=0):
    path = event['path']
    if not path:
        return None
    side = 1 if event['side']=='Buy' else -1
    slip = config['slippagePoints']+extra_slippage
    entry = path[0]['open']+side*slip
    cfg = dict(strategy_version=event.get('strategyVersion','orb_atr_v2'),stop_points=config['stopPoints'],target_points=config['stopPoints']*config['targetR'],
        slippage_points=slip,fee_per_side=config['feePerSide'],tax_rate=config['taxRate'],loss_limit=1000)
    plan,_ = entry_plan(cfg,event['signal'],event['side'],entry,path[0]['open'],day_net)
    if plan is None:
        return None
    stop,target = entry-side*plan['stopPoints'],entry+side*plan['targetPoints']
    if event.get('strategyVersion') == 'regime_mtf_v3':
        from .regime_strategy import protection
        stop,target = protection(cfg,plan,event['side'],entry)
    fee,tax = config['feePerSide'],config['taxRate']
    cost = lambda price: fee+futures_tax(price,10,tax)
    marks=[]
    for i,b in enumerate(path):
        stop_hit = side*(b['low' if side>0 else 'high']-stop)<=0
        target_hit = side*(b['high' if side>0 else 'low']-target)>=0
        gap_stop = side*(b['open']-stop)<=0
        gap_target = side*(b['open']-target)>=0
        exit_price = None
        reason = ''
        if gap_stop: exit_price,reason=b['open'],'跳空停損'
        elif gap_target: exit_price,reason=target,'停利'
        elif stop_hit: exit_price,reason=stop,'同根雙觸採停損' if target_hit else '停損'
        elif target_hit: exit_price,reason=target,'停利'
        elif i==len(path)-1: exit_price,reason=b['close'],'20分鐘／日內期限'
        marked = (b['close']-entry)*side*10-cost(entry)-cost(b['close'])
        if exit_price is not None:
            exit_price -= side*slip
            if min(entry,exit_price)<=0:
                return None
            net=(exit_price-entry)*side*10-cost(entry)-cost(exit_price)
            marks.append(dict(time=b['time'],value=net))
            return dict(time=event['time'],exitTime=b['time'],side=event['side'],entry=entry,exit=exit_price,
                net=net,label=int(net>0),stopPoints=plan['stopPoints'],reason=reason,marks=marks,
                **({'regime':event['signal']['regime']} if event.get('strategyVersion') == 'regime_mtf_v3' else {}))
        marks.append(dict(time=b['time'],value=marked))


def simulate(events, config, scores=None, extra_slippage=0, *, regimes=None):
    balance=peak=drawdown=0
    day=None;day_net=0;used=set();busy=0;trades=[]
    for event in events:
        if regimes is not None and event['signal'].get('regime') not in regimes:
            continue
        if event['day']!=day:
            day=event['day'];day_net=0;used=set();busy=0
        if event['time']<busy or event['side'] in used or day_net<=-1000:
            continue
        if scores is not None and scores[event['time']]<POLICY['threshold']:
            continue
        trade=outcome(event,config,extra_slippage,day_net)
        if trade is None:
            continue
        for point in trade.pop('marks'):
            marked=balance+point['value'];peak=max(peak,marked);drawdown=max(drawdown,peak-marked)
        trades.append(trade)
        balance+=trade['net'];day_net+=trade['net'];used.add(event['side']);busy=trade['exitTime']
    won=sum(t['net'] for t in trades if t['net']>0)
    lost=-sum(t['net'] for t in trades if t['net']<0)
    return dict(trades=trades,net=balance,maxDrawdown=drawdown,count=len(trades),profitFactor=won/lost if lost else None)


def chronological_split(events, complete_dates, session='cash'):
    n=len(complete_dates);a=max(1,int(n*.6));b=max(a+1,int(n*.8))
    groups=[complete_dates[:a],complete_dates[a:b],complete_dates[b:]]
    sets=[set(g) for g in groups]
    partitions=[[e for e in events if e['day'] in days] for days in sets]
    purged=[]
    for i in range(2):
        boundary=(int(datetime.fromisoformat(groups[i+1][0]).replace(tzinfo=TAIPEI).timestamp()) if session == 'cash'
            else int(schedule(session).window(groups[i+1][0])[0].timestamp())) if groups[i+1] else float('inf')
        before=partitions[i]
        partitions[i]=[e for e in before if e['labelEnd']<boundary]
        purged.append(len(before)-len(partitions[i]))
    return partitions,dict(trainDates=groups[0],validationDates=groups[1],testDates=groups[2],purged=purged)
