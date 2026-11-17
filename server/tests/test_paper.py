from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from copy import deepcopy
from datetime import datetime, timedelta
from types import SimpleNamespace as NS

import pytest

from fubon_bridge.auto_gateway import PaperGateway
from fubon_bridge.auto_store import AutoStore
from fubon_bridge.auto_trading import AutoConfig, SandboxAutoTrader
from fubon_bridge.broker import Broker
from fubon_bridge.config import Config
from fubon_bridge.mapping import TAIPEI
from fubon_bridge.models import PaperCost
from fubon_bridge.paper import PaperBook
from fubon_bridge.paper_store import PaperStore
from fubon_bridge.research import ResearchStore

MANUAL = dict(account_type='F',broker_id='LOCAL',account_id='PAPER-F')
AUTO = dict(account_type='F',broker_id='LOCAL',account_id='PAPER-AUTO-F')
CONTRACT = dict(code='TMFK6',security_type='FUT',multiplier=10,delivery_date='2026-11-18',limit_up=50000,limit_down=1)
COST = dict(fee_per_side=12,tax_rate=.00002,fee_source='statement')


def at(hour=9,minute=20,day=13):
    return datetime(2026,11,day,hour,minute,tzinfo=TAIPEI)


def order(action='Buy',price=0,quantity=1,**kw):
    value=dict(action=action,price=price,quantity=quantity,price_type='MKT' if not price else 'LMT',order_type='IOC' if not price else 'ROD',octype='Auto')
    return dict(value,**kw)


def quote(clock,price=25000):
    return dict(datetime=clock.at.isoformat(),close=price,buy_price=price,sell_price=price)


def make_book(tmp_path):
    clock=NS(at=at())
    store=PaperStore(ResearchStore(tmp_path/'paper.db'))
    events=[]
    book=PaperBook(lambda *x:events.append(x),store,costs=True,clock=lambda:clock.at)
    return book,store,clock,events


def test_fills_costs_restart_and_no_duplicate_charges(tmp_path):
    book,store,clock,events=make_book(tmp_path)
    buy=book.place(CONTRACT,order(),MANUAL,quote(clock),cost=COST)
    assert buy['paper']['fee']==12 and buy['paper']['tax']==5
    restarted=PaperBook(lambda *_:None,store,costs=True,clock=lambda:clock.at)
    assert restarted.overview()['positions'][0]['signed_qty']==1
    assert restarted.overview()['realizedNet']==-17
    close=restarted.place(CONTRACT,order('Sell',octype='Cover'),MANUAL,quote(clock,25010),cost=COST)
    assert close['paper']['realizedGross']==100
    for _ in range(3):
        restarted.tick(CONTRACT['code'],quote(clock,25010))
    total=book.overview()
    assert (total['realizedGross'],total['fee'],total['tax'],total['realizedNet'])==(100,24,10,66)
    assert not total['positions'] and len(total['orders'])==2
    assert len(events)==1  # One post-commit projection notification for the first order/fill.


def test_rounds_tax_per_contract_and_short_reversal(tmp_path):
    book,store,clock,_=make_book(tmp_path)
    trade=book.place(CONTRACT,order('Sell',quantity=2),MANUAL,quote(clock,27500),cost=COST)
    assert trade['paper']['tax']==12  # 5.5 => 6 per contract, not aggregate 11.
    book.place(CONTRACT,order('Buy',quantity=3),MANUAL,quote(clock,27490),cost=COST)
    total=book.overview()
    assert total['realizedGross']==200
    assert total['positions'][0]['signed_qty']==1
    assert total['positions'][0]['price']==27490


def test_cancel_modify_fee_snapshot_and_session_expiry(tmp_path):
    book,store,clock,_=make_book(tmp_path)
    pending=book.place(CONTRACT,order(price=24900,quantity=2),MANUAL,quote(clock),cost=COST)
    ident=pending['order']['id']
    restarted=PaperBook(lambda *_:None,store,costs=True,clock=lambda:clock.at)
    restarted.update(ident,'quantity',1,quote(clock))
    fill=restarted.update(ident,'price',25000,quote(clock))
    assert fill['paper']['cost']['fee_per_side']==12
    assert fill['paper']['fee']==12 and fill['status']['deal_quantity']==1
    p=book.place(CONTRACT,order(price=24900),MANUAL,quote(clock),cost=COST)
    book.cancel(p['order']['id'])
    assert book.orders[p['order']['id']]['paper']['fee']==0
    old=book.place(CONTRACT,order(price=24900),MANUAL,quote(clock),cost=COST)
    clock.at+=timedelta(days=3)
    restarted.tick(CONTRACT['code'],quote(clock,24900))
    assert restarted.orders[old['order']['id']]['status']['status']=='Cancelled'
    assert restarted.orders[old['order']['id']]['paper']['fee']==0
    assert book.overview(day=clock.at.date().isoformat())['realizedNet']==0
    assert book.overview()['realizedNet']==-17


def test_transactions_do_not_lose_other_process_orders_or_tag_idempotency(tmp_path):
    book,store,clock,_=make_book(tmp_path)
    other=PaperBook(lambda *_:None,PaperStore(ResearchStore(tmp_path/'paper.db')),costs=True,clock=lambda:clock.at)
    def buy(i):
        return (book if i%2 else other).place(CONTRACT,order(),MANUAL,quote(clock),cost=COST)
    with ThreadPoolExecutor(max_workers=4) as pool:
        list(pool.map(buy,range(12)))
    assert len(book.overview()['orders'])==12
    assert book.overview()['positions'][0]['signed_qty']==12
    first=book.place(CONTRACT,order(),AUTO,quote(clock),cost=COST,strategy_tag='FA12345678')
    assert other.place(CONTRACT,order(),AUTO,quote(clock),cost=dict(COST,fee_per_side=99),strategy_tag='FA12345678')['order']['id']==first['order']['id']
    with pytest.raises(ValueError,match='識別碼'):
        other.place(CONTRACT,order('Sell'),AUTO,quote(clock),cost=COST,strategy_tag='FA12345678')
    assert book.overview(AUTO['account_id'])['fee']==12
    with store.research.connect() as db:
        assert db.execute('select count(*) from paper_tags').fetchone()[0]==1


def test_commit_failure_rolls_back_fill_position_and_notifications(tmp_path):
    book,store,clock,events=make_book(tmp_path)
    actual=store.transaction
    @contextmanager
    def fail():
        with actual() as state:
            yield state
            raise OSError('simulated disk failure')
    store.transaction=fail
    with pytest.raises(OSError):
        book.place(CONTRACT,order(),MANUAL,quote(clock),cost=COST)
    assert not book.orders and not book.positions and not events
    store.transaction=actual
    assert store.read()['orders']=={}


def test_fee_validation_rejects_nonfinite_and_unknown_fields():
    for value in [dict(fee_per_side=-1),dict(fee_per_side=float('nan')),dict(tax_rate=float('inf')),dict(ignored=True)]:
        with pytest.raises(ValueError):
            PaperCost.model_validate(value)


def paper_trader(tmp_path):
    clock=NS(at=at(9,19),mono=0,price=25020)
    research=ResearchStore(tmp_path/'paper.db')
    broker=Broker(Config(mode='paper', session='regular'),paper_store=PaperStore(research))
    broker.sdk=NS()  # Truthy sentinel; every execution must stay in PaperBook.
    broker.paper.clock=lambda:clock.at
    broker.connected_sockets.add('futopt')
    broker.contract=lambda *a,**kw:deepcopy(CONTRACT)
    broker.subscribe=lambda *a:None
    broker.quote=lambda *_:dict(quote(clock,clock.price),buy_price=clock.price-1,sell_price=clock.price+1)
    start=at(9,0).timestamp()
    bars=[dict(time=int(start+(i+1)*60),open=25000 if i<19 else 25020,high=25010 if i<19 else 25030,low=24990,close=25000 if i<19 else 25020,volume=10) for i in range(260)]
    broker.kbars=lambda *_:dict(datetime=[datetime.fromtimestamp(b['time'],TAIPEI).isoformat() for b in bars],**{col:[b[key] for b in bars] for key,col in [('open','Open'),('high','High'),('low','Low'),('close','Close'),('volume','Volume')]})
    store=AutoStore(research,'paper')
    trader=SandboxAutoTrader(PaperGateway(broker),store,lambda h:h=='owner',clock=lambda:clock.at,monotonic=lambda:clock.mono)
    cfg=AutoConfig(account=AUTO,contract_code='TMFK6',trade_date='2026-11-13',fee_per_side=12,fee_source='statement')
    return trader,broker,clock,store,cfg


def test_paper_auto_real_book_entry_exit_net_and_restart(tmp_path):
    trader,broker,clock,store,cfg=paper_trader(tmp_path)
    trader.start(cfg,'owner')
    clock.at=at(9,20)
    trader.tick(); trader.tick()
    state=trader.snapshot()
    assert state['position']['entryPrice']==25021
    assert broker.paper.overview()['positions'][0]['signed_qty']==1
    clock.price=25090
    trader.tick(); trader.tick()
    assert trader.snapshot()['position'] is None
    assert trader.snapshot()['realizedNet']==646
    assert broker.paper.overview(AUTO['account_id'])['realizedNet']==646
    trader.shutdown()
    restarted=SandboxAutoTrader(PaperGateway(broker),store,lambda h:h=='owner',clock=lambda:clock.at,monotonic=lambda:clock.mono)
    assert restarted.snapshot()['status']=='paused' and not restarted.snapshot()['monitoring']
    restarted.tick()
    assert len(broker.paper.overview()['orders'])==2


def test_manual_and_strategy_accounts_are_enforced_in_broker(tmp_path):
    trader,broker,clock,store,cfg=paper_trader(tmp_path)
    with pytest.raises(ValueError,match='策略專用'):
        broker.place(CONTRACT,order(),broker.account(AUTO))
    with pytest.raises(ValueError,match='策略專用'):
        broker.place(CONTRACT,dict(order(),custom_field='FA12345678'),broker.account(AUTO))
    trader.start(cfg,'owner'); clock.at=at(9,20); trader.tick(); trader.tick()
    ident=broker.paper.overview()['orders'][0]['order']['id']
    with pytest.raises(ValueError,match='策略專用'):
        broker.mutate(ident,'cancel')
    broker.place(CONTRACT,order('Sell'),broker.account(MANUAL),paper_cost=COST)
    assert broker.paper.overview(AUTO['account_id'])['positions'][0]['signed_qty']==1
    assert broker.paper.overview(MANUAL['account_id'])['positions'][0]['signed_qty']==-1
    assert broker.config.broker_orders is False
    trader.shutdown()


def test_auto_modes_migrate_legacy_rows_without_cross_loading(tmp_path):
    research=ResearchStore(tmp_path/'paper.db')
    with research.connect() as db:
        db.execute('insert into research_auto_runs values(?,?,?,?,?)',('legacy','2026-11-13','{}','2026-11-13','{"id":"legacy"}'))
    sandbox,paper=AutoStore(research,'sandbox'),AutoStore(research,'paper')
    assert sandbox.latest()['id']=='legacy' and paper.latest() is None
    state=dict(id='paper',config=dict(account={},trade_date='2026-11-13'))
    paper.save(state)
    assert paper.latest()['id']=='paper' and sandbox.latest()['id']=='legacy'
    assert paper.for_day({},'2026-11-13')['id']=='paper'
    sandbox.claim('sandbox')
    with pytest.raises(ValueError): paper.claim('paper')
    sandbox.release('sandbox'); paper.claim('paper'); paper.release('paper')


def test_cross_day_paper_recovery_keeps_run_identity_and_actual_cash_day(tmp_path):
    trader,broker,clock,store,cfg=paper_trader(tmp_path)
    trader.start(cfg,'owner'); clock.at=at(9,20); trader.tick(); trader.tick()
    clock.at=at(9,20,16); clock.price=25090
    trader.tick()
    assert trader.snapshot()['status']=='attention'
    with pytest.raises(ValueError,match='不能封存'):
        trader.control('archive','owner',trader.state['id'],'已確認測試委託與部位')
    # Even an old archived state must not let a new day absorb its book position.
    new=cfg.model_copy(update={'trade_date':clock.at.date()})
    with pytest.raises(ValueError,match='其他日期'):
        trader.gateway.prepare(new.model_dump(mode='json'))
    for allowed,ack in [(False,'確認退出 paper 策略部位'),(True,'')]:
        with pytest.raises(ValueError,match='解除風控鎖'):
            trader.control('flatten','owner',trader.state['id'],ack,execution_allowed=allowed)
    closed=trader.control('flatten','owner',trader.state['id'],'確認退出 paper 策略部位',execution_allowed=True)
    assert closed['status']=='stopped' and closed['position'] is None and not closed['monitoring']
    assert closed['realizedNet']==646
    total=broker.paper.overview(AUTO['account_id'])
    assert not total['positions'] and total['realizedNet']==646
    assert total['orders'][-1]['paper']['strategyDay']=='2026-11-13'
    assert total['orders'][-1]['paper']['filledDay']=='2026-11-16'
    daily=broker.paper.overview(AUTO['account_id'],'2026-11-16')
    assert daily['realizedNet']==663 and daily['fee']==12 and daily['tax']==5
    trader.gateway.prepare(new.model_dump(mode='json'))


def test_paper_recovery_never_uses_an_expired_contract_or_stale_quote(tmp_path):
    trader,broker,clock,store,cfg=paper_trader(tmp_path)
    trader.start(cfg,'owner'); clock.at=at(9,20); trader.tick(); trader.tick()
    clock.at=at(9,20,16)
    q=broker.quote
    broker.quote=lambda contract:dict(q(contract),datetime=at(9,19,16).isoformat())
    with pytest.raises(ValueError,match='送單前'):
        trader.control('flatten','owner',trader.state['id'],'確認退出 paper 策略部位',execution_allowed=True)
    assert len(broker.paper.overview()['orders'])==1
    broker.quote=q
    clock.at=at(9,20,19)
    with pytest.raises(ValueError,match='已到期'):
        trader.control('flatten','owner',trader.state['id'],'確認退出 paper 策略部位',execution_allowed=True)
    assert len(broker.paper.overview()['orders'])==1
    assert not trader.snapshot()['monitoring']


def test_auto_store_construction_and_demo_app_do_not_initialize_research(tmp_path):
    research=ResearchStore(tmp_path/'untouched.db')
    AutoStore(research,'paper')
    assert not research.path.exists()
    from fubon_bridge.app import create_app
    from fubon_bridge.passkeys import PasskeyStore
    create_app(Config(),research_store=research,passkey_store=PasskeyStore(tmp_path/'keys.db'))
    assert not research.path.exists()


def test_notification_failure_does_not_fail_a_committed_fill(tmp_path):
    book,store,clock,_=make_book(tmp_path)
    def broken(*_): raise RuntimeError('notification unavailable')
    book.emit=broken
    trade=book.place(CONTRACT,order(),MANUAL,quote(clock),cost=COST)
    assert trade['status']['status']=='Filled'
    assert len(store.read()['orders'])==1
