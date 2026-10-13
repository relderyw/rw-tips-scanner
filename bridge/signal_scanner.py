"""signal_scanner.py — Motor de sinais integrado ao RW TIPS Bridge.

Integra-se ao Collector via hook em on_new_candle:
  - A cada vela fechada, busca o histórico do SQLite (db.query)
  - Aplica 8 indicadores/padrões técnicos com pesos
  - Se confiança >= MIN_CONFIDENCE, envia sinal via telegram_notifications
  - Armazena deduplication por (asset, tf, direction, candle_time)

Não executa trades. Não tem estado próprio de conexão.
É instanciado pelo main.py e registrado no Collector de cada sessão.
"""
from __future__ import annotations

import hashlib
import json
import logging
from pathlib import Path
import re
import threading
import time
from collections import deque
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple

import config
import db
import telegram_notifications

log = logging.getLogger("signal_scanner")

CONFIG_PATH = Path(__file__).parent / "data" / "scanner_config.json"

def _load_persisted_config() -> dict:
    try:
        if CONFIG_PATH.exists():
            with open(CONFIG_PATH, "r", encoding="utf-8") as f:
                return json.load(f)
    except Exception as e:
        log.warning("Falha ao ler scanner_config.json: %s", e)
    return {}

def _save_persisted_config(cfg: dict) -> None:
    try:
        CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
        with open(CONFIG_PATH, "w", encoding="utf-8") as f:
            json.dump(cfg, f, indent=2)
    except Exception as e:
        log.warning("Falha ao gravar scanner_config.json: %s", e)

# ─── Configuração ─────────────────────────────────────────────────────────────
MIN_CONFIDENCE: int  = int(__import__("os").getenv("SCANNER_MIN_CONFIDENCE", "70"))
MIN_CANDLES:    int  = 50       # mínimo de velas no histórico para analisar
LOOKBACK_HOURS: int  = 48       # janela do histórico buscada no SQLite
COOLDOWN_SECS:  int  = 300      # segundos sem repetir sinal para o mesmo ativo+tf
MIN_PAYOUT:     int  = 70       # payout mínimo para enviar sinal (%)

# ─── Pesos das estratégias (soma = 100) ───────────────────────────────────────
WEIGHTS: Dict[str, int] = {
    "EMA Cross":    20,
    "MACD":         20,
    "RSI":          15,
    "Bollinger":    15,
    "Stochastic":   10,
    "Engulfing":    10,
    "Hammer/Star":   5,
    "3 Velas":       5,
}
MAX_SCORE = sum(WEIGHTS.values())  # 100


# ─── Indicadores técnicos ─────────────────────────────────────────────────────
def _ema(values: List[float], period: int) -> Optional[float]:
    if len(values) < period:
        return None
    k = 2 / (period + 1)
    v = sum(values[:period]) / period
    for x in values[period:]:
        v = x * k + v * (1 - k)
    return v


def _rsi(values: List[float], period: int = 14) -> Optional[float]:
    if len(values) < period + 1:
        return None
    d = [values[i] - values[i - 1] for i in range(1, len(values))]
    gains = [max(x, 0) for x in d]
    losses = [max(-x, 0) for x in d]
    ag = sum(gains[:period]) / period
    al = sum(losses[:period]) / period
    for i in range(period, len(gains)):
        ag = (ag * (period - 1) + gains[i]) / period
        al = (al * (period - 1) + losses[i]) / period
    return 100.0 if al == 0 else 100 - 100 / (1 + ag / al)


def _macd(values: List[float]) -> Tuple[Optional[float], Optional[float]]:
    if len(values) < 35:
        return None, None
    e12 = _ema(values, 12)
    e26 = _ema(values, 26)
    if e12 is None or e26 is None:
        return None, None
    ml = e12 - e26
    hist = []
    for i in range(26, len(values)):
        a = _ema(values[:i+1], 12)
        b = _ema(values[:i+1], 26)
        if a and b:
            hist.append(a - b)
    ms = _ema(hist, 9) if len(hist) >= 9 else None
    return ml, ms


def _bollinger(values: List[float], period: int = 20) -> Tuple[Optional[float], Optional[float], Optional[float]]:
    if len(values) < period:
        return None, None, None
    w = values[-period:]
    mid = sum(w) / period
    std = (sum((x - mid) ** 2 for x in w) / period) ** 0.5
    return mid + 2 * std, mid, mid - 2 * std


def _stochastic(highs: List[float], lows: List[float], closes: List[float], k: int = 14) -> Optional[float]:
    if len(closes) < k:
        return None
    h = max(highs[-k:])
    l = min(lows[-k:])
    return 50.0 if h == l else 100 * (closes[-1] - l) / (h - l)


def _is_hammer(c: dict) -> bool:
    body = abs(c["close"] - c["open"])
    lo   = min(c["open"], c["close"]) - c["low"]
    hi   = c["high"] - max(c["open"], c["close"])
    return body > 0 and lo > body * 2 and hi < body * 0.5


def _is_shooting_star(c: dict) -> bool:
    body = abs(c["close"] - c["open"])
    hi   = c["high"] - max(c["open"], c["close"])
    lo   = min(c["open"], c["close"]) - c["low"]
    return body > 0 and hi > body * 2 and lo < body * 0.5


def _is_bull_engulf(prev: dict, curr: dict) -> bool:
    return (
        prev["close"] < prev["open"] and curr["close"] > curr["open"]
        and curr["open"] <= prev["close"] and curr["close"] >= prev["open"]
    )


def _is_bear_engulf(prev: dict, curr: dict) -> bool:
    return (
        prev["close"] > prev["open"] and curr["close"] < curr["open"]
        and curr["open"] >= prev["close"] and curr["close"] <= prev["open"]
    )


def _three_consec(candles: List[dict], direction: str) -> bool:
    if len(candles) < 3:
        return False
    last3 = candles[-3:]
    if direction == "up":
        return all(c["close"] > c["open"] for c in last3)
    return all(c["close"] < c["open"] for c in last3)


# ─── Modelo de sinal ──────────────────────────────────────────────────────────
@dataclass
class ScannerSignal:
    asset:      str
    direction:  str       # "CALL" ou "PUT"
    confidence: int       # 0–99
    timeframe:  str       # "M1", "M5", "M15"
    strategies: List[str]
    candle_time: int      # timestamp unix da vela que disparou
    payout:     int = 0


# ─── Motor de análise técnica por confluência ────────────────────────────────
def analyse(asset: str, candles: List[dict], timeframe: str) -> Optional[ScannerSignal]:
    """Analisa velas e retorna ScannerSignal baseado em confluência técnica real (Setups)."""
    if len(candles) < MIN_CANDLES:
        return None

    closes = [float(c["close"]) for c in candles]
    highs  = [float(c["high"])  for c in candles]
    lows   = [float(c["low"])   for c in candles]
    opens  = [float(c["open"])  for c in candles]

    last = candles[-1]
    prev = candles[-2]
    curr_c = closes[-1]
    curr_o = opens[-1]
    curr_h = highs[-1]
    curr_l = lows[-1]

    # Indicadores principais
    e9  = _ema(closes, 9)
    e21 = _ema(closes, 21)
    ml, ms = _macd(closes)
    r   = _rsi(closes)
    upper, mid, lower = _bollinger(closes)
    st  = _stochastic(highs, lows, closes)

    call_reasons: List[str] = []
    put_reasons: List[str] = []
    call_score = 0
    put_score = 0

    # -------------------------------------------------------------
    # SETUP 1: Reversão / Retração em Exaustão (Mean Reversion)
    # -------------------------------------------------------------
    # CALL: Toque ou rompimento da banda inferior + Sobrevenda + Padrão de rejeição
    if lower and curr_c <= lower * 1.0015:
        call_score += 25
        call_reasons.append("Toque Banda Inferior BB")
    if r is not None and r <= 32:
        call_score += 25
        call_reasons.append(f"RSI Sobrevendido ({r:.0f})")
    elif r is not None and r <= 40:
        call_score += 10
        call_reasons.append(f"RSI Baixo ({r:.0f})")

    if st is not None and st <= 22:
        call_score += 15
        call_reasons.append(f"Estocástico Exaustão ({st:.0f})")

    if _is_hammer(last):
        call_score += 20
        call_reasons.append("Martelo de Alta")
    elif _is_bull_engulf(prev, last):
        call_score += 25
        call_reasons.append("Engolfo de Alta")
    elif curr_c > curr_o and (curr_o - curr_l) > abs(curr_c - curr_o) * 1.2:
        call_score += 15
        call_reasons.append("Pavio Inferior de Rejeição")

    # PUT: Toque ou rompimento da banda superior + Sobrecompra + Padrão de rejeição
    if upper and curr_c >= upper * 0.9985:
        put_score += 25
        put_reasons.append("Toque Banda Superior BB")
    if r is not None and r >= 68:
        put_score += 25
        put_reasons.append(f"RSI Sobrecomprado ({r:.0f})")
    elif r is not None and r >= 60:
        put_score += 10
        put_reasons.append(f"RSI Alto ({r:.0f})")

    if st is not None and st >= 78:
        put_score += 15
        put_reasons.append(f"Estocástico Exaustão ({st:.0f})")

    if _is_shooting_star(last):
        put_score += 20
        put_reasons.append("Estrela Cadente")
    elif _is_bear_engulf(prev, last):
        put_score += 25
        put_reasons.append("Engolfo de Baixa")
    elif curr_c < curr_o and (curr_h - curr_o) > abs(curr_c - curr_o) * 1.2:
        put_score += 15
        put_reasons.append("Pavio Superior de Rejeição")

    # -------------------------------------------------------------
    # SETUP 2: Tendência & Fluxo (Trend Following & Momentum)
    # -------------------------------------------------------------
    # CALL: EMA9 > EMA21 + Preço acima das EMAs + MACD positivo
    if e9 and e21 and e9 > e21 and curr_c > e9:
        trend_call_score = 25
        trend_call_reasons = ["Tendência Alta (EMA9>EMA21)"]
        if ml is not None and ms is not None and ml > ms:
            trend_call_score += 20
            trend_call_reasons.append("MACD Bullish")
        if _three_consec(candles, "up"):
            trend_call_score += 15
            trend_call_reasons.append("Fluxo 3 Velas Verdes")
        if r is not None and 50 <= r <= 68:
            trend_call_score += 15
            trend_call_reasons.append(f"RSI Favorável ({r:.0f})")
        # Se o score de tendência for forte, junta ao call
        if trend_call_score >= 45:
            call_score += trend_call_score
            call_reasons.extend(trend_call_reasons)

    # PUT: EMA9 < EMA21 + Preço abaixo das EMAs + MACD negativo
    if e9 and e21 and e9 < e21 and curr_c < e9:
        trend_put_score = 25
        trend_put_reasons = ["Tendência Baixa (EMA9<EMA21)"]
        if ml is not None and ms is not None and ml < ms:
            trend_put_score += 20
            trend_put_reasons.append("MACD Bearish")
        if _three_consec(candles, "down"):
            trend_put_score += 15
            trend_put_reasons.append("Fluxo 3 Velas Vermelhas")
        if r is not None and 32 <= r <= 50:
            trend_put_score += 15
            trend_put_reasons.append(f"RSI Favorável ({r:.0f})")
        if trend_put_score >= 45:
            put_score += trend_put_score
            put_reasons.extend(trend_put_reasons)

    # -------------------------------------------------------------
    # Decisão por Confluência Mínima
    # -------------------------------------------------------------
    candle_time = int(candles[-1]["time"])

    # Exige confluência real: pelo menos 2 razões e pontuação >= 45
    if call_score >= 45 and call_score > put_score and len(call_reasons) >= 2:
        confidence = min(96, max(65, int(60 + (call_score / 120.0) * 36)))
        return ScannerSignal(
            asset=asset,
            direction="CALL",
            confidence=confidence,
            timeframe=timeframe,
            strategies=list(dict.fromkeys(call_reasons))[:4],
            candle_time=candle_time,
        )

    if put_score >= 45 and put_score > call_score and len(put_reasons) >= 2:
        confidence = min(96, max(65, int(60 + (put_score / 120.0) * 36)))
        return ScannerSignal(
            asset=asset,
            direction="PUT",
            confidence=confidence,
            timeframe=timeframe,
            strategies=list(dict.fromkeys(put_reasons))[:4],
            candle_time=candle_time,
        )

    return None


# ─── Formatador de mensagem Telegram (MarkdownV2) ─────────────────────────────
def _escape(text: str) -> str:
    import re
    return re.sub(r"([_*\[\]()~`>#+=|{}.!\\\-])", r"\\\1", str(text))


def _build_telegram_message(
    sig: ScannerSignal,
    entry_time_str: str,
    account_type: str = "PRACTICE",
    order_info: str = "",
    display_name: str = "",
) -> str:
    arrow  = "📈" if sig.direction == "CALL" else "📉"
    tf_map = {"M1": "1 minuto (M1)", "M5": "5 minutos (M5)", "M15": "15 minutos (M15)", "1m": "1 minuto (M1)", "5m": "5 minutos (M5)"}
    tf_str = tf_map.get(sig.timeframe, sig.timeframe)
    payout_str = f"{sig.payout}%" if sig.payout else "—"
    strats = "\n  ✦ ".join(_escape(s) for s in sig.strategies)
    acct_label = "🔵 DEMO (PRACTICE)" if "PRACTICE" in account_type.upper() or "DEMO" in account_type.upper() else "🔴 CONTA REAL"
    trade_line = f"\n⚡ *Entrada automática:* `{_escape(order_info)}`" if order_info else ""
    asset_title = display_name if display_name else sig.asset

    return (
        f"🤖 *RW TIPS SCANNER*\n"
        f"━━━━━━━━━━━━━━━━━━━━━━\n"
        f"{arrow} *{_escape(sig.direction)}*  \\|  *{_escape(asset_title)}*\n"
        f"⏱ Timeframe: *{_escape(tf_str)}*\n"
        f"⚡ Assertividade/Confiança: *{sig.confidence}%*\n"
        f"💰 Payout: *{_escape(payout_str)}*\n"
        f"👤 Modo: *{_escape(acct_label)}*\n"
        f"🕐 Horário da Vela: *{_escape(entry_time_str)}*{trade_line}\n"
        f"━━━━━━━━━━━━━━━━━━━━━━\n"
        f"🔍 *Padrões detectados:*\n"
        f"  ✦ {strats}\n"
        f"━━━━━━━━━━━━━━━━━━━━━━\n"
        f"⚠️ _Opere com gerenciamento de risco\\._"
    )


# ─── Scanner por sessão ────────────────────────────────────────────────────────
class SessionScanner:
    """
    Instância por sessão de usuário.
    Recebe callbacks de vela fechada do Collector e decide se envia sinal.
    """

    def __init__(
        self,
        session_token: str,
        identity_hash: str,
        db_path: str,
        payouts: Dict[str, int],
        collector=None,
    ):
        self.session_token  = session_token
        self.identity_hash  = identity_hash
        self.db_path        = db_path
        self.payouts        = payouts   # referência ao dict vivo do Collector
        self.collector      = collector
        self._lock          = threading.Lock()
        # Deduplication: chave = (asset_id, tf, direction) → ultimo timestamp enviado
        self._last_sent: Dict[Tuple[str, str, str], float] = {}
        # Sinais emitidos nesta sessão (para /scanner/signals)
        self.signals_history: List[dict] = []
        self._enabled = True

        persisted = _load_persisted_config()
        self.auto_trade: bool = persisted.get("auto_trade", __import__("os").getenv("AUTO_TRADE", "false").lower() == "true")
        self.stake: float = float(persisted.get("stake", __import__("os").getenv("DEFAULT_STAKE", "2.0")))
        self.min_confidence: int = int(persisted.get("min_confidence", __import__("os").getenv("DEFAULT_MIN_CONF", str(MIN_CONFIDENCE))))
        self.min_payout: int = int(persisted.get("min_payout", MIN_PAYOUT))
        self.max_gales: int = int(persisted.get("max_gales", __import__("os").getenv("MAX_GALES", "1")))
        self.gale_multiplier: float = float(persisted.get("gale_multiplier", __import__("os").getenv("GALE_MULTIPLIER", "2.0")))
        self.blacklist: set = set(persisted.get("blacklist", []))
        # Cache em memória RAM das últimas velas para latência zero (sem bater no disco a cada vela)
        self._candles_cache: Dict[Tuple[str, str], deque] = {}

    def _normalize_asset(self, asset: str) -> str:
        return asset.replace("-OTC", "").replace("-op", "").replace("(OTC)", "").replace("/", "").strip().upper()

    def is_blacklisted(self, asset: str) -> bool:
        if not asset or not self.blacklist:
            return False
        clean = self._normalize_asset(asset)
        with self._lock:
            for b in self.blacklist:
                if self._normalize_asset(b) == clean or b.upper() == asset.upper():
                    return True
        return False

    def add_to_blacklist(self, asset: str) -> list:
        clean = self._normalize_asset(asset)
        with self._lock:
            self.blacklist.add(clean)
            _save_persisted_config({
                "auto_trade": self.auto_trade,
                "stake": self.stake,
                "min_confidence": self.min_confidence,
                "min_payout": self.min_payout,
                "max_gales": self.max_gales,
                "gale_multiplier": self.gale_multiplier,
                "blacklist": sorted(list(self.blacklist)),
            })
            log.info("[%s] 🚫 Ativo %s adicionado à BLACKLIST", self.session_token[:8], clean)
            return sorted(list(self.blacklist))

    def remove_from_blacklist(self, asset: str) -> list:
        clean = self._normalize_asset(asset)
        with self._lock:
            self.blacklist = {b for b in self.blacklist if self._normalize_asset(b) != clean and b.upper() != asset.upper()}
            _save_persisted_config({
                "auto_trade": self.auto_trade,
                "stake": self.stake,
                "min_confidence": self.min_confidence,
                "min_payout": self.min_payout,
                "max_gales": self.max_gales,
                "gale_multiplier": self.gale_multiplier,
                "blacklist": sorted(list(self.blacklist)),
            })
            log.info("[%s] ✅ Ativo %s removido da BLACKLIST", self.session_token[:8], clean)
            return sorted(list(self.blacklist))

    def get_blacklist(self) -> list:
        with self._lock:
            return sorted(list(self.blacklist))

    def get_payout(self, asset_id: str) -> int:
        """Obtém o payout em tempo real do ativo, consultando o Collector e a IQ Option."""
        candidates = [asset_id]
        clean = asset_id.replace("-OTC", "").replace("-op", "").replace("(OTC)", "").strip()
        candidates.extend([clean, f"{clean}-OTC", f"{clean}-op"])

        # 1. Consulta dict vivo do Collector
        if self.collector and hasattr(self.collector, "payouts") and self.collector.payouts:
            for c in candidates:
                p = self.collector.payouts.get(c)
                if p and isinstance(p, (int, float)) and p > 0:
                    return int(p)
            resolved = getattr(self.collector, "asset_resolved", {}).get(asset_id)
            if resolved:
                p = self.collector.payouts.get(resolved)
                if p and isinstance(p, (int, float)) and p > 0:
                    return int(p)

        # 2. Consulta self.payouts local
        if self.payouts:
            for c in candidates:
                p = self.payouts.get(c)
                if p and isinstance(p, (int, float)) and p > 0:
                    return int(p)

        # 3. Consulta direta no client da IQ Option se conectado
        if self.collector and getattr(self.collector, "client", None) and getattr(self.collector, "connected", False):
            try:
                # pyrefly: ignore [missing-import]
                from iqoptionapi.constants import InstrumentType
                client = self.collector.client
                actives = client.get_actives(InstrumentType.BINARY_OPTION) or {}
                for act_id_int, info in actives.items():
                    ticker = (info.get("ticker") or "").strip()
                    if ticker in candidates:
                        pp = client.get_profit_percent(int(act_id_int)) or info.get("profit_percent", 0)
                        if pp and 0 < int(pp) < 100:
                            if self.collector and hasattr(self.collector, "payouts"):
                                self.collector.payouts[asset_id] = int(pp)
                            return int(pp)
            except Exception as e:
                log.debug("get_payout consulta direta falhou para %s: %s", asset_id, e)

        return 0

    def on_candle_closed(self, asset_id: str, tf: str, candle: dict) -> None:
        """
        Chamado pelo Collector a cada vela fechada.
        asset_id: "EURUSD", tf: "M1"/"M5"/"M15", candle: {time, open, high, low, close}
        """
        if not self._enabled:
            return

        # 🚫 Verifica se o ativo está na BLACKLIST configurada pelo usuário
        if self.is_blacklisted(asset_id):
            log.info(
                "[%s] 🚫 Ativo %s está na BLACKLIST. Análise e entradas bloqueadas.",
                self.session_token[:8], asset_id,
            )
            return

        # Verifica payout mínimo de forma estrita (payout deve ser >= min_payout)
        payout = self.get_payout(asset_id)
        if payout < self.min_payout:
            log.info(
                "[%s] ⏸ Vela %s/%s ignorada: payout atual (%d%%) menor que o mínimo exigido (%d%%)",
                self.session_token[:8], asset_id, tf, payout, self.min_payout,
            )
            return

        # ⚡ Cache em RAM: busca no SQLite apenas na 1ª vez; depois alimenta em memória instantaneamente
        cache_key = (asset_id, tf)
        if cache_key not in self._candles_cache or len(self._candles_cache[cache_key]) < MIN_CANDLES:
            try:
                initial_rows = db.query(asset_id, tf, 4, self.db_path)
                self._candles_cache[cache_key] = deque(initial_rows, maxlen=80)
            except Exception as e:
                log.debug("db.query %s/%s inicial falhou: %s", asset_id, tf, e)
                return

        self._candles_cache[cache_key].append(candle)
        rows = list(self._candles_cache[cache_key])

        if len(rows) < MIN_CANDLES:
            return

        sig = analyse(asset_id, rows, tf)
        if sig is None or sig.confidence < self.min_confidence:
            return

        sig.payout = payout

        # Cooldown — evita spam do mesmo sinal
        key = (asset_id, tf, sig.direction)
        now = time.time()
        with self._lock:
            last = self._last_sent.get(key, 0)
            if now - last < COOLDOWN_SECS:
                return
            self._last_sent[key] = now

        # Formata e envia
        self._emit(sig)

    def _emit(self, sig: ScannerSignal) -> None:
        # Checagem estrita de payout antes de qualquer ordem ou envio ao Telegram
        current_payout = self.get_payout(sig.asset)
        effective_payout = current_payout if current_payout > 0 else (sig.payout if sig.payout > 0 else 0)
        sig.payout = effective_payout

        # 🚫 Checagem de Blacklist
        if self.is_blacklisted(sig.asset):
            log.warning(
                "[%s] 🛑 Entrada e sinal bloqueados para %s: ativo consta na BLACKLIST.",
                self.session_token[:8], sig.asset,
            )
            return

        if effective_payout < self.min_payout:
            log.warning(
                "[%s] 🛑 Entrada e sinal bloqueados para %s: payout atual (%d%%) < mínimo (%d%%)",
                self.session_token[:8], sig.asset, effective_payout, self.min_payout,
            )
            return

        # ── Prepara metadados ANTES de qualquer I/O de rede ────────────────
        tf_exp = 1 if sig.timeframe == "M1" else (5 if sig.timeframe == "M5" else 15)
        entry_time_str = time.strftime("%H:%M", time.localtime(sig.candle_time))
        signal_id = _make_signal_id(sig)
        account_type = getattr(self.collector, "account_type", "PRACTICE") if self.collector else "PRACTICE"

        # Resolve status OTC e formatação do ativo
        iq_ticker = sig.asset
        is_otc = False
        if self.collector:
            resolved = getattr(self.collector, "asset_resolved", {}).get(sig.asset, sig.asset)
            if resolved:
                iq_ticker = resolved
            if "-OTC" in str(iq_ticker) or "-otc" in str(iq_ticker) or "(OTC)" in str(iq_ticker):
                is_otc = True
        elif "-OTC" in sig.asset or "(OTC)" in sig.asset:
            is_otc = True

        base_clean = sig.asset.replace("-OTC", "").replace("-op", "")
        if len(base_clean) == 6 and base_clean.isalpha():
            pair_formatted = f"{base_clean[:3]}/{base_clean[3:]}"
        else:
            pair_formatted = base_clean

        display_name = f"{pair_formatted} (OTC)" if is_otc else pair_formatted

        log.info(
            "[%s] SINAL: %s %s [%s] conf=%d%% payout=%d%% conta=%s",
            self.session_token[:8], display_name, sig.direction,
            sig.timeframe, sig.confidence, sig.payout, account_type,
        )

        # ── 🚀 PRIORIDADE MÁXIMA: Telegram IMEDIATO — antes do trade ────────
        # O sinal chega ao usuário no instante do fechamento da vela,
        # garantindo tempo para entrar manualmente no "nascimento" da próxima.
        msg_text = _build_telegram_message(
            sig, entry_time_str,
            account_type=account_type,
            order_info="",   # sem info de ordem ainda — atualizado após o trade
            display_name=display_name,
        )

        status = "not_sent"
        try:
            sent = telegram_notifications.send_signal(
                signal_id=signal_id,
                owner_id=self.identity_hash,
                strategy=f"{'; '.join(sig.strategies[:3])}",
                asset=display_name,
                direction=sig.direction,
                timeframe=sig.timeframe,
                signal_time=entry_time_str,
                message_text=msg_text,
            )
            status = "sent" if sent else "duplicate"
            log.info("[%s] 📱 Telegram disparado imediatamente ao fechamento da vela",
                     self.session_token[:8])
        except telegram_notifications.TelegramConfigurationError as e:
            log.warning("Telegram não configurado: %s", e)
            status = "no_telegram"
        except Exception as e:
            log.error("Falha ao enviar sinal ao Telegram: %s", e)
            status = "error"

        # Registra o sinal imediatamente (trade ainda não executado)
        record = {
            "signal_id":    signal_id,
            "asset":        sig.asset,
            "display_name": display_name,
            "iq_ticker":    iq_ticker,
            "is_otc":       is_otc,
            "direction":    sig.direction,
            "timeframe":    sig.timeframe,
            "confidence":   sig.confidence,
            "payout":       sig.payout,
            "strategies":   sig.strategies,
            "candle_time":  sig.candle_time,
            "sent_at":      int(time.time()),
            "status":       status,
            "account_type": account_type,
            "auto_trade":   self.auto_trade,
            "trade_status": "not_executed",
            "order_info":   "",
        }
        with self._lock:
            self.signals_history.append(record)
            if len(self.signals_history) > 200:
                self.signals_history = self.signals_history[-200:]

        # ── 🔄 Trade + Gale em thread separada (não bloqueia o Telegram) ────
        if self.auto_trade and self.collector:
            threading.Thread(
                target=self._execute_trade_and_monitor,
                args=(sig, tf_exp, signal_id, display_name, account_type),
                daemon=True,
                name=f"trade-{signal_id[:8]}",
            ).start()

    def _execute_trade_and_monitor(
        self,
        sig: ScannerSignal,
        tf_exp: int,
        signal_id: str,
        display_name: str,
        account_type: str,
    ) -> None:
        """Executa ordem e monitora gale/resultado em background.
        Roda em thread daemon separada para não atrasar o Telegram."""
        order_info = ""
        trade_status = "not_executed"
        trade_res = None

        try:
            ok, res = self.collector.execute_trade(
                asset=sig.asset,
                direction=sig.direction,
                expiry=tf_exp,
                amount=self.stake,
                min_payout=self.min_payout,
            )
            if ok:
                trade_status = "executed"
                trade_res = str(res)
                order_info = f"Ordem #{res} (${self.stake:.2f})"
                log.info("[%s] ⚡ Auto-trade executado: %s %s | #%s",
                         self.session_token[:8], sig.asset, sig.direction, res)
            else:
                trade_status = f"failed: {res}"
                order_info = f"Falha na entrada: {res}"
                log.warning("[%s] Auto-trade rejeitado: %s %s: %s",
                            self.session_token[:8], sig.asset, sig.direction, res)
        except Exception as e_trade:
            trade_status = f"error: {e_trade}"
            order_info = f"Erro: {e_trade}"
            log.error("[%s] Erro ao executar auto-trade: %s", self.session_token[:8], e_trade)

        # Actualiza o registro do sinal com resultado da ordem
        self._update_signal_record(signal_id, trade_status, order_info=order_info)

        # Inicia monitor de Gale / resultado se houver ordem aberta
        if trade_res:
            self._monitor_trade_and_run_gale(
                sig, trade_res, tf_exp, self.stake, signal_id, display_name, account_type,
            )

    def get_best_strategies(self, top_n: int = 15) -> List[dict]:
        """Calcula assertividade histórica real de estratégias x paridade x timeframe de forma rápida e com EV real."""
        results = []
        with self._lock:
            min_pay = self.min_payout
        if self.payouts:
            assets_to_test = [
                asset for asset, pay in self.payouts.items()
                if pay >= min_pay
            ]
            assets_to_test.sort(key=lambda a: self.payouts.get(a, 0), reverse=True)
        else:
            assets_to_test = list(config.ASSET_IDS)
        timeframes = ["M1", "M5"]

        # Limita aos top 8 ativos para responder rápido mantendo o ranking completo
        for asset in assets_to_test[:8]:
            for tf in timeframes:
                try:
                    candles = db.query(asset, tf, 12, self.db_path)
                    if len(candles) < 40:
                        continue
                    # Pega no máximo as últimas 150 velas para cálculo instantâneo
                    if len(candles) > 150:
                        candles = candles[-150:]

                    setup_stats: Dict[str, Dict] = {}
                    for i in range(30, len(candles) - 1):
                        window = candles[:i + 1]
                        next_c = candles[i + 1]
                        sig = analyse(asset, window, tf)
                        if sig is None or not sig.strategies:
                            continue
                        is_win = (
                            (sig.direction == "CALL" and next_c["close"] > next_c["open"]) or
                            (sig.direction == "PUT"  and next_c["close"] < next_c["open"])
                        )
                        setup_key = sig.strategies[0]
                        if setup_key not in setup_stats:
                            setup_stats[setup_key] = {"triggers": 0, "wins": 0}
                        setup_stats[setup_key]["triggers"] += 1
                        if is_win:
                            setup_stats[setup_key]["wins"] += 1

                    payout_val = self.payouts.get(asset, 80)

                    for setup_name, st in setup_stats.items():
                        if st["triggers"] < 2:
                            continue
                        winrate = round((st["wins"] / st["triggers"]) * 100, 1)
                        ev = round((winrate / 100 * payout_val) - ((1 - winrate / 100) * 100), 2)
                        results.append({
                            "asset":         asset,
                            "timeframe":     tf,
                            "strategy":      setup_name,
                            "winrate":       winrate,
                            "signals_count": st["triggers"],
                            "wins":          st["wins"],
                            "losses":        st["triggers"] - st["wins"],
                            "payout":        payout_val,
                            "ev":            ev,
                        })
                except Exception as e:
                    log.debug("Erro ao calcular melhores estratégias para %s/%s: %s", asset, tf, e)

        results.sort(key=lambda x: (x["ev"], x["signals_count"]), reverse=True)
        return results[:top_n]

    def _monitor_trade_and_run_gale(
        self,
        sig: ScannerSignal,
        order_id: str,
        tf_exp: int,
        initial_stake: float,
        signal_id: str,
        display_name: str,
        account_type: str,
    ):
        """Monitora expiração da ordem. Se der LOSS, executa Gale 1 e envia resumo final ao Telegram."""
        log.info("[%s] Iniciando monitoramento da ordem #%s (%s)", self.session_token[:8], order_id, display_name)
        tf_seconds = tf_exp * 60

        # Aguarda a vela da 1ª ordem expirar (+ buffer de 2s para consolidação)
        server_now = self.collector._server_now() if self.collector else int(time.time())
        wait_s = (tf_seconds - (server_now % tf_seconds)) + 2
        if wait_s < 3:
            wait_s += tf_seconds
        time.sleep(wait_s)

        # 1. Determina resultado da 1ª ordem
        outcome_1, pl_1 = self._check_order_outcome(sig, order_id, tf_exp)
        payout_val = sig.payout if sig.payout else 80

        if outcome_1 == "WIN":
            profit = pl_1 if pl_1 > 0 else round(initial_stake * (payout_val / 100), 2)
            log.info("[%s] ✅ WIN de Primeira na ordem #%s! Lucro: +$%.2f", self.session_token[:8], order_id, profit)
            telegram_notifications.update_signal_result(
                signal_id=signal_id,
                owner_id=self.identity_hash,
                outcome="WIN",
            )
            telegram_notifications.send_result_summary(
                owner_id=self.identity_hash,
                asset=display_name,
                direction=sig.direction,
                timeframe=sig.timeframe,
                outcome="WIN_DIRECT",
                profit=profit,
            )
            self._update_signal_record(signal_id, "win_first", f"WIN (+${profit:.2f})")
            return

        # 2. Se deu LOSS e Gale está habilitado (max_gales >= 1)
        if self.max_gales >= 1 and self.collector:
            gale_stake = round(initial_stake * self.gale_multiplier, 2)
            log.warning("[%s] ❌ Ordem 1 deu LOSS. Disparando GALE 1 ($%.2f) em %s...", self.session_token[:8], gale_stake, display_name)

            telegram_notifications.send_gale_alert(
                owner_id=self.identity_hash,
                asset=display_name,
                direction=sig.direction,
                gale_num=1,
                amount=gale_stake,
            )

            ok_gale, res_gale = self.collector.execute_trade(
                asset=sig.asset,
                direction=sig.direction,
                expiry=tf_exp,
                amount=gale_stake,
            )

            if ok_gale:
                log.info("[%s] Gale 1 executado com sucesso: ordem #%s ($%.2f)", self.session_token[:8], res_gale, gale_stake)
                # Aguarda a vela do Gale expirar (+ buffer de 2s)
                server_now = self.collector._server_now() if self.collector else int(time.time())
                wait_gale = (tf_seconds - (server_now % tf_seconds)) + 2
                if wait_gale < 3:
                    wait_gale += tf_seconds
                time.sleep(wait_gale)

                outcome_gale, pl_gale = self._check_order_outcome(sig, str(res_gale), tf_exp)
                if outcome_gale == "WIN":
                    net_profit = pl_gale - initial_stake if pl_gale > 0 else round(gale_stake * (payout_val / 100) - initial_stake, 2)
                    log.info("[%s] ✅ WIN no Gale 1 (#%s)! Lucro líquido: +$%.2f", self.session_token[:8], res_gale, net_profit)
                    telegram_notifications.update_signal_result(
                        signal_id=signal_id,
                        owner_id=self.identity_hash,
                        outcome="WIN",
                    )
                    telegram_notifications.send_result_summary(
                        owner_id=self.identity_hash,
                        asset=display_name,
                        direction=sig.direction,
                        timeframe=sig.timeframe,
                        outcome="WIN_GALE1",
                        profit=net_profit,
                    )
                    self._update_signal_record(signal_id, "win_gale1", f"WIN G1 (+${net_profit:.2f})")
                    return
                else:
                    total_loss = round(initial_stake + gale_stake, 2)
                    log.warning("[%s] ❌ LOSS no Gale 1 (#%s)! Prejuízo: -$%.2f", self.session_token[:8], res_gale, total_loss)
                    telegram_notifications.update_signal_result(
                        signal_id=signal_id,
                        owner_id=self.identity_hash,
                        outcome="LOSS",
                    )
                    telegram_notifications.send_result_summary(
                        owner_id=self.identity_hash,
                        asset=display_name,
                        direction=sig.direction,
                        timeframe=sig.timeframe,
                        outcome="LOSS_GALE1",
                        profit=-total_loss,
                    )
                    self._update_signal_record(signal_id, "loss_gale1", f"LOSS G1 (-${total_loss:.2f})")
                    return
            else:
                log.error("[%s] Falha ao disparar ordem de Gale: %s", self.session_token[:8], res_gale)

        # Se Gale não pôde ser executado ou desabilitado, registra o Loss direto
        telegram_notifications.update_signal_result(
            signal_id=signal_id,
            owner_id=self.identity_hash,
            outcome="LOSS",
        )
        telegram_notifications.send_result_summary(
            owner_id=self.identity_hash,
            asset=display_name,
            direction=sig.direction,
            timeframe=sig.timeframe,
            outcome="LOSS_DIRECT",
            profit=-initial_stake,
        )
        self._update_signal_record(signal_id, "loss", f"LOSS (-${initial_stake:.2f})")

    def _check_order_outcome(self, sig: ScannerSignal, order_id: str, tf_exp: int) -> Tuple[str, float]:
        """Avalia se a ordem foi WIN ou LOSS usando a API da IQ ou os preços da vela fechada."""
        # 1. Tenta API oficial da IQ Option se conectada
        if self.collector and self.collector.client:
            try:
                numeric_id = int(re.sub(r"\D", "", str(order_id)))
                success, order_data, pl_amount = self.collector.client.get_trade_outcome(numeric_id, expiry=tf_exp)
                if success and pl_amount is not None:
                    if pl_amount > 0:
                        return "WIN", float(pl_amount)
                    elif pl_amount < 0:
                        return "LOSS", float(pl_amount)
            except Exception as e:
                log.debug("get_trade_outcome falhou para #%s (%s), usando fallback de vela", order_id, e)

        # 2. Fallback por vela no banco de dados SQLite
        try:
            recent = db.query(sig.asset, sig.timeframe, 1, self.db_path)
            if recent and len(recent) >= 1:
                last_c = recent[-1]
                op = last_c.get("open", 0)
                cl = last_c.get("close", 0)
                if sig.direction == "CALL":
                    return ("WIN", 0.0) if cl > op else ("LOSS", 0.0)
                elif sig.direction == "PUT":
                    return ("WIN", 0.0) if cl < op else ("LOSS", 0.0)
        except Exception as e:
            log.warning("Fallback de vela falhou: %s", e)

        return "LOSS", 0.0

    def _update_signal_record(self, signal_id: str, trade_status: str, result_label: str = "", order_info: str = ""):
        with self._lock:
            for s in self.signals_history:
                if s.get("signal_id") == signal_id:
                    s["trade_status"] = trade_status
                    if result_label:
                        s["result_label"] = result_label
                    if order_info:
                        s["order_info"] = order_info
                    break

    def get_signals(self, limit: int = 50) -> List[dict]:
        with self._lock:
            return list(reversed(self.signals_history[-limit:]))

    def update_config(
        self,
        auto_trade: Optional[bool] = None,
        stake: Optional[float] = None,
        min_confidence: Optional[int] = None,
        min_payout: Optional[int] = None,
        max_gales: Optional[int] = None,
        gale_multiplier: Optional[float] = None,
        blacklist: Optional[List[str]] = None,
    ):
        with self._lock:
            if auto_trade is not None:
                self.auto_trade = bool(auto_trade)
            if stake is not None and stake > 0:
                self.stake = float(stake)
            if min_confidence is not None and 50 <= min_confidence <= 99:
                self.min_confidence = int(min_confidence)
            if min_payout is not None and 0 <= min_payout <= 99:
                self.min_payout = int(min_payout)
            if max_gales is not None and 0 <= max_gales <= 3:
                self.max_gales = int(max_gales)
            if gale_multiplier is not None and 1.0 <= gale_multiplier <= 5.0:
                self.gale_multiplier = float(gale_multiplier)
            if blacklist is not None:
                self.blacklist = {self._normalize_asset(b) for b in blacklist if b}

            _save_persisted_config({
                "auto_trade": self.auto_trade,
                "stake": self.stake,
                "min_confidence": self.min_confidence,
                "min_payout": self.min_payout,
                "max_gales": self.max_gales,
                "gale_multiplier": self.gale_multiplier,
                "blacklist": sorted(list(self.blacklist)),
            })

    def get_config(self) -> dict:
        with self._lock:
            return {
                "auto_trade": self.auto_trade,
                "stake": self.stake,
                "min_confidence": self.min_confidence,
                "min_payout": self.min_payout,
                "max_gales": self.max_gales,
                "gale_multiplier": self.gale_multiplier,
                "blacklist": sorted(list(self.blacklist)),
                "enabled": self._enabled,
                "account_type": getattr(self.collector, "account_type", "PRACTICE") if self.collector else "PRACTICE",
            }

    def get_daily_asset_stats(self) -> dict:
        """Calcula estatísticas de greens e reds por ativo no dia de hoje (ou últimas 24h)."""
        asset_stats: Dict[str, Dict] = {}
        for aid in config.ASSET_IDS:
            clean = self._normalize_asset(aid)
            disp = f"{clean[:3]}/{clean[3:]}" if len(clean) == 6 else clean
            asset_stats[clean] = {
                "asset": disp,
                "raw_id": aid,
                "wins": 0,
                "losses": 0,
                "consecutive_losses": 0,
                "current_streak_type": None,
                "current_streak": 0,
                "winrate": 0.0,
                "blacklisted": self.is_blacklisted(aid),
            }

        # 1. Analisa sinais emitidos nesta sessão
        with self._lock:
            recent_sigs = list(self.signals_history)

        for sig in recent_sigs:
            raw = sig.get("asset", "")
            clean = self._normalize_asset(raw)
            if clean not in asset_stats:
                disp = sig.get("display_name") or clean
                asset_stats[clean] = {
                    "asset": disp,
                    "raw_id": raw,
                    "wins": 0,
                    "losses": 0,
                    "consecutive_losses": 0,
                    "current_streak_type": None,
                    "current_streak": 0,
                    "winrate": 0.0,
                    "blacklisted": self.is_blacklisted(raw),
                }

            st = str(sig.get("trade_status", "")).lower()
            lbl = str(sig.get("result_label", "")).lower()
            is_win = "win" in st or "win" in lbl
            is_loss = "loss" in st or "loss" in lbl

            if is_win:
                asset_stats[clean]["wins"] += 1
                if asset_stats[clean]["current_streak_type"] == "win":
                    asset_stats[clean]["current_streak"] += 1
                else:
                    asset_stats[clean]["current_streak_type"] = "win"
                    asset_stats[clean]["current_streak"] = 1
                asset_stats[clean]["consecutive_losses"] = 0
            elif is_loss:
                asset_stats[clean]["losses"] += 1
                if asset_stats[clean]["current_streak_type"] == "loss":
                    asset_stats[clean]["current_streak"] += 1
                else:
                    asset_stats[clean]["current_streak_type"] = "loss"
                    asset_stats[clean]["current_streak"] = 1
                asset_stats[clean]["consecutive_losses"] = asset_stats[clean]["current_streak"]

        # 2. Se a sessão acabou de iniciar e tiver poucos sinais registrados, complementa com ranking de assertividade
        total_recorded = sum(s["wins"] + s["losses"] for s in asset_stats.values())
        if total_recorded < 5:
            try:
                best_strats = self.get_best_strategies(top_n=20)
                for bs in best_strats:
                    raw = bs.get("asset", "")
                    clean = self._normalize_asset(raw)
                    if clean in asset_stats:
                        asset_stats[clean]["wins"] += int(bs.get("wins", 0))
                        asset_stats[clean]["losses"] += int(bs.get("losses", 0))
            except Exception as e:
                log.debug("Erro ao complementar estatísticas do dia: %s", e)

        # 3. Calcula winrates e ordena greens e reds
        for clean, data in asset_stats.items():
            tot = data["wins"] + data["losses"]
            data["winrate"] = round((data["wins"] / tot * 100), 1) if tot > 0 else 0.0
            data["blacklisted"] = self.is_blacklisted(clean)

        active_items = [v for v in asset_stats.values() if (v["wins"] + v["losses"]) > 0]
        top_greens = sorted(active_items, key=lambda x: (x["wins"], x["winrate"]), reverse=True)
        top_reds = sorted(active_items, key=lambda x: (x["losses"], -x["winrate"]), reverse=True)

        total_greens = sum(v["wins"] for v in asset_stats.values())
        total_reds = sum(v["losses"] for v in asset_stats.values())

        return {
            "top_greens": top_greens,
            "top_reds": top_reds,
            "total_greens": total_greens,
            "total_reds": total_reds,
            "asset_stats": asset_stats,
            "blacklist": sorted(list(self.blacklist)),
        }

    def enable(self):
        self._enabled = True

    def disable(self):
        self._enabled = False


# ─── Helpers ──────────────────────────────────────────────────────────────────
def _make_signal_id(sig: ScannerSignal) -> str:
    raw = f"{sig.asset}|{sig.timeframe}|{sig.direction}|{sig.candle_time}"
    return hashlib.sha1(raw.encode()).hexdigest()[:24]


# ─── Registro global de scanners por sessão ───────────────────────────────────
_scanners: Dict[str, SessionScanner] = {}
_scanners_lock = threading.Lock()


def register(
    session_token: str,
    identity_hash: str,
    db_path: str,
    payouts: Dict[str, int],
    collector=None,
) -> SessionScanner:
    """Cria e registra um SessionScanner para a sessão. Idempotente."""
    with _scanners_lock:
        if session_token not in _scanners:
            scanner = SessionScanner(session_token, identity_hash, db_path, payouts, collector=collector)
            _scanners[session_token] = scanner
            log.info("Scanner registrado para sessão %s", session_token[:8])
        else:
            if collector:
                _scanners[session_token].collector = collector
        return _scanners[session_token]


def unregister(session_token: str) -> None:
    with _scanners_lock:
        scanner = _scanners.pop(session_token, None)
    if scanner:
        scanner.disable()
        log.info("Scanner removido para sessão %s", session_token[:8])


def get(session_token: str) -> Optional[SessionScanner]:
    with _scanners_lock:
        return _scanners.get(session_token)
