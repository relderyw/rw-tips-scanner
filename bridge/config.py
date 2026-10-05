"""Configuração da ponte. Tudo vem de variáveis de ambiente.

SOMENTE LEITURA: esta ponte NÃO executa trades. A sessão do painel consulta a conta real.
"""
import os
from dotenv import load_dotenv

load_dotenv(os.path.join(os.path.dirname(__file__), ".env"))

# --- Credenciais e chaves ---
IQ_EMAIL = os.getenv("IQ_EMAIL", "")
IQ_PASSWORD = os.getenv("IQ_PASSWORD", "")
API_KEY = os.getenv("API_KEY", "")

# --- Persistência ---
DB_PATH = os.getenv("DB_PATH", "./data/candles.db")
RETENTION_HOURS = int(os.getenv("RETENTION_HOURS", "200"))
BACKFILL_HOURS = int(os.getenv("BACKFILL_HOURS", "168"))

# (Legado, ignorado silenciosamente; substituído por streaming em tempo real)
POLL_SECONDS = int(os.getenv("POLL_SECONDS", "15"))

# --- CORS e REST ---
CORS_ORIGINS = [o.strip() for o in os.getenv("CORS_ORIGINS", "http://localhost:5173").split(",") if o.strip()]

# --- Tempos do coletor em tempo real ---
# Intervalo do watchdog que verifica streams stale / market_closed (segundos)
WATCHDOG_INTERVAL = int(os.getenv("WATCHDOG_INTERVAL", "10"))
# Margem extra (acima de 2 x timeframe) para considerar um stream "stale" sem candle novo
STALE_MARGIN_SECONDS = int(os.getenv("STALE_MARGIN_SECONDS", "30"))
# Intervalo de envio de mensagem "health" pelo WebSocket (segundos)
WS_HEALTH_INTERVAL = int(os.getenv("WS_HEALTH_INTERVAL", "5"))
# Intervalo de atualização dos payouts da IQ Option (minutos)
PAYOUT_REFRESH_MINUTES = int(os.getenv("PAYOUT_REFRESH_MINUTES", "5"))

# Timeframes do painel -> segundos
TIMEFRAMES = {"M1": 60, "M5": 300, "M15": 900}
# Reverso: segundos -> id do painel (ex.: 60 -> "M1")
TIMEFRAMES_SEC_TO_ID = {v: k for k, v in TIMEFRAMES.items()}

# IDs dos 12 ativos do painel (mesma ordem de src/data/candleData.js)
ASSET_IDS = [
    "EURUSD", "GBPUSD", "USDJPY", "AUDCAD",
    "EURJPY", "GBPJPY", "BTCUSD", "ETHUSD",
    "US30", "US500", "US100", "GER30",
]

# ID do painel -> nome DO PRIMEIRO ativo (quando mercado ABERTO) na IQ Option.
# (Mantido por compatibilidade; o resolver real usa ASSET_IQ_NAMES abaixo.)
ASSETS = {
    "EURUSD": "EURUSD-op",  "GBPUSD": "GBPUSD-op",
    "USDJPY": "USDJPY-op",  "AUDCAD": "AUDCAD-op",
    "EURJPY": "EURJPY-op",  "GBPJPY": "GBPJPY-op",
    "BTCUSD": "BTCUSD-op",  "ETHUSD": "ETHUSD-OTC",
    "US30":   "US30:N",     "US500":  "SP500-OTC",
    "US100":  "USNDAQ100:N","GER30":  "GER30-OTC",
}

# ID do painel -> LISTA DE CANDIDATOS (ordem de preferência) para nome na IQ Option.
# O resolvedor testa cada candidato:
#   1) se existe em UNDERLYING_ASSESTS (options_assests.py) E
#   2) se is_open=True via get_actives()
# Usa o primeiro que satisfaz; se nenhum aberto, usa o primeiro existente mesmo que fechado
# (status será "market_closed" e não haverá reconexão em loop).
# Valores confirmados em ./iqoptionapi/instruments/options_assests.py (UNDERLYING_ASSESTS)
ASSET_IQ_NAMES = {
    "EURUSD": ["EURUSD-op", "EURUSD-OTC"],
    "GBPUSD": ["GBPUSD-op", "GBPUSD-OTC"],
    "USDJPY": ["USDJPY-op", "USDJPY-OTC"],
    "AUDCAD": ["AUDCAD-op", "AUDCAD-OTC"],
    "EURJPY": ["EURJPY-op", "EURJPY-OTC"],
    "GBPJPY": ["GBPJPY-op", "GBPJPY-OTC"],
    "BTCUSD": ["BTCUSD-op", "BTCUSD"],
    "ETHUSD": ["ETHUSD-OTC"],
    "US30":   ["US30:N", "US30-OTC"],
    "US500":  ["USSPX500:N", "SP500-OTC", "S&P 500"],
    "US100":  ["USNDAQ100:N", "USNDAQ100-OTC", "USNDAQ 100 (NDX) Spot Index"],
    "GER30":  ["GER30-OTC", "DAX"],
}
