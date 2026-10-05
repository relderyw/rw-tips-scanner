// Estatística e formatadores (pt-BR). payout sempre em PERCENTUAL (ex.: 85).

// Break-even (%) = 100 / (1 + payout)
export const breakEven = (payoutPct) => 100 / (1 + payoutPct / 100);

// Expectância por unidade apostada (sem Gale)
export const expectancy = (winRatePct, payoutPct) => {
  const w = winRatePct / 100, p = payoutPct / 100;
  return w * p - (1 - w);
};

// Intervalo de confiança de Wilson (95%)
export function wilson(wins, n, z = 1.96) {
  if (!n) return { low: 0, high: 0 };
  const p = wins / n, d = 1 + (z * z) / n, c = p + (z * z) / (2 * n);
  const m = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * n)) / n);
  return { low: (100 * (c - m)) / d, high: (100 * (c + m)) / d };
}

// Nível de confiança da amostra
export function sampleConfidence(n) {
  if (n < 30) return { level: 'PEQUENA', tone: 'loss' };
  if (n < 100) return { level: 'MODERADA', tone: 'warn' };
  return { level: 'GRANDE', tone: 'neon' };
}

const nf = (d) => new Intl.NumberFormat('pt-BR', { minimumFractionDigits: d, maximumFractionDigits: d });
export const fmtPct = (v, d = 1) => (v == null || !isFinite(v) ? '—' : nf(d).format(v) + '%');
export const fmtNum = (v, d = 0) => (v == null || !isFinite(v) ? '—' : nf(d).format(v));
export const fmtUnits = (v, d = 2) => (v == null || !isFinite(v) ? '—' : (v > 0 ? '+' : '') + nf(d).format(v) + ' u');
export const fmtPrice = (v) => (v == null ? '—' : v >= 100 ? nf(2).format(v) : nf(5).format(v));
export const fmtDateTime = (sec) =>
  new Date(sec * 1000).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
