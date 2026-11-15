from copy import deepcopy
from datetime import date, datetime, timedelta
from types import SimpleNamespace
from concurrent.futures import ThreadPoolExecutor
from threading import Event

import pytest
from fastapi.testclient import TestClient

from fubon_bridge.app import create_app
from fubon_bridge.auto_store import AutoStore
from fubon_bridge.auto_trading import AutoConfig, SandboxAutoTrader, opening_signal
from fubon_bridge.config import Config
from fubon_bridge.mapping import TAIPEI
from fubon_bridge.passkeys import PasskeyStore
from fubon_bridge.research import ResearchStore

HEADER = "Bearer controller"
ACCOUNT = dict(account_type="F",broker_id="TEST",account_id="AUTO")


class FakeGateway:
    mode = "sandbox"

    def __init__(self, clock):
        self.clock = clock
        self.requests, self.rows, self.cancels = [],[],[]
        self.price = 25020
        self.age = 0
        self.trial = False
        self.unknown = False
        self.missing_fill_price = False
        self.before_submit = lambda:None
        start = datetime(2026,11,13,9,tzinfo=TAIPEI).timestamp()
        self.candles = [dict(time=int(start+(i+1)*60),open=25000 if i<19 else 25020,
            high=25010 if i<19 else 25030,low=24990,close=25000 if i<19 else 25020,volume=10) for i in range(260)]

    def prepare(self, cfg):
        if self.mode!="sandbox":
            raise ValueError("wrong mode")
        return dict(code=cfg["contract_code"],security_type="FUT",multiplier=10,delivery_date="2026-11-18",limit_up=50000,limit_down=1)

    def quote(self, contract):
        return dict(price=self.price,bid=self.price-1,ask=self.price+1,time=self.clock.at.timestamp()-self.age,trial=self.trial)

    def bars(self, *args):
        return deepcopy(self.candles)

    def orders(self, cfg):
        return deepcopy(self.rows)

    def fill_price(self, cfg, trade):
        if self.missing_fill_price:
            raise ValueError("pending execution detail")
        return trade["test_fill_price"]

    def submit(self, cfg, action, limit, role, tag):
        self.before_submit()
        self.requests.append(dict(tag=tag,role=role,action=action,limit=limit))
        if self.unknown:
            raise TimeoutError("outcome unknown")
        row = dict(automation_day=cfg["trade_date"].replace("-",""),contract=dict(code=cfg["contract_code"]),
            order=dict(id=tag,ordno=tag,custom_field=tag,action=action,quantity=1,account=cfg["account"],price_type="LMT",order_type="IOC",octype="New" if role=="entry" else "Cover"),
            status=dict(status="Submitted",deal_quantity=0))
        self.rows.append(row)
        return deepcopy(row)

    def execution_ready(self):
        return True

    def fill(self, price):
        self.rows[-1]["status"].update(status="Filled",deal_quantity=1)
        self.rows[-1]["test_fill_price"] = price

    def cancel(self, ident, tag):
        self.cancels.append((ident,tag))
        next(r for r in self.rows if r["order"]["id"]==ident)["status"]["status"] = "Cancelled"


@pytest.fixture
def setup(tmp_path):
    clock = SimpleNamespace(at=datetime(2026,11,13,9,19,tzinfo=TAIPEI),mono=0)
    gateway = FakeGateway(clock)
    store = AutoStore(ResearchStore(tmp_path/"research.db"))
    authorize = lambda header:header==HEADER
    trader = SandboxAutoTrader(gateway,store,authorize,clock=lambda:clock.at,monotonic=lambda:clock.mono)
    cfg = AutoConfig(account=ACCOUNT,contract_code="TMFK6",trade_date="2026-11-13")
    return trader,gateway,clock,store,cfg


def enter(setup):
    trader,gateway,clock,store,cfg = setup
    trader.start(cfg,HEADER)
    clock.at = datetime(2026,11,13,9,20,1,tzinfo=TAIPEI)
    trader.tick()
    assert len(gateway.requests)==1
    return trader,gateway,clock,store,cfg


def test_durable_intent_precedes_one_submission_and_never_repeats_same_signal(setup):
    trader,gateway,clock,store,cfg = setup
    def before():
        saved = store.latest()
        assert saved["pending"]==saved["orders"][-1]["tag"]
        assert saved["orders"][-1]["status"]=="Sending"
        assert saved["entryCount"]==1
    gateway.before_submit = before
    enter(setup)
    for _ in range(3):
        trader.tick()
    assert len(gateway.requests)==1
    assert trader.snapshot()["pending"]
    assert len(gateway.requests[0]["tag"])==10


@pytest.mark.parametrize("mode",["demo","live"])
def test_other_environments_cannot_start(setup,mode):
    trader,gateway,clock,store,cfg = setup
    gateway.mode = mode
    with pytest.raises(ValueError,match="sandbox"):
        trader.start(cfg,HEADER)
    assert gateway.requests==[]


def test_unknown_entry_with_empty_authoritative_query_is_not_retried(setup):
    trader,gateway,clock,store,cfg = setup
    gateway.unknown = True
    enter(setup)
    for _ in range(5):
        trader.tick()
    assert len(gateway.requests)==1
    assert trader.snapshot()["status"]=="attention"
    assert trader.snapshot()["orders"][0]["status"]=="Unknown"
    assert store.latest()["entryCount"]==1


def test_fill_is_authoritative_and_repeated_queries_do_not_duplicate_exposure(setup):
    trader,gateway,clock,store,cfg = enter(setup)
    assert trader.snapshot()["position"] is None
    gateway.fill(25022)
    for _ in range(3):
        trader.tick()
    state = trader.snapshot()
    assert state["position"]==dict(entryTag=gateway.requests[0]["tag"],side="Buy",quantity=1,entryPrice=25022,referencePrice=25022,referenceType='fill',stop=24992,target=25082)
    assert state["pending"] is None and len(gateway.requests)==1


def test_only_three_confirmed_unfilled_exit_attempts_then_attention(setup):
    trader,gateway,clock,store,cfg = enter(setup)
    gateway.fill(25022)
    trader.tick()
    gateway.price = 24990
    trader.tick()
    for _ in range(3):
        gateway.rows[-1]["status"]["status"] = "Cancelled"
        trader.tick()
    state = trader.snapshot()
    assert len(gateway.requests)==4  # one entry, three bounded exits
    assert state["status"]=="attention" and state["position"]["quantity"]==1
    trader.tick()
    assert len(gateway.requests)==4


def test_unknown_exit_keeps_position_and_never_submits_second_exit(setup):
    trader,gateway,clock,store,cfg = enter(setup)
    gateway.fill(25022)
    trader.tick()
    gateway.price,gateway.unknown = 24990,True
    trader.tick()
    for _ in range(3):
        trader.tick()
    assert len(gateway.requests)==2
    assert trader.snapshot()["position"]["quantity"]==1
    assert trader.snapshot()["pending"]==gateway.requests[-1]["tag"]


def test_heartbeat_expiry_pauses_new_entries_but_preserves_exit_monitor(setup):
    trader,gateway,clock,store,cfg = enter(setup)
    gateway.fill(25022)
    trader.tick()
    clock.mono = 16
    trader.tick()
    assert trader.snapshot()["status"]=="paused"
    gateway.price = 24990
    trader.tick()
    assert [r["role"] for r in gateway.requests]==["entry","exit"]


def test_risk_lock_pauses_and_viewer_cannot_renew_owner_heartbeat(setup):
    trader,gateway,clock,store,cfg = setup
    state = trader.start(cfg,HEADER)
    with pytest.raises(ValueError):
        trader.heartbeat("Bearer viewer",state["id"],True)
    trader.heartbeat(HEADER,state["id"],False)
    clock.at += timedelta(minutes=1)
    trader.tick()
    assert trader.snapshot()["status"]=="paused" and gateway.requests==[]


def test_restart_and_rearm_keep_consumed_entry_limit_and_freeze_config(setup):
    trader,gateway,clock,store,cfg = setup
    cfg = cfg.model_copy(update={"max_entries":1})
    trader.start(cfg,HEADER)
    clock.at += timedelta(minutes=1,seconds=1)
    trader.tick()
    gateway.rows[-1]["status"]["status"] = "Cancelled"
    trader.tick()
    trader.shutdown()
    restored = SandboxAutoTrader(gateway,store,lambda h:h==HEADER,clock=lambda:clock.at,monotonic=lambda:clock.mono)
    assert restored.snapshot()["status"]=="paused"
    assert restored.snapshot()["entryCount"]==1
    with pytest.raises(ValueError,match="設定已固定"):
        restored.start(cfg.model_copy(update={"stop_points":50}),HEADER)
    restored.start(cfg,HEADER)
    restored.tick()
    assert restored.snapshot()["status"]=="paused" and len(gateway.requests)==1


def test_missing_execution_prices_are_not_replaced_with_limit_prices(setup):
    trader,gateway,clock,store,cfg = enter(setup)
    gateway.missing_fill_price = True
    gateway.fill(25022)
    trader.tick()
    assert trader.snapshot()["position"]["entryPrice"] is None
    gateway.price = 24990
    trader.tick()
    gateway.fill(24990)
    trader.tick()
    assert trader.snapshot()["position"] is None
    assert trader.snapshot()["realizedNet"] is None
    assert trader.snapshot()["status"]=="attention"


def test_old_signals_and_stale_quotes_do_not_enter(setup):
    trader,gateway,clock,store,cfg = setup
    clock.at = datetime(2026,11,13,9,20,1,tzinfo=TAIPEI)
    trader.start(cfg,HEADER)
    trader.tick()
    assert gateway.requests==[]  # already completed before arm
    trader.control("pause",HEADER,trader.snapshot()["id"])
    clock.at = datetime(2026,11,13,9,19,tzinfo=TAIPEI)
    trader.start(cfg,HEADER)
    gateway.age = 120
    clock.at += timedelta(minutes=1,seconds=1)
    trader.tick()
    assert gateway.requests==[]


def test_foreign_or_duplicate_tag_rows_cannot_become_strategy_fills(setup):
    trader,gateway,clock,store,cfg = enter(setup)
    gateway.rows.append(deepcopy(gateway.rows[0]))
    trader.tick()
    assert trader.snapshot()["status"]=="attention"
    assert trader.snapshot()["position"] is None and not gateway.cancels


def test_two_backend_instances_cannot_own_execution_lease(setup):
    trader,gateway,clock,store,cfg = setup
    trader.start(cfg,HEADER)
    second = SandboxAutoTrader(gateway,store,lambda h:True,clock=lambda:clock.at)
    with pytest.raises(ValueError,match="另一個服務"):
        second.start(cfg,HEADER)


def test_restart_cannot_exit_until_operator_explicitly_reconciles(setup):
    trader,gateway,clock,store,cfg = enter(setup)
    gateway.fill(25022)
    trader.tick()
    trader.shutdown()
    restored = SandboxAutoTrader(gateway,store,lambda h:h==HEADER,clock=lambda:clock.at,monotonic=lambda:clock.mono)
    gateway.price = 24990
    restored.tick()
    assert len(gateway.requests)==1
    assert restored.snapshot()["monitoring"] is False
    restored.control("reconcile",HEADER,restored.snapshot()["id"],execution_allowed=True)
    restored.tick()
    assert len(gateway.requests)==2


def test_archive_is_permanent_even_with_stale_controls_and_keeps_daily_cap(setup):
    trader,gateway,clock,store,cfg = enter(setup)
    gateway.fill(25022)
    trader.tick()
    gateway.price,gateway.unknown = 24990,True
    trader.tick()
    ident = trader.snapshot()["id"]
    trader.control("archive",HEADER,ident,"已確認測試委託與部位")
    for command in ["pause","stop","reconcile"]:
        with pytest.raises(ValueError,match="已結束"):
            trader.control(command,HEADER,ident)
    trader.tick()
    assert len(gateway.requests)==2
    assert trader.snapshot()["manualResolved"]
    with pytest.raises(ValueError,match="本日已人工封存"):
        trader.start(cfg,HEADER)


def test_global_lock_blocks_exit_orders_until_explicitly_unlocked(setup):
    trader,gateway,clock,store,cfg = enter(setup)
    gateway.fill(25022)
    trader.tick()
    trader.heartbeat(HEADER,trader.snapshot()["id"],False,False)
    gateway.price = 24990
    trader.tick()
    assert len(gateway.requests)==1
    assert trader.snapshot()["position"] and trader.snapshot()["executionBlocked"]
    trader.heartbeat(HEADER,trader.snapshot()["id"],True,True)
    trader.tick()
    assert len(gateway.requests)==2


def test_future_plan_can_stop_immediately_without_waiting_for_trading_date(setup):
    trader,gateway,clock,store,cfg = setup
    cfg = cfg.model_copy(update={"trade_date":date(2026,11,16)})
    state = trader.start(cfg,HEADER)
    state = trader.control("stop",HEADER,state["id"])
    assert state["status"]=="stopped" and state["monitoring"] is False
    assert gateway.requests==[]


def test_confirmed_fill_remains_exposure_when_quote_fails_then_stop_exits(setup):
    trader,gateway,clock,store,cfg = enter(setup)
    gateway.fill(25022)
    quote = gateway.quote
    def unavailable(_):
        raise TimeoutError("quote unavailable")
    gateway.quote = unavailable
    trader.tick()
    assert trader.snapshot()["orders"][0]["filled"]==1
    assert trader.snapshot()["position"]["quantity"]==1
    gateway.quote = quote
    trader.control("stop",HEADER,trader.snapshot()["id"],execution_allowed=True)
    trader.tick()
    assert len(gateway.requests)==2
    assert trader.snapshot()["status"]!="stopped"


def test_old_or_queued_heartbeats_cannot_unlock_or_extend_control(setup):
    trader,gateway,clock,store,cfg = setup
    state = trader.start(cfg,HEADER)
    clock.mono = 2
    trader.heartbeat(HEADER,state["id"],False,False,received_at=2)
    with pytest.raises(ValueError,match="過期"):
        trader.heartbeat(HEADER,state["id"],True,True,received_at=1)
    assert trader.snapshot()["executionBlocked"]
    clock.mono = 20
    with pytest.raises(ValueError,match="過期"):
        trader.heartbeat(HEADER,state["id"],True,True,received_at=3)
    assert trader.snapshot()["leaseSeconds"]==0


def test_kill_request_interrupts_entry_while_quote_rpc_holds_state_lock(setup):
    trader,gateway,clock,store,cfg = setup
    state = trader.start(cfg,HEADER)
    clock.at += timedelta(minutes=1,seconds=1)
    entered,release = Event(),Event()
    quote = gateway.quote
    def slow_quote(contract):
        entered.set()
        assert release.wait(timeout=5)
        return quote(contract)
    gateway.quote = slow_quote
    with ThreadPoolExecutor(max_workers=2) as pool:
        tick = pool.submit(trader.tick)
        assert entered.wait(timeout=5)
        heartbeat = pool.submit(trader.heartbeat,HEADER,state["id"],False,False)
        try:
            assert trader.execution_blocked.wait(timeout=5)
        finally:
            release.set()
        tick.result(timeout=5)
        heartbeat.result(timeout=5)
    assert gateway.requests==[]


def test_older_in_progress_unlock_cannot_clear_newer_immediate_kill(setup):
    trader,gateway,clock,_,cfg = setup
    state = trader.start(cfg,HEADER)
    reached,release = Event(),Event()
    original = trader._execution_control
    def gated(allowed,received):
        if allowed and received==1:
            reached.set()
            assert release.wait(5)
        return original(allowed,received)
    trader._execution_control = gated
    clock.mono = 1
    with ThreadPoolExecutor(max_workers=2) as pool:
        older = pool.submit(trader.heartbeat,HEADER,state["id"],True,True,1)
        assert reached.wait(5)
        clock.mono = 2
        newer = pool.submit(trader.heartbeat,HEADER,state["id"],False,False,2)
        try:
            assert trader.execution_blocked.wait(5)
        finally:
            release.set()
        assert older.result(timeout=5)["executionBlocked"] is True
        assert newer.result(timeout=5)["executionBlocked"] is True
    assert trader.execution_blocked.is_set()
    assert gateway.requests==[]


def test_signal_requires_complete_closed_minutes_and_ignores_future(setup):
    trader,gateway,clock,store,cfg = setup
    decision = int(datetime(2026,11,13,9,20,tzinfo=TAIPEI).timestamp())
    assert opening_signal(gateway.candles,decision)["side"]=="Buy"
    gateway.candles[20]["high"] = 99999
    assert opening_signal(gateway.candles,decision)["high"]==25010
    assert opening_signal(gateway.candles[1:],decision)["side"] is None


@pytest.mark.parametrize("side,stock_change,expected", [
    ("Buy",1,"Buy"),("Buy",-1,None),("Sell",-1,"Sell"),("Sell",1,None),
])
def test_live_signal_cross_and_synchronized_basket_agree_in_both_directions(setup,side,stock_change,expected):
    _,gateway,_,_,_ = setup
    decision = gateway.candles[19]["time"]
    if side=="Sell":
        gateway.candles[19].update(open=24980,high=24990,low=24970,close=24980)
    stock = [dict(time=decision-300,close=100),dict(time=decision,close=100+stock_change)]
    basket = [dict(code="2330",weight=.4)]
    assert opening_signal(gateway.candles,decision)["side"]==side
    assert opening_signal(gateway.candles,decision,basket,{"2330":stock})["side"]==expected
    # A later stock price cannot replace the missing synchronous close.
    stock[-1]["time"] += 60
    assert opening_signal(gateway.candles,decision,basket,{"2330":stock})["side"] is None
    # Remaining outside the range is not a second crossing signal.
    gateway.candles[14]["close"] = gateway.candles[19]["close"]
    assert opening_signal(gateway.candles,decision)["side"] is None


def test_http_routes_require_passkey_session_and_non_sandbox_cannot_arm(tmp_path):
    app = create_app(Config(),passkey_store=PasskeyStore(tmp_path/"passkeys.db"),research_store=ResearchStore(tmp_path/"research.db"))
    with TestClient(app) as client:
        assert client.get('/api/v1/automation/state').status_code==401
        client.headers['Authorization'] = 'Bearer '+app.state.session.issue()
        assert client.get('/api/v1/automation/state').json()['available'] is False
        cfg = AutoConfig(account=ACCOUNT,contract_code='TMFK6',trade_date='2026-11-16')
        assert client.post('/api/v1/automation/start',json=cfg.model_dump(mode='json')).status_code==400
        assert not app.state.broker.paper.orders


def test_legacy_intent_keeps_limit_anchor_after_upgrade(setup):
    trader,gateway,clock,store,cfg = enter(setup)
    entry = trader.state['orders'][0]
    for key in ['anchorMode','stopPoints','targetPoints']:
        entry.pop(key, None)
    gateway.fill(25022)
    trader.tick()
    p=trader.snapshot()['position']
    assert (p['entryPrice'],p['referencePrice'],p['referenceType'],p['stop'],p['target'])==(25022,25023,'limit',24993,25083)


@pytest.mark.parametrize('price,limit_reason', [(25009,'開盤區間'),(25040,'偏離')])
def test_fresh_quote_must_still_validate_signal_before_intent(setup,price,limit_reason):
    trader,gateway,clock,store,cfg = setup
    trader.start(cfg,HEADER)
    clock.at = datetime(2026,11,13,9,20,1,tzinfo=TAIPEI)
    gateway.price=price
    trader.tick()
    state=trader.snapshot()
    assert gateway.requests==[] and state['entryCount']==0 and state['pending'] is None
    assert limit_reason in state['reason']
    assert store.events(state['id'])[0]['kind']=='signal_rejected'


def test_v2_freezes_wider_distances_and_anchors_confirmed_fill(setup):
    trader,gateway,clock,store,cfg=setup
    cfg=cfg.model_copy(update={'strategy_version':'orb_atr_v2','fee_per_side':12,'fee_source':'statement'})
    trader.start(cfg,HEADER)
    clock.at=datetime(2026,11,13,9,20,1,tzinfo=TAIPEI)
    trader.tick()
    entry=trader.snapshot()['orders'][0]
    assert entry['stopPoints']==33 and entry['targetPoints']==66 and entry['anchorMode']=='fill'
    assert entry['estimatedRisk'] < cfg.loss_limit
    gateway.fill(25022)
    trader.tick()
    p=trader.snapshot()['position']
    assert p['stop']==24989 and p['target']==25088 and p['referenceType']=='fill'
    gateway.candles[20]['high']=26000
    trader.tick()
    assert trader.snapshot()['position']['stop']==24989


def test_v2_missing_contiguous_atr_and_fee_inclusive_budget_do_not_create_intent(setup):
    trader,gateway,clock,store,cfg=setup
    cfg=cfg.model_copy(update={'strategy_version':'orb_atr_v2','loss_limit':350})
    trader.start(cfg,HEADER)
    clock.at=datetime(2026,11,13,9,20,1,tzinfo=TAIPEI)
    trader.tick()
    assert gateway.requests==[] and trader.snapshot()['entryCount']==0
    assert '預算' in trader.snapshot()['reason']
    # Simulate another new 5m crossing with a hole outside opening range/last10 bars.
    clock.at=datetime(2026,11,13,9,35,1,tzinfo=TAIPEI)
    gateway.candles[29]['close']=25000
    gateway.candles=[b for i,b in enumerate(gateway.candles) if i!=16]
    trader.tick()
    assert gateway.requests==[]
    assert 'ATR14' in trader.snapshot()['reason'] and trader.snapshot()['entryCount']==0
