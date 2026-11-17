"""Isolated portfolio/replay QA: synthetic fills and market pages, never SDK login."""
from copy import deepcopy
from datetime import date, datetime, timedelta
from types import SimpleNamespace as NS
from unittest.mock import Mock

import pytest
from fastapi.testclient import TestClient

from fubon_bridge.app import create_app
from fubon_bridge.broker import Broker
from fubon_bridge.config import Config
from fubon_bridge.feature_errors import FeatureUnavailable
from fubon_bridge.mapping import TAIPEI
from fubon_bridge.passkeys import PasskeyStore
from fubon_bridge.portfolio_data import PortfolioData
from fubon_bridge.research import ResearchStore


DAY = date(2026, 11, 17)
AT = datetime(2026, 11, 17, 14, 0, tzinfo=TAIPEI)
ACCOUNT = dict(account_type='F', broker_id='LOCAL', account_id='PAPER-F')
OTHER = dict(account_type='F', broker_id='LOCAL', account_id='PAPER-AUTO-F')
STOCK = dict(account_type='S', broker_id='LOCAL', account_id='PAPER-S')
CONTRACT = dict(code='TMFK6', security_type='FUT', currency='TWD', multiplier=10)


def filled(ident, action, price, quantity, *, at=AT, account=None, fee=None, tax=None, configured=True, contract=None, lot='Common'):
    return dict(contract=deepcopy(contract or CONTRACT),
                order=dict(id=ident, seqno=ident, action=action, account=deepcopy(account or ACCOUNT), order_lot=lot),
                status=dict(status='Filled', deals=[dict(price=price, quantity=quantity, ts=at.timestamp(),
                            fee=quantity*10 if fee is None else fee, tax=quantity*2 if tax is None else tax)]),
                paper=dict(cost=dict(configured=configured)))


def paper_portfolio(trades):
    broker = Broker(Config(mode='paper', session='regular'))
    broker.paper.orders = {trade['order']['id']: deepcopy(trade) for trade in trades}
    return PortfolioData(broker)


def test_avgcost_partial_close_allocates_entry_and_exit_costs_once():
    trades = [filled('buy1','Buy',100,2,at=AT-timedelta(minutes=4)),
              filled('buy2','Buy',120,2,at=AT-timedelta(minutes=3)),
              filled('sell1','Sell',130,1,at=AT-timedelta(minutes=2)),
              filled('sell2','Sell',100,3,at=AT-timedelta(minutes=1))]
    adapter = paper_portfolio(trades)
    rows = adapter.profit_loss(ACCOUNT, DAY, DAY)
    assert [r['quantity'] for r in rows] == [1,3]
    assert [r['entry_price'] for r in rows] == [110,110]
    assert [r['cover_price'] for r in rows] == [130,100]
    assert [r['fee'] for r in rows] == [20,60]
    assert [r['tax'] for r in rows] == [4,12]
    assert [r['pnl'] for r in rows] == [176,-372]
    summary = adapter.summary(ACCOUNT, DAY, DAY)
    assert summary['total']['entry_amount'] == 4400
    assert summary['total']['cover_amount'] == 4300
    assert summary['total']['pnl'] == -196
    assert summary['total']['quantity'] == 4
    assert summary['costs_complete'] is True
    assert summary['profitloss_sum'][0]['entry_price'] == 110
    assert summary['profitloss_sum'][0]['cover_price'] == 107.5


def test_reversal_splits_exit_costs_from_new_entry_without_double_counting():
    adapter = paper_portfolio([
        filled('long','Buy',100,2,at=AT-timedelta(minutes=3)),
        filled('reverse','Sell',110,3,at=AT-timedelta(minutes=2)),
        filled('cover-short','Buy',105,1,at=AT-timedelta(minutes=1)),
    ])
    rows = adapter.profit_loss(ACCOUNT, DAY, DAY)
    assert [(r['direction'],r['quantity'],r['entry_price'],r['cover_price']) for r in rows] == [
        ('Buy',2,100,110), ('Sell',1,110,105)]
    assert [r['fee'] for r in rows] == [40,20]
    assert [r['tax'] for r in rows] == [8,4]
    assert [r['pnl'] for r in rows] == [152,26]
    summary = adapter.summary(ACCOUNT, DAY, DAY)
    assert summary['total']['pnl'] == 178
    assert summary['total']['buy_cost'] + summary['total']['sell_cost'] == 72
    assert {r['direction'] for r in summary['profitloss_sum']} == {'Buy','Sell'}


def test_query_date_is_taipei_close_date_but_cost_basis_includes_prior_fills():
    adapter = paper_portfolio([
        filled('prior-entry','Buy',100,2,at=datetime(2026,11,16,23,0,tzinfo=TAIPEI)),
        filled('prior-exit','Sell',110,1,at=datetime(2026,11,16,23,59,tzinfo=TAIPEI)),
        filled('today-exit','Sell',120,1,at=datetime(2026,11,17,0,1,tzinfo=TAIPEI)),
        filled('foreign-entry','Buy',1,1,at=AT-timedelta(minutes=2),account=OTHER),
        filled('foreign-exit','Sell',999,1,at=AT-timedelta(minutes=1),account=OTHER),
    ])
    rows = adapter.profit_loss(ACCOUNT, DAY, DAY)
    assert len(rows) == 1 and rows[0]['dseq'] == 'today-exit'
    assert rows[0]['date'] == '20261117' and rows[0]['entry_price'] == 100
    assert rows[0]['pnl'] == 176
    assert adapter.profit_loss(STOCK, DAY, DAY) == []


def test_stock_common_and_odd_lot_quantities_share_one_average_cost_position():
    contract = dict(code='2330',security_type='STK',currency='TWD')
    adapter = paper_portfolio([
        filled('common-entry','Buy',100,1,at=AT-timedelta(minutes=3),account=STOCK,contract=contract,fee=10,tax=0),
        filled('odd-entry','Buy',120,100,at=AT-timedelta(minutes=2),account=STOCK,contract=contract,lot='Odd',fee=1,tax=0),
        filled('odd-exit','Sell',130,100,at=AT-timedelta(minutes=1),account=STOCK,contract=contract,lot='Odd',fee=1,tax=0),
    ])
    row = adapter.profit_loss(STOCK, DAY, DAY)[0]
    assert row['quantity'] == .1
    assert row['entry_price'] == pytest.approx((100_000+12_000)/1100)
    assert row['fee'] == pytest.approx(2)
    assert row['pnl'] == pytest.approx((130-(112_000/1100))*100-2)


def test_unconfigured_entry_costs_remain_incomplete_after_a_configured_exit():
    adapter = paper_portfolio([
        filled('entry','Buy',100,1,at=AT-timedelta(minutes=1),configured=False),
        filled('exit','Sell',110,1),
    ])
    assert adapter.profit_loss(ACCOUNT, DAY, DAY)[0]['costs_complete'] is False
    assert adapter.summary(ACCOUNT, DAY, DAY)['costs_complete'] is False


@pytest.mark.parametrize('start,end', [('2026-11-18','2026-11-17'),('not-date','2026-11-17'),('2000-01-01','2026-11-17')])
def test_profit_loss_rejects_invalid_or_unbounded_date_windows(start,end):
    with pytest.raises(ValueError):
        paper_portfolio([]).profit_loss(ACCOUNT,start,end)


@pytest.mark.parametrize('missing', ['fee','tax'])
def test_configured_paper_costs_cannot_be_fabricated_from_missing_fill_fields(missing):
    entry = filled('entry','Buy',100,1,at=AT-timedelta(minutes=1))
    entry['status']['deals'][0].pop(missing)
    adapter = paper_portfolio([entry,filled('exit','Sell',110,1)])
    with pytest.raises((ValueError,FeatureUnavailable)):
        adapter.profit_loss(ACCOUNT,DAY,DAY)


def test_derivative_profit_loss_requires_a_known_multiplier():
    contract = dict(code='TMFK6',security_type='FUT',currency='TWD')
    adapter = paper_portfolio([
        filled('entry','Buy',100,1,at=AT-timedelta(minutes=1),contract=contract),
        filled('exit','Sell',110,1,contract=contract),
    ])
    with pytest.raises((ValueError,FeatureUnavailable)):
        adapter.profit_loss(ACCOUNT,DAY,DAY)


@pytest.fixture
def native_portfolio():
    broker = Broker(Config(mode='sandbox', session='regular'))
    account = dict(account_type='S',broker_id='TEST',account_id='S-FIXTURE')
    broker.accounts_raw = {('S','TEST','S-FIXTURE'):NS(name='isolated native-account fixture')}
    row = dict(date='2026/11/17',realized_profit=1200,realized_loss=200,filled_qty=1000,
               filled_price=110,stock_no='2330',order_type='Stock')
    query = Mock(return_value=NS(is_success=True,data=[row]))
    broker.sdk = NS(accounting=NS(realized_gains_and_loses=query))
    return PortfolioData(broker), account, query, row


def test_native_stock_profit_loss_filters_dates_and_labels_unknown_provider_coverage(native_portfolio):
    adapter, account, query, row = native_portfolio
    query.return_value.data = [dict(row,date='20261116'),row]
    result = adapter.profit_loss(account,'2026-11-17','2026-11-17')
    assert len(result) == 1 and result[0]['quantity'] == 1 and result[0]['pnl'] == 1000
    assert result[0]['coverage'] == 'provider-returned-range-unknown' and result[0]['pr_ratio'] is None
    query.assert_called_once()
    with pytest.raises(FeatureUnavailable):
        adapter.summary(account,DAY,DAY)
    with pytest.raises(FeatureUnavailable):
        adapter.profit_loss(dict(account,account_type='F'),DAY,DAY)
    assert query.call_count == 1


@pytest.mark.parametrize('patch',[dict(realized_profit=None),dict(realized_loss='NaN'),dict(filled_qty=-1),dict(filled_price=float('inf'))])
def test_native_profit_loss_rejects_missing_nonfinite_or_negative_financial_fields(native_portfolio,patch):
    adapter, account, query, row = native_portfolio
    query.return_value.data = [{**row,**patch}]
    with pytest.raises(ValueError):
        adapter.profit_loss(account,DAY,DAY)


@pytest.fixture
def replay(monkeypatch):
    import fubon_bridge.broker as broker_module
    monkeypatch.setattr(broker_module,'now',lambda:AT)
    broker = Broker(Config(mode='paper', session='regular'))
    broker.contract = Mock(return_value=deepcopy(CONTRACT))
    trades = Mock()
    broker._client = Mock(return_value=NS(intraday=NS(trades=trades)))
    return broker,trades


def tick(index, **patch):
    return dict(time=int(datetime(2026,11,17,9,0,tzinfo=TAIPEI).timestamp()*1_000_000)+index*1000,
                serial=index,price=100+index*.01,size=1,**patch)


def test_all_day_reads_more_than_500_ticks_in_order_and_caches_complete_copy(replay):
    broker, source = replay
    rows = [tick(i) for i in range(501)]
    source.side_effect = [dict(date=DAY.isoformat(),data=rows[:500]),dict(date=DAY.isoformat(),data=rows[500:])]
    result = broker.ticks(dict(code='TMFK6',security_type='FUT'),DAY.isoformat(),all_day=True)
    assert len(result['datetime']) == len(result['close']) == 501
    assert result['complete'] is True and result['limited'] is False and result['source_date'] == DAY.isoformat()
    assert [call.kwargs['offset'] for call in source.call_args_list] == [0,500]
    assert all(call.kwargs['limit'] == 500 and call.kwargs['sort'] == 'asc' for call in source.call_args_list)
    result['close'][0] = -100
    cached = broker.ticks(dict(code='TMFK6',security_type='FUT'),DAY.isoformat(),all_day=True)
    assert cached['close'][0] == 100 and source.call_count == 2
    assert broker.sdk is None


def test_last_count_fetches_latest_descending_then_returns_chronological_without_day_cache(replay):
    broker, source = replay
    source.return_value = dict(date=DAY.isoformat(),data=[tick(3),tick(2),tick(1)])
    result = broker.ticks(dict(code='TMFK6',security_type='FUT'),DAY.isoformat(),3)
    assert result['close'] == [100.01,100.02,100.03]
    assert result['complete'] is False
    source.assert_called_once_with(symbol='TMFK6',limit=3,sort='desc')
    assert not broker.tick_history_cache


@pytest.mark.parametrize('payload',[dict(date='2026-11-16',data=[]),dict(date='not-date',data=[]),dict(date='2026-11-17',data=None)])
def test_replay_rejects_payload_date_or_shape_mismatches_without_cache(replay,payload):
    broker, source = replay
    source.return_value = payload
    with pytest.raises(ValueError):
        broker.ticks(dict(code='TMFK6',security_type='FUT'),DAY.isoformat(),all_day=True)
    assert not broker.tick_history_cache


def test_all_day_mid_page_failure_never_caches_a_partial_day(replay):
    broker, source = replay
    source.side_effect = [dict(date=DAY.isoformat(),data=[tick(i) for i in range(500)]),RuntimeError('temporary market failure')]
    with pytest.raises(RuntimeError):
        broker.ticks(dict(code='TMFK6',security_type='FUT'),DAY.isoformat(),all_day=True)
    assert not broker.tick_history_cache


def test_repeated_page_is_rejected_instead_of_claiming_completeness(replay):
    broker, source = replay
    source.return_value = dict(date=DAY.isoformat(),data=[tick(i) for i in range(500)])
    with pytest.raises(ValueError,match='分頁沒有前進'):
        broker.ticks(dict(code='TMFK6',security_type='FUT'),DAY.isoformat(),all_day=True)
    assert source.call_count == 2 and not broker.tick_history_cache


def test_partial_overlap_between_pages_is_not_published_as_duplicate_complete_ticks(replay):
    broker, source = replay
    source.side_effect = [dict(date=DAY.isoformat(),data=[tick(i) for i in range(500)]),
                          dict(date=DAY.isoformat(),data=[tick(499),tick(500)])]
    try:
        result = broker.ticks(dict(code='TMFK6',security_type='FUT'),DAY.isoformat(),all_day=True)
    except ValueError:
        assert not broker.tick_history_cache
        return
    assert len(result['datetime']) == 501
    assert len(set(result['datetime'])) == 501


@pytest.mark.parametrize('patch',[dict(price=None),dict(price=float('nan')),dict(price=-1),dict(price=True),
                                  dict(size=None),dict(size=float('inf')),dict(size=-1),dict(size=True)])
def test_replay_rejects_malformed_price_or_size_without_cache(replay,patch):
    broker, source = replay
    source.return_value = dict(date=DAY.isoformat(),data=[{**tick(1),**patch}])
    with pytest.raises(ValueError):
        broker.ticks(dict(code='TMFK6',security_type='FUT'),DAY.isoformat(),all_day=True)
    assert not broker.tick_history_cache


@pytest.fixture
def http_replay(tmp_path,monkeypatch):
    import fubon_bridge.broker as broker_module
    monkeypatch.setattr(broker_module,'now',lambda:AT)
    app = create_app(Config(mode='demo'),passkey_store=PasskeyStore(tmp_path/'passkeys.sqlite3'),
                     research_store=ResearchStore(tmp_path/'research.sqlite3'))
    with TestClient(app,raise_server_exceptions=False) as client:
        client.headers['Authorization'] = 'Bearer '+app.state.session.issue()
        yield client,app


@pytest.mark.parametrize('patch',[dict(query_type='NoSuchQuery'),dict(last_cnt=True),dict(last_cnt=0),dict(last_cnt=501),dict(date='NaN')])
def test_http_replay_validates_query_type_count_and_date(http_replay,patch):
    client,app = http_replay
    body = dict(contract=dict(code='TMFR1',security_type='FUT'),date=DAY.isoformat(),query_type='AllDay')
    assert client.post('/api/v1/data/ticks',json={**body,**patch}).status_code == 422
    assert app.state.broker.sdk is None


def test_demo_replay_does_not_claim_a_different_day_than_requested(http_replay):
    client,_ = http_replay
    body = dict(contract=dict(code='TMFR1',security_type='FUT'),date=(DAY-timedelta(days=1)).isoformat(),query_type='AllDay')
    assert client.post('/api/v1/data/ticks',json=body).status_code in {400,422}


def test_all_day_cap_is_reported_as_limited_not_complete(replay):
    broker, source = replay
    source.side_effect = lambda **kw: dict(date=DAY.isoformat(), data=[tick(i) for i in range(kw['offset'],kw['offset']+500)])
    result = broker.ticks(dict(code='TMFK6',security_type='FUT'),DAY.isoformat(),all_day=True)
    assert len(result['close']) == 50_000
    assert result['limited'] is True and result['complete'] is False
    assert source.call_count == 100


@pytest.mark.parametrize('patch',[dict(stock_no=None),dict(filled_price=-1)])
def test_native_profit_loss_rejects_missing_identity_or_negative_price(native_portfolio,patch):
    adapter, account, query, row = native_portfolio
    query.return_value.data = [{**row,**patch}]
    with pytest.raises(ValueError):
        adapter.profit_loss(account,DAY,DAY)
