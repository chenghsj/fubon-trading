"""Single-day, single-lot TMF automation for the official sandbox only.

The worker owns execution. Browser heartbeats permit new entries, not exit monitoring.
Every intent is durable before its one SDK submission; uncertain outcomes are queried.
"""
from copy import deepcopy
from datetime import date, datetime, timedelta
import math
import threading
import time
import uuid

from pydantic import BaseModel, ConfigDict, Field, model_validator

from .mapping import TAIPEI, now
from .research import BasketMember


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
    tax_rate: float = Field(default=.00002, ge=0, le=.01)
    use_basket: bool = False
    basket: list[BasketMember] = Field(default_factory=lambda:[BasketMember(code="2330",weight=.4),BasketMember(code="2454",weight=.04),BasketMember(code="2317",weight=.02),BasketMember(code="2881",weight=.01)], min_length=1, max_length=12)

    @model_validator(mode="after")
    def valid_basket(self):
        if len({m.code for m in self.basket}) != len(self.basket) or sum(m.weight for m in self.basket)>1.000001:
            raise ValueError("股票不可重複，權重合計不可超過 100%")
        return self


def empty_state():
    return dict(id=None, status="idle", reason="設定單日日盤策略後啟動", config=None, contract=None,
        entryCount=0, usedSides=[], lastDecision=0, lastSignal=None, orders=[], pending=None,
        position=None, quote=None, realizedNet=0, unrealizedNet=None, exitRequested=False,
        exitReason="", updatedAt=None, manualResolved=False,executionBlocked=False)


def opening_signal(bars, decision, basket=None, stocks=None):
    """Same 09:00 cash-aligned range/cross as the historical harness; exact completed bars."""
    at = datetime.fromtimestamp(decision, TAIPEI)
    start = int(at.replace(hour=9,minute=0,second=0,microsecond=0).timestamp())
    index = {b["time"]:b for b in bars if start < b["time"] <= decision}
    required = {start+i*60 for i in range(1,16)} | {decision-i*60 for i in range(10)}
    result = dict(time=decision, side=None, high=None, low=None, score=None, reason="等待完整已收盤分 K")
    if not required.issubset(index):
        return result
    high = max(index[start+i*60]["high"] for i in range(1,16))
    low = min(index[start+i*60]["low"] for i in range(1,16))
    previous, current = index[decision-300]["close"], index[decision]["close"]
    side = None
    if current>high and previous<=high:
        side = "Buy"
    elif current<low and previous>=low:
        side = "Sell"
    result.update(high=high,low=low,side=side,reason="沒有新的開盤區間穿越" if side is None else "5 分收盤突破開盤區間")
    if side and basket:
        score = 0
        for member in basket:
            quotes = {b["time"]:b for b in (stocks or {}).get(member["code"],[])}
            if decision not in quotes or decision-300 not in quotes:
                return dict(result,side=None,reason=f"{member['code']} 缺少同步資料，跳過此訊號")
            score += member["weight"]*(quotes[decision]["close"]/quotes[decision-300]["close"]-1)
        result["score"] = score
        if score*(1 if side=="Buy" else -1)<=0:
            result.update(side=None,reason="權值股假設籃子未同向，跳過此訊號")
    return result


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
        try:
            self.state = (store.latest() if gateway.mode=="sandbox" else None) or empty_state()
            if self.state["id"]:
                AutoConfig.model_validate(self.state["config"])
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
            result.update(mode=self.gateway.mode,available=self.gateway.mode=="sandbox" and not self.load_error,
                monitoring=self.monitoring,
                owned=bool(self.owner and self.owner==header), leaseSeconds=max(0,round(self.lease_until-self.monotonic())),
                events=self.store.events(self.state["id"]) if self.state["id"] else [])
            return result

    def _save(self, message=None, kind="state"):
        self.state["updatedAt"] = self.clock().isoformat()
        if self.state["id"]:
            self.store.save(self.state,kind,message)

    def _assert_mode(self):
        if self.gateway.mode!="sandbox" or self.closing.is_set() or self.load_error:
            raise ValueError("自動交易僅支援官方 sandbox；目前不可啟動")

    def start(self, config, header):
        with self.lock:
            self._assert_mode()
            if not self.authorize(header):
                raise ValueError("工作階段已鎖定，請重新解鎖")
            cfg = config.model_dump(mode="json")
            at = self.clock()
            day = config.trade_date
            if day < at.date() or day>at.date()+timedelta(days=7) or day.weekday()>=5:
                raise ValueError("請選擇今天至未來 7 天內的平日；休市日將不產生委託")
            if day==at.date() and at.hour*60+at.minute>=790:
                raise ValueError("13:10 後不再啟動新進場，請選擇下一個交易日")
            if self.state["id"] and not self.state.get("manualResolved"):
                self._rebuild()
            if self.state["status"] in {"running","stopping"} or self.state["pending"] or self.state["position"]:
                raise ValueError("已有執行中策略或未確認曝險；請先暫停、對帳與退出")
            self.store.claim(self.writer)
            previous = self.store.for_day(cfg["account"],cfg["trade_date"])
            if previous and previous.get("manualResolved"):
                raise ValueError("本日已人工封存，不再重新啟動；請選擇下一交易日")
            if previous and previous["entryCount"] and previous["config"]!=cfg:
                raise ValueError("本日已有進場意圖，設定已固定；請沿用原設定恢復")
            if previous and (previous["pending"] or previous["position"]):
                raise ValueError("本日仍有未確認委託或曝險，請先重新對帳")
            if previous and sum(o["filled"]*(1 if o["action"]=="Buy" else -1) for o in previous["orders"]):
                raise ValueError("本日成交紀錄仍有曝險，請先重新對帳")
            contract = self.gateway.prepare(cfg)
            self.state = previous or empty_state()
            self.state.update(id=self.state["id"] or uuid.uuid4().hex,config=cfg,contract=contract,
                status="running",reason="等待啟動後新完成的 5 分訊號",lastDecision=int(at.timestamp())//300*300)
            self.owner, self.lease_until = header,self.monotonic()+15
            self.last_heartbeat_received = self.monotonic()
            self.entries_blocked.clear()
            self.monitoring = True
            self._save("啟動 sandbox 策略；不追補啟動前訊號","control")
            return self.snapshot(header)

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
        if command in {"pause","stop"} and run_id==self.state["id"] and self.authorize(header):
            self.entries_blocked.set()
        with self.lock:
            self._assert_mode()
            if not self.state["id"] or run_id!=self.state["id"]:
                raise ValueError("策略版本已變更，請重新整理")
            if not self.authorize(header):
                raise ValueError("工作階段已鎖定")
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
                self.state.update(status="archived",manualResolved=True,pending=None,position=None,
                    reason="已由使用者人工確認並封存；此動作沒有撤單或平倉")
                self.owner = None
                self.monitoring = False
                self.store.release(self.writer)
            else:
                raise ValueError("未知控制指令")
            self._save(self.state["reason"],"control")
            return self.snapshot(header)

    def _valid_quote(self):
        q = self.state["quote"]
        if not q or q.get("trial") or not all(math.isfinite(q.get(k,0)) and q.get(k,0)>0 for k in ("price","bid","ask")):
            return False
        if q["bid"]>q["ask"]:
            return False
        age = self.clock().timestamp()-q["time"]
        return -2<=age<=15 and datetime.fromtimestamp(q["time"],TAIPEI).date().isoformat()==self.state["config"]["trade_date"]

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
                    realized += (b-a)*(1 if entry["action"]=="Buy" else -1)*10 - cfg["fee_per_side"]*2 - (a+b)*10*cfg["tax_rate"]
                entry = None
        self.state["realizedNet"] = realized if known else None
        self.state["unrealizedNet"] = None
        if entry:
            side = 1 if entry["action"]=="Buy" else -1
            anchor = entry["limit"]
            self.state["position"] = dict(entryTag=entry["tag"],side=entry["action"],quantity=1,
                entryPrice=entry["fillPrice"],referencePrice=anchor,
                stop=anchor-side*cfg["stop_points"],target=anchor+side*cfg["target_points"])
            if entry["fillPrice"] is not None and self._valid_quote():
                price = self.state["quote"]["price"]
                self.state["unrealizedNet"] = (price-entry["fillPrice"])*side*10-cfg["fee_per_side"]*2-(price+entry["fillPrice"])*10*cfg["tax_rate"]
        else:
            self.state["position"] = None
            if not self.state["pending"]:
                self.state["exitRequested"] = False

    def _send(self, action, role, reason):
        self._assert_mode()
        if not self.monitoring or self.state.get("manualResolved"):
            raise ValueError("尚未人工接管監控，不可建立委託")
        cfg, at = self.state["config"],self.clock()
        minute = at.hour*60+at.minute
        if at.date().isoformat()!=cfg["trade_date"] or not 540<=minute<825 or not self._valid_quote() or self.state["pending"]:
            raise ValueError("送單前日期、行情或待確認狀態不符")
        if role=="entry" and (self.state["status"]!="running" or not self.owner or not self.authorize(self.owner) or self.monotonic()>self.lease_until or not 560<=minute<=790):
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
        tag = "FA"+uuid.uuid4().hex[:8]
        order = dict(tag=tag,role=role,action=action,limit=limit,status="Sending",filled=0,fillPrice=None,
            orderId=None,submittedAt=at.timestamp(),cancelRequested=False,
            entryTag=self.state["position"]["entryTag"] if role=="exit" else None)
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
        if self.state["status"]=="running" and (not self.owner or not self.authorize(self.owner) or self.monotonic()>self.lease_until):
            self.state.update(status="paused",reason="面板心跳逾時或介面已鎖定；暫停新倉，既有曝險仍監控退出")
            self._save(self.state["reason"],"control")
        if at.date().isoformat()<cfg["trade_date"]:
            if self.state["status"]=="running":
                self.state["reason"] = "等待指定交易日；不使用先前交易日報價"
            return
        if self.state.get("metadataDay")!=at.date().isoformat():
            self.state["contract"] = self.gateway.prepare(cfg)
            self.state["metadataDay"] = at.date().isoformat()
        self._reconcile()
        # Exposure comes from confirmed fills, independently of quote availability.
        self._rebuild()
        self.state["quote"] = self.gateway.quote(self.state["contract"])
        self._rebuild()
        minute = at.hour*60+at.minute
        if at.date().isoformat()>cfg["trade_date"] or minute>=825:
            self.state.update(status="attention" if self.state["position"] or self.state["pending"] else "completed",reason="本次日盤已結束；未確認曝險須人工處理，不跨日自動交易")
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
        if minute>=800:
            self.state.update(status="stopping",exitRequested=True,exitReason="13:20 日內退出")
        if position:
            price, buy = self.state["quote"]["price"],position["side"]=="Buy"
            stop_hit = price<=position["stop"] if buy else price>=position["stop"]
            target_hit = price>=position["target"] if buy else price<=position["target"]
            if stop_hit:
                self.state.update(exitRequested=True,exitReason="策略停損")
            elif target_hit:
                self.state.update(exitRequested=True,exitReason="策略停利")
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
        decision = int(at.timestamp())//300*300
        if not 560<=minute<=790 or decision<=self.state["lastDecision"] or at.timestamp()-decision>90:
            return
        self.state["lastDecision"] = decision
        bars = self.gateway.bars(cfg["contract_code"],cfg["trade_date"])
        closed = [b for b in bars if b["time"]<=decision]
        month = self.state["contract"].get("delivery_date", "").replace("-", "")[:6]
        self.store.research.ingest_closed_bars(("fubon-sandbox","FUT","TMF",month,"regular"),closed)
        stocks = {}
        if cfg["use_basket"]:
            for member in cfg["basket"]:
                values = self.gateway.bars(member["code"],cfg["trade_date"],"STK")
                stocks[member["code"]] = [b for b in values if b["time"]<=decision]
                self.store.research.ingest_closed_bars(("fubon-sandbox","STK",member["code"],"","regular"),stocks[member["code"]])
        signal = opening_signal(closed,decision,cfg["basket"] if cfg["use_basket"] else None,stocks)
        self.state["lastSignal"] = signal
        self._save(signal["reason"],"signal")
        if signal["side"] and signal["side"] not in self.state["usedSides"]:
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
