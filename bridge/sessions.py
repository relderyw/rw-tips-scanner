"""Isolated, in-memory IQ Option sessions for web-app users."""
from __future__ import annotations

import hashlib
import os
import secrets
import threading
import time
from dataclasses import dataclass
from typing import Dict, Optional

import config
import db
from collector import Collector

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

    def create(self, email: str, password: str) -> UserSession:
        normalized_email = email.strip().casefold()
        if not normalized_email or not password:
            raise ValueError("Informe o e-mail e a senha da IQ Option.")

        identity_hash = hashlib.sha256(normalized_email.encode("utf-8")).hexdigest()
        with self._lock:
            active_token = self._identity_to_token.get(identity_hash)
            if active_token in self._sessions:
                raise ValueError("Esta conta IQ Option já está conectada.")

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
            account_type="real",
        )
        collector.start()

        if not collector._startup_event.wait(CONNECT_TIMEOUT_SECONDS):
            collector.stop()
            raise TimeoutError("A conexão com a IQ Option excedeu o tempo limite.")
        if collector._startup_error:
            error = collector._startup_error
            collector.stop()
            raise ConnectionError(f"Não foi possível conectar à IQ Option: {error}")

        session = UserSession(token, normalized_email, identity_hash, collector, time.time())
        with self._lock:
            active_token = self._identity_to_token.get(identity_hash)
            if active_token in self._sessions:
                collector.stop()
                raise ValueError("Esta conta IQ Option já está conectada.")
            self._sessions[token] = session
            self._identity_to_token[identity_hash] = token
        return session

    def get(self, token: str) -> Optional[UserSession]:
        with self._lock:
            session = self._sessions.get(token)
            if session is not None:
                session.last_used = time.time()
            return session

    def disconnect(self, token: str) -> bool:
        with self._lock:
            session = self._sessions.pop(token, None)
            if session is None:
                return False
            self._identity_to_token.pop(session.identity_hash, None)
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
