// Indicadores técnicos usados pelos detectores. Todos retornam arrays do mesmo tamanho da entrada.

export function ema(arr, p) {
  const k = 2 / (p + 1);
  const out = new Array(arr.length);
  let prev = arr[0];
  out[0] = prev;
  for (let i = 1; i < arr.length; i++) {
    prev = arr[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

export function sma(arr, p) {
  const out = new Array(arr.length).fill(NaN);
  let s = 0;
  for (let i = 0; i < arr.length; i++) {
    s += arr[i];
    if (i >= p) s -= arr[i - p];
    if (i >= p - 1) out[i] = s / p;
  }
  return out;
}

// RSI com suavização de Wilder
export function rsi(close, p = 14) {
  const out = new Array(close.length).fill(NaN);
  let g = 0, l = 0;
  for (let i = 1; i < close.length; i++) {
    const ch = close[i] - close[i - 1];
    const gain = Math.max(ch, 0), loss = Math.max(-ch, 0);
    if (i <= p) {
      g += gain; l += loss;
      if (i === p) { g /= p; l /= p; out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l); }
    } else {
      g = (g * (p - 1) + gain) / p;
      l = (l * (p - 1) + loss) / p;
      out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
    }
  }
  return out;
}

export function bollinger(close, p = 20, dev = 2) {
  const n = close.length;
  const mid = sma(close, p);
  const upper = new Array(n).fill(NaN), lower = new Array(n).fill(NaN), width = new Array(n).fill(NaN);
  for (let i = p - 1; i < n; i++) {
    let v = 0;
    for (let j = i - p + 1; j <= i; j++) v += (close[j] - mid[i]) ** 2;
    const sd = Math.sqrt(v / p);
    upper[i] = mid[i] + dev * sd;
    lower[i] = mid[i] - dev * sd;
    width[i] = mid[i] ? (upper[i] - lower[i]) / mid[i] : NaN;
  }
  return { mid, upper, lower, width };
}

// Estocástico %K suavizado
export function stochastic(h, l, c, p = 14, smooth = 3) {
  const n = c.length;
  const raw = new Array(n).fill(NaN);
  for (let i = p - 1; i < n; i++) {
    let hh = -Infinity, ll = Infinity;
    for (let j = i - p + 1; j <= i; j++) { hh = Math.max(hh, h[j]); ll = Math.min(ll, l[j]); }
    raw[i] = hh === ll ? 50 : ((c[i] - ll) / (hh - ll)) * 100;
  }
  const out = new Array(n).fill(NaN);
  for (let i = p - 1 + smooth - 1; i < n; i++) {
    let s = 0;
    for (let j = i - smooth + 1; j <= i; j++) s += raw[j];
    out[i] = s / smooth;
  }
  return out;
}

export function macd(close, f = 12, s = 26, sig = 9) {
  const ef = ema(close, f), es = ema(close, s);
  const line = ef.map((v, i) => v - es[i]);
  return { line, signal: ema(line, sig) };
}

export function atr(h, l, c, p = 14) {
  const tr = h.map((hi, i) => (i === 0 ? hi - l[i] : Math.max(hi - l[i], Math.abs(hi - c[i - 1]), Math.abs(l[i] - c[i - 1]))));
  return ema(tr, p);
}

// Maior máxima / menor mínima das p velas ANTERIORES (exclui a vela atual)
export function highest(h, p) {
  const out = new Array(h.length).fill(NaN);
  for (let i = p; i < h.length; i++) { let m = -Infinity; for (let j = i - p; j < i; j++) m = Math.max(m, h[j]); out[i] = m; }
  return out;
}
export function lowest(l, p) {
  const out = new Array(l.length).fill(NaN);
  for (let i = p; i < l.length; i++) { let m = Infinity; for (let j = i - p; j < i; j++) m = Math.min(m, l[j]); out[i] = m; }
  return out;
}
export function rollingMin(arr, p) {
  const out = new Array(arr.length).fill(NaN);
  for (let i = p - 1; i < arr.length; i++) { let m = Infinity; for (let j = i - p + 1; j <= i; j++) m = Math.min(m, arr[j]); out[i] = m; }
  return out;
}
