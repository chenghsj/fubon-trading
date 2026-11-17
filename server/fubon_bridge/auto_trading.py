"""Single-day, single-lot TMF automation for paper and the official sandbox.

The worker owns execution. Browser heartbeats permit new entries, not exit monitoring.
Every intent is durable before its one SDK submission; uncertain outcomes are queried.
"""
from copy import deepcopy
from datetime import date, datetime, timedelta
import math
import threading
import time
import uuid
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from .mapping import TAIPEI, now
from .research import BasketMember
from .intraday_strategy import opening_signal, entry_plan, futures_tax
from .strategy_session import StrategySession, schedule, window, opening_date, entry_window, market_session


class AutoAccount(BaseModel):
    model_config = ConfigDict(extra="forbid")
    account_type: str = Field(pattern="^F$")
    broker_id: str = Field(min_length=1, max_length=30)
    account_id: str = Field(min_length=1, max_length=30)


class AutoConfig(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    account: AutoAccount
    contract_code: str = Field(pattern=r"^TMF[A-L]\d$")
    trade_date: date
    stop_points: int = Field(default=30, ge=1, le=1000)
    target_points: int = Field(default=60, ge=1, le=2000)
    slippage_points: int = Field(default=2, ge=0, le=10)
    max_entries: int = Field(default=2, ge=1, le=2)
    loss_limit: float = Field(default=1000, ge=10, le=100000)
    fee_per_side: float = Field(default=20, ge=0, le=1000)
    fee_source: Literal['assumed','statement'] = 'assumed'
    tax_rate: float = Field(default=.00002, ge=0, le=.01)
    use_basket: bool = False
    strategy_version: Literal['orb_v1','orb_atr_v2'] = 'orb_v1'
    model_run_id: str | None = Field(default=None, pattern=r'^[a-f0-9]{64}$')
    strategy_session: StrategySession = 'cash'
    decision_minutes: Literal[1,5] = 5
    basket: list[BasketMember] = Field(default_factory=lambda:[BasketMember(code="2330",weight=.4),BasketMember(code="2454",weight=.04),BasketMember(code="2317",weight=.02),BasketMember(code="2881",weight=.01)], min_length=1, max_length=12)

    @model_validator(mode="after")
    def valid_basket(self):
        if self.decision_minutes != 5 and not self.model_run_id:
            raise ValueError('1分鐘判斷須使用相符的多週期模型')
        if self.strategy_session != 'cash' and self.use_basket:
            raise ValueError('完整期貨日盤與夜盤不使用同步現貨籃子')
        if self.model_run_id and (self.strategy_version != 'orb_atr_v2' or self.use_basket):
            raise ValueError('LightGBM 濾網須使用 V2 並關閉權值股方向濾網')
        if len({m.code for m in self.basket}) != len(self.basket) or sum(m.weight for m in self.basket)>1.000001:
            raise ValueError("股票不可重複，權重合計不可超過 100%")
        return self


def empty_state():
    return dict(id=None, status="idle", reason="設定單次日盤或夜盤策略後啟動", config=None, contract=None,
        entryCount=0, usedSides=[], lastDecision=0, lastSignal=None, orders=[], pending=None,
        position=None, quote=None, realizedNet=0, unrealizedNet=None, exitRequested=False,
        exitReason="", updatedAt=None, manualResolved=False,executionBlocked=False)


class SandboxAutoTrader:
    def __init__(self, gateway, store, authorize, clock=now, monotonic=time.monotonic):
        self.gateway, self.store, self.authorize = gateway, store, authorize
        self.clock, self.monotonic = clock, monotonic
        self.lock = threading.RLock()
        self.closing = threading.Event()
        self.writer = uuid.uuid4().hex
        self.owner = None
        self.lease_until = 0
        self.monitoring = False
        self.execution_blocked = threading.Event()
        self.admission_lock = threading.Lock()
        self.last_execution_block_received = float('-inf')
        self.entries_blocked = threading.Event()
        self.last_heartbeat_received = float('-inf')
        self.load_error = False
        self.entry_filter = None
        try:
            self.state = (store.latest() if gateway.mode in {"sandbox","paper"} else None) or empty_state()
            if self.state["id"]:
                self.state["config"] = AutoConfig.model_validate(self.state["config"]).model_dump(mode="json")
                assert isinstance(self.state["orders"],list)
                if self.state.get("executionBlocked"):
                    self.execution_blocked.set()
                if self.state["status"] in {"running","stopping","paused","attention"}:
                    self.state["status"] = "attention" if self.state["pending"] or self.state["position"] else "paused"
                    self.state["reason"] = "服務已重啟；請重新對帳或手動恢復，不會自動進場"
        except (ValueError, KeyError, AssertionError, TypeError):
            self.state = dict(empty_state(),status="attention",reason="策略紀錄無法讀取，請先人工核對測試委託與部位")
            self.load_error = True

    def snapshot(self, header=""):
        with self.lock:
            result = deepcopy(self.state)
            result["executionBlocked"] = self.execution_blocked.is_set() or result.get("executionBlocked",False)
            result.update(mode=self.gateway.mode,available=self.gateway.mode in {"sandbox","paper"} and not self.load_error,
                monitoring=self.monitoring,
                owned=bool(self.owner and self.owner==header), leaseSeconds=max(0,round(self.lease_until-self.monotonic())),
                events=self.store.events(self.state["id"]) if self.state["id"] else [])
            return result

    def _save(self, message=None, kind="state"):
        self.state["updatedAt"] = self.clock().isoformat()
        if self.state["id"]:
            self.store.save(self.state,kind,message)

    def _assert_mode(self):
        if self.gateway.mode not in {"sandbox","paper"} or self.closing.is_set() or self.load_error:
            raise ValueError("自動交易僅支援 sandbox 或 paper；目前不可啟動")

    def start(self, config, header):
        with self.lock:
            self._assert_mode()
            if not self.authorize(header):
                raise ValueError("工作階段已鎖定，請重新解鎖")
            cfg = config.model_dump(mode="json")
            at = self.clock()
            day = config.trade_date
            session_start, session_end = window(cfg)
            if session_end <= at or day>at.date()+timedelta(days=7) or day.weekday()>=5:
                raise ValueError("請選擇今天至未來 7 天內的平日；休市日將不產生委託")
            if at >= session_start+timedelta(minutes=schedule(cfg['strategy_session']).last_entry):
                raise ValueError("已過此盤別新進場截止時間，請選擇下一個開盤日")
            if cfg['strategy_session'] == 'afterhours' and self.gateway.mode != 'paper':
                raise ValueError('夜盤自動交易僅供 Paper 本機模擬')
            if self.state["id"] and not self.state.get("manualResolved"):
                self._rebuild()
            if self.state["status"] in {"running","stopping"} or self.state["pending"] or self.state["position"]:
                raise ValueError("已有執行中策略或未確認曝險；請先暫停、對帳與退出")
            self.store.claim(self.writer)
            prior_state = deepcopy(self.state)
            prior_control = self.monitoring,self.owner,self.lease_until,self.last_heartbeat_received
            prior_filter = self.entry_filter
            try:
                previous = self.store.for_day(cfg["account"],cfg["trade_date"],cfg['strategy_session'])
                if previous:
                    previous['config']=AutoConfig.model_validate(previous['config']).model_dump(mode='json')
                if previous and previous.get("manualResolved"):
                    raise ValueError("本日已人工封存，不再重新啟動；請選擇下一交易日")
                if previous and previous["entryCount"] and previous["config"]!=cfg:
                    raise ValueError("本日已有進場意圖，設定已固定；請沿用原設定恢復")
                if previous and (previous["pending"] or previous["position"]):
                    raise ValueError("本日仍有未確認委託或曝險，請先重新對帳")
                if previous and sum(o["filled"]*(1 if o["action"]=="Buy" else -1) for o in previous["orders"]):
                    raise ValueError("本日成交紀錄仍有曝險，請先重新對帳")
                entry_filter = None
                if cfg.get('model_run_id'):
                    from .learning_inference import EntryFilter
                    from .learning_store import LearningStore
                    entry_filter = EntryFilter(LearningStore(self.store.research), cfg['model_run_id'], cfg)
                contract = self.gateway.prepare(cfg)
                self.state = previous or empty_state()
                self.state.update(id=self.state["id"] or uuid.uuid4().hex,config=cfg,contract=contract,
                    status="running",reason=f"等待啟動後新完成的 {cfg['decision_minutes']} 分訊號",lastDecision=int(at.timestamp())//(cfg['decision_minutes']*60)*(cfg['decision_minutes']*60))
                self.owner, self.lease_until = header,self.monotonic()+15
                self.last_heartbeat_received = self.monotonic()
                self.entries_blocked.clear()
                self.monitoring = True
                self.entry_filter = entry_filter
                self._save(f"啟動 {self.gateway.mode} 策略；不追補啟動前訊號","control")
                return self.snapshot(header)
            except Exception:
                self.state = prior_state
                self.entry_filter = prior_filter
                self.monitoring,self.owner,self.lease_until,self.last_heartbeat_received = prior_control
                if not self.monitoring:
                    self.store.release(self.writer)
                raise

    def _execution_control(self, allowed, received):
        # This short gate never waits for the state lock or brokerage RPCs.
        # An older unlock must not erase a kill that arrived while it was processing.
        with self.admission_lock:
            if not allowed:
                self.last_execution_block_received = max(self.last_execution_block_received,received)
                self.execution_blocked.set()
            elif received>=self.last_execution_block_received:
                self.execution_blocked.clear()
            return self.execution_blocked.is_set()

    def heartbeat(self, header, run_id, entries_allowed, execution_allowed=True, received_at=None):
        received = self.monotonic() if received_at is None else received_at
        # A lock request must interrupt entry admission even while a quote RPC owns the state lock.
        if (header==self.owner and run_id==self.state["id"] and self.authorize(header)
            and received>=self.last_heartbeat_received and self.monotonic()-received<=5):
            if not execution_allowed:
                self._execution_control(False,received)
            if not entries_allowed or not execution_allowed:
                self.entries_blocked.set()
        with self.lock:
            if header!=self.owner or run_id!=self.state["id"] or not self.authorize(header):
                raise ValueError("此分頁不是目前策略的控制者")
            if received<self.last_heartbeat_received or not -1<=self.monotonic()-received<=5:
                raise ValueError("控制心跳已過期，不能延長新倉控制權")
            self.last_heartbeat_received = received
            self.lease_until = received+15
            self.state["executionBlocked"] = self._execution_control(execution_allowed,received)
            entries_allowed = entries_allowed and not self.state["executionBlocked"]
            if not entries_allowed and self.state["status"]=="running":
                self.state.update(status="paused",reason="風控鎖定，所有自動送單暫停；既有曝險需留意人工處理" if self.state["executionBlocked"] else "風控限制，已暫停新倉")
                self._save(self.state["reason"],"control")
            return self.snapshot(header)

    def control(self, command, header, run_id, acknowledgement="", execution_allowed=False):
        received = self.monotonic()
        if command in {"pause","stop","flatten"} and run_id==self.state["id"] and self.authorize(header):
            self.entries_blocked.set()
        with self.lock:
            self._assert_mode()
            if not self.state["id"] or run_id!=self.state["id"]:
                raise ValueError("策略版本已變更，請重新整理")
            if not self.authorize(header):
                raise ValueError("工作階段已鎖定")
            if command=='flatten':
                return self._flatten_paper(header,acknowledgement,execution_allowed,received)
            if self.state.get("manualResolved") or self.state["status"] in {"idle","stopped","completed","archived"}:
                raise ValueError("本次策略已結束，不能重新開啟舊控制指令；請建立新的交易日設定")
            self.store.claim(self.writer)
            self._rebuild()
            if command=="pause":
                if self.state["status"] not in {"attention","stopping"}:
                    self.state.update(status="paused",reason="已暫停新倉；既有曝險仍監控退出" if self.monitoring else "新倉已暫停；請先重新對帳接管監控")
            elif command=="stop":
                self.gateway.prepare(self.state["config"])
                self.monitoring = True
                self.owner,self.lease_until = header,self.monotonic()+15
                self.last_heartbeat_received = self.monotonic()
                self.state["executionBlocked"] = self._execution_control(execution_allowed,received)
                self.state.update(status="stopping",exitRequested=True,exitReason="使用者停止並退出",reason="停止新倉，等待確認委託與退出本策略曝險")
                if not self.state["pending"] and not self.state["position"]:
                    self.state.update(status="stopped",reason="已停止；沒有待確認委託或追蹤曝險")
                    self.monitoring,self.owner,self.lease_until = False,None,0
                    self.store.release(self.writer)
            elif command=="reconcile":
                self.gateway.prepare(self.state["config"])
                self.monitoring = True
                self.state["executionBlocked"] = self._execution_control(execution_allowed,received)
                self.owner,self.lease_until = header,self.monotonic()+15
                self.last_heartbeat_received = self.monotonic()
                self.entries_blocked.set()
                self.state.update(status="paused",reason="重新對帳；新倉維持暫停，恢復退出監控")
                self._reconcile()
                self._rebuild()
            elif command=="archive":
                if self.state["status"]!="attention" or acknowledgement!="已確認測試委託與部位":
                    raise ValueError("請先人工確認測試委託與部位，再輸入完整確認文字")
                if self.gateway.mode=='paper':
                    self.gateway.assert_flat(self.state['config'])
                self.state.update(status="archived",manualResolved=True,pending=None,position=None,
                    reason="已由使用者人工確認並封存；此動作沒有撤單或平倉")
                self.owner = None
                self.monitoring = False
                self.store.release(self.writer)
            else:
                raise ValueError("未知控制指令")
            self._save(self.state["reason"],"control")
            return self.snapshot(header)

    def _flatten_paper(self, header, acknowledgement, execution_allowed, received):
        if self.gateway.mode!='paper' or acknowledgement!='確認退出 paper 策略部位' or not execution_allowed:
            raise ValueError('請解除風控鎖並確認退出 paper 策略部位；此操作不適用券商環境')
        cfg, at = self.state['config'],self.clock()
        self.store.claim(self.writer)
        try:
            self._reconcile()
            self._rebuild()
            contract=self.gateway.prepare(cfg)
            if contract['delivery_date']<at.date().isoformat():
                raise ValueError('原合約已到期，無法以其他月份行情代替退出')
            self.state['contract']=contract
            self.state['quote']=self.gateway.quote(contract)
            self._rebuild()
            if self.state['pending']:
                raise ValueError('仍有待確認委託，不重送退出')
            if self.state['position']:
                self.state['executionBlocked']=self._execution_control(True,received)
                self.state.update(status='stopping',manualResolved=False,exitRequested=True)
                self.monitoring=True
                self._send('Sell' if self.state['position']['side']=='Buy' else 'Buy','exit','使用者確認退出保存的 paper 部位',recovery=True)
                self._reconcile()
                self._rebuild()
            self.gateway.assert_flat(cfg)
            self.state.update(status='stopped',reason='保存的 paper 策略部位已確認退出，未恢復新倉')
            self._save(self.state['reason'],'control')
        except Exception:
            self.state.update(status='attention',reason='Paper 部位退出未完成；保留紀錄，不自動重送，請確認原合約新鮮行情與委託')
            self._save(self.state['reason'],'error')
            raise
        finally:
            self.monitoring,self.owner,self.lease_until=False,None,0
            self.store.release(self.writer)
        return self.snapshot(header)

    def _valid_quote(self, day=None):
        q = self.state["quote"]
        if not q or q.get("trial") or not all(math.isfinite(q.get(k,0)) and q.get(k,0)>0 for k in ("price","bid","ask")):
            return False
        if q["bid"]>q["ask"]:
            return False
        age = self.clock().timestamp()-q["time"]
        cfg = self.state['config']
        start, end = window(dict(cfg, trade_date=day or cfg['trade_date']))
        return -2<=age<=15 and start.timestamp() <= q['time'] < end.timestamp()

    def _owned_trade(self, trade, order):
        cfg = self.state["config"]
        value = trade["order"]
        return (trade.get("automation_day")==cfg["trade_date"].replace("-","")
            and value.get("custom_field")==order["tag"] and value.get("action")==order["action"]
            and trade["contract"]["code"]==cfg["contract_code"] and value.get("quantity")==1
            and all(value["account"].get(k)==v for k,v in cfg["account"].items())
            and value.get("price_type")=="LMT" and value.get("order_type")=="IOC"
            and value.get("octype")==("New" if order["role"]=="entry" else "Cover"))

    def _reconcile(self):
        orders = self.state["orders"]
        needed = [o for o in orders if o["tag"]==self.state["pending"] or o["filled"] and o["fillPrice"] is None]
        if not needed:
            return
        trades = self.gateway.orders(self.state["config"])
        for order in needed:
            matches = [t for t in trades if t["order"].get("custom_field")==order["tag"]]
            if not matches:
                self.state.update(status="attention",reason="券商尚未確認本策略委託；保留未知狀態，不重送")
                continue
            if len(matches)!=1 or not self._owned_trade(matches[0],order):
                raise ValueError("策略委託識別或內容不一致")
            trade = matches[0]
            filled = trade["status"]["deal_quantity"]
            status = trade["status"]["status"]
            if filled not in {0,1} or filled<order["filled"] or status=="Filled" and filled!=1 or status=="Failed" and filled:
                raise ValueError("策略成交數量或狀態不一致")
            order.update(orderId=trade["order"]["id"],filled=int(filled),status=status)
            if filled and order["fillPrice"] is None:
                try:
                    price = self.gateway.fill_price(self.state["config"],trade)
                    if not math.isfinite(price) or price<=0 or not float(price).is_integer():
                        raise ValueError("無效成交價")
                    order["fillPrice"] = price
                except Exception:
                    self.state["reason"] = "成交價尚未對齊；損益未知，不新增曝險，退出仍按進場限價監控"
            terminal = filled==1 or status in {"Cancelled","Failed"}
            if order["tag"]==self.state["pending"]:
                if terminal:
                    self.state["pending"] = None
                    self._save(f"{order['tag']} 已確認：{status}，成交 {filled} 口","order")
                elif (self.clock().timestamp()-order["submittedAt"]>=10 or self.state["status"]=="stopping") and not order["cancelRequested"]:
                    order["cancelRequested"] = True
                    self._save(f"{order['tag']} 請求取消未完成餘量；結果仍須對帳","order")
                    self.store.claim(self.writer)
                    self.gateway.cancel(order["orderId"],order["tag"])

    def _rebuild(self):
        cfg = self.state["config"]
        entry, realized, known = None,0.0,True
        for order in self.state["orders"]:
            if not order["filled"]:
                continue
            if order["role"]=="entry":
                if entry:
                    raise ValueError("策略曝險超過一口，請人工處理")
                entry = order
            else:
                if not entry or order["action"]==entry["action"] or order["entryTag"]!=entry["tag"]:
                    raise ValueError("退出成交與策略進場不一致")
                if entry["fillPrice"] is None or order["fillPrice"] is None:
                    known = False
                else:
                    a,b = entry["fillPrice"],order["fillPrice"]
                    realized += (b-a)*(1 if entry["action"]=="Buy" else -1)*10 - cfg["fee_per_side"]*2 - (futures_tax(a,10,cfg["tax_rate"])+futures_tax(b,10,cfg["tax_rate"]))
                entry = None
        self.state["realizedNet"] = realized if known else None
        self.state["unrealizedNet"] = None
        if entry:
            side = 1 if entry["action"]=="Buy" else -1
            anchor = entry['fillPrice'] if entry.get('anchorMode')=='fill' and entry['fillPrice'] is not None else entry['limit']
            self.state["position"] = dict(entryTag=entry["tag"],side=entry["action"],quantity=1,
                entryPrice=entry["fillPrice"],referencePrice=anchor,
                stop=anchor-side*entry.get('stopPoints',cfg['stop_points']),target=anchor+side*entry.get('targetPoints',cfg['target_points']),
                referenceType='fill' if entry.get('anchorMode')=='fill' and entry['fillPrice'] is not None else 'limit')
            if entry.get('exitDeadline') is not None:
                self.state['position']['exitDeadline'] = entry['exitDeadline']
            if entry["fillPrice"] is not None and self._valid_quote():
                price = self.state["quote"]["price"]
                self.state["unrealizedNet"] = (price-entry["fillPrice"])*side*10-cfg["fee_per_side"]*2-(futures_tax(price,10,cfg["tax_rate"])+futures_tax(entry["fillPrice"],10,cfg["tax_rate"]))
        else:
            self.state["position"] = None
            if not self.state["pending"]:
                self.state["exitRequested"] = False

    def _send(self, action, role, reason, *, recovery=False):
        self._assert_mode()
        if recovery and (self.gateway.mode!='paper' or role!='exit'):
            raise ValueError('手動恢復僅供 paper 退出')
        if not self.monitoring or self.state.get("manualResolved"):
            raise ValueError("尚未人工接管監控，不可建立委託")
        cfg, at = self.state["config"],self.clock()
        day=opening_date(at.timestamp(),cfg['strategy_session']) if recovery else cfg['trade_date']
        start, end = window(dict(cfg,trade_date=day))
        if not start<=at<end or day<cfg['trade_date'] or not self._valid_quote(day) or self.state["pending"]:
            raise ValueError("送單前日期、行情或待確認狀態不符")
        if role=="entry" and (self.state["status"]!="running" or not self.owner or not self.authorize(self.owner) or self.monotonic()>self.lease_until or not entry_window(cfg,at)):
            raise ValueError("新倉控制權或交易時段已失效")
        if role=="entry" and self.entries_blocked.is_set():
            self.state.update(status="paused",reason="已收到停止新倉控制，不建立委託")
            self._save(self.state["reason"],"blocked")
            return
        if self.execution_blocked.is_set() or self.state.get("executionBlocked") or not self.gateway.execution_ready():
            self.state.update(status="attention",reason="風控鎖定或行情串流中斷，退出受阻；不送出委託，請人工確認" if role=="exit" else "風控鎖定或行情串流中斷，已阻擋進場")
            self._save(self.state["reason"],"blocked")
            return
        self.store.claim(self.writer)
        q = self.state["quote"]
        price = q["ask"]+cfg["slippage_points"] if action=="Buy" else q["bid"]-cfg["slippage_points"]
        limit = math.ceil(price) if action=="Buy" else math.floor(price)
        contract = self.state["contract"]
        if action=="Buy" and contract.get("limit_up"):
            limit = min(limit,int(contract["limit_up"]))
        elif action=="Sell" and contract.get("limit_down"):
            limit = max(limit,int(contract["limit_down"]))
        if limit<=0:
            raise ValueError("委託限價無效")
        plan={}
        if role=='entry':
            if cfg.get('model_run_id'):
                model = (self.state['lastSignal'] or {}).get('model') or {}
                if (self.entry_filter is None or model.get('runId') != cfg['model_run_id']
                    or model.get('hash') != self.entry_filter.hash or model.get('accepted') is not True
                    or self.state['lastSignal']['time'] != int(at.timestamp())//(cfg['decision_minutes']*60)*(cfg['decision_minutes']*60)):
                    raise ValueError('缺少本次已確認模型訊號，禁止進場')
            # Keep the trained R before rounding the ATR-adjusted target. The UI's
            # integer target_points only describes the nominal minimum distance.
            entry_config = dict(cfg, target_points=cfg['stop_points']*self.entry_filter.target_r) if cfg.get('model_run_id') else cfg
            plan,blocked=entry_plan(entry_config,self.state['lastSignal'] or {},action,limit,q['price'],self.state['realizedNet'])
            if blocked:
                self.state['reason']=blocked
                self._save(blocked,'signal_rejected')
                return
            if cfg.get('model_run_id'):
                plan.update(modelRunId=model['runId'], modelHash=model['hash'], modelScore=model['score'],
                    modelThreshold=model['threshold'], exitDeadline=min(self.state['lastSignal']['time']+20*60,
                        int((window(cfg)[0]+timedelta(minutes=schedule(cfg['strategy_session']).exit_minute)).timestamp())))
        tag = "FA"+uuid.uuid4().hex[:8]
        order = dict(tag=tag,role=role,action=action,limit=limit,status="Sending",filled=0,fillPrice=None,
            orderId=None,submittedAt=at.timestamp(),cancelRequested=False,
            entryTag=self.state["position"]["entryTag"] if role=="exit" else None)
        order.update(plan)
        self.state["orders"].append(order)
        self.state["pending"] = tag
        if role=="entry":
            self.state["entryCount"] += 1
            self.state["usedSides"].append(action)
        self._save(f"{reason}：{tag} {action} 1 口，限價 {limit} IOC（送出前已保存）","intent")
        if self.closing.is_set() or self.execution_blocked.is_set() or role=="entry" and self.entries_blocked.is_set():
            order["status"] = "NotSent"
            self.state["pending"] = None
            self._save("服務或風控已停止送單，已保存意圖未送出","order")
            return
        try:
            trade = self.gateway.submit(cfg,action,limit,role,tag)
            order.update(orderId=trade["order"]["id"],status="AwaitingConfirmation")
            self._save(f"{tag} 已回覆；等待權威委託查詢確認成交","order")
        except Exception:
            order["status"] = "Unknown"
            self.state.update(status="attention",reason="送單結果未知；不重送，持續查詢本策略識別碼")
            self._save(self.state["reason"],"error")

    def tick(self):
        with self.lock:
            if self.closing.is_set() or not self.monitoring or not self.state["id"] or self.state.get("manualResolved") or self.state["status"] in {"idle","stopped","completed","archived"}:
                return
            try:
                self._assert_mode()
                self.store.claim(self.writer)
            except ValueError:
                self.monitoring = False
                self.state.update(status="attention",reason="策略執行權不可用；停止所有自動發送，請人工確認")
                return
            try:
                self._tick()
                self._save()
            except Exception:
                self.state.update(status="attention",reason="行情或委託對帳失敗；停止新倉，請重新對帳；已有曝險時需人工確認")
                self._save(self.state["reason"],"error")

    def _tick(self):
        cfg, at = self.state["config"],self.clock()
        spec = schedule(cfg['strategy_session'])
        start, end = window(cfg)
        if self.state["status"]=="running" and (not self.owner or not self.authorize(self.owner) or self.monotonic()>self.lease_until):
            self.state.update(status="paused",reason="面板心跳逾時或介面已鎖定；暫停新倉，既有曝險仍監控退出")
            self._save(self.state["reason"],"control")
        if at < start:
            if self.state["status"]=="running":
                self.state["reason"] = "等待指定交易日；不使用先前交易日報價"
            return
        if self.state.get("metadataDay")!=cfg['trade_date']:
            self.state["contract"] = self.gateway.prepare(cfg)
            self.state["metadataDay"] = cfg['trade_date']
        self._reconcile()
        # Exposure comes from confirmed fills, independently of quote availability.
        self._rebuild()
        self.state["quote"] = self.gateway.quote(self.state["contract"])
        self._rebuild()
        if at >= end:
            self.state.update(status="attention" if self.state["position"] or self.state["pending"] else "completed",reason="本次盤別已結束；未確認曝險須人工處理，不接續下一盤自動交易")
            self.monitoring,self.owner,self.lease_until = False,None,0
            self.store.release(self.writer)
            return
        if not self._valid_quote():
            self.state["reason"] = "報價過期、試撮或買賣價不足；不送單，已有曝險時請留意人工退出"
            return
        position = self.state["position"]
        pnl = self.state["realizedNet"]
        estimated = None
        if pnl is not None:
            if position is None:
                estimated = pnl
            elif self.state["unrealizedNet"] is not None:
                estimated = pnl+self.state["unrealizedNet"]
        loss_hit = estimated is not None and estimated<=-cfg["loss_limit"]
        if loss_hit:
            self.state.update(status="stopping",exitRequested=True,exitReason="估計損失門檻",reason="已達估計損失門檻，停止新倉並嘗試退出")
        if at >= start+timedelta(minutes=spec.exit_minute):
            self.state.update(status="stopping",exitRequested=True,exitReason="盤別收盤前退出")
        if position:
            price, buy = self.state["quote"]["price"],position["side"]=="Buy"
            stop_hit = price<=position["stop"] if buy else price>=position["stop"]
            target_hit = price>=position["target"] if buy else price<=position["target"]
            if stop_hit:
                self.state.update(exitRequested=True,exitReason="策略停損")
            elif target_hit:
                self.state.update(exitRequested=True,exitReason="策略停利")
            if position.get('exitDeadline') is not None and at.timestamp() >= position['exitDeadline']:
                self.state.update(exitRequested=True,exitReason='模型20分鐘退出期限')
            if self.state["exitRequested"] and not self.state["pending"]:
                attempts = sum(o["role"]=="exit" and o["entryTag"]==position["entryTag"] for o in self.state["orders"])
                if attempts>=3:
                    self.state.update(status="attention",reason="三次退出委託均未確認平倉；保留曝險，請人工處理")
                else:
                    self._send("Sell" if buy else "Buy","exit",self.state["exitReason"])
            return
        if self.state["pending"]:
            return
        if self.state["status"]=="stopping":
            self.state.update(status="stopped",reason="本策略委託已確認且無追蹤曝險；不再新增委託")
            self.monitoring,self.owner,self.lease_until = False,None,0
            self.store.release(self.writer)
            return
        if self.state["status"]!="running":
            return
        if pnl is None:
            self.state.update(status="attention",reason="成交價尚未對齊，損益未知；停止新倉，請重新對帳")
            return
        if self.state["entryCount"]>=cfg["max_entries"]:
            self.state.update(status="paused",reason="已達本日進場委託上限；重新啟動不會重設額度")
            return
        interval = cfg.get('decision_minutes',5)*60
        decision = int(at.timestamp())//interval*interval
        if not entry_window(cfg,at) or decision<=self.state["lastDecision"] or at.timestamp()-decision>90:
            return
        self.state["lastDecision"] = decision
        bars = (self.gateway.bars(cfg['contract_code'],cfg['trade_date']) if cfg['strategy_session'] == 'cash'
            else self.gateway.bars(cfg['contract_code'],cfg['trade_date'], 'FUT', cfg['strategy_session']))
        closed = [b for b in bars if b["time"]<=decision]
        month = self.state["contract"].get("delivery_date", "").replace("-", "")[:6]
        self.store.research.ingest_closed_bars(("fubon-"+self.gateway.mode,"FUT","TMF",month,market_session(cfg['strategy_session'])),closed)
        stocks = {}
        if cfg["use_basket"] or cfg.get('model_run_id') and cfg['strategy_session'] == 'cash':
            from .learning_data import STOCKS
            codes = STOCKS if cfg.get('model_run_id') else [member['code'] for member in cfg['basket']]
            for code in codes:
                values = self.gateway.bars(code,cfg["trade_date"],"STK")
                stocks[code] = [b for b in values if b["time"]<=decision]
                self.store.research.ingest_closed_bars(("fubon-"+self.gateway.mode,"STK",code,"","regular"),stocks[code])
        signal = opening_signal(closed,decision,cfg["basket"] if cfg["use_basket"] else None,stocks, cfg['strategy_session'],cfg.get('decision_minutes',5))
        if signal['side'] and cfg.get('model_run_id'):
            if self.entry_filter is None or self.entry_filter.ident != cfg['model_run_id']:
                raise ValueError('所選模型尚未載入，禁止進場')
            from .learning_inference import ModelInferenceError
            try:
                signal['model'] = self.entry_filter.evaluate(closed, decision, stocks)
            except ModelInferenceError as error:
                signal['model'] = error.decision
                signal['reason'] = str(error)
                self.state.update(lastSignal=signal, status='attention', reason=str(error))
                self._save(self.state['reason'], 'model_error')
                return
            signal['reason'] = signal['model']['reason']
        self.state["lastSignal"] = signal
        self._save(signal["reason"],"signal")
        if signal["side"] and signal["side"] not in self.state["usedSides"] and (not cfg.get('model_run_id') or signal['model']['accepted']):
            # Re-read current quotes after candle requests; stale HTTP success cannot arm an order.
            self.state["quote"] = self.gateway.quote(self.state["contract"])
            self._send(signal["side"],"entry",signal["reason"])

    def shutdown(self):
        self.closing.set()
        with self.lock:
            if not self.state["id"] or not self.monitoring:
                return
            try:
                self.store.claim(self.writer)
            except ValueError:
                self.monitoring = False
                return
            if self.state["id"] and self.state["status"] not in {"stopped","completed","archived"}:
                self.state.update(status="attention" if self.state["position"] or self.state["pending"] else "paused",
                    reason="服務已停止；不保證自動平倉，重新啟動後必須手動對帳")
                self._save(self.state["reason"],"control")
            self.store.release(self.writer)
