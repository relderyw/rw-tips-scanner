"""Exercise real-account read-only balance and position-history accessors."""
from __future__ import annotations

import os
import sys
from types import SimpleNamespace

_HERE = os.path.dirname(os.path.abspath(__file__))
_TOOLS = os.path.dirname(_HERE)
_BRIDGE = os.path.dirname(_TOOLS)
_REPO = os.path.dirname(_BRIDGE)
for _path in (_BRIDGE, _REPO, _TOOLS):
    if _path not in sys.path:
        sys.path.insert(0, _path)

from collector import Collector  # noqa: E402
import main as bridge_main  # noqa: E402


def main() -> int:
    collector = Collector(account_type="real")
    collector.connected = True
    collector.client = SimpleNamespace(
        appstate=SimpleNamespace(balance_id=7),
        account_manager=SimpleNamespace(get_balances=lambda: [
            {"id": 7, "type": 1, "amount": 123.45, "currency": "USD"},
            {"id": 8, "type": 4, "amount": 10000, "currency": "USD"},
        ]),
        get_position_history_by_page=lambda instrument_types, limit, offset: [
            {
                "id": 22,
                "instrument_underlying": {"name": "EURUSD"},
                "active_id": 1,
                "direction": "call",
                "status": "closed",
                "instrument_type": "binary-option",
                "invest": 10,
                "pnl_net": 8.5,
                "open_time": 1_790_000_000_000,
                "close_time": 1_790_000_060_000,
            }
        ],
    )

    overview = collector.account_overview()
    assert overview == {
        "balance": 123.45,
        "currency": "USD",
        "account_type": "real",
        "read_only": True,
    }
    history = collector.position_history(50)
    assert len(history) == 1
    session = SimpleNamespace(collector=collector)
    assert bridge_main.account_overview(session) == overview
    api_history = bridge_main.positions(limit=50, session=session)
    assert len(api_history) == 1
    normalized = api_history[0]
    assert normalized["asset"] == "EURUSD"
    assert normalized["direction"] == "call"
    assert normalized["amount"] == 10
    assert normalized["profit"] == 8.5
    assert normalized["open_time"] == 1_790_000_000_000

    demo_collector = Collector(account_type="demo")
    for read in (demo_collector.account_overview, lambda: demo_collector.position_history(50)):
        try:
            read()
        except RuntimeError:
            pass
        else:
            raise AssertionError("Demo sessions must not serve the real-account read endpoints.")

    print("OK: saldo real, histórico normalizado e bloqueio explícito de sessões demo.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
