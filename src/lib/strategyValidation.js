import { getAvailableAssets, getPayout, getPricePrecision, getPriceTick } from '../data/candleData.js';
import { IMPLEMENTED_STRATEGIES } from '../data/strategies.js';
import { getValidationHistory, invalidateCache } from './runner.js';
import { runBacktest, computeStats, detectSignals } from './backtestEngine.js';
import { getIQSessionToken } from '../services/bridgeApi.js';

export const VALIDATION_TIMEFRAMES = [...new Set(IMPLEMENTED_STRATEGIES.map((strategy) => strategy.timeframe))];
export const VALIDATION_REFRESH_MS = 2 * 60 * 1000;
export const MIN_VALIDATION_TRADES = 10;

const EVALUATION_HOURS = { M1: 1, M5: 2 };
const pairCache = new Map();
const listeners = new Set();
let catalog = [];
let catalogUpdatedAt = 0;
let catalogQueue = Promise.resolve();

export function getEvaluationHours(tf) {
  return EVALUATION_HOURS[tf] ?? null;
}

export function getCatalogSnapshot() {
  return { rows: catalog, updatedAt: catalogUpdatedAt };
}

export function subscribeCatalog(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function publishCatalog(rows) {
  catalog = rows;
  catalogUpdatedAt = Date.now();
  listeners.forEach((listener) => listener(getCatalogSnapshot()));
}

function updatePairStatistics(pair) {
  const { candles, evaluationHours, asset, tf, payout, source } = pair;
  const stepSeconds = tf === 'M1' ? 60 : 300;
  const evaluationBars = (evaluationHours * 3600) / stepSeconds;
  const latestTime = candles.at(-1)?.time ?? 0;
  const evaluationStart = latestTime - (evaluationBars - 1) * stepSeconds;

  pair.evaluationStart = evaluationStart;
  pair.latestEvaluatedTime = latestTime;
  pair.strategies = IMPLEMENTED_STRATEGIES
    .filter((strategy) => strategy.timeframe === tf)
    .map((strategy) => {
    const runs = [0, 1, 2].map((gale) => {
      const trades = runBacktest(candles, strategy, {
        gale, direction: 'ALL', payout,
        pricePrecision: getPricePrecision(asset),
        minimumTick: getPriceTick(asset),
      })
        .filter((trade) => trade.time >= evaluationStart);
      return { gale, trades, stats: computeStats(trades, payout) };
      });
    const base = runs[0];
    return {
      strategy,
      runs,
      stats: base.stats,
      eligible: source === 'live'
        && base.stats.decided >= MIN_VALIDATION_TRADES
        && base.stats.winRate > base.stats.breakEven,
    };
  });
}

export async function validatePair(asset, tf, { force = false } = {}) {
  const evaluationHours = getEvaluationHours(tf);
  if (!evaluationHours) throw new RangeError(`Timeframe sem janela de validação configurada: ${tf}`);

  const key = `${getIQSessionToken()}|${asset}|${tf}`;
  const existing = pairCache.get(key);
  if (!force && existing && Date.now() - existing.updatedAt < VALIDATION_REFRESH_MS) {
    const pair = await existing.promise;
    const currentPayout = getPayout(asset);
    if (
      pair.latestEvaluatedTime !== (pair.candles.at(-1)?.time ?? 0) ||
      pair.payout !== currentPayout
    ) {
      pair.payout = currentPayout;
      updatePairStatistics(pair);
    }
    return pair;
  }

  if (force) invalidateCache(asset, tf);
  const promise = (async () => {
    const { candles, source } = await getValidationHistory(asset, tf, evaluationHours);
    const payout = getPayout(asset);
    const pair = { asset, tf, evaluationHours, candles, source, payout, strategies: [] };
    updatePairStatistics(pair);
    return pair;
  })();

  const entry = { promise, updatedAt: Date.now() };
  pairCache.set(key, entry);
  try {
    const result = await promise;
    entry.updatedAt = Date.now();
    return result;
  } catch (error) {
    if (pairCache.get(key) === entry) pairCache.delete(key);
    throw error;
  }
}

export function invalidatePairValidation(asset, tf) {
  if (!asset) {
    pairCache.clear();
    return;
  }
  if (!tf) {
    for (const key of pairCache.keys()) {
      if (key.startsWith(`${getIQSessionToken()}|${asset}|`)) pairCache.delete(key);
    }
    return;
  }
  pairCache.delete(`${getIQSessionToken()}|${asset}|${tf}`);
}

export async function refreshCatalog({ assets, tfs, force = false } = {}) {
  if (!getIQSessionToken()) {
    publishCatalog([]);
    return [];
  }
  const selectedAssets = assets || getAvailableAssets({ analysisOnly: true }).map((asset) => asset.id);
  const selectedAssetsExplicitly = Boolean(assets);
  const selectedTfs = tfs || VALIDATION_TIMEFRAMES;

  const refresh = catalogQueue.catch(() => {}).then(async () => {
    const rows = [];
    for (const asset of selectedAssets) {
      for (const tf of selectedTfs) {
        const pair = await validatePair(asset, tf, { force });
        for (const result of pair.strategies) {
          rows.push({
            key: `${result.strategy.id}|${asset}|${tf}`,
            strategy: result.strategy,
            asset,
            tf,
            payout: pair.payout,
            source: pair.source,
            stats: result.stats,
            eligible: result.eligible,
          });
        }
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }
    if (selectedAssetsExplicitly || tfs) {
      const refreshedAssets = new Set(selectedAssets);
      const refreshedTimeframes = new Set(selectedTfs);
      const retained = catalog.filter((row) =>
        !refreshedAssets.has(row.asset) || !refreshedTimeframes.has(row.tf));
      publishCatalog([...retained, ...rows]);
    } else {
      publishCatalog(rows);
    }
    return rows;
  });
  catalogQueue = refresh;
  return refresh;
}

export function getApprovedSignals(pair, lookback = 6) {
  const output = [];
  const { candles, strategies, asset, tf } = pair;
  for (const result of strategies) {
    if (!result.eligible) continue;
    const signals = detectSignals(candles, result.strategy, {
      pricePrecision: getPricePrecision(asset),
      minimumTick: getPriceTick(asset),
    })
      .filter((signal) => signal.index >= candles.length - lookback);
    for (const signal of signals) {
      output.push({
        asset,
        tf,
        strategy: result.strategy,
        direction: signal.direction,
        index: signal.index,
        time: candles[signal.index].time,
        stats: result.stats,
      });
    }
  }
  return output;
}

export function startCatalogRefresh() {
  let stopped = false;
  const refresh = (force) => {
    if (!getIQSessionToken()) return;
    refreshCatalog({ force }).catch((error) => {
      if (!stopped) console.error('[strategyValidation] catalog refresh failed:', error);
    });
  };
  refresh(false);
  const timer = setInterval(() => refresh(true), VALIDATION_REFRESH_MS);
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
