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
import logging
import threading
import time
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple

import config
import db
import telegram_notifications

log = logging.getLogger("signal_scanner")

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


# ─── Motor de análise ─────────────────────────────────────────────────────────
def analyse(asset: str, candles: List[dict], timeframe: str) -> Optional[ScannerSignal]:
    """Analisa velas e retorna ScannerSignal ou None."""
    if len(candles) < MIN_CANDLES:
        return None

    closes = [float(c["close"]) for c in candles]
    highs  = [float(c["high"])  for c in candles]
    lows   = [float(c["low"])   for c in candles]

    cs, ps = 0, 0
    cr: List[str] = []
    pr: List[str] = []

    # 1 — EMA Cross (9/21)
    e9  = _ema(closes, 9)
    e21 = _ema(closes, 21)
    if e9 and e21:
        if e9 > e21 and closes[-1] > e21:
            cs += WEIGHTS["EMA Cross"]; cr.append("EMA9>EMA21")
        elif e9 < e21 and closes[-1] < e21:
            ps += WEIGHTS["EMA Cross"]; pr.append("EMA9<EMA21")

    # 2 — MACD
    ml, ms = _macd(closes)
    if ml is not None and ms is not None:
        if ml > ms and ml > 0:
            cs += WEIGHTS["MACD"]; cr.append("MACD Bullish")
        elif ml < ms and ml < 0:
            ps += WEIGHTS["MACD"]; pr.append("MACD Bearish")
        elif ml > ms:
            cs += int(WEIGHTS["MACD"] * 0.6); cr.append("MACD Cross↑")
        elif ml < ms:
            ps += int(WEIGHTS["MACD"] * 0.6); pr.append("MACD Cross↓")

    # 3 — RSI
    r = _rsi(closes)
    if r is not None:
        if 50 < r < 70:
            cs += WEIGHTS["RSI"]; cr.append(f"RSI {r:.0f}↑")
        elif 30 < r < 50:
            ps += WEIGHTS["RSI"]; pr.append(f"RSI {r:.0f}↓")
        elif r <= 30:
            cs += WEIGHTS["RSI"]; cr.append(f"RSI {r:.0f} Sobrevenda")
        elif r >= 70:
            ps += WEIGHTS["RSI"]; pr.append(f"RSI {r:.0f} Sobrecompra")

    # 4 — Bollinger Bands
    upper, mid, lower = _bollinger(closes)
    if upper and lower and mid:
        if closes[-1] <= lower:
            cs += WEIGHTS["Bollinger"]; cr.append("BB Lower Bounce")
        elif closes[-1] >= upper:
            ps += WEIGHTS["Bollinger"]; pr.append("BB Upper Rejection")
        elif closes[-1] > mid:
            cs += int(WEIGHTS["Bollinger"] * 0.4); cr.append("Acima BB Mid")
        else:
            ps += int(WEIGHTS["Bollinger"] * 0.4); pr.append("Abaixo BB Mid")

    # 5 — Stochastic
    st = _stochastic(highs, lows, closes)
    if st is not None:
        if st < 20:
            cs += WEIGHTS["Stochastic"]; cr.append(f"Stoch {st:.0f} Oversold")
        elif st > 80:
            ps += WEIGHTS["Stochastic"]; pr.append(f"Stoch {st:.0f} Overbought")

    # 6 — Engulfing
    if len(candles) >= 2:
        prev, curr = candles[-2], candles[-1]
        if _is_bull_engulf(prev, curr):
            cs += WEIGHTS["Engulfing"]; cr.append("Engulfing Bull")
        elif _is_bear_engulf(prev, curr):
            ps += WEIGHTS["Engulfing"]; pr.append("Engulfing Bear")

    # 7 — Hammer / Shooting Star
    last = candles[-1]
    if _is_hammer(last):
        cs += WEIGHTS["Hammer/Star"]; cr.append("Martelo")
    elif _is_shooting_star(last):
        ps += WEIGHTS["Hammer/Star"]; pr.append("Estrela Cadente")

    # 8 — 3 Velas Consecutivas
    if _three_consec(candles, "up"):
        cs += WEIGHTS["3 Velas"]; cr.append("3 Altas")
    elif _three_consec(candles, "down"):
        ps += WEIGHTS["3 Velas"]; pr.append("3 Baixas")

    # Decisão
    if cs == ps or (cs == 0 and ps == 0):
        return None

    candle_time = int(candles[-1]["time"])
    if cs > ps:
        return ScannerSignal(asset, "CALL", min(99, round(cs / MAX_SCORE * 100)),
                             timeframe, cr, candle_time)
    return ScannerSignal(asset, "PUT",  min(99, round(ps / MAX_SCORE * 100)),
                         timeframe, pr, candle_time)


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
        self.auto_trade: bool = __import__("os").getenv("AUTO_TRADE", "false").lower() == "true"
        self.stake: float = float(__import__("os").getenv("DEFAULT_STAKE", "2.0"))
        self.min_confidence: int = int(__import__("os").getenv("DEFAULT_MIN_CONF", str(MIN_CONFIDENCE)))
        self.min_payout: int = MIN_PAYOUT

    def on_candle_closed(self, asset_id: str, tf: str, candle: dict) -> None:
        """
        Chamado pelo Collector a cada vela fechada.
        asset_id: "EURUSD", tf: "M1"/"M5"/"M15", candle: {time, open, high, low, close}
        """
        if not self._enabled:
            return

        # Verifica payout mínimo
        payout = self.payouts.get(asset_id, 0)
        if payout and payout < self.min_payout:
            return

        try:
            rows = db.query(asset_id, tf, LOOKBACK_HOURS, self.db_path)
        except Exception as e:
            log.debug("db.query %s/%s falhou: %s", asset_id, tf, e)
            return

        if len(rows) < MIN_CANDLES:
            return

        sig = analyse(asset_id, rows, tf)
        if sig is None or sig.confidence < self.min_confidence:
            return

        sig.payout = payout if payout else 80

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

        # Executa entrada automática na IQ Option se habilitado
        order_info = ""
        trade_status = "not_executed"
        if self.auto_trade and self.collector:
            try:
                tf_exp = 1
                if sig.timeframe == "M5":
                    tf_exp = 5
                elif sig.timeframe == "M15":
                    tf_exp = 15
                ok, res = self.collector.execute_trade(
                    asset=sig.asset,
                    direction=sig.direction,
                    expiry=tf_exp,
                    amount=self.stake,
                )
                if ok:
                    trade_status = "executed"
                    order_info = f"Ordem #{res} (${self.stake:.2f})"
                    log.info("[%s] Auto-trade executado com sucesso: %s %s | #%s", self.session_token[:8], display_name, sig.direction, res)
                else:
                    trade_status = f"failed: {res}"
                    order_info = f"Falha na entrada: {res}"
                    log.warning("[%s] Auto-trade rejeitado: %s %s: %s", self.session_token[:8], display_name, sig.direction, res)
            except Exception as e_trade:
                trade_status = f"error: {e_trade}"
                order_info = f"Erro: {e_trade}"
                log.error("[%s] Erro ao executar auto-trade: %s", self.session_token[:8], e_trade)

        msg_text = _build_telegram_message(
            sig, entry_time_str,
            account_type=account_type,
            order_info=order_info,
            display_name=display_name,
        )

        log.info(
            "[%s] SINAL: %s %s [%s] conf=%d%% payout=%d%% conta=%s",
            self.session_token[:8], display_name, sig.direction,
            sig.timeframe, sig.confidence, sig.payout, account_type,
        )

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
        except telegram_notifications.TelegramConfigurationError as e:
            log.warning("Telegram não configurado: %s", e)
            status = "no_telegram"
        except Exception as e:
            log.error("Falha ao enviar sinal ao Telegram: %s", e)
            status = "error"

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
            "trade_status": trade_status,
            "order_info":   order_info,
        }
        with self._lock:
            self.signals_history.append(record)
            # Mantém apenas os últimos 200
            if len(self.signals_history) > 200:
                self.signals_history = self.signals_history[-200:]

    def get_best_strategies(self, top_n: int = 15) -> List[dict]:
        """Calcula assertividade histórica real de estratégias x paridade x timeframe."""
        results = []
        # ── Payout-first: só analisa ativos que atendam ao limiar configurado ──
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

        for asset in assets_to_test[:10]:
            for tf in timeframes:
                try:
                    candles = db.query(asset, tf, 24, self.db_path)
                    if len(candles) < 40:
                        continue
                    
                    # Backtest simples das estratégias individuais
                    strat_stats = {}
                    for strat_name in WEIGHTS:
                        strat_stats[strat_name] = {"triggers": 0, "wins": 0}

                    for i in range(35, len(candles) - 1):
                        window = candles[:i+1]
                        next_c = candles[i+1]
                        sig = analyse(asset, window, tf)
                        if sig and sig.strategies:
                            is_win = (sig.direction == "CALL" and next_c["close"] > next_c["open"]) or \
                                     (sig.direction == "PUT" and next_c["close"] < next_c["open"])
                            for s in sig.strategies:
                                for s_name in WEIGHTS:
                                    if s_name.lower() in s.lower():
                                        strat_stats[s_name]["triggers"] += 1
                                        if is_win:
                                            strat_stats[s_name]["wins"] += 1

                    for strat_name, st in strat_stats.items():
                        if st["triggers"] >= 3:
                            winrate = round((st["wins"] / st["triggers"]) * 100, 1)
                            results.append({
                                "asset": asset,
                                "timeframe": tf,
                                "strategy": strat_name,
                                "winrate": winrate,
                                "signals_count": st["triggers"],
                                "wins": st["wins"],
                                "losses": st["triggers"] - st["wins"],
                                "payout": self.payouts.get(asset, 80),
                            })
                except Exception as e:
                    log.debug("Erro ao calcular melhores estratégias para %s/%s: %s", asset, tf, e)

        results.sort(key=lambda x: (x["winrate"], x["signals_count"]), reverse=True)
        return results[:top_n]

    def get_signals(self, limit: int = 50) -> List[dict]:
        with self._lock:
            return list(reversed(self.signals_history[-limit:]))

    def update_config(
        self,
        auto_trade: Optional[bool] = None,
        stake: Optional[float] = None,
        min_confidence: Optional[int] = None,
        min_payout: Optional[int] = None,
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

    def get_config(self) -> dict:
        with self._lock:
            return {
                "auto_trade": self.auto_trade,
                "stake": self.stake,
                "min_confidence": self.min_confidence,
                "min_payout": self.min_payout,
                "enabled": self._enabled,
                "account_type": getattr(self.collector, "account_type", "PRACTICE") if self.collector else "PRACTICE",
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
