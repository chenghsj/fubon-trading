"""Arrival-causal quote simulation. Recorded depth is not an actual fill."""
from bisect import bisect_left, bisect_right
from collections import defaultdict
import hashlib
import json
from pathlib import Path
import sqlite3

import numpy as np

from .intraday_strategy import futures_tax
from .market_capture import validate_frame
from .microstructure_research import SecondTape
from .research import digest
from .strategy_session import schedule

SCENARIOS=dict(normal=(0,0),stress=(2,0),delayed=(0,60))


class QuoteTape:
    def __init__(self,quotes,seconds,month):
        self.quotes=np.asarray(quotes,dtype=np.float64).reshape((-1,8))
        if (not np.isfinite(self.quotes).all() or (self.quotes[:,0]<self.quotes[:,1]).any()
            or (self.quotes[:,2:8]<=0).any() or (self.quotes[:,2]>self.quotes[:,3]).any()):
            raise ValueError('五檔時間、價量或深度無效')
        self.available=self.quotes[:,0].astype(np.int64);self.source=self.quotes[:,1].astype(np.int64)
        if len(self.available) and (np.diff(self.available)<0).any():
            raise ValueError('五檔可用時間不連續排序')
        self.seconds=SecondTape(seconds);self.month=month

    def at(self,at_us):
        i=bisect_right(self.available,int(at_us))-1
        if i<0 or at_us-self.source[i]>1_000_000 or at_us<self.source[i]:return None
        return i

    def fill(self,at_us):
        i=self.at(at_us)
        if i is not None:return i
        i=bisect_left(self.available,int(at_us))
        while i<len(self.available) and self.available[i]<=at_us+2_000_000:
            if self.available[i]-self.source[i]<=1_000_000:return i
            i+=1
        return None

    def features(self,at,atr):
        micro=self.seconds.features(at,atr);i=self.at(at*1_000_000);old=self.at((at-5)*1_000_000)
        last=self.seconds.price(at-1)
        if micro is None or i is None or old is None or last is None:return None
        q,p=self.quotes[i],self.quotes[old]
        imbalance=lambda r:(r[4]-r[5])/(r[4]+r[5])
        return micro+[(q[3]-q[2])/atr,imbalance(q),(q[6]-q[7])/(q[6]+q[7]),
            ((q[2]+q[3])/2-last[1])/atr,(at*1_000_000-q[1])/1_000_000,
            imbalance(q)-imbalance(p),((q[3]-q[2])-(p[3]-p[2]))/atr]

    def outcome(self,a,extra=0,delay=0,realized=0,marks=False):
        side=a.side;slip=2+extra;decision=a.time*1_000_000;deadline=a.bars[a.end]['time']*1_000_000
        entry_request=decision+(1+delay)*1_000_000;i=self.fill(entry_request)
        if i is None:return dict(status='not_sent',reason='missing_entry_quote',net=0.)
        entry_time=max(int(self.available[i]),entry_request)
        if entry_time>=deadline:return dict(status='not_sent',reason='expired',net=0.)
        if entry_time>(a.start+schedule(a.session).last_entry*60)*1_000_000:
            return dict(status='not_sent',reason='last_entry',net=0.)
        q=self.quotes[i];raw_entry=q[3] if side>0 else q[2];entry=raw_entry+side*slip
        stop=a.stop_level if a.stop_level is not None else entry-side*a.stop
        distance=side*(entry-stop)
        target=a.target_level if a.target_level is not None else entry+side*2*distance
        fee=lambda price:20+futures_tax(price,10,.00002)
        friction=2*slip+(fee(entry)+fee(target))/10
        risk=abs(entry-(stop-side*slip))*10+fee(entry)+fee(stop-side*slip)
        if (abs(entry-a.bars[a.index]['close'])>10 or side*(entry-stop)<=0 or side*(target-entry)<=0
            or min(entry,stop,target,stop-side*slip)<=0 or distance<30
            or side*(target-entry)<max((1.3 if a.plan=='range' else 2)*distance,3*friction)
            or side*((q[2] if side>0 else q[3])-stop)<=0 or risk>min(1000,1000+realized)):
            return dict(status='not_sent',reason='drift_structure_or_budget',net=0.)
        end=bisect_right(self.available,deadline)
        price=self.quotes[i:end,2 if side>0 else 3]
        fresh=self.available[i:end]-self.source[i:end]<=1_000_000
        hits=np.flatnonzero(fresh&((side*(price-stop)<=0)|(side*(price-target)>=0)))
        trigger=i+int(hits[0]) if len(hits) else None
        exit_decision=max(int(self.available[trigger]),entry_time) if trigger is not None else deadline
        reason=('stop' if side*(self.quotes[trigger,2 if side>0 else 3]-stop)<=0 else 'target') if trigger is not None else 'deadline'
        exit_request=exit_decision+1_000_000;j=self.fill(exit_request)
        if j is None:return dict(status='censored',reason='missing_exit_quote')
        raw_exit=self.quotes[j,2 if side>0 else 3];exit_price=raw_exit-side*slip
        gross=(exit_price-entry)*side*10;taxes=fee(entry)+fee(exit_price)-40;net=gross-40-taxes
        trajectory=np.array([0.,net])
        if marks:
            fresh_marks=self.available[i:j+1]-self.source[i:j+1]<=1_000_000
            path=self.quotes[i:j+1,2 if side>0 else 3][fresh_marks]-side*slip
            trajectory=np.r_[0.,(path-entry)*side*10-np.array([fee(entry)+fee(p) for p in path]),net]
        drawdown=float(np.max(np.maximum.accumulate(trajectory)-trajectory))
        mid_entry=(q[2]+q[3])/2;mid_exit=(self.quotes[j,2]+self.quotes[j,3])/2
        spread=((q[3]-q[2])+(self.quotes[j,3]-self.quotes[j,2]))*5
        mid_gross=(mid_exit-mid_entry)*side*10;slippage=2*slip*10
        if abs(net-(mid_gross-spread-slippage-40-taxes))>1e-7:
            raise ValueError('五檔模擬成本對帳不符')
        return dict(status='filled',time=a.time,day=a.day,plan=a.plan,side='Buy' if side>0 else 'Sell',
            entryTime=float(entry_time/1e6),exitTime=float(max(int(self.available[j]),exit_request)/1e6),entry=float(entry),exit=float(exit_price),
            reason=reason,risk=float(risk),gross=float(gross),net=float(net),fees=40.,taxes=float(taxes),
            midGross=float(mid_gross),spreadCost=float(spread),slippageCost=float(slippage),
            minimumNet=float(np.min(trajectory)),maximumNet=float(np.max(trajectory)),internalDrawdown=drawdown)


def load_tape(database,group,cache):
    identity=digest(dict(group=group,code=hashlib.sha256(Path(__file__).read_bytes()).hexdigest()))
    path=Path(cache)/f'{identity}.npz';path.parent.mkdir(parents=True,exist_ok=True)
    if path.exists():
        with np.load(path,allow_pickle=False) as saved:
            return QuoteTape(saved['quotes'],saved['seconds'].tolist(),group['month']),json.loads(str(saved['metadata']))
    seconds={};quotes=[];minutes={};minute_available={};ambiguous=set();counts=defaultdict(int);h=hashlib.sha256()
    with sqlite3.connect(f'file:{database}?mode=ro',uri=True) as db:
        cursor=db.execute('''SELECT received_us,event_us,channel,event_type,is_trial,duplicate,valid,sha256,raw_json
            FROM capture_frames WHERE session=? AND opening_day=? AND symbol=? AND window_start_us=? AND window_end_us=? AND id<=? ORDER BY id''',
            (group['session'],group['day'],group['symbol'],group['startUs'],group['endUs'],group['maximumFrameId']))
        for received,event_us,channel,event,trial,duplicate,valid,sha,raw in cursor:
            h.update(sha.encode());counts['frames']+=1
            if trial or duplicate or (channel=='trades' and event!='data'):continue
            if not valid:
                if event_us and group['researchStartUs']<=event_us<=group['researchEndUs']:counts['invalidResearchFrames']+=1
                continue
            data=json.loads(raw)['data']
            if hashlib.sha256(json.dumps(data,sort_keys=True,separators=(',',':'),ensure_ascii=False).encode()).hexdigest()!=sha:
                raise ValueError('原生行情內容與已保存hash不同')
            at,issues=validate_frame(data,channel,group,received)
            if issues or at!=event_us:raise ValueError('原生行情再次驗證失敗')
            available=max(received,event_us)
            if channel=='books':
                bid,ask=data['bids'],data['asks']
                quotes.append((available,event_us,bid[0]['price'],ask[0]['price'],bid[0]['size'],ask[0]['size'],
                    sum(x['size'] for x in bid),sum(x['size'] for x in ask)))
                continue
            trades=data['trades'];bucket=available//1_000_000;minute=(event_us//60_000_000+1)*60
            minute_available[minute]=max(minute_available.get(minute,0),available)
            if len(trades)>1 and event_us%60_000_000<1_000_000:
                ambiguous.update((minute-60,minute))
            s=seconds.setdefault(bucket,[10**9,0,0,0,0]);m=minutes.setdefault(minute,[10**9,0,0])
            for t in trades:
                price,size=t['price'],t['size'];s[0]=min(s[0],price);s[1]=max(s[1],price);s[2]+=size;s[3]+=price*size;s[4]+=1
                m[0]=min(m[0],price);m[1]=max(m[1],price);m[2]+=size
    rows=[(t,v[3]/v[2],v[0],v[1],v[2],v[4]) for t,v in sorted(seconds.items())]
    quotes.sort(key=lambda r:r[0])
    metadata=dict(counts=dict(counts),orderedPacketHash=h.hexdigest(),minutes=minutes,minuteAvailableUs=minute_available,ambiguousMinutes=sorted(ambiguous),
        priceSecondsUse='max(exchange_us,received_us); no future arrivals in past features',quantityUnit='native single-side contracts')
    temporary=path.with_suffix('.part.npz')
    np.savez_compressed(temporary,quotes=np.asarray(quotes,dtype=np.float64).reshape((-1,8)),seconds=np.asarray(rows,dtype=np.float64),metadata=json.dumps(metadata))
    temporary.replace(path)
    return QuoteTape(quotes,rows,group['month']),metadata
