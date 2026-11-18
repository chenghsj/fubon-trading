"""Fixed, causal 1m/3m/15m range/trend hypothesis shared by Paper and research."""
import math

from .strategy_session import opening_date, schedule
from .learning_multiframe import MTF_FEATURES, candle_features

VERSION = 'regime_mtf_v3'
POLICY = dict(version=VERSION, timeframes=[1, 3, 15], decisionMinutes=1,
    efficiencyPeriods=8, trendThreshold=.55, rangeThreshold=.25,
    trendChannelCandles=6, rangeChannelCandles=12, rangeEntryFraction=.2,
    atrPeriod=14, atrMethod='wilder', trendStopAtr=1.5, rangeStopAtr=.25,
    minimumCostRoom=2, horizonMinutes=20, warmupMinutes=135,
    contextEndsBeforeSignalMinute=True, completedOnly=True)
FEATURES = ['regimeRange', 'regimeTrend', 'efficiency', 'directionAlignment',
    'atr3Ratio', 'channelRatio', 'distanceFromLowAtr', 'distanceFromHighAtr',
    'targetRoomAtr', 'sessionTime', *MTF_FEATURES]


def _candle(rows):
    return dict(time=rows[-1]['time'], open=rows[0]['open'],
        high=max(b['high'] for b in rows), low=min(b['low'] for b in rows),
        close=rows[-1]['close'], volume=sum(b['volume'] for b in rows))


class RegimeStream:
    """One session, strict chronological minutes; no state borrowed across breaks."""
    def __init__(self, start, session):
        if session not in {'regular', 'afterhours'}:
            raise ValueError('區間／順勢策略僅支援完整期貨日盤或夜盤')
        self.start, self.session = int(start), session
        self.minutes, self.threes, self.fifteens = [], [], []
        self.atr3, self.tr_seed = None, 0.

    def push(self, bar):
        expected = self.start + (len(self.minutes)+1)*60
        if bar['time'] != expected:
            raise ValueError('區間／順勢策略所需分鐘資料缺漏、重複或未依時間排序')
        if (not all(isinstance(bar[k], (int, float)) and math.isfinite(bar[k]) for k in ('open', 'high', 'low', 'close', 'volume'))
            or min(bar[k] for k in ('open', 'high', 'low', 'close')) <= 0 or bar['volume'] < 0
            or bar['high'] < max(bar['open'], bar['close']) or bar['low'] > min(bar['open'], bar['close'])):
            raise ValueError('區間／順勢策略分鐘行情無效')
        self.minutes.append(bar)
        count = len(self.minutes)
        if count % 15 == 0:
            self.fifteens.append(_candle(self.minutes[-15:]))
        # Signal-minute 3m OHLC must not define its own trigger/channel.
        result = self._signal(bar)
        if count % 3 == 0:
            candle = _candle(self.minutes[-3:])
            previous = self.threes[-1]['close'] if self.threes else None
            tr = candle['high']-candle['low'] if previous is None else max(
                candle['high']-candle['low'], abs(candle['high']-previous), abs(candle['low']-previous))
            self.threes.append(candle)
            if len(self.threes) <= 14:
                self.tr_seed += tr
                if len(self.threes) == 14:
                    self.atr3 = self.tr_seed/14
            else:
                self.atr3 = (self.atr3*13+tr)/14
        if result['side']:
            result['features'] = self.features(result)
        return result

    def features(self, signal):
        side = 1 if signal['side'] == 'Buy' else -1
        price, atr = signal['close'], signal['atr']
        direction = 1 if signal['direction'] == 'up' else -1 if signal['direction'] == 'down' else 0
        values = [float(signal['regime']=='range'), float(signal['regime']=='trend'),
            signal['efficiency'], side*direction, atr/price, (signal['high']-signal['low'])/price,
            (price-signal['low'])/atr, (signal['high']-price)/atr,
            abs(signal.get('targetLevel',price)-price)/atr,
            (signal['time']-self.start)/(schedule(self.session).duration*60)]
        for rows in (self.minutes, self.threes, self.fifteens):
            values.extend(candle_features(rows, side))
        return values

    def _signal(self, bar):
        result = dict(time=bar['time'], side=None, high=None, low=None, close=bar['close'],
            score=None, atr=self.atr3, regime='warming', efficiency=None,
            strategyVersion=VERSION, reason='等待9根完整15分K（當盤135分鐘暖身）')
        if len(self.fifteens) < 9 or self.atr3 is None or self.atr3 <= 0:
            return result
        closes = [b['close'] for b in self.fifteens[-9:]]
        change = closes[-1]-closes[0]
        distance = sum(abs(b-a) for a, b in zip(closes, closes[1:]))
        efficiency = abs(change)/distance if distance else 0.
        regime = 'trend' if efficiency >= .55 and change else 'range' if distance and efficiency <= .25 else 'uncertain'
        result.update(regime=regime, efficiency=efficiency, direction='up' if change > 0 else 'down' if change < 0 else None, regimeTime=self.fifteens[-1]['time'],
            contextTime=self.threes[-1]['time'], reason='15分盤勢不明確，等待區間或趨勢確認')
        minute = (bar['time']-self.start)//60
        if not 20 <= minute <= schedule(self.session).last_entry:
            result['reason'] = '不在此盤別新進場時段'
            return result
        if regime == 'uncertain':
            return result
        size = 6 if regime == 'trend' else 12
        rows = self.threes[-size:]
        if len(rows) != size:
            return dict(result, reason='3分結構資料尚未完整')
        high, low = max(b['high'] for b in rows), min(b['low'] for b in rows)
        previous, current = self.minutes[-2]['close'], bar['close']
        result.update(high=high, low=low)
        if regime == 'trend':
            if change > 0 and previous <= high < current:
                result.update(side='Buy', trigger=high, reason='15分上行趨勢；1分收盤突破先前18分鐘高點')
            elif change < 0 and previous >= low > current:
                result.update(side='Sell', trigger=low, reason='15分下行趨勢；1分收盤跌破先前18分鐘低點')
            else:
                result['reason'] = '15分趨勢已確認，等待同向3分結構的1分突破'
        else:
            width, midpoint = high-low, (high+low)/2
            lower, upper = low+width*.2, high-width*.2
            if width <= 0:
                return dict(result, reason='滾動區間沒有有效寬度')
            if previous <= lower < current < midpoint and bar['low'] <= lower:
                result.update(side='Buy', trigger=lower, targetLevel=midpoint,
                    stopLevel=low-.25*self.atr3, reason='15分盤整；1分由區間下緣回到內側，目標中線')
            elif previous >= upper > current > midpoint and bar['high'] >= upper:
                result.update(side='Sell', trigger=upper, targetLevel=midpoint,
                    stopLevel=high+.25*self.atr3, reason='15分盤整；1分由區間上緣回到內側，目標中線')
            else:
                result['reason'] = '15分盤整已確認，等待區間邊緣反轉，區間中段不進場'
        return result


def regime_signal(bars, decision, session):
    start = int(schedule(session).window(opening_date(decision, session))[0].timestamp())
    result = dict(time=decision, side=None, high=None, low=None, close=None,
        score=None, atr=None, regime='warming', efficiency=None,
        strategyVersion=VERSION, reason='等待完整已收盤1分K')
    try:
        stream = RegimeStream(start, session)
        for bar in bars:
            if start < bar['time'] <= decision:
                result = stream.push(bar)
        if result['time'] != decision or not stream.minutes:
            return dict(result, time=decision, side=None, reason='缺少當前已收盤1分K')
        return result
    except (ValueError, KeyError, TypeError) as error:
        return dict(result, time=decision, side=None, reason=str(error) if isinstance(error, ValueError) else '區間／順勢行情欄位無效')


def entry_plan(cfg, signal, action, limit, price, realized):
    from .intraday_strategy import futures_tax
    side = 1 if action == 'Buy' else -1
    if (signal.get('strategyVersion') != VERSION or signal.get('side') != action
        or signal.get('regime') not in {'range', 'trend'}):
        return None, '沒有有效區間／順勢訊號'
    fields = ('close', 'atr', 'trigger', 'high', 'low')
    if any(not isinstance(signal.get(k), (int, float)) or not math.isfinite(signal[k]) for k in fields):
        return None, '區間／順勢訊號資料不完整'
    if abs(limit-signal['close']) > 10:
        return None, '委託價偏離訊號收盤超過10點，不追價'
    if signal['atr'] <= 0 or (price-signal['trigger'])*side <= 0 or (limit-signal['trigger'])*side <= 0:
        return None, '價格已退回進場觸發線，跳過失效訊號'
    stop = max(30, cfg['stop_points'], math.ceil(1.5*signal['atr']))
    target = math.ceil(stop*cfg['target_points']/cfg['stop_points'])
    if signal['regime'] == 'range':
        if any(not isinstance(signal.get(k), (int, float)) or not math.isfinite(signal[k]) for k in ('stopLevel', 'targetLevel')):
            return None, '區間停損或中線資料不完整'
        stop = max(30, cfg['stop_points'], math.ceil(side*(limit-signal['stopLevel'])))
        target = math.floor(side*(signal['targetLevel']-limit))
        cost_points = 2*cfg['slippage_points']+(2*cfg['fee_per_side']+futures_tax(limit,10,cfg['tax_rate'])+futures_tax(max(1,signal['targetLevel']),10,cfg['tax_rate']))/10
        if (side*(signal['targetLevel']-price) < 2*cost_points
            or target <= cost_points or not signal['low'] < price < signal['high']):
            return None, '區間中線剩餘空間不足以覆蓋成本緩衝，跳過'
    plan = dict(stopPoints=stop, targetPoints=target, estimatedRisk=0, anchorMode='fill',
        strategyVersion=VERSION, regime=signal['regime'], signalTime=signal['time'],
        signalClose=signal['close'], atr=signal['atr'])
    if signal['regime'] == 'range':
        plan.update(rangeStopLevel=signal['stopLevel'], rangeTargetLevel=signal['targetLevel'],
            minimumStopPoints=max(30,cfg['stop_points']))
    protected_stop, _ = protection(cfg, plan, action, limit)
    risk = estimated_risk(cfg, action, limit, protected_stop)
    if realized is None or risk > min(cfg['loss_limit'],cfg['loss_limit']+realized):
        return None, '含費稅的單口停損估計超過剩餘損失預算，跳過'
    plan.update(estimatedRisk=risk, riskBudget=min(cfg['loss_limit'],cfg['loss_limit']+realized))
    return plan, None


def protection(cfg, plan, action, fill):
    """Freeze the range midpoint; only the minimum stop distance follows fills."""
    side = 1 if action == 'Buy' else -1
    if plan.get('regime') == 'range':
        minimum = plan.get('minimumStopPoints',max(30,cfg['stop_points']))
        if side > 0:
            return min(math.floor(plan['rangeStopLevel']),fill-minimum), math.floor(plan['rangeTargetLevel'])
        return max(math.ceil(plan['rangeStopLevel']),fill+minimum), math.ceil(plan['rangeTargetLevel'])
    return fill-side*plan['stopPoints'], fill+side*plan['targetPoints']


def estimated_risk(cfg, action, fill, stop):
    from .intraday_strategy import futures_tax
    side = 1 if action == 'Buy' else -1
    worst = stop-side*cfg['slippage_points']
    return abs(fill-worst)*10+2*cfg['fee_per_side']+futures_tax(fill,10,cfg['tax_rate'])+futures_tax(max(1,worst),10,cfg['tax_rate'])
