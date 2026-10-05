"""Test per-user IQ session creation and isolated candle databases."""
from __future__ import annotations

import os
import sys
import tempfile
import threading
import time

_HERE = os.path.dirname(os.path.abspath(__file__))
_TOOLS = os.path.dirname(_HERE)
_BRIDGE = os.path.dirname(_TOOLS)
_REPO = os.path.dirname(_BRIDGE)
for _path in (_BRIDGE, _REPO, _TOOLS):
    if _path not in sys.path:
        sys.path.insert(0, _path)

import config  # noqa: E402
import db  # noqa: E402
import sessions as sessions_module  # noqa: E402
from sessions import IQSessionManager  # noqa: E402


class FakeCollector:
    instances = []

    def __init__(self, **kwargs):
        self.email = kwargs["email"]
        self.password = kwargs["password"]
        self.db_path = kwargs["db_path"]
        self.connected = True
        self._startup_error = None
        self._startup_event = threading.Event()
        self._startup_event.set()
        self.stopped = False
        self.kwargs = kwargs
        FakeCollector.instances.append(self)

    def start(self):
        return None

    def stop(self):
        self.stopped = True
        self.password = ""


def main() -> int:
    original_db_path = config.DB_PATH
    original_collector = sessions_module.Collector
    FakeCollector.instances = []
    try:
        with tempfile.TemporaryDirectory() as temp_dir:
            config.DB_PATH = os.path.join(temp_dir, "bridge.db")
            sessions_module.Collector = FakeCollector
            manager = IQSessionManager()
            first = manager.create("first@example.com", "first-demo-password")
            second = manager.create("second@example.com", "second-demo-password")

            assert first.token != second.token
            assert first.collector.db_path != second.collector.db_path
            assert first.collector.email != second.collector.email
            assert first.collector.kwargs["timeframes"] == config.TIMEFRAMES
            assert first.collector.kwargs["account_type"] == "real"
            assert second.collector.kwargs["account_type"] == "real"

            db.upsert("EURUSD", "M1", [{
                "time": int(time.time()) - 60,
                "open": 1.0, "high": 1.1, "low": 0.9, "close": 1.05,
            }], first.collector.db_path)
            assert len(db.query("EURUSD", "M1", 10000, first.collector.db_path)) == 1
            assert db.query("EURUSD", "M1", 10000, second.collector.db_path) == []
            assert manager.get(first.token) is first
            assert manager.get(second.token) is second
            assert manager.disconnect(first.token)
            assert first.collector.stopped
            assert manager.get(first.token) is None
            assert manager.get(second.token) is second
            assert manager.disconnect(second.token)
            print("OK: sessões IQ possuem tokens e bancos isolados; logout encerra apenas a sessão própria.")
            return 0
    finally:
        config.DB_PATH = original_db_path
        sessions_module.Collector = original_collector


if __name__ == "__main__":
    raise SystemExit(main())
