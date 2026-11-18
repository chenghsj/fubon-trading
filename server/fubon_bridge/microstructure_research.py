"""Causal, unordered second aggregates for price research. No executable P&L."""
from bisect import bisect_left, bisect_right
import math

LAGS=(1,3,5,15,30)
FEATURES=[*(f'vwapMove{s}' for s in LAGS),*(f'range{s}' for s in (5,15,30)),
    'path30','upFraction30','turnFraction30','quantityIntensity5','tradeIntensity5',
    'vwapPeakGiveback30','vwapTroughBounce30','observedFraction30','priceAge']


class SecondTape:
    """Rows: timestamp, VWAP, low, high, raw B+S quantity, print count."""
    def __init__(self,rows):
        rows=list(rows)
        for r in rows:
            if (len(r)!=6 or not all(isinstance(v,(int,float)) and not isinstance(v,bool) and math.isfinite(v) for v in r)
                or r[0]!=int(r[0]) or r[2]<=0 or not r[2]<=r[1]<=r[3] or r[4]<=0 or r[5]<=0):
                raise ValueError('秒資料無效')
        self.rows=sorted(rows);self.times=[r[0] for r in self.rows]
        if len(set(self.times))!=len(self.times):
            raise ValueError('同一實際契約秒出現在多個來源；拒絕重複合併')

    def price(self,second):
        i=bisect_right(self.times,second)-1
        if i<0 or second-self.times[i]>2:
            return None
        return self.rows[i]

    def features(self,at,atr):
        if not math.isfinite(atr) or atr<=0 or not math.isfinite(at) or at!=int(at):
            raise ValueError('決策秒或ATR無效')
        latest=self.price(at-1);lags=[self.price(at-1-s) for s in LAGS]
        end=bisect_left(self.times,at);start=bisect_left(self.times,at-30)
        past=self.rows[start:end]
        if latest is None or any(r is None for r in lags) or len(past)<10:
            return None
        now=latest[1];x=[(now-r[1])/atr for r in lags]
        for seconds in (5,15,30):
            window=[r for r in past if r[0]>=at-seconds]
            if not window:
                return None
            x.append((max(r[3] for r in window)-min(r[2] for r in window))/atr)
        changes=[b[1]-a[1] for a,b in zip(past,past[1:])]
        nonzero=[v for v in changes if v]
        recent=[r for r in past if r[0]>=at-5];earlier=[r for r in past if r[0]<at-5]
        x.extend((sum(abs(v) for v in changes)/atr,
            sum(v>0 for v in nonzero)/len(nonzero) if nonzero else .5,
            sum(a*b<0 for a,b in zip(nonzero,nonzero[1:]))/max(1,len(nonzero)-1)))
        for k in (4,5):
            old=sum(r[k] for r in earlier)/25
            x.append((sum(r[k] for r in recent)/5)/old if old else 0.)
        x.extend(((max(r[1] for r in past)-now)/atr,(now-min(r[1] for r in past))/atr,
            len(past)/30,at-1-latest[0]))
        if len(x)!=len(FEATURES) or not all(math.isfinite(v) for v in x):
            raise ValueError('秒級特徵無效')
        return x

    def label(self,at,atr):
        """Future observed VWAP path, never a fill, realized profit, or emotion."""
        current=self.price(at-1)
        a=bisect_left(self.times,at);b=bisect_left(self.times,at+30);future=self.rows[a:b]
        if current is None or not future or at+29-future[-1][0]>2:
            return None
        move=future[-1][1]-current[1];values=[current[1],*(r[1] for r in future)]
        up=max(values)-current[1];down=current[1]-min(values)
        return dict(target=max(-3.,min(3.,move/atr)),points=move,
            longFavorableVwapPoints=up,shortFavorableVwapPoints=down,
            longVwapGivebackPoints=up-max(move,0.),shortVwapGivebackPoints=down-max(-move,0.),
            labelEnd=at+30)
