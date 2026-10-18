"""Global Telegram signal delivery using bridge environment secrets.

Mensagens usam parse_mode=MarkdownV2 para visual moderno.
"""
from __future__ import annotations

import os
import re
import sqlite3
import threading
import time
import hashlib
import logging
from contextlib import contextmanager
from typing import Generator, Optional

import requests
from dotenv import load_dotenv

load_dotenv(os.path.join(os.path.dirname(__file__), ".env"))

log = logging.getLogger("telegram_notifications")

_DB_PATH = os.getenv(
    "TELEGRAM_STATE_DB",
    os.path.join(os.path.dirname(__file__), "data", "telegram_signals.sqlite3"),
)
_db_lock = threading.Lock()
_TOKEN_RE = re.compile(r"^\d+:[A-Za-z0-9_-]{20,}$")
_CHAT_ID_RE = re.compile(r"^(?:-?\d+|@[A-Za-z0-9_]{5,})$")
_CLOCK_RE = re.compile(r"^(?:[01]\d|2[0-3]):[0-5]\d$")


class TelegramConfigurationError(RuntimeError):
    pass


class TelegramDeliveryError(RuntimeError):
    pass


def _connect() -> sqlite3.Connection:
    os.makedirs(os.path.dirname(_DB_PATH) or ".", exist_ok=True)
    connection = sqlite3.connect(_DB_PATH, timeout=30)
    connection.execute("PRAGMA journal_mode=WAL")
    connection.execute(
        """CREATE TABLE IF NOT EXISTS telegram_signals (
            signal_id TEXT PRIMARY KEY,
            owner_id TEXT NOT NULL,
            status TEXT NOT NULL,
            chat_id TEXT NOT NULL,
            message_id INTEGER,
            message_text TEXT NOT NULL,
            outcome TEXT,
            created_at INTEGER NOT NULL
        )"""
    )
    # Tabela de estatísticas de sessão por owner_id
    connection.execute(
        """CREATE TABLE IF NOT EXISTS telegram_session_stats (
            owner_id TEXT PRIMARY KEY,
            greens INTEGER NOT NULL DEFAULT 0,
            reds INTEGER NOT NULL DEFAULT 0,
            updated_at INTEGER NOT NULL DEFAULT 0
        )"""
    )
    # Tabela de operações e histórico diário por tipo de conta (REAL / PRACTICE)
    connection.execute(
        """CREATE TABLE IF NOT EXISTS telegram_daily_operations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            owner_id TEXT NOT NULL,
            date_str TEXT NOT NULL,
            account_type TEXT NOT NULL,
            asset TEXT NOT NULL,
            direction TEXT NOT NULL,
            timeframe TEXT NOT NULL,
            outcome TEXT NOT NULL,
            profit REAL NOT NULL DEFAULT 0.0,
            stake REAL NOT NULL DEFAULT 0.0,
            created_at INTEGER NOT NULL
        )"""
    )
    connection.execute(
        "CREATE INDEX IF NOT EXISTS idx_ops_owner_date ON telegram_daily_operations(owner_id, date_str)"
    )
    return connection


@contextmanager
def _connection() -> Generator[sqlite3.Connection, None, None]:
    connection = _connect()
    try:
        yield connection
        connection.commit()
    finally:
        connection.close()


def get_status() -> dict[str, bool]:
    token = os.getenv("TELEGRAM_BOT_TOKEN", "").strip()
    chat_id = os.getenv("TELEGRAM_CHAT_ID", "").strip()
    return {
        "configured": bool(_TOKEN_RE.fullmatch(token) and _CHAT_ID_RE.fullmatch(chat_id)),
    }


def _get_configuration() -> tuple[str, str]:
    token = os.getenv("TELEGRAM_BOT_TOKEN", "").strip()
    chat_id = os.getenv("TELEGRAM_CHAT_ID", "").strip()
    if not token or not chat_id:
        raise TelegramConfigurationError(
            "O Telegram ainda não foi configurado no servidor da ponte."
        )
    if not _TOKEN_RE.fullmatch(token):
        raise TelegramConfigurationError("O token do bot configurado no servidor é inválido.")
    if not _CHAT_ID_RE.fullmatch(chat_id):
        raise TelegramConfigurationError("O chat ID configurado no servidor é inválido.")
    return token, chat_id


def get_session_stats(owner_id: str) -> dict:
    """Retorna estatísticas da sessão (greens/reds) para o owner_id."""
    hashed = hashlib.sha256(owner_id.encode("utf-8")).hexdigest()
    with _db_lock:
        with _connection() as connection:
            row = connection.execute(
                "SELECT greens, reds FROM telegram_session_stats WHERE owner_id=?",
                (hashed,),
            ).fetchone()
    if row is None:
        return {"greens": 0, "reds": 0}
    return {"greens": row[0], "reds": row[1]}


def send_signal(
    *,
    signal_id: str,
    owner_id: str,
    strategy: str,
    asset: str,
    direction: str,
    timeframe: str,
    signal_time: str,
    message_text: Optional[str] = None,
) -> bool:
    """Send one formatted signal to the single configured destination.

    Aceita `message_text` pronto (formatado pelo frontend) ou constrói
    uma mensagem básica como fallback.
    """
    bot_token, chat_id = _get_configuration()
    if direction not in {"CALL", "PUT"} or timeframe not in {"M1", "M5", "M15", "M30", "1m", "5m", "15m"}:
        raise ValueError("Direção ou timeframe inválido para sinal do Telegram.")
    if not _CLOCK_RE.fullmatch(signal_time):
        raise ValueError("Horário inválido para sinal do Telegram.")

    safe_strategy = re.sub(r"[\r\n]+", " ", strategy).strip()
    safe_asset = re.sub(r"[\r\n]+", " ", asset).strip()
    if not signal_id or not safe_strategy or not safe_asset:
        raise ValueError("Os dados do sinal estão incompletos.")

    # Se o frontend não passou a mensagem pronta, monta uma básica (sem MarkdownV2)
    if message_text:
        message = message_text
        parse_mode = "MarkdownV2"
    else:
        arrow = "📈" if direction == "CALL" else "📉"
        message = "\n".join(
            (
                "🎯 *Sinal confirmado*",
                "",
                f"⚡ *Estratégia:* {safe_strategy}",
                f"💹 *Ativo:* `{safe_asset}`",
                f"{arrow} *{direction}*",
                f"⏱ *Timeframe:* {timeframe}",
                f"🕐 *Entrada:* {signal_time}",
            )
        )
        parse_mode = "MarkdownV2"

    with _db_lock:
        with _connection() as connection:
            cursor = connection.execute(
                """INSERT OR IGNORE INTO telegram_signals
                   (signal_id, owner_id, status, chat_id, message_text, created_at)
                   VALUES (?, ?, 'sending', ?, ?, ?)""",
                (
                    signal_id,
                    hashlib.sha256(owner_id.encode("utf-8")).hexdigest(),
                    chat_id,
                    message,
                    int(time.time()),
                ),
            )
            if cursor.rowcount == 0:
                return False
    try:
        response = requests.post(
            f"https://api.telegram.org/bot{bot_token}/sendMessage",
            json={"chat_id": chat_id, "text": message, "parse_mode": parse_mode},
            timeout=10,
        )
    except requests.RequestException as exc:
        raise TelegramDeliveryError("Não foi possível conectar ao Telegram.") from exc

    # Se Telegram rejeitou por erro de sintaxe MarkdownV2 (HTTP 400),
    # tenta imediatamente enviar sem parse_mode (texto limpo) como fallback
    if response.status_code >= 400 and parse_mode:
        try:
            fallback_resp = requests.post(
                f"https://api.telegram.org/bot{bot_token}/sendMessage",
                json={"chat_id": chat_id, "text": message},
                timeout=10,
            )
            if fallback_resp.status_code < 400:
                response = fallback_resp
        except Exception:
            pass

    if response.status_code >= 400:
        _delete_reservation(signal_id)
        desc = ""
        try:
            desc = response.json().get("description", "")
        except Exception:
            pass
        err_msg = f"Telegram rejeitou o envio (HTTP {response.status_code})"
        if desc:
            err_msg += f": {desc}"
        raise TelegramDeliveryError(err_msg)
    try:
        result = response.json()
    except ValueError as exc:
        raise TelegramDeliveryError("Telegram retornou uma resposta inválida.") from exc
    if not isinstance(result, dict) or result.get("ok") is not True:
        _delete_reservation(signal_id)
        desc = result.get("description", "") if isinstance(result, dict) else ""
        raise TelegramDeliveryError(f"Telegram não confirmou o envio: {desc}" if desc else "Telegram não confirmou o envio da mensagem.")

    message_result = result.get("result")
    message_id = message_result.get("message_id") if isinstance(message_result, dict) else None
    if not isinstance(message_id, int):
        raise TelegramDeliveryError("Telegram não retornou o identificador da mensagem enviada.")
    with _db_lock:
        with _connection() as connection:
            connection.execute(
                "UPDATE telegram_signals SET status='sent', message_id=? WHERE signal_id=?",
                (message_id, signal_id),
            )
    return True


def _delete_reservation(signal_id: str) -> None:
    with _db_lock:
        with _connection() as connection:
            connection.execute(
                "DELETE FROM telegram_signals WHERE signal_id=? AND status='sending'",
                (signal_id,),
            )


def _escape_md(text: str) -> str:
    """Escapa caracteres especiais do MarkdownV2 do Telegram."""
    return re.sub(r"([_*\[\]()~`>#+\-=|{}.!\\])", r"\\\1", str(text))


def _send_telegram_post(bot_token: str, chat_id: str, html_text: str, timeout: int = 10) -> bool:
    """Envia mensagem formatada em HTML para o Telegram com fallback em texto limpo se houver erro de parsing."""
    try:
        resp = requests.post(
            f"https://api.telegram.org/bot{bot_token}/sendMessage",
            json={"chat_id": chat_id, "text": html_text, "parse_mode": "HTML"},
            timeout=timeout,
        )
        if resp.status_code == 200 and resp.json().get("ok"):
            return True
        log.warning("[Telegram] Falha no envio HTML (status=%d): %s. Tentando texto limpo...", resp.status_code, resp.text)
    except Exception as e:
        log.warning("[Telegram] Exceção no envio HTML: %s. Tentando texto limpo...", e)

    # Fallback: remove tags HTML básicas e envia em texto puro
    try:
        clean_text = re.sub(r"<[^>]+>", "", html_text)
        fallback_resp = requests.post(
            f"https://api.telegram.org/bot{bot_token}/sendMessage",
            json={"chat_id": chat_id, "text": clean_text},
            timeout=timeout,
        )
        if fallback_resp.status_code == 200 and fallback_resp.json().get("ok"):
            return True
        log.error("[Telegram] Falha no fallback texto puro: %s", fallback_resp.text)
    except Exception as e_clean:
        log.error("[Telegram] Exceção no fallback texto puro: %s", e_clean)

    return False


def update_signal_result(*, signal_id: str, owner_id: str, outcome: str) -> bool:
    """Edit an existing Telegram signal once its real result is known."""
    if outcome not in {"WIN", "LOSS"}:
        raise ValueError("Resultado inválido para atualização do Telegram.")
    bot_token, _ = _get_configuration()

    hashed_owner = hashlib.sha256(owner_id.encode("utf-8")).hexdigest()

    with _db_lock:
        with _connection() as connection:
            row = connection.execute(
                """SELECT chat_id, message_id, message_text, outcome
                   FROM telegram_signals
                   WHERE signal_id=? AND owner_id=? AND status='sent'""",
                (signal_id, hashed_owner),
            ).fetchone()
            if row is None or row[1] is None:
                return False
            chat_id, message_id, message_text, existing_outcome = row
            if existing_outcome is not None:
                return False

        result_emoji = "🟢" if outcome == "WIN" else "🔴"
        result_label = "GREEN ✅" if outcome == "WIN" else "RED ❌"
        updated_message = f"{message_text}\n\n{result_emoji} *{result_label}*"

        try:
            response = requests.post(
                f"https://api.telegram.org/bot{bot_token}/editMessageText",
                json={
                    "chat_id": chat_id,
                    "message_id": message_id,
                    "text": updated_message,
                    "parse_mode": "MarkdownV2",
                },
                timeout=10,
            )
        except requests.RequestException as exc:
            raise TelegramDeliveryError("Não foi possível atualizar a mensagem no Telegram.") from exc

        try:
            result = response.json()
        except ValueError as exc:
            raise TelegramDeliveryError("Telegram retornou uma resposta inválida.") from exc
        if response.status_code >= 400:
            description = result.get("description", "") if isinstance(result, dict) else ""
            if "message is not modified" not in description.lower():
                raise TelegramDeliveryError(
                    f"Telegram rejeitou a atualização (HTTP {response.status_code})."
                )
        elif not isinstance(result, dict) or result.get("ok") is not True:
            raise TelegramDeliveryError("Telegram não confirmou a atualização da mensagem.")

        with _connection() as connection:
            connection.execute(
                """UPDATE telegram_signals SET outcome=?
                   WHERE signal_id=? AND owner_id=? AND outcome IS NULL""",
                (
                    outcome,
                    signal_id,
                    hashed_owner,
                ),
            )
            # Atualiza contadores de sessão
            if outcome == "WIN":
                connection.execute(
                    """INSERT INTO telegram_session_stats (owner_id, greens, reds, updated_at)
                       VALUES (?, 1, 0, ?)
                       ON CONFLICT(owner_id) DO UPDATE SET greens=greens+1, updated_at=excluded.updated_at""",
                    (hashed_owner, int(time.time())),
                )
            else:
                connection.execute(
                    """INSERT INTO telegram_session_stats (owner_id, reds, greens, updated_at)
                       VALUES (?, 1, 0, ?)
                       ON CONFLICT(owner_id) DO UPDATE SET reds=reds+1, updated_at=excluded.updated_at""",
                    (hashed_owner, int(time.time())),
                )
    return True


def record_operation(
    *,
    owner_id: str,
    asset: str,
    direction: str,
    timeframe: str,
    outcome: str,  # "WIN" ou "LOSS"
    profit: float = 0.0,
    stake: float = 0.0,
    account_type: str = "PRACTICE",
    date_str: Optional[str] = None,
) -> None:
    """Registra uma operação finalizada no banco de dados SQLite com data e tipo de conta."""
    if not date_str:
        date_str = time.strftime("%Y-%m-%d")
    hashed_owner = hashlib.sha256(owner_id.encode("utf-8")).hexdigest()
    act = "REAL" if "real" in str(account_type).lower() else "PRACTICE"
    with _db_lock:
        with _connection() as connection:
            connection.execute(
                """INSERT INTO telegram_daily_operations
                   (owner_id, date_str, account_type, asset, direction, timeframe, outcome, profit, stake, created_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (hashed_owner, date_str, act, asset, direction, timeframe, outcome.upper(), profit, stake, int(time.time())),
            )


def get_daily_report_stats(
    owner_id: str,
    date_str: Optional[str] = None,
    account_filter: str = "both",  # "real", "demo", "both"
) -> dict:
    """Retorna estatísticas detalhadas das operações do dia para o Telegram e painel."""
    if not date_str:
        date_str = time.strftime("%Y-%m-%d")
    hashed_owner = hashlib.sha256(owner_id.encode("utf-8")).hexdigest()

    with _db_lock:
        with _connection() as connection:
            # Todas as operações do dia para o usuário
            rows = connection.execute(
                """SELECT account_type, asset, outcome, profit, stake
                   FROM telegram_daily_operations
                   WHERE owner_id=? AND date_str=?""",
                (hashed_owner, date_str),
            ).fetchall()

    real_greens = 0
    real_reds = 0
    real_profit = 0.0

    demo_greens = 0
    demo_reds = 0
    demo_profit = 0.0

    asset_map = {}

    for row in rows:
        act, ast, out, pnl, stk = row[0], row[1], row[2], row[3], row[4]
        is_real = (act == "REAL")
        is_win = (out == "WIN")

        if is_real:
            if is_win:
                real_greens += 1
            else:
                real_reds += 1
            real_profit += float(pnl or 0)
        else:
            if is_win:
                demo_greens += 1
            else:
                demo_reds += 1
            demo_profit += float(pnl or 0)

        # Filtro de ativos para ranking
        include_asset = (
            account_filter == "both"
            or (account_filter == "real" and is_real)
            or (account_filter in ("demo", "practice") and not is_real)
        )
        if include_asset:
            if ast not in asset_map:
                asset_map[ast] = {"asset": ast, "wins": 0, "losses": 0}
            if is_win:
                asset_map[ast]["wins"] += 1
            else:
                asset_map[ast]["losses"] += 1

    # Totais consolidados conforme filtro
    if account_filter == "real":
        total_greens = real_greens
        total_reds = real_reds
        total_profit = real_profit
    elif account_filter in ("demo", "practice"):
        total_greens = demo_greens
        total_reds = demo_reds
        total_profit = demo_profit
    else:
        total_greens = real_greens + demo_greens
        total_reds = real_reds + demo_reds
        total_profit = real_profit + demo_profit

    total_ops = total_greens + total_reds
    winrate_geral = round((total_greens / total_ops * 100), 1) if total_ops > 0 else 0.0
    real_ops = real_greens + real_reds
    real_winrate = round((real_greens / real_ops * 100), 1) if real_ops > 0 else 0.0
    demo_ops = demo_greens + demo_reds
    demo_winrate = round((demo_greens / demo_ops * 100), 1) if demo_ops > 0 else 0.0

    # Ranqueamento de ativos
    top_greens = []
    top_reds = []
    for ast, item in asset_map.items():
        w = item["wins"]
        l = item["losses"]
        tot = w + l
        wr = round((w / tot * 100), 1) if tot > 0 else 0.0
        data = {"asset": ast, "wins": w, "losses": l, "winrate": wr}
        if w > 0:
            top_greens.append(data)
        if l > 0:
            top_reds.append(data)

    top_greens.sort(key=lambda x: (x["wins"], x["winrate"]), reverse=True)
    top_reds.sort(key=lambda x: (x["losses"], -x["winrate"]), reverse=True)

    return {
        "date_str": date_str,
        "account_filter": account_filter,
        "total_greens": total_greens,
        "total_reds": total_reds,
        "winrate": winrate_geral,
        "total_profit": round(total_profit, 2),
        "real_greens": real_greens,
        "real_reds": real_reds,
        "real_winrate": real_winrate,
        "real_profit": round(real_profit, 2),
        "demo_greens": demo_greens,
        "demo_reds": demo_reds,
        "demo_winrate": demo_winrate,
        "demo_profit": round(demo_profit, 2),
        "top_greens": top_greens,
        "top_reds": top_reds,
    }


def _send_telegram_post(bot_token: str, chat_id: str, html_text: str, timeout: int = 10) -> bool:
    """Envia mensagem ao Telegram usando HTML limpo com fallback automático para texto puro."""
    # 1. Tenta envio com formatação HTML
    try:
        resp = requests.post(
            f"https://api.telegram.org/bot{bot_token}/sendMessage",
            json={"chat_id": chat_id, "text": html_text, "parse_mode": "HTML"},
            timeout=timeout,
        )
        if resp.ok:
            return True
        log.warning("[Telegram] Falha no envio HTML (HTTP %s): %s", resp.status_code, resp.text)
    except Exception as e:
        log.warning("[Telegram] Erro na requisição HTML: %s", e)

    # 2. Fallback resiliente: remove tags HTML e envia texto sem formatação
    try:
        plain_text = re.sub(r"<[^>]+>", "", html_text)
        resp_fallback = requests.post(
            f"https://api.telegram.org/bot{bot_token}/sendMessage",
            json={"chat_id": chat_id, "text": plain_text},
            timeout=timeout,
        )
        if resp_fallback.ok:
            log.info("[Telegram] Mensagem entregue com sucesso via fallback de texto.")
            return True
        log.error("[Telegram] Fallback de texto também falhou (HTTP %s): %s", resp_fallback.status_code, resp_fallback.text)
    except Exception as e_fb:
        log.error("[Telegram] Erro no fallback de texto do Telegram: %s", e_fb)

    return False


def send_result_summary(
    *,
    owner_id: str,
    asset: str,
    direction: str,
    timeframe: str,
    outcome: str,  # "WIN_DIRECT", "WIN_GALE1", "LOSS_GALE1", "LOSS_DIRECT"
    profit: float,
    stake: float = 0.0,
    account_type: str = "PRACTICE",
) -> bool:
    """Registra o resultado no banco diário e envia o resumo da operação ao Telegram com placar do DIA."""
    is_win = "WIN" in outcome.upper()
    simple_outcome = "WIN" if is_win else "LOSS"

    # 1. Grava no histórico diário permanente por conta
    record_operation(
        owner_id=owner_id,
        asset=asset,
        direction=direction,
        timeframe=timeframe,
        outcome=simple_outcome,
        profit=profit,
        stake=stake,
        account_type=account_type,
    )

    try:
        bot_token, chat_id = _get_configuration()
    except Exception:
        return False

    # 2. Busca estatísticas do DIA ATUAL da conta operada
    stats = get_daily_report_stats(owner_id, account_filter="real" if "real" in str(account_type).lower() else "demo")
    greens = stats.get("total_greens", 0)
    reds = stats.get("total_reds", 0)
    total_ops = greens + reds
    winrate_str = f"{(greens / total_ops * 100):.1f}%" if total_ops > 0 else "100%"

    account_label = "Conta Real 💎" if "real" in str(account_type).lower() else "Conta Demo 🎮"
    dir_emoji = "🟢 CALL" if direction.upper() == "CALL" else "🔴 PUT"

    if outcome == "WIN_DIRECT":
        header = "🎯 <b>RESULTADO DA OPERAÇÃO</b>\n\n✅ <b>WIN DE PRIMEIRA!</b> 🚀"
        profit_line = f"💰 <b>Lucro:</b> <code>+${profit:.2f}</code>"
    elif outcome == "WIN_GALE1":
        header = "🎯 <b>RESULTADO DA OPERAÇÃO</b>\n\n✅ <b>WIN NO GALE 1!</b> 🎯"
        profit_line = f"💰 <b>Lucro Líquido:</b> <code>+${profit:.2f}</code> (Recuperado)"
    elif outcome == "LOSS_GALE1":
        header = "🎯 <b>RESULTADO DA OPERAÇÃO</b>\n\n❌ <b>LOSS NO GALE 1</b> 🔴"
        profit_line = f"💸 <b>Prejuízo:</b> <code>-${abs(profit):.2f}</code> (Stop Gale 1)"
    else:
        header = "🎯 <b>RESULTADO DA OPERAÇÃO</b>\n\n❌ <b>LOSS</b> 🔴"
        profit_line = f"💸 <b>Prejuízo:</b> <code>-${abs(profit):.2f}</code>"

    lines = [
        header,
        f"💹 <b>Ativo:</b> <code>{asset}</code>",
        f"⏱ <b>Timeframe:</b> <code>{timeframe}</code>",
        f"📊 <b>Direção:</b> {dir_emoji}",
        f"💼 <b>Conta:</b> {account_label}",
        profit_line,
        "━━━━━━━━━━━━━━━━━━━━━━",
        f"📊 <b>Placar de Hoje ({account_label}):</b> {greens}🟢 | {reds}🔴 (<b>{winrate_str}</b> Assertividade)",
    ]
    html_text = "\n".join(lines)
    return _send_telegram_post(bot_token, chat_id, html_text, timeout=8)


def send_gale_alert(
    *,
    owner_id: str,
    asset: str,
    direction: str,
    gale_num: int,
    amount: float,
) -> bool:
    """Envia aviso no Telegram de que a ordem 1 deu loss e o Gale está sendo executado."""
    try:
        bot_token, chat_id = _get_configuration()
    except Exception:
        return False

    dir_emoji = "🟢 CALL" if direction.upper() == "CALL" else "🔴 PUT"
    lines = [
        f"⚡ <b>EXECUTANDO GALE {gale_num}</b>",
        f"💹 <b>Ativo:</b> <code>{asset}</code>",
        f"🎯 <b>Direção:</b> {dir_emoji}",
        f"💵 <b>Entrada:</b> <code>${amount:.2f}</code>",
        "⏳ <i>Aguardando fechamento da vela...</i>",
    ]
    html_text = "\n".join(lines)
    return _send_telegram_post(bot_token, chat_id, html_text, timeout=6)


def send_daily_ranking(
    *,
    owner_id: str,
    top_greens: list = None,
    top_reds: list = None,
    total_greens: int = None,
    total_reds: int = None,
    blacklisted_assets: list = None,
    account_filter: str = "both",  # "real", "demo", "both"
) -> bool:
    """Envia mensagem personalizada ao Telegram com o resumo do DIA ATUAL (Demo, Real ou Ambos)."""
    try:
        bot_token, chat_id = _get_configuration()
    except Exception as e_cfg:
        log.error("[Telegram] Erro de configuração ao enviar relatório diário: %s", e_cfg)
        return False

    # Obtém dados consolidados do DIA de hoje no banco
    stats = get_daily_report_stats(owner_id, account_filter=account_filter)

    # Permite sobrescrever com dados passados ou usa os do banco diário
    t_greens = total_greens if total_greens is not None else stats["total_greens"]
    t_reds = total_reds if total_reds is not None else stats["total_reds"]
    t_top_greens = top_greens if (top_greens is not None and len(top_greens) > 0) else stats["top_greens"]
    t_top_reds = top_reds if (top_reds is not None and len(top_reds) > 0) else stats["top_reds"]

    now_str = time.strftime("%d/%m/%Y às %H:%M")
    total_ops = t_greens + t_reds
    winrate_geral = round((t_greens / total_ops * 100), 1) if total_ops > 0 else 0.0

    if account_filter == "real":
        title_badge = "💎 <b>CONTA REAL</b>"
    elif account_filter in ("demo", "practice"):
        title_badge = "🎮 <b>CONTA DEMO (TREINAMENTO)</b>"
    else:
        title_badge = "🌐 <b>CONSOLIDADO (REAL & DEMO)</b>"

    lines = [
        "🏆 <b>RANKING DIÁRIO — RW TIPS SCANNER</b>",
        f"💼 <b>Modalidade:</b> {title_badge}",
        f"📅 <b>Relatório:</b> <code>{now_str}</code>",
        "━━━━━━━━━━━━━━━━━━━━━━",
        "🟢 <b>TOP ATIVOS COM MAIS GREENS (WINS):</b>",
    ]

    if t_top_greens:
        for idx, item in enumerate(t_top_greens[:5], start=1):
            num_emoji = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣"][idx - 1] if idx <= 5 else f"{idx}."
            asset = item.get("asset", "")
            wins = item.get("wins", 0)
            losses = item.get("losses", 0)
            wr = item.get("winrate", 0.0)
            lines.append(f"{num_emoji} <b>{asset}:</b> <code>{wins} W | {losses} L</code> (<b>{wr}%</b> winrate)")
    else:
        lines.append("  <i>Nenhum ativo com greens registrado ainda hoje.</i>")

    lines.append("")
    lines.append("🔴 <b>TOP ATIVOS COM MAIS REDS (LOSSES):</b>")
    if t_top_reds:
        for idx, item in enumerate(t_top_reds[:5], start=1):
            num_emoji = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣"][idx - 1] if idx <= 5 else f"{idx}."
            asset = item.get("asset", "")
            losses = item.get("losses", 0)
            wins = item.get("wins", 0)
            wr = item.get("winrate", 0.0)
            warning_tag = " ⚠️" if losses >= 3 else ""
            lines.append(f"{num_emoji} <b>{asset}:</b>{warning_tag} <code>{losses} L | {wins} W</code> (<b>{wr}%</b> winrate)")
    else:
        lines.append("  <i>Nenhum ativo com excesso de perdas hoje! 🚀</i>")

    lines.append("━━━━━━━━━━━━━━━━━━━━━━")
    lines.append(f"📊 <b>PLACAR DO DIA:</b> {t_greens}🟢 | {t_reds}🔴 (<b>{winrate_geral}%</b> Assertividade)")

    if account_filter == "both":
        lines.append(f"   💎 <i>Conta Real:</i> <b>{stats['real_greens']}🟢 | {stats['real_reds']}🔴</b> ({stats['real_winrate']}%)")
        lines.append(f"   🎮 <i>Conta Demo:</i> <b>{stats['demo_greens']}🟢 | {stats['demo_reds']}🔴</b> ({stats['demo_winrate']}%)")

    if blacklisted_assets:
        bl_str = ", ".join(blacklisted_assets[:8])
        lines.append("━━━━━━━━━━━━━━━━━━━━━━")
        lines.append(f"🚫 <b>Blacklist Ativa:</b> <code>{bl_str}</code>")
        lines.append("<i>(Estes ativos estão 100% pausados pelo robô)</i>")

    lines.append("━━━━━━━━━━━━━━━━━━━━━━")
    lines.append("💡 <i>Dica: Monitore o Dashboard na plataforma para filtros por período e análise completa de assertividade.</i>")

    html_text = "\n".join(lines)
    return _send_telegram_post(bot_token, chat_id, html_text, timeout=10)


def get_dashboard_analytics(
    owner_id: str,
    start_date: Optional[str] = None,
    end_date: Optional[str] = None,
    account_filter: str = "both",
) -> dict:
    """Retorna dados analíticos completos para o Dashboard da plataforma com filtro de datas."""
    hashed_owner = hashlib.sha256(owner_id.encode("utf-8")).hexdigest()
    today_str = time.strftime("%Y-%m-%d")
    s_date = start_date or today_str
    e_date = end_date or today_str

    with _db_lock:
        with _connection() as connection:
            query = """SELECT date_str, account_type, asset, direction, timeframe, outcome, profit, stake, created_at
                       FROM telegram_daily_operations
                       WHERE owner_id=? AND date_str >= ? AND date_str <= ?"""
            params = [hashed_owner, s_date, e_date]

            if account_filter == "real":
                query += " AND account_type='REAL'"
            elif account_filter in ("demo", "practice"):
                query += " AND account_type='PRACTICE'"

            query += " ORDER BY created_at ASC"
            rows = connection.execute(query, params).fetchall()

    total_greens = 0
    total_reds = 0
    total_profit = 0.0
    timeline_map = {}
    asset_map = {}
    recent_trades = []

    for r in rows:
        d_str, act, ast, direc, tf, out, pnl, stk, cat = r[0], r[1], r[2], r[3], r[4], r[5], r[6], r[7], r[8]
        is_win = (out == "WIN")
        profit_val = float(pnl or 0)

        if is_win:
            total_greens += 1
        else:
            total_reds += 1
        total_profit += profit_val

        # Timeline por dia
        if d_str not in timeline_map:
            timeline_map[d_str] = {"date": d_str, "greens": 0, "reds": 0, "profit": 0.0, "total": 0}
        if is_win:
            timeline_map[d_str]["greens"] += 1
        else:
            timeline_map[d_str]["reds"] += 1
        timeline_map[d_str]["profit"] = round(timeline_map[d_str]["profit"] + profit_val, 2)
        timeline_map[d_str]["total"] += 1

        # Agrupamento por ativo
        if ast not in asset_map:
            asset_map[ast] = {"asset": ast, "trades": 0, "greens": 0, "reds": 0, "profit": 0.0}
        asset_map[ast]["trades"] += 1
        if is_win:
            asset_map[ast]["greens"] += 1
        else:
            asset_map[ast]["reds"] += 1
        asset_map[ast]["profit"] = round(asset_map[ast]["profit"] + profit_val, 2)

        # Trade recente
        recent_trades.append({
            "date": d_str,
            "time": time.strftime("%H:%M", time.localtime(cat)),
            "account_type": act,
            "asset": ast,
            "direction": direc,
            "timeframe": tf,
            "outcome": out,
            "profit": round(profit_val, 2),
            "stake": float(stk or 0),
            "created_at": cat,
        })

    total_ops = total_greens + total_reds
    winrate = round((total_greens / total_ops * 100), 1) if total_ops > 0 else 0.0

    timeline = sorted(list(timeline_map.values()), key=lambda x: x["date"])
    for t in timeline:
        tot = t["total"]
        t["winrate"] = round((t["greens"] / tot * 100), 1) if tot > 0 else 0.0

    asset_performance = []
    for ast, item in asset_map.items():
        tr = item["trades"]
        gr = item["greens"]
        wr = round((gr / tr * 100), 1) if tr > 0 else 0.0
        asset_performance.append({
            "asset": ast,
            "trades": tr,
            "greens": gr,
            "reds": item["reds"],
            "winrate": wr,
            "profit": item["profit"],
        })
    asset_performance.sort(key=lambda x: (x["trades"], x["winrate"]), reverse=True)

    # Últimos primeiro
    recent_trades.reverse()

    return {
        "start_date": s_date,
        "end_date": e_date,
        "account_filter": account_filter,
        "total_trades": total_ops,
        "total_greens": total_greens,
        "total_reds": total_reds,
        "winrate": winrate,
        "total_profit": round(total_profit, 2),
        "timeline": timeline,
        "asset_performance": asset_performance,
        "recent_trades": recent_trades[:100],
    }




