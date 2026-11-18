from copy import deepcopy
from types import SimpleNamespace

import numpy as np
import pytest

from fubon_bridge.candle_patterns import (FEATURES, PatternRow, boundary, oriented,
    samples, shape, stock_days, weights)
from fubon_bridge.pattern_transfer import partition, pretrain, select


def minutes(count=100,day='2024-08-01'):
    start=boundary(day)+9*3600
    bars=[dict(time=start+(i+1)*60,open=100+i,high=104+i,low=98+i,close=102+i)
        for i in range(count)]
    return start,bars


def test_shapes_have_hand_calculated_body_wicks_and_closed_frames():
    start,bars=minutes()
    values,atr=shape(bars,59,start)
    assert len(values)==len(FEATURES)==63
    assert atr==6
    # Most recent minute: O159 H163 L157 C161, body and each wick = 2/6.
    assert values[10:15]==pytest.approx([1/3,1/3,1/3,1/3,1.])
    # Latest completed 15m is minutes46..60: O145 H163 L143 C161.
    assert values[52:57]==pytest.approx([.8,.1,.1,.8,20/(6*np.sqrt(15))])
    at74=shape(bars,73,start)[0]
    assert at74[52:56]==pytest.approx(values[52:56])


def test_patterns_are_scale_free_and_sell_reflection_preserves_geometry():
    start,bars=minutes()
    original=shape(bars,73,start)[0]
    scaled=[{k:(v*8.5 if k!='time' else v) for k,v in bar.items()} for bar in bars]
    reflected=[dict(time=b['time'],open=1000-b['open'],high=1000-b['low'],
        low=1000-b['high'],close=1000-b['close']) for b in bars]
    assert shape(scaled,73,start)[0]==pytest.approx(original)
    assert oriented(shape(reflected,73,start)[0],-1)==pytest.approx(original)


@pytest.mark.parametrize('current_range,expected',[(2.,10.),(0.,0.)])
def test_compression_distinguishes_breakout_from_three_flat_candles(current_range,expected):
    start,bars=minutes()
    for i in (57,58,59):
        bars[i]=dict(time=bars[i]['time'],open=160.,high=160.,low=160.,close=160.)
    bars[59]['high']+=current_range;bars[59]['close']+=current_range/2
    values,_=shape(bars,59,start)
    assert values[20]==expected


def test_future_candles_cannot_change_current_pattern():
    start,bars=minutes();changed=deepcopy(bars)
    for bar in changed[74:]:
        for key in ('open','high','low','close'):
            bar[key]*=100
    assert shape(changed,73,start)==shape(bars,73,start)


def test_missing_minutes_need_60_consecutive_minutes_again():
    start,bars=minutes(160);gapped=bars[:69]+bars[70:]
    assert shape(gapped,100,start) is None
    assert shape(gapped,129,start) is not None
    rows,_=samples('2330',[('2024-08-01',start,gapped)],boundary('2024-08-02'))
    assert not any(start+55*60<=r.time<=start+129*60 for r in rows)


def test_stocks_exclude_closing_auction_and_never_cross_day_for_labels():
    start,bars=minutes(265)
    auction=dict(bars[-1],time=start+271*60,close=10000.,high=10000.)
    next_start,next_day=minutes(20,'2024-08-02')
    grouped=stock_days(bars+[auction]+next_day)
    assert max(b['time'] for b in grouped[0][2])==start+265*60
    rows,_=samples('2330',grouped,boundary('2024-08-03'))
    assert rows and all(r.label_end<=start+265*60 for r in rows)
    assert not any(r.day=='2024-08-02' for r in rows)
    assert next_start>rows[-1].label_end


def test_auxiliary_target_is_gross_next_open_move_in_atr_units():
    start,bars=minutes();rows,_=samples('2330',[('2024-08-01',start,bars)],boundary('2024-08-02'))
    first=rows[0]
    # Signal minute60, entry minute61 open160, minute75 close176 -> 16/6.
    assert first.time==start+60*60
    assert first.label_end==start+75*60
    assert first.target==pytest.approx(16/6)


def test_pooled_weights_balance_groups_assets_and_days_despite_row_counts():
    rows=[SimpleNamespace(asset=asset,day=day) for asset,day,count in (
        ('TMF','2024-08-01',100),('TMF','2024-08-02',10),('2330','2024-08-01',1),
        ('2454','2024-08-01',30),('2317','2024-08-01',10),('2881','2024-08-01',20)) for _ in range(count)]
    w=weights(rows,True);total=sum(w)
    by_asset={a:sum(v for r,v in zip(rows,w,strict=True) if r.asset==a)/total for a in {r.asset for r in rows}}
    assert by_asset==pytest.approx({'TMF':.5,'2330':.125,'2454':.125,'2317':.125,'2881':.125})
    assert sum(v for r,v in zip(rows,w,strict=True) if r.asset=='TMF' and r.day=='2024-08-01')==pytest.approx(total/4)
    with pytest.raises(ValueError,match='缺少'):
        weights(rows[110:],True)


def test_all_assets_use_strict_global_label_cutoff(monkeypatch):
    import fubon_bridge.pattern_transfer as module
    cutoff=boundary('2024-09-01');captured=[]
    def fake_tree(x,y,w,names,parameters):
        captured.extend(y.tolist());return dict(kind='fake')
    monkeypatch.setattr(module,'tree',fake_tree)
    rows=[PatternRow(asset,f'2024-08-{day:02}',cutoff-120,cutoff-1,[0.]*63,1.)
        for asset in ('TMF','2330','2454','2317','2881') for day in range(1,26) for _ in range(10)]
    # Even TMF night and stock labels ending exactly at midnight are excluded.
    rows += [PatternRow(a,'2024-08-31',cutoff-60,end,[0.]*63,999.)
        for a in ('TMF','2330','2454','2317','2881') for end in (cutoff,cutoff+60)]
    model,meta=pretrain(rows,'pooled-pretrain',cutoff)
    assert model and meta['samples']==1250 and meta['maximumLabelEnd']==cutoff-1
    assert captured==[1.]*1250
    assert meta['weightMass']==pytest.approx({'TMF':.5,'2330':.125,'2454':.125,'2317':.125,'2881':.125})


def test_sparse_pretraining_and_incomplete_development_fail_closed():
    model,meta=pretrain([],'stocks-pretrain',boundary('2024-09-01'))
    assert model is None and 'reason' in meta
    assert select({})['selected'] is None


def test_partition_reserves_disjoint_meta_rows_and_calibration_dates():
    dates=[str(i) for i in range(100)]
    pre,meta,cal=partition(dates)
    assert (pre,meta,cal)==(dates[:40],dates[40:80],dates[80:])
    assert not set(pre)&set(meta) and not set(meta)&set(cal)
