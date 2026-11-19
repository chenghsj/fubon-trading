"""Expired monthly plans must not be diagnosed as a market-session mismatch."""
import pytest

from fubon_bridge.auto_gateway import PaperGateway
from fubon_bridge.auto_trading import AutoConfig
from test_market_session_qa import market, ticker_row, instant
from test_paper import AUTO


@pytest.mark.parametrize('day,session', [('2026-11-19', 'afterhours'), ('2026-11-19', 'regular'), ('2026-11-18', 'afterhours')])
def test_expiry_is_reported_before_session_mismatch_and_subscriptions(market, day, session):
    market.clock[0] = instant('2026-11-19T20:00:00')
    expired = ticker_row('TMFK6', '2026-11-18T08:45:00', '2026-11-18T13:30:00')
    expired['settlementDate'] = '2026-11-18'
    market.rows['TMFK6'] = {'regular': expired}
    cfg = AutoConfig(account=AUTO, contract_code='TMFK6', trade_date=day, strategy_session=session)
    with pytest.raises(ValueError, match='TMFK6.*2026-11-18.*到期'):
        PaperGateway(market.broker).prepare(cfg.model_dump(mode='json'))
    market.socket.subscribe.assert_not_called()
    assert market.broker.paper.overview()['orders'] == []


def test_valid_december_night_contract_is_not_blocked_by_expired_november(market):
    market.clock[0] = instant('2026-11-17T21:00:00')
    cfg = AutoConfig(account=AUTO, contract_code='TMFL6', trade_date='2026-11-17', strategy_session='afterhours')
    contract = PaperGateway(market.broker).prepare(cfg.model_dump(mode='json'))
    assert contract['code'] == 'TMFL6'
    assert contract['market_session'] == 'afterhours'
    assert market.broker.paper.overview()['orders'] == []
