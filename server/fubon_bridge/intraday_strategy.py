"""Versioned signal-time risk policy, independent of brokerage calls."""
from datetime import datetime
import math
from .mapping import TAIPEI
from .strategy_session import schedule, opening_date

ATR_PERIOD = 14
ATR_MULTIPLIER = 1.5
MAX_ENTRY_DRIFT = 10

def futures_tax(price, multiplier, tax_rate):
    # Python round uses bankers rounding; statutory positive tax uses half-up.
    return math.floor(price*multiplier*tax_rate+.5)

def cash_atr(bars, decision, session='cash'):
    start = int(schedule(session).window(opening_date(decision, session))[0].timestamp())
    index = {b['time']:b for b in bars if start<b['time']<=decision}
    count = (decision-start)//60
    if count<ATR_PERIOD or any(start+i*60 not in index for i in range(1,count+1)):
        return None
    atr, seed, previous = None,0,None
    for i in range(1,count+1):
        b=index[start+i*60]
        tr=b['high']-b['low'] if previous is None else max(b['high']-b['low'],abs(b['high']-previous),abs(b['low']-previous))
        if i<=ATR_PERIOD:
            seed+=tr
            if i==ATR_PERIOD:atr=seed/ATR_PERIOD
        else:atr=(atr*(ATR_PERIOD-1)+tr)/ATR_PERIOD
        previous=b['close']
    return atr

def entry_plan(cfg, signal, action, limit, price, realized):
    if cfg.get('strategy_version') == 'regime_mtf_v3':
        from .regime_strategy import entry_plan as regime_entry_plan
        return regime_entry_plan(cfg, signal, action, limit, price, realized)
    side=1 if action=='Buy' else -1
    boundary=signal.get('high') if side==1 else signal.get('low')
    close=signal.get('close')
    if signal.get('side')!=action or close is None or boundary is None:
        return None,'訊號資料不完整，不建立進場意圖'
    if (price-boundary)*side<=0 or (limit-boundary)*side<=0:
        return None,'價格已回到開盤區間，跳過失效突破'
    if abs(limit-close)>MAX_ENTRY_DRIFT:
        return None,'委託價偏離訊號收盤超過 10 點，不追價'
    stop=cfg['stop_points']
    if cfg.get('strategy_version','orb_v1')=='orb_atr_v2':
        atr=signal.get('atr')
        if atr is None or not math.isfinite(atr) or atr<=0:
            return None,'Wilder ATR14 尚未暖身或分鐘資料缺漏'
        stop=max(stop,math.ceil(ATR_MULTIPLIER*atr))
    target=math.ceil(stop*cfg['target_points']/cfg['stop_points'])
    worst=limit-side*(stop+cfg['slippage_points'])
    risk=(stop+cfg['slippage_points'])*10+2*cfg['fee_per_side']+futures_tax(limit,10,cfg['tax_rate'])+futures_tax(max(1,worst),10,cfg['tax_rate'])
    if realized is None or risk>min(cfg['loss_limit'],cfg['loss_limit']+realized):
        return None,'含費稅的單口停損估計超過剩餘損失預算，跳過'
    return dict(stopPoints=stop,targetPoints=target,estimatedRisk=risk,anchorMode='fill',
        strategyVersion=cfg.get('strategy_version','orb_v1'),signalTime=signal['time'],signalClose=close,atr=signal.get('atr')),None


def opening_signal(bars, decision, basket=None, stocks=None, session='cash', decision_minutes=5):
    """Same 09:00 cash-aligned range/cross as the historical harness; exact completed bars."""
    start = int(schedule(session).window(opening_date(decision, session))[0].timestamp())
    index = {b["time"]:b for b in bars if start < b["time"] <= decision}
    if decision_minutes not in {1,5}:
        raise ValueError('不支援的訊號判斷頻率')
    required = {start+i*60 for i in range(1,16)} | {decision-i*60 for i in range(max(10,decision_minutes+1))}
    result = dict(time=decision, side=None, high=None, low=None, score=None, reason="等待完整已收盤分 K")
    if not required.issubset(index):
        return result
    high = max(index[start+i*60]["high"] for i in range(1,16))
    low = min(index[start+i*60]["low"] for i in range(1,16))
    previous, current = index[decision-decision_minutes*60]["close"], index[decision]["close"]
    side = None
    if current>high and previous<=high:
        side = "Buy"
    elif current<low and previous>=low:
        side = "Sell"
    result.update(high=high,low=low,side=side,close=current,atr=cash_atr(bars,decision,session),reason="沒有新的開盤區間穿越" if side is None else f"{decision_minutes} 分收盤突破開盤區間")
    if side and basket:
        score = 0
        for member in basket:
            quotes = {b["time"]:b for b in (stocks or {}).get(member["code"],[])}
            if decision not in quotes or decision-300 not in quotes:
                return dict(result,side=None,reason=f"{member['code']} 缺少同步資料，跳過此訊號")
            score += member["weight"]*(quotes[decision]["close"]/quotes[decision-300]["close"]-1)
        result["score"] = score
        if score*(1 if side=="Buy" else -1)<=0:
            result.update(side=None,reason="權值股假設籃子未同向，跳過此訊號")
    return result
