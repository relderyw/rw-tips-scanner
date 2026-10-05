"""Coletor em TEMPO REAL da IQ Option (conta DEMO, SOMENTE LEITURA).

Arquitetura multi-thread:
  - Thread principal do Collector (self.run): conecta, subscribe, backfill inicial,
    respira em loop tratando halt.
  - Thread de escrita (`_writer_thread`): DRENDA `write_queue` (Queue thread-safe)
    e faz INSERT OR REPLACE no SQLite (1 escritor = sem races). Também publica
    velas fechadas prontas em `broadcast_queue` para o FastAPI retransmitir por WS.
  - Thread watchdog (`_watchdog_thread`): detecta streams stale por ativo/tf e
    decide se reassina 1 stream vs reconecta tudo com backoff exponencial.
  - Callback `on_new_candle` roda NA THREAD DO WEBSOCKET da biblioteca.
    NUNCA faz I/O: só envia dict normalizado para `write_queue`.

NÃO operamos em conta real. NÃO há código de trade.
"""
from __future__ import annotations

import logging
import math
import queue
import random
import threading
import time
from dataclasses import dataclass
from typing import Dict, List, Optional, Tuple

import config
import db

# ---------------------------------------------------------------------------
# SOMENTE LEITURA: importamos APENAS o cliente e o tipo de instrumento para
# consulta de ativos. NÃO importamos nada de trade.
# ---------------------------------------------------------------------------
from iqoptionapi.iqapi import IQOptionClient  # noqa: E402  (import depois de sys.path se precisar)
from iqoptionapi.models import InstrumentType  # noqa: E402
from iqoptionapi.instruments.options_assests import UNDERLYING_ASSESTS  # noqa: E402

log = logging.getLogger("collector")

# Quantidade máxima de candles por chamada de get_candles.
# Valor conservador do coletor antigo; se IQ recusar, _backfill_pair reduz para 500.
MAX_CANDLES_PER_CALL = 1000

# Quantidade streams stale para disparar reconexão GLOBAL (em vez de reassinar 1 por 1).
GLOBAL_RECONNECT_THRESHOLD = 5

# Backoff exponencial para reconexão global: min, max, multiplicador.
BACKOFF_INITIAL = 5
BACKOFF_MAX = 300
BACKOFF_MULTIPLIER = 2
BACKOFF_JITTER_PCT = 0.20

# Delay entre cada subscribe (evitar inundar o WS da IQ).
SUBSCRIBE_DELAY_SECONDS = 0.333


@dataclass
class StreamKey:
    """Identificador único de stream = (ativo do painel, timeframe em segundos)."""
    asset_id: str
    tf_sec: int

    @property
    def tf_id(self) -> str:
        return config.TIMEFRAMES_SEC_TO_ID[self.tf_sec]

    def as_pair(self) -> Tuple[str, int]:
        return (self.asset_id, self.tf_sec)

    def __hash__(self):
        return hash(self.as_pair())

    def __eq__(self, other):
        return isinstance(other, StreamKey) and self.as_pair() == other.as_pair()


def _iter_all_stream_keys(timeframes=None) -> List[StreamKey]:
    """Gera as chaves monitoradas para cada ativo e timeframe."""
    selected_timeframes = timeframes or config.TIMEFRAMES
    return [
        StreamKey(asset_id=a, tf_sec=s)
        for a in config.ASSET_IDS
        for s in selected_timeframes.values()
    ]


def _jitter(base: float, pct: float = BACKOFF_JITTER_PCT) -> float:
    """Jitter simétrico ±pct sobre um valor base."""
    delta = base * pct
    return base + random.uniform(-delta, delta)


class Collector(threading.Thread):
    """Thread principal do coletor em tempo real (SOMENTE LEITURA)."""

    def __init__(
        self,
        email=None,
        password=None,
        db_path=None,
        timeframes=None,
        backfill_hours=None,
        session_id="default",
        account_type="demo",
    ):
        super().__init__(daemon=False, name=f"iq-collector-{session_id[:8]}")
        self.email = email if email is not None else config.IQ_EMAIL
        self.password = password if password is not None else config.IQ_PASSWORD
        self.db_path = db_path or config.DB_PATH
        self.timeframes = timeframes or config.TIMEFRAMES
        self.backfill_hours = backfill_hours or config.BACKFILL_HOURS
        self.session_id = session_id
        self.account_type = account_type
        self._account_data_lock = threading.Lock()
        self._market_data_lock = threading.RLock()
        self._stream_keys = _iter_all_stream_keys(self.timeframes)
        self._startup_event = threading.Event()
        self._startup_error: Optional[str] = None
        # Cliente da IQ Option — inicializado em _connect(), nunca aqui.
        self.client: Optional[IQOptionClient] = None
        self.connected: bool = False

        # Payouts por ativo do painel (%).
        self.payouts: Dict[str, int] = {}

        # Sinal de shutdown; broadcast_queue é público para o FastAPI consumir.
        self._halt = threading.Event()
        # write_queue recebe dicts {kind:'candle_closed', asset_id, tf_id, candle, received_at}
        self.write_queue: "queue.Queue" = queue.Queue()
        # broadcast_queue recebe dicts prontos para o FastAPI retransmitir no WS
        # (kind = 'candle' ou 'health_snapshot' pedido)
        self.broadcast_queue: "queue.Queue" = queue.Queue()

        # Threads internas.
        self._writer_thread: Optional[threading.Thread] = None
        self._watchdog_thread: Optional[threading.Thread] = None
        self._connection_lock = threading.RLock()

        # Resolução de nomes de ativos (painel → IQ).
        self.asset_resolved: Dict[str, str] = {a: config.ASSETS[a] for a in config.ASSET_IDS}
        self.asset_is_open: Dict[str, bool] = {a: False for a in config.ASSET_IDS}
        self._resolver_lock = threading.Lock()

        # Estado por stream.
        all_keys = self._stream_keys
        self.stream_last_seen: Dict[StreamKey, float] = {k: 0.0 for k in all_keys}  # time.time() último recebimento
        self.stream_last_candle_ts: Dict[StreamKey, int] = {k: 0 for k in all_keys}  # candle.timestamp (unix s)
        self.stream_latency_ms: Dict[StreamKey, int] = {k: 0 for k in all_keys}
        self._latest_candle_received_at = 0.0
        self._latest_candle_latency_ms = 0
        self.stream_status: Dict[StreamKey, str] = {k: "not_subscribed" for k in all_keys}
        # status ∈ {"not_subscribed", "subscribing", "ok", "stale", "market_closed"}
        self.subscriptions_active: set = set()  # Set[StreamKey] com subscribe confirmado
        self.subscriptions_expected_count: int = len(all_keys)  # 36

        # Backoff global (usado quando reconectamos tudo).
        self._global_backoff: float = BACKOFF_INITIAL
        self._last_payout_refresh: float = 0.0
        self._last_backfill_run: float = 0.0

    # ===================================================================
    # Lifecycle público
    # ===================================================================
    def stop(self) -> None:
        """Solicita shutdown limpo. Bloqueia até threads internas terminarem."""
        log.info("Solicitando shutdown limpo do coletor…")
        self._halt.set()
        # Não encerra o socket no meio de um subscribe/backfill em andamento.
        with self._connection_lock:
            self._disconnect_client()

        # Espera thread de escrita drenar a fila restante.
        if self._writer_thread and self._writer_thread.is_alive():
            # sinaliza ao writer que não virão mais itens; drene o que já entrou
            self.write_queue.put(None)  # poison pill
            self._writer_thread.join(timeout=15)
        if self._watchdog_thread and self._watchdog_thread.is_alive():
            self._watchdog_thread.join(timeout=15)
        if self.is_alive() and threading.current_thread() is not self:
            self.join(timeout=15)
        self.email = ""
        self.password = ""

    def run(self) -> None:
        """Loop principal do coletor: conecta → backfill → subscribe → respira."""
        # Inicia threads internas ANTES de qualquer conexão (já começam em modo wait
        # enquanto connected=False).
        self._writer_thread = threading.Thread(
            target=self._writer_thread_loop, name="iq-collector-writer", daemon=True
        )
        self._writer_thread.start()
        self._watchdog_thread = threading.Thread(
            target=self._watchdog_loop, name="iq-collector-watchdog", daemon=True
        )
        self._watchdog_thread.start()

        while not self._halt.is_set():
            try:
                if not self.connected:
                    self._connect_cycle()
                # Ciclo leve: sleep pequeno + refresh payouts periódico.
                self._halt.wait(1.0)
                self._maybe_refresh_payouts()
            except Exception as e:  # noqa: BLE001
                # Qualquer exceção não tratada força desconexão e backoff.
                if not self._startup_event.is_set():
                    self._startup_error = str(e)
                    self._startup_event.set()
                self.connected = False
                sleep_for = _jitter(self._global_backoff)
                log.error("Erro no ciclo do coletor: %s — backoff %s s", e, f"{sleep_for:.1f}")
                self._halt.wait(sleep_for)
                self._global_backoff = min(self._global_backoff * BACKOFF_MULTIPLIER, BACKOFF_MAX)

    # ===================================================================
    # Conexão / reconexão global
    # ===================================================================
    def _connect_cycle(self) -> None:
        """Executa 1 ciclo: conectar → resolver ativos → subscribe → backfill."""
        with self._connection_lock:
            log.info("Iniciando ciclo de conexão com conta %s…", self.account_type.upper())
            self._disconnect_client()
            self._connect_client()
            self._resolve_asset_names()
            self._full_backfill_all_pairs()
            sub_ok, sub_closed, sub_fail = self._subscribe_all()
            log.info(
                "Subscribe finalizado: %d ok · %d market_closed · %d falhou (de %d esperados)",
                sub_ok, sub_closed, sub_fail, self.subscriptions_expected_count,
            )
            self._refresh_payouts(force=True)
            self._global_backoff = BACKOFF_INITIAL
            log.info("Ciclo de conexão completo. Backoff resetado para %ds.", BACKOFF_INITIAL)

    def _disconnect_client(self) -> None:
        """Fecha a conexão anterior antes de abrir outra."""
        client = self.client
        self.client = None
        self.connected = False
        self.subscriptions_active.clear()
        if client is None:
            return
        try:
            client.candle_manager.unsubscribe_all()
        except Exception as exc:
            log.warning("unsubscribe_all antes de reconectar falhou: %s", exc)
        try:
            client.disconnect()
        except Exception as exc:
            log.warning("disconnect antes de reconectar falhou: %s", exc)

    def _connect_client(self) -> None:
        """Instancia e conecta o IQOptionClient para a conta configurada.

        Levanta exceção se falhar.
        """
        if not self.email or not self.password:
            raise RuntimeError(
                "Informe o e-mail e a senha da conta IQ Option."
            )
        client = IQOptionClient(
            email=self.email,
            password=self.password,
            account_type=self.account_type,
        )
        try:
            ok = client.connect()
            if not ok:
                raise ConnectionError("IQOptionClient.connect() retornou False")
            client.on_new_candle(self._on_new_closed_candle_callback)
        except Exception:
            try:
                client.disconnect()
            except Exception as cleanup_error:
                log.warning("Falha ao fechar cliente IQ após erro de conexão: %s", cleanup_error)
            raise

        self.client = client
        self.connected = True
        self._startup_error = None
        self._startup_event.set()
        log.info("Conectado à IQ Option. Conta: %s (somente leitura).", self.account_type.upper())

    def account_overview(self) -> Dict[str, object]:
        if self.account_type != "real":
            raise RuntimeError("O saldo real só pode ser consultado numa sessão real.")
        client = self.client
        if not self.connected or client is None:
            raise ConnectionError("A conexão com a IQ Option está indisponível.")

        with self._account_data_lock:
            balances = client.account_manager.get_balances()
            account_id = client.appstate.balance_id
            account = next(
                (item for item in balances if item.get("id") == account_id),
                None,
            )
            if account is None or account.get("type") != 1:
                raise LookupError("A IQ Option não retornou o saldo da conta real ativa.")
            return {
                "balance": account.get("amount"),
                "currency": account.get("currency"),
                "account_type": self.account_type,
                "read_only": True,
            }

    def position_history(self, limit: int) -> list:
        if self.account_type != "real":
            raise RuntimeError("O histórico real só pode ser consultado numa sessão real.")
        client = self.client
        if not self.connected or client is None:
            raise ConnectionError("A conexão com a IQ Option está indisponível.")

        with self._account_data_lock:
            return client.get_position_history_by_page(
                [
                    "marginal-forex", "marginal-cfd", "marginal-crypto",
                    "digital-option", "blitz-option", "turbo-option", "binary-option",
                ],
                limit=limit,
                offset=0,
            )

    # ===================================================================
    # Resolução de nomes de ativos
    # ===================================================================
    def binary_option_actives(self) -> List[dict]:
        """Return the currently open binary-option assets and their IQ payouts."""
        if not self.connected or self.client is None:
            raise ConnectionError("A conexão com a IQ Option está indisponível.")
        with self._market_data_lock:
            actives = self.client.get_actives(InstrumentType.BINARY_OPTION) or {}

        rows = []
        for active_id, info in actives.items():
            ticker = (info.get("ticker") or "").strip()
            if not ticker or not info.get("is_open"):
                continue
            try:
                payout = int(info.get("profit_percent") or 0)
                normalized_id = int(active_id)
            except (TypeError, ValueError):
                log.warning("Ignorando ativo binário com dados inválidos: %r", info)
                continue
            rows.append({
                "asset": ticker,
                "active_id": normalized_id,
                "payout": payout if 0 < payout < 100 else None,
                "is_open": True,
                "candles_supported": ticker in UNDERLYING_ASSESTS,
            })
        return sorted(rows, key=lambda row: (-(row["payout"] or 0), row["asset"]))

    def binary_option_candles(self, asset: str, tf_id: str, hours: int) -> list:
        """Fetch and cache historical candles for a library-known binary asset."""
        if asset not in UNDERLYING_ASSESTS:
            raise ValueError("Ativo binário inválido.")
        if tf_id not in self.timeframes:
            raise ValueError("Timeframe inválido.")
        if not self.connected or self.client is None:
            raise ConnectionError("A conexão com a IQ Option está indisponível.")

        timeframe = self.timeframes[tf_id]
        now = self._server_now()
        since = now - hours * 3600
        latest_closed = now - (now % timeframe) - timeframe
        cached = db.query(asset, tf_id, hours, self.db_path)
        if cached and cached[0]["time"] <= since + timeframe and cached[-1]["time"] >= latest_closed - timeframe:
            return cached

        target_count = math.ceil(hours * 3600 / timeframe) + 1
        collected: Dict[int, dict] = {}
        end_time = now
        with self._market_data_lock:
            while len(collected) < target_count:
                count = min(MAX_CANDLES_PER_CALL, target_count - len(collected))
                raw = self.client.get_candles(
                    asset, count=count, timeframe=timeframe, end_time=end_time
                ) or []
                if not raw:
                    break

                oldest = None
                for candle in raw:
                    candle_time = int(candle.get("from", 0) or 0)
                    if candle_time <= 0 or candle_time + timeframe > now:
                        continue
                    oldest = candle_time if oldest is None else min(oldest, candle_time)
                    collected[candle_time] = {
                        "time": candle_time,
                        "open": float(candle.get("open")),
                        "high": float(candle.get("max")),
                        "low": float(candle.get("min")),
                        "close": float(candle.get("close")),
                    }
                if oldest is None or oldest <= since or len(raw) < count:
                    break
                end_time = oldest
                time.sleep(0.05)

        rows = sorted(
            (candle for candle in collected.values() if candle["time"] >= since),
            key=lambda candle: candle["time"],
        )
        if rows:
            db.upsert(asset, tf_id, rows, self.db_path)
        return rows

    def _resolve_asset_names(self) -> None:
        """Decide qual nome da IQ Option usar para cada ativo do painel.

        Estratégia: chamada get_actives(InstrumentType.BINARY_OPTION). Ela devolve
        um dict {active_id_int: {ticker, is_open, profit_percent}}. Construímos
        um mapa reverso ticker→{is_open, profit_percent} e, para cada ativo do
        painel, iteramos ASSET_IQ_NAMES candidatos e pegamos o primeiro que
        1) existe em UNDERLYING_ASSESTS E 2) is_open=True. Se nenhum aberto,
        escolhemos o primeiro candidato existente (status ficará market_closed).
        """
        if self.client is None:
            raise RuntimeError("resolve_asset_names sem cliente conectado")
        with self._resolver_lock:
            try:
                with self._market_data_lock:
                    actives_open_info = self.client.get_actives(InstrumentType.BINARY_OPTION) or {}
            except Exception as e:  # noqa: BLE001
                log.warning("get_actives() falhou, usando candidatos padrão: %s", e)
                actives_open_info = {}
            # Mapa ticker (ex.: 'EURUSD-op') → {is_open, profit_percent}
            ticker_info: Dict[str, Dict] = {}
            for _active_id, info in actives_open_info.items():
                t = (info.get("ticker") or "").strip()
                if t:
                    ticker_info[t] = info

            resolved_any_changed = False
            for asset_id in config.ASSET_IDS:
                candidates = config.ASSET_IQ_NAMES.get(asset_id, [])
                chosen = None
                chosen_open = False
                for cand in candidates:
                    if cand not in UNDERLYING_ASSESTS:
                        continue
                    info = ticker_info.get(cand, {})
                    is_open = bool(info.get("is_open", False))
                    if chosen is None:
                        # Primeiro existente é o fallback padrão.
                        chosen = cand
                        chosen_open = is_open
                    if is_open:
                        # Encontramos um aberto; é preferência máxima.
                        chosen = cand
                        chosen_open = True
                        break
                if chosen is None:
                    # Nenhum candidato existe em UNDERLYING_ASSESTS: usamos o
                    # primeiro candidato mesmo assim (subscribe vai falhar e
                    # o watchdog marca como not_subscribed; não crashamos).
                    chosen = candidates[0] if candidates else asset_id
                    chosen_open = False
                    log.error(
                        "Ativo %s: NENHUM candidato em ASSET_IQ_NAMES existe em "
                        "UNDERLYING_ASSESTS; tentaremos '%s' mesmo assim.",
                        asset_id, chosen,
                    )
                if self.asset_resolved.get(asset_id) != chosen:
                    resolved_any_changed = True
                self.asset_resolved[asset_id] = chosen
                self.asset_is_open[asset_id] = chosen_open

            # Atualiza status market_closed/ok por stream agora que temos is_open.
            for sk in self.stream_status:
                if not self.asset_is_open[sk.asset_id]:
                    self.stream_status[sk] = "market_closed"

            if resolved_any_changed:
                log.info("Resolução de ativos atualizada: %s",
                         {a: (self.asset_resolved[a], "aberto" if self.asset_is_open[a] else "fechado")
                          for a in config.ASSET_IDS})
            else:
                log.info("Resolução de ativos: sem mudanças em relação ao ciclo anterior.")

    # ===================================================================
    # Subscribe de todos os streams (36)
    # ===================================================================
    def _subscribe_all(self) -> Tuple[int, int, int]:
        """Tenta subscrever todas (12×3) combinações.

        Retorna (contagem_ok, contagem_market_closed, contagem_falhou).
        """
        if self.client is None:
            return (0, 0, self.subscriptions_expected_count)
        ok = 0
        mc = 0
        fail = 0
        for i, sk in enumerate(self._stream_keys):
            if self._halt.is_set():
                break
            # Delay entre subscribes (exceto primeiro) para não inundar o WS.
            if i > 0:
                time.sleep(SUBSCRIBE_DELAY_SECONDS)
            if not self.asset_is_open[sk.asset_id]:
                # Mercado fechado: não tentamos subscribe (evita warning inútil).
                self.stream_status[sk] = "market_closed"
                mc += 1
                continue
            self.stream_status[sk] = "subscribing"
            iq_name = self.asset_resolved[sk.asset_id]
            result_ok = False
            last_err = None
            # 2 tentativas lineares por stream com pequeno backoff.
            for attempt in range(2):
                try:
                    if self.client.start_candle_stream(iq_name, sk.tf_sec, timeout=5):
                        result_ok = True
                        break
                except Exception as e:  # noqa: BLE001
                    last_err = e
                time.sleep(0.5)
            if result_ok:
                self.subscriptions_active.add(sk)
                self.stream_status[sk] = "ok"
                # Marca "visto pela última vez" para watchdog não marcar stale
                # antes da primeira vela chegar.
                self.stream_last_seen[sk] = time.time()
                ok += 1
            else:
                self.subscriptions_active.discard(sk)
                self.stream_status[sk] = "stale"
                log.warning(
                    "Subscribe falhou em 2 tentativas: %s/%s (IQ: %s). %s",
                    sk.asset_id, sk.tf_id, iq_name,
                    f"Erro: {last_err}" if last_err else "Timeout ou False.",
                )
                fail += 1
        return (ok, mc, fail)

    def _resubscribe_one(self, sk: StreamKey) -> bool:
        """Reassina UM stream único (usado pelo watchdog quando só 1 fica stale)."""
        if self.client is None or not self.connected:
            return False
        iq_name = self.asset_resolved[sk.asset_id]
        try:
            # Desinscreve primeiro (se tiver subscription pendente).
            self.client.stop_candle_stream(iq_name, sk.tf_sec)
        except Exception:  # noqa: BLE001
            pass
        time.sleep(0.2)
        try:
            ok = self.client.start_candle_stream(iq_name, sk.tf_sec, timeout=5)
        except Exception as e:  # noqa: BLE001
            log.warning("resubscribe_one ex: %s", e)
            ok = False
        if ok:
            self.subscriptions_active.add(sk)
            self.stream_status[sk] = "ok"
            self.stream_last_seen[sk] = time.time()
        else:
            self.stream_status[sk] = "stale"
        return ok

    # ===================================================================
    # Callback: vela fechada (roda NA THREAD DO WEBSOCKET → NÃO FAZER I/O AQUI)
    # ===================================================================
    def _on_new_closed_candle_callback(self, candle_obj, _history=None) -> None:
        """Invocado pela biblioteca IQOption CADA VEZ QUE UMA VELA FECHA.

        A biblioteca chama: cb(completed_candle, history_list).
        completed_candle é um dataclass Candle com atributos:
          .asset_name (IQ name), .asset_id, .timeframe, .timestamp, .open,
          .high, .low, .close, .volume.
        candle.timestamp é o from (segundos unix de ABERTURA da vela).
        """
        try:
            # Recebimento exato para latency.
            received_at = time.time()
            # Map IQ asset_name (ex.: 'EURUSD-op') → asset_id do painel (ex.: 'EURUSD').
            # Usamos asset_resolved + UNDERLYING_ASSESTS para lookup robusto.
            iq_name = getattr(candle_obj, "asset_name", "") or ""
            asset_id = self._iq_name_to_panel_id(iq_name)
            if asset_id is None:
                log.debug("Candle de ativo desconhecido (IQ: %s) — ignorado.", iq_name)
                return
            tf_sec = int(getattr(candle_obj, "timeframe", 0) or 0)
            if tf_sec not in self.timeframes.values():
                log.debug("Candle timeframe %ds não monitorado — ignorado.", tf_sec)
                return
            tf_id = config.TIMEFRAMES_SEC_TO_ID[tf_sec]
            ts = int(getattr(candle_obj, "timestamp", 0) or 0)
            # candle_obj tem open/high/low/close como float; garantimos float.
            norm = {
                "time": ts,
                "open": float(candle_obj.open),
                "high": float(candle_obj.high),
                "low": float(candle_obj.low),
                "close": float(candle_obj.close),
            }
            # Envia para fila. I/O real só acontece na thread de escrita.
            self.write_queue.put({
                "kind": "candle_closed",
                "asset_id": asset_id,
                "tf_id": tf_id,
                "tf_sec": tf_sec,
                "candle": norm,
                "received_at": received_at,
            })
        except Exception as e:  # noqa: BLE001
            # NÃO deixamos exception do callback quebrar a thread do websocket.
            log.error("Callback on_new_candle exception (ignorada, WS continua): %s", e)

    def _iq_name_to_panel_id(self, iq_name: str) -> Optional[str]:
        """Lookup reverso: nome IQ (ex.: 'EURUSD-op', 'GER30-OTC') → painel id."""
        with self._resolver_lock:
            for pid, chosen in self.asset_resolved.items():
                if chosen == iq_name:
                    return pid
            active_id = UNDERLYING_ASSESTS.get(iq_name)
            if active_id is not None:
                for pid, chosen in self.asset_resolved.items():
                    if UNDERLYING_ASSESTS.get(chosen) == active_id:
                        return pid
        # Fallback: varre todos candidatos de ASSET_IQ_NAMES (caso resolvedor
        # tivesse escolhido nome alternativo que depois recebeu candle).
        for pid, cands in config.ASSET_IQ_NAMES.items():
            if iq_name in cands:
                return pid
        return None

    # ===================================================================
    # Thread de escrita (1 escritor — garante thread-safety do SQLite)
    # ===================================================================
    def _writer_thread_loop(self) -> None:
        """Drena write_queue.

        Itens esperados:
          - dict com kind='candle_closed' → grava + atualiza métricas + publica broadcast.
          - None (poison pill) → termina depois de drenar.
        """
        log.info("Thread de escrita iniciada.")
        while True:
            try:
                item = self.write_queue.get(timeout=0.5)
            except queue.Empty:
                continue
            if item is None:
                # Poison pill: drena resto e termina (shutdown).
                self._drain_remaining_queue()
                break
            try:
                if item.get("kind") == "candle_closed":
                    self._process_writer_candle_closed(item)
            except Exception as e:  # noqa: BLE001
                log.error("Thread de escrita encontrou erro (item dropado): %s", e)
        log.info("Thread de escrita finalizada.")

    def _drain_remaining_queue(self) -> None:
        """Drena (com timeout curto) os itens que já entraram mas ainda não foram processados."""
        processed = 0
        while True:
            try:
                item = self.write_queue.get_nowait()
            except queue.Empty:
                break
            if item is None:
                continue
            try:
                if item.get("kind") == "candle_closed":
                    self._process_writer_candle_closed(item)
                    processed += 1
            except Exception as e:  # noqa: BLE001
                log.error("Drain final: erro em 1 item (pulado): %s", e)
        log.info("Drain final concluído: %d itens processados.", processed)

    def _process_writer_candle_closed(self, item: dict) -> None:
        """Persiste 1 vela + atualiza métricas + coloca em broadcast_queue (para FastAPI WS)."""
        asset_id = item["asset_id"]
        tf_id = item["tf_id"]
        tf_sec = item["tf_sec"]
        candle = item["candle"]
        received_at = item["received_at"]

        # Descarta duplicatas e eventos atrasados antes que possam sobrescrever
        # valores já persistidos ou emitir candles fora de ordem no WebSocket.
        sk = StreamKey(asset_id=asset_id, tf_sec=tf_sec)
        previous_time = self.stream_last_candle_ts.get(sk, 0) or db.last_time(asset_id, tf_id, self.db_path) or 0
        if int(candle["time"]) <= previous_time:
            log.debug(
                "Candle duplicado/atrasado ignorado: %s/%s time=%s (último=%s).",
                asset_id, tf_id, candle["time"], previous_time,
            )
            return

        # 1) Persistência.
        db.upsert(asset_id, tf_id, [candle], self.db_path)

        # 2) Atualiza métricas globais do stream.
        self.stream_last_candle_ts[sk] = int(candle["time"])
        self.stream_last_seen[sk] = received_at
        # latency_ms = tempo entre fechamento esperado e recebimento.
        # fechamento esperado = candle.time (abertura) + tf_sec (duração).
        expected_close_ts = candle["time"] + tf_sec
        latency_s = received_at + self._server_offset_seconds() - expected_close_ts
        latency_ms = int(max(0.0, latency_s) * 1000.0)
        self.stream_latency_ms[sk] = latency_ms
        if received_at >= self._latest_candle_received_at:
            self._latest_candle_received_at = received_at
            self._latest_candle_latency_ms = latency_ms
        # Mercado estava fechado e agora temos candle → promove para ok.
        if self.stream_status.get(sk) == "market_closed":
            self.stream_status[sk] = "ok"
            self.asset_is_open[asset_id] = True
        elif self.stream_status.get(sk) == "stale":
            self.stream_status[sk] = "ok"

        # 3) Publica para o FastAPI broadcastar por WebSocket.
        self.broadcast_queue.put({
            "kind": "candle",
            "session_id": self.session_id,
            "asset": asset_id,
            "tf": tf_id,
            "candle": dict(candle),  # cópia para ninguém mutar
            "latency_ms": latency_ms,
        })

        # 4) log leve (não para cada stream de 36 — só loga se latência alta)
        if latency_ms > 2000:
            log.warning(
                "Vela %s/%s time=%s chegou com %dms (> 2s) — latência alta.",
                asset_id, tf_id, candle["time"], latency_ms,
            )
        else:
            log.debug(
                "Vela %s/%s time=%s persistida (latência %dms).",
                asset_id, tf_id, candle["time"], latency_ms,
            )

    # ===================================================================
    # Thread watchdog: streams stale, reconexão global
    # ===================================================================
    def _watchdog_loop(self) -> None:
        """Loop do watchdog (1 ciclo a cada WATCHDOG_INTERVAL segundos)."""
        log.info("Watchdog iniciado (intervalo %ds).", config.WATCHDOG_INTERVAL)
        while not self._halt.is_set():
            try:
                with self._connection_lock:
                    if self.connected and self.client is not None:
                        self._watchdog_one_cycle()
            except Exception as e:  # noqa: BLE001
                log.error("Exceção no watchdog (não fatal, continuamos): %s", e)
            # Sleep em pedaços pequenos para shutdown responsivo.
            for _ in range(config.WATCHDOG_INTERVAL * 2):
                if self._halt.is_set():
                    break
                time.sleep(0.5)
        log.info("Watchdog finalizado.")

    def _watchdog_one_cycle(self) -> None:
        """1 passada do watchdog: marca stale, repara streams, decide reconexão global."""
        assert self.client is not None  # mypy hint
        now = time.time()
        stale_count = 0
        closed_count = 0
        reconn_needed_global = False

        # Se o socket base caiu, reconectamos TUDO sem nem olhar stream por stream.
        ws_alive = bool(getattr(self.client.websocket, "ws_is_active", False))
        if not ws_alive:
            log.error("WebSocket da IQ foi marcado inativo (ws_is_active=False). "
                      "Solicitando reconexão global.")
            reconn_needed_global = True

        for sk in self._stream_keys:
            # Mercado fechado não é erro.
            if not self.asset_is_open[sk.asset_id]:
                self.stream_status[sk] = "market_closed"
                closed_count += 1
                continue
            # Stream nunca inscrito: pula.
            if self.stream_status[sk] == "not_subscribed":
                continue
            last_seen = self.stream_last_seen[sk] or 0.0
            # stale_threshold_s = 2 * duração + margem.
            threshold = 2 * sk.tf_sec + config.STALE_MARGIN_SECONDS
            age = now - last_seen
            if last_seen > 0 and age > threshold:
                # Não alteramos market_closed para stale (previne retentar fim de semana).
                if self.stream_status[sk] != "market_closed":
                    self.stream_status[sk] = "stale"
                stale_count += 1
                log.warning(
                    "Stream %s/%s stale: última vela há %.0fs (> limiar %ds).",
                    sk.asset_id, sk.tf_id, age, threshold,
                )
            elif last_seen == 0.0:
                # Ainda não recebemos 1 vela. Subscribe pode estar falhando.
                stale_count += 1

        if reconn_needed_global or stale_count >= GLOBAL_RECONNECT_THRESHOLD:
            log.warning(
                "Reconexão GLOBAL solicitada: ws_alive=%s, stale=%d (≥%d), closed=%d. "
                "Backoff atual %ds.",
                ws_alive, stale_count, GLOBAL_RECONNECT_THRESHOLD, closed_count,
                int(self._global_backoff),
            )
            # Marca self.connected = False e o loop run() vai desconectar + connect_cycle.
            self.connected = False
            return

        # Se chegou aqui: só 1-4 streams stale → reassina individualmente.
        for sk in self._stream_keys:
            if self.stream_status[sk] == "stale":
                log.info("Reassinando stream %s/%s individualmente.", sk.asset_id, sk.tf_id)
                self._resubscribe_one(sk)

    # ===================================================================
    # Backfill (histórico + recuperação de lacunas)
    # ===================================================================
    def _full_backfill_all_pairs(self) -> None:
        """Roda backfill para TODOS os 36 pares."""
        log.info("Backfill completo iniciado (%d pares, %dh por par).",
                 self.subscriptions_expected_count, self.backfill_hours)
        t0 = time.time()
        total_velas = 0
        for sk in self._stream_keys:
            if self._halt.is_set():
                break
            try:
                n = self._backfill_pair(sk)
                total_velas += n
            except Exception as e:  # noqa: BLE001
                log.warning("Backfill falhou %s/%s: %s (tentar novamente próximo ciclo).",
                            sk.asset_id, sk.tf_id, e)
        # Prune dados antigos.
        try:
            db.prune(self.db_path)
        except Exception as e:  # noqa: BLE001
            log.warning("db.prune() falhou: %s", e)
        self._last_backfill_run = time.time()
        log.info("Backfill completo finalizado. %d velas inseridas em %.1fs.",
                 total_velas, time.time() - t0)

    def _backfill_pair(self, sk: StreamKey) -> int:
        """Baixa histórico para (ativo, tf) usando get_candles(), em blocos.

        Idempotente: comparamos db.last_time() e só baixamos o que falta a partir
        de então (ou BACKFILL_HOURS completo se ainda nada no banco).

        Retorna quantidade de velas efetivamente gravadas.
        """
        if self.client is None:
            return 0
        iq_name = self.asset_resolved[sk.asset_id]
        size = sk.tf_sec
        last = db.last_time(sk.asset_id, sk.tf_id, self.db_path)
        server_now = self._server_now()
        if last is None:
            # Nada no banco: baixar BACKFILL_HOURS completas.
            need = (self.backfill_hours * 3600) // size
            end_ts: Optional[int] = server_now
        else:
            # Quantas velas faltam desde a última gravada.
            last_expected_close = server_now - (server_now % size) - size
            need = max(0, (last_expected_close - last) // size)
            if need <= 0:
                # Banco já está atualizado.
                return 0
            end_ts = server_now
        # Limite superior razoável (168h de M1 = 10080 velas).
        need = min(need, 24 * 30 * 7 * 12)  # hard cap de ~720k (impossível prático)
        count_per_call = MAX_CANDLES_PER_CALL
        total_written = 0
        # Baixamos do MAIS NOVO para o MAIS VELHO: cada bloco usamos "to=X" e a API
        # retorna as N velas fechadas ANTES de X (confirmado em markets.py:
        # only_closed=True e to=server_ts). Para não ter duplicação no meio,
        # ordenamos por 'from' e usamos INSERT OR REPLACE.
        while need > 0:
            if self._halt.is_set():
                break
            take = min(count_per_call, need)
            try:
                with self._market_data_lock:
                    raw = self.client.get_candles(
                        iq_name, count=take, timeframe=size, end_time=end_ts
                    ) or []
            except Exception as e:  # noqa: BLE001
                # Tentar novamente com count menor (pode ser que a IQ rejeite 1000).
                if count_per_call > 100:
                    count_per_call = count_per_call // 2
                    log.warning("get_candles ex (%s). Reduzindo count/para para %d e repetindo.",
                                e, count_per_call)
                    time.sleep(0.5)
                    continue
                else:
                    raise RuntimeError(f"get_candles falhou com count={count_per_call}: {e}") from e
            if not raw:
                log.debug("get_candles(%s, %s, %d, end=%s) retornou vazio. Parando backfill.",
                          iq_name, sk.tf_id, take, end_ts)
                break
            # Formato raw = list[dict with keys: from, open, max, min, close, to, volume]
            # Normaliza para contrato do banco e garante só velas FECHADAS e fora de ordem.
            normalized = []
            min_from_seen = None
            for r in raw:
                t_from = int(r.get("from", 0) or 0)
                if t_from <= 0:
                    continue
                # Valida que a vela está realmente fechada: from + size < now (defesa profunda,
                # já que a IQ marca only_closed=True).
                if t_from + size > server_now:
                    continue
                if last is not None and t_from <= last:
                    continue
                normalized.append({
                    "time": t_from,
                    "open": float(r.get("open")),
                    "high": float(r.get("max")),
                    "low": float(r.get("min")),
                    "close": float(r.get("close")),
                })
                if min_from_seen is None or t_from < min_from_seen:
                    min_from_seen = t_from
            if normalized:
                normalized = list({c["time"]: c for c in normalized}.values())
                # Ordem crescente por time.
                normalized.sort(key=lambda c: c["time"])
                db.upsert(sk.asset_id, sk.tf_id, normalized, self.db_path)
                total_written += len(normalized)
            # O próximo bloco termina na abertura mais antiga retornada; o filtro
            # only_closed da API inclui candles cujo fechamento é exatamente esse instante.
            if min_from_seen is None:
                break
            end_ts = min_from_seen
            if not normalized:
                break
            need -= len(normalized)
            # Pequeno delay entre chamadas para não ratear.
            time.sleep(0.05)
        if total_written > 0:
            log.info("Backfill %s/%s: %d velas inseridas.", sk.asset_id, sk.tf_id, total_written)
        return total_written

    def _server_now(self) -> int:
        """Usa o relógio sincronizado pela IQ Option, se disponível."""
        if self.client is not None:
            server_time = getattr(self.client.message_handler, "server_time", None)
            if isinstance(server_time, (int, float)) and server_time > 0:
                return int(server_time / 1000) if server_time > 100_000_000_000 else int(server_time)
        return int(time.time())

    def _server_offset_seconds(self) -> float:
        """Diferença aproximada entre o relógio sincronizado da IQ e o local."""
        if self.client is not None:
            server_time = getattr(self.client.message_handler, "server_time", None)
            if isinstance(server_time, (int, float)) and server_time > 0:
                server_seconds = (
                    server_time / 1000
                    if server_time > 100_000_000_000
                    else server_time
                )
                return server_seconds - time.time()
        return 0.0

    # ===================================================================
    # Payouts
    # ===================================================================
    def _maybe_refresh_payouts(self) -> None:
        """Chama _refresh_payouts a cada PAYOUT_REFRESH_MINUTES (não força)."""
        if time.time() - self._last_payout_refresh > config.PAYOUT_REFRESH_MINUTES * 60:
            try:
                self._refresh_payouts(force=False)
            except Exception as e:  # noqa: BLE001
                log.warning("refresh_payouts periódico falhou: %s", e)

    def _refresh_payouts(self, force: bool = False) -> None:
        """Atualiza self.payouts[asset_id] usando get_actives + get_profit_percent.

        Se IQ não devolver payout para um ativo, NÃO inventamos valor: mantemos o
        valor anterior ou deixamos de fora (o painel usará seu payout padrão).
        """
        if self.client is None:
            return
        if not force and time.time() - self._last_payout_refresh < 60:
            return  # não martelar
        try:
            with self._market_data_lock:
                data = self.client.get_actives(InstrumentType.BINARY_OPTION) or {}
        except Exception as e:  # noqa: BLE001
            log.warning("get_actives() payouts falhou: %s", e)
            return
        # Atualiza também asset_is_open aqui (conveniência).
        ticker_to_active_id = {}
        for active_id_int, info in data.items():
            t = (info.get("ticker") or "").strip()
            if t:
                ticker_to_active_id[t] = int(active_id_int)
        new_payouts: Dict[str, int] = {}
        for pid in config.ASSET_IDS:
            iq_name = self.asset_resolved[pid]
            act_id_int = ticker_to_active_id.get(iq_name)
            payout = None
            if act_id_int is not None:
                try:
                    pp = self.client.get_profit_percent(act_id_int) or 0
                    pp_int = int(pp)
                    if 0 < pp_int < 100:
                        payout = pp_int
                except Exception as e:  # noqa: BLE001
                    log.debug("get_profit_percent(%s=%d) ex: %s", pid, act_id_int, e)
            info_for_open = data.get(act_id_int) if act_id_int is not None else None
            if info_for_open:
                self.asset_is_open[pid] = bool(info_for_open.get("is_open", self.asset_is_open[pid]))
            if payout is not None:
                new_payouts[pid] = payout
        # Merge: preserva valores antigos se IQ não devolveu nada (não zero valores!).
        merged = dict(self.payouts)
        merged.update(new_payouts)
        self.payouts = merged
        self._last_payout_refresh = time.time()
        log.info("Payouts atualizados. %d ativos com valor informado pela IQ.", len(new_payouts))

    # ===================================================================
    # Health snapshot (usado por /health e por mensagens health do WS)
    # ===================================================================
    def health_snapshot(self) -> dict:
        """Retorna dict compatível com o schema estendido de /health.

        Schema:
          connected: bool
          latency_ms: { "EURUSD/M1": 520, ... }
          last_candle: { "EURUSD": <unix_s>, ..., "per_tf": { "EURUSD/M1": <unix_s>, ... } }
          lag_seconds: { "EURUSD/M1": <int> , ... }
          status: { "EURUSD/M1": <ok|stale|market_closed|not_subscribed> , ... }
          subscriptions_active: int
          subscriptions_expected: int
        """
        latency_ms: Dict[str, int] = {}
        per_tf_last: Dict[str, int] = {}
        per_asset_last: Dict[str, int] = {}
        lag_seconds: Dict[str, int] = {}
        status: Dict[str, str] = {}
        now = int(time.time())
        for sk in self._stream_keys:
            key = f"{sk.asset_id}/{sk.tf_id}"
            latency_ms[key] = int(self.stream_latency_ms.get(sk, 0) or 0)
            lct = int(self.stream_last_candle_ts.get(sk, 0) or 0)
            per_tf_last[key] = lct
            # Lag = quantos segundos passaram desde o expected_close_ts da última
            # candle até agora. Se nenhuma vela, lag = 0 e status = not_subscribed.
            if lct > 0:
                expected_close = lct + sk.tf_sec
                lag = max(0, now - expected_close)
            else:
                lag = 0
            lag_seconds[key] = int(lag)
            raw_status = self.stream_status.get(sk, "not_subscribed")
            status[key] = raw_status if raw_status in {"ok", "stale", "market_closed"} else "stale"
            # last_candle global por ativo = max M1 (mais sensível)
            prev = per_asset_last.get(sk.asset_id, 0)
            if sk.tf_id == "M1" or lct > prev:
                per_asset_last[sk.asset_id] = lct
        return {
            "connected": bool(self.connected and self.client is not None),
            "latency_ms": self._latest_candle_latency_ms,
            "latency_by_stream": latency_ms,
            "last_candle": {
                **{a: int(per_asset_last.get(a, 0)) for a in config.ASSET_IDS},
                "per_tf": per_tf_last,
            },
            "lag_seconds": lag_seconds,
            "status": status,
            "per_asset_tf": {
                asset_id: {
                    tf_id: {
                        "last_candle": per_tf_last[f"{asset_id}/{tf_id}"],
                        "lag_seconds": lag_seconds[f"{asset_id}/{tf_id}"],
                        "status": status[f"{asset_id}/{tf_id}"],
                        "latency_ms": latency_ms[f"{asset_id}/{tf_id}"],
                    }
                    for tf_id in self.timeframes
                }
                for asset_id in config.ASSET_IDS
            },
            "count_ok": sum(value == "ok" for value in status.values()),
            "count_stale": sum(value == "stale" for value in status.values()),
            "count_market_closed": sum(value == "market_closed" for value in status.values()),
            "subscriptions_active": int(len(self.subscriptions_active)),
            "subscriptions_expected": int(self.subscriptions_expected_count),
        }


collector = Collector()
