import asyncio
from contextlib import asynccontextmanager
import json
from pathlib import Path
from urllib.parse import urlparse
import uuid

from fastapi import Body, FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

from .broker import Broker
from .config import Config, ROOT
from .mapping import now
from .models import ContractKey, Mutation, PlaceOrder


def create_app(config=None, sdk_factory=None):
    cfg = config or Config.from_env()
    clients = set()
    loop = None

    def publish(event, data):
        def deliver():
            for queue in list(clients):
                if queue.full():
                    # Disconnect an overwhelmed consumer. Reconnection forces
                    # a fresh orders/positions baseline instead of dropping fills.
                    while not queue.empty():
                        queue.get_nowait()
                    queue.put_nowait(None)
                else:
                    queue.put_nowait((event, data))
        if loop and not loop.is_closed():
            loop.call_soon_threadsafe(deliver)

    broker = Broker(cfg, publish, sdk_factory)

    @asynccontextmanager
    async def lifespan(app):
        nonlocal loop
        loop = asyncio.get_running_loop()
        await asyncio.to_thread(broker.connect)

        async def demo_clock():
            while True:
                broker.demo_events()
                await asyncio.sleep(1)
        task = asyncio.create_task(demo_clock())
        yield
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass
        await asyncio.to_thread(broker.close)

    app = FastAPI(title="Fubon Trading local bridge", lifespan=lifespan)
    app.state.broker = broker

    @app.middleware("http")
    async def local_only(request: Request, call_next):
        host = request.url.hostname
        origin = request.headers.get("origin")
        allowed_ports = {cfg.port, 5179}
        if host not in {"127.0.0.1", "localhost", "testserver"}:
            return JSONResponse({"detail": "Local bridge: invalid Host"}, status_code=403)
        if origin:
            parsed = urlparse(origin)
            if parsed.scheme != "http" or parsed.hostname not in {"127.0.0.1", "localhost"} or parsed.port not in allowed_ports:
                return JSONResponse({"detail": "Local bridge: invalid Origin"}, status_code=403)
        if request.method in {"POST", "PUT", "DELETE"} and request.headers.get("content-type", "").split(";")[0] != "application/json":
            return JSONResponse({"detail": "application/json required"}, status_code=415)
        response = await call_next(request)
        response.headers["Cache-Control"] = "no-store"
        return response

    @app.exception_handler(ValueError)
    async def invalid(_, error):
        return JSONResponse({"detail": str(error)}, status_code=400)

    @app.exception_handler(Exception)
    async def unavailable(_, error):
        # Do not expose native SDK exceptions (credentials/paths/identity).
        return JSONResponse({"detail": "富邦服務請求失敗，請檢查連線、權限及商品；委託結果未知時請先查詢，勿直接重送"}, status_code=502)

    @app.get("/api/v1/info")
    def info():
        return dict(name="Fubon Trading", version="0.1.0", broker="fubon", sdk_version="2.5.0",
            description="Independent fork of Shioaji Pro; Fubon Neo local adapter",
            protocols=["http", "sse"], simulation=cfg.mode != "live", mode=cfg.mode,
            instance_id=broker.instance_id, connected=cfg.mode == "demo" or bool(broker.sdk and not broker.error),
            market_connected=broker.market_connected(),
            session=cfg.session, error=broker.error,
            supported=["quotes", "depth", "kbars", "orders", "positions", "balance", "futures_margin"],
            limitations=["複式單、信用下單與 Shioaji 專屬市場分析尚未轉接", "本機模擬不計手續費、稅與市場衝擊；重啟即重設"])

    @app.get("/api/v1/health")
    def health():
        return dict(status="healthy" if cfg.mode == "demo" or broker.sdk and not broker.error else "unavailable",
            version="0.1.0", timestamp=now().isoformat(), token_expires_in_seconds=0,
            token_stale=bool(broker.error), next_maintenance="", session_recovering=False)

    @app.get("/api/v1/auth/accounts")
    def accounts():
        return broker.account_rows()

    @app.post("/api/v1/auth/subscribe_trade")
    def subscribe_trade(body: dict = Body(...)):
        broker.account(body)
        return {"success": True}

    @app.get("/api/v1/auth/ca_expiretime")
    def ca_expire():
        raise HTTPException(501, "憑證效期請從富邦憑證管理查詢；此轉接器不提供虛構效期")

    @app.get("/api/v1/data/contracts")
    def contracts(security_type: str = "FUT", page: int = 1, page_size: int = 500):
        if page < 1 or page_size < 1 or page_size > 5000:
            raise ValueError("無效分頁")
        rows = broker.contracts(security_type)
        return dict(contracts=rows[(page-1)*page_size:page*page_size], security_type=security_type,
            region="TW", total=len(rows), page=page, page_size=page_size, max_page=max(1, (len(rows)+page_size-1)//page_size))

    @app.get("/api/v1/data/contracts/futures/roots")
    def futures_roots():
        return list({row["root"]: dict(root=row["root"], name=row["root"]) for row in broker.contracts("FUT")}.values())

    @app.get("/api/v1/data/contracts/futures")
    def futures(root: str = "", delivery_month: str = ""):
        return [row for row in broker.contracts("FUT") if (not root or row["root"] == root) and (not delivery_month or row.get("delivery_month") == delivery_month)]

    @app.get("/api/v1/data/contracts/options/roots")
    def options_roots():
        return [{"root": "TXO", "name": "臺指選擇權"}]

    @app.get("/api/v1/data/contracts/options")
    def options():
        raise HTTPException(501, "選擇權到期、履約價與權利別篩選尚未完成轉接")

    @app.get("/api/v1/data/contracts/tick-bands/{rule}")
    def tick_bands(rule: str, security_type: str = "FUT"):
        if rule != "index" or security_type != "FUT":
            raise HTTPException(501, "此商品的跳動級距尚未轉接")
        return dict(region="TW", security_type="FUT", rule=rule, basis="price", bands=[dict(min=0, max=None, tick=1)])

    @app.get("/api/v1/data/contracts/{code}/info")
    @app.get("/api/v1/data/contracts/{code}")
    def contract(code: str, security_type: str | None = None):
        return broker.contract(ContractKey(code=code, security_type=security_type).model_dump())

    @app.post("/api/v1/data/snapshots")
    def snapshots(body: dict = Body(...)):
        keys = body.get("contracts", [])
        if not isinstance(keys, list) or len(keys) > 100:
            raise ValueError("單次快照上限 100 筆")
        return [broker.quote(broker.contract(ContractKey.model_validate(key).model_dump())) for key in keys]

    @app.post("/api/v1/data/kbars")
    def kbars(body: dict = Body(...)):
        return broker.kbars(ContractKey.model_validate(body["contract"]).model_dump(), body["start"], body["end"])

    @app.post("/api/v1/data/ticks")
    def ticks(body: dict = Body(...)):
        return broker.ticks(ContractKey.model_validate(body["contract"]).model_dump(), body["date"], min(int(body.get("last_cnt", 500)), 500))

    @app.post("/api/v1/stream/subscribe")
    @app.post("/api/v1/stream/unsubscribe")
    def subscribe(request: Request, body: dict = Body(...)):
        if body.get("intraday_odd"):
            raise HTTPException(501, "零股即時行情尚未轉接")
        key = ContractKey.model_validate(body.get("contract", body)).model_dump()
        fn = broker.unsubscribe if request.url.path.endswith("unsubscribe") else broker.subscribe
        fn(key, body.get("quote_type", "Tick"))
        return dict(success=True)

    @app.get("/api/v1/stream/data")
    async def stream(request: Request):
        queue = asyncio.Queue(maxsize=512)
        clients.add(queue)

        async def events():
            try:
                yield 'retry: 2000\n\n'
                while not await request.is_disconnected():
                    needed = {sub["kind"] for sub in list(broker.subscriptions.values())}
                    if cfg.mode != "demo" and needed and not needed.issubset(broker.connected_sockets):
                        yield 'event: fubon_connection_status\ndata: {"market_connected":false}\n\n'
                        # Close even when another market continues sending ticks.
                        # Reconnection replays all subscriptions, including the lost feed.
                        break
                    try:
                        item = await asyncio.wait_for(queue.get(), timeout=10)
                        if item is None:
                            break
                        event, data = item
                    except asyncio.TimeoutError:
                        needed = {sub["kind"] for sub in broker.subscriptions.values()}
                        feed_down = cfg.mode != "demo" and (broker.error or not needed.issubset(broker.connected_sockets))
                        event = "fubon_connection_status" if feed_down else "heartbeat"
                        data = {"time": now().isoformat(), "market_connected": not feed_down}
                    yield f'event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n'
            finally:
                clients.discard(queue)
        return StreamingResponse(events(), media_type="text/event-stream", headers={"X-Accel-Buffering": "no"})

    @app.post("/api/v1/order/place_order")
    def place_order(body: PlaceOrder):
        order = body.stock_order or body.futures_order
        if order.quantity > cfg.max_quantity:
            raise ValueError(f"超過本機單筆數量上限 {cfg.max_quantity}")
        account = broker.account(order.account)
        return broker.place(body.contract.model_dump(), order.model_dump(exclude={"account"}), account)

    @app.post("/api/v1/order/trades")
    def trades(body: dict = Body(...)):
        return broker.order_list(broker.account(body), body.get("refresh", True) is not False)

    @app.post("/api/v1/order/trade_cache_health")
    def cache_health(body: dict = Body(...)):
        account = broker.account(body)
        healthy = cfg.mode != "live" or broker.cache_health.get(account["account_id"], False)
        return dict(state="Healthy" if healthy else "Degraded",
            reasons=[] if healthy else [{"event_type": "FuturesOrder" if account["account_type"] == "F" else "StockOrder", "reason": "PendingReport"}])

    @app.post("/api/v1/order/cancel_order")
    def cancel(body: Mutation):
        return broker.mutate(body.trade_id, "cancel")

    @app.post("/api/v1/order/update_price")
    def update_price(body: Mutation):
        if body.price is None:
            raise ValueError("缺少改價價格")
        return broker.mutate(body.trade_id, "price", body.price)

    @app.post("/api/v1/order/update_qty")
    def update_qty(body: Mutation):
        if body.quantity is None or body.quantity > cfg.max_quantity:
            raise ValueError("無效修改數量")
        return broker.mutate(body.trade_id, "quantity", body.quantity)

    @app.post("/api/v1/portfolio/position_unit")
    def positions(body: dict = Body(...)):
        return broker.positions(broker.account(body))

    @app.post("/api/v1/portfolio/margin")
    def margin(body: dict = Body(...)):
        account = broker.account(body)
        if account["account_type"] != "F":
            raise ValueError("權益數查詢需選擇期貨帳戶")
        return broker.margin(account)

    @app.post("/api/v1/portfolio/account_balance")
    def balance(body: dict = Body(...)):
        account = broker.account(body)
        if account["account_type"] != "S":
            raise ValueError("銀行餘額查詢需選擇證券帳戶")
        return broker.balance(account)

    watchlists = {}

    @app.get("/api/v1/watchlist")
    def watchlist():
        if not watchlists:
            # Server-side defaults keep the fork independent of Shioaji aliases.
            watchlists["default"] = dict(id="default", name="台指期與股票", contracts=[
                broker.contract(dict(code=code, security_type=kind)) for code, kind in
                [("TMFR1", "FUT"), ("TXFR1", "FUT"), ("MXFR1", "FUT"), ("2330", "STK")]])
        return list(watchlists.values())

    @app.post("/api/v1/watchlist")
    def create_watchlist(body: dict = Body(...)):
        ident = uuid.uuid4().hex
        watchlists[ident] = dict(id=ident, name=str(body["name"])[:100], contracts=body.get("contracts", []))
        return watchlists[ident]

    @app.put("/api/v1/watchlist/{ident}")
    def sync_watchlist(ident: str, body: dict = Body(...)):
        if ident not in watchlists:
            raise HTTPException(404, "自選清單不存在")
        watchlists[ident]["contracts"] = body.get("contracts", [])
        return watchlists[ident]

    @app.delete("/api/v1/watchlist/{ident}")
    def delete_watchlist(ident: str):
        watchlists.pop(ident, None)
        return {"success": True}

    @app.api_route("/api/{path:path}", methods=["GET", "POST", "PUT", "DELETE"])
    def unsupported(path: str):
        raise HTTPException(501, "此功能尚未完成富邦 API 轉接")

    if (ROOT / "dist").is_dir():
        app.mount("/", StaticFiles(directory=ROOT / "dist", html=True), name="terminal")
    return app
