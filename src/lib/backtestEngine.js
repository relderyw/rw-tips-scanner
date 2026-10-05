// Motor de backtest genérico: interpreta strategy.rules, gera sinais e simula resultados com até 2 Gales.
import { ema, sma, rsi, bollinger, stochastic, macd, atr, highest, lowest, rollingMin } from './indicators.js';
import { DETECTORS, comparePrices, evaluateStrategy } from './detectors.js';
import { wilson, sampleConfidence, breakEven } from './stats.js';
import { isStrategyBacktestEnabled } from '../data/strategies.js';

export const WARMUP = 120;
export const STAKE_MULT = 2; // multiplicador de stake em cada Gale
const BANKROLL0 = 100;

// Contexto com arrays e indicadores memoizados (calculados uma única vez por conjunto de candles)
const ctxCache = new WeakMap();
export function getContext(candles) {
  if (!Array.isArray(candles)) {
    throw new TypeError('O backtest esperava uma lista de candles válida.');
  }
  const invalidIndex = candles.findIndex((candle) =>
    !candle ||
    ![candle.time, candle.open, candle.high, candle.low, candle.close].every(Number.isFinite));
  if (invalidIndex !== -1) {
    throw new TypeError(`Candle inválido na posição ${invalidIndex}; o backtest foi interrompido para evitar resultados incorretos.`);
  }
  if (ctxCache.has(candles)) return ctxCache.get(candles);
  const o = candles.map((k) => k.open), h = candles.map((k) => k.high);
  const l = candles.map((k) => k.low), c = candles.map((k) => k.close);
  const time = candles.map((k) => k.time);
  const cache = new Map();
  const memo = (key, fn) => { if (!cache.has(key)) cache.set(key, fn()); return cache.get(key); };
  const ctx = {
    n: candles.length, o, h, l, c, time,
    ema: (p) => memo('ema' + p, () => ema(c, p)),
    sma: (p) => memo('sma' + p, () => sma(c, p)),
    rsi: (p) => memo('rsi' + p, () => rsi(c, p)),
    bb: (p, d) => memo(`bb${p}_${d}`, () => bollinger(c, p, d)),
    stoch: (p) => memo('st' + p, () => stochastic(h, l, c, p)),
    macd: () => memo('macd', () => macd(c)),
    atr: (p) => memo('atr' + p, () => atr(h, l, c, p)),
    hh: (p) => memo('hh' + p, () => highest(h, p)),
    ll: (p) => memo('ll' + p, () => lowest(l, p)),
    wmin: (p) => memo('wmin' + p, () => rollingMin(ctx.bb(20, 2).width, p)),
  };
  ctxCache.set(candles, ctx);
  return ctx;
}

// Gera sinais [{ index, direction }] para uma estratégia
export function detectSignals(candles, strategy, options = {}) {
  if (!isStrategyBacktestEnabled(strategy)) return [];
  if (strategy.evaluator) {
    const signals = [];
    for (let index = 0; index < candles.length; index++) {
      const evaluation = evaluateStrategy(candles, index, strategy.evaluator, {
        ...options,
        timeframe: strategy.timeframe,
        variant: strategy.variant,
      });
      if (evaluation.signal) signals.push({ index, direction: evaluation.direction, evaluation });
    }
    return signals;
  }

  const ctx = getContext(candles);
  const { detector, params = {}, direction = 'both' } = strategy.rules;
  const fn = DETECTORS[detector];
  if (typeof fn !== 'function') {
    throw new RangeError(`Detector não implementado para estratégia ${strategy.id}: ${detector}`);
  }
  const out = [];
  const warmup = WARMUP;
  for (let i = warmup; i < ctx.n; i++) {
    const d = fn(ctx, i, params);
    if (d && (direction === 'both' || direction === d)) out.push({ index: i, direction: d });
  }
  return out;
}

// Simula operações. opts: { gale: 0|1|2, direction: 'ALL'|'CALL'|'PUT', payout (%) }
export function runBacktest(candles, strategy, opts = {}) {
  const { gale = 0, direction = 'ALL', payout = 85, pricePrecision, minimumTick } = opts;
  const ctx = getContext(candles);
  const exp = strategy.expiration;
  const pay = payout / 100;
  const trades = [];
  let nextFree = 0;

  for (const sig of detectSignals(candles, strategy, { pricePrecision, minimumTick })) {
    if (sig.index < nextFree) continue;
    if (direction !== 'ALL' && sig.direction !== direction) continue;
    const dir = sig.direction === 'CALL' ? 1 : -1;
    const enterAtNextOpen = Boolean(strategy.evaluator) || strategy.rules.entry === 'next_candle_open';
    let stakeSum = 0, profit = 0, result = null, level = 0, exitIdx = sig.index, complete = true;

    for (level = 0; level <= gale; level++) {
      const eIdx = sig.index + (enterAtNextOpen ? 1 : 0) + level * exp;
      const xIdx = eIdx + exp - (enterAtNextOpen ? 1 : 0);
      if (xIdx >= ctx.n) { complete = false; break; }
      const step = strategy.timeframe === 'M5' ? 300 : 60;
      if (enterAtNextOpen && ctx.time[eIdx] !== ctx.time[sig.index] + step * (1 + level * exp)) {
        complete = false;
        break;
      }
      for (let candleIndex = sig.index + 1; candleIndex <= xIdx; candleIndex++) {
        if (ctx.time[candleIndex] - ctx.time[candleIndex - 1] !== step) {
          complete = false;
          break;
        }
      }
      if (!complete) break;
      const stake = STAKE_MULT ** level;
      const prior = stakeSum;
      stakeSum += stake;
      exitIdx = xIdx;
      const entry = enterAtNextOpen ? ctx.o[eIdx] : ctx.c[eIdx];
      const priceDirection = comparePrices(ctx.c[xIdx], entry, pricePrecision);
      if (priceDirection === null) {
        throw new TypeError(`Preço inválido na vela ${xIdx} da estratégia ${strategy.id}.`);
      }
      const diff = priceDirection * dir;
      if (diff > 0) { profit = stake * pay - prior; result = 'WIN'; break; }
      if (diff === 0) { profit = -prior; result = 'DOJI'; break; }
      if (level === gale) {
        profit = -stakeSum;
        result = 'LOSS';
        break;
      }
    }
    if (!complete) continue;
    nextFree = exitIdx;
    const entryIndex = sig.index + (enterAtNextOpen ? 1 : 0) + level * exp;
    trades.push({
      index: sig.index, endIndex: exitIdx, time: candles[sig.index].time,
      entryIndex,
      direction: sig.direction,
      entry: enterAtNextOpen ? ctx.o[entryIndex] : ctx.c[entryIndex],
      exit: ctx.c[exitIdx],
      strategy_id: strategy.id,
      variant: strategy.variant || strategy.id,
      signal: true,
      signal_time: sig.evaluation?.signal_time ?? null,
      entry_time: new Date(candles[entryIndex].time * 1000).toISOString(),
      entry_price: enterAtNextOpen ? ctx.o[entryIndex] : ctx.c[entryIndex],
      expiration_time: new Date(candles[exitIdx].time * 1000 + (strategy.timeframe === 'M5' ? 300_000 : 60_000)).toISOString(),
      reference_candles: sig.evaluation?.reference_candles ?? [],
      cancellation_reason: null,
      result, level, profit, stakeSum,
    });
  }
  return trades;
}

const rate = (w, l) => (w + l > 0 ? (w / (w + l)) * 100 : 0);

export function computeStats(trades, payout = 85) {
  let wins = 0, losses = 0, dojis = 0, totalProfit = 0, totalStaked = 0, gp = 0, gl = 0;
  let cw = 0, cl = 0, maxW = 0, maxL = 0;
  let bank = BANKROLL0, peak = BANKROLL0, maxDD = 0, maxDDPct = 0;
  const equity = [{ n: 0, bankroll: BANKROLL0, time: trades[0]?.time }];
  const byDirection = { CALL: { n: 0, wins: 0, losses: 0 }, PUT: { n: 0, wins: 0, losses: 0 } };
  const byLevel = [0, 0, 0];

  trades.forEach((t, idx) => {
    totalProfit += t.profit; totalStaked += t.stakeSum;
    if (t.profit > 0) gp += t.profit; else gl += -t.profit;
    const d = byDirection[t.direction]; d.n++;
    if (t.result === 'WIN') { wins++; d.wins++; byLevel[t.level]++; cw++; cl = 0; }
    else if (t.result === 'LOSS') { losses++; d.losses++; cl++; cw = 0; }
    else dojis++;
    maxW = Math.max(maxW, cw); maxL = Math.max(maxL, cl);
    bank += t.profit; peak = Math.max(peak, bank);
    const dd = peak - bank;
    if (dd > maxDD) { maxDD = dd; maxDDPct = (dd / peak) * 100; }
    equity.push({ n: idx + 1, bankroll: Number(bank.toFixed(2)), time: t.time });
  });

  const decided = wins + losses;
  const winRate = rate(wins, losses);
  const be = breakEven(payout);
  for (const k of ['CALL', 'PUT']) byDirection[k].winRate = rate(byDirection[k].wins, byDirection[k].losses);

  // Distribuição por blocos cronológicos (5 blocos)
  const blocks = [];
  const size = Math.ceil(trades.length / 5) || 1;
  for (let b = 0; b < 5; b++) {
    const slice = trades.slice(b * size, (b + 1) * size);
    const w = slice.filter((t) => t.result === 'WIN').length;
    const l = slice.filter((t) => t.result === 'LOSS').length;
    blocks.push({ label: `Bloco ${b + 1}`, n: slice.length, winRate: Number(rate(w, l).toFixed(1)) });
  }

  return {
    n: trades.length, wins, losses, dojis, decided, winRate, breakEven: be, edge: winRate - be,
    expectancy: trades.length ? totalProfit / trades.length : 0,
    totalProfit, totalStaked, roi: totalStaked ? (totalProfit / totalStaked) * 100 : 0,
    profitFactor: gl > 0 ? gp / gl : gp > 0 ? null : 0,
    maxDrawdown: maxDD, maxDrawdownPct: maxDDPct, maxWinStreak: maxW, maxLossStreak: maxL,
    ci: wilson(wins, decided), confidence: sampleConfidence(decided),
    equity, byDirection, blocks, byLevel,
  };
}
