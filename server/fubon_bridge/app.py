import asyncio
from contextlib import asynccontextmanager
from copy import deepcopy
import json
import hashlib
import threading
from time import monotonic
from pathlib import Path
from urllib.parse import urlparse
import uuid

from fastapi import Body, FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from starlette.background import BackgroundTask

from .broker import Broker
from .config import Config, ROOT
from .mapping import now
from .models import ContractKey, Mutation, PlaceOrder, ProfitLossRequest, ScannerRequest, TicksRequest, VolumesRequest, WatchlistContracts
from .market_data import MarketData
from .portfolio_data import PortfolioData
from .feature_errors import FeatureUnavailable
from .native_panels import NativePanels
from .native_models import NativeQuery, NativeAction, IndexLease, NativeAccount, NativeReconcile
from .native_attempts import NativeAttempts
from .session import Session
from .passkeys import Passkeys, PasskeyStore
from .origins import localhost_ui_origin
from .research import HistoryRequest, ResearchStore, load_history
from .auto_gateway import SandboxGateway, PaperGateway
from .paper_store import PaperStore
from .auto_store import AutoStore
from .auto_trading import AutoConfig, SandboxAutoTrader
from .learning_store import LearningStore
from .learning_service import LearningService
from .learning_data import CollectionRequest
from .learning_train import TrainingRequest
from .regime_research import RegimeReports, RegimeRequest
from .mode_settings import ModeChange, ModeSettings, ensure_idle
from .watchlist_store import WatchlistStore
from .credential_settings import CredentialChange, CredentialSettings
from .keychain import KeychainError
from pydantic import BaseModel, ValidationError
from typing import Literal


class AutoControl(BaseModel):
    run_id: str
    command: Literal["pause", "stop", "reconcile", "archive", "flatten"]
    acknowledgement: str = ""
    execution_allowed: bool = False


class AutoHeartbeat(BaseModel):
    run_id: str
    entries_allowed: bool
    execution_allowed: bool


def create_app(config=None, sdk_factory=None, *, launch_token=None, on_ready=None, passkey_store=None, public_origin=None, research_store=None, automation_factory=None, mode_store=None, on_restart=None, credential_store=None, watchlist_store=None):
    cfg = config or Config.from_env()
    session = Session(launch_token)
    public_origin = localhost_ui_origin(public_origin or "http://localhost:5179")
    allowed_ports = {cfg.port, urlparse(public_origin).port}
    passkeys = Passkeys(passkey_store if passkey_store is not None else PasskeyStore(), public_origin)
    login_lock = asyncio.Lock()
    login_attempted = False
    request_lock = asyncio.Lock()
    switching = False
    settings = mode_store or ModeSettings(ROOT / 'server' / '.mode-settings.json')
    credentials = credential_store if credential_store is not None else CredentialSettings()
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

    research = research_store or ResearchStore(ROOT / "server" / ".research.sqlite3")
    broker = Broker(cfg,publish,sdk_factory,paper_store=PaperStore(research) if cfg.mode=='paper' else None)
    native_panels = NativePanels(broker,NativeAttempts(research))
    gateway = PaperGateway(broker) if cfg.mode=='paper' else SandboxGateway(broker)
    automation = automation_factory(broker, research, session.authorize) if automation_factory else SandboxAutoTrader(gateway,AutoStore(research,cfg.mode),session.authorize)
    learning = LearningService(broker,LearningStore(research),automation)
    regime_reports = RegimeReports(research)

    @asynccontextmanager
    async def lifespan(app):
        nonlocal loop
        loop = asyncio.get_running_loop()

        async def demo_clock():
            while True:
                await asyncio.to_thread(broker.refresh_market_sessions)
                broker.demo_events()
                await asyncio.to_thread(native_panels.expire_indices)
                await asyncio.sleep(1)
        async def automation_clock():
            while True:
                await asyncio.to_thread(automation.tick)
                await asyncio.sleep(5)
        if on_ready:
            loop.call_later(0.5, on_ready)
        task = asyncio.create_task(demo_clock())
        auto_task = asyncio.create_task(automation_clock())
        try:
            yield
        finally:
            await asyncio.to_thread(learning.shutdown)
            automation.closing.set()
            await asyncio.to_thread(automation.shutdown)
            for pending in (task, auto_task):
                pending.cancel()
                try:
                    await pending
                except asyncio.CancelledError:
                    pass
            await asyncio.to_thread(broker.close)

    app = FastAPI(title="Fubon Trading local bridge", lifespan=lifespan)
    app.state.broker = broker
    app.state.native_panels = native_panels
    app.state.session = session
    app.state.automation = automation
    app.state.learning = learning

    @app.middleware("http")
    async def local_only(request: Request, call_next):
        if request.url.path=="/api/v1/automation/heartbeat":
            request.state.automation_received_at = automation.monotonic()
        host = request.url.hostname
        origin = request.headers.get("origin")
        if host not in {"127.0.0.1", "localhost", "testserver"}:
            return JSONResponse({"detail": "Local bridge: invalid Host"}, status_code=403)
        if origin:
            parsed = urlparse(origin)
            if parsed.scheme != "http" or parsed.hostname not in {"127.0.0.1", "localhost"} or parsed.port not in allowed_ports:
                return JSONResponse({"detail": "Local bridge: invalid Origin"}, status_code=403)
        if request.method in {"POST", "PUT", "DELETE"} and request.headers.get("content-type", "").split(";")[0] != "application/json":
            return JSONResponse({"detail": "application/json required"}, status_code=415)
        if request.url.path.startswith(("/api/v1/passkeys/", "/api/v1/settings/credentials")) and request.method == "POST":
            if origin != public_origin:
                return JSONResponse({"detail": "Passkey Origin 不符，請使用 localhost 啟動視窗"}, status_code=403)
        public_paths = {"/api/v1/session", "/api/v1/passkeys/status", "/api/v1/passkeys/register/options",
                        "/api/v1/passkeys/register/verify", "/api/v1/passkeys/authenticate/options", "/api/v1/passkeys/authenticate/verify"}
        if request.url.path.startswith("/api/") and request.url.path not in public_paths:
            if not session.authorize(request.headers.get("authorization", "")):
                return JSONResponse({"detail": "本機工作階段未授權，請使用啟動時開啟的視窗"}, status_code=401,
                                    headers={"Cache-Control": "no-store"})
        if switching and request.url.path.startswith('/api/'):
            return JSONResponse({'detail': '交易模式正在切換，請等待重新解鎖'}, status_code=503)
        if request.url.path in {'/api/v1/settings/mode', '/api/v1/settings/credentials', '/api/v1/settings/credentials/options'} and request.method == 'POST':
            # Serialize settings changes. Ordinary quote requests must never
            # delay a heartbeat or cancellation. Broker and worker locks guard
            # requests already admitted before the transition was committed.
            async with request_lock:
                if switching:
                    return JSONResponse({'detail': '交易模式正在切換，請等待重新解鎖'}, status_code=503)
                response = await call_next(request)
        else:
            response = await call_next(request)
        response.headers["Cache-Control"] = "no-store"
        response.headers["Referrer-Policy"] = "no-referrer"
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Content-Security-Policy"] = "frame-ancestors 'none'"
        response.headers["X-Frame-Options"] = "DENY"
        return response

    async def unlock():
        nonlocal login_attempted
        async with login_lock:
            if not login_attempted:
                login_attempted = True
                await asyncio.to_thread(broker.connect)
        return {"access_token": session.issue()}

    @app.post("/api/v1/session")
    async def exchange_session(request: Request):
        token = session.exchange(request.headers.get("authorization", ""))
        if token is None:
            raise HTTPException(401, "啟動授權已失效，請重啟 Fubon Trading")
        if passkeys.enrolled():
            session.enrollment_token = ""
            return {"passkey_required": True}
        return {"enrollment_token": token}

    @app.get("/api/v1/passkeys/status")
    def passkey_status():
        return {"enrolled": passkeys.enrolled(), "origin": public_origin, "instance_id": broker.instance_id, "mode": cfg.mode}

    def require_enrollment(request):
        header = request.headers.get("authorization", "")
        if not session.can_enroll(header):
            raise HTTPException(401, "首次註冊需要有效的啟動授權，請重啟服務")
        return header

    @app.post("/api/v1/passkeys/register/options")
    async def register_options(request: Request):
        return passkeys.registration_options(require_enrollment(request))

    @app.post("/api/v1/passkeys/register/verify")
    async def register_verify(request: Request, body: dict = Body(...)):
        header = require_enrollment(request)
        passkeys.register(body.get("request_id", ""), body.get("credential", {}), header)
        session.enrollment_token = ""
        return await unlock()

    @app.post("/api/v1/passkeys/authenticate/options")
    async def authenticate_options():
        return passkeys.authentication_options()

    @app.post("/api/v1/passkeys/authenticate/verify")
    async def authenticate_verify(body: dict = Body(...)):
        passkeys.authenticate(body.get("request_id", ""), body.get("credential", {}))
        return await unlock()

    @app.post("/api/v1/session/logout")
    async def logout(request: Request):
        session.revoke(request.headers.get("authorization", ""))
        return {"success": True}

    @app.exception_handler(ValueError)
    async def invalid(_, error):
        return JSONResponse({"detail": str(error)}, status_code=400)

    @app.exception_handler(FeatureUnavailable)
    async def unsupported_feature(_, error):
        return JSONResponse({'detail': str(error)}, status_code=501)

    @app.exception_handler(Exception)
    async def unavailable(_, error):
        # Do not expose native SDK exceptions (credentials/paths/identity).
        return JSONResponse({"detail": "富邦服務請求失敗，請檢查連線、權限及商品；委託結果未知時請先查詢，勿直接重送"}, status_code=502)

    @app.get("/api/v1/info")
    def info():
        return dict(name="Fubon Trading", version="0.1.0", broker="fubon", sdk_version="2.5.0", native_panel_api=1,
            description="Independent fork of Shioaji Pro; Fubon Neo local adapter",
            protocols=["http", "sse"], simulation=cfg.mode != "live", mode=cfg.mode,
            instance_id=broker.instance_id, connected=cfg.mode == "demo" or bool(broker.sdk and not broker.error),
            market_connected=broker.market_connected(),
            session=cfg.session, error=broker.error or broker.session_error,
            trading_environment="sandbox" if cfg.mode == "sandbox" else "production" if cfg.mode == "live" else "local",
            supported=["quotes", "depth", "kbars", "orders", "positions", "balance", "futures_margin", "scanner", "volumes", "option_catalog", "current_session_ticks"] + (["paper_realized_pnl"] if cfg.mode in {'paper', 'demo'} else []),
            limitations=(["富邦共用測試帳戶，帳務數字不保證正確且庫存每日重設"] if cfg.mode == "sandbox" else []) + ["複式單、信用下單與 Shioaji 專屬市場分析尚未轉接", "選擇權清單支援唯讀查詢；完整即時 T 字與選擇權交易尚未啟用", "標示 API 尚未接通的新功能面板僅提供本機版面，遠端操作停用"] + (["Paper 保存委託、持倉與費稅；未模擬排隊、部分成交、市場衝擊與保證金占用"] if cfg.mode=='paper' else ["展示模式使用合成資料與記憶體帳簿"] if cfg.mode=='demo' else []))

    def restart_response():
        def restart():
            # End long-lived SSE before uvicorn waits for graceful shutdown.
            def disconnect():
                for queue in list(clients):
                    while not queue.empty():
                        queue.get_nowait()
                    queue.put_nowait(None)
            loop.call_soon_threadsafe(disconnect)
            on_restart()
        return JSONResponse(dict(restarting=True), background=BackgroundTask(restart))

    @app.get('/api/v1/settings/credentials')
    def credential_status():
        available = credentials.available()
        try:
            saved = credentials.status() if available else dict(configured=False, cert_path='')
        except Exception:
            raise HTTPException(503, '無法存取 Keychain，請解鎖 macOS 鑰匙圈後重試') from None
        return dict(available=available and on_restart is not None, **saved,
                    storage='macOS Keychain' if available else None, instance_id=broker.instance_id)

    def credential_binding(request):
        return hashlib.sha256(request.headers.get('authorization', '').encode()).hexdigest()

    def require_credential_editor():
        if not credentials.available():
            raise HTTPException(409, '目前安全儲存僅支援 macOS Keychain，無法在此系統儲存')
        if on_restart is None:
            raise HTTPException(409, '請使用 pnpm start 啟動，才能儲存並重新連線')

    @app.post('/api/v1/settings/credentials/options')
    async def credential_options(request: Request):
        require_credential_editor()
        return passkeys.authentication_options(purpose='credentials', binding=credential_binding(request))

    @app.post('/api/v1/settings/credentials')
    async def change_credentials(request: Request):
        nonlocal switching
        require_credential_editor()
        # Parse here rather than through FastAPI's request validation: its
        # default 422 response includes rejected input, including secret values.
        raw = bytearray()
        async for chunk in request.stream():
            raw.extend(chunk)
            if len(raw) > 32768:
                raise HTTPException(413, '登入資料過長，請檢查輸入')
        try:
            body = CredentialChange.model_validate(json.loads(raw))
        except (ValueError, ValidationError, TypeError):
            raise HTTPException(400, '登入資料格式不完整或無效，請檢查欄位後重試') from None
        if body.instance_id != broker.instance_id:
            raise HTTPException(409, '服務已更新，請重新開啟富邦連線設定')
        passkeys.authenticate(body.request_id, body.credential, purpose='credentials', binding=credential_binding(request))

        def save():
            nonlocal switching
            with learning.lock, automation.lock, broker.lock:
                if broker.config.broker_orders and broker.accounts_raw and broker.error:
                    raise HTTPException(409, '券商連線中斷，無法核對委託與持倉。若舊 Key 已停用，請先停止策略與本機服務，執行 pnpm credentials set 更新，再啟動服務並核對券商帳務。停止服務不會取消券商委託或平倉。')
                try:
                    ensure_idle(broker, automation, learning)
                except ValueError as error:
                    raise HTTPException(409, str(error).replace('切換模式', '更新登入資料').replace('再切換', '再更新登入資料')) from None
                try:
                    credentials.save(body)
                except KeychainError as error:
                    raise HTTPException(400, str(error)) from None
                except Exception:
                    raise HTTPException(503, 'Keychain 儲存未完成，請確認鑰匙圈存取權限後重新開啟設定') from None
                switching = True
                broker.transitioning = True
                automation.closing.set()
                learning.closing = True
        await asyncio.to_thread(save)
        return restart_response()

    @app.get('/api/v1/settings/mode')
    def mode_settings():
        return dict(mode=cfg.mode, live_enabled=cfg.live_enabled, session=cfg.session, instance_id=broker.instance_id,
                    available=on_restart is not None, saved=settings.path.exists(),
                    sandbox_configured=bool(cfg.test_id and cfg.test_cert_path and Path(cfg.test_cert_path).expanduser().is_file()))

    @app.post('/api/v1/settings/mode')
    def change_mode(body: ModeChange):
        nonlocal switching
        if on_restart is None:
            raise HTTPException(409, '此啟動方式不支援介面切換，請使用 pnpm start')
        if body.instance_id != broker.instance_id:
            raise HTTPException(409, '服務已更新，請重新開啟設定並確認目前模式')
        body = body.model_copy(update={'session': body.session or cfg.session})
        if body.mode == cfg.mode and body.live_enabled == cfg.live_enabled and body.session == cfg.session:
            return dict(restarting=False)
        expected = '確認啟用正式下單' if body.mode == 'live' else '確認切換交易環境'
        if body.acknowledgement != expected:
            raise ValueError('請先明確確認切換；正式交易需確認啟用正式下單')
        if body.mode == 'sandbox' and not (cfg.test_id and cfg.test_cert_path and Path(cfg.test_cert_path).expanduser().is_file()):
            raise ValueError('尚未備妥官方測試憑證，請依設定說明配置 sandbox 後再切換')
        with learning.lock, automation.lock, broker.lock:
            ensure_idle(broker, automation, learning, target_mode=body.mode)
            settings.save(body)
            switching = True
            broker.transitioning = True
            automation.closing.set()
            learning.closing = True
        return restart_response()

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
        return broker.future_roots()

    @app.get("/api/v1/data/contracts/futures")
    def futures(root: str = "", delivery_month: str = "", underlying_code: str = ""):
        return broker.futures(root, underlying_code, delivery_month)

    @app.get("/api/v1/data/contracts/options/roots")
    def options_roots():
        return broker.options.roots()

    @app.get("/api/v1/data/contracts/options")
    def options(root: str, delivery_month: str = '', option_right: str = '', strike_min: float | None = None,
                strike_max: float | None = None, expiry_weekday: str = ''):
        return broker.options.contracts(root, delivery_month, option_right, strike_min, strike_max, expiry_weekday)

    @app.get("/api/v1/data/contracts/tick-bands/{rule}")
    def tick_bands(rule: str, security_type: str = "FUT"):
        if rule != "index" or security_type != "FUT":
            raise HTTPException(501, "此商品的跳動級距尚未轉接")
        return dict(region="TW", security_type="FUT", rule=rule, basis="price", bands=[dict(min=0, max=None, tick=1)])

    @app.get("/api/v1/data/contracts/{code}/info")
    @app.get("/api/v1/data/contracts/{code}")
    def contract(code: str, security_type: str | None = None):
        return broker.contract_info(ContractKey(code=code, security_type=security_type).model_dump())

    @app.get('/api/v1/native/accounts')
    def native_accounts():
        return native_panels.accounts()

    @app.post('/api/v1/native/query')
    def native_query(body: NativeQuery):
        return native_panels.query(body)

    @app.post('/api/v1/native/draft/validate')
    def native_validate(body: NativeAction):
        return native_panels.validate_action(body)

    @app.post('/api/v1/native/action')
    def native_action(body: NativeAction):
        return native_panels.action(body)

    @app.post('/api/v1/native/attempts')
    def native_attempts(body: NativeAccount):
        return native_panels.pending_attempts(body)

    @app.post('/api/v1/native/reconcile')
    def native_reconcile(body: NativeReconcile):
        return native_panels.reconcile(body)

    @app.post('/api/v1/native/index/subscribe')
    def native_index_subscribe(body: IndexLease):
        return native_panels.subscribe_index(body)

    @app.post('/api/v1/native/index/unsubscribe')
    def native_index_unsubscribe(body: IndexLease):
        return native_panels.unsubscribe_index(body.lease_id,body.symbol)

    market_data = MarketData(broker)

    @app.post('/api/v1/data/scanner')
    def scanner(body: ScannerRequest):
        # Keep the existing client's documented convention: ascending=True means largest first.
        return market_data.scan(body.scanner_type, body.count, body.ascending, body.date)

    @app.post('/api/v1/data/volumes')
    def volumes(body: VolumesRequest):
        return market_data.volumes(body.contract.model_dump())

    @app.post("/api/v1/data/snapshots")
    def snapshots(body: dict = Body(...)):
        keys = body.get("contracts", [])
        if not isinstance(keys, list) or len(keys) > 100:
            raise ValueError("單次快照上限 100 筆")
        return [broker.quote(broker.contract(ContractKey.model_validate(key).model_dump())) for key in keys]

    @app.post("/api/v1/data/kbars")
    def kbars(body: dict = Body(...)):
        return broker.kbars(ContractKey.model_validate(body["contract"]).model_dump(), body["start"], body["end"])

    @app.post("/api/v1/research/history")
    def research_history(body: HistoryRequest):
        return load_history(broker, research, body)

    @app.get("/api/v1/automation/state")
    def automation_state(request: Request):
        return automation.snapshot(request.headers.get("authorization", ""))

    @app.get('/api/v1/paper/state')
    def paper_state():
        if cfg.mode != 'paper':
            raise ValueError('本機持久模擬帳簿僅供 paper 模式')
        return broker.paper.overview()

    @app.post("/api/v1/automation/start")
    def automation_start(request: Request, body: AutoConfig):
        with learning.lock:
            if learning.busy():
                raise ValueError('歷史研究工作執行中，完成後才能啟動自動交易')
            return automation.start(body, request.headers.get("authorization", ""))

    @app.post("/api/v1/automation/heartbeat")
    def automation_heartbeat(request: Request, body: AutoHeartbeat):
        return automation.heartbeat(request.headers.get("authorization", ""), body.run_id, body.entries_allowed,body.execution_allowed,request.state.automation_received_at)

    @app.post("/api/v1/automation/control")
    def automation_control(request: Request, body: AutoControl):
        return automation.control(body.command, request.headers.get("authorization", ""), body.run_id, body.acknowledgement,body.execution_allowed)

    @app.get("/api/v1/research/database")
    def research_database():
        return research.stats()

    @app.post("/api/v1/research/latest")
    def research_latest(body: dict = Body(...)):
        return research.latest(str(body.get("datasetId", "")))

    @app.get("/api/v1/research/runs")
    def research_runs():
        return research.runs()

    @app.post("/api/v1/research/runs")
    def save_research_run(body: dict = Body(...)):
        return research.save_run(str(body.get("datasetId", "")), body.get("result", {}))

    @app.get('/api/v1/research/learning')
    def learning_overview():
        return learning.overview()

    @app.get('/api/v1/automation/models')
    def automation_models():
        from .learning_inference import model_choices
        return model_choices(learning.store)

    @app.post('/api/v1/research/learning/collect')
    def learning_collect(body: CollectionRequest):
        return learning.start('collect',body)

    @app.post('/api/v1/research/learning/train')
    def learning_train(body: TrainingRequest):
        return learning.start('train',body)

    @app.post('/api/v1/research/regime/run')
    def regime_run(body: RegimeRequest):
        return learning.start('regime', body)

    @app.get('/api/v1/research/regime/runs')
    def regime_runs():
        return regime_reports.overview()

    @app.get('/api/v1/research/regime/runs/{ident}')
    def regime_report(ident: str):
        return regime_reports.get(ident)

    @app.get('/api/v1/research/learning/runs/{ident}')
    def learning_run(ident: str):
        return learning.store.run(ident)

    @app.get('/api/v1/research/learning/models/{ident}')
    def learning_model(ident: str):
        return dict(format='lightgbm-text',model=learning.store.model(ident))

    @app.post("/api/v1/data/ticks")
    def ticks(body: TicksRequest):
        return broker.ticks(body.contract.model_dump(), body.date.isoformat(), body.last_cnt, all_day=body.query_type == 'AllDay')

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
                # Active quotes must not postpone explicit stream heartbeats.
                next_heartbeat = monotonic()+30
                yield 'retry: 2000\n\n'
                while not switching and session.authorize(request.headers.get("authorization", "")) and not await request.is_disconnected():
                    needed = {sub["kind"] for sub in list(broker.subscriptions.values())} | getattr(broker,'extra_socket_requirements',set())
                    if cfg.mode != "demo" and needed and not needed.issubset(broker.connected_sockets):
                        yield 'event: fubon_connection_status\ndata: {"market_connected":false}\n\n'
                        # Close even when another market continues sending ticks.
                        # Reconnection replays all subscriptions, including the lost feed.
                        break
                    try:
                        remaining = next_heartbeat-monotonic()
                        if remaining <= 0:
                            raise asyncio.TimeoutError
                        item = await asyncio.wait_for(queue.get(), timeout=min(10, remaining))
                        if item is None:
                            break
                        event, data = item
                    except asyncio.TimeoutError:
                        if monotonic() < next_heartbeat:
                            continue
                        needed = {sub["kind"] for sub in list(broker.subscriptions.values())} | getattr(broker,'extra_socket_requirements',set())
                        feed_down = cfg.mode != "demo" and (broker.error or not needed.issubset(broker.connected_sockets))
                        event = "fubon_connection_status" if feed_down else "heartbeat"
                        data = {"time": now().isoformat(), "market_connected": not feed_down}
                        next_heartbeat = monotonic()+30
                    if not session.authorize(request.headers.get("authorization", "")):
                        break
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
        cost=body.paper_cost.model_dump() if body.paper_cost else None
        return broker.place(body.contract.model_dump(),order.model_dump(exclude={"account"}),account,paper_cost=cost)

    @app.post("/api/v1/order/trades")
    def trades(body: dict = Body(...)):
        return broker.order_list(broker.account(body), body.get("refresh", True) is not False)

    @app.post("/api/v1/order/trade_cache_health")
    def cache_health(body: dict = Body(...)):
        account = broker.account(body)
        healthy = not cfg.broker_orders or broker.cache_health.get(account["account_id"], False)
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

    portfolio_data = PortfolioData(broker)

    @app.post('/api/v1/portfolio/profit_loss')
    def profit_loss(body: ProfitLossRequest):
        return portfolio_data.profit_loss(broker.account(body.model_dump()), body.begin_date, body.end_date)

    @app.post('/api/v1/portfolio/profitloss_sum')
    def profit_loss_summary(body: ProfitLossRequest):
        return portfolio_data.summary(broker.account(body.model_dump()), body.begin_date, body.end_date)

    @app.post('/api/v1/portfolio/settlements')
    def settlements(body: dict = Body(...)):
        return portfolio_data.settlements(broker.account(body))

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

    saved_watchlists = watchlist_store or WatchlistStore()
    watchlists = saved_watchlists.load()
    watchlist_lock = threading.RLock()

    def save_watchlists(candidate):
        nonlocal watchlists
        saved_watchlists.save(candidate)
        watchlists = candidate

    def watchlist_key(contract):
        code = contract['code'].strip().upper()
        return (contract.get('security_type') or ('STK' if code.isdigit() else 'FUT'), code)

    @app.get("/api/v1/watchlist")
    def watchlist():
        with watchlist_lock:
            if watchlists is None:
                # Server-side defaults keep the fork independent of Shioaji aliases.
                defaults = dict(id="default", name="台指期與股票", contracts=[
                    broker.contract(dict(code=code, security_type=kind)) for code, kind in
                    [("TMFR1", "FUT"), ("TXFR1", "FUT"), ("MXFR1", "FUT"), ("2330", "STK")]])
                save_watchlists({'default': defaults})
            return deepcopy(list(watchlists.values()))

    @app.post("/api/v1/watchlist")
    def create_watchlist(body: dict = Body(...)):
        with watchlist_lock:
            ident = uuid.uuid4().hex
            candidate = deepcopy(watchlists or {})
            candidate[ident] = dict(id=ident, name=str(body["name"])[:100], contracts=body.get("contracts", []))
            save_watchlists(candidate)
            return deepcopy(watchlists[ident])

    @app.put("/api/v1/watchlist/{ident}")
    def sync_watchlist(ident: str, body: dict = Body(...)):
        with watchlist_lock:
            if not watchlists or ident not in watchlists:
                raise HTTPException(404, "自選清單不存在")
            candidate = deepcopy(watchlists)
            if 'contracts' in body:
                candidate[ident]["contracts"] = body['contracts']
            if 'name' in body:
                candidate[ident]['name'] = str(body['name'])[:100]
            save_watchlists(candidate)
            return deepcopy(watchlists[ident])

    @app.post("/api/v1/watchlist/{ident}/contracts")
    def add_watchlist_contracts(ident: str, body: WatchlistContracts):
        with watchlist_lock:
            if not watchlists or ident not in watchlists:
                raise HTTPException(404, "自選清單不存在")
            # Resolve the entire batch before changing membership; a failed
            # lookup must not leave a partially added list.
            additions = [broker.contract(key.model_dump(exclude_none=True)) for key in body.contracts]
            candidate = deepcopy(watchlists)
            contracts = candidate[ident]['contracts']
            seen = {watchlist_key(contract) for contract in contracts}
            for contract in additions:
                key = watchlist_key(contract)
                if key not in seen:
                    contracts.append({field: contract[field] for field in ('code', 'security_type', 'exchange')})
                    seen.add(key)
            save_watchlists(candidate)
            return deepcopy(watchlists[ident])

    @app.delete("/api/v1/watchlist/{ident}/contracts")
    def remove_watchlist_contracts(ident: str, body: WatchlistContracts):
        with watchlist_lock:
            if not watchlists or ident not in watchlists:
                raise HTTPException(404, "自選清單不存在")
            removed = {watchlist_key(key.model_dump()) for key in body.contracts}
            candidate = deepcopy(watchlists)
            candidate[ident]['contracts'] = [contract for contract in watchlists[ident]['contracts']
                                            if watchlist_key(contract) not in removed]
            save_watchlists(candidate)
            return deepcopy(watchlists[ident])

    @app.delete("/api/v1/watchlist/{ident}")
    def delete_watchlist(ident: str):
        with watchlist_lock:
            candidate = deepcopy(watchlists or {})
            candidate.pop(ident, None)
            save_watchlists(candidate)
            return {"success": True}

    @app.api_route("/api/{path:path}", methods=["GET", "POST", "PUT", "DELETE"])
    def unsupported(path: str):
        raise HTTPException(501, "此功能尚未完成富邦 API 轉接")

    if (ROOT / "dist").is_dir():
        app.mount("/", StaticFiles(directory=ROOT / "dist", html=True), name="terminal")
    return app
