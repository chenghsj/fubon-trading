"""Cash-session event features and cost labels; all features end at signal time."""
from collections import defaultdict
from datetime import datetime
from .auto_trading import opening_signal
from .intraday_strategy import entry_plan, futures_tax
from .learning_data import STOCKS, quality
from .mapping import TAIPEI

FEATURES = ['return5','return15','atrRatio','rangeRatio','breakoutAtr','bodyRatio','volumeRatio','sessionTime',*[f'stock{c}Return5' for c in STOCKS]]
POLICY = dict(version='orb-lightgbm-v1',horizonMinutes=20,threshold=.5,lossLimit=1000,atrPeriod=14,atrMultiplier=1.5)


def build_events(data):
    q = quality(data)
    eligible = set(q['completeDates'])
    grouped = defaultdict(list)
    stocks = {code:{b['time']:b for b in data['stocks'][code]} for code in STOCKS}
    for b in data['futures']:
        day = datetime.fromtimestamp(b['time'],TAIPEI).date().isoformat()
        if day in eligible and 541 <= (b['time']+28800)%86400//60 <= 800:
            grouped[day].append(b)
    events, missing = [], 0
    for day,bars in sorted(grouped.items()):
        for i,b in enumerate(bars):
            minute = (b['time']+28800)%86400//60
            if not 560 <= minute <= 790 or b['time']%300:
                continue
            signal = opening_signal(bars[:i+1],b['time'])
            if not signal['side']:
                continue
            if any(b['time'] not in stocks[c] or b['time']-300 not in stocks[c] for c in STOCKS):
                missing += 1; continue
            side = 1 if signal['side']=='Buy' else -1
            atr = signal.get('atr')
            if atr is None or atr <= 0:
                continue
            average_volume = sum(x['volume'] for x in bars[i-19:i+1])/20
            high,low = signal['high'],signal['low']
            boundary = high if side>0 else low
            x = [side*(b['close']/bars[i-5]['close']-1),side*(b['close']/bars[i-15]['close']-1),
                atr/b['close'],(high-low)/b['close'],side*(b['close']-boundary)/atr,
                side*(b['close']-b['open'])/max(1,b['high']-b['low']),b['volume']/max(1,average_volume),(minute-540)/260]
            x += [side*(stocks[c][b['time']]['close']/stocks[c][b['time']-300]['close']-1) for c in STOCKS]
            events.append(dict(day=day,time=b['time'],side=signal['side'],signal=signal,x=x,
                path=bars[i+1:min(i+21,len(bars))],month=b['month']))
    return events,dict(q,events=len(events),missingStockEvents=missing)


def outcome(event, config, extra_slippage=0, day_net=0):
    path = event['path']
    if not path:
        return None
    side = 1 if event['side']=='Buy' else -1
    slip = config['slippagePoints']+extra_slippage
    entry = path[0]['open']+side*slip
    cfg = dict(strategy_version='orb_atr_v2',stop_points=config['stopPoints'],target_points=config['stopPoints']*config['targetR'],
        slippage_points=slip,fee_per_side=config['feePerSide'],tax_rate=config['taxRate'],loss_limit=1000)
    plan,_ = entry_plan(cfg,event['signal'],event['side'],entry,path[0]['open'],day_net)
    if plan is None:
        return None
    stop,target = entry-side*plan['stopPoints'],entry+side*plan['targetPoints']
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
                net=net,label=int(net>0),stopPoints=plan['stopPoints'],reason=reason,marks=marks)
        marks.append(dict(time=b['time'],value=marked))


def simulate(events, config, scores=None, extra_slippage=0):
    balance=peak=drawdown=0
    day=None;day_net=0;used=set();busy=0;trades=[]
    for event in events:
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


def chronological_split(events, complete_dates):
    n=len(complete_dates);a=max(1,int(n*.6));b=max(a+1,int(n*.8))
    groups=[complete_dates[:a],complete_dates[a:b],complete_dates[b:]]
    sets=[set(g) for g in groups]
    partitions=[[e for e in events if e['day'] in days] for days in sets]
    purged=[]
    for i in range(2):
        boundary=int(datetime.fromisoformat(groups[i+1][0]).replace(tzinfo=TAIPEI).timestamp()) if groups[i+1] else float('inf')
        before=partitions[i]
        partitions[i]=[e for e in before if e['labelEnd']<boundary]
        purged.append(len(before)-len(partitions[i]))
    return partitions,dict(trainDates=groups[0],validationDates=groups[1],testDates=groups[2],purged=purged)
