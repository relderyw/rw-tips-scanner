import { ema } from './indicators.js';

// Detectores genéricos recebem (ctx, i, params) e retornam CALL, PUT ou null.
// Regras com ciclo/execução próprios usam um evaluator dedicado.

const bull = (x, i) => x.c[i] > x.o[i];
const bear = (x, i) => x.c[i] < x.o[i];
const body = (x, i) => Math.abs(x.c[i] - x.o[i]);
const rng = (x, i) => x.h[i] - x.l[i];
const upW = (x, i) => x.h[i] - Math.max(x.o[i], x.c[i]);
const loW = (x, i) => Math.min(x.o[i], x.c[i]) - x.l[i];
const allBear = (x, from, to) => { for (let k = from; k <= to; k++) if (!bear(x, k)) return false; return true; };
const allBull = (x, from, to) => { for (let k = from; k <= to; k++) if (!bull(x, k)) return false; return true; };

export function comparePrices(leftPrice, rightPrice, precision) {
  if (!Number.isFinite(leftPrice) || !Number.isFinite(rightPrice)) return null;
  const left = Number.isInteger(precision) && precision >= 0 && precision <= 12
    ? Number(leftPrice.toFixed(precision))
    : leftPrice;
  const right = Number.isInteger(precision) && precision >= 0 && precision <= 12
    ? Number(rightPrice.toFixed(precision))
    : rightPrice;
  if (left > right) return 1;
  if (left < right) return -1;
  return 0;
}

function candleDirection(candle, precision) {
  if (!candle) return null;
  const comparison = comparePrices(candle.close, candle.open, precision);
  if (comparison === 1) return 'CALL';
  if (comparison === -1) return 'PUT';
  if (comparison === 0) return 'DOJI';
  return null;
}

const SEC = { M1: 60, M5: 300 };
const ids = {
  mhi1MinorityBlock5m: 'mhi-1-minority-5m',
  mhi2FourCandleMinority: 'mhi-2-four-candle-minority',
  mhi3MovingMinority: 'mhi-3-moving-minority',
  mhiMajority5m: 'mhi-majority-5m',
  twinTowers: 'torres-gemeas',
  fiveFlip: 'five-flip',
  sevenFlip: 'seven-flip',
  threeNeighbors: 'tres-vizinhos',
  millionSixMajority: 'milhao-six-majority',
  triplication: 'triplicacao',
  noTriplication: 'nao-triplicacao',
  intercalation: 'intercalacao',
  r7Majority: 'r7',
  pattern23: 'padrao-23',
  pattern3x1: 'padrao-3x1',
  oddPattern: 'padrao-impar',
  fifthElement: 'quinto-elemento',
  threeMusketeers: 'tres-mosqueteiros',
  twinCandle: 'twin-candle',
  mirror: 'mirror',
  wolf: 'wolf',
  claw: 'garra',
  threeBrothers: 'tres-irmaos',
  threePairs: 'tres-pares',
  bullishEngulfing: 'engolfo-alta',
  bearishEngulfing: 'engolfo-baixa',
  hammerSupport: 'martelo-suporte',
  shootingStarResistance: 'estrela-cadente-resistencia',
  trendPullback: 'pullback-tendencia',
  resistanceBreakout: 'rompimento-resistencia',
  supportBreakout: 'rompimento-suporte',
  breakoutRetest: 'breakout-reteste',
  supportRejection: 'rejeicao-suporte',
  resistanceRejection: 'rejeicao-resistencia',
};

function getCandleDirection(candle, precision) {
  if (!candle || ![candle.time, candle.open, candle.high, candle.low, candle.close].every(Number.isFinite)
    || candle.high < Math.max(candle.open, candle.close)
    || candle.low > Math.min(candle.open, candle.close)
    || candle.high < candle.low) return null;
  return candleDirection(candle, precision);
}

function result(candles, index, strategyId, direction, referenceCandles, step, cancellationReason = null, variant = strategyId) {
  const signalCandle = candles[index];
  const entryTime = signalCandle && Number.isFinite(signalCandle.time)
    ? signalCandle.time + step
    : null;
  const entryCandle = candles[index + 1];
  const hasEntry = entryCandle && entryCandle.time === entryTime;
  return {
    strategy_id: strategyId,
    variant,
    signal: Boolean(direction) && (!entryCandle || hasEntry),
    ...(direction && (!entryCandle || hasEntry) ? { direction } : {}),
    ...(entryTime === null ? {} : {
      signal_time: new Date(entryTime * 1000).toISOString(),
      entry_time: new Date(entryTime * 1000).toISOString(),
      entry_price: hasEntry ? entryCandle.open : null,
      expiration_time: new Date((entryTime + step) * 1000).toISOString(),
    }),
    reference_candles: referenceCandles,
    cancellation_reason: cancellationReason || (direction && entryCandle && !hasEntry ? 'MISSING_ENTRY_CANDLE' : null),
  };
}

function failure(candles, index, evaluator, refs, step, reason, variant) {
  return result(candles, index, ids[evaluator], null, refs, step, reason, variant);
}

function contiguous(candles, from, to, step) {
  return from >= 0 && to < candles.length && Array.from({ length: to - from }, (_, offset) =>
    candles[from + offset + 1]?.time - candles[from + offset]?.time === step).every(Boolean);
}

function classify(candles, from, to, precision) {
  const directions = [];
  for (let cursor = from; cursor <= to; cursor++) {
    const direction = getCandleDirection(candles[cursor], precision);
    if (!direction || direction === 'DOJI') return null;
    directions.push(direction);
  }
  return directions;
}

function evaluate(candles, index, evaluator, options = {}) {
  const { pricePrecision, minimumTick } = options;
  const variant = options.variant || (evaluator === 'mhi1MinorityBlock5m' ? 'minority_block_5m' : ids[evaluator]);
  const step = SEC[options.timeframe || (evaluator.endsWith('Support') || evaluator.endsWith('Resistance')
    || evaluator.includes('Breakout') || evaluator.includes('Rejection') || evaluator === 'trendPullback'
    || evaluator.includes('Engulfing') ? 'M5' : 'M1')];
  const definition = ({
    mhi1MinorityBlock5m: 3, mhi2FourCandleMinority: 4, mhi3MovingMinority: 3,
    mhiMajority5m: 3, twinTowers: 2, fiveFlip: 5, sevenFlip: 7, threeNeighbors: 3,
    millionSixMajority: 6, triplication: 3, noTriplication: 2, intercalation: 4,
    r7Majority: 7, pattern23: 2, pattern3x1: 4, oddPattern: 5, fifthElement: 5,
    threeMusketeers: 3, twinCandle: 2, mirror: 6, wolf: 3, claw: 3,
    threeBrothers: 3, threePairs: 6, bullishEngulfing: 2, bearishEngulfing: 2,
    hammerSupport: 21, shootingStarResistance: 21, trendPullback: 4,
    resistanceBreakout: 21, supportBreakout: 21, breakoutRetest: 22,
    supportRejection: 21, resistanceRejection: 21,
  })[evaluator];
  const from = index - definition + 1;
  const refs = Number.isInteger(index) && from >= 0 ? candles.slice(from, index + 1) : [];
  const fail = (reason) => failure(candles, index, evaluator, refs, step, reason, variant);
  if (!Number.isInteger(index) || index < 0 || index >= candles.length || refs.length !== definition) {
    return fail('INSUFFICIENT_REFERENCE_CANDLES');
  }
  if (!contiguous(candles, from, index, step)) return fail('MISSING_CANDLE_OR_TIME_GAP');
  if (refs.some((candle) => !getCandleDirection(candle, pricePrecision))) return fail('INVALID_CANDLE');
  if (getCandleDirection(candles[index], pricePrecision) === 'DOJI') return fail('DOJI_SIGNAL_CANDLE');
  const dir = (at) => getCandleDirection(candles[at], pricePrecision);
  const directionStart = ['hammerSupport', 'shootingStarResistance', 'supportRejection', 'resistanceRejection',
    'resistanceBreakout', 'supportBreakout', 'breakoutRetest'].includes(evaluator)
    ? index
    : from;
  const dirs = classify(candles, directionStart, index, pricePrecision);
  const directionCount = (items, direction) => items.filter((item) => item === direction).length;
  let signal = null;
  let reason = 'PATTERN_NOT_MATCHED';

  if (evaluator === 'mhi1MinorityBlock5m' || evaluator === 'mhiMajority5m') {
    const first = candles[index - 2];
    if (first.time % 300 !== 0 || candles[index].time % 300 !== 120) return fail('INVALID_BLOCK_ALIGNMENT');
    if (!dirs) return fail('DOJI_REFERENCE');
    const calls = directionCount(dirs, 'CALL');
    const puts = directionCount(dirs, 'PUT');
    if (calls === puts) return fail('TIED_REFERENCE_COUNT');
    signal = evaluator === 'mhi1MinorityBlock5m'
      ? (calls > puts ? 'PUT' : 'CALL')
      : (calls > puts ? 'CALL' : 'PUT');
  } else if (evaluator === 'mhi2FourCandleMinority') {
    const first = candles[index - 3];
    if (first.time % 300 !== 0 || candles[index].time % 300 !== 180) return fail('INVALID_BLOCK_ALIGNMENT');
    if (!dirs) return fail('DOJI_REFERENCE');
    const calls = directionCount(dirs, 'CALL');
    const puts = directionCount(dirs, 'PUT');
    if (Math.abs(calls - puts) !== 2) return fail('TIED_REFERENCE_COUNT');
    signal = calls > puts ? 'PUT' : 'CALL';
  } else if (evaluator === 'millionSixMajority') {
    const first = candles[index - 5];
    if (first.time % 360 !== 0 || candles[index].time % 360 !== 300) return fail('INVALID_BLOCK_ALIGNMENT');
    if (!dirs) return fail('DOJI_REFERENCE');
    const calls = directionCount(dirs, 'CALL');
    const puts = directionCount(dirs, 'PUT');
    if (calls < 4 && puts < 4) return fail('NO_REQUIRED_MAJORITY');
    signal = calls >= 4 ? 'CALL' : 'PUT';
  } else if (evaluator === 'pattern23') {
    if (candles[index - 1].time % 300 !== 60 || candles[index].time % 300 !== 120) return fail('INVALID_BLOCK_ALIGNMENT');
    if (!dirs) return fail('DOJI_REFERENCE');
    signal = dirs[0] === dirs[1] ? dirs[1] : null;
    if (!signal) reason = 'REFERENCE_DIRECTIONS_DIFFER';
  } else if (evaluator === 'oddPattern') {
    if (candles[index - 4].time % 300 !== 0 || candles[index].time % 300 !== 240) return fail('INVALID_BLOCK_ALIGNMENT');
    const odd = [dir(index - 4), dir(index - 2), dir(index)];
    if (odd.includes(null) || odd.includes('DOJI')) return fail('DOJI_REFERENCE');
    signal = directionCount(odd, 'CALL') > directionCount(odd, 'PUT') ? 'CALL' : 'PUT';
  } else if (evaluator === 'fifthElement') {
    const firstFour = dirs?.slice(0, 4);
    if (!firstFour) return fail('DOJI_REFERENCE');
    const calls = directionCount(firstFour, 'CALL');
    const puts = directionCount(firstFour, 'PUT');
    if (calls === puts) return fail('TIED_REFERENCE_COUNT');
    const majority = calls > puts ? 'CALL' : 'PUT';
    if (dirs[4] === majority) signal = majority;
    else reason = 'CONFIRMATION_DIRECTION_MISMATCH';
  } else if (evaluator === 'mhi3MovingMinority') {
    if (!dirs) return fail('DOJI_REFERENCE');
    const calls = directionCount(dirs, 'CALL');
    const puts = directionCount(dirs, 'PUT');
    if (calls === puts) return fail('TIED_REFERENCE_COUNT');
    signal = calls > puts ? 'PUT' : 'CALL';
  } else if (evaluator === 'twinTowers') {
    if (!dirs) return fail('DOJI_REFERENCE');
    const [left, right] = refs;
    if (dirs[0] !== dirs[1]) return fail('DIRECTION_MISMATCH');
    const ratios = refs.map((candle) => Math.abs(candle.close - candle.open) / (candle.high - candle.low));
    signal = ratios.every((ratio) => ratio >= 0.5) ? dirs[1] : null;
    if (!signal) reason = 'BODY_BELOW_MINIMUM';
  } else if (evaluator === 'fiveFlip' || evaluator === 'sevenFlip' || evaluator === 'threeNeighbors' || evaluator === 'triplication' || evaluator === 'noTriplication') {
    if (!dirs) return fail('DOJI_REFERENCE');
    if (dirs.every((item) => item === dirs[0])) {
      signal = evaluator === 'fiveFlip' || evaluator === 'sevenFlip' || evaluator === 'noTriplication'
        ? (dirs[0] === 'CALL' ? 'PUT' : 'CALL')
        : dirs[0];
    } else reason = 'SEQUENCE_BROKEN';
  } else if (evaluator === 'intercalation') {
    if (!dirs) return fail('DOJI_REFERENCE');
    signal = dirs.every((item, offset) => offset === 0 || item !== dirs[offset - 1]) ? dirs[3] : null;
    if (!signal) reason = 'ALTERNATION_BROKEN';
  } else if (evaluator === 'r7Majority') {
    if (!dirs) return fail('DOJI_REFERENCE');
    const calls = directionCount(dirs, 'CALL');
    const puts = directionCount(dirs, 'PUT');
    if (Math.max(calls, puts) >= 5) signal = calls > puts ? 'CALL' : 'PUT';
    else reason = 'NO_REQUIRED_MAJORITY';
  } else if (evaluator === 'pattern3x1') {
    if (!dirs) return fail('DOJI_REFERENCE');
    signal = dirs[0] === dirs[1] && dirs[1] === dirs[2] && dirs[3] !== dirs[0] ? dirs[0] : null;
    if (!signal) reason = 'THREE_PLUS_COUNTER_CANDLE_REQUIRED';
  } else if (evaluator === 'threeMusketeers' || evaluator === 'threeBrothers') {
    if (!dirs) return fail('DOJI_REFERENCE');
    const bodyMin = evaluator === 'threeBrothers' ? 0.4 : 0.4;
    const bodyMax = evaluator === 'threeBrothers' ? 0.8 : 0.8;
    const validBody = refs.every((candle) => {
      const range = candle.high - candle.low;
      const ratio = range > 0 ? Math.abs(candle.close - candle.open) / range : 0;
      return ratio >= bodyMin && ratio <= bodyMax;
    });
    const progressive = dirs[0] === 'CALL'
      ? refs[1].close > refs[0].close && refs[2].close > refs[1].close
      : refs[1].close < refs[0].close && refs[2].close < refs[1].close;
    signal = dirs.every((item) => item === dirs[0]) && validBody && progressive ? dirs[0] : null;
    if (!signal) reason = !validBody ? 'BODY_RATIO_OUT_OF_RANGE' : 'CLOSES_NOT_PROGRESSIVE';
  } else if (evaluator === 'twinCandle') {
    if (!dirs) return fail('DOJI_REFERENCE');
    const [first, second] = refs;
    const bodies = refs.map((candle) => Math.abs(candle.close - candle.open));
    signal = dirs[0] !== dirs[1] && Math.abs(bodies[0] - bodies[1]) / Math.max(bodies[0], bodies[1]) <= 0.1
      ? dirs[1]
      : null;
    if (!signal) reason = 'BODY_SIZE_OUT_OF_TOLERANCE';
  } else if (evaluator === 'mirror') {
    if (!dirs) return fail('DOJI_REFERENCE');
    const first = dirs.slice(0, 3);
    const second = dirs.slice(3);
    signal = second.every((item, offset) => item === first[2 - offset]) ? second[2] : null;
    if (!signal) reason = 'SEQUENCES_NOT_MIRRORED';
  } else if (evaluator === 'wolf') {
    if (!dirs) return fail('DOJI_REFERENCE');
    const highs = refs.slice(1).map((candle, offset) => comparePrices(candle.high, refs[offset].high, pricePrecision));
    const lows = refs.slice(1).map((candle, offset) => comparePrices(candle.low, refs[offset].low, pricePrecision));
    if ([...highs, ...lows].includes(0)) return fail('EQUAL_EXTREMA');
    if (highs.every((value) => value > 0) && lows.every((value) => value > 0)) signal = 'CALL';
    else if (highs.every((value) => value < 0) && lows.every((value) => value < 0)) signal = 'PUT';
    else reason = 'MIXED_EXTREMA';
  } else if (evaluator === 'claw') {
    if (!dirs) return fail('DOJI_REFERENCE');
    signal = dirs[0] === dirs[2] && dirs[1] !== dirs[0] ? dirs[0] : null;
    if (!signal) reason = 'OUTER_MIDDLE_DIRECTIONS_MISMATCH';
  } else if (evaluator === 'threePairs') {
    if (!dirs) return fail('DOJI_REFERENCE');
    const pairs = [dirs.slice(0, 2), dirs.slice(2, 4), dirs.slice(4, 6)];
    signal = pairs.every(([first, second]) => first === second && first === pairs[0][0])
      ? pairs[0][0]
      : null;
    if (!signal) reason = 'PAIR_DIRECTIONS_DIVERGE';
  } else if (evaluator === 'bullishEngulfing' || evaluator === 'bearishEngulfing') {
    const [previous, current] = refs;
    if (!dirs) return fail('DOJI_REFERENCE');
    const match = evaluator === 'bullishEngulfing'
      ? dirs[0] === 'PUT' && dirs[1] === 'CALL' && current.open <= previous.close && current.close >= previous.open
      : dirs[0] === 'CALL' && dirs[1] === 'PUT' && current.open >= previous.close && current.close <= previous.open;
    signal = match ? (evaluator === 'bullishEngulfing' ? 'CALL' : 'PUT') : null;
    if (!signal) reason = 'BODY_DOES_NOT_ENGULF';
  } else if (evaluator === 'hammerSupport' || evaluator === 'shootingStarResistance' || evaluator === 'supportRejection' || evaluator === 'resistanceRejection') {
    const candle = candles[index];
    if (!dirs) return fail('DOJI_REFERENCE');
    const prior = candles.slice(index - 20, index);
    if (prior.length !== 20) return fail('INSUFFICIENT_LEVEL_HISTORY');
    const isResistance = evaluator === 'shootingStarResistance' || evaluator === 'resistanceRejection';
    const level = isResistance ? Math.max(...prior.map((item) => item.high)) : Math.min(...prior.map((item) => item.low));
    const tolerance = level * 0.001;
    const bodySize = Math.abs(candle.close - candle.open);
    const upperWick = candle.high - Math.max(candle.open, candle.close);
    const lowerWick = Math.min(candle.open, candle.close) - candle.low;
    const range = candle.high - candle.low;
    const nearLevel = isResistance ? Math.abs(candle.high - level) <= tolerance : Math.abs(candle.low - level) <= tolerance;
    const hammer = evaluator === 'hammerSupport';
    const rejectionValid = nearLevel && (hammer
      ? lowerWick >= 2 * bodySize && upperWick <= bodySize && candle.close >= candle.low + range / 2
      : upperWick >= 2 * bodySize && lowerWick <= bodySize && candle.close <= candle.low + range / 2);
    const plainRejectionValid = nearLevel && (isResistance
      ? upperWick >= 2 * bodySize && candle.close < level
      : lowerWick >= 2 * bodySize && candle.close > level);
    const valid = hammer || evaluator === 'shootingStarResistance' ? rejectionValid : plainRejectionValid;
    signal = valid ? (isResistance ? 'PUT' : 'CALL') : null;
    if (!signal) reason = 'LEVEL_OR_WICK_CONDITION_NOT_MET';
  } else if (evaluator === 'trendPullback') {
    if (!dirs) return fail('DOJI_REFERENCE');
    if (index < 23) return fail('INSUFFICIENT_TREND_HISTORY');
    const closeValues = candles.slice(0, index + 1).map((candle) => candle.close);
    const fast = ema(closeValues, 9);
    const slow = ema(closeValues, 21);
    const bullishTrend = fast[index] > slow[index] && fast[index] > fast[index - 3] && slow[index] > slow[index - 3];
    const bearishTrend = fast[index] < slow[index] && fast[index] < fast[index - 3] && slow[index] < slow[index - 3];
    const correction = candles[index - 1];
    if (bullishTrend && correction.low <= fast[index - 1] && correction.close >= slow[index - 1] && dirs[3] === 'CALL') signal = 'CALL';
    else if (bearishTrend && correction.high >= fast[index - 1] && correction.close <= slow[index - 1] && dirs[3] === 'PUT') signal = 'PUT';
    else reason = 'TREND_PULLBACK_NOT_CONFIRMED';
  } else if (evaluator === 'resistanceBreakout' || evaluator === 'supportBreakout') {
    if (!Number.isFinite(minimumTick) || minimumTick <= 0) return fail('TICK_SIZE_UNAVAILABLE');
    const prior = candles.slice(index - 20, index);
    if (prior.length !== 20) return fail('INSUFFICIENT_LEVEL_HISTORY');
    const resistance = Math.max(...prior.map((candle) => candle.high));
    const support = Math.min(...prior.map((candle) => candle.low));
    if (evaluator === 'resistanceBreakout' && candles[index].close >= resistance + minimumTick) signal = 'CALL';
    else if (evaluator === 'supportBreakout' && candles[index].close <= support - minimumTick) signal = 'PUT';
    else reason = 'BREAKOUT_NOT_CONFIRMED';
  } else if (evaluator === 'breakoutRetest') {
    if (!Number.isFinite(minimumTick) || minimumTick <= 0) return fail('TICK_SIZE_UNAVAILABLE');
    if (index < 21) return fail('INSUFFICIENT_LEVEL_HISTORY');
    for (let breakoutIndex = Math.max(20, index - 5); breakoutIndex < index; breakoutIndex++) {
      const history = candles.slice(breakoutIndex - 20, breakoutIndex);
      const resistance = Math.max(...history.map((candle) => candle.high));
      const support = Math.min(...history.map((candle) => candle.low));
      const breakout = candles[breakoutIndex];
      const upBreak = breakout.close >= resistance + minimumTick;
      const downBreak = breakout.close <= support - minimumTick;
      if (!upBreak && !downBreak) continue;
      const level = upBreak ? resistance : support;
      const tolerance = level * 0.001;
      const postBreak = candles.slice(breakoutIndex + 1, index + 1);
      const invalidated = postBreak.slice(0, -1).some((candle) =>
        upBreak ? candle.close < level - tolerance : candle.close > level + tolerance);
      if (invalidated) continue;
      const current = candles[index];
      const touched = upBreak
        ? current.low <= level + tolerance && current.high >= level - tolerance && current.close > level
        : current.high >= level - tolerance && current.low <= level + tolerance && current.close < level;
      if (touched) {
        signal = upBreak ? 'CALL' : 'PUT';
        break;
      }
    }
    if (!signal) reason = 'NO_CONFIRMED_RETEST_WITHIN_WINDOW';
  }

  return result(candles, index, ids[evaluator], signal, refs, step, signal ? null : reason, variant);
}

export const evaluateMhi1MinorityBlock5m = (candles, index, options = {}) =>
  evaluate(candles, index, 'mhi1MinorityBlock5m', options);

export const STRATEGY_EVALUATORS = Object.fromEntries(
  Object.keys(ids).map((key) => [key, (candles, index, options) => evaluate(candles, index, key, options)]),
);

export function evaluateStrategy(candles, index, evaluator, options = {}) {
  const evaluatorFn = STRATEGY_EVALUATORS[evaluator];
  if (!evaluatorFn) throw new RangeError(`Evaluator não implementado: ${evaluator}`);
  return evaluatorFn(candles, index, options);
}

export const DETECTORS = {
  // RSI em zona extrema → reversão
  rsiExtreme(x, i, p) {
    const r = x.rsi(p.period)[i];
    if (r <= p.low) return 'CALL';
    if (r >= p.high) return 'PUT';
    return null;
  },
  // Fechamento fora da banda de Bollinger → reversão
  bbTouch(x, i, p) {
    const b = x.bb(p.period || 20, p.dev || 2);
    if (x.c[i] < b.lower[i]) return 'CALL';
    if (x.c[i] > b.upper[i]) return 'PUT';
    return null;
  },
  // Vela anterior fechou fora da banda e a atual voltou para dentro
  bbReentry(x, i, p) {
    const b = x.bb(p.period || 20, p.dev || 2);
    if (x.c[i - 1] < b.lower[i - 1] && x.c[i] >= b.lower[i]) return 'CALL';
    if (x.c[i - 1] > b.upper[i - 1] && x.c[i] <= b.upper[i]) return 'PUT';
    return null;
  },
  stochExtreme(x, i, p) {
    const k = x.stoch(p.period || 14)[i];
    if (k <= p.low) return 'CALL';
    if (k >= p.high) return 'PUT';
    return null;
  },
  // N velas seguidas da mesma cor. mode: 'reversal' (opera contra) ou 'continuation' (a favor)
  streak(x, i, p) {
    const a = i - p.n + 1;
    const dn = allBear(x, a, i), up = allBull(x, a, i);
    if (!dn && !up) return null;
    if (p.mode === 'continuation') return up ? 'CALL' : 'PUT';
    return up ? 'PUT' : 'CALL';
  },
  // Martelo / estrela cadente (pavio longo de rejeição)
  pinBar(x, i, p) {
    const r = rng(x, i);
    if (r <= 0) return null;
    const ratio = p.ratio || 2;
    if (loW(x, i) >= ratio * body(x, i) && loW(x, i) >= 2 * upW(x, i) && loW(x, i) >= 0.55 * r) {
      if (!p.trend || x.c[i - 3] > x.c[i - 1]) return 'CALL';
    }
    if (upW(x, i) >= ratio * body(x, i) && upW(x, i) >= 2 * loW(x, i) && upW(x, i) >= 0.55 * r) {
      if (!p.trend || x.c[i - 3] < x.c[i - 1]) return 'PUT';
    }
    return null;
  },
  engulfing(x, i, p) {
    if (bear(x, i - 1) && bull(x, i) && x.o[i] <= x.c[i - 1] && x.c[i] >= x.o[i - 1] && body(x, i) > body(x, i - 1)) {
      if (!p.trend || x.c[i - 3] > x.c[i - 1]) return 'CALL';
    }
    if (bull(x, i - 1) && bear(x, i) && x.o[i] >= x.c[i - 1] && x.c[i] <= x.o[i - 1] && body(x, i) > body(x, i - 1)) {
      if (!p.trend || x.c[i - 3] < x.c[i - 1]) return 'PUT';
    }
    return null;
  },
  morningStar(x, i) {
    const big = body(x, i - 2) >= 0.5 * rng(x, i - 2);
    const small = body(x, i - 1) < 0.4 * body(x, i - 2);
    const mid = (x.o[i - 2] + x.c[i - 2]) / 2;
    if (big && small && bear(x, i - 2) && bull(x, i) && x.c[i] > mid) return 'CALL';
    if (big && small && bull(x, i - 2) && bear(x, i) && x.c[i] < mid) return 'PUT';
    return null;
  },
  harami(x, i) {
    if (body(x, i - 1) < 0.6 * rng(x, i - 1)) return null;
    if (bear(x, i - 1) && bull(x, i) && x.o[i] >= x.c[i - 1] && x.c[i] <= x.o[i - 1]) return 'CALL';
    if (bull(x, i - 1) && bear(x, i) && x.o[i] <= x.c[i - 1] && x.c[i] >= x.o[i - 1]) return 'PUT';
    return null;
  },
  tweezer(x, i, p) {
    const tol = (p.tol || 0.1) * Math.max(rng(x, i), rng(x, i - 1));
    if (bull(x, i - 1) && bear(x, i) && Math.abs(x.h[i] - x.h[i - 1]) <= tol) return 'PUT';
    if (bear(x, i - 1) && bull(x, i) && Math.abs(x.l[i] - x.l[i - 1]) <= tol) return 'CALL';
    return null;
  },
  // Doji depois de N velas na mesma direção → reversão
  dojiAfterRun(x, i, p) {
    const r = rng(x, i);
    if (r <= 0 || body(x, i) > 0.1 * r) return null;
    if (allBear(x, i - p.n, i - 1)) return 'CALL';
    if (allBull(x, i - p.n, i - 1)) return 'PUT';
    return null;
  },
  // Barra interna (inside bar) seguida de rompimento
  insideBar(x, i) {
    const inside = x.h[i - 1] < x.h[i - 2] && x.l[i - 1] > x.l[i - 2];
    if (!inside) return null;
    if (x.c[i] > x.h[i - 1]) return 'CALL';
    if (x.c[i] < x.l[i - 1]) return 'PUT';
    return null;
  },
  threeSoldiers(x, i) {
    const strong = (k) => body(x, k) >= 0.5 * rng(x, k);
    if (allBull(x, i - 2, i) && x.c[i] > x.c[i - 1] && x.c[i - 1] > x.c[i - 2] && strong(i) && strong(i - 1) && strong(i - 2)) return 'CALL';
    if (allBear(x, i - 2, i) && x.c[i] < x.c[i - 1] && x.c[i - 1] < x.c[i - 2] && strong(i) && strong(i - 1) && strong(i - 2)) return 'PUT';
    return null;
  },
  // Vela de corpo cheio e amplitude acima da média → continuação
  marubozu(x, i, p) {
    const r = rng(x, i);
    if (r <= 0 || body(x, i) < 0.85 * r || r < (p.atrMult || 1.2) * x.atr(14)[i - 1]) return null;
    return bull(x, i) ? 'CALL' : 'PUT';
  },
  emaCross(x, i, p) {
    const f = x.ema(p.fast), s = x.ema(p.slow);
    if (f[i - 1] <= s[i - 1] && f[i] > s[i]) return 'CALL';
    if (f[i - 1] >= s[i - 1] && f[i] < s[i]) return 'PUT';
    return null;
  },
  // Tendência (EMA lenta) + toque na EMA rápida e rejeição
  emaPullback(x, i, p) {
    const f = x.ema(p.fast), s = x.ema(p.slow);
    if (f[i] > s[i] && s[i] > s[i - 3] && x.l[i] <= f[i] && x.c[i] > f[i] && bull(x, i)) return 'CALL';
    if (f[i] < s[i] && s[i] < s[i - 3] && x.h[i] >= f[i] && x.c[i] < f[i] && bear(x, i)) return 'PUT';
    return null;
  },
  macdCross(x, i) {
    const m = x.macd();
    if (m.line[i - 1] <= m.signal[i - 1] && m.line[i] > m.signal[i]) return 'CALL';
    if (m.line[i - 1] >= m.signal[i - 1] && m.line[i] < m.signal[i]) return 'PUT';
    return null;
  },
  // Filtro de tendência por EMA longa + retorno após 2 velas contra
  trendPullback(x, i, p) {
    const e = x.ema(p.period);
    if (x.c[i] > e[i] && e[i] > e[i - 5] && bear(x, i - 2) && bear(x, i - 1) && bull(x, i)) return 'CALL';
    if (x.c[i] < e[i] && e[i] < e[i - 5] && bull(x, i - 2) && bull(x, i - 1) && bear(x, i)) return 'PUT';
    return null;
  },
  tripleEma(x, i) {
    const a = x.ema(5), b = x.ema(13), c = x.ema(34);
    const up = (k) => a[k] > b[k] && b[k] > c[k];
    const dn = (k) => a[k] < b[k] && b[k] < c[k];
    if (up(i) && !up(i - 1)) return 'CALL';
    if (dn(i) && !dn(i - 1)) return 'PUT';
    return null;
  },
  // Rebote em suporte/resistência (extremos das últimas N velas) com pavio de rejeição
  srBounce(x, i, p) {
    const a = x.atr(14)[i];
    if (x.l[i] <= x.ll(p.lookback)[i] + 0.15 * a && bull(x, i) && loW(x, i) >= body(x, i)) return 'CALL';
    if (x.h[i] >= x.hh(p.lookback)[i] - 0.15 * a && bear(x, i) && upW(x, i) >= body(x, i)) return 'PUT';
    return null;
  },
  donchianBreak(x, i, p) {
    if (x.c[i] > x.hh(p.lookback)[i]) return 'CALL';
    if (x.c[i] < x.ll(p.lookback)[i]) return 'PUT';
    return null;
  },
  // Falso rompimento: ultrapassa o extremo mas fecha de volta dentro
  donchianFake(x, i, p) {
    if (x.h[i] > x.hh(p.lookback)[i] && x.c[i] < x.hh(p.lookback)[i]) return 'PUT';
    if (x.l[i] < x.ll(p.lookback)[i] && x.c[i] > x.ll(p.lookback)[i]) return 'CALL';
    return null;
  },
  // Compressão de volatilidade (largura mínima das bandas) seguida de rompimento
  squeeze(x, i) {
    const b = x.bb(20, 2);
    const wmin = x.wmin(50)[i - 1];
    if (!(b.width[i - 1] <= wmin * 1.15)) return null;
    if (x.c[i] > b.upper[i]) return 'CALL';
    if (x.c[i] < b.lower[i]) return 'PUT';
    return null;
  },
  // Confluência: todos os detectores da lista precisam apontar a mesma direção
  all(x, i, p) {
    let dir = null;
    for (const item of p.list) {
      const d = DETECTORS[item.detector](x, i, item.params || {});
      if (!d || (dir && d !== dir)) return null;
      dir = d;
    }
    return dir;
  },
};
