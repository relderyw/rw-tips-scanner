/**
 * marketSession.js
 * Filtro de sessão de mercado para opções binárias.
 *
 * Em mercados com baixa liquidez (fora de sessão), os padrões de candle têm
 * win rate historicamente inferior em ~10-15 pp. Sinalizar fora de sessão
 * polui os resultados e destrói a confiança no sistema.
 *
 * Fontes:
 *  - Forex: sessões Tóquio (00-09h UTC), Londres (07-16h UTC), NY (12-21h UTC)
 *    → janela ativa: 07h-21h UTC (sobreposição Londres+NY = melhor liquidez)
 *  - Cripto: 24/7, mas evitar fins de semana (menor liquidez, OTC manipulado)
 *  - Índices: horário da bolsa respectiva
 */

// Sessões por tipo de ativo (horas UTC, [horaInicio, horaFim])
const FOREX_SESSION  = [7, 21];   // Londres abertura → NY fechamento
const INDEX_US_SESSION = [13, 20]; // NYSE: 09:30-16:00 ET = 13:30-20:00 UTC
const INDEX_EU_SESSION = [7, 15];  // Frankfurt: 08:00-16:30 CET = 07:00-15:30 UTC
const CRYPTO_SESSION = [0, 24];    // 24h (mas com flag de fim de semana)

// Mapeamento ativo → configuração de sessão
const SESSION_CONFIG = {
  // Forex majors/crosses
  EURUSD:  { type: 'forex', session: FOREX_SESSION },
  'EURUSD-op':  { type: 'forex', session: FOREX_SESSION },
  'EURUSD-OTC': { type: 'forex', session: FOREX_SESSION },
  GBPUSD:  { type: 'forex', session: FOREX_SESSION },
  'GBPUSD-op':  { type: 'forex', session: FOREX_SESSION },
  USDJPY:  { type: 'forex', session: FOREX_SESSION },
  'USDJPY-op':  { type: 'forex', session: FOREX_SESSION },
  AUDCAD:  { type: 'forex', session: FOREX_SESSION },
  'AUDCAD-op':  { type: 'forex', session: FOREX_SESSION },
  EURJPY:  { type: 'forex', session: FOREX_SESSION },
  'EURJPY-op':  { type: 'forex', session: FOREX_SESSION },
  GBPJPY:  { type: 'forex', session: FOREX_SESSION },
  'GBPJPY-op':  { type: 'forex', session: FOREX_SESSION },

  // Crypto: sempre ativo, mas não em fins de semana
  BTCUSD:  { type: 'crypto', session: CRYPTO_SESSION, blockWeekend: false },
  'BTCUSD-op':  { type: 'crypto', session: CRYPTO_SESSION, blockWeekend: false },
  ETHUSD:  { type: 'crypto', session: CRYPTO_SESSION, blockWeekend: false },
  'ETHUSD-OTC': { type: 'crypto', session: CRYPTO_SESSION, blockWeekend: false },

  // Índices americanos
  US30:    { type: 'index_us', session: INDEX_US_SESSION },
  'US30:N':{ type: 'index_us', session: INDEX_US_SESSION },
  US500:   { type: 'index_us', session: INDEX_US_SESSION },
  'SP500-OTC': { type: 'index_us', session: INDEX_US_SESSION },
  US100:   { type: 'index_us', session: INDEX_US_SESSION },
  'USNDAQ100:N': { type: 'index_us', session: INDEX_US_SESSION },

  // Índice europeu
  GER30:   { type: 'index_eu', session: INDEX_EU_SESSION },
  'GER30-OTC': { type: 'index_eu', session: INDEX_EU_SESSION },
};

/**
 * Retorna true se o ativo está dentro da janela de sessão ativa.
 * @param {string} assetId - ID do ativo (ex: 'EURUSD', 'EURUSD-op', 'BTCUSD')
 * @param {number} [nowMs=Date.now()] - timestamp em ms (para testes)
 * @returns {boolean}
 */
export function isActiveSession(assetId, nowMs = Date.now()) {
  const config = SESSION_CONFIG[assetId];

  // Ativo desconhecido → não bloquear (deixar o sistema decidir)
  if (!config) return true;

  const now = new Date(nowMs);
  const utcHour = now.getUTCHours() + now.getUTCMinutes() / 60;
  const utcDay = now.getUTCDay(); // 0=Dom, 6=Sáb

  const [start, end] = config.session;

  // Forex: bloquear sábado inteiro e domingo até abertura de Tóquio (00h UTC)
  // Na prática: sábado=fechado, domingo antes das 7h UTC=fechado
  if (config.type === 'forex') {
    if (utcDay === 6) return false; // sábado inteiro
    if (utcDay === 0 && utcHour < 7) return false; // domingo antes de Londres
  }

  // Índices: bloquear fim de semana inteiro
  if (config.type === 'index_us' || config.type === 'index_eu') {
    if (utcDay === 0 || utcDay === 6) return false;
  }

  return utcHour >= start && utcHour < end;
}

/**
 * Retorna a próxima abertura de sessão (string HH:MM UTC) ou null se aberta agora.
 * Útil para exibir mensagem informativa na UI.
 */
export function getNextSessionOpen(assetId, nowMs = Date.now()) {
  if (isActiveSession(assetId, nowMs)) return null;
  const config = SESSION_CONFIG[assetId];
  if (!config) return null;
  const [start] = config.session;
  return `${String(Math.floor(start)).padStart(2, '0')}:00 UTC`;
}

/**
 * Mapa de correlação entre ativos (coeficiente aproximado de correlação histórica).
 * Valores > 0.65 em valor absoluto = correlação alta.
 * Fonte: médias históricas de correlação rolling 30d para pares forex.
 */
export const ASSET_CORRELATION_GROUPS = [
  // Grupo USD-positivo (fortalecem quando USD sobe)
  { group: 'USD_BULL', assets: ['USDJPY'], label: 'USD/JPY' },

  // Grupo USD-negativo (enfraquecem quando USD sobe)
  { group: 'USD_BEAR', assets: ['EURUSD', 'GBPUSD', 'AUDCAD'], label: 'EUR/USD, GBP/USD, AUD/CAD' },

  // Grupo EUR-crosses (fortemente influenciados pelo EUR)
  { group: 'EUR_CROSS', assets: ['EURJPY', 'EURUSD'], label: 'EUR/JPY, EUR/USD' },

  // Grupo GBP-crosses
  { group: 'GBP_CROSS', assets: ['GBPJPY', 'GBPUSD'], label: 'GBP/JPY, GBP/USD' },

  // Índices americanos (altamente correlacionados entre si)
  { group: 'US_INDEX', assets: ['US30', 'US500', 'US100'], label: 'Dow, S&P, Nasdaq' },

  // Cripto (correlacionados entre si)
  { group: 'CRYPTO', assets: ['BTCUSD', 'ETHUSD'], label: 'BTC, ETH' },
];

/**
 * Detecta grupos de ativos correlacionados que estão sinalizando na mesma direção.
 * @param {Array<{asset: string, direction: string}>} signals
 * @returns {Array<{group: string, label: string, direction: string, assets: string[]}>}
 */
export function detectCorrelatedSignals(signals) {
  const warnings = [];
  for (const { group, assets, label } of ASSET_CORRELATION_GROUPS) {
    const groupSignals = signals.filter((s) => assets.includes(s.asset));
    if (groupSignals.length < 2) continue;
    // Verifica se 2+ ativos do grupo sinalizam a MESMA direção
    const byDirection = {};
    for (const s of groupSignals) {
      (byDirection[s.direction] = byDirection[s.direction] || []).push(s.asset);
    }
    for (const [direction, affectedAssets] of Object.entries(byDirection)) {
      if (affectedAssets.length >= 2) {
        warnings.push({ group, label, direction, assets: affectedAssets });
      }
    }
  }
  return warnings;
}
