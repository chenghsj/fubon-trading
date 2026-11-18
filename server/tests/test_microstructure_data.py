from datetime import datetime
import io
import math
import zipfile

import pytest

from fubon_bridge.mapping import TAIPEI
from fubon_bridge.microstructure_data import HEADER, executable_quote, read_archive, trade_time
from fubon_bridge.microstructure_research import FEATURES, SecondTape


def archive(*rows):
    stream=io.BytesIO()
    with zipfile.ZipFile(stream,'w') as z:
        z.writestr('Daily.csv',('\n'.join([','.join(HEADER),*rows])+'\n').encode('cp950'))
    return stream.getvalue()


def test_physical_friday_and_saturday_night_auction_duplicates_and_raw_quantity():
    raw=archive('20261113,TMF,202611,150000,40000,4,-,-,*',
        '20261114,TMF,202611,000001,40001,2,-,-,',
        '20261114,TMF,202611,000001,40001,2,-,-,',
        '20261114,TMF,202611,000001,40003,2,-,-,',
        '20261114,TMF,202611/202612,000001,1,2,40000,40001,')
    prints,seconds,q=read_archive(raw,'Daily.csv',trade_time('20261117','000000'))
    assert len(prints)==4 and prints[1][:4]==prints[2][:4] and prints[1][4]!=prints[2][4]
    assert datetime.fromtimestamp(prints[1][0],TAIPEI).isoformat().startswith('2026-11-14T00:00:01')
    assert seconds[-1]['vwap']==pytest.approx((40001*4+40003*2)/6)
    assert seconds[-1]['quantityBothSides']==6 and seconds[-1]['trades']==3
    assert q['auctionPrints']==1 and q['excludedNonMonthlyRows']==1
    assert q['multiplePriceSeconds']==1 and q['quoteRows']==0 and not q['sameSecondOrderKnown']
    assert all(k not in seconds[0] for k in ('bid','ask','open','close'))


@pytest.mark.parametrize('change',[{'price':'nan'},{'price':'40000.5'},{'quantity':'0'},
    {'clock':'240001'},{'auction':'isTrial'},{'near':'40000'}])
def test_invalid_prints_fail_closed(change):
    row=dict(day='20261116',product='TMF',month='202611',clock='150000',price='40000',quantity='2',near='-',far='-',auction='')|change
    with pytest.raises(ValueError):
        read_archive(archive(','.join(row.values())),'Daily.csv',trade_time('20261117','000000'))


def test_future_second_excluded_and_schema_change_rejected():
    raw=archive('20261116,TMF,202611,150000,40000,2,-,-,')
    p,s,q=read_archive(raw,'Daily.csv',trade_time('20261116','150000'))
    assert p==s==[] and q['excludedNotYetClosedRows']==1
    with pytest.raises(ValueError):
        read_archive(raw,'other.csv',math.inf)
    stream=io.BytesIO()
    with zipfile.ZipFile(stream,'w') as z:
        z.writestr('Daily.csv','日期,價格\n'.encode('cp950'))
    with pytest.raises(ValueError):
        read_archive(stream.getvalue(),'Daily.csv',0)


def quote():
    return dict(product='TMF',month='202611',time=100.,bid=40000,ask=40001,bidSize=1,askSize=2)


@pytest.mark.parametrize('patch',[{'time':102},{'time':98},{'bid':0},{'ask':39999},
    {'ask':40000.5},{'bidSize':0},{'askSize':1.5},{'bid':math.nan},
    {'product':'MXF'},{'month':'202612'},{'time':True}])
def test_missing_stale_future_crossed_wrong_contract_quotes_never_qualify(patch):
    with pytest.raises(ValueError):
        executable_quote(quote()|patch,101,'202611')


@pytest.mark.parametrize('at,age',[(math.nan,1),(101,math.nan),(101,0),(math.inf,1)])
def test_invalid_decision_or_age_cannot_bypass_quote_guard(at,age):
    with pytest.raises(ValueError):
        executable_quote(quote(),at,'202611',age)


def test_depth_is_only_simulation_qualification_not_fabricated_execution():
    assert executable_quote(quote(),101,'202611')['age']==1
    with pytest.raises(ValueError,match='缺歷史'):
        executable_quote(None,101,'202611')


def tape():
    return [(t,40000+t/10,40000,40030,10,5) for t in range(200)]


def test_features_ignore_decision_second_and_future_path():
    rows=tape();a=SecondTape(rows);x=a.features(100,10)
    altered=[r if r[0]<100 else (r[0],50000,50000,50001,100,50) for r in rows]
    assert SecondTape(altered).features(100,10)==x and len(x)==len(FEATURES)==17
    assert a.label(100,10)['points']==pytest.approx(3.)
    assert SecondTape(altered).label(100,10)['points']!=a.label(100,10)['points']
    assert x[0]==pytest.approx(.01)


def test_missing_seconds_have_staleness_no_interpolated_prints_or_labels():
    assert SecondTape(tape()[:97]).features(100,10) is None
    assert SecondTape(tape()[:98]).features(100,10)[-1]==2
    assert SecondTape(tape()[:127]).label(100,10) is None
    assert SecondTape(tape()[:128]).label(100,10)['labelEnd']==130
    with pytest.raises(ValueError,match='同一'):
        SecondTape([*tape(),tape()[0]])
