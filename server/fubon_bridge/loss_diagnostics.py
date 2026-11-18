"""Descriptive, fixed-fill loss attribution. Never used to choose live orders."""
from collections import Counter, defaultdict
from statistics import mean, median, quantiles

from .intraday_strategy import futures_tax
from .opportunity_research import COST


def distribution(values):
    if not values:
        return dict(count=0,mean=None,median=None,p25=None,p75=None)
    quartiles=quantiles(values,n=4,method='inclusive') if len(values)>1 else [values[0]]*3
    return dict(count=len(values),mean=mean(values),median=median(values),
        p25=quartiles[0],p75=quartiles[2])


def decompose(trades,slip=2):
    """Add back explicit friction at the SAME recorded fills and exit decision.

    This is an accounting attribution, not a new zero-cost strategy replay.
    """
    components=[]
    for t in trades:
        price_pnl=(t['exit']-t['entry'])*(1 if t['side']=='Buy' else -1)*10
        fee=2*COST['feePerSide']
        tax=futures_tax(t['entry'],10,COST['taxRate'])+futures_tax(t['exit'],10,COST['taxRate'])
        slippage=2*slip*10
        if abs(t['net']-(price_pnl-fee-tax))>1e-7:
            raise ValueError('成交淨額與費稅無法對帳')
        components.append(dict(net=t['net'],fees=fee,taxes=tax,slippage=slippage,
            fixedPathGross=price_pnl+slippage,reason=t['reason'],plan=t['plan'],side=t['side']))
    result={name:sum(t[name] for t in components) for name in ('net','fees','taxes','slippage','fixedPathGross')}
    result.update(count=len(trades),winCount=sum(t['net']>0 for t in trades),
        pnl=distribution([t['net'] for t in trades]),
        meanWinner=mean([t['net'] for t in trades if t['net']>0]) if any(t['net']>0 for t in trades) else None,
        meanLoser=mean([t['net'] for t in trades if t['net']<0]) if any(t['net']<0 for t in trades) else None,
        byReason={reason:dict(count=sum(t['reason']==reason for t in components),
            net=sum(t['net'] for t in components if t['reason']==reason)) for reason in sorted({t['reason'] for t in components})})
    return result


def matched_latency(normal,delayed):
    key=lambda t:(t['time'],t['side'],t['plan'])
    left={key(t):t for t in normal};right={key(t):t for t in delayed}
    shared=sorted(left.keys()&right.keys())
    return dict(shared=len(shared),normalOnly=len(left.keys()-right.keys()),
        delayedOnly=len(right.keys()-left.keys()),
        sharedNormalNet=sum(left[k]['net'] for k in shared),
        sharedDelayedNet=sum(right[k]['net'] for k in shared),
        sharedDifference=sum(right[k]['net']-left[k]['net'] for k in shared),
        flippedToLoss=sum(left[k]['net']>0 and right[k]['net']<=0 for k in shared),
        differences=distribution([right[k]['net']-left[k]['net'] for k in shared]))
