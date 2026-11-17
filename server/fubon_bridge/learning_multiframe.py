"""Session-anchored, completed-candle features shared by training and inference."""
from typing import Literal

FeatureSet = Literal['base', 'mtf_1_3_15']
TIMEFRAMES = (1, 3, 15)
MTF_FEATURES = [f'm{minutes}{name}' for minutes in TIMEFRAMES
    for name in ('Return', 'RangeRatio', 'BodyRatio', 'CloseLocation', 'VolumeRatio', 'Trend')]


def decision_minutes(feature_set='base'):
    if feature_set not in {'base', 'mtf_1_3_15'}:
        raise ValueError('未知的模型特徵版本，請重新訓練')
    return 1 if feature_set == 'mtf_1_3_15' else 5


def closed_candles(bars, start, decision, minutes):
    """Bars are stamped at minute close. Never include a partial larger candle."""
    if minutes not in TIMEFRAMES:
        raise ValueError('多週期僅支援1／3／15分鐘')
    end = start + (decision-start)//(minutes*60)*(minutes*60)
    selected = [b for b in bars if start < b['time'] <= end]
    index = {b['time']: b for b in selected}
    if len(index) != len(selected) or set(index) != set(range(start+60, end+1, 60)):
        raise ValueError('多週期聚合所需分鐘資料缺漏或重複')
    result = []
    for left in range(start, end, minutes*60):
        rows = [index[left+i*60] for i in range(1, minutes+1)]
        result.append(dict(time=left+minutes*60, open=rows[0]['open'],
            high=max(b['high'] for b in rows), low=min(b['low'] for b in rows),
            close=rows[-1]['close'], volume=sum(b['volume'] for b in rows)))
    return result


def multiframe_features(bars, start, decision, side):
    values = []
    for minutes in TIMEFRAMES:
        rows = closed_candles(bars, start, decision, minutes)
        if not rows:
            raise ValueError('多週期尚無完整已收盤K棒')
        b = rows[-1]
        width = b['high']-b['low']
        average_volume = sum(r['volume'] for r in rows[-5:])/len(rows[-5:])
        # During session warmup, trend/volume use up to 3/5 completed candles.
        # The short window never borrows another session or fills partial bars.
        values.extend([side*(b['close']/b['open']-1), width/b['close'],
            side*(b['close']-b['open'])/width if width else 0.,
            side*(2*(b['close']-b['low'])/width-1) if width else 0.,
            b['volume']/max(1, average_volume),
            side*(b['close']/rows[-min(3,len(rows))]['open']-1)])
    return values
