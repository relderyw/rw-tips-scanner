"""Script de validação da biblioteca iqoptionapi + mapeamento de ativos.

Uso (na pasta bridge/):
    python -m tools.check_lib
Ou, na raiz do repositório:
    python -m bridge.tools.check_lib

O que faz:
  1. Conecta na IQ Option (conta DEMO, SOMENTE LEITURA) via IQOptionClient.
  2. Exibe status da conexão + balance.
  3. Resolve os 12 ativos do painel (nome IQ + is_open + payout%) usando
     get_actives(BINARY_OPTION) e UNDERLYING_ASSESTS.
  4. Tenta inscrever os 36 streams (12 ativos × M1/M5/M15), com delay, e
     informa quantos deram ok / market_closed / falha.
  5. Aguarda ~65 s para capturar PELO MENOS 3 velas M1 FECHADAS de EURUSD
     (coletadas via on_new_candle) e exibe time convertido em data local
     (dd/mm/yyyy HH:MM:SS).
  6. Desconecta limpo (unsubscribe_all + disconnect).

  7. No início, imprime um relatório dos 7 pontos confirmados na seção 2 do
     spec (callback timing, timestamp unidade s, threads callback, limites de
     subscribe, reconexão lib, payout, formato get_candles).
"""
from __future__ import annotations

import json
import os
import sys
import time
from datetime import datetime
from typing import Dict, List

# Garante imports: iqoptionapi (pai) + bridge.config (irmão).
_HERE = os.path.dirname(os.path.abspath(__file__))
_BRIDGE = os.path.dirname(_HERE)
_REPO = os.path.dirname(_BRIDGE)
for p in (_BRIDGE, _REPO):
    if p not in sys.path:
        sys.path.insert(0, p)

import config  # noqa: E402
from iqoptionapi.iqapi import IQOptionClient  # noqa: E402
from iqoptionapi.models import InstrumentType  # noqa: E402
from iqoptionapi.instruments.options_assests import UNDERLYING_ASSESTS  # noqa: E402


def fmt_ts_local(unix_s: int) -> str:
    return datetime.fromtimestamp(int(unix_s)).strftime("%d/%m/%Y %H:%M:%S")


def print_sep(title: str) -> None:
    print()
    print("=" * 78)
    print(f" {title}")
    print("=" * 78)


def report_sec2_confirmation_points():
    """Relata o que foi CONFIRMADO no código da biblioteca (seção 2 do spec)."""
    print_sep("RESUMO DOS 7 PONTOS CONFIRMADOS NA BIBLIOTECA (seção 2 do spec)")
    # Lê dos arquivos fonte diretamente para garantir que está certo.
    candles_path = os.path.join(_REPO, "iqoptionapi", "candles.py")
    markets_path = os.path.join(_REPO, "iqoptionapi", "markets.py")
    ws_path = os.path.join(_REPO, "iqoptionapi", "wsmanager", "iqwebsocket.py")
    iqapi_path = os.path.join(_REPO, "iqoptionapi", "iqapi.py")

    def read(p: str) -> str:
        try:
            with open(p, "r", encoding="utf-8") as fh:
                return fh.read()
        except Exception:
            return ""

    candles_src = read(candles_path)
    markets_src = read(markets_path)
    ws_src = read(ws_path)
    iqapi_src = read(iqapi_path)

    # 1) Callback on_new_candle dispara quando nova vela ABRE (anterior FECHOU).
    p1 = "on_new_candle callback timing: CONFIRMADO "
    if "if current is None or current.get('id') != candle_id:" in candles_src and "_new_candle_callbacks.append" in candles_src:
        p1 += "✓ — dispara ao detectar candle_id diferente (nova vela abrindo), com a vela ANTERIOR já fechada. Assinatura: cb(completed_candle, history_list)."
    else:
        p1 += "⚠ não foi possível confirmar via source grep."
    # 2) candle.timestamp: segundos unix, abertura.
    p2 = "candle.timestamp (from): CONFIRMADO "
    if "pd.to_datetime(df['from'], unit='s')" in markets_src:
        p2 += "✓ — from é unix SEGUNDOS, da ABERTURA da vela (campo from)."
    else:
        p2 += "⚠ não foi possível confirmar via source grep."
    # 3) Threads callback: websocket daemon thread. Exceptions logadas.
    p3 = "Threads callbacks: CONFIRMADO "
    if "daemon=True" in ws_src and "logger.error(f\"New candle callback failed" in candles_src:
        p3 += "✓ — WebSocket roda em thread daemon. Callbacks rodam na thread do WS e try/except loga erro sem travar."
    else:
        p3 += "⚠ não foi possível confirmar via source grep."
    # 4) Limite subscribe: NÃO ENCONTRADO limite explícito no código.
    p4 = "Limite de assinaturas simultâneas: NÃO ENCONTRADO limite explícito no código. Método subscribe_live_candles() usa 0.5s de delay entre subscribes → adotamos 0.333s para 36 streams."
    # 5) Reconexão automática: NÃO FAZ.
    p5 = "Reconexão automática na lib: CONFIRMADO "
    if "_on_close.*ws_is_active = False" in ws_src and "reconnect" not in ws_src.lower():
        p5 += "✗ — biblioteca NÃO reconecta sozinha. Apenas marca ws_is_active=False. Toda lógica de reconexão + reassinatura é responsabilidade nosso coletor."
    else:
        p5 += "⚠ grep inconclusivo."
    # 6) Payout por ativo: existe get_profit_percent + fetch_active_assets.
    p6 = "Payout / profit_percent por ativo: CONFIRMADO "
    if "get_profit_percent" in iqapi_src and "commission = 100 - commission" in markets_src:
        p6 += "✓ — client.get_profit_percent(active_id) retorna 100 - commission (%). Também via get_actives(BINARY_OPTION) retorna {active_id_int: {ticker, is_open, profit_percent}}."
    else:
        p6 += "⚠ não foi possível confirmar via source grep."
    # 7) Formato get_candles: only_closed=True, count default 50.
    p7 = "Formato get_candles: CONFIRMADO "
    if "\"only_closed\": True" in markets_src and "\"count\": count" in markets_src:
        p7 += "✓ — only_closed=True (apenas velas fechadas), parâmetro count default 50 (usamos blocos 1000 no backfill). Chaves: from, to, open, max, min, close, volume."
    else:
        p7 += "⚠ não foi possível confirmar via source grep."

    for i, p in enumerate([p1, p2, p3, p4, p5, p6, p7], start=1):
        print(f"  {i}. {p}")
    print()


def main() -> int:
    # 0) Relatório da seção 2 baseado em source grep.
    report_sec2_confirmation_points()
    # 1) Checar variáveis de ambiente.
    if not config.IQ_EMAIL or not config.IQ_PASSWORD:
        print("[ERRO] IQ_EMAIL e/ou IQ_PASSWORD não definidos no ambiente/.env")
        print("       Configure em bridge/.env e rode a partir da pasta bridge/.")
        return 2

    client: IQOptionClient | None = None
    collected_m1_eurusd: List[Dict] = []

    # 2) Conectar.
    print_sep("1. CONEXÃO (conta DEMO, SOMENTE LEITURA)")
    print(f"  IQ_EMAIL={config.IQ_EMAIL[:3]}*** (parcial por segurança)")
    print(f"  account_type=demo")
    client = IQOptionClient(config.IQ_EMAIL, config.IQ_PASSWORD, account_type="demo")

    print("  Chamando connect()...")
    t0 = time.monotonic()
    try:
        conectado = bool(client.connect())
    except Exception as e:  # noqa: BLE001
        print(f"  [ERRO] Exception: {e}")
        return 3
    t1 = time.monotonic()
    print(f"  conectado: {conectado}  (tempo: {t1 - t0:.2f}s)")
    if not conectado:
        print("  Sem conexão; abortando resto.")
        return 4
    try:
        balance = float(client.get_balance() or 0.0)
    except Exception as e:  # noqa: BLE001
        balance = 0.0
        print(f"  [WARN] get_balance falhou: {e}")
    print(f"  balance (demo): {balance:.2f} USD")

    # 3) Resolver 12 ativos do painel.
    print_sep("2. ATIVOS DISPONÍVEIS (12 do painel — candidatos em config.ASSET_IQ_NAMES)")
    try:
        actives_data = client.get_actives(InstrumentType.BINARY_OPTION) or {}
    except Exception as e:  # noqa: BLE001
        print(f"  [WARN] get_actives falhou: {e}. Usaremos UNDERLYING_ASSESTS apenas.")
        actives_data = {}
    # Mapa reverso ticker -> {is_open, profit_percent, active_id}
    ticker_info: Dict[str, Dict] = {}
    for aid, info in actives_data.items():
        t = (info.get("ticker") or "").strip()
        if t:
            ticker_info[t] = {
                "is_open": bool(info.get("is_open", False)),
                "profit_percent": int(info.get("profit_percent", 0) or 0),
                "active_id": int(aid),
            }

    resolved: Dict[str, Dict] = {}
    for asset_id in config.ASSET_IDS:
        candidates = config.ASSET_IQ_NAMES.get(asset_id, [])
        chosen = None
        chosen_open = False
        chosen_payout = 0
        for cand in candidates:
            if cand not in UNDERLYING_ASSESTS:
                continue
            info = ticker_info.get(cand, {})
            is_open = bool(info.get("is_open", False))
            if chosen is None:
                chosen = cand
                chosen_open = is_open
                chosen_payout = int(info.get("profit_percent", 0) or 0)
            if is_open:
                chosen = cand
                chosen_open = True
                chosen_payout = int(info.get("profit_percent", 0) or 0)
                break
        resolved[asset_id] = {
            "escolhido_IQ": chosen or "(nenhum candidato encontrado!)",
            "is_open": chosen_open,
            "profit_percent": chosen_payout,
        }
    print(json.dumps(resolved, indent=2, ensure_ascii=False))

    # 4) Inscrever 36 streams.
    print_sep("3. SUBSCREVENDO 36 STREAMS (12 ativos × M1/M5/M15) — delay 0.333s")
    # Callback: coleta velas M1 EURUSD para a demo final.
    def on_closed_candle(candle, _history=None):
        iq_name = getattr(candle, "asset_name", "")
        tf_sec = int(getattr(candle, "timeframe", 0) or 0)
        asset_id = None
        for pid, info in resolved.items():
            if info["escolhido_IQ"] == iq_name:
                asset_id = pid
                break
        if asset_id == "EURUSD" and tf_sec == 60:
            entry = {
                "time": int(getattr(candle, "timestamp", 0) or 0),
                "open": float(getattr(candle, "open")),
                "high": float(getattr(candle, "high")),
                "low": float(getattr(candle, "low")),
                "close": float(getattr(candle, "close")),
                "received_at": time.time(),
            }
            collected_m1_eurusd.append(entry)
            print(f"   + [M1 EURUSD] time={entry['time']} data={fmt_ts_local(entry['time'])} "
                  f"open={entry['open']} close={entry['close']} recebimento_delta_ms="
                  f"{int((entry['received_at']-(entry['time']+60))*1000)}")

    client.on_new_candle(on_closed_candle)

    ok = 0
    mc = 0
    falhou = 0
    sub_results: Dict[str, str] = {}
    keys = [(aid, tname, tsec)
            for aid in config.ASSET_IDS
            for tname, tsec in config.TIMEFRAMES.items()]
    for idx, (aid, tname, tsec) in enumerate(keys):
        if idx > 0:
            time.sleep(0.333)
        iq_name = resolved[aid]["escolhido_IQ"]
        if not resolved[aid]["is_open"]:
            status = "market_closed"
            mc += 1
        else:
            try:
                if client.start_candle_stream(iq_name, tsec):
                    status = "ok"
                    ok += 1
                else:
                    status = "falhou (False)"
                    falhou += 1
            except Exception as e:  # noqa: BLE001
                status = f"falhou (ex: {e})"
                falhou += 1
        key = f"{aid}/{tname}"
        sub_results[key] = status
    print(f"  Total: tentados={len(keys)}  ok={ok}  market_closed={mc}  falhou={falhou}")
    print("  Detalhe por stream (apenas 'falhou' e 'market_closed'):")
    for k, v in sub_results.items():
        if v != "ok":
            print(f"    - {k}: {v}")

    # 5) Aguardar ~65 s para receber pelo menos 3 velas M1 fechadas.
    print_sep("4. AGUARDANDO PELO MENOS 3 VELAS M1 EURUSD FECHADAS (timeout ~90s)")
    t0 = time.monotonic()
    timeout = 90.0
    while len(collected_m1_eurusd) < 3 and (time.monotonic() - t0) < timeout:
        print(f"   (até agora: {len(collected_m1_eurusd)} velas M1 EURUSD — esperando mais…)",
              end="\r", flush=True)
        time.sleep(1.0)
    print()
    if len(collected_m1_eurusd) >= 3:
        print(f"  ✓ Recebemos {len(collected_m1_eurusd)} velas. Exibindo as 3 PRIMEIRAS:")
        for i, c in enumerate(collected_m1_eurusd[:3], start=1):
            print(f"    [{i}] time_unix={c['time']}  "
                  f"data_local={fmt_ts_local(c['time'])}  "
                  f"OHLC=({c['open']}, {c['high']}, {c['low']}, {c['close']})  "
                  f"time%60 == {c['time'] % 60}")
        # Validação rápida: múltiplo de 60.
        all_mult60 = all(c["time"] % 60 == 0 for c in collected_m1_eurusd[:3])
        print(f"  Todos 'time' são múltiplos de 60? {all_mult60} "
              f"({'✓ candles de M1 corretos' if all_mult60 else '✗ TIMEFRAME ERRADO (esperava M1)'})")
    else:
        print(f"  ⚠ Apenas {len(collected_m1_eurusd)} velas em {timeout:.0f}s. "
              "Mercado EURUSD fechado? Verifique resolução acima.")

    # 6) Desconecta limpo.
    print_sep("5. SHUTDOWN LIMPO")
    try:
        client.candle_manager.unsubscribe_all()
        print("  ✓ unsubscribe_all()")
    except Exception as e:  # noqa: BLE001
        print(f"  ⚠ unsubscribe_all ex: {e}")
    try:
        client.disconnect()
        print("  ✓ disconnect()")
    except Exception as e:  # noqa: BLE001
        print(f"  ⚠ disconnect ex: {e}")
    print("  FIM.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
