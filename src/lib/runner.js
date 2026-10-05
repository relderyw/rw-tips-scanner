// Orquestra: carrega candles (via camada de dados) + roda backtests. Usado pelas páginas.
//
// Mudança no streaming em tempo real: o cache NÃO é mais "por minuto". A chave é
// `${asset}|${tf}|${hours}` e a entrada contém uma referência MUTÁVEL ao array
// de candles. Quando chega uma vela fechada pelo WebSocket (liveFeed), a função
// `appendLiveCandle` muta esse array (append/substitui último), de modo que
// quem já tem uma Promise resolvida para essa entrada vê os novos candles sem
// precisar fazer novo fetch — o RadarLive então recalcula apenas os sinais.
//
// Mantemos fallback por polling REST a cada 2 min (invalida a entry se a entry
// for muito antiga, para recuperar de desconexões longas do WS).
import { getCandles, getPayout, getPricePrecision, getPriceTick, TIMEFRAMES } from '../data/candleData.js';
import { runBacktest, computeStats, detectSignals, WARMUP } from './backtestEngine.js';
import { liveFeed, liveWsEnabled } from '../services/liveFeed.js';
import { getIQSessionToken } from '../services/bridgeApi.js';

const cache = new Map(); // key `${asset}|${tf}|${hours}` → {promise, candles, source, receivedAt}
const MAX_CACHE_SIZE = 48; // mais que antes pois as entradas duram mais
const CACHE_INVALIDATE_MS = 2 * 60 * 1000; // Atualiza o histórico a cada 2 min.

// ---------- Cache utilitários ----------
function cacheKey(asset, tf, hours) {
  return `${getIQSessionToken()}|${asset}|${tf}|${hours}`;
}

function evictOldestIfNeeded() {
  while (cache.size > MAX_CACHE_SIZE) {
    const firstKey = cache.keys().next().value;
    cache.delete(firstKey);
  }
}

/**
 * Remove entradas antigas do cache se passarem CACHE_INVALIDATE_MS. Usado antes
 * de retornar uma entrada — se o WS caiu e o usuário deixou a página aberta,
 * ele acaba refrescando via REST sem clique manual.
 */
function entryStale(entry, nowMs) {
  return nowMs - (entry.receivedAt || 0) > CACHE_INVALIDATE_MS;
}

// Cache por ativo/timeframe/período para evitar fetch repetido a cada render.
export function loadCandles(asset, tf, hours) {
  const key = cacheKey(asset, tf, hours);
  const nowMs = Date.now();
  const existing = cache.get(key);
  if (existing && !entryStale(existing, nowMs)) {
    return existing.promise;
  }

  // Nova fetch (ou re-fetch porque entry ficou stale).
  const promise = (async () => {
    const result = await getCandles({ asset, tf, hours });
    // Garantimos que o array de candles seja nosso (não compartilhamos referência
    // com outros módulos para poder mutar com segurança).
    const candles = Array.isArray(result.candles) ? result.candles.slice() : [];
    const source = result.source || (liveWsEnabled ? 'live' : 'simulated');
    const entry = cache.get(key);
    if (entry) {
      // Dá merge nas referências: atualiza candles e source no mesmo objeto
      // que os outros já têm (continuarão vendo os dados atualizados sem rerender
      // explícito, mas RadarLive usa tick state).
      entry.candles = candles;
      entry.source = source;
      entry.receivedAt = nowMs;
    }
    return { candles, source };
  })();
  // Cria a entrada no cache (mesmo objeto da promise; no await damos merge).
  const entry = {
    promise, candles: null, source: null, receivedAt: nowMs, asset, tf, hours,
    sessionToken: getIQSessionToken(),
  };
  promise.then((r) => {
    entry.candles = r.candles;
    entry.source = r.source;
    entry.receivedAt = nowMs;
  }).catch(() => { /* falha já logada na camada de dados; não deixamos a entry quebrar. */ });
  cache.set(key, entry);
  evictOldestIfNeeded();
  return promise;
}

export async function getValidationHistory(asset, tf, evaluationHours) {
  const timeframe = TIMEFRAMES.find((item) => item.id === tf);
  if (!timeframe) throw new RangeError(`Timeframe inválido: ${tf}`);
  const warmupHours = Math.ceil((WARMUP * timeframe.minutes) / 60);
  const totalHours = evaluationHours + warmupHours + 1;
  const result = await loadCandles(asset, tf, totalHours);
  return { ...result, warmupHours, totalHours };
}

/**
 * Anexa (ou substitui a última, se for mesma abertura) uma vela FECHADA em
 * TODAS as entradas do cache que correspondam ao (asset, tf) e que tenham
 * `hours` grande o suficiente para cobrir o time da vela.
 * Chamado internamente pelo listener do liveFeed (abaixo).
 *
 * Retorna a quantidade de entradas do cache que tiveram candles anexados.
 */
export function appendLiveCandle(asset, tf, candle) {
  if (!candle || typeof candle.time !== 'number') return 0;
  let modified = 0;
  for (const [key, entry] of cache.entries()) {
    if (!entry || entry.asset !== asset || entry.tf !== tf || entry.sessionToken !== getIQSessionToken()) continue;
    const arr = entry.candles;
    if (!Array.isArray(arr) || arr.length === 0) continue;
    const last = arr[arr.length - 1];
    if (!last) continue;
    if (candle.time > last.time) {
      // Nova vela fechada: anexamos no final.
      arr.push({ ...candle });
      modified++;
    } else if (candle.time === last.time) {
      // Mesmo tempo (chegada duplicada ou preço ajustado no mesmo candle):
      // substituímos a última (idempotência).
      arr[arr.length - 1] = { ...candle };
      modified++;
    } else {
      // candle.time < last.time: fora de ordem (chegou atrasado). Ignoramos.
    }
  }
  return modified;
}

/**
 * Invalida 1 entrada ou todas de um ativo/tf. Usado no botão "Atualizar" manual.
 */
export function invalidateCache(asset, tf) {
  if (!asset) { cache.clear(); return; }
  for (const [key, entry] of cache.entries()) {
    if (entry.asset !== asset) continue;
    if (tf && entry.tf !== tf) continue;
    cache.delete(key);
  }
}

// ---------- Listener global: liveFeed → appendLiveCandle ----------
// Assim que o módulo carrega, nos inscrevemos no liveFeed. Quando chega vela
// fechada, appendLiveCandle atualiza TODAS as entradas relevantes do cache.
// Qualquer página que use `loadCandles` (RadarLive, Dashboard, etc.) passará a
// enxergar os novos candles no objeto. A UI então aciona rerender via trigger
// próprio (no RadarLive é um state `tick` incrementado; no Dashboard via polling
// de health).
if (liveWsEnabled && typeof liveFeed.subscribe === 'function') {
  liveFeed.subscribe((msg) => {
    try {
      if (msg && msg.type === 'candle' && msg.asset && msg.tf && msg.candle) {
        appendLiveCandle(msg.asset, msg.tf, msg.candle);
      }
    } catch (e) {
      console.warn('[runner] appendLiveCandle from liveFeed failed:', e);
    }
  });
}

export async function runConfig({ asset, tf, hours, strategy, gale = 0, direction = 'ALL' }) {
  const { candles, source } = await loadCandles(asset, tf, hours);
  const payout = getPayout(asset);
  const trades = runBacktest(candles, strategy, {
    gale, direction, payout,
    pricePrecision: getPricePrecision(asset),
    minimumTick: getPriceTick(asset),
  });
  return { candles, source, payout, trades, stats: computeStats(trades, payout) };
}

const tick = () => new Promise((r) => setTimeout(r, 0)); // libera a UI entre ativos

// Varre ativos × timeframes × estratégias
export async function scanAll({ assets, tfs, hours, strategies, gale = 0, direction = 'ALL', withTrades = false }) {
  const rows = [];
  for (const asset of assets) {
    for (const tf of tfs) {
      const { candles } = await loadCandles(asset, tf, hours);
      const payout = getPayout(asset);
      for (const strategy of strategies) {
        const trades = runBacktest(candles, strategy, {
          gale, direction, payout,
          pricePrecision: getPricePrecision(asset),
          minimumTick: getPriceTick(asset),
        });
        rows.push({
          key: `${strategy.id}|${asset}|${tf}`, strategy, asset, tf, payout,
          stats: computeStats(trades, payout), trades: withTrades ? trades : undefined,
        });
      }
      await tick();
    }
  }
  return rows;
}

export { detectSignals };
