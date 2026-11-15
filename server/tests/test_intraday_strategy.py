import json
from pathlib import Path
import pytest
from fubon_bridge.intraday_strategy import cash_atr, entry_plan

fixture=json.loads((Path(__file__).parents[2]/'src/lib/fixtures/intraday-policy.json').read_text())

def test_wilder_seed_recursion_warmup_gaps_session_reset_and_no_lookahead():
    bars,start=fixture['bars'],fixture['start']
    assert cash_atr(bars,start+13*60) is None
    assert cash_atr(bars,start+14*60)==2
    assert cash_atr(bars,start+15*60)==pytest.approx(37/14)
    assert cash_atr(bars,start+16*60)==pytest.approx(509/196)
    assert cash_atr(bars[:3]+bars[4:],start+16*60) is None
    assert cash_atr(bars,start+86400+16*60) is None
    changed=[dict(b,high=10000) if i==15 else b for i,b in enumerate(bars)]
    assert cash_atr(changed,start+15*60)==pytest.approx(37/14)

@pytest.mark.parametrize('c',fixture['cases'],ids=lambda c:c['name'])
def test_shared_entry_policy_fixtures(c):
    cfg=dict(stop_points=30,target_points=60,slippage_points=2,fee_per_side=12,tax_rate=.00002,loss_limit=1000,strategy_version='orb_atr_v2')
    signal=dict(time=fixture['start']+20*60,side=c['action'],close=c['close'],high=c['high'],low=c['low'],atr=c['atr'])
    plan,reason=entry_plan(cfg,signal,c['action'],c['limit'],c['price'],c['realized'])
    if 'blocked' in c:
        assert plan is None
        assert {'breakout':'開盤區間','drift':'偏離','warmup':'ATR14','budget':'預算'}[c['blocked']] in reason
    else:
        assert reason is None and plan['stopPoints']==c['stop'] and plan['targetPoints']==c['stop']*2
        assert plan['estimatedRisk']==pytest.approx(c['risk'])

def test_unknown_realized_cost_cannot_authorize_more_risk():
    cfg=dict(stop_points=30,target_points=60,slippage_points=2,fee_per_side=12,tax_rate=.00002,loss_limit=1000)
    signal=dict(time=1,side='Buy',close=25020,high=25010,low=24990)
    assert entry_plan(cfg,signal,'Buy',25023,25020,None)[0] is None


def test_index_futures_tax_half_up_per_contract():
    from fubon_bridge.intraday_strategy import futures_tax
    assert futures_tax(42499,10,.00002)==8
    assert futures_tax(42500,10,.00002)==9
    assert futures_tax(100,10,0)==0
