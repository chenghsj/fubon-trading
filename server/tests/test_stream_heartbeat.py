import asyncio
from datetime import datetime
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

import fubon_bridge.app as app_module
from fubon_bridge.app import create_app
from fubon_bridge.config import Config
from fubon_bridge.passkeys import PasskeyStore


def stream_fixture(tmp_path, monkeypatch, clock, config=None):
    monkeypatch.setattr(app_module,'monotonic',lambda:clock[0])
    app=create_app(config or Config(),passkey_store=PasskeyStore(tmp_path/'passkeys.sqlite3'))
    monkeypatch.setattr(app.state.broker,'demo_events',lambda:None)
    monkeypatch.setattr(app.state.broker,'refresh_market_sessions',lambda:None)
    token=app.state.session.issue()
    request=SimpleNamespace(headers={'authorization':'Bearer '+token},is_disconnected=AsyncMock(return_value=False))
    endpoint=next(r.endpoint for r in app.routes if getattr(r,'path','')=='/api/v1/stream/data')
    return app,request,endpoint


def test_busy_market_emits_periodic_heartbeats_without_losing_queued_ticks(tmp_path,monkeypatch):
    async def scenario():
        clock=[0.]
        app,request,endpoint=stream_fixture(tmp_path,monkeypatch,clock)
        async with app.router.lifespan_context(app):
            response=await endpoint(request)
            stream=response.body_iterator
            assert await anext(stream)=='retry: 2000\n\n'
            for at in (1,5,15,29):
                clock[0]=at
                payload=dict(code='TMFK6',close=39800+at,datetime='2026-11-18T02:30:00+08:00')
                app.state.broker.emit('tick_fop_v1',payload)
                await asyncio.sleep(0)
                assert json.loads((await anext(stream)).split('data: ')[1])==payload
            clock[0]=30
            pending=dict(code='TMFK6',close=39830,datetime='2026-11-18T02:30:30+08:00')
            app.state.broker.emit('tick_fop_v1',pending)
            await asyncio.sleep(0)
            heartbeat=await anext(stream)
            assert heartbeat.startswith('event: heartbeat\n')
            data=json.loads(heartbeat.split('data: ')[1])
            assert data['market_connected'] is True
            assert datetime.fromisoformat(data['time']).tzinfo is not None
            assert json.loads((await anext(stream)).split('data: ')[1])==pending
            clock[0]=60
            assert (await anext(stream)).startswith('event: heartbeat\n')
            await stream.aclose()
    asyncio.run(scenario())


def test_idle_health_polls_do_not_advance_the_heartbeat_deadline(tmp_path,monkeypatch):
    async def scenario():
        clock=[0.]
        app,request,endpoint=stream_fixture(tmp_path,monkeypatch,clock)
        waits=[]
        async def timeout(awaitable,timeout):
            awaitable.close()
            waits.append(timeout)
            clock[0]+=timeout
            raise asyncio.TimeoutError
        async with app.router.lifespan_context(app):
            monkeypatch.setattr(app_module.asyncio,'wait_for',timeout)
            stream=(await endpoint(request)).body_iterator
            await anext(stream)
            assert (await anext(stream)).startswith('event: heartbeat\n')
            assert waits==[10,10,10] and clock[0]==30
            await stream.aclose()
    asyncio.run(scenario())


def test_revocation_before_due_heartbeat_stops_stream(tmp_path,monkeypatch):
    async def scenario():
        clock=[0.]
        app,request,endpoint=stream_fixture(tmp_path,monkeypatch,clock)
        async with app.router.lifespan_context(app):
            stream=(await endpoint(request)).body_iterator
            await anext(stream)
            clock[0]=30
            app.state.session.revoke(request.headers['authorization'])
            with pytest.raises(StopAsyncIteration):
                await anext(stream)
    asyncio.run(scenario())


def test_feed_requirement_added_during_wait_cannot_emit_healthy_heartbeat(tmp_path,monkeypatch):
    async def scenario():
        clock=[0.]
        app,request,endpoint=stream_fixture(tmp_path,monkeypatch,clock,Config(mode='paper'))
        app.state.broker.connected_sockets={'stock'}
        app.state.broker.extra_socket_requirements=set()
        async def timeout(awaitable,timeout):
            awaitable.close()
            clock[0]+=timeout
            if clock[0]>=30:
                app.state.broker.extra_socket_requirements={'futopt'}
            raise asyncio.TimeoutError
        async with app.router.lifespan_context(app):
            monkeypatch.setattr(app_module.asyncio,'wait_for',timeout)
            stream=(await endpoint(request)).body_iterator
            await anext(stream)
            event=await anext(stream)
            assert event.startswith('event: fubon_connection_status\n')
            assert json.loads(event.split('data: ')[1])['market_connected'] is False
            await stream.aclose()
    asyncio.run(scenario())
