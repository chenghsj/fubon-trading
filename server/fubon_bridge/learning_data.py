"""Bounded, resumable historical market reads. No order or accounting APIs."""
from collections import defaultdict
from datetime import date, datetime, timedelta
import hashlib
from pathlib import Path
import re
from pydantic import BaseModel, Field, model_validator
from .mapping import TAIPEI, now
from .research import normalize

STOCKS = ('2330', '2454', '2317', '2881')


class CollectionRequest(BaseModel):
    start: date
    end: date
    refresh: bool = False

    @model_validator(mode='after')
    def dates(self):
        if not 0 <= (self.end-self.start).days <= 365 or self.end >= now().date():
            raise ValueError('請選擇已完成日期，範圍最多366天')
        if self.start < date(2024,7,29):
            raise ValueError('微台訓練資料須自2024-07-29上市日起')
        return self


def futures_rows(rows, start, end):
    grouped = defaultdict(list)
    for row in rows:
        month = str(row.get('contractMonth', ''))
        if not re.fullmatch(r'20\d{2}(0[1-9]|1[0-2])', month):
            raise ValueError('連續合約缺少逐根實際契約月份，無法安全保存')
        grouped[month].append(row)
    result = sorted([dict(b, month=month) for month, values in grouped.items() for b in normalize(values,start,end)], key=lambda b:b['time'])
    if len({b['time'] for b in result}) != len(result):
        raise ValueError('連續合約同時刻出現多個月份，拒絕合併')
    if any(not float(b[k]).is_integer() for b in result for k in ('open','high','low','close')):
        raise ValueError('微台期貨價格必須符合1點跳動單位')
    return result


def quality(data):
    days = defaultdict(list)
    for b in data['futures']:
        minute = (b['time']+28800)%86400//60
        if 541 <= minute <= 800:
            days[datetime.fromtimestamp(b['time'],TAIPEI).date().isoformat()].append(b)
    complete, excluded = [], []
    for day, bars in sorted(days.items()):
        contiguous = len(bars)==260 and all((b['time']+28800)%86400//60==541+i for i,b in enumerate(bars))
        if contiguous and len({b['month'] for b in bars})==1:
            complete.append(day)
        else:
            excluded.append(day)
    first, last = date.fromisoformat(data['start']), date.fromisoformat(data['end'])
    absent = [d.isoformat() for i in range((last-first).days+1) if (d:=first+timedelta(days=i)).weekday()<5 and d.isoformat() not in days]
    contracts = sorted({b['month'] for b in data['futures']})
    return dict(start=data['start'],end=data['end'],source=data['source'],product='TMF',futuresBars=len(data['futures']),
        stockBars={code:len(data['stocks'][code]) for code in STOCKS},completeDays=len(complete),completeDates=complete,
        excludedDays=excluded,absentWeekdays=absent,contracts=contracts,calendarVerified=False)


def collect(broker, store, request, progress=lambda *_:None):
    source = 'synthetic' if broker.config.mode=='demo' else 'fubon-'+broker.config.mode
    pieces = []
    start = request.start
    chunks = []
    while start <= request.end:
        end = min(request.end,start+timedelta(days=30))
        chunks.append((start,end)); start=end+timedelta(days=1)
    for i,(start,end) in enumerate(chunks):
        normalizer_hash=hashlib.sha256(Path(__file__).read_bytes()+Path(__file__).with_name('research.py').read_bytes()).hexdigest()
        spec = dict(schema='learning-chunk-v1',normalizerHash=normalizer_hash,source=source,start=start.isoformat(),end=end.isoformat(),product='TMF',stocks=list(STOCKS))
        piece = None if request.refresh else store.chunk(spec)
        if piece is None:
            raw = broker.learning_candles('FUT','TMF',spec['start'],spec['end'])
            future = futures_rows(raw,start,end)
            stocks = {}
            for j,code in enumerate(STOCKS):
                stocks[code] = normalize(broker.learning_candles('STK',code,spec['start'],spec['end']),start,end)
                progress(f'下載第 {i+1}/{len(chunks)} 批 · {code}', (i*5+j+2)/(len(chunks)*5))
            piece = dict(futures=future,stocks=stocks)
            store.save_chunk(spec,piece)
        pieces.append(piece)
        progress(f'已保存第 {i+1}/{len(chunks)} 批', (i+1)/len(chunks))
    data = dict(schema='fubon-learning-v1',source=source,marketDataVerified=False,start=request.start.isoformat(),end=request.end.isoformat(),
        product='TMF',contractQuery='1!',futures=[b for p in pieces for b in p['futures']],
        stocks={code:[b for p in pieces for b in p['stocks'][code]] for code in STOCKS})
    if not data['futures']:
        raise ValueError('指定期間沒有微台歷史資料，未建立訓練版本')
    return store.save_dataset(data,quality(data))
