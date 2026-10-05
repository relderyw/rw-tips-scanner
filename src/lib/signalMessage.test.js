import test from 'node:test';
import assert from 'node:assert/strict';
import { formatSignalMessage, formatSignalMessagePlain, isRecentSignal, getSignalClockTime } from './signalMessage.js';

test('getSignalClockTime returns correct entry time 1 minute after M1 candle close', () => {
  const time = Math.floor(new Date(2026, 9, 4, 19, 22).getTime() / 1000);
  // candle opens at 19:22, closes at 19:23 (M1), entry = 19:24
  assert.equal(getSignalClockTime(time, 'M1'), '19:24');
});

test('getSignalClockTime returns correct entry time 1 minute after M5 candle close', () => {
  const time = Math.floor(new Date(2026, 9, 4, 19, 20).getTime() / 1000);
  // candle opens at 19:20, closes at 19:25 (M5), entry = 19:26
  assert.equal(getSignalClockTime(time, 'M5'), '19:26');
});

test('formatSignalMessage includes asset IQ name (iqName priority over assetId)', () => {
  const time = Math.floor(new Date(2026, 9, 4, 19, 20).getTime() / 1000);
  const message = formatSignalMessage({
    strategy: 'Estratégia teste',
    assetId: 'XAGUSD',
    iqName: 'XAGUSD-OTC',
    direction: 'PUT',
    tf: 'M5',
    time,
  });
  // MarkdownV2 escapes the hyphen: XAGUSD\-OTC — verify the base ticker is present
  assert.ok(message.includes('XAGUSD'), `Expected XAGUSD in: ${message}`);
  assert.ok(message.includes('OTC'), `Expected OTC in: ${message}`);
  assert.match(message, /PUT/);
  assert.match(message, /19:26/);
});

test('formatSignalMessage falls back to assetId when iqName is not provided', () => {
  const time = Math.floor(new Date(2026, 9, 4, 19, 22).getTime() / 1000);
  const message = formatSignalMessage({
    strategy: 'Estratégia teste',
    assetId: 'EURUSD',
    direction: 'CALL',
    tf: 'M1',
    time,
  });
  assert.match(message, /EURUSD/);
  assert.match(message, /CALL/);
  assert.match(message, /19:24/);
});

test('formatSignalMessage includes convergence marker when convergent=true', () => {
  const time = Math.floor(new Date(2026, 9, 4, 19, 22).getTime() / 1000);
  const message = formatSignalMessage({
    strategy: 'Estratégia teste',
    assetId: 'EURUSD',
    direction: 'CALL',
    tf: 'M1',
    time,
    convergent: true,
  });
  assert.match(message, /CONVERG/i);
});

test('formatSignalMessage includes session stats when provided', () => {
  const time = Math.floor(new Date(2026, 9, 4, 19, 22).getTime() / 1000);
  const message = formatSignalMessage({
    strategy: 'Estratégia teste',
    assetId: 'EURUSD',
    direction: 'CALL',
    tf: 'M1',
    time,
    sessionStats: { greens: 5, reds: 2 },
  });
  assert.match(message, /Sessão/i);
  // 5 greens, 2 reds → 71%
  assert.match(message, /71/);
});

test('formatSignalMessagePlain returns plain text (no Markdown)', () => {
  const time = Math.floor(new Date(2026, 9, 4, 19, 22).getTime() / 1000);
  const message = formatSignalMessagePlain({
    strategy: 'Estratégia teste',
    assetId: 'EURUSD-op',
    direction: 'CALL',
    tf: 'M1',
    time,
  });
  // Plain text should not contain Markdown V2 escaping backslashes for common chars
  assert.doesNotMatch(message, /\\\./);
  assert.match(message, /EURUSD-op/);
  assert.match(message, /CALL/);
});

test('only signals at their dispatch time are eligible for automatic Telegram delivery', () => {
  const now = new Date(2026, 9, 4, 19, 23).getTime();
  const recentOpen = Math.floor(new Date(2026, 9, 4, 19, 22).getTime() / 1000);
  const staleOpen = Math.floor(new Date(2026, 9, 4, 19, 15).getTime() / 1000);
  const earlyNow = new Date(2026, 9, 4, 19, 22, 59).getTime();
  const lateNow = new Date(2026, 9, 4, 19, 23, 16).getTime();

  assert.equal(isRecentSignal(recentOpen, 'M1', now), true);
  assert.equal(isRecentSignal(staleOpen, 'M1', now), false);
  assert.equal(isRecentSignal(recentOpen, 'M1', earlyNow), false);
  assert.equal(isRecentSignal(recentOpen, 'M1', lateNow), false);
});
