"""
╔══════════════════════════════════════════════════════════════════════════╗
║             RW TIPS SCANNER — BOT DE SINAIS IQ OPTION                   ║
║  Análise técnica multi-ativo • Telegram • Entrada automática IQ Option   ║
╚══════════════════════════════════════════════════════════════════════════╝

Fluxo principal:
 1. Conecta à IQ Option (demo ou real)
 2. Busca todos os ativos abertos
 3. Para cada ativo x timeframe, busca histórico de velas
 4. Aplica estratégias técnicas (EMA, RSI, MACD, Bollinger, Padrões de vela)
 5. Quando confiança >= MIN_CONFIDENCE, envia sinal ao Telegram
 6. Se auto_trade=True, executa entrada automática na IQ Option

Uso:
    python bot_scanner.py

Configuração via .env:
    IQ_EMAIL=seu@email.com
    IQ_PASSWORD=suasenha
    IQ_ACCOUNT_TYPE=PRACTICE   (ou REAL)
    TELEGRAM_BOT_TOKEN=token
    TELEGRAM_CHAT_ID=chat_id
"""

import os
import time
import logging
import threading
from datetime import datetime, timezone
from dataclasses import dataclass, field
from typing import Optional, List, Tuple

from dotenv import load_dotenv
import requests

load_dotenv()

# ──────────────────────────────────────────────────────────────────────────────
# CONFIGURAÇÕES GLOBAIS (editáveis ou via .env)
# ──────────────────────────────────────────────────────────────────────────────
IQ_EMAIL    = os.getenv("IQ_EMAIL", "")
IQ_PASSWORD = os.getenv("IQ_PASSWORD", "")
TG_TOKEN    = os.getenv("TELEGRAM_BOT_TOKEN", "")
TG_CHAT_ID  = os.getenv("TELEGRAM_CHAT_ID", "")

DEFAULT_ACCOUNT      = os.getenv("IQ_ACCOUNT_TYPE", "PRACTICE")
DEFAULT_STAKE        = float(os.getenv("DEFAULT_STAKE", "2.0"))
DEFAULT_EXPIRY       = int(os.getenv("DEFAULT_EXPIRY", "1"))
DEFAULT_MIN_CONF     = int(os.getenv("DEFAULT_MIN_CONF", "75"))
DEFAULT_AUTO_TRADE   = os.getenv("AUTO_TRADE", "false").lower() == "true"
SCAN_INTERVAL        = int(os.getenv("SCAN_INTERVAL", "60"))
MAX_ASSETS_PER_SCAN  = int(os.getenv("MAX_ASSETS", "60"))
MAX_DAILY_TRADES     = int(os.getenv("MAX_DAILY_TRADES", "30"))
MAX_DAILY_LOSS_USD   = float(os.getenv("MAX_DAILY_LOSS", "50.0"))
LOOKBACK_CANDLES     = 150

TIMEFRAMES = {
    "1m":  60,
    "5m":  300,
    "15m": 900,
}

# ──────────────────────────────────────────────────────────────────────────────
# LOGGING
# ──────────────────────────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)-8s | %(message)s",
    datefmt="%H:%M:%S",
    handlers=[
        logging.StreamHandler(),
        logging.FileHandler("bot_scanner.log", encoding="utf-8"),
    ]
)
LOG = logging.getLogger("rw-scanner")
logging.getLogger("websocket").setLevel(logging.WARNING)
logging.getLogger("urllib3").setLevel(logging.WARNING)


# ──────────────────────────────────────────────────────────────────────────────
# MODELOS DE DADOS
# ──────────────────────────────────────────────────────────────────────────────
@dataclass
class Signal:
    asset: str
    direction: str
    confidence: float
    timeframe: str
    strategies: List[str]
    entry_time: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    stake: float = DEFAULT_STAKE
    expiry: int = DEFAULT_EXPIRY
    order_id: Optional[int] = None
    result: Optional[str] = None
    pnl: float = 0.0


@dataclass
class BotState:
    account_type: str = DEFAULT_ACCOUNT
    stake: float = DEFAULT_STAKE
    expiry: int = DEFAULT_EXPIRY
    min_confidence: float = DEFAULT_MIN_CONF
    auto_trade: bool = DEFAULT_AUTO_TRADE
    scanning: bool = False
    daily_trades: int = 0
    daily_pnl: float = 0.0
    total_signals: int = 0
    wins: int = 0
    losses: int = 0
    signals_history: List[Signal] = field(default_factory=list)

    @property
    def winrate(self) -> float:
        total = self.wins + self.losses
        return (self.wins / total * 100) if total > 0 else 0.0


# ──────────────────────────────────────────────────────────────────────────────
# ANÁLISE TÉCNICA
# ──────────────────────────────────────────────────────────────────────────────
class TA:
    """Indicadores técnicos e padrões de vela."""

    @staticmethod
    def ema(values: List[float], period: int) -> Optional[float]:
        if len(values) < period:
            return None
        k = 2 / (period + 1)
        val = sum(values[:period]) / period
        for x in values[period:]:
            val = x * k + val * (1 - k)
        return val

    @staticmethod
    def rsi(values: List[float], period: int = 14) -> Optional[float]:
        if len(values) < period + 1:
            return None
        deltas = [values[i] - values[i - 1] for i in range(1, len(values))]
        gains = [max(d, 0) for d in deltas]
        losses = [max(-d, 0) for d in deltas]
        ag = sum(gains[:period]) / period
        al = sum(losses[:period]) / period
        for i in range(period, len(gains)):
            ag = (ag * (period - 1) + gains[i]) / period
            al = (al * (period - 1) + losses[i]) / period
        return 100.0 if al == 0 else 100 - 100 / (1 + ag / al)

    @staticmethod
    def macd(values: List[float]) -> Tuple[Optional[float], Optional[float]]:
        if len(values) < 35:
            return None, None
        e12 = TA.ema(values, 12)
        e26 = TA.ema(values, 26)
        if e12 is None or e26 is None:
            return None, None
        macd_line = e12 - e26
        macd_hist = []
        for i in range(26, len(values)):
            a = TA.ema(values[:i+1], 12)
            b = TA.ema(values[:i+1], 26)
            if a and b:
                macd_hist.append(a - b)
        signal = TA.ema(macd_hist, 9) if len(macd_hist) >= 9 else None
        return macd_line, signal

    @staticmethod
    def bollinger(values: List[float], period: int = 20) -> Tuple[Optional[float], Optional[float], Optional[float]]:
        if len(values) < period:
            return None, None, None
        w = values[-period:]
        mid = sum(w) / period
        std = (sum((x - mid) ** 2 for x in w) / period) ** 0.5
        return mid + 2 * std, mid, mid - 2 * std

    @staticmethod
    def stochastic(highs, lows, closes, k=14) -> Optional[float]:
        if len(closes) < k:
            return None
        h = max(highs[-k:])
        l = min(lows[-k:])
        if h == l:
            return 50.0
        return 100 * (closes[-1] - l) / (h - l)

    @staticmethod
    def is_hammer(c: dict) -> bool:
        body = abs(c["close"] - c["open"])
        lo_wick = min(c["open"], c["close"]) - c["min"]
        hi_wick = c["max"] - max(c["open"], c["close"])
        return body > 0 and lo_wick > body * 2 and hi_wick < body * 0.5

    @staticmethod
    def is_shooting_star(c: dict) -> bool:
        body = abs(c["close"] - c["open"])
        hi_wick = c["max"] - max(c["open"], c["close"])
        lo_wick = min(c["open"], c["close"]) - c["min"]
        return body > 0 and hi_wick > body * 2 and lo_wick < body * 0.5

    @staticmethod
    def is_doji(c: dict) -> bool:
        body = abs(c["close"] - c["open"])
        wick = c["max"] - c["min"]
        return wick > 0 and body / wick < 0.1

    @staticmethod
    def is_bull_engulf(prev: dict, curr: dict) -> bool:
        return (prev["close"] < prev["open"] and curr["close"] > curr["open"]
                and curr["open"] <= prev["close"] and curr["close"] >= prev["open"])

    @staticmethod
    def is_bear_engulf(prev: dict, curr: dict) -> bool:
        return (prev["close"] > prev["open"] and curr["close"] < curr["open"]
                and curr["open"] >= prev["close"] and curr["close"] <= prev["open"])

    @staticmethod
    def three_consec(candles: List[dict], direction: str) -> bool:
        if len(candles) < 3:
            return False
        last3 = candles[-3:]
        if direction == "up":
            return all(c["close"] > c["open"] for c in last3)
        return all(c["close"] < c["open"] for c in last3)


# ──────────────────────────────────────────────────────────────────────────────
# MOTOR DE ESTRATÉGIAS
# ──────────────────────────────────────────────────────────────────────────────
class StrategyEngine:
    """
    Analisa velas e retorna Signal com confiança baseada em votos
    ponderados de múltiplas estratégias técnicas.
    """

    WEIGHTS = {
        "EMA Cross":      20,
        "RSI":            15,
        "MACD":           20,
        "Bollinger":      15,
        "Stochastic":     10,
        "Engulfing":      10,
        "Hammer/Star":     5,
        "3 Velas":         5,
    }
    MAX_SCORE = sum(WEIGHTS.values())  # 100

    def analyse(self, asset: str, candles: List[dict], timeframe: str) -> Optional[Signal]:
        if len(candles) < 50:
            return None

        closes = [float(c["close"]) for c in candles]
        highs  = [float(c["max"])   for c in candles]
        lows   = [float(c["min"])   for c in candles]

        cs, ps = 0, 0          # call_score, put_score
        cr, pr = [], []        # call_reasons, put_reasons

        # 1 ─ EMA Cross
        e9  = TA.ema(closes, 9)
        e21 = TA.ema(closes, 21)
        if e9 and e21:
            if e9 > e21 and closes[-1] > e21:
                cs += self.WEIGHTS["EMA Cross"]; cr.append("EMA9>EMA21")
            elif e9 < e21 and closes[-1] < e21:
                ps += self.WEIGHTS["EMA Cross"]; pr.append("EMA9<EMA21")

        # 2 ─ RSI
        r = TA.rsi(closes)
        if r is not None:
            if 50 < r < 70:
                cs += self.WEIGHTS["RSI"]; cr.append(f"RSI {r:.0f}↑")
            elif 30 < r < 50:
                ps += self.WEIGHTS["RSI"]; pr.append(f"RSI {r:.0f}↓")
            elif r <= 30:
                cs += self.WEIGHTS["RSI"]; cr.append(f"RSI {r:.0f} Sobrevenda")
            elif r >= 70:
                ps += self.WEIGHTS["RSI"]; pr.append(f"RSI {r:.0f} Sobrecompra")

        # 3 ─ MACD
        ml, ms = TA.macd(closes)
        if ml is not None and ms is not None:
            if ml > ms and ml > 0:
                cs += self.WEIGHTS["MACD"]; cr.append("MACD Bullish")
            elif ml < ms and ml < 0:
                ps += self.WEIGHTS["MACD"]; pr.append("MACD Bearish")
            elif ml > ms:
                cs += int(self.WEIGHTS["MACD"] * 0.6); cr.append("MACD Cross↑")
            elif ml < ms:
                ps += int(self.WEIGHTS["MACD"] * 0.6); pr.append("MACD Cross↓")

        # 4 ─ Bollinger Bands
        upper, mid, lower = TA.bollinger(closes)
        if upper and lower and mid:
            if closes[-1] <= lower:
                cs += self.WEIGHTS["Bollinger"]; cr.append("BB Lower ↓→↑")
            elif closes[-1] >= upper:
                ps += self.WEIGHTS["Bollinger"]; pr.append("BB Upper ↑→↓")
            elif closes[-1] > mid:
                cs += int(self.WEIGHTS["Bollinger"] * 0.4); cr.append("BB Mid↑")
            else:
                ps += int(self.WEIGHTS["Bollinger"] * 0.4); pr.append("BB Mid↓")

        # 5 ─ Stochastic
        st = TA.stochastic(highs, lows, closes)
        if st is not None:
            if st < 20:
                cs += self.WEIGHTS["Stochastic"]; cr.append(f"Stoch {st:.0f} Oversold")
            elif st > 80:
                ps += self.WEIGHTS["Stochastic"]; pr.append(f"Stoch {st:.0f} Overbought")

        # 6 ─ Padrões de Engulfing
        if len(candles) >= 2:
            prev, curr = candles[-2], candles[-1]
            if TA.is_bull_engulf(prev, curr):
                cs += self.WEIGHTS["Engulfing"]; cr.append("Engulfing Bull 🐂")
            elif TA.is_bear_engulf(prev, curr):
                ps += self.WEIGHTS["Engulfing"]; pr.append("Engulfing Bear 🐻")

        # 7 ─ Hammer / Shooting Star
        last = candles[-1]
        if TA.is_hammer(last):
            cs += self.WEIGHTS["Hammer/Star"]; cr.append("Martelo 🔨")
        elif TA.is_shooting_star(last):
            ps += self.WEIGHTS["Hammer/Star"]; pr.append("Estrela Cadente 🌠")

        # 8 ─ 3 Velas Consecutivas
        if TA.three_consec(candles, "up"):
            cs += self.WEIGHTS["3 Velas"]; cr.append("3 Altas Seguidas")
        elif TA.three_consec(candles, "down"):
            ps += self.WEIGHTS["3 Velas"]; pr.append("3 Baixas Seguidas")

        # ── Decisão ────────────────────────────────────────────────────────
        if cs == ps or (cs == 0 and ps == 0):
            return None

        if cs > ps:
            conf = min(99, round(cs / self.MAX_SCORE * 100))
            return Signal(asset=asset, direction="CALL", confidence=conf,
                          timeframe=timeframe, strategies=cr)
        else:
            conf = min(99, round(ps / self.MAX_SCORE * 100))
            return Signal(asset=asset, direction="PUT", confidence=conf,
                          timeframe=timeframe, strategies=pr)


# ──────────────────────────────────────────────────────────────────────────────
# TELEGRAM NOTIFIER
# ──────────────────────────────────────────────────────────────────────────────
class TelegramNotifier:
    BASE = "https://api.telegram.org/bot"

    def __init__(self, token: str, chat_id: str):
        self.token    = token
        self.chat_id  = chat_id
        self._enabled = bool(token and chat_id)

    def send(self, text: str, parse_mode: str = "HTML") -> bool:
        if not self._enabled:
            return False
        try:
            r = requests.post(
                f"{self.BASE}{self.token}/sendMessage",
                json={"chat_id": self.chat_id, "text": text, "parse_mode": parse_mode},
                timeout=10,
            )
            return r.ok
        except Exception as e:
            LOG.error(f"Telegram send error: {e}")
            return False

    def fmt_signal(self, sig: Signal, account: str) -> str:
        arrow  = "📈" if sig.direction == "CALL" else "📉"
        acct   = "🔵 DEMO" if "PRACTICE" in account.upper() else "🔴 REAL"
        ts     = sig.entry_time.strftime("%H:%M UTC")
        strats = "\n   • ".join(sig.strategies) if sig.strategies else "—"
        return (
            f"<b>🤖 RW TIPS SCANNER</b>\n"
            f"━━━━━━━━━━━━━━━━━━━━━━━━\n"
            f"{arrow} <b>{sig.direction}</b>  |  <b>{sig.asset}</b>  [{sig.timeframe}]\n"
            f"⚡ Confiança: <b>{sig.confidence:.0f}%</b>\n"
            f"⏱ Expiração: <b>{sig.expiry}min</b>  |  💵 Stake: <b>${sig.stake:.2f}</b>\n"
            f"👤 Conta: {acct}  |  🕐 {ts}\n"
            f"━━━━━━━━━━━━━━━━━━━━━━━━\n"
            f"🔍 <b>Estratégias:</b>\n"
            f"   • {strats}\n"
            f"━━━━━━━━━━━━━━━━━━━━━━━━\n"
            f"<i>⚠️ Opere com responsabilidade. Past ≠ Future.</i>"
        )

    def fmt_result(self, sig: Signal) -> str:
        if sig.result == "win":
            icon, emoji = "WIN ✅", "🎉"
        elif sig.result == "loss":
            icon, emoji = "LOSS ❌", "😔"
        else:
            icon, emoji = "Pendente ⏳", "🔄"
        return (
            f"<b>{emoji} {icon}</b>\n"
            f"📊 {sig.asset} [{sig.timeframe}] {sig.direction}\n"
            f"💰 P&L: <b>${sig.pnl:+.2f}</b>"
        )

    def fmt_stats(self, s: BotState) -> str:
        return (
            f"<b>📊 ESTATÍSTICAS</b>\n"
            f"━━━━━━━━━━━━━━━━━━━━━━━━\n"
            f"✅ Wins: <b>{s.wins}</b>  |  ❌ Losses: <b>{s.losses}</b>\n"
            f"📈 Winrate: <b>{s.winrate:.1f}%</b>\n"
            f"💰 P&L Hoje: <b>${s.daily_pnl:+.2f}</b>\n"
            f"🎯 Sinais gerados: <b>{s.total_signals}</b>\n"
            f"🔄 Trades hoje: <b>{s.daily_trades}/{MAX_DAILY_TRADES}</b>\n"
            f"━━━━━━━━━━━━━━━━━━━━━━━━\n"
            f"⚙️ Conf min: {s.min_confidence}%  •  Stake: ${s.stake:.2f}  •  Exp: {s.expiry}min"
        )


# ──────────────────────────────────────────────────────────────────────────────
# ADAPTADOR IQ OPTION
# ──────────────────────────────────────────────────────────────────────────────
class IQAdapter:
    def __init__(self):
        self.client = None
        self._ok    = False

    def connect(self, account_type: str = "PRACTICE") -> bool:
        try:
            from iqoptionapi.iqapi import IQOptionClient
            act = "demo" if "PRACTICE" in account_type.upper() else "real"
            self.client = IQOptionClient(IQ_EMAIL, IQ_PASSWORD, account_type=act)
            self._ok    = bool(self.client.connect())
            if self._ok:
                LOG.info(f"✅ IQ Option conectado | {account_type} | ${self.client.get_balance():.2f}")
            return self._ok
        except Exception as e:
            LOG.error(f"❌ IQ Option conexão falhou: {e}")
            return False

    def switch_account(self, account_type: str):
        if not self._ok or not self.client:
            return
        try:
            act = "demo" if "PRACTICE" in account_type.upper() else "real"
            self.client.switch_account(act)
        except Exception as e:
            LOG.error(f"Erro ao trocar conta: {e}")

    def get_balance(self) -> float:
        try:
            return float(self.client.get_balance()) if self._ok else 0.0
        except Exception:
            return 0.0

    def get_open_assets(self) -> List[str]:
        if not self._ok:
            return []
        try:
            from iqoptionapi.models import InstrumentType
            actives = {}
            for itype in [InstrumentType.BINARY_OPTION, InstrumentType.TURBO_OPTION]:
                try:
                    actives.update(self.client.get_actives(itype))
                except Exception:
                    pass
            assets = [
                info["ticker"] for _, info in actives.items()
                if info.get("is_open") and info.get("profit_percent", 0) >= 70
            ]
            LOG.info(f"📋 {len(assets)} ativos abertos com payout >=70%")
            return assets[:MAX_ASSETS_PER_SCAN]
        except Exception as e:
            LOG.error(f"Erro get_open_assets: {e}")
            return []

    def get_candles(self, asset: str, timeframe_sec: int) -> List[dict]:
        if not self._ok:
            return []
        try:
            result = self.client.get_candles(asset, count=LOOKBACK_CANDLES, timeframe=timeframe_sec)
            return result if result else []
        except Exception as e:
            LOG.debug(f"Erro candles {asset}/{timeframe_sec}s: {e}")
            return []

    def place_trade(self, sig: Signal) -> Tuple[bool, Optional[int]]:
        if not self._ok or not self.client:
            return False, None
        try:
            from iqoptionapi.models import OptionsTradeParams, Direction, OptionType
            direction = Direction.CALL if sig.direction == "CALL" else Direction.PUT
            params = OptionsTradeParams(
                asset=sig.asset,
                expiry=sig.expiry,
                amount=sig.stake,
                direction=direction,
                option_type=OptionType.BINARY_OPTION,
            )
            ok, order_id = self.client.execute_options_trade(params)
            if ok:
                LOG.info(f"✅ Trade: {sig.asset} {sig.direction} ${sig.stake} | #{order_id}")
            else:
                LOG.error(f"❌ Trade falhou: {order_id}")
            return (True, order_id) if ok else (False, None)
        except Exception as e:
            LOG.error(f"Erro place_trade: {e}")
            return False, None

    def get_result(self, order_id: int, expiry: int) -> Tuple[bool, float]:
        if not self._ok or not self.client:
            return False, 0.0
        try:
            ok, _, pnl = self.client.get_trade_outcome(order_id, expiry=expiry)
            return (True, float(pnl)) if ok else (False, 0.0)
        except Exception:
            return False, 0.0


# ──────────────────────────────────────────────────────────────────────────────
# BOT PRINCIPAL
# ──────────────────────────────────────────────────────────────────────────────
class RWTipsBot:
    def __init__(self):
        self.state    = BotState()
        self.iq       = IQAdapter()
        self.tg       = TelegramNotifier(TG_TOKEN, TG_CHAT_ID)
        self.engine   = StrategyEngine()
        self._stop    = threading.Event()
        self._thread: Optional[threading.Thread] = None

    def start(self) -> bool:
        LOG.info("🚀 Iniciando RW Tips Scanner...")
        if not IQ_EMAIL or not IQ_PASSWORD:
            LOG.critical("Configure IQ_EMAIL e IQ_PASSWORD no .env")
            return False
        ok = self.iq.connect(self.state.account_type)
        if not ok:
            return False
        acct_label = "🔵 DEMO" if "PRACTICE" in self.state.account_type.upper() else "🔴 REAL"
        self.tg.send(
            f"<b>🤖 RW Tips Scanner INICIADO</b>\n"
            f"👤 Conta: {acct_label}\n"
            f"💰 Saldo: ${self.iq.get_balance():.2f}\n"
            f"🎯 Confiança mín: {self.state.min_confidence}%\n"
            f"🔄 Auto-trade: {'✅' if self.state.auto_trade else '❌'}"
        )
        return True

    def stop(self):
        self._stop.set()
        self.state.scanning = False

    def run_background(self):
        if self._thread and self._thread.is_alive():
            LOG.warning("Scanner já em execução")
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._loop, daemon=True, name="ScanLoop")
        self._thread.start()

    def _loop(self):
        self.state.scanning = True
        LOG.info(f"🔍 Scan loop iniciado | intervalo={SCAN_INTERVAL}s")
        while not self._stop.is_set():
            try:
                self._scan()
            except Exception as e:
                LOG.error(f"Erro no ciclo: {e}", exc_info=True)
            self._stop.wait(SCAN_INTERVAL)
        self.state.scanning = False
        LOG.info("✅ Scan loop encerrado")

    def _scan(self):
        assets = self.iq.get_open_assets()
        if not assets:
            LOG.warning("Nenhum ativo aberto")
            return

        LOG.info(f"🔎 Analisando {len(assets)} ativos x {len(TIMEFRAMES)} timeframes...")
        signals: List[Signal] = []

        for asset in assets:
            if self._stop.is_set():
                break
            for tf_name, tf_sec in TIMEFRAMES.items():
                try:
                    candles = self.iq.get_candles(asset, tf_sec)
                    if len(candles) < 50:
                        continue
                    sig = self.engine.analyse(asset, candles, tf_name)
                    if sig and sig.confidence >= self.state.min_confidence:
                        sig.stake  = self.state.stake
                        sig.expiry = self.state.expiry
                        signals.append(sig)
                        LOG.info(f"💡 {sig.asset} {sig.direction} [{sig.timeframe}] {sig.confidence:.0f}%")
                except Exception as e:
                    LOG.debug(f"Erro {asset}/{tf_name}: {e}")
            time.sleep(0.3)

        signals.sort(key=lambda s: s.confidence, reverse=True)
        top = signals[:5]

        if not top:
            LOG.info(f"📊 Sem sinais acima de {self.state.min_confidence}% neste ciclo")
            return

        LOG.info(f"🎯 {len(top)} sinais qualificados!")
        for sig in top:
            self._process(sig)

    def _process(self, sig: Signal):
        self.state.total_signals += 1
        self.state.signals_history.append(sig)
        self.tg.send(self.tg.fmt_signal(sig, self.state.account_type))

        if not self.state.auto_trade:
            return
        if self.state.daily_trades >= MAX_DAILY_TRADES:
            LOG.warning(f"⛔ Limite diário de trades atingido ({MAX_DAILY_TRADES})")
            return
        if self.state.daily_pnl <= -MAX_DAILY_LOSS_USD:
            LOG.warning(f"⛔ Stop loss diário atingido (${MAX_DAILY_LOSS_USD})")
            return

        ok, order_id = self.iq.place_trade(sig)
        if ok and order_id:
            sig.order_id = order_id
            sig.result   = "pending"
            self.state.daily_trades += 1
            threading.Thread(
                target=self._await_result, args=(sig,),
                daemon=True, name=f"Res-{order_id}"
            ).start()

    def _await_result(self, sig: Signal):
        wait = sig.expiry * 60 + 5
        LOG.info(f"⏳ Aguardando resultado #{sig.order_id} por {wait}s...")
        time.sleep(wait)
        ok, pnl = self.iq.get_result(sig.order_id, sig.expiry)
        if ok:
            sig.pnl    = pnl
            sig.result = "win" if pnl >= 0 else "loss"
            self.state.daily_pnl += pnl
            if pnl >= 0:
                self.state.wins += 1
            else:
                self.state.losses += 1
            self.tg.send(self.tg.fmt_result(sig))
            LOG.info(f"📊 {sig.result.upper()} | P&L ${pnl:+.2f} | WR {self.state.winrate:.1f}%")


# ──────────────────────────────────────────────────────────────────────────────
# TELEGRAM COMMAND BOT (long polling via requests)
# ──────────────────────────────────────────────────────────────────────────────
HELP_TEXT = """<b>🤖 Comandos RW Tips Scanner</b>
━━━━━━━━━━━━━━━━━━━━━━━━
/start_scan     — inicia o scanner
/stop_scan      — para o scanner
/scan_now       — força scan imediato
/status         — status e estatísticas
/balance        — saldo atual
━━━━━━━━━━━━━━━━━━━━━━━━
/demo           — usa conta DEMO ✅
/real           — usa conta REAL ⚠️
/autotrade_on   — ativa entrada automática
/autotrade_off  — desativa entrada automática
━━━━━━━━━━━━━━━━━━━━━━━━
/stake &lt;valor&gt;  — stake (ex: /stake 5)
/expiry &lt;min&gt;   — expiração (ex: /expiry 5)
/conf &lt;pct&gt;     — confiança mín (ex: /conf 80)
/help           — esta mensagem"""


class TGCommandBot:
    def __init__(self, bot: RWTipsBot):
        self.bot      = bot
        self.token    = TG_TOKEN
        self.chat_id  = str(TG_CHAT_ID)
        self._offset  = 0
        self._running = False
        self._base    = f"https://api.telegram.org/bot{self.token}"

    def _updates(self) -> list:
        try:
            r = requests.get(
                f"{self._base}/getUpdates",
                params={"offset": self._offset, "timeout": 30},
                timeout=35,
            )
            if r.ok:
                return r.json().get("result", [])
        except Exception:
            pass
        return []

    def _reply(self, text: str):
        self.bot.tg.send(text)

    def _handle(self, text: str):
        parts = text.strip().split()
        cmd   = parts[0].lower().lstrip("/").split("@")[0]
        args  = parts[1:]
        s     = self.bot.state

        if cmd in ("help", "start"):
            self._reply(HELP_TEXT)

        elif cmd == "start_scan":
            if s.scanning:
                self._reply("⚠️ Scanner já está ativo.")
            else:
                self.bot.run_background()
                self._reply("✅ Scanner iniciado!")

        elif cmd == "stop_scan":
            self.bot.stop()
            self._reply("🛑 Scanner parado.")

        elif cmd == "scan_now":
            self._reply("🔍 Forçando scan...")
            threading.Thread(target=self.bot._scan, daemon=True).start()

        elif cmd == "status":
            acct    = s.account_type
            scan_st = "🟢 Ativo" if s.scanning else "🔴 Parado"
            at_st   = "✅ ON" if s.auto_trade else "❌ OFF"
            bal     = self.bot.iq.get_balance()
            self._reply(
                f"<b>📊 STATUS</b>\n"
                f"🔄 Scanner: {scan_st}  |  🤖 Auto-trade: {at_st}\n"
                f"👤 Conta: {acct}  |  💰 Saldo: ${bal:.2f}\n\n"
                + self.bot.tg.fmt_stats(s)
            )

        elif cmd == "balance":
            self._reply(f"💰 Saldo: <b>${self.bot.iq.get_balance():.2f}</b>")

        elif cmd == "demo":
            s.account_type = "PRACTICE"
            self.bot.iq.switch_account("PRACTICE")
            self._reply(f"🔵 Conta trocada para DEMO | ${self.bot.iq.get_balance():.2f}")

        elif cmd == "real":
            s.account_type = "REAL"
            self.bot.iq.switch_account("REAL")
            self._reply(
                f"🔴 Conta trocada para REAL | ${self.bot.iq.get_balance():.2f}\n"
                f"<b>⚠️ ATENÇÃO: conta REAL ativada!</b>"
            )

        elif cmd == "autotrade_on":
            s.auto_trade = True
            self._reply("✅ Auto-trade ATIVADO — bot executará entradas automáticas.")

        elif cmd == "autotrade_off":
            s.auto_trade = False
            self._reply("❌ Auto-trade DESATIVADO — apenas sinais.")

        elif cmd == "stake":
            if args:
                try:
                    v = float(args[0]); assert v >= 1
                    s.stake = v
                    self._reply(f"✅ Stake: <b>${v:.2f}</b>")
                except Exception:
                    self._reply("❌ Use: /stake 5")
            else:
                self._reply(f"💵 Stake atual: ${s.stake:.2f}")

        elif cmd == "expiry":
            if args:
                try:
                    v = int(args[0]); assert v >= 1
                    s.expiry = v
                    self._reply(f"✅ Expiração: <b>{v}min</b>")
                except Exception:
                    self._reply("❌ Use: /expiry 5")
            else:
                self._reply(f"⏱ Expiração: {s.expiry}min")

        elif cmd == "conf":
            if args:
                try:
                    v = int(args[0]); assert 50 <= v <= 99
                    s.min_confidence = v
                    self._reply(f"✅ Confiança mínima: <b>{v}%</b>")
                except Exception:
                    self._reply("❌ Use: /conf 80  (50-99)")
            else:
                self._reply(f"🎯 Confiança mínima: {s.min_confidence}%")

        else:
            self._reply(f"❓ Comando desconhecido: /{cmd}\nUse /help")

    def run(self):
        if not self.token or not self.chat_id:
            LOG.warning("Telegram não configurado — modo headless")
            return
        self._running = True
        LOG.info("📱 Telegram command bot iniciado")
        while self._running:
            try:
                updates = self._updates()
                for upd in updates:
                    self._offset = upd["update_id"] + 1
                    msg = upd.get("message", {})
                    if not msg:
                        continue
                    if str(msg.get("chat", {}).get("id")) != self.chat_id:
                        continue
                    text = msg.get("text", "")
                    if text.startswith("/"):
                        try:
                            self._handle(text)
                        except Exception as e:
                            LOG.error(f"Erro comando '{text}': {e}")
            except Exception as e:
                LOG.error(f"Erro polling: {e}")
                time.sleep(5)

    def stop(self):
        self._running = False


# ──────────────────────────────────────────────────────────────────────────────
# PONTO DE ENTRADA
# ──────────────────────────────────────────────────────────────────────────────
def main():
    print("""
╔══════════════════════════════════════════════════════════╗
║         🤖 RW TIPS SCANNER — IQ Option Bot v2.0         ║
║  Análise técnica • Sinais Telegram • Auto-trade          ║
╚══════════════════════════════════════════════════════════╝
    """)

    bot = RWTipsBot()
    if not bot.start():
        LOG.critical("Falha ao iniciar. Verifique .env e tente novamente.")
        return

    tg_cmd = TGCommandBot(bot)
    tg_thread = threading.Thread(target=tg_cmd.run, daemon=True, name="TGCmd")
    tg_thread.start()

    bot.run_background()
    LOG.info("▶️  Bot em execução. Pressione Ctrl+C para parar.")

    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        LOG.info("\n🛑 Encerrando...")
        bot.stop()
        tg_cmd.stop()
        LOG.info("✅ Encerrado com sucesso.")


if __name__ == "__main__":
    main()
