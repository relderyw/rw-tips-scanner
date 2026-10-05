"""Dynamic IQ binary-option asset discovery and candle retrieval."""
from __future__ import annotations

import os
import sys
import tempfile
from types import SimpleNamespace

from fastapi import HTTPException

_HERE = os.path.dirname(os.path.abspath(__file__))
_TOOLS = os.path.dirname(_HERE)
_BRIDGE = os.path.dirname(_TOOLS)
_REPO = os.path.dirname(_BRIDGE)
for _path in (_BRIDGE, _REPO, _TOOLS):
    if _path not in sys.path:
        sys.path.insert(0, _path)

from collector import Collector  # noqa: E402
import db  # noqa: E402
import main as bridge_main  # noqa: E402


def main() -> int:
    with tempfile.TemporaryDirectory() as temp_dir:
        db_path = os.path.join(temp_dir, "candles.db")
        db.init(db_path)
        collector = Collector(db_path=db_path)
        candle_calls = []
        collector.connected = True
        collector.client = SimpleNamespace(
            message_handler=SimpleNamespace(server_time=None),
            get_actives=lambda _kind: {
                76: {"ticker": "EURUSD-OTC", "is_open": True, "profit_percent": 91},
                77: {"ticker": "EURGBP-OTC", "is_open": True, "profit_percent": 90},
                78: {"ticker": "USDCHF-OTC", "is_open": False, "profit_percent": 89},
                999: {"ticker": "NOT-A-LIBRARY-ACTIVE", "is_open": True, "profit_percent": 99},
            },
            get_candles=lambda asset, count, timeframe, end_time: candle_calls.append(
                (asset, count, timeframe, end_time)
            ) or [
                {
                    "from": end_time - (end_time % 60) - 60 - index * 60,
                    "open": 1.0,
                    "max": 1.1,
                    "min": 0.9,
                    "close": 1.05,
                }
                for index in range(count)
            ],
        )
        session = SimpleNamespace(collector=collector)

        active_rows = bridge_main.binary_option_actives(session)
        assert [row["asset"] for row in active_rows] == [
            "NOT-A-LIBRARY-ACTIVE", "EURUSD-OTC", "EURGBP-OTC",
        ]
        assert active_rows[0]["payout"] == 99
        assert active_rows[0]["candles_supported"] is False
        assert active_rows[1]["payout"] == 91
        assert active_rows[1]["candles_supported"] is True
        assert active_rows[1]["is_open"] is True

        candles = bridge_main.candles("EURUSD-OTC", "M1", 1, session)
        assert candles
        assert candles[-1]["time"] > candles[0]["time"]
        assert candles[-1]["close"] == 1.05
        assert bridge_main.candles("EURUSD-OTC", "M1", 1, session) == candles
        assert len(candle_calls) == 1

        try:
            bridge_main.candles("NOT-A-LIBRARY-ACTIVE", "M1", 1, session)
        except HTTPException as exc:
            assert exc.status_code == 400
        else:
            raise AssertionError("The candles endpoint must reject unknown symbols.")

    print("OK: ativos abertos e payouts vêm da IQ; candles OTC são reais e cacheados.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
