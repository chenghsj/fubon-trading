"""Auditable public trade prints. Missing quotes never become execution prices."""
from collections import Counter
from datetime import datetime
from decimal import Decimal, InvalidOperation
import csv
import hashlib
import io
import math
import re
import zipfile

from .mapping import TAIPEI

HEADER=['成交日期','商品代號','到期月份(週別)','成交時間','成交價格','成交數量(B+S)','近月價格','遠月價格','開盤集合競價']


def trade_time(day,clock):
    if not re.fullmatch(r'\d{8}',day) or not re.fullmatch(r'\d{6}',clock):
        raise ValueError('逐筆日期／秒級時間格式錯誤')
    return int(datetime.strptime(day+clock,'%Y%m%d%H%M%S').replace(tzinfo=TAIPEI).timestamp())


def positive_integer(value,name):
    try:
        x=Decimal(value)
    except InvalidOperation:
        raise ValueError(f'{name}不是有效數字') from None
    if not x.is_finite() or x<=0 or x!=x.to_integral_value():
        raise ValueError(f'{name}必須是正整數')
    return int(x)


def read_archive(raw,member,asof):
    if isinstance(asof,bool) or not isinstance(asof,(int,float)) or not math.isfinite(asof):
        raise ValueError('資料截止時間無效')
    archive=zipfile.ZipFile(io.BytesIO(raw));members=archive.infolist()
    if len(members)!=1 or members[0].filename!=member or members[0].file_size>512*1024*1024:
        raise ValueError('逐筆ZIP成員或大小不符合預期')
    payload=archive.read(member)
    try:
        text=io.TextIOWrapper(io.BytesIO(payload),encoding='cp950',newline='')
        header=next(csv.reader([next(text)]))
    except (UnicodeDecodeError,StopIteration):
        raise ValueError('成交CSV無有效表頭') from None
    if [v.strip().lstrip('\ufeff') for v in header]!=HEADER:
        raise ValueError('成交CSV schema已改變，拒絕猜測欄位')
    quality=Counter();seconds={};prints=[]
    for ordinal,line in enumerate(text,1):
        if not line.strip():
            quality['blankRows']+=1;continue
        quality['allRows']+=1;prefix=line.split(',',2)
        if len(prefix)<3 or prefix[1].strip()!='TMF':
            continue
        quality['tmfRows']+=1;row=next(csv.reader([line]));row=[v.strip() for v in row]
        if len(row)!=len(HEADER):
            raise ValueError('TMF成交列欄位數錯誤')
        day,_,month,clock,price,quantity,near,far,auction=row
        if not re.fullmatch(r'20\d{2}(0[1-9]|1[0-2])',month):
            quality['excludedNonMonthlyRows']+=1;continue
        if near!='-' or far!='-':
            raise ValueError('單式月份卻帶跨月成交價格')
        at=trade_time(day,clock)
        if at>=asof:
            quality['excludedNotYetClosedRows']+=1;continue
        price=positive_integer(price,'微台價格');quantity=positive_integer(quantity,'B+S數量')
        if auction not in ('','*'):
            raise ValueError('未知開盤集合競價旗標')
        quality['prints']+=1;quality['quantityBothSides']+=quantity
        quality['oddQuantityRows']+=quantity%2;quality['auctionPrints']+=int(auction=='*')
        prints.append((at,month,price,quantity,ordinal,int(auction=='*')))
        key=(at,month)
        if key not in seconds:
            seconds[key]=dict(time=at,month=month,low=price,high=price,trades=0,quantityBothSides=0,notionalBothSides=0,auctionQuantityBothSides=0)
        s=seconds[key];s['low']=min(s['low'],price);s['high']=max(s['high'],price)
        s['trades']+=1;s['quantityBothSides']+=quantity;s['notionalBothSides']+=price*quantity
        s['auctionQuantityBothSides']+=quantity if auction=='*' else 0
    ordered=[]
    for key in sorted(seconds):
        s=seconds[key];s['vwap']=s.pop('notionalBothSides')/s['quantityBothSides'];ordered.append(s)
    quality['tradedContractSeconds']=len(ordered)
    quality['multiplePrintSeconds']=sum(s['trades']>1 for s in ordered)
    quality['multiplePriceSeconds']=sum(s['high']>s['low'] for s in ordered)
    return prints,ordered,dict(quality,archiveSha256=hashlib.sha256(raw).hexdigest(),csvSha256=hashlib.sha256(payload).hexdigest(),
        physicalTimestamp=True,timePrecisionSeconds=1,sameSecondOrderKnown=False,quoteRows=0,
        quantityUnit='raw B+S; not interpreted as single-side contracts',
        missingQuotes=True,executionAllowed=False,adoptionAllowed=False)


def executable_quote(quote,decision_time,month,max_age=1.):
    """Qualify a recorded TMF quote for simulation; depth does not guarantee a fill."""
    if (not re.fullmatch(r'20\d{2}(0[1-9]|1[0-2])',str(month))
        or any(isinstance(v,bool) or not isinstance(v,(int,float)) or not math.isfinite(v)
               for v in (decision_time,max_age)) or max_age<=0):
        raise ValueError('決策時間、契約或報價期限無效')
    if not isinstance(quote,dict):
        raise ValueError('缺歷史買賣報價，不能驗證成交／淨利')
    if quote.get('product')!='TMF' or quote.get('month')!=month:
        raise ValueError('買賣報價商品或實際契約不符')
    required=('time','bid','ask','bidSize','askSize')
    if any(isinstance(quote.get(k),bool) or not isinstance(quote.get(k),(int,float)) or not math.isfinite(quote[k]) for k in required):
        raise ValueError('買賣報價欄位缺漏或無效')
    if (quote['bid']<=0 or quote['ask']<=0 or quote['bid']>quote['ask']
        or min(quote['bidSize'],quote['askSize'])<1
        or any(float(quote[k])!=int(quote[k]) for k in ('bid','ask','bidSize','askSize'))):
        raise ValueError('買賣報價／深度不可成交')
    age=decision_time-quote['time']
    if age<0 or age>max_age:
        raise ValueError('報價來自未來或過期')
    return dict(quote,age=age)
