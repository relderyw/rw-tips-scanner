"""Dashboard analytics should use completed trades from the connected IQ account."""
from __future__ import annotations

import os
import sys
import time
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
    today = time.strftime("%Y-%m-%d")
    now_ms = int(time.time() * 1000)
    history = [
        {
            "id": 101,
            "instrument_underlying": {"name": "USDBRL-OTC"},
            "direction": "call",
            "status": "closed",
            "instrument_type": "binary-option",
            "invest": 10,
            "pnl_net": 8.5,
            "open_time": now_ms - 60_000,
            "close_time": now_ms,
        },
        {
            "id": 102,
            "instrument_underlying": {"name": "EURUSD"},
            "direction": "put",
            "status": "closed",
            "instrument_type": "binary-option",
            "invest": 10,
            "pnl_net": -10,
            "open_time": now_ms - 120_000,
            "close_time": now_ms - 60_000,
        },
        {
            "id": 103,
            "instrument_underlying": {"name": "GBPUSD"},
            "direction": "put",
            "status": "closed",
            "instrument_type": "binary-option",
            "invest": 10,
            "pnl_net": 90,
            "open_time": now_ms - 48 * 60 * 60 * 1000,
            "close_time": now_ms - 48 * 60 * 60 * 1000,
        },
    ]
    queried_ranges = []
    collector = Collector(account_type="demo")
    collector.connected = True
    collector.client = SimpleNamespace(
        get_position_history_by_time=lambda _types, start_time, end_time: (
            queried_ranges.append((start_time, end_time)) or history
        ),
    )
    session = SimpleNamespace(
        identity_hash="test-owner",
        collector=collector,
    )

    result = bridge_main.get_scanner_dashboard_stats(
        start_date=today,
        end_date=today,
        account_type="demo",
        session=session,
    )

    assert queried_ranges == [(f"{today} 00:00:00", f"{today} 23:59:59")]
    assert result["data_source"] == "iq_option"
    assert result["source_account_type"] == "PRACTICE"
    assert result["total_trades"] == 2
    assert result["total_greens"] == 1
    assert result["total_reds"] == 1
    assert result["total_profit"] == -1.5
    assert result["asset_performance"][0]["asset"] == "USDBRL-OTC"
    assert len(result["recent_trades"]) == 2
    print("OK: o Dashboard agrega resultados fechados da conta IQ e respeita o período.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
