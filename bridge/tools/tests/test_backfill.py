"""Teste CA-rule-03: Backfill preenche lacuna após queda simulada.

Não requer conexão com a IQ Option. Mockamos `client.get_candles()`.

Cenário:
  - DB temporário com 10 velas M1: tempos t0..t9, MAS SEM t5..t9 (LACUNA de 5).
    Ou seja, temos t0..t4 (5) inseridas; as 5 seguintes estão FALTANDO.
  - Queremos _backfill_pair() baixar o que falta. Montamos um Mock cliente
    get_candles(iq_name, count=1000, timeframe=60, end=X) que retorna
    exatamente as velas que faltariam (t5..t9) (ou mais; backfill usa
    INSERT OR REPLACE então duplicates are harmless).
  - Verifica COUNT(*) passa de 5 → 10 (lacuna totalmente preenchida).

Uso:
    python -m bridge.tools.tests.test_backfill
"""
from __future__ import annotations

import os
import sys
import tempfile
import time
from types import SimpleNamespace

_HERE = os.path.dirname(os.path.abspath(__file__))
_TOOLS = os.path.dirname(_HERE)
_BRIDGE = os.path.dirname(_TOOLS)
_REPO = os.path.dirname(_BRIDGE)
for p in (_BRIDGE, _REPO, _TOOLS):
    if p not in sys.path:
        sys.path.insert(0, p)

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DB_PATH"] = _tmp_db.name
os.environ["API_KEY"] = "test-key"
os.environ["IQ_EMAIL"] = "a@b.c"
os.environ["IQ_PASSWORD"] = "x"
# Backfill pequeno para teste.
os.environ["BACKFILL_HOURS"] = "1"

import config  # noqa: E402
import db  # noqa: E402
import collector as collector_module  # noqa: E402
from collector import Collector, StreamKey  # noqa: E402
from iqoptionapi.iqapi import IQOptionClient  # noqa: E402
from iqoptionapi.markets import MarketManager  # noqa: E402


def build_candle_dict(from_s: int, open_p: float):
    return {
        "from": int(from_s),
        "to": int(from_s + 60),
        "open": float(open_p),
        "close": float(open_p + 0.0001),
        "max": float(open_p + 0.0005),
        "min": float(open_p - 0.0005),
        "volume": 1000,
    }


class FakeIQClient:
    """Mock client.get_candles retorna blocos de velas."""

    def __init__(self, all_available: dict, server_time: int):
        self.all_available = all_available
        self.message_handler = SimpleNamespace(server_time=server_time)
        self.requested_end_times = []

    def get_candles(self, _asset_name, count=50, timeframe=60, end_time=None):
        self.requested_end_times.append(end_time)
        eligible = [
            (timestamp, candle)
            for timestamp, candle in self.all_available.items()
            if timestamp + timeframe <= end_time
        ]
        eligible.sort(key=lambda pair: pair[0])
        return [candle for _, candle in eligible[-count:]]


def _raw_count(db_path) -> int:
    """Conta com sqlite3 direto (ignora o `since` de db.query) — debug simples."""
    import sqlite3
    c = sqlite3.connect(db_path)
    try:
        return c.execute("SELECT COUNT(*) FROM candles WHERE asset='EURUSD' AND tf='M1'").fetchone()[0]
    finally:
        c.close()


def test_history_cursor_is_forwarded() -> None:
    handler = SimpleNamespace(server_time=1_730_000_000_000, candles=None)

    class FakeSocket:
        message = None

        def send_message(self, _name, message):
            self.message = message
            handler.candles = []

    socket = FakeSocket()
    manager = MarketManager(socket, handler)
    client = object.__new__(IQOptionClient)
    client._connected = True
    client.market_manager = manager

    client.get_candles("EURUSD-op", count=7, timeframe=60, end_time=1_729_999_000)
    body = socket.message["body"]
    assert body["to"] == 1_729_999_000
    assert body["count"] == 7
    assert body["only_closed"] is True
    print("OK: get_candles encaminha end_time à API de histórico.")


def main() -> int:
    global _tmp_db
    print(f"_tmp_db.name = {_tmp_db.name} (abspath = {os.path.abspath(_tmp_db.name)})")
    print(f"config.DB_PATH = {config.DB_PATH} (abspath = {os.path.abspath(config.DB_PATH)})")
    print(f"Iguais? {os.path.abspath(_tmp_db.name) == os.path.abspath(config.DB_PATH)}")
    print(f"config.DB_PATH existe? {os.path.exists(config.DB_PATH)} (tamanho inicial: {os.path.getsize(config.DB_PATH) if os.path.exists(config.DB_PATH) else 'n/a'})")
    db.init()
    test_history_cursor_is_forwarded()
    print(f"após db.init: tamanho: {os.path.getsize(config.DB_PATH) if os.path.exists(config.DB_PATH) else 'n/a'}")

    # === Setup ===
    step_s = 60
    t0 = (int(time.time()) // step_s) * step_s - 60 * 20  # base: 20 velas atrás
    # Universo (k=0..9): (tempo, dict_raw_candle). k é o índice lógico.
    candles_list = [(t0 + step_s * k, build_candle_dict(t0 + step_s * k, 1.0 + 0.0001 * k)) for k in range(10)]
    universo_raw = {t: d for (t, d) in candles_list}
    # Inserimos SOMENTE k=0..1; as 8 velas seguintes devem ser recuperadas.
    rows_existentes = [
        {
            "time": d["from"],
            "open": d["open"], "high": d["max"],
            "low": d["min"], "close": d["close"],
        }
        for (_, d), k in zip(candles_list, range(10))
        if 0 <= k <= 1
    ]
    assert len(rows_existentes) == 2, f"pré: rows_existentes tem {len(rows_existentes)}!"
    print(f"rows_existentes = {len(rows_existentes)}  1st time = {rows_existentes[0]['time']}  last time = {rows_existentes[-1]['time']}")
    db.upsert("EURUSD", "M1", rows_existentes)

    cnt_before = _raw_count(config.DB_PATH)
    print(f"Antes do backfill: {cnt_before} velas (esperado 2).")
    assert cnt_before == 2, f"Pré-condição falhou: {cnt_before}"

    # === Executa o método real do coletor com API simulada ===
    server_time = t0 + step_s * 10
    fake_client = FakeIQClient(universo_raw, server_time)
    collector = Collector()
    collector_module.MAX_CANDLES_PER_CALL = 3
    collector.client = fake_client
    collector.asset_resolved["EURUSD"] = "EURUSD-op"
    inserted = collector._backfill_pair(StreamKey("EURUSD", step_s))
    print(f"  Método _backfill_pair inseriu {inserted} candles.")
    print(f"  Cursores end_time usados: {fake_client.requested_end_times}")

    cnt_after = _raw_count(config.DB_PATH)
    print(f"Depois do backfill: {cnt_after} velas (esperado 10).")

    # === Verificações ===
    errs = []
    if cnt_after != 10:
        errs.append(f"Esperava 10 velas finais, encontradas {cnt_after}. Lacuna não preenchida.")
    if inserted != 8:
        errs.append(f"Esperava inserir 8 candles faltantes, método retornou {inserted}.")
    if len(fake_client.requested_end_times) < 2 or any(
        current >= previous
        for previous, current in zip(
            fake_client.requested_end_times, fake_client.requested_end_times[1:]
        )
    ):
        errs.append(f"Paginação não avançou para trás: {fake_client.requested_end_times}.")
    # Verifica sem gaps — usa SQL direto para não depender do since temporal de db.query.
    import sqlite3
    _c = sqlite3.connect(config.DB_PATH)
    try:
        raw_rows = _c.execute(
            "SELECT time FROM candles WHERE asset='EURUSD' AND tf='M1' ORDER BY time"
        ).fetchall()
    finally:
        _c.close()
    ts = sorted(r[0] for r in raw_rows)
    gaps = [(p, n, n - p) for p, n in zip(ts, ts[1:]) if n - p != 60]
    if gaps:
        errs.append(f"Ainda há gaps: {gaps}")

    print("\n" + ("=" * 70))
    if errs:
        print(f"FALHA ({len(errs)}):")
        for e in errs:
            print(f"  - {e}")
        return 1
    print("SUCESSO ✓ — Backfill preencheu lacuna em múltiplos blocos, sem gaps.")
    return 0


if __name__ == "__main__":
    code = main()
    try:
        if os.path.exists(_tmp_db.name):
            os.unlink(_tmp_db.name)
    except Exception:
        pass
    sys.exit(code)
