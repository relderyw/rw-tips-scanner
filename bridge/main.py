"""API REST + WebSocket da ponte RW TIPS Scanner ↔ IQ Option.

Endpoints REST (isolados pelo token temporário da sessão IQ):
  POST /session {"email":"...","password":"..."} → real IQ session token (read-only)
  DELETE /session → disconnects only that session
  GET /account → current real-account balance
  GET /positions?limit=100 → recent real-account option entries
  GET /actives → currently open binary-option assets and IQ payouts
  GET /candles?asset=EURUSD&tf=M5&hours=24
      → [ {time, open, high, low, close} ]  (time = segundos unix da ABERTURA)
  GET /payouts → { "EURUSD": 87, ... } for continuously streamed panel assets
  GET /health  → schema ESTENDIDO (ver collector.health_snapshot())

Endpoints WebSocket:
  GET /ws  (upgrade HTTP → WS)
      Cliente deve enviar, em ATÉ 5 segundos, a primeira mensagem:
          {"type":"auth","token":"<session-token>"}
      Se inválido ou não enviado a tempo: servidor fecha conexão close code 4401.
      Depois de autenticado, servidor envia:
        • a cada WS_HEALTH_INTERVAL (~5s): {"type":"health", ...} (mesmo payload de /health)
        • assim que uma vela fecha e é persistida: {"type":"candle","asset":"EURUSD","tf":"M5",
                                                     "candle":{time, open, high, low, close}}
      Cada cliente tem fila de 100 msgs pendentes; se encher → cliente é desconectado
      close code 4000 ("client slow"). Um cliente lento NÃO trava os outros.

Executar local:
  cd bridge
  uvicorn main:app --host 0.0.0.0 --port 8000 --reload
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import sys
import threading
import time
from collections import deque
from contextlib import asynccontextmanager
from typing import Dict, Literal, Set

from fastapi import Depends, FastAPI, HTTPException, Query, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

# ---------------------------------------------------------------------------
# Garante que `import config`, `import db`, `import collector`, etc. funcionem
# tanto rodando `python main.py` (direto) quanto `uvicorn main:app`.
# ---------------------------------------------------------------------------
_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)
_PARENT = os.path.dirname(_HERE)
if _PARENT not in sys.path:
    sys.path.insert(0, _PARENT)  # para importar iqoptionapi.*

import config  # noqa: E402
import db  # noqa: E402
import admin_auth  # noqa: E402
import telegram_notifications  # noqa: E402
from sessions import UserSession, session_manager  # noqa: E402

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
log = logging.getLogger("bridge")

bearer = HTTPBearer(auto_error=False)


# ===================================================================
# REST authentication: Bearer token from an active IQ session.
# ===================================================================
def require_iq_session(cred: HTTPAuthorizationCredentials = Depends(bearer)):
    session = session_manager.get(cred.credentials if cred else "")
    if session is None:
        raise HTTPException(status_code=401, detail="Conecte sua conta IQ Option para continuar.")
    return session


# ===================================================================
# Gerenciamento de clientes WebSocket (conectados e autenticados)
# ===================================================================
# Cada cliente ativo: WebSocket objeto + deque(maxlen=100) de mensagens pendentes.
_active_clients: Dict[int, "WsClient"] = {}
_next_client_id: int = 0
# Lock asyncio para proteger _active_clients de acesso concorrente.
_clients_lock: asyncio.Lock = asyncio.Lock()
_login_attempts: Dict[str, deque] = {}
_login_attempts_lock = threading.Lock()


class WsClient:
    """1 cliente WS autenticado. Tem sua própria fila limitada de msgs pendentes."""

    QUEUE_MAX = 100
    AUTH_TIMEOUT_SECONDS = 5.0

    def __init__(self, client_id: int, ws: WebSocket):
        self.client_id = client_id
        self.ws = ws
        self.authenticated: bool = False
        self.session_token: str = ""
        self.session: UserSession | None = None
        self.pending: deque = deque(maxlen=self.QUEUE_MAX)
        # Evento sinalizado quando há itens novos para enviar.
        self.has_data: asyncio.Event = asyncio.Event()
        # Flag que o writer loop lê para encerrar.
        self.disconnected: bool = False
        self.dropped_count: int = 0  # msgs descartadas por encher a fila (cliente lento)

    def enqueue_msg(self, msg_obj: dict) -> bool:
        """Coloca uma mensagem na fila; se a fila estiver cheia → descarta a mais antiga
        e incrementa dropped_count. Quando dropped_count > 0 duas vezes seguidas
        consideramos o cliente "lento" e ele será desconectado.

        Retorna True se o cliente deve ser desconectado (lento).
        """
        if self.pending.maxlen and len(self.pending) == self.pending.maxlen:
            self.pending.popleft()
            self.dropped_count += 1
        self.pending.append(msg_obj)
        self.has_data.set()
        # Cliente lento: mais de QUEUE_MAX*2 msgs dropadas = desconectar.
        return self.dropped_count > self.QUEUE_MAX * 2

    def pop_msg(self):
        try:
            return self.pending.popleft()
        except IndexError:
            self.has_data.clear()
            return None


# ===================================================================
# Lifespan do FastAPI: inicializa DB, inicia collector, cria tasks
#   - broadcast_worker: lê collector.broadcast_queue (sync queue) e
#     distribui para cada cliente autenticado.
#   - health_pusher: a cada WS_HEALTH_INTERVAL envia mensagem type=health.
# ===================================================================
@asynccontextmanager
async def lifespan(_app: FastAPI):
    # --- Startup ---
    loop = asyncio.get_running_loop()
    # Salva referência pro loop: a thread do collector usa
    # asyncio.run_coroutine_threadsafe para "acordar" o worker.
    lifespan.state = {}  # type: ignore
    lifespan.state["loop"] = loop  # type: ignore

    tasks: Set[asyncio.Task] = set()
    t_broadcast = asyncio.create_task(_broadcast_worker_loop(), name="ws-broadcast-worker")
    t_health = asyncio.create_task(_health_pusher_loop(), name="ws-health-pusher")
    t_expire = asyncio.create_task(_session_expiry_loop(), name="session-expiry-worker")
    tasks.update({t_broadcast, t_health, t_expire})

    yield

    # --- Shutdown ---
    log.info("Shutdown lifespan: parando sessões IQ e tasks de WS…")
    for session in session_manager.all_sessions():
        try:
            await asyncio.to_thread(session_manager.disconnect, session.token)
        except Exception as e:  # noqa: BLE001
            log.warning("Falha ao encerrar sessão IQ: %s", e)
    for t in tasks:
        t.cancel()
    await asyncio.gather(*tasks, return_exceptions=True)
    # Fecha todos WS clientes que ainda estavam vivos (com close code normal).
    async with _clients_lock:
        for c in list(_active_clients.values()):
            try:
                await c.ws.close(code=1001, reason="server shutting down")
            except Exception:
                pass
        _active_clients.clear()
    log.info("Lifespan encerrado.")


async def _broadcast_worker_loop():
    """Lê filas de candles por usuário e transmite somente à sessão proprietária.

    Polling 50ms sobre queue.get_nowait() + run_coroutine_threadsafe para acordar
    imediatamente quando a thread do collector publicar. Em vez de busy-wait,
    usamos sleep curto (0.05s) + verificação rápida: responsivo e leve.
    """
    log.info("broadcast-worker iniciado.")
    while True:
        try:
            batched: list = []
            for session in session_manager.all_sessions():
                for _ in range(100):
                    try:
                        item = session.collector.broadcast_queue.get_nowait()
                    except Exception:
                        break
                    item["session_id"] = session.token
                    batched.append(item)
            if batched:
                await _distribute_broadcast_batch(batched)
            await asyncio.sleep(0.05)
        except asyncio.CancelledError:
            break
        except Exception as e:  # noqa: BLE001
            log.error("broadcast-worker erro não fatal: %s", e)
            await asyncio.sleep(0.25)


async def _distribute_broadcast_batch(batch: list) -> None:
    """Distribui 1 lote de msgs do collector.broadcast_queue para todos clientes."""
    drop_clients: list = []
    async with _clients_lock:
        clients_snapshot = list(_active_clients.values())
    for client in clients_snapshot:
        if not client.authenticated or client.disconnected:
            continue
        for item in batch:
            if item.get("session_id") != client.session_token:
                continue
            # Item do collector.broadcast_queue tem "kind".
            kind = item.get("kind")
            if kind == "candle":
                # Transforma no contrato do WS.
                ws_msg = {
                    "type": "candle",
                    "asset": item["asset"],
                    "tf": item["tf"],
                    "candle": dict(item["candle"]),
                }
            else:
                # Outros tipos (futuro).
                continue
            if client.enqueue_msg(ws_msg):
                drop_clients.append(client)
    for c in drop_clients:
        await _drop_slow_client(c)


async def _drop_slow_client(c: WsClient) -> None:
    """Desconecta um cliente lento, com close code 4000."""
    if c.disconnected:
        return
    c.disconnected = True
    log.warning("Cliente WS %d desconectado por estar lento (%d msgs dropadas).",
                c.client_id, c.dropped_count)
    async with _clients_lock:
        _active_clients.pop(c.client_id, None)
    try:
        await c.ws.close(code=4000, reason="client slow")
    except Exception:
        pass


async def _health_pusher_loop():
    """Envia o health de cada IQ session apenas aos seus clientes."""
    log.info("health-pusher iniciado (intervalo %ds).", config.WS_HEALTH_INTERVAL)
    while True:
        try:
            for session in session_manager.all_sessions():
                snapshot = session.collector.health_snapshot()
                msg = {"type": "health", **snapshot}
                async with _clients_lock:
                    clients_snapshot = [
                        client for client in _active_clients.values()
                        if client.session_token == session.token
                    ]
                for client in clients_snapshot:
                    if not client.authenticated or client.disconnected:
                        continue
                    if client.enqueue_msg(dict(msg)):
                        await _drop_slow_client(client)
            await asyncio.sleep(config.WS_HEALTH_INTERVAL)
        except asyncio.CancelledError:
            break
        except Exception as e:  # noqa: BLE001
            log.error("health-pusher loop erro: %s", e)
            await asyncio.sleep(1.0)


async def _session_expiry_loop():
    while True:
        try:
            expired_tokens = await asyncio.to_thread(session_manager.expire_idle)
            if expired_tokens:
                async with _clients_lock:
                    expired_clients = [
                        client.client_id for client in _active_clients.values()
                        if client.session_token in expired_tokens
                    ]
                for client_id in expired_clients:
                    await _cleanup_client(client_id)
            await asyncio.sleep(60)
        except asyncio.CancelledError:
            break
        except Exception as exc:  # noqa: BLE001
            log.error("Session expiry worker failed: %s", exc)
            await asyncio.sleep(5)


# ===================================================================
# App FastAPI + middleware CORS
# ===================================================================
app = FastAPI(title="RW TIPS Bridge (tempo real IQ Option)", lifespan=lifespan)

# CORS: apenas origens permitidas. WebSocket upgrade respeita Origin.
app.add_middleware(
    CORSMiddleware,
    allow_origins=config.CORS_ORIGINS,
    allow_methods=["GET", "POST", "PUT", "DELETE"],
    allow_headers=["Authorization", "Content-Type"],
)


@app.get("/")
def root():
    return {"status": "ok", "app": "RW TIPS Bridge", "version": "1.0.0"}


@app.get("/ping")
def ping():
    return {"ping": "pong"}


# ===================================================================
# IQ account sessions and per-user market data
# ===================================================================
class IQLoginRequest(BaseModel):
    email: str = Field(min_length=3, max_length=254)
    password: str = Field(min_length=1, max_length=512)


class TelegramSignalRequest(BaseModel):
    signal_id: str = Field(min_length=1, max_length=256, pattern=r"^[\w|:/.\- ]+$")
    strategy: str = Field(min_length=1, max_length=120)
    asset: str = Field(min_length=1, max_length=64)
    direction: Literal["CALL", "PUT"]
    timeframe: Literal["M1", "M5"]
    signal_time: str = Field(pattern=r"^(?:[01]\d|2[0-3]):[0-5]\d$")
    message_text: str | None = Field(default=None, max_length=4096)


class TelegramSignalResultRequest(BaseModel):
    signal_id: str = Field(min_length=1, max_length=256, pattern=r"^[\w|:/.\- ]+$")
    outcome: Literal["WIN", "LOSS"]


@app.post("/session")
async def create_session(payload: IQLoginRequest, request: Request):
    if "@" not in payload.email or payload.email.startswith("@") or payload.email.endswith("@"):
        raise HTTPException(status_code=422, detail="Informe um e-mail válido.")
    client_ip = request.client.host if request.client else "unknown"
    now = time.monotonic()
    with _login_attempts_lock:
        attempts = _login_attempts.setdefault(client_ip, deque())
        while attempts and now - attempts[0] > 60:
            attempts.popleft()
        if len(attempts) >= 5:
            raise HTTPException(status_code=429, detail="Muitas tentativas. Aguarde um minuto e tente novamente.")
        attempts.append(now)
    try:
        session = await asyncio.to_thread(
            session_manager.create, payload.email, payload.password
        )
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except TimeoutError as exc:
        raise HTTPException(status_code=504, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        log.warning("IQ login failed (%s).", type(exc).__name__)
        raise HTTPException(
            status_code=502,
            detail="A IQ Option não aceitou a conexão. Confira o login, a senha e tente novamente.",
        ) from exc
    return {
        "token": session.token,
        "email": session.email,
        "connected": session.collector.connected,
        "account_type": session.collector.account_type,
        "read_only": True,
    }


@app.get("/session")
def current_session(session: UserSession = Depends(require_iq_session)):
    return {
        "email": session.email,
        "connected": bool(session.collector.connected),
        "account_type": session.collector.account_type,
        "read_only": True,
    }


@app.delete("/session")
async def disconnect_session(session: UserSession = Depends(require_iq_session)):
    await asyncio.to_thread(session_manager.disconnect, session.token)
    async with _clients_lock:
        clients = [
            client for client in _active_clients.values()
            if client.session_token == session.token
        ]
    for client in clients:
        await _cleanup_client(client.client_id)
    return {"disconnected": True}


@app.get("/candles")
def candles(
    asset: str,
    tf: str = Query("M1"),
    hours: int = Query(24, ge=1, le=720),
    session: UserSession = Depends(require_iq_session),
):
    """Returns closed candles only for the authenticated IQ account."""
    if tf not in session.collector.timeframes:
        raise HTTPException(status_code=400, detail="asset ou tf inválido")
    if asset not in config.ASSET_IDS:
        try:
            return session.collector.binary_option_candles(asset, tf, hours)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except ConnectionError as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc
    return db.query(asset, tf, hours, session.collector.db_path)


@app.get("/actives")
def binary_option_actives(session: UserSession = Depends(require_iq_session)):
    """Returns currently open binary-option assets from the connected IQ account."""
    try:
        return session.collector.binary_option_actives()
    except ConnectionError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@app.get("/payouts")
def payouts(session: UserSession = Depends(require_iq_session)):
    return dict(session.collector.payouts)


@app.post("/telegram/signal")
def send_telegram_signal(
    payload: TelegramSignalRequest,
    session: UserSession = Depends(require_iq_session),
):
    try:
        sent = telegram_notifications.send_signal(
            signal_id=payload.signal_id,
            owner_id=session.identity_hash,
            strategy=payload.strategy,
            asset=payload.asset,
            direction=payload.direction,
            timeframe=payload.timeframe,
            signal_time=payload.signal_time,
            message_text=payload.message_text,
        )
    except telegram_notifications.TelegramConfigurationError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except telegram_notifications.TelegramDeliveryError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return {"sent": sent, "duplicate": not sent}


@app.get("/telegram/stats")
def telegram_session_stats(session: UserSession = Depends(require_iq_session)):
    """Retorna os greens/reds acumulados da sessão do usuário."""
    return telegram_notifications.get_session_stats(session.identity_hash)


@app.get("/telegram/status")
def telegram_status(session: UserSession = Depends(require_iq_session)):
    return telegram_notifications.get_status()


@app.put("/telegram/signal/result")
def update_telegram_signal_result(
    payload: TelegramSignalResultRequest,
    session: UserSession = Depends(require_iq_session),
):
    try:
        updated = telegram_notifications.update_signal_result(
            signal_id=payload.signal_id,
            owner_id=session.identity_hash,
            outcome=payload.outcome,
        )
    except telegram_notifications.TelegramConfigurationError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except telegram_notifications.TelegramDeliveryError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return {"updated": updated, "duplicate": not updated}


@app.get("/health")
def health(session: UserSession = Depends(require_iq_session)):
    return session.collector.health_snapshot()


@app.get("/account")
def account_overview(session: UserSession = Depends(require_iq_session)):
    try:
        return session.collector.account_overview()
    except ConnectionError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except TimeoutError as exc:
        raise HTTPException(status_code=504, detail=str(exc)) from exc
    except LookupError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


def _position_for_api(position: dict) -> dict:
    def first_value(*keys):
        value = next((position[key] for key in keys if position.get(key) is not None), None)
        if isinstance(value, dict):
            return next(
                (value[key] for key in ("name", "ticker", "symbol", "id")
                 if isinstance(value.get(key), (str, int, float))),
                None,
            )
        return value if isinstance(value, (str, int, float, bool)) else None

    return {
        "id": first_value("id", "position_id", "order_id", "external_id"),
        "asset": first_value("instrument_underlying", "underlying", "active_name", "asset_name"),
        "asset_id": first_value("active_id"),
        "direction": first_value("direction", "side", "option_type", "action"),
        "status": first_value("status"),
        "instrument_type": first_value("instrument_type"),
        "amount": first_value("invest", "amount"),
        "profit": first_value("pnl_net", "close_profit", "profit_amount"),
        "open_time": first_value("open_time", "created_at"),
        "close_time": first_value("close_time", "closed_at"),
    }


@app.get("/positions")
def positions(
    limit: int = Query(100, ge=1, le=300),
    session: UserSession = Depends(require_iq_session),
):
    try:
        history = session.collector.position_history(limit)
    except ConnectionError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except TimeoutError as exc:
        raise HTTPException(status_code=504, detail=str(exc)) from exc
    if not isinstance(history, list) or any(not isinstance(item, dict) for item in history):
        raise HTTPException(status_code=502, detail="A IQ Option retornou um formato inválido para o histórico.")
    return [_position_for_api(item) for item in history]


class AdminUserRequest(BaseModel):
    email: str = Field(min_length=3, max_length=254)
    password: str = Field(min_length=6, max_length=128)
    days: int = Field(ge=1, le=3650)


@app.post("/admin/users", status_code=201)
def create_admin_user(
    payload: AdminUserRequest,
    cred: HTTPAuthorizationCredentials = Depends(bearer),
):
    if cred is None:
        raise HTTPException(status_code=401, detail="Autentique-se para continuar.")
    admin_auth.require_admin(cred.credentials)
    return admin_auth.create_limited_user(
        payload.email,
        payload.password,
        payload.days,
    )


# ===================================================================
# WebSocket endpoint /ws
# ===================================================================
@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket):
    """Upgrade /ws → handshakes → auth (primeira mensagem com token de sessão) → streaming.

    Falha de auth → close 4401. Cliente lento → close 4000.
    """
    global _next_client_id
    # 1) Aceita upgrade.
    origin_ok = True
    origin = ws.headers.get("origin")
    if origin and config.CORS_ORIGINS:
        origin_ok = any(o.strip("/") == origin.strip("/") for o in config.CORS_ORIGINS)
    if not origin_ok:
        log.info("WS upgrade rejeitado: CORS origin=%s não permitido.", origin)
        await ws.close(code=4403, reason="forbidden origin")
        return
    await ws.accept()

    # 2) Aloca cliente não autenticado.
    async with _clients_lock:
        cid = _next_client_id
        _next_client_id += 1
        client = WsClient(cid, ws)
        _active_clients[cid] = client
    log.info("WS cliente %d conectado, aguardando auth…", cid)

    # 3) Espera primeira mensagem de auth em AUTH_TIMEOUT_SECONDS.
    auth_start = time.monotonic()
    auth_done = asyncio.Event()

    # Task auxiliar: deadline de auth.
    async def auth_deadline():
        try:
            await asyncio.sleep(WsClient.AUTH_TIMEOUT_SECONDS)
            if not auth_done.is_set():
                log.warning("WS cliente %d: timeout auth.", cid)
                await ws.close(code=4401, reason="auth timeout")
                await _cleanup_client(cid)
        except asyncio.CancelledError:
            pass

    deadline_task = asyncio.create_task(auth_deadline())
    writer_task: asyncio.Task | None = None
    try:
        while not auth_done.is_set():
            elapsed = time.monotonic() - auth_start
            if elapsed > WsClient.AUTH_TIMEOUT_SECONDS:
                return
            try:
                raw = await asyncio.wait_for(ws.receive_text(), timeout=WsClient.AUTH_TIMEOUT_SECONDS - elapsed)
            except (TimeoutError, WebSocketDisconnect, asyncio.TimeoutError):
                return
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                log.info("WS cliente %d: primeira msg não é JSON.", cid)
                await ws.close(code=4401, reason="invalid auth message")
                return
            if isinstance(msg, dict) and msg.get("type") == "auth":
                token = msg.get("token")
                session = session_manager.get(token) if isinstance(token, str) else None
                if session is not None:
                    client.authenticated = True
                    client.session_token = session.token
                    client.session = session
                    auth_done.set()
                    log.info("WS cliente %d autenticado OK.", cid)
                    break
                else:
                    log.warning("WS cliente %d: sessão inválida.", cid)
                    await ws.close(code=4401, reason="invalid session")
                    return
            else:
                log.info("WS cliente %d: primeira msg não é auth (type=%s).", cid, msg.get("type"))
                await ws.close(code=4401, reason="expected auth first")
                return
    finally:
        deadline_task.cancel()
        try:
            await deadline_task
        except (asyncio.CancelledError, Exception):
            pass
        if not client.authenticated:
            await _cleanup_client(cid)

    # 4) Autenticado: inicia task "writer" por cliente (pega da fila e envia no ws).
    writer_task = asyncio.create_task(_client_writer_loop(client), name=f"ws-writer-{cid}")
    # Envia 1 health imediatamente para o cliente.
    try:
        h = client.session.collector.health_snapshot()
        if client.enqueue_msg({"type": "health", **h}):
            await _drop_slow_client(client)
    except Exception as exc:  # noqa: BLE001
        log.error("Não foi possível enviar health inicial ao cliente WS %d: %s", cid, exc)

    # 5) Lê mensagens do cliente (ping/keepalive). Nós não esperamos msgs do cliente,
    # mas recebê-las é necessário para detectar close/disconnect do lado deles.
    try:
        while not client.disconnected:
            try:
                data = await ws.receive()
            except WebSocketDisconnect:
                break
            # Receive devolve dict com 'type': 'bytes'/'text'/'disconnect'.
            if data.get("type") == "disconnect":
                break
            # Qualquer outra mensagem: ignoramos (não fazemos broadcast cliente→servidor).
            await asyncio.sleep(0.01)
    finally:
        await _cleanup_client(cid, writer_task)


async def _client_writer_loop(client: WsClient) -> None:
    """Task por cliente: envia msgs da sua fila pro socket.

    Isso desacopla o cliente lento do broadcast: o enqueue já é não-bloqueante
    e só 1 task por cliente trava nesse websocket.
    """
    try:
        while not client.disconnected:
            # Espera evento (tem msg para enviar).
            await client.has_data.wait()
            msg = client.pop_msg()
            while msg is not None:
                try:
                    await client.ws.send_json(msg)
                except WebSocketDisconnect:
                    client.disconnected = True
                    return
                except RuntimeError:
                    # WebSocket já está closed no objeto.
                    client.disconnected = True
                    return
                msg = client.pop_msg()
    except asyncio.CancelledError:
        pass
    except Exception as e:  # noqa: BLE001
        log.error("client_writer_loop %d erro (cliente será desconectado): %s",
                  client.client_id, e)
        client.disconnected = True


async def _cleanup_client(cid: int, writer_task: asyncio.Task | None = None) -> None:
    """Remove cliente da lista e cancela task writer se existir."""
    client = None
    async with _clients_lock:
        client = _active_clients.pop(cid, None)
    if client is None:
        return
    client.disconnected = True
    if writer_task is not None and not writer_task.done():
        writer_task.cancel()
        try:
            await asyncio.wait_for(writer_task, timeout=1.0)
        except Exception:
            pass
    try:
        await client.ws.close(code=1000, reason="bye")
    except Exception:
        pass
    log.info("WS cliente %d removido (cleanup).", cid)
