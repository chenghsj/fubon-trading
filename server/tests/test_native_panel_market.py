"""Native market panel contract QA. No SDK initialization, credentials or network.

Wire shapes/units follow /private/tmp/fubon-official-llms-full.txt. Stats and
IX0001 ticker are small exact public examples; other numeric rows are synthetic
reference-shaped excerpts, never represented as live market observations.
"""
from collections import deque
from copy import deepcopy
from datetime import datetime
from types import SimpleNamespace as NS
from unittest.mock import Mock

import httpx
import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from pydantic import ValidationError

from fubon_bridge.app import create_app
from fubon_bridge.broker import Broker
from fubon_bridge.config import Config
from fubon_bridge.feature_errors import FeatureUnavailable
from fubon_bridge.native_models import NativeQuery
from fubon_bridge.native_panels import NativePanels
from fubon_bridge.passkeys import PasskeyStore
from fubon_bridge.research import ResearchStore


INDEX_TICKER = dict(date='2026-11-17', type='INDEX', exchange='TWSE', market='TSE',
    symbol='IX0001', name='發行量加權股價指數', previousClose=41040.08, openTime='0900', closeTime='1330')
STATS = dict(date='2023-02-09',type='EQUITY',exchange='TWSE',market='TSE',symbol='0050',name='元大台灣50',
    openPrice=120.5,highPrice=121,lowPrice=120.3,closePrice=120.9,change=.05,changePercent=.04,
    tradeVolume=5032245,tradeValue=607543546,previousClose=120.85000000000001,week52High=145.05,week52Low=96.5)
INSTITUTIONAL = dict(type='EQUITY',exchange='TWSE',market='TSE',symbol='2330',data=[
    dict(date='2026-07-09',foreign=dict(buy=2000,sell=500,net=1500),trust=dict(buy=200,sell=100,net=100),
         dealer=dict(buy=100,sell=300,net=-200),total=1400)])
DIRECTOR = dict(type='EQUITY',exchange='TWSE',market='TSE',symbol='2330',data=[
    dict(date='2026-07',directors=[dict(order=0,title='董事長本人',name='合成測試法人',heldShares=None,
         pledgedShares=0,pledgeRatio=.2146,relatedHeldShares=None,relatedPledgedShares=None,relatedPledgeRatio=None)])])
ETF = dict(type='EQUITY',exchange='TWSE',market='TSE',symbol='0050',data=[
    dict(date='2026-07-09',components=[dict(symbol='AAPL UQ',name='reference-shaped foreign constituent',
         quantity=100,weight=58.82,quantityChange=None,weightChange=None)])])
TDCC = dict(type='EQUITY',exchange='TWSE',market='TSE',symbol='2330',data=[
    dict(date='2026-07-10',distributions=[dict(range='1-999',holders=10,shares=9000,proportion=84.67)])])
DIVIDENDS = dict(start_date='2026-11-17',end_date='2026-12-31',sort='asc',data=[
    dict(date='2026-12-01',symbol='2330',name='reference-shaped dividend',exchange='TWSE',cashDividend=5,
         stockDividendShares=0,dividend=5,previousClose=100,referencePrice=95)])
CAPITAL = dict(start_date='2026-11-17',end_date='2026-12-31',sort='asc',data=[
    dict(symbol='0050',name='reference-shaped split',exchange='TWSE',actionType='etf_split_or_merge',
         haltDate='2026-12-01',resumeDate='2026-12-04',raw=dict(splitRatio=4,splitType='分割',referencePrice=None))])
LISTINGS = dict(start_date='2026-11-17',end_date='2026-12-31',sort='asc',data=[
    dict(symbol='9955',name='reference-shaped listed applicant',exchange='TWSE',applicationDate='2026-11-17',
         capitalAtApplication=120000,reviewCommitteeDate=None,boardApprovalDate=None,contractFilingDate=None,
         listedDate=None,underwritingPrice=None),
    dict(symbol='9956',name='reference-shaped OTC applicant',exchange='TPEx',applicationDate='2026-11-17',
         capitalAtApplication=120000000,reviewCommitteeDate=None,boardApprovalDate=None,contractApprovalDate=None,
         listedDate=None,underwritingPrice=None)])
DAILY = dict(date='2026-10-02',product='TXF',exchange='TAIFEX',session='AFTERHOURS',data=[
    dict(contractMonth='202610',strikePrice=None,callPut=None,exchange='TAIFEX',openPrice=None,highPrice=None,
         lowPrice=None,closePrice=None,change=None,changePercent=None,volume=0,volumeSpread=None,
         openInterest=None,settlementPrice=None)])
OPTION_CANDLES = dict(product='TXO',contractMonth='202610W1',exchange='TAIFEX',session='AFTERHOURS',
    timeframe='D',sort='asc',strikePrice=48000,callPut='PUT',data=[
    dict(date='2026-10-02',contractMonth='202610W1',open=None,high=None,low=None,close=None,volume=0)])
INDEX_QUOTE = dict(INDEX_TICKER,lastPrice=41100.25,openPrice=41050,highPrice=41120,lowPrice=41000,
    closePrice=41100.25,change=60.17,changePercent=.1466,lastUpdated=1794902400000000)


@pytest.fixture
def market():
    broker = Broker(Config(mode='paper'))
    broker.sdk = NS(shutdown=Mock())  # ready() only; no SDK object is initialized.
    methods = {
        ('ownership','institutional_trades'):INSTITUTIONAL,('ownership','director_holdings'):DIRECTOR,
        ('ownership','etf_holdings'):ETF,('ownership','tdcc_distribution'):TDCC,
        ('corporate_actions','dividends'):DIVIDENDS,('corporate_actions','capital_changes'):CAPITAL,
        ('corporate_actions','listing_applicants'):LISTINGS,
        ('historical','stats'):STATS,('historical','daily'):DAILY,('historical','candles'):OPTION_CANDLES,
        ('intraday','tickers'):dict(date='2026-11-17',type='INDEX',exchange='TWSE',market='TSE',data=[
            dict(symbol='IX0001',name='發行量加權股價指數')]),
        ('intraday','ticker'):INDEX_TICKER,('intraday','quote'):INDEX_QUOTE,
    }
    for op,values in [('sma',dict(sma=None)),('rsi',dict(rsi=56.2)),('macd',dict(macdLine=2.1,signalLine=1.5)),
                      ('kdj',dict(k=50,d=45,j=60)),('bb',dict(upper=120,middle=110,lower=100))]:
        methods[('technical',op)] = dict(symbol='2330',timeframe='D',data=[dict(date='2026-07-09',**values)])
    client, calls = NS(), {}
    for (namespace,method),payload in methods.items():
        if not hasattr(client,namespace): setattr(client,namespace,NS())
        callback = Mock(return_value=deepcopy(payload))
        setattr(getattr(client,namespace),method,callback)
        calls[(namespace,method)] = callback
    broker._client = Mock(return_value=client)
    return NativePanels(broker),calls


def query(service,operation,**values):
    return service.query(NativeQuery(operation=operation,**values))


@pytest.mark.parametrize('op,method,symbol,start,end',[
    ('institutional','institutional_trades','2330','2026-07-09','2026-07-10'),
    ('director','director_holdings','2330','2026-07-09','2026-08-15'),
    ('etf','etf_holdings','0050','2026-07-09','2026-07-10'),
    ('tdcc','tdcc_distribution','2330','2026-07-09','2026-07-10'),
])
def test_ownership_uses_installed_method_and_exact_documented_date_params(market,op,method,symbol,start,end):
    service,calls = market
    result = query(service,op,symbol=symbol,start=start,end=end)
    expected = dict(symbol=symbol,sort='asc',**{'from':start[:7] if op=='director' else start,
                                              'to':end[:7] if op=='director' else end})
    calls[('ownership',method)].assert_called_once_with(**expected)
    assert result['operation'] == op and result['source'] == 'fubon'


def test_ownership_units_nested_details_and_nulls_are_not_normalized_or_zero_filled(market):
    service,_ = market
    row = query(service,'institutional',symbol='2330')['rows'][0]
    assert row['foreign.buy'] == 2000 and row['foreign.net'] == 1500 and row['total'] == 1400
    directors = query(service,'director',symbol='2330')
    assert directors['detail_keys'] == ['directors']
    assert directors['rows'][0]['directors'][0]['pledgeRatio'] == .2146
    assert directors['rows'][0]['directors'][0]['heldShares'] is None
    etf = query(service,'etf',symbol='0050')
    assert etf['rows'][0]['components'][0]['symbol'] == 'AAPL UQ'
    assert etf['rows'][0]['components'][0]['weight'] == 58.82
    assert etf['rows'][0]['components'][0]['quantityChange'] is None
    tdcc = query(service,'tdcc',symbol='2330')
    assert tdcc['rows'][0]['distributions'][0]['proportion'] == 84.67


@pytest.mark.parametrize('op,method', [('dividends','dividends'),('capital','capital_changes'),('listings','listing_applicants')])
def test_corporate_actions_send_start_date_end_date_and_allow_future_dates(market,op,method):
    service,calls = market
    result = query(service,op,start='2026-11-17',end='2026-12-31')
    calls[('corporate_actions',method)].assert_called_once_with(start_date='2026-11-17',end_date='2026-12-31',sort='asc')
    assert result['rows']


def test_corporate_market_filter_uses_official_exchange_field(market):
    service,_ = market
    result = query(service,'listings',market='OTC',start='2026-11-17',end='2026-12-31')
    assert [row['exchange'] for row in result['rows']] == ['TPEx']
    assert result['rows'][0]['capitalAtApplication'] == 120000000
    assert result['rows'][0]['listedDate'] is None


@pytest.mark.parametrize('op,extras,expected',[
    ('sma',dict(period=10),dict(period=10)),('rsi',dict(period=14),dict(period=14)),
    ('bb',dict(period=20),dict(period=20)),('macd',dict(fast=12,slow=26,signal=9),dict(fast=12,slow=26,signal=9)),
    ('kdj',dict(r_period=9,k_period=3,d_period=3),dict(rPeriod=9,kPeriod=3,dPeriod=3)),
])
def test_technical_period_names_and_daily_date_pair_are_exact(market,op,extras,expected):
    service,calls = market
    query(service,op,symbol='2330',start='2026-07-09',end='2026-07-10',timeframe='D',**extras)
    params = calls[('technical',op)].call_args.kwargs
    assert params['symbol'] == '2330' and params['timeframe'] == 'D'
    assert params['from'] == '2026-07-09' and params['to'] == '2026-07-10'
    for key,value in expected.items(): assert params[key] == value
    assert 'period' not in params or op in {'sma','rsi','bb'}


def test_minute_technical_drops_unsupported_date_range_and_preserves_warmup_null(market):
    service,calls = market
    result = query(service,'sma',symbol='2330',timeframe='3',start='2026-07-09',end='2026-07-10')
    params = calls[('technical','sma')].call_args.kwargs
    assert 'from' not in params and 'to' not in params
    assert result['rows'][0]['sma'] is None and '30' in result['note']


def test_stats_is_flat_native_object_with_raw_quantity_and_source_date(market):
    service,calls = market
    result = query(service,'stats',symbol='0050')
    calls[('historical','stats')].assert_called_once_with(symbol='0050')
    assert len(result['rows']) == 1
    assert result['rows'][0]['tradeVolume'] == 5032245
    assert result['rows'][0]['week52High'] == 145.05
    assert result['metadata']['date'] == '2023-02-09'


def test_daily_uses_root_one_trading_day_and_keeps_night_nulls(market):
    service,calls = market
    result = query(service,'daily',symbol='TXF',date='2026-10-02',session='afterhours',month='202610')
    calls[('historical','daily')].assert_called_once_with(product='TXF',date='2026-10-02',session='afterhours',contractMonth='202610')
    row = result['rows'][0]
    assert row['volume'] == 0 and row['openInterest'] is None and row['settlementPrice'] is None
    assert row['volumeSpread'] is None and result['metadata']['session'] == 'AFTERHOURS'


def test_option_candles_has_explicit_contract_strike_right_and_trading_date_range(market):
    service,calls = market
    result = query(service,'option_candles',symbol='TXO',start='2026-10-01',end='2026-10-02',
                   month='202610W1',strike=48000,right='P',session='afterhours',timeframe='D')
    calls[('historical','candles')].assert_called_once_with(product='TXO',contractMonth='202610W1',strikePrice=48000,
        callPut='PUT',timeframe='D',session='afterhours',sort='asc',**{'from':'2026-10-01','to':'2026-10-02'})
    assert result['rows'][0]['close'] is None and result['rows'][0]['volume'] == 0


@pytest.mark.parametrize('month',['202613','202600','000012','202610W0','202610W6','202610W1Wed','202610F1Fri','1!','202610/202611'])
def test_option_history_rejects_impossible_or_unsupported_contract_months_before_source(market,month):
    service,calls = market
    with pytest.raises((ValueError,ValidationError)):
        query(service,'option_candles',symbol='TXO',start='2026-10-01',end='2026-10-02',month=month,strike=48000)
    calls[('historical','candles')].assert_not_called()


def test_option_history_rejects_unsupported_three_minute_timeframe(market):
    service,calls = market
    with pytest.raises((ValueError,ValidationError)):
        query(service,'option_candles',symbol='TXO',start='2026-10-01',end='2026-10-02',month='202610',strike=48000,timeframe='3')
    calls[('historical','candles')].assert_not_called()


@pytest.mark.parametrize('month',['1!','2!','3!','202610/202611'])
def test_futures_daily_accepts_documented_continuous_and_spread_months(market,month):
    service,calls = market
    query(service,'daily',symbol='TXF',date='2026-10-02',month=month)
    assert calls[('historical','daily')].call_args.kwargs['contractMonth'] == month


@pytest.mark.parametrize('values',[
    dict(start='2026-07-01'),dict(end='2026-07-01'),dict(start='2026-07-10',end='2026-07-09'),
    dict(start='not-date',end='2026-07-09'),dict(period=True),dict(strike=float('nan')),
    dict(strike=float('inf')),dict(month='x'*17),dict(symbol='2330/secret'),dict(method='raw_sdk_method'),
])
def test_query_dto_rejects_bad_date_pairs_nonfinite_and_arbitrary_sdk_args(values):
    with pytest.raises(ValidationError):
        NativeQuery(operation='sma',**values)


def test_market_date_interval_must_be_strictly_less_than_one_year(market):
    service,calls = market
    with pytest.raises(ValueError):
        query(service,'institutional',symbol='2330',start='2025-01-01',end='2026-01-01')
    calls[('ownership','institutional_trades')].assert_not_called()


def test_indices_use_native_identity_and_equity_is_not_accepted_as_index(market):
    service,calls = market
    calls[('intraday','tickers')].return_value = dict(date='2026-11-17',type='INDEX',exchange='TPEx',market='OTC',
        data=[dict(symbol='TESTOTC',name='synthetic OTC index')])
    result = query(service,'indices',market='OTC')
    calls[('intraday','tickers')].assert_called_once_with(type='INDEX',market='OTC')
    assert result['rows'][0]['symbol'] == 'TESTOTC'
    calls[('intraday','ticker')].return_value = dict(INDEX_TICKER,type='EQUITY')
    with pytest.raises(ValueError): query(service,'index_quote',symbol='2330')
    calls[('intraday','quote')].assert_not_called()


def test_native_index_quote_calls_stock_transport_with_same_native_symbol(market):
    service,calls = market
    result = query(service,'index_quote',symbol='ix0001')
    calls[('intraday','ticker')].assert_called_once_with(symbol='IX0001')
    calls[('intraday','quote')].assert_called_once_with(symbol='IX0001')
    assert result['rows'][0]['type'] == 'INDEX'


def test_index_quote_rejects_mismatched_equity_payload_even_after_valid_index_ticker(market):
    service,calls = market
    calls[('intraday','quote')].return_value = dict(INDEX_QUOTE,type='EQUITY',symbol='2330')
    with pytest.raises(ValueError): query(service,'index_quote',symbol='IX0001')


def test_native_market_cache_is_deepcopied_parameter_scoped_and_expires(market,monkeypatch):
    import fubon_bridge.native_panels as module
    service,calls = market
    clock = [100.0]
    monkeypatch.setattr(module,'time',NS(monotonic=lambda:clock[0]))
    first = query(service,'stats',symbol='0050')
    first['rows'][0]['week52High'] = -1
    assert query(service,'stats',symbol='0050')['rows'][0]['week52High'] == 145.05
    assert calls[('historical','stats')].call_count == 1
    clock[0] += 16
    query(service,'stats',symbol='0050')
    assert calls[('historical','stats')].call_count == 2


def test_native_market_local_rate_limit_stops_source_then_recovers_after_minute(market,monkeypatch):
    import fubon_bridge.native_panels as module
    service,calls = market
    clock = [100.0]
    monkeypatch.setattr(module,'time',NS(monotonic=lambda:clock[0]))
    service.rate['historical'] = deque([100.0]*45)
    with pytest.raises(HTTPException) as error: query(service,'stats',symbol='0050')
    assert error.value.status_code == 429 and error.value.headers['Retry-After'] == '60'
    calls[('historical','stats')].assert_not_called()
    clock[0] += 61
    query(service,'stats',symbol='0050')
    calls[('historical','stats')].assert_called_once()


def test_upstream_failure_is_not_cached(market):
    service,calls = market
    source = calls[('historical','stats')]
    source.side_effect = [HTTPException(429,'rate limited'),deepcopy(STATS)]
    with pytest.raises(HTTPException): query(service,'stats',symbol='0050')
    assert not service.cache
    assert query(service,'stats',symbol='0050')['rows'][0]['symbol'] == '0050'
    assert source.call_count == 2


@pytest.mark.parametrize('payload',[dict(symbol='2330',data=None),dict(symbol='2330',data='not-list'),dict(symbol='2330')])
def test_malformed_list_source_is_not_presented_as_a_successful_metadata_row(market,payload):
    service,calls = market
    calls[('ownership','institutional_trades')].return_value = payload
    with pytest.raises(ValueError): query(service,'institutional',symbol='2330')
    assert not service.cache


def test_nonfinite_source_is_not_cached_and_next_good_response_can_recover(market):
    service,calls = market
    calls[('historical','stats')].side_effect = [dict(STATS,week52High=float('inf')),deepcopy(STATS)]
    with pytest.raises(ValueError): query(service,'stats',symbol='0050')
    assert not service.cache
    assert query(service,'stats',symbol='0050')['rows'][0]['week52High'] == 145.05


def test_readonly_transport_timeout_and_errors_do_not_leak_credentials(market,monkeypatch):
    import fubon_bridge.native_panels as module
    service,_ = market
    config = dict(base_url='https://fixture.invalid/stock',sdk_token='fixture-token')
    request = Mock(side_effect=httpx.TimeoutException('unsafe-private-body'))
    monkeypatch.setattr(module.httpx,'get',request)
    with pytest.raises(HTTPException) as error: service._request(config,'historical/stats/0050',{})
    assert error.value.status_code == 504
    assert 'fixture-token' not in error.value.detail and 'unsafe-private-body' not in error.value.detail
    assert request.call_args.kwargs['timeout'] == 20


@pytest.fixture
def http_native(tmp_path,market):
    service,_ = market
    app = create_app(Config(mode='paper'),passkey_store=PasskeyStore(tmp_path/'passkeys.sqlite3'),
                     research_store=ResearchStore(tmp_path/'research.sqlite3'))
    app.state.broker.sdk = service.broker.sdk
    app.state.broker._client = service.broker._client
    with TestClient(app,raise_server_exceptions=False) as client:
        yield client,app


def test_native_http_route_is_authenticated_typed_and_market_only(http_native):
    client,app = http_native
    body = dict(operation='stats',symbol='0050')
    assert client.post('/api/v1/native/query',json=body).status_code == 401
    client.headers['Authorization'] = 'Bearer '+app.state.session.issue()
    result = client.post('/api/v1/native/query',json=body)
    assert result.status_code == 200, result.text
    assert result.json()['rows'][0]['week52High'] == 145.05
    assert client.post('/api/v1/native/query',json={**body,'method':'__dict__'}).status_code == 422


@pytest.mark.parametrize('op,values,path,payload',[
    ('institutional',dict(symbol='2330'),'ownership/institutional-trades/2330',INSTITUTIONAL),
    ('bb',dict(symbol='2330'),'technical/bb/2330',dict(symbol='2330',timeframe='D',data=[])),
    ('daily',dict(symbol='TXF',date='2026-10-02',month='202610'),'historical/daily/TXF',DAILY),
    ('option_candles',dict(symbol='TXO',start='2026-10-01',end='2026-10-02',month='202610W1',strike=48000,right='P'),
     'historical/candles/TXO',OPTION_CANDLES),
])
def test_real_installed_rest_method_dispatch_is_exercised_through_offline_transport_seam(market,op,values,path,payload):
    # These REST facades only store config. No FubonSDK/CoreSDK is created;
    # NativePanels._request is replaced before any endpoint method is invoked.
    from fugle_marketdata.rest.stock.client import RestStockClient
    from fugle_marketdata.rest.futopt.client import RestFutOptClient
    service,_ = market
    stock = RestStockClient(base_url='https://fixture.invalid/stock',sdk_token='test-only')
    futures = RestFutOptClient(base_url='https://fixture.invalid/futopt',sdk_token='test-only')
    service.broker._client = Mock(side_effect=lambda kind: stock if kind=='STK' else futures)
    service._request = Mock(return_value=deepcopy(payload))
    result = query(service,op,**values)
    assert result['source'] == 'fubon'
    assert service._request.call_args.args[1] == path
    assert 'symbol' not in service._request.call_args.args[2]
