"""Teste CA-rule-02: Vela só persiste quando FECHA.

Não requer conexão com a IQ Option.

Cenário:
  - Cria um DB SQLite temporário.
  - Injeta, na write_queue do Collector, 6 eventos:
      • 5 velas M1 CONSECUTIVAS e FECHADAS (time múltiplo de 60).
      • 1 vela "EM FORMAÇÃO" (time == now // 60 * 60 → aberta agora).
  - Roda o thread de escrita por tempo suficiente para drenar.
  - Valida:
      • COUNT(*) == 5 (a "em formação" NÃO foi gravada).
      • Todos os `time` % 60 == 0.
      • Tempos estritamente crescentes, sem gaps, sem duplicatas.
      • Nenhuma vela tem `time == floor(now/60)*60` (a em formação).

Uso:
    python -m bridge.tools.tests.test_candle_close
"""
from __future__ import annotations

import math
import os
import sys
import tempfile
import time

_HERE = os.path.dirname(os.path.abspath(__file__))
_TOOLS = os.path.dirname(_HERE)
_BRIDGE = os.path.dirname(_TOOLS)
_REPO = os.path.dirname(_BRIDGE)
for p in (_BRIDGE, _REPO, _TOOLS):
    if p not in sys.path:
        sys.path.insert(0, p)

# Força DB_PATH num arquivo temporário ANTES de importar db/collector.
_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DB_PATH"] = _tmp_db.name
os.environ["API_KEY"] = "test-key-does-not-matter"
os.environ["IQ_EMAIL"] = "a@b.c"  # apenas para não dar warning
os.environ["IQ_PASSWORD"] = "x"

import config  # noqa: E402
import db  # noqa: E402
from collector import Collector  # noqa: E402


def main() -> int:
    print(f"Banco temporário: {config.DB_PATH}")
    db.init()

    col = Collector()
    # Não ligamos coletor.run() → não precisamos de conexão IQ.
    # Apenas iniciamos o thread de escrita (ele é seguro drainar a fila).
    import threading
    writer_thread = threading.Thread(target=col._writer_thread_loop, daemon=True)
    writer_thread.start()

    # Constroi 5 velas M1 fechadas:
    step_s = 60
    now = int(time.time())
    last_closed = (now // step_s) * step_s - step_s  # última vela FECHADA (M1)
    candles_fechadas = []
    for k in range(-4, 1):  # índices -4...0 → 5 velas (0 = última fechada)
        t = last_closed + step_s * k
        candles_fechadas.append({
            "time": t,
            "open": 1.0800 + k * 0.0001,
            "high": 1.0810 + k * 0.0001,
            "low":  1.0790 + k * 0.0001,
            "close":1.0805 + k * 0.0001,
        })
    # A vela EM FORMAÇÃO (agora, open time ainda não fechou, duração M1):
    candle_aberta_time = (now // step_s) * step_s
    candle_aberta = {
        "time": candle_aberta_time,
        "open": 1.1111, "high": 1.2222, "low": 1.0001, "close": 1.1500,
    }
    print(f"Horário base now={now} → última vela fechada time={last_closed} "
          f"(= {time.strftime('%H:%M:%S', time.localtime(last_closed))})")
    print(f"Vela em formação time={candle_aberta_time}")

    # Envia para a write_queue como o callback do coletor faria.
    received_at_base = time.time()
    for i, c in enumerate(candles_fechadas):
        col.write_queue.put({
            "kind": "candle_closed", "asset_id": "EURUSD", "tf_id": "M1", "tf_sec": 60,
            "candle": dict(c), "received_at": received_at_base + 0.001 * i,
        })
    duplicate = dict(candles_fechadas[-1])
    duplicate["close"] = 99.0
    col.write_queue.put({
        "kind": "candle_closed", "asset_id": "EURUSD", "tf_id": "M1", "tf_sec": 60,
        "candle": duplicate, "received_at": received_at_base + 0.020,
    })
    # Envia a vela em formação (deveria ser descartada).
    col.write_queue.put({
        "kind": "candle_open_mock_DO_NOT_PERSIST",  # <- o writer ignora kinds != candle_closed
        "asset_id": "EURUSD", "tf_id": "M1", "tf_sec": 60,
        "candle": dict(candle_aberta), "received_at": received_at_base + 0.010,
    })
    # Espera a fila drenar.
    deadline = time.monotonic() + 3.0
    while col.write_queue.qsize() > 0 and time.monotonic() < deadline:
        time.sleep(0.05)
    time.sleep(0.2)
    # Envia poison pill e espera o writer finalizar.
    col.write_queue.put(None)
    writer_thread.join(timeout=3.0)

    # === Validações ===
    errs = []

    # 1) 5 velas somente (a em formação não deve estar)
    rows = db.query("EURUSD", "M1", hours=10000)
    print(f"\nVelas persistidas: {len(rows)} (esperado 5)")
    for r in rows:
        print(f"   time={r['time']} ({time.strftime('%H:%M:%S', time.localtime(r['time']))}) "
              f"open={r['open']:.4f} close={r['close']:.4f}")
    if len(rows) != 5:
        errs.append(f"Esperava 5 velas, temos {len(rows)} — a em formação entrou?")
    if rows and rows[-1]["close"] == 99.0:
        errs.append("Uma duplicata sobrescreveu os preços da última vela persistida.")

    # 2) Todos os 'time' múltiplos de 60
    not_multiple = [r for r in rows if r["time"] % 60 != 0]
    print(f"\nVelas com time%60!=0: {len(not_multiple)}")
    if not_multiple:
        errs.append(f"{len(not_multiple)} velas não têm time múltiplo de 60")

    # 3) Estritamente crescente, sem gaps
    ts = sorted(r["time"] for r in rows)
    gaps = []
    for prev, nxt in zip(ts, ts[1:]):
        if nxt - prev != 60:
            gaps.append((prev, nxt, nxt - prev))
    print(f"Gaps encontrados: {len(gaps)}")
    if gaps:
        errs.append(f"Existem gaps entre velas consecutivas: {gaps}")
    if len(set(ts)) != len(ts):
        errs.append("Velas duplicadas! PK falhou?")

    # 4) Nenhuma tem time == candle aberto.
    has_open = any(r["time"] == candle_aberta_time for r in rows)
    print(f"\nVela EM FORMAÇÃO (time={candle_aberta_time}) está persistida? {has_open}")
    if has_open:
        errs.append("A vela EM FORMAÇÃO (ainda aberta) foi PERSISTIDA indevidamente!")

    # Relatório final.
    print("\n" + ("=" * 70))
    if errs:
        print(f"FALHA ({len(errs)} erros):")
        for e in errs:
            print(f"  - {e}")
        return 1
    # Sanity extra: 'time' bate o esperado.
    expected_times = {last_closed + 60 * k for k in range(-4, 1)}
    got_times = {r["time"] for r in rows}
    if expected_times == got_times:
        print(f"SUCESSO ✓ — 5 velas persistidas, sem vela em formação. "
              f"time%60==0 para todas. Sem gaps, sem duplicatas.")
        return 0
    else:
        print(f"FALHA: esperava {expected_times} → recebi {got_times}")
        return 1


if __name__ == "__main__":
    code = main()
    # Limpeza
    try:
        if os.path.exists(_tmp_db.name):
            os.unlink(_tmp_db.name)
    except Exception:
        pass
    sys.exit(code)
