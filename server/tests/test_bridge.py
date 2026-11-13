from copy import deepcopy
from datetime import timedelta
from types import SimpleNamespace as NS

import pytest
from fastapi.testclient import TestClient

from fubon_bridge.app import create_app
from fubon_bridge.broker import Broker
from fubon_bridge.config import Config
from fubon_bridge.mapping import contract_from_ticker, market_events, normalize_trade, now, snapshot


@pytest.fixture
def client():
    with TestClient(create_app(Config())) as client:
        yield client


def account(client, kind="F"):
    return next(a for a in client.get("/api/v1/auth/accounts").json() if a["account_type"] == kind)


def request_order(client, price=10000, quantity=2, **overrides):
    contract = client.get("/api/v1/data/contracts/TXFR1/info?security_type=FUT").json()
    contract["code"] = contract["target_code"]
    order = dict(action="Buy", price=price, quantity=quantity, price_type="LMT", order_type="ROD", octype="New", account=account(client))
    order.update(overrides)
    return dict(contract={k: contract[k] for k in ("code", "security_type", "exchange", "target_code")}, futures_order=order)


def test_demo_boots_and_reports_truthful_mode(client):
    info = client.get("/api/v1/info").json()
    assert info["broker"] == "fubon" and info["mode"] == "demo" and info["simulation"]
    assert client.get("/api/v1/health").json()["status"] == "healthy"
    watchlist = client.get("/api/v1/watchlist").json()[0]
    assert watchlist["contracts"][0]["code"] == "TMFR1"
    assert client.get("/api/v1/data/contracts/2330/info?security_type=STK").json()["exchange"] == "TSE"


def test_order_lifecycle_quantity_reduction_and_cancel(client):
    body = request_order(client)
    trade = client.post("/api/v1/order/place_order", json=body).json()
    ident = trade["order"]["id"]
    assert trade["status"]["status"] == "Submitted"
    reduced = client.post("/api/v1/order/update_qty", json=dict(trade_id=ident, quantity=1)).json()
    assert reduced["order"]["quantity"] == 2
    assert reduced["status"]["cancel_quantity"] == 1
    assert client.post("/api/v1/order/update_qty", json=dict(trade_id=ident, quantity=2)).status_code == 400
    cancelled = client.post("/api/v1/order/cancel_order", json=dict(trade_id=ident)).json()
    assert cancelled["status"]["status"] == "Cancelled"
    assert cancelled["status"]["cancel_quantity"] == 2
    assert client.post("/api/v1/order/cancel_order", json=dict(trade_id=ident)).status_code == 400


def test_reduced_order_fills_only_remaining_quantity(client):
    trade = client.post("/api/v1/order/place_order", json=request_order(client)).json()
    ident = trade["order"]["id"]
    client.post("/api/v1/order/update_qty", json=dict(trade_id=ident, quantity=1))
    filled = client.post("/api/v1/order/update_price", json=dict(trade_id=ident, price=26000)).json()
    assert filled["status"]["deal_quantity"] == 1
    pos = client.post("/api/v1/portfolio/position_unit", json=account(client)).json()
    assert pos[0]["quantity"] == 1
    assert "yd_quantity" not in pos[0]  # terminal discriminates stocks by this field


def test_paper_buy_and_close_do_not_call_sdk(client):
    filled = client.post("/api/v1/order/place_order", json=request_order(client, price=0, price_type="MKT", order_type="IOC")).json()
    assert filled["status"]["status"] == "Filled"
    assert client.app.state.broker.sdk is None
    closed = client.post("/api/v1/order/place_order", json=request_order(client, price=0, price_type="MKT", order_type="IOC", action="Sell", octype="Cover")).json()
    assert closed["status"]["status"] == "Filled"
    assert client.post("/api/v1/portfolio/position_unit", json=account(client)).json() == []


def test_two_pending_cover_orders_cannot_reverse_position(client):
    client.post("/api/v1/order/place_order", json=request_order(client, price=0, price_type="MKT", order_type="IOC"))
    for _ in range(2):
        assert client.post("/api/v1/order/place_order", json=request_order(client, price=26000, action="Sell", octype="Cover")).status_code == 200
    book = client.app.state.broker.paper
    code = next(iter(book.positions.values()))["contract"]["code"]
    book.tick(code, dict(close=27000, buy_price=27000, sell_price=27001, datetime=now().isoformat()))
    assert next(iter(book.positions.values()))["signed_qty"] == 0
    assert list(book.orders.values())[-1]["status"]["status"] == "Cancelled"


@pytest.mark.parametrize("changes", [dict(quantity=0), dict(quantity=-1), dict(quantity=1.5), dict(quantity=True),
    dict(price=-1), dict(price_type="WRONG"), dict(action="Foo"), dict(octype="Wrong"),
    dict(price_type="MKT", order_type="ROD"), dict(quantity=11)])
def test_invalid_orders_never_enter_book(client, changes):
    body = request_order(client)
    body["futures_order"].update(changes)
    assert client.post("/api/v1/order/place_order", json=body).status_code in {400, 422}
    assert client.app.state.broker.paper.orders == {}


def test_account_and_continuous_contract_guards(client):
    body = request_order(client)
    body["futures_order"]["account"]["account_id"] = "ANOTHER-ACCOUNT"
    assert client.post("/api/v1/order/place_order", json=body).status_code == 400
    body = request_order(client)
    body["contract"]["code"] = "TXFR1"
    # A fabricated target_code must not authorize an alias order.
    body["contract"]["target_code"] = "TXFA0"
    assert client.post("/api/v1/order/place_order", json=body).status_code == 400


def test_foreign_origin_and_form_posts_are_rejected(client):
    body = request_order(client)
    assert client.post("/api/v1/order/place_order", json=body, headers={"Origin": "https://evil.example"}).status_code == 403
    assert client.post("/api/v1/order/place_order", data={"price": "25000"}).status_code == 415
    assert client.get("/api/v1/info", headers={"Host": "evil.example"}).status_code == 403


def test_missing_credentials_do_not_fall_back_to_synthetic_data():
    with TestClient(create_app(Config(mode="paper"))) as client:
        assert not client.get("/api/v1/info").json()["connected"]
        assert not account(client)["signed"]
        assert client.get("/api/v1/data/contracts/TXFR1/info?security_type=FUT").status_code == 400


def test_live_requires_explicit_opt_in():
    with pytest.raises(ValueError, match="ENABLE_LIVE"):
        Config(mode="live")


def test_stock_exchange_and_native_quantity_mapping():
    stock = contract_from_ticker(dict(symbol="2330", exchange="TWSE", market="TSE"), "STK")
    assert stock["exchange"] == "TSE"
    a = dict(account_type="S", broker_id="6460", account_id="123")
    row = dict(quantity=2000, after_qty=1000, filled_qty=1000, status=30, seq_no="1", order_no="A1", market_type="Common")
    trade = normalize_trade(row, stock, a)
    assert trade["order"]["quantity"] == 2
    assert trade["status"]["deal_quantity"] == 1
    assert trade["status"]["cancel_quantity"] == 1


def test_new_futures_position_type_survives_mapping():
    trade = normalize_trade(dict(lot=2, after_lot=2, filled_lot=1, status=10, order_type="New"), {}, dict(account_type="F", broker_id="1", account_id="1"))
    assert trade["order"]["octype"] == "New"
    assert trade["status"]["cancel_quantity"] == 0


def test_market_mapping_preserves_trial_and_microsecond_time():
    q = snapshot(dict(lastPrice=26000, isTrial=True, lastTrade=dict(price=25000, time=1702956487023000)), "TXFA4")
    assert q["is_trial"]
    assert q["datetime"].endswith("+08:00")
    event, payload = next(market_events("trades", dict(symbol="TXFA4", time=1702956487023000, trades=[dict(price=25000, size=2)], isTrial=True), "TXFR1"))
    assert event == "tick_fop" and payload["simtrade"]
    assert payload["code"] == "TXFR1" and payload["close"] == "25000"


@pytest.mark.parametrize("override", [dict(is_trial=True), dict(datetime=(now()-timedelta(minutes=3)).isoformat()), dict(datetime="bad")])
def test_trial_and_stale_quotes_cannot_fill_paper(client, override):
    broker = client.app.state.broker
    contract = broker.contract(dict(code="TXFR1", security_type="FUT"))
    contract = broker.contract(dict(code=contract["target_code"], security_type="FUT"))
    q = dict(broker.quote(contract), **override)
    order = request_order(client, price=0, price_type="MKT", order_type="IOC")["futures_order"]
    trade = broker.paper.place(contract, order, account(client), q)
    assert trade["status"]["status"] == "Cancelled"
    assert not broker.paper.positions


def fake_live_broker(session="regular"):
    cfg = Config(mode="live", live_enabled=True, session=session)
    broker = Broker(cfg)
    a = NS(account_type="futopt", branch_no="15901", account="123", name="test")
    row = NS(lot=2, after_lot=2, filled_lot=0, status=10, seq_no="seq", order_no="A1", date="2026/11/13", symbol="FITX", expiry_date="202611", buy_sell="Buy", price=25000, order_type="New")
    captures = []
    futopt = NS(get_order_results=lambda _: NS(is_success=True, data=[row]),
        convert_symbol=lambda *a, **kw: "TXFK6",
        place_order=lambda account, order: (captures.append(order) or NS(is_success=True, data=row)),
        cancel_order=lambda account, raw: (captures.append(raw) or NS(is_success=True, data=NS(**{**vars(row), "status": 30, "after_lot": 0}))))
    broker.sdk = NS(futopt=futopt)
    broker.accounts_raw[("F", "15901", "123")] = a
    broker.connected_sockets.add("futopt")
    broker.catalog["TXFK6"] = contract_from_ticker(dict(symbol="TXFK6", referencePrice=25000, settlementDate="2026-11-18"), "FUT")
    broker.catalog_full.add("TXFK6")
    return broker, row, captures


@pytest.mark.parametrize("session,market", [("regular", "Future"), ("afterhours", "FutureNight")])
def test_real_sdk_order_constructor_is_compatible_without_login(session, market):
    pytest.importorskip("fubon_neo")
    broker, row, captured = fake_live_broker(session)
    a = broker.account_rows()[0]
    broker.place(dict(code="TXFK6", security_type="FUT"), dict(action="Sell", price=0, quantity=2, price_type="MKP", order_type="IOC", octype="Cover"), a)
    order = captured[0]
    assert str(order.market_type).endswith(market)
    assert str(order.order_type).endswith("Close")
    assert order.lot == 2 and order.symbol == "TXFK6"


def test_live_order_refuses_when_market_socket_is_down():
    broker, row, captured = fake_live_broker()
    broker.connected_sockets.clear()
    with pytest.raises(ValueError, match="即時行情未連線"):
        broker.place(dict(code="TXFK6", security_type="FUT"), dict(action="Buy", price=25000, quantity=1, price_type="LMT", order_type="ROD"), broker.account_rows()[0])
    assert captured == []


def test_fresh_authoritative_order_required_before_cancel():
    broker, row, captured = fake_live_broker()
    a = broker.account_rows()[0]
    trade = broker._remember(row, broker.catalog["TXFK6"], a)
    broker.sdk.futopt.get_order_results = lambda _: NS(is_success=True, data=[])
    with pytest.raises(ValueError, match="舊快取"):
        broker.mutate(trade["order"]["id"], "cancel")
    assert captured == []


def test_cancel_passes_native_order_result_directly():
    broker, row, captured = fake_live_broker()
    a = broker.account_rows()[0]
    trade = broker._remember(row, broker.catalog["TXFK6"], a)
    assert broker.mutate(trade["order"]["id"], "cancel")["status"]["status"] == "Cancelled"
    assert captured == [row]


def test_continuous_history_keeps_continuous_month():
    broker, _, _ = fake_live_broker()
    seen = []
    info = dict(broker.catalog["TXFK6"], code="TXFR1", target_code="TXFK6")
    broker.contract = lambda _: info
    candles = lambda **kw: (seen.append(kw) or {"data": []})
    broker.sdk.marketdata = NS(rest_client=NS(futopt=NS(historical=NS(candles=candles))))
    broker.kbars(dict(code="TXFR1", security_type="FUT"), "2025-01-01", "2025-02-01")
    assert seen[0]["product"] == "TXF" and seen[0]["contractMonth"] == "1!"


def test_no_unsupported_feature_reports_success(client):
    assert client.post("/api/v1/order/place_comboorder", json={}).status_code == 501
    assert client.post("/api/v1/data/scanner", json={}).status_code == 501


def test_partial_ioc_fill_and_cancel_is_terminal():
    trade = normalize_trade(dict(lot=3, after_lot=0, filled_lot=1, status=40), {}, dict(account_type="F", broker_id="1", account_id="1"))
    assert trade["status"]["status"] == "Cancelled"
    assert trade["status"]["deal_quantity"] == 1 and trade["status"]["cancel_quantity"] == 2


@pytest.mark.parametrize("status", [19, 29, 39])
def test_rejected_amendment_preserves_working_order(status):
    trade = normalize_trade(dict(lot=3, after_lot=3, filled_lot=1, status=status), {}, dict(account_type="F", broker_id="1", account_id="1"))
    assert trade["status"]["status"] == "PartFilled"


def test_sparse_stock_catalog_fetches_full_ticker_once():
    broker = Broker(Config(mode="paper"))
    seen = []
    intraday = NS(tickers=lambda **_: {"data": [dict(symbol="2330", name="TSMC")]},
        ticker=lambda **kw: (seen.append(kw) or dict(symbol="2330", name="TSMC", market="TSE", referencePrice=1000, limitUpPrice=1100, limitDownPrice=900, canDayTrade=True)))
    broker.sdk = NS(marketdata=NS(rest_client=NS(stock=NS(intraday=intraday))))
    broker.contracts("STK")
    assert broker.contract(dict(code="2330", security_type="STK"))["reference"] == 1000
    assert broker.contract(dict(code="2330", security_type="STK"))["limit_up"] == 1100
    assert len(seen) == 1


def test_any_required_socket_down_is_not_reported_as_connected():
    broker = Broker(Config(mode="paper"))
    broker.subscriptions = {("2330", "Tick"): dict(kind="stock"), ("TXFK6", "Tick"): dict(kind="futopt")}
    broker.connected_sockets.add("stock")
    assert not broker.market_connected()
    broker.connected_sockets.add("futopt")
    assert broker.market_connected()


def test_fubon_minute_start_is_shifted_to_terminal_close_label():
    broker, _, _ = fake_live_broker()
    broker.contract = lambda _: broker.catalog["TXFK6"]
    row = dict(date="2025-01-02T08:45:00+08:00", open=1, high=2, low=1, close=2, volume=5)
    broker.sdk.marketdata = NS(rest_client=NS(futopt=NS(historical=NS(candles=lambda **_: {"data": [row]}))))
    result = broker.kbars(dict(code="TXFK6", security_type="FUT"), "2025-01-01", "2025-01-03")
    assert result["datetime"] == ["2025-01-02T08:46:00+08:00"]
