"""Isolated, in-memory IQ Option sessions for web-app users."""
from __future__ import annotations

import hashlib
import os
import secrets
import threading
import time
from dataclasses import dataclass
from typing import Dict, Optional

import sys

_BRIDGE_DIR = os.path.dirname(os.path.abspath(__file__))
if _BRIDGE_DIR not in sys.path:
    sys.path.insert(0, _BRIDGE_DIR)
_ROOT_DIR = os.path.abspath(os.path.join(_BRIDGE_DIR, ".."))
if _ROOT_DIR not in sys.path:
    sys.path.insert(0, _ROOT_DIR)

try:
    import config
    import db
    from collector import Collector
    import signal_scanner
except ImportError:
    from bridge import config
    from bridge import db
    from bridge.collector import Collector
    from bridge import signal_scanner

SESSION_TIMEFRAMES = config.TIMEFRAMES
SESSION_BACKFILL_HOURS = 14
SESSION_IDLE_SECONDS = 15 * 60
CONNECT_TIMEOUT_SECONDS = 60


@dataclass
class UserSession:
    token: str
    email: str
    identity_hash: str
    collector: Collector
    last_used: float


class IQSessionManager:
    def __init__(self) -> None:
        self._sessions: Dict[str, UserSession] = {}
        self._identity_to_token: Dict[str, str] = {}
        self._lock = threading.RLock()

    def create(self, email: str, password: str, account_type: str = "PRACTICE") -> UserSession:
        normalized_email = email.strip().casefold()
        if not normalized_email or not password:
            raise ValueError("Informe o e-mail e a senha da IQ Option.")

        identity_hash = hashlib.sha256(normalized_email.encode("utf-8")).hexdigest()
        with self._lock:
            active_token = self._identity_to_token.get(identity_hash)
            existing_session = self._sessions.get(active_token) if active_token else None
            if existing_session and existing_session.collector.connected:
                # Sessão já ativa e saudável: reutiliza imediatamente sem bloquear o usuário
                existing_session.last_used = time.time()
                if account_type:
                    try:
                        self.switch_account_type(existing_session.token, account_type)
                    except Exception:
                        pass
                return existing_session
            elif existing_session:
                # Sessão anterior desconectada ou zumbi: limpa antes de criar nova
                try:
                    existing_session.collector.stop()
                except Exception:
                    pass
                signal_scanner.unregister(existing_session.token)
                self._sessions.pop(existing_session.token, None)
                self._identity_to_token.pop(identity_hash, None)

        token = secrets.token_urlsafe(32)
        base_path = config.DB_PATH
        if not os.path.isabs(base_path):
            base_path = os.path.join(os.path.dirname(__file__), base_path)
        user_db_path = os.path.join(
            os.path.dirname(base_path), "users", f"{identity_hash}.db"
        )
        db.init(user_db_path)

        collector = Collector(
            email=normalized_email,
            password=password,
            db_path=user_db_path,
            timeframes=SESSION_TIMEFRAMES,
            backfill_hours=SESSION_BACKFILL_HOURS,
            session_id=token,
            account_type=account_type.lower(),
        )
        collector.start()

        if not collector._startup_event.wait(CONNECT_TIMEOUT_SECONDS):
            collector.stop()
            raise TimeoutError("A conexão com a IQ Option excedeu o tempo limite.")
        if collector._startup_error:
            error = collector._startup_error
            collector.stop()
            raise ConnectionError(f"Não foi possível conectar à IQ Option: {error}")

        # Registra e ativa o scanner de sinais em tempo real
        scanner = signal_scanner.register(
            session_token=token,
            identity_hash=identity_hash,
            db_path=user_db_path,
            payouts=collector.payouts,
            collector=collector,
        )
        collector.add_candle_listener(scanner.on_candle_closed)

        session = UserSession(token, normalized_email, identity_hash, collector, time.time())
        with self._lock:
            old_token = self._identity_to_token.get(identity_hash)
            if old_token and old_token in self._sessions and old_token != token:
                old_session = self._sessions.pop(old_token, None)
                if old_session:
                    try:
                        old_session.collector.stop()
                    except Exception:
                        pass
                    signal_scanner.unregister(old_token)
            self._sessions[token] = session
            self._identity_to_token[identity_hash] = token
        return session

    def get(self, token: str) -> Optional[UserSession]:
        with self._lock:
            session = self._sessions.get(token)
            if session is not None:
                session.last_used = time.time()
            return session

    def switch_account_type(self, token: str, account_type: str) -> str:
        with self._lock:
            session = self._sessions.get(token)
            if session is None:
                raise ValueError("Sessão não encontrada.")
            act = "demo" if "practice" in str(account_type).lower() or "demo" in str(account_type).lower() else "real"
            if session.collector.client:
                session.collector.client.switch_account(act)
            session.collector.account_type = "practice" if act == "demo" else "real"
            return session.collector.account_type

    def disconnect(self, token: str) -> bool:
        with self._lock:
            session = self._sessions.pop(token, None)
            if session is None:
                return False
            self._identity_to_token.pop(session.identity_hash, None)
        signal_scanner.unregister(token)
        session.collector.stop()
        return True

    def all_sessions(self) -> list[UserSession]:
        with self._lock:
            return list(self._sessions.values())

    def expire_idle(self) -> list[str]:
        cutoff = time.time() - SESSION_IDLE_SECONDS
        with self._lock:
            expired = [token for token, session in self._sessions.items()
                       if session.last_used < cutoff]
        for token in expired:
            self.disconnect(token)
        return expired


session_manager = IQSessionManager()
