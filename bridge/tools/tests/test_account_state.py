"""Ensure IQ client account state is isolated between concurrent clients."""
from __future__ import annotations

from iqoptionapi.iqapi import IQOptionClient
from iqoptionapi.state import appstate


def main() -> int:
    real_client = IQOptionClient("real@example.com", "test-password", account_type="real")
    demo_client = IQOptionClient("demo@example.com", "test-password", account_type="demo")

    assert real_client.appstate is not appstate
    assert real_client.appstate is not demo_client.appstate
    assert real_client.appstate.balance_type == 1
    assert demo_client.appstate.balance_type == 4
    real_client.appstate.update(balance_id=123)
    assert demo_client.appstate.balance_id is None
    assert real_client.account_manager.appstate is real_client.appstate
    assert real_client.message_handler.appstate is real_client.appstate
    assert real_client.trade_manager.appstate is real_client.appstate
    assert demo_client.account_manager.appstate is demo_client.appstate
    print("OK: IQ clients keep their own real/demo account state.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
