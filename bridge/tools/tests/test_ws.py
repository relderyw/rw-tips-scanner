"""Teste isolado do protocolo WebSocket, sem IQ Option ou servidor externo."""
from __future__ import annotations

import asyncio
import json
import os
import queue
import sys
from types import SimpleNamespace

_HERE = os.path.dirname(os.path.abspath(__file__))
_TOOLS = os.path.dirname(_HERE)
_BRIDGE = os.path.dirname(_TOOLS)
_REPO = os.path.dirname(_BRIDGE)
for _path in (_BRIDGE, _REPO, _TOOLS):
    if _path not in sys.path:
        sys.path.insert(0, _path)

os.environ["API_KEY"] = "CHAVE_TESTE_12345"
os.environ["IQ_EMAIL"] = ""
os.environ["IQ_PASSWORD"] = ""

import config  # noqa: E402
import main  # noqa: E402
class FakeWebSocket:
    def __init__(self, token: str):
        self.headers = {}
        self._auth_message = json.dumps({"type": "auth", "token": token})
        self._client_closed = asyncio.Event()
        self.sent = asyncio.Queue()
        self.close_code = None

    async def accept(self):
        return None

    async def receive_text(self):
        return self._auth_message

    async def receive(self):
        await self._client_closed.wait()
        return {"type": "disconnect"}

    async def send_json(self, message):
        await self.sent.put(message)

    async def close(self, code=1000, reason=""):
        if self.close_code is None:
            self.close_code = code
        self._client_closed.set()

    def disconnect_from_client(self):
        self._client_closed.set()


async def _test_websocket() -> int:
    first_collector = SimpleNamespace(
        broadcast_queue=queue.Queue(),
        health_snapshot=lambda: {"connected": True, "session": "first"},
    )
    second_collector = SimpleNamespace(
        broadcast_queue=queue.Queue(),
        health_snapshot=lambda: {"connected": True, "session": "second"},
    )
    first_session = SimpleNamespace(token="session-first", collector=first_collector)
    second_session = SimpleNamespace(token="session-second", collector=second_collector)
    sessions = {first_session.token: first_session, second_session.token: second_session}
    old_get = main.session_manager.get
    old_all_sessions = main.session_manager.all_sessions
    main.session_manager.get = lambda token: sessions.get(token)
    main.session_manager.all_sessions = lambda: list(sessions.values())

    # Token inválido deve fechar com 4401 e não deixar cliente pendurado.
    wrong = FakeWebSocket("chave-incorreta")
    await main.websocket_endpoint(wrong)
    if wrong.close_code != 4401:
        raise AssertionError(f"Esperava close 4401, recebi {wrong.close_code}")
    if main._active_clients:
        raise AssertionError("Cliente não autenticado permaneceu registrado.")
    print("OK: token inválido fechado com 4401; cliente removido.")

    # Cada sessão deve receber apenas candles da própria conta.
    ws_first = FakeWebSocket(first_session.token)
    ws_second = FakeWebSocket(second_session.token)
    endpoint_first = asyncio.create_task(main.websocket_endpoint(ws_first))
    endpoint_second = asyncio.create_task(main.websocket_endpoint(ws_second))
    try:
        health_first = await asyncio.wait_for(ws_first.sent.get(), timeout=2)
        health_second = await asyncio.wait_for(ws_second.sent.get(), timeout=2)
        if health_first.get("session") != "first" or health_second.get("session") != "second":
            raise AssertionError("Cada WebSocket precisa receber o health da própria conta.")
        print("OK: health é isolado por sessão.")

        await main._distribute_broadcast_batch([{
            "kind": "candle",
            "session_id": first_session.token,
            "asset": "EURUSD",
            "tf": "M1",
            "candle": {
                "time": 1730000000,
                "open": 1.08,
                "high": 1.09,
                "low": 1.07,
                "close": 1.085,
            },
        }])
        candle = await asyncio.wait_for(ws_first.sent.get(), timeout=2)
        if candle.get("type") != "candle" or candle.get("asset") != "EURUSD":
            raise AssertionError(f"Payload candle inesperado: {candle}")
        if not ws_second.sent.empty():
            raise AssertionError("Candle de uma conta foi transmitido para outra.")
        print("OK: broadcast de candles isolado por conta.")
    finally:
        ws_first.disconnect_from_client()
        ws_second.disconnect_from_client()
        await asyncio.wait_for(asyncio.gather(endpoint_first, endpoint_second), timeout=2)
        main.session_manager.get = old_get
        main.session_manager.all_sessions = old_all_sessions

    return 0


def main_test() -> int:
    return asyncio.run(_test_websocket())


if __name__ == "__main__":
    sys.exit(main_test())
