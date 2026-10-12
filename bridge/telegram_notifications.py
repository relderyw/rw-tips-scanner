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
from contextlib import contextmanager
from typing import Generator, Optional

import requests

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


def send_result_summary(
    *,
    owner_id: str,
    asset: str,
    direction: str,
    timeframe: str,
    outcome: str,  # "WIN_DIRECT", "WIN_GALE1", "LOSS_GALE1", "LOSS_DIRECT"
    profit: float,
) -> bool:
    """Envia uma mensagem resumo formatada do resultado final da ordem ao Telegram com o placar geral."""
    try:
        bot_token, chat_id = _get_configuration()
    except Exception:
        return False

    stats = get_session_stats(owner_id)
    greens = stats.get("greens", 0)
    reds = stats.get("reds", 0)
    total = greens + reds
    winrate_str = f"{(greens / total * 100):.1f}%" if total > 0 else "100%"

    dir_emoji = "🟢 CALL" if direction.upper() == "CALL" else "🔴 PUT"

    if outcome == "WIN_DIRECT":
        header = "🎯 *RESULTADO DA OPERAÇÃO*\n\n✅ *WIN DE PRIMEIRA\\!* 🚀"
        profit_line = f"💰 *Lucro:* `+${profit:.2f}`"
    elif outcome == "WIN_GALE1":
        header = "🎯 *RESULTADO DA OPERAÇÃO*\n\n✅ *WIN NO GALE 1\\!* 🎯"
        profit_line = f"💰 *Lucro Líquido:* `+${profit:.2f}` \\(Recuperado\\)"
    elif outcome == "LOSS_GALE1":
        header = "🎯 *RESULTADO DA OPERAÇÃO*\n\n❌ *LOSS NO GALE 1* 🔴"
        profit_line = f"💸 *Prejuízo:* `-${abs(profit):.2f}` \\(Stop Gale 1\\)"
    else:
        header = "🎯 *RESULTADO DA OPERAÇÃO*\n\n❌ *LOSS* 🔴"
        profit_line = f"💸 *Prejuízo:* `-${abs(profit):.2f}`"

    lines = [
        header,
        f"💹 *Ativo:* `{_escape_md(asset)}`",
        f"⏱ *Timeframe:* `{_escape_md(timeframe)}`",
        f"📊 *Direção:* {dir_emoji}",
        profit_line,
        "━━━━━━━━━━━━━━━━━━━━━━",
        f"📊 *Placar da Sessão:* {greens}🟢 \\| {reds}🔴 \\({_escape_md(winrate_str)} Assertividade\\)",
    ]
    message_text = "\n".join(lines)

    try:
        requests.post(
            f"https://api.telegram.org/bot{bot_token}/sendMessage",
            json={"chat_id": chat_id, "text": message_text, "parse_mode": "MarkdownV2"},
            timeout=8,
        )
        return True
    except Exception:
        return False


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
        f"⚡ *EXECUTANDO GALE {gale_num}*",
        f"💹 *Ativo:* `{_escape_md(asset)}`",
        f"🎯 *Direção:* {dir_emoji}",
        f"💵 *Entrada:* `${amount:.2f}`",
        "⏳ _Aguardando fechamento da vela\\.\\.\\._",
    ]
    message_text = "\n".join(lines)

    try:
        requests.post(
            f"https://api.telegram.org/bot{bot_token}/sendMessage",
            json={"chat_id": chat_id, "text": message_text, "parse_mode": "MarkdownV2"},
            timeout=6,
        )
        return True
    except Exception:
        return False


def send_daily_ranking(
    *,
    owner_id: str,
    top_greens: list,
    top_reds: list,
    total_greens: int,
    total_reds: int,
    blacklisted_assets: list = None,
) -> bool:
    """Envia mensagem personalizada ao Telegram com os ativos que mais deram Green e Red no dia atual."""
    try:
        bot_token, chat_id = _get_configuration()
    except Exception:
        return False

    now_str = time.strftime("%d/%m/%Y às %H:%M")
    total_ops = total_greens + total_reds
    winrate_geral = round((total_greens / total_ops * 100), 1) if total_ops > 0 else 0.0

    lines = [
        "🏆 *RANKING DIÁRIO — RW TIPS SCANNER*",
        f"📅 *Relatório:* `{_escape_md(now_str)}`",
        "━━━━━━━━━━━━━━━━━━━━━━",
        "🟢 *TOP ATIVOS COM MAIS GREENS (WINS):*",
    ]

    if top_greens:
        for idx, item in enumerate(top_greens[:5], start=1):
            num_emoji = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣"][idx - 1] if idx <= 5 else f"{idx}."
            asset = item.get("asset", "")
            wins = item.get("wins", 0)
            losses = item.get("losses", 0)
            wr = item.get("winrate", 0.0)
            lines.append(f"{num_emoji} *{_escape_md(asset)}:* `{wins} W` \\| `{losses} L` \\(`{wr}%` winrate\\)")
    else:
        lines.append("  _Nenhum ativo com greens registrado ainda hoje\\._")

    lines.append("")
    lines.append("🔴 *TOP ATIVOS COM MAIS REDS (LOSSES):*")
    if top_reds:
        for idx, item in enumerate(top_reds[:5], start=1):
            num_emoji = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣"][idx - 1] if idx <= 5 else f"{idx}."
            asset = item.get("asset", "")
            losses = item.get("losses", 0)
            wins = item.get("wins", 0)
            wr = item.get("winrate", 0.0)
            warning_tag = " ⚠️" if losses >= 3 else ""
            lines.append(f"{num_emoji} *{_escape_md(asset)}:*{warning_tag} `{losses} L` \\| `{wins} W` \\(`{wr}%` winrate\\)")
    else:
        lines.append("  _Nenhum ativo com excesso de perdas hoje\\! 🚀_")

    lines.append("━━━━━━━━━━━━━━━━━━━━━━")
    lines.append(f"📊 *PLACAR GERAL DO DIA:* {total_greens}🟢 \\| {total_reds}🔴 \\({_escape_md(str(winrate_geral))}% Assertividade\\)")

    if blacklisted_assets:
        bl_str = ", ".join(blacklisted_assets[:8])
        lines.append("━━━━━━━━━━━━━━━━━━━━━━")
        lines.append(f"🚫 *Blacklist Ativa:* `{_escape_md(bl_str)}`")
        lines.append("_(Estes ativos estão 100% pausados pelo robô)_")

    lines.append("━━━━━━━━━━━━━━━━━━━━━━")
    lines.append("💡 _Dica: Ativos na lista de Reds podem ser colocados na Blacklist diretamente pelo painel para proteger sua banca\\._")

    message_text = "\n".join(lines)

    try:
        resp = requests.post(
            f"https://api.telegram.org/bot{bot_token}/sendMessage",
            json={"chat_id": chat_id, "text": message_text, "parse_mode": "MarkdownV2"},
            timeout=10,
        )
        return resp.ok
    except Exception:
        return False


