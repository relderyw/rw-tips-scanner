import os
import asyncio
import logging
import time
from dataclasses import dataclass, field
from typing import Optional

from dotenv import load_dotenv
from telegram import Update, InlineKeyboardButton, InlineKeyboardMarkup
from telegram.ext import (
    Application, CommandHandler, CallbackQueryHandler,
    MessageHandler, ContextTypes, filters,
)

try:
    from iqoptionapi.stable_api import IQ_Option
except ImportError:
    IQ_Option = None

load_dotenv()
logging.basicConfig(level=logging.INFO, format="%(asctime)s | %(levelname)s | %(message)s")
LOG = logging.getLogger("smt-bot")

BOT_TOKEN = os.getenv("SMT_BOT_TOKEN", "")
IQ_EMAIL = os.getenv("IQ_EMAIL", "")
IQ_PASSWORD = os.getenv("IQ_PASSWORD", "")

MIN_CONFIDENCE = 80
MAX_ASSETS = 80
CONCURRENCY = 6
LOOKBACK = 120
EXPIRIES = {"1m": 60, "5m": 300, "15m": 900, "30m": 1800, "1h": 3600}


@dataclass
class Signal:
    asset: str
    direction: str
    confidence: float
    expiry: str
    reasons: list[str] = field(default_factory=list)


@dataclass
class State:
    stake: int = 1000
    expiry: str = "1m"
    min_confidence: int = 80
    min_payout: int = 80
    daily_loss_limit: int = 5000
    account: str = "DEMO"
    auto_minutes: int = 60
    max_trades: int = 20
    scanning: bool = False
    scan_task: Optional[asyncio.Task] = None
    waiting: Optional[str] = None
    signals: list[Signal] = field(default_factory=list)


STATES: dict[int, State] = {}
ADAPTER = None


class MarketAdapter:
    def __init__(self):
        self.api = None
        self.connected = False

    async def connect(self):
        if IQ_Option is None:
            raise RuntimeError("iqoptionapi is not installed.")
        if not IQ_EMAIL or not IQ_PASSWORD:
            raise RuntimeError("IQ_EMAIL and IQ_PASSWORD are missing from .env")
        self.api = IQ_Option(IQ_EMAIL, IQ_PASSWORD)
        ok, reason = await asyncio.to_thread(self.api.connect)
        if not ok:
            raise RuntimeError(f"IQ Option connection failed: {reason}")
        self.connected = True
        await asyncio.to_thread(self.api.change_balance, "PRACTICE")

    async def ensure(self):
        if not self.connected or self.api is None:
            await self.connect()

    async def set_demo(self):
        await self.ensure()
        await asyncio.to_thread(self.api.change_balance, "PRACTICE")

    async def balance(self):
        await self.ensure()
        return float(await asyncio.to_thread(self.api.get_balance()))

    async def currency(self):
        await self.ensure()
        try:
            v = await asyncio.to_thread(self.api.get_currency)
            return str(v) if v else "USD"
        except Exception:
            return "USD"

    async def open_assets(self):
        await self.ensure()
        data = await asyncio.to_thread(self.api.get_all_open_time)
        assets = set()
        for market in ("binary", "turbo", "digital"):
            for asset, info in data.get(market, {}).items():
                if isinstance(info, dict) and info.get("open"):
                    assets.add(asset)
        return sorted(assets)

    async def candles(self, asset, seconds):
        await self.ensure()
        end = int(time.time())
        return await asyncio.to_thread(
            self.api.get_candles, asset, seconds, LOOKBACK, end
        )


def state(chat_id):
    return STATES.setdefault(chat_id, State())


def ema(values, period):
    if len(values) < period:
        return None
    value = sum(values[:period]) / period
    alpha = 2 / (period + 1)
    for x in values[period:]:
        value = alpha * x + (1 - alpha) * value
    return value


def rsi(values, period=14):
    if len(values) <= period:
        return None
    gains, losses = [], []
    for i in range(1, len(values)):
        d = values[i] - values[i - 1]
        gains.append(max(d, 0))
        losses.append(max(-d, 0))
    gain = sum(gains[:period]) / period
    loss = sum(losses[:period]) / period
    for i in range(period, len(gains)):
        gain = ((period - 1) * gain + gains[i]) / period
        loss = ((period - 1) * loss + losses[i]) / period
    return 100.0 if loss == 0 else 100 - 100 / (1 + gain / loss)


def analyse(asset, candles, expiry):
    if len(candles) < 60:
        return None

    close = [float(x["close"]) for x in candles]
    e20, e50 = ema(close, 20), ema(close, 50)
    r = rsi(close)
    if e20 is None or e50 is None or r is None:
        return None

    up = down = 0
    ru, rd = [], []

    if e20 > e50:
        up += 25; ru.append("EMA20 > EMA50")
    elif e20 < e50:
        down += 25; rd.append("EMA20 < EMA50")

    if close[-1] > e20:
        up += 15; ru.append("price > EMA20")
    elif close[-1] < e20:
        down += 15; rd.append("price < EMA20")

    if 52 <= r <= 68:
        up += 15; ru.append(f"RSI {r:.1f}")
    elif 32 <= r <= 48:
        down += 15; rd.append(f"RSI {r:.1f}")

    momentum = close[-1] - close[-6]
    if momentum > 0:
        up += 15; ru.append("positive momentum")
    elif momentum < 0:
        down += 15; rd.append("negative momentum")

    recent = candles[-3:]
    green = sum(float(x["close"]) > float(x["open"]) for x in recent)
    red = sum(float(x["close"]) < float(x["open"]) for x in recent)
    if green >= 2:
        up += 15; ru.append("bullish recent candles")
    if red >= 2:
        down += 15; rd.append("bearish recent candles")

    if up == down:
        return None

    if up > down:
        return Signal(asset, "BUY", min(99, up), expiry, ru)
    return Signal(asset, "SELL", min(99, down), expiry, rd)


async def scan_signals(s: State, limit=10):
    assets = (await ADAPTER.open_assets())[:MAX_ASSETS]
    semaphore = asyncio.Semaphore(CONCURRENCY)

    async def scan_one(asset):
        async with semaphore:
            try:
                candles = await asyncio.wait_for(
                    ADAPTER.candles(asset, EXPIRIES[s.expiry]), 12
                )
                return analyse(asset, candles, s.expiry)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                LOG.warning("scan %s failed: %s", asset, exc)
                return None

    tasks = [asyncio.create_task(scan_one(a)) for a in assets]
    try:
        results = await asyncio.gather(*tasks)
    except asyncio.CancelledError:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        raise

    results = [
        x for x in results
        if x and x.confidence >= s.min_confidence
    ]
    results.sort(key=lambda x: x.confidence, reverse=True)
    return results[:limit]


def main_keyboard():
    return InlineKeyboardMarkup([
        [InlineKeyboardButton("📊 SCAN MARKET", callback_data="scan"),
         InlineKeyboardButton("🎯 MANUAL MODE", callback_data="manual")],
        [InlineKeyboardButton("🚀 AUTO-RUN", callback_data="auto")],
        [InlineKeyboardButton("🛑 STOP", callback_data="stop"),
         InlineKeyboardButton("⚙️ SETTINGS", callback_data="settings")],
        [InlineKeyboardButton("📈 RESULTS", callback_data="results")],
    ])


def settings_keyboard():
    return InlineKeyboardMarkup([
        [InlineKeyboardButton("💰 Stake", callback_data="stake"),
         InlineKeyboardButton("⏱️ Expiry", callback_data="expiry")],
        [InlineKeyboardButton("🎯 Confidence", callback_data="confidence"),
         InlineKeyboardButton("💵 Payout", callback_data="payout")],
        [InlineKeyboardButton("📉 Daily Loss", callback_data="loss"),
         InlineKeyboardButton("👤 Account", callback_data="account")],
        [InlineKeyboardButton("⏱️ Auto-Run", callback_data="autorun"),
         InlineKeyboardButton("🔢 Max Trades", callback_data="maxtrades")],
        [InlineKeyboardButton("💾 SAVE SETTINGS", callback_data="save")],
        [InlineKeyboardButton("↩️ BACK", callback_data="back")],
    ])


async def settings_text(chat_id):
    s = state(chat_id)
    try:
        await ADAPTER.set_demo()
        bal = await ADAPTER.balance()
        cur = await ADAPTER.currency()
        acct = f"{s.account} | {cur} {bal:,.2f}"
    except Exception:
        acct = f"{s.account} | connection pending"

    return (
        "⚙️ SETTINGS\n\n"
        "Configure all parameters below, then save once.\n\n"
        f"💰 Stake per trade: ₦{s.stake:,}\n"
        f"⏱️ Trade expiry: {s.expiry}\n"
        f"🎯 Minimum confidence: {s.min_confidence}%\n"
        f"💵 Minimum payout: {s.min_payout}%\n"
        f"📉 Daily loss limit: ₦{s.daily_loss_limit:,}\n"
        f"👤 Account: {acct}\n"
        f"⏱️ Auto-Run duration: {s.auto_minutes} minutes\n"
        f"🔢 Maximum trades/cycle: {s.max_trades}\n\n"
        "DEMO analysis is active. Order execution is not included in this build."
    )


async def start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    global ADAPTER
    if ADAPTER is None:
        ADAPTER = MarketAdapter()
    state(update.effective_chat.id)
    await update.message.reply_text(
        "🤖 smt-bot\n\n"
        "DEMO is the default account.\n"
        "Stage 1: market scanning and signal validation.",
        reply_markup=main_keyboard()
    )


async def run_scan(chat_id, context):
    s = state(chat_id)
    if s.scanning:
        return
    s.scanning = True

    async def job():
        try:
            signals = await scan_signals(s)
            s.signals = signals
            if not signals:
                text = (
                    "📊 SCAN COMPLETE\n\n"
                    f"No pair reached {s.min_confidence}% confidence."
                )
            else:
                lines = ["📊 QUALIFYING SIGNALS\n"]
                for i, x in enumerate(signals, 1):
                    lines.append(
                        f"{i}. {x.asset} — {x.direction} — {x.confidence:.0f}%\n"
                        f"   Expiry: {x.expiry}\n"
                        f"   {'; '.join(x.reasons)}"
                    )
                lines.append("\n🥇 Highest-ranked signal is shown first.")
                text = "\n".join(lines)
            await context.bot.send_message(chat_id, text, reply_markup=main_keyboard())
        except asyncio.CancelledError:
            pass
        except Exception as exc:
            LOG.exception("scan error")
            await context.bot.send_message(chat_id, f"❌ Scan error: {exc}")
        finally:
            s.scanning = False
            s.scan_task = None

    s.scan_task = asyncio.create_task(job())


async def callback(update: Update, context: ContextTypes.DEFAULT_TYPE):
    q = update.callback_query
    chat_id = q.message.chat.id
    s = state(chat_id)
    action = q.data
    await q.answer()

    if action == "settings":
        await q.edit_message_text(
            await settings_text(chat_id), reply_markup=settings_keyboard()
        )
        return

    if action == "back":
        await q.edit_message_text("Main menu:", reply_markup=main_keyboard())
        return

    if action == "scan":
        await q.message.reply_text(
            "📊 Scanning available pairs concurrently...\n"
            "🛑 STOP remains responsive."
        )
        await run_scan(chat_id, context)
        return

    if action in ("manual", "auto"):
        label = "MANUAL MODE" if action == "manual" else "AUTO-RUN ANALYSIS"
        await q.message.reply_text(
            f"🎯 {label}\n\n"
            "The scanner will rank qualifying opportunities. "
            "This Stage-1 build does not submit orders."
        )
        await run_scan(chat_id, context)
        return

    if action == "stop":
        s.scanning = False
        if s.scan_task and not s.scan_task.done():
            s.scan_task.cancel()
        await q.edit_message_text(
            "🛑 STOP ACTIVATED\n\nMarket scanning stopped.",
            reply_markup=main_keyboard()
        )
        return

    if action == "results":
        await q.message.reply_text(
            "📈 RESULTS\n\n"
            "Stage 1 records the signals produced by the scanner. "
            "Order execution/results are intentionally outside this build.",
            reply_markup=main_keyboard()
        )
        return

    prompts = {
        "stake": ("stake", "Enter stake amount, e.g. 1000."),
        "confidence": ("confidence", "Enter minimum confidence (80–100)."),
        "payout": ("payout", "Enter minimum payout percentage."),
        "loss": ("loss", "Enter daily loss limit."),
        "autorun": ("autorun", "Auto-Run is fixed at 60 minutes. Enter 60."),
        "maxtrades": ("maxtrades", "Enter maximum trades, 1–20."),
    }
    if action in prompts:
        s.waiting = prompts[action][0]
        await q.message.reply_text(prompts[action][1])
        return

    if action == "expiry":
        await q.message.reply_text(
            "Select expiry:",
            reply_markup=InlineKeyboardMarkup([
                [InlineKeyboardButton("1m", callback_data="exp_1m"),
                 InlineKeyboardButton("5m", callback_data="exp_5m"),
                 InlineKeyboardButton("15m", callback_data="exp_15m")],
                [InlineKeyboardButton("30m", callback_data="exp_30m"),
                 InlineKeyboardButton("1h", callback_data="exp_1h")],
            ])
        )
        return

    if action.startswith("exp_"):
        s.expiry = action[4:]
        await q.message.reply_text(await settings_text(chat_id), reply_markup=settings_keyboard())
        return

    if action == "account":
        await q.message.reply_text(
            "Select account:",
            reply_markup=InlineKeyboardMarkup([
                [InlineKeyboardButton("🔵 DEMO", callback_data="acct_DEMO")],
                [InlineKeyboardButton("⚪ REAL", callback_data="acct_REAL")],
            ])
        )
        return

    if action.startswith("acct_"):
        # Interface retains DEMO/REAL selection, but Stage 1 keeps the market
        # connection on DEMO.
        s.account = action[5:]
        await ADAPTER.set_demo()
        await q.message.reply_text(await settings_text(chat_id), reply_markup=settings_keyboard())
        return

    if action == "save":
        await q.message.reply_text(
            "✅ SETTINGS SAVED\n\n" + await settings_text(chat_id),
            reply_markup=main_keyboard()
        )


async def text_handler(update: Update, context: ContextTypes.DEFAULT_TYPE):
    chat_id = update.effective_chat.id
    s = state(chat_id)
    if not s.waiting:
        return

    key, value = s.waiting, update.message.text.strip()
    try:
        if key == "stake":
            n = int(float(value)); assert n > 0; s.stake = n
        elif key == "confidence":
            n = int(value); assert 80 <= n <= 100; s.min_confidence = n
        elif key == "payout":
            n = int(value); assert 0 <= n <= 100; s.min_payout = n
        elif key == "loss":
            n = int(float(value)); assert n >= 0; s.daily_loss_limit = n
        elif key == "autorun":
            assert int(value) == 60; s.auto_minutes = 60
        elif key == "maxtrades":
            n = int(value); assert 1 <= n <= 20; s.max_trades = n
        else:
            raise ValueError
    except Exception:
        await update.message.reply_text("❌ Invalid value. Please try again.")
        return

    s.waiting = None
    await update.message.reply_text(
        await settings_text(chat_id), reply_markup=settings_keyboard()
    )


def main():
    if not BOT_TOKEN:
        raise RuntimeError("SMT_BOT_TOKEN is missing.")
    global ADAPTER
    ADAPTER = MarketAdapter()
    app = Application.builder().token(BOT_TOKEN).build()
    app.add_handler(CommandHandler("start", start))
    app.add_handler(CallbackQueryHandler(callback))
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, text_handler))
    app.run_polling(close_loop=False)


if __name__ == "__main__":
    main()