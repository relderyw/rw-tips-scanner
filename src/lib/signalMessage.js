/**
 * signalMessage.js
 * Formata mensagens de sinal para o Telegram e calcula horários de entrada.
 *
 * Usa MarkdownV2 do Telegram para mensagem moderna e elegante.
 */

const TIMEFRAME_SECONDS = { M1: 60, M5: 300 };
const SIGNAL_LEAD_SECONDS = 60;

/**
 * Retorna o horário de entrada do sinal no formato HH:MM.
 * O sinal é emitido 1 minuto antes do fechamento da vela de entrada.
 */
export function getSignalClockTime(time, tf) {
  const timeframeSeconds = TIMEFRAME_SECONDS[tf];
  if (!timeframeSeconds) throw new RangeError(`Timeframe inválido para sinal: ${tf}`);
  if (!Number.isFinite(time)) throw new TypeError('Horário do sinal inválido.');
  const entryTime = new Date((time + timeframeSeconds + SIGNAL_LEAD_SECONDS) * 1000);
  return `${String(entryTime.getHours()).padStart(2, '0')}:${String(entryTime.getMinutes()).padStart(2, '0')}`;
}

/**
 * Escapa caracteres especiais do MarkdownV2 do Telegram.
 */
function escapeMd(text) {
  return String(text).replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, '\\$&');
}

/**
 * Formata a mensagem do sinal para o Telegram (MarkdownV2).
 * Usa `iqName` como nome real do ativo (ex: BTCUSD-OTC, EURUSD-op).
 *
 * Parâmetros:
 *   strategy   - nome da estratégia
 *   assetId    - id interno do painel (ex: BTCUSD)
 *   iqName     - nome real na IQ Option (ex: BTCUSD-OTC) — exibido na mensagem
 *   direction  - 'CALL' ou 'PUT'
 *   tf         - 'M1' ou 'M5'
 *   time       - unix timestamp da vela de sinal
 *   winRate    - assertividade histórica (0..1)
 *   totalTrades - total de operações no histórico
 *   convergent  - true se sinal convergiu em M1 e M5
 *   sessionStats - { greens, reds } acumulado da sessão (opcional)
 */
export function formatSignalMessage({
  strategy,
  assetId,
  iqName,
  direction,
  tf,
  time,
  winRate,
  totalTrades,
  convergent = false,
  sessionStats = null,
}) {
  if (direction !== 'CALL' && direction !== 'PUT') {
    throw new RangeError(`Direção inválida para sinal: ${direction}`);
  }

  // Usa iqName se disponível, caso contrário usa assetId
  const displayAsset = String(iqName || assetId || '').trim();
  if (!displayAsset) throw new TypeError('Ativo do sinal inválido.');

  const arrow = direction === 'CALL' ? '📈' : '📉';
  const dirLabel = direction === 'CALL' ? 'COMPRA \\(CALL\\)' : 'VENDA \\(PUT\\)';
  const tfLabel = tf === 'M1' ? '1 minuto' : '5 minutos';
  const entryTime = getSignalClockTime(time, tf);
  const winRateFormatted = winRate != null ? `${Math.round(winRate * 100)}%` : null;
  const convergentTag = convergent ? '\n🔗 *CONVERGÊNCIA M1\\+M5* \\— sinal confirmado nos dois timeframes' : '';

  let statsLine = '';
  if (winRateFormatted && totalTrades) {
    statsLine = `\n📊 Assertividade: *${escapeMd(winRateFormatted)}* em ${escapeMd(String(totalTrades))} ops`;
  }

  let sessionLine = '';
  if (sessionStats && (sessionStats.greens > 0 || sessionStats.reds > 0)) {
    const total = sessionStats.greens + sessionStats.reds;
    const pct = total > 0 ? Math.round((sessionStats.greens / total) * 100) : 0;
    sessionLine = `\n\n🏆 *Sessão hoje:* 🟢 ${sessionStats.greens} green · 🔴 ${sessionStats.reds} red \\(${escapeMd(String(pct))}%\\)`;
  }

  return [
    `${convergent ? '🚀' : '🎯'} *SINAL CONFIRMADO*${convergentTag}`,
    '',
    `⚡ *Estratégia:* ${escapeMd(strategy)}`,
    `💹 *Ativo:* \`${escapeMd(displayAsset)}\``,
    `${arrow} *Direção:* ${dirLabel}`,
    `⏱ *Timeframe:* ${escapeMd(tfLabel)}`,
    `🕐 *Entrada em:* *${escapeMd(entryTime)}*`,
    statsLine,
    sessionLine,
    '',
    '━━━━━━━━━━━━━━━━',
    '_Operações com ativos digitais envolvem risco\\. Opere com responsabilidade\\._',
  ].filter((line) => line !== null && line !== undefined).join('\n');
}

/**
 * Versão de texto simples para clipboard (sem Markdown).
 */
export function formatSignalMessagePlain({
  strategy,
  assetId,
  iqName,
  direction,
  tf,
  time,
  winRate,
  totalTrades,
  convergent = false,
  sessionStats = null,
}) {
  if (direction !== 'CALL' && direction !== 'PUT') {
    throw new RangeError(`Direção inválida para sinal: ${direction}`);
  }
  const displayAsset = String(iqName || assetId || '').trim();
  if (!displayAsset) throw new TypeError('Ativo do sinal inválido.');
  const arrow = direction === 'CALL' ? '📈' : '📉';
  const tfLabel = tf === 'M1' ? '1 minuto' : '5 minutos';
  const entryTime = getSignalClockTime(time, tf);
  const winRateFormatted = winRate != null ? `${Math.round(winRate * 100)}%` : null;

  const lines = [
    convergent ? '🚀 SINAL CONVERGENTE (M1+M5)' : '🎯 Sinal confirmado',
    '',
    `⚡ Estratégia: ${strategy}`,
    `💹 Ativo: ${displayAsset}`,
    `${arrow} ${direction}`,
    `⏱ Timeframe: ${tfLabel}`,
    `🕐 Entrada: ${entryTime}`,
  ];
  if (winRateFormatted && totalTrades) {
    lines.push(`📊 Assertividade: ${winRateFormatted} (${totalTrades} ops)`);
  }
  if (sessionStats && (sessionStats.greens > 0 || sessionStats.reds > 0)) {
    const total = sessionStats.greens + sessionStats.reds;
    const pct = total > 0 ? Math.round((sessionStats.greens / total) * 100) : 0;
    lines.push(`🏆 Sessão: 🟢 ${sessionStats.greens} green · 🔴 ${sessionStats.reds} red (${pct}%)`);
  }

  return lines.join('\n');
}

export function isRecentSignal(time, tf, nowMs = Date.now()) {
  const timeframeSeconds = TIMEFRAME_SECONDS[tf];
  if (!timeframeSeconds || !Number.isFinite(time)) return false;
  const dispatchAtMs = (time + timeframeSeconds) * 1000;
  return dispatchAtMs <= nowMs && nowMs - dispatchAtMs <= 15_000;
}
