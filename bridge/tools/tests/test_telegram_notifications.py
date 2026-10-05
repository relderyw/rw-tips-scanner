"""Global Telegram configuration and signal delivery tests."""
from __future__ import annotations

import os
import sys
import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import Mock, patch

_HERE = os.path.dirname(os.path.abspath(__file__))
_TOOLS = os.path.dirname(_HERE)
_BRIDGE = os.path.dirname(_TOOLS)
if _BRIDGE not in sys.path:
    sys.path.insert(0, _BRIDGE)

import telegram_notifications  # noqa: E402
import main as bridge_main  # noqa: E402


class TelegramNotificationTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp_dir.cleanup)
        self.database = patch.object(
            telegram_notifications,
            "_DB_PATH",
            os.path.join(self.temp_dir.name, "telegram.sqlite3"),
        )
        self.database.start()
        self.addCleanup(self.database.stop)
        self.environment = patch.dict(os.environ, {
            "TELEGRAM_BOT_TOKEN": "123456:" + "a" * 30,
            "TELEGRAM_CHAT_ID": "-100123",
        })
        self.environment.start()
        self.addCleanup(self.environment.stop)

    def test_status_confirms_configuration_without_returning_secrets(self):
        status = telegram_notifications.get_status()
        self.assertEqual(status, {"configured": True})
        self.assertNotIn("TELEGRAM_BOT_TOKEN", status)
        self.assertNotIn("TELEGRAM_CHAT_ID", status)
        with patch.dict(os.environ, {"TELEGRAM_BOT_TOKEN": "", "TELEGRAM_CHAT_ID": ""}):
            self.assertEqual(telegram_notifications.get_status(), {"configured": False})

    def test_sends_formatted_signal_once_and_deduplicates(self):
        response = Mock(status_code=200)
        response.json.return_value = {"ok": True, "result": {"message_id": 42}}
        with patch.object(telegram_notifications.requests, "post", return_value=response) as post:
            sent = telegram_notifications.send_signal(
                signal_id="EURUSD|mhi-1|M1|123",
                owner_id="user-1",
                strategy="MHI 1",
                asset="EUR/USD",
                direction="CALL",
                timeframe="M1",
                signal_time="19:23",
            )
            duplicate = telegram_notifications.send_signal(
                signal_id="EURUSD|mhi-1|M1|123",
                owner_id="user-1",
                strategy="MHI 1",
                asset="EUR/USD",
                direction="CALL",
                timeframe="M1",
                signal_time="19:23",
            )
        self.assertTrue(sent)
        self.assertFalse(duplicate)
        post.assert_called_once()
        self.assertEqual(post.call_args.kwargs["json"], {
            "chat_id": "-100123",
            "text": "\n".join([
                "🎯 Sinal confirmado", "", "🚨 MHI 1", "", "📊 #EUR/USD",
                "", "⬆️ CALL", "", "⏳M1", "", "⌚19:23",
            ]),
        })

    def test_asset_ticker_is_preserved_exactly(self):
        response = Mock(status_code=200)
        response.json.return_value = {"ok": True, "result": {"message_id": 43}}
        with patch.object(telegram_notifications.requests, "post", return_value=response) as post:
            telegram_notifications.send_signal(
                signal_id="BTCUSD-op|mhi-1|M1|123",
                owner_id="user-1",
                strategy="MHI 1",
                asset="BTCUSD-op",
                direction="CALL",
                timeframe="M1",
                signal_time="19:23",
            )
        self.assertIn("#BTCUSD-op", post.call_args.kwargs["json"]["text"])

    def test_missing_configuration_fails_without_sending(self):
        with patch.dict(os.environ, {"TELEGRAM_BOT_TOKEN": "", "TELEGRAM_CHAT_ID": ""}):
            with patch.object(telegram_notifications.requests, "post") as post:
                with self.assertRaises(telegram_notifications.TelegramConfigurationError):
                    telegram_notifications.send_signal(
                        signal_id="event",
                        owner_id="user-1",
                        strategy="MHI 1",
                        asset="EUR/USD",
                        direction="PUT",
                        timeframe="M1",
                        signal_time="19:23",
                    )
        post.assert_not_called()

    def test_invalid_configuration_fails_without_sending(self):
        with patch.dict(os.environ, {"TELEGRAM_BOT_TOKEN": "invalid"}):
            with patch.object(telegram_notifications.requests, "post") as post:
                with self.assertRaises(telegram_notifications.TelegramConfigurationError):
                    telegram_notifications.send_signal(
                        signal_id="event",
                        owner_id="user-1",
                        strategy="MHI 1",
                        asset="EUR/USD",
                        direction="PUT",
                        timeframe="M1",
                        signal_time="19:23",
                    )
        post.assert_not_called()

    def test_failed_delivery_is_not_marked_as_sent(self):
        response = Mock(status_code=200)
        response.json.return_value = {"ok": False}
        with patch.object(telegram_notifications.requests, "post", return_value=response):
            with self.assertRaises(telegram_notifications.TelegramDeliveryError):
                telegram_notifications.send_signal(
                    signal_id="retry-event",
                    owner_id="user-1",
                    strategy="MHI 1",
                    asset="EUR/USD",
                    direction="PUT",
                    timeframe="M1",
                    signal_time="19:23",
                )
        with patch.object(
            telegram_notifications.requests,
            "post",
            return_value=Mock(status_code=200, json=lambda: {"ok": True, "result": {"message_id": 54}}),
        ) as post:
            self.assertTrue(telegram_notifications.send_signal(
                signal_id="retry-event",
                owner_id="user-1",
                strategy="MHI 1",
                asset="EURUSD-op",
                direction="PUT",
                timeframe="M1",
                signal_time="19:23",
            ))
        post.assert_called_once()

    def test_uncertain_send_failure_remains_deduplicated(self):
        with patch.object(
            telegram_notifications.requests,
            "post",
            side_effect=telegram_notifications.requests.RequestException("timeout"),
        ) as post:
            with self.assertRaises(telegram_notifications.TelegramDeliveryError):
                telegram_notifications.send_signal(
                    signal_id="uncertain-event",
                    owner_id="user-1",
                    strategy="MHI 1",
                    asset="EURUSD-op",
                    direction="PUT",
                    timeframe="M1",
                    signal_time="19:23",
                )
            self.assertFalse(telegram_notifications.send_signal(
                signal_id="uncertain-event",
                owner_id="user-1",
                strategy="MHI 1",
                asset="EURUSD-op",
                direction="PUT",
                timeframe="M1",
                signal_time="19:23",
            ))
        post.assert_called_once()

    def test_distinct_signals_are_sent_concurrently(self):
        barrier = threading.Barrier(2)
        response = Mock(status_code=200)
        response.json.return_value = {"ok": True, "result": {"message_id": 55}}

        def send_request(*_args, **_kwargs):
            barrier.wait(timeout=3)
            return response

        with patch.object(telegram_notifications.requests, "post", side_effect=send_request):
            with ThreadPoolExecutor(max_workers=2) as executor:
                sends = [
                    executor.submit(
                        telegram_notifications.send_signal,
                        signal_id=f"parallel-{index}",
                        owner_id="user-1",
                        strategy="MHI 1",
                        asset="EURUSD-op",
                        direction="CALL",
                        timeframe="M1",
                        signal_time="19:23",
                    )
                    for index in range(2)
                ]
                self.assertEqual([send.result(timeout=5) for send in sends], [True, True])

    def test_updates_original_message_once_with_result(self):
        sent_response = Mock(status_code=200)
        sent_response.json.return_value = {"ok": True, "result": {"message_id": 61}}
        edit_response = Mock(status_code=200)
        edit_response.json.return_value = {"ok": True, "result": {"message_id": 61}}
        with patch.object(telegram_notifications.requests, "post", side_effect=[sent_response, edit_response]) as post:
            telegram_notifications.send_signal(
                signal_id="result-event",
                owner_id="user-1",
                strategy="MHI 1",
                asset="BTCUSD-op",
                direction="CALL",
                timeframe="M1",
                signal_time="19:23",
            )
            self.assertFalse(telegram_notifications.update_signal_result(
                signal_id="result-event",
                owner_id="another-user",
                outcome="LOSS",
            ))
            self.assertTrue(telegram_notifications.update_signal_result(
                signal_id="result-event",
                owner_id="user-1",
                outcome="WIN",
            ))
            self.assertFalse(telegram_notifications.update_signal_result(
                signal_id="result-event",
                owner_id="user-1",
                outcome="WIN",
            ))
        self.assertEqual(post.call_count, 2)
        self.assertTrue(post.call_args.args[0].endswith("/editMessageText"))
        self.assertEqual(post.call_args.kwargs["json"]["message_id"], 61)
        self.assertTrue(post.call_args.kwargs["json"]["text"].endswith("Green ✅"))

    def test_authenticated_routes_expose_status_and_send_to_global_destination(self):
        session = Mock(identity_hash="user-hash")
        with patch.object(telegram_notifications, "get_status", return_value={"configured": True}):
            self.assertEqual(bridge_main.telegram_status(session), {"configured": True})

        payload = bridge_main.TelegramSignalRequest(
            signal_id="EURUSD|mhi-1|M1|123",
            strategy="MHI 1",
            asset="EUR/USD",
            direction="CALL",
            timeframe="M1",
            signal_time="19:23",
        )
        with patch.object(telegram_notifications, "send_signal", return_value=True) as send:
            response = bridge_main.send_telegram_signal(payload, session)
        self.assertEqual(response, {"sent": True, "duplicate": False})
        self.assertEqual(send.call_args.kwargs["signal_id"], payload.signal_id)
        self.assertEqual(send.call_args.kwargs["owner_id"], session.identity_hash)

        result_payload = bridge_main.TelegramSignalResultRequest(
            signal_id=payload.signal_id,
            outcome="LOSS",
        )
        with patch.object(telegram_notifications, "update_signal_result", return_value=True) as update:
            response = bridge_main.update_telegram_signal_result(result_payload, session)
        self.assertEqual(response, {"updated": True, "duplicate": False})
        self.assertEqual(update.call_args.kwargs, {
            "signal_id": payload.signal_id,
            "owner_id": session.identity_hash,
            "outcome": "LOSS",
        })


if __name__ == "__main__":
    unittest.main()
