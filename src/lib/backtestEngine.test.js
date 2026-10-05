import test from 'node:test';
import assert from 'node:assert/strict';
import {
  STRATEGIES,
  IMPLEMENTED_STRATEGIES,
  STATUS,
  hasOperationalRule,
  isStrategyBacktestEnabled,
} from '../data/strategies.js';
import { detectSignals, runBacktest, computeStats, getContext } from './backtestEngine.js';
import { evaluateMhi1MinorityBlock5m, evaluateStrategy } from './detectors.js';

const M1_START = 1_800_000_000;

function rawCandle(time, open, high, low, close) {
  return { time, open, high, low, close };
}

function candle(time, direction, timeframe = 'M1') {
  const step = timeframe === 'M5' ? 300 : 60;
  if (direction === 'CALL') return rawCandle(time, 1, 1.12, 0.98, 1.1);
  if (direction === 'PUT') return rawCandle(time, 1.1, 1.12, 0.98, 1);
  return rawCandle(time, 1, 1.1, 0.9, 1);
}

function sequence(directions, timeframe = 'M1', start = M1_START) {
  const step = timeframe === 'M5' ? 300 : 60;
  return directions.map((direction, index) => candle(start + index * step, direction, timeframe));
}

function progressiveCalls(timeframe = 'M1', start = M1_START) {
  return [0, 1, 2].map((index) => {
    const open = 1 + index * 0.2;
    const close = open + 0.1;
    return rawCandle(start + index * (timeframe === 'M5' ? 300 : 60), open, close + 0.05, open - 0.05, close);
  });
}

function paHistory(timeframe = 'M5', count = 20) {
  const step = timeframe === 'M5' ? 300 : 60;
  return Array.from({ length: count }, (_, index) =>
    rawCandle(M1_START + index * step, 1.04, 1.1, 1, 1.06));
}

function makeFixture(id) {
  switch (id) {
    case 'mhi-1-minority-5m': return { candles: sequence(['CALL', 'CALL', 'PUT']), index: 2 };
    case 'mhi-2-four-candle-minority': return { candles: sequence(['CALL', 'CALL', 'PUT', 'CALL']), index: 3 };
    case 'mhi-3-moving-minority': return { candles: sequence(['PUT', 'PUT', 'CALL']), index: 2 };
    case 'mhi-majority-5m': return { candles: sequence(['PUT', 'CALL', 'PUT']), index: 2 };
    case 'torres-gemeas': return { candles: sequence(['CALL', 'CALL']), index: 1 };
    case 'five-flip': return { candles: sequence(Array(5).fill('CALL')), index: 4 };
    case 'seven-flip': return { candles: sequence(Array(7).fill('PUT')), index: 6 };
    case 'tres-vizinhos': return { candles: sequence(Array(3).fill('CALL')), index: 2 };
    case 'milhao-six-majority': return { candles: sequence(['CALL', 'CALL', 'CALL', 'CALL', 'PUT', 'PUT']), index: 5 };
    case 'triplicacao': return { candles: sequence(Array(3).fill('PUT')), index: 2 };
    case 'nao-triplicacao': return { candles: sequence(['CALL', 'CALL']), index: 1 };
    case 'intercalacao': return { candles: sequence(['CALL', 'PUT', 'CALL', 'PUT']), index: 3 };
    case 'r7': return { candles: sequence(['CALL', 'CALL', 'PUT', 'CALL', 'CALL', 'PUT', 'CALL']), index: 6 };
    case 'padrao-23': return { candles: sequence(['CALL', 'PUT', 'PUT']), index: 2 };
    case 'padrao-3x1': return { candles: sequence(['CALL', 'CALL', 'CALL', 'PUT']), index: 3 };
    case 'padrao-impar': return { candles: sequence(['PUT', 'CALL', 'PUT', 'CALL', 'PUT']), index: 4 };
    case 'quinto-elemento': return { candles: sequence(['CALL', 'CALL', 'PUT', 'CALL', 'CALL']), index: 4 };
    case 'tres-mosqueteiros':
    case 'tres-irmaos': return { candles: progressiveCalls(), index: 2 };
    case 'twin-candle': return { candles: sequence(['CALL', 'PUT']), index: 1 };
    case 'mirror': return { candles: sequence(['CALL', 'PUT', 'CALL', 'CALL', 'PUT', 'CALL']), index: 5 };
    case 'wolf': return {
      candles: [0, 1, 2].map((offset) => {
        const open = 1 + offset * 0.1;
        return rawCandle(M1_START + offset * 60, open, open + 0.08, open - 0.02, open + 0.05);
      }),
      index: 2,
    };
    case 'garra': return { candles: sequence(['CALL', 'PUT', 'CALL']), index: 2 };
    case 'tres-pares': return { candles: sequence(Array(6).fill('CALL')), index: 5 };
    case 'engolfo-alta': return {
      candles: [
        rawCandle(M1_START, 1.1, 1.11, 0.99, 1),
        rawCandle(M1_START + 300, 0.99, 1.13, 0.98, 1.12),
      ],
      index: 1,
    };
    case 'engolfo-baixa': return {
      candles: [
        rawCandle(M1_START, 1, 1.11, 0.99, 1.1),
        rawCandle(M1_START + 300, 1.12, 1.13, 0.98, 0.99),
      ],
      index: 1,
    };
    case 'martelo-suporte':
    case 'rejeicao-suporte': return {
      candles: [...paHistory(), rawCandle(M1_START + 6000, 1.05, 1.065, 1.0005, 1.06)],
      index: 20,
    };
    case 'estrela-cadente-resistencia':
    case 'rejeicao-resistencia': return {
      candles: [...paHistory(), rawCandle(M1_START + 6000, 1.05, 1.0995, 1.035, 1.04)],
      index: 20,
    };
    case 'pullback-tendencia': {
      const candles = Array.from({ length: 28 }, (_, index) => {
        const close = 1 + index * 0.01;
        return rawCandle(M1_START + index * 300, close - 0.005, close + 0.02, close - 0.02, close);
      });
      candles.push(
        rawCandle(M1_START + 28 * 300, 1.27, 1.275, 1.22, 1.24),
        rawCandle(M1_START + 29 * 300, 1.24, 1.3, 1.23, 1.29),
      );
      return { candles, index: 29 };
    }
    case 'rompimento-resistencia':
    case 'rompimento-suporte': {
      const candles = paHistory();
      candles.push(id === 'rompimento-resistencia'
        ? rawCandle(M1_START + 6000, 1.08, 1.13, 1.07, 1.12)
        : rawCandle(M1_START + 6000, 1.02, 1.03, 0.87, 0.88));
      return { candles, index: 20 };
    }
    case 'breakout-reteste': {
      const candles = paHistory();
      candles.push(
        rawCandle(M1_START + 6000, 1.08, 1.13, 1.07, 1.12),
        rawCandle(M1_START + 6300, 1.11, 1.12, 1.099, 1.105),
      );
      return { candles, index: 21 };
    }
    default: throw new Error(`Fixture ausente: ${id}`);
  }
}

function evaluateFixture(strategy, fixture) {
  return evaluateStrategy(fixture.candles, fixture.index, strategy.evaluator, {
    timeframe: strategy.timeframe,
    pricePrecision: 3,
    minimumTick: 0.01,
  });
}

test('catalog mirrors the 34 prompt entries and exposes only tested, approved rules to the scanner', () => {
  assert.equal(STRATEGIES.length, 34);
  assert.deepEqual(STRATEGIES.map((strategy) => strategy.id), [
    'mhi-1-minority-5m', 'mhi-2-four-candle-minority', 'mhi-3-moving-minority',
    'mhi-majority-5m', 'torres-gemeas', 'five-flip', 'seven-flip', 'tres-vizinhos',
    'milhao-six-majority', 'triplicacao', 'nao-triplicacao', 'intercalacao',
    'r7', 'padrao-23', 'padrao-3x1', 'padrao-impar', 'quinto-elemento',
    'tres-mosqueteiros', 'twin-candle', 'mirror', 'wolf', 'garra', 'tres-irmaos',
    'tres-pares', 'engolfo-alta', 'engolfo-baixa', 'martelo-suporte',
    'estrela-cadente-resistencia', 'pullback-tendencia', 'rompimento-resistencia',
    'rompimento-suporte', 'breakout-reteste', 'rejeicao-suporte', 'rejeicao-resistencia',
  ]);
  assert.equal(STRATEGIES.filter((strategy) => strategy.status === STATUS.VALIDATION_PENDING).length, 3);
  assert.equal(STRATEGIES.filter((strategy) => strategy.status === STATUS.IMPLEMENTED).length, 31);
  assert.deepEqual(IMPLEMENTED_STRATEGIES.map((strategy) => strategy.id),
    STRATEGIES.filter((strategy) => strategy.status === STATUS.IMPLEMENTED).map((strategy) => strategy.id));
  assert.ok(STRATEGIES.every((strategy) => Object.values(STATUS).includes(strategy.status)));
  assert.ok(STRATEGIES.every(hasOperationalRule));

  const unapproved = { ...STRATEGIES[0], validation: { approved: false } };
  const incomplete = { ...STRATEGIES[0], rules: { ...STRATEGIES[0].rules, entry: null } };
  assert.equal(isStrategyBacktestEnabled(unapproved), false);
  assert.equal(hasOperationalRule(incomplete), false);
  assert.deepEqual(detectSignals([candle(0, 'CALL'), candle(60, 'CALL'), candle(120, 'PUT')], unapproved), []);
});

test('every catalog rule produces its documented valid direction and a standard evaluator result', () => {
  for (const strategy of STRATEGIES) {
    const fixture = makeFixture(strategy.id);
    const evaluation = evaluateFixture(strategy, fixture);
    assert.equal(evaluation.signal, true, `${strategy.id}: ${evaluation.cancellation_reason}`);
    assert.equal(typeof evaluation.direction, 'string', strategy.id);
    assert.equal(evaluation.strategy_id, strategy.id, strategy.id);
    assert.equal(evaluation.cancellation_reason, null, strategy.id);
    assert.ok(Array.isArray(evaluation.reference_candles), strategy.id);
    assert.ok(evaluation.entry_time, strategy.id);
    assert.ok(evaluation.expiration_time, strategy.id);
  }
});

test('all strategies reject a doji at the signal candle', () => {
  for (const strategy of STRATEGIES) {
    const fixture = makeFixture(strategy.id);
    const signalCandle = fixture.candles[fixture.index];
    signalCandle.close = signalCandle.open;
    const evaluation = evaluateFixture(strategy, fixture);
    assert.equal(evaluation.signal, false, strategy.id);
    assert.equal(evaluation.cancellation_reason, 'DOJI_SIGNAL_CANDLE', strategy.id);
  }
});

test('MHI 1 respects the example, fixed UTC cycle, and next-candle entry/expiry', () => {
  const strategy = STRATEGIES.find((item) => item.id === 'mhi-1-minority-5m');
  const candles = [
    candle(0, 'CALL'), candle(60, 'CALL'), candle(120, 'PUT'),
    rawCandle(180, 1.05, 1.06, 1.03, 1.04),
  ];
  const signal = evaluateMhi1MinorityBlock5m(candles, 2, { pricePrecision: 3 });
  const trade = runBacktest(candles, strategy, { payout: 85, pricePrecision: 3 })[0];
  assert.equal(signal.direction, 'PUT');
  assert.equal(signal.variant, 'minority_block_5m');
  assert.equal(signal.signal_time, '1970-01-01T00:03:00.000Z');
  assert.equal(signal.entry_time, '1970-01-01T00:03:00.000Z');
  assert.equal(signal.entry_price, 1.05);
  assert.equal(signal.expiration_time, '1970-01-01T00:04:00.000Z');
  assert.equal(trade.result, 'WIN');
  assert.equal(trade.entry, 1.05);
  assert.equal(trade.exit, 1.04);
});

test('MHI 1 cancels dojis, gaps, and misaligned cycles without using later candles for direction', () => {
  const base = [candle(0, 'CALL'), candle(60, 'CALL'), candle(120, 'PUT'), candle(180, 'PUT')];
  const later = [...base];
  later[3] = candle(180, 'CALL');
  assert.equal(evaluateMhi1MinorityBlock5m(base, 2).direction, 'PUT');
  assert.equal(evaluateMhi1MinorityBlock5m(later, 2).direction, 'PUT');

  const doji = [...base];
  doji[1] = candle(60, 'DOJI');
  const gap = [...base];
  gap[1] = candle(90, 'CALL');
  const misaligned = [candle(60, 'CALL'), candle(120, 'CALL'), candle(180, 'PUT')];
  assert.equal(evaluateMhi1MinorityBlock5m(doji, 2).signal, false);
  assert.equal(evaluateMhi1MinorityBlock5m(gap, 2).signal, false);
  assert.equal(evaluateMhi1MinorityBlock5m(misaligned, 2).signal, false);
});

test('every evaluator cancels a gap before entry, and backtest entries use the next candle open', () => {
  const mhi = STRATEGIES.find((strategy) => strategy.id === 'mhi-1-minority-5m');
  const gapCandles = [
    candle(0, 'CALL'), candle(60, 'CALL'), candle(120, 'PUT'),
    candle(181, 'PUT'),
  ];
  const gapEvaluation = evaluateMhi1MinorityBlock5m(gapCandles, 2);
  assert.equal(gapEvaluation.signal, false);
  assert.equal(gapEvaluation.cancellation_reason, 'MISSING_ENTRY_CANDLE');
  assert.deepEqual(runBacktest(gapCandles, mhi), []);

  const bullishEngulf = STRATEGIES.find((strategy) => strategy.id === 'engolfo-alta');
  const fixture = makeFixture(bullishEngulf.id);
  const entry = rawCandle(M1_START + 600, 0.99, 1.13, 0.98, 1.12);
  const trades = runBacktest([...fixture.candles, entry], bullishEngulf, { payout: 85 });
  assert.equal(trades.length, 1);
  assert.equal(trades[0].entry, entry.open);
  assert.equal(trades[0].exit, entry.close);
  assert.equal(trades[0].expiration_time, new Date((entry.time + 300) * 1000).toISOString());
});

test('price breakouts require a real tick size and stay disabled until IQ supplies it', () => {
  for (const id of ['rompimento-resistencia', 'rompimento-suporte', 'breakout-reteste']) {
    const strategy = STRATEGIES.find((item) => item.id === id);
    assert.equal(strategy.status, STATUS.VALIDATION_PENDING);
    const fixture = makeFixture(id);
    const withoutTick = evaluateStrategy(fixture.candles, fixture.index, strategy.evaluator, { timeframe: strategy.timeframe });
    assert.equal(withoutTick.signal, false);
    assert.equal(withoutTick.cancellation_reason, 'TICK_SIZE_UNAVAILABLE');
    assert.equal(isStrategyBacktestEnabled(strategy), false);
  }
});

test('completed operations alone are included in backtest statistics; the default has no gale', () => {
  const strategy = STRATEGIES.find((item) => item.id === 'mhi-1-minority-5m');
  const candles = [
    candle(0, 'CALL'), candle(60, 'CALL'), candle(120, 'PUT'),
    rawCandle(180, 1.05, 1.06, 1.03, 1.04),
    candle(240, 'CALL'), candle(300, 'CALL'), candle(360, 'PUT'),
  ];
  const trades = runBacktest(candles, strategy, { payout: 85 });
  const stats = computeStats(trades, 85);
  assert.equal(trades.length, 1);
  assert.equal(trades[0].level, 0);
  assert.equal(stats.wins + stats.losses + stats.dojis, stats.n);
});

test('final losses keep the correct entry candle with Gale disabled or enabled', () => {
  const strategy = STRATEGIES.find((item) => item.id === 'mhi-1-minority-5m');
  const candles = [
    candle(0, 'CALL'), candle(60, 'CALL'), candle(120, 'PUT'),
    rawCandle(180, 1.05, 1.12, 1.04, 1.1),
    rawCandle(240, 1.1, 1.15, 1.09, 1.14),
  ];

  const [withoutGale] = runBacktest(candles, strategy, { gale: 0, payout: 85 });
  assert.equal(withoutGale.result, 'LOSS');
  assert.equal(withoutGale.level, 0);
  assert.equal(withoutGale.entryIndex, 3);
  assert.equal(withoutGale.entry, candles[3].open);

  const [withGale] = runBacktest(candles, strategy, { gale: 1, payout: 85 });
  assert.equal(withGale.result, 'LOSS');
  assert.equal(withGale.level, 1);
  assert.equal(withGale.entryIndex, 4);
  assert.equal(withGale.entry, candles[4].open);
});

test('pending, unapproved, or incomplete catalog entries never enter the backtest', () => {
  const strategy = STRATEGIES.find((item) => item.status === STATUS.VALIDATION_PENDING);
  const fixture = makeFixture(strategy.id);
  assert.deepEqual(detectSignals(fixture.candles, strategy, { minimumTick: 0.01 }), []);
  const rulePending = { ...strategy, status: STATUS.RULE_PENDING };
  assert.deepEqual(detectSignals(fixture.candles, rulePending), []);
});

test('malformed candle rows fail with an indexed data error instead of reading time from undefined', () => {
  const candles = [candle(0, 'CALL'), undefined, candle(120, 'PUT')];
  assert.throws(
    () => getContext(candles),
    { name: 'TypeError', message: /Candle inválido na posição 1/ },
  );
});
