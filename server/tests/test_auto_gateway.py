from dataclasses import replace
from types import SimpleNamespace as NS

import pytest

from fubon_bridge.mapping import contract_from_ticker
from test_bridge import fake_live_broker


def sandbox_broker():
    broker,row,captures = fake_live_broker()
    broker.config = replace(broker.config,mode="sandbox",live_enabled=False)
    contract = contract_from_ticker(dict(symbol="TMFK6",settlementDate="2026-11-18",referencePrice=25000),"FUT")
    broker.catalog["TMFK6"] = contract
    broker.catalog_full.add("TMFK6")
    broker.sdk.futopt.convert_symbol = lambda *args,**kwargs:"TMFK6"
    row.lot,row.after_lot,row.filled_lot = 1,1,0
    row.user_def,row.buy_sell,row.order_type,row.price_type,row.time_in_force = "FA1234abcd","Buy","New","Limit","IOC"
    return broker,row,captures


def test_automation_reads_fresh_rows_without_inheriting_merged_cache():
    broker,row,_ = sandbox_broker()
    account = broker.account_rows()[0]
    first = broker.automation_orders(account)
    assert first[0]["automation_day"]=="20261113"
    broker.sdk.futopt.get_order_results = lambda _:NS(is_success=True,data=[])
    assert broker.automation_orders(account)==[]
    assert broker.order_list(account,refresh=False)  # manual cache semantics remain unchanged


def test_automation_rejects_duplicate_broker_ids_instead_of_overwriting():
    broker,row,_ = sandbox_broker()
    broker.sdk.futopt.get_order_results = lambda _:NS(is_success=True,data=[row,row])
    with pytest.raises(ValueError,match="重複"):
        broker.automation_orders(broker.account_rows()[0])


@pytest.mark.parametrize('change',[{'quantity':2},{'price':25000.5},{'price_type':'MKT'},{'order_type':'ROD'},{'octype':'Auto'}])
def test_automation_has_hard_single_lot_ioc_guards_before_sdk(change):
    broker,row,captures = sandbox_broker()
    order = dict(action="Buy",price=25000,quantity=1,price_type="LMT",order_type="IOC",octype="New",**{})
    order.update(change)
    with pytest.raises(ValueError,match="單口限價 IOC"):
        broker.place(dict(code="TMFK6",security_type="FUT"),order,broker.account_rows()[0],client_tag="FA1234abcd")
    assert captures==[]


def test_automation_tag_cannot_reach_live_or_night_execution():
    broker,row,captures = sandbox_broker()
    order = dict(action="Buy",price=25000,quantity=1,price_type="LMT",order_type="IOC",octype="New")
    broker.config = replace(broker.config,mode="live",live_enabled=True)
    with pytest.raises(ValueError,match="sandbox"):
        broker.place(dict(code="TMFK6",security_type="FUT"),order,broker.account_rows()[0],client_tag="FA1234abcd")
    broker.config = replace(broker.config,mode="sandbox",live_enabled=False,session="afterhours")
    with pytest.raises(ValueError,match="日盤"):
        broker.place(dict(code="TMFK6",security_type="FUT"),order,broker.account_rows()[0],client_tag="FA1234abcd")
    assert captures==[]


def test_automation_cancel_checks_ownership_after_authoritative_refresh():
    broker,row,captures = sandbox_broker()
    trade = broker.automation_orders(broker.account_rows()[0])[0]
    row.user_def = "FWother123"
    with pytest.raises(ValueError,match="不屬於本策略"):
        broker.mutate(trade['order']['id'],'cancel',client_tag="FA1234abcd")
    assert captures==[]


def test_fill_price_uses_exact_execution_facts_and_deduplicates_filled_no():
    pytest.importorskip('fubon_neo')
    broker,row,_ = sandbox_broker()
    row.status,row.filled_lot,row.filled_money = 50,1,250000
    account = broker.account_rows()[0]
    trade = broker.automation_orders(account)[0]
    fill = NS(date="2026/11/13",branch_no=account['broker_id'],account=account['account_id'],order_no=row.order_no,
        symbol=row.symbol,expiry_date="202611",buy_sell="Buy",filled_no="FILL1",filled_lot=1,filled_price=25001)
    broker.sdk.futopt.filled_history = lambda *args:NS(is_success=True,data=[fill,fill])
    assert broker.automation_fill_price(account,trade,"2026-11-13")==25001
    wrong = NS(**{**vars(fill),'account':'OTHER'})
    broker.sdk.futopt.filled_history = lambda *args:NS(is_success=True,data=[wrong])
    with pytest.raises(ValueError,match="尚未對齊"):
        broker.automation_fill_price(account,trade,"2026-11-13")
    conflict = NS(**{**vars(fill),'filled_price':25002})
    broker.sdk.futopt.filled_history = lambda *args:NS(is_success=True,data=[fill,conflict])
    with pytest.raises(ValueError,match="衝突"):
        broker.automation_fill_price(account,trade,"2026-11-13")
