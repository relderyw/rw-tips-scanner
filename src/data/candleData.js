// Camada abstrata de dados de candles.
// Hoje: ponte Python (se VITE_BRIDGE_URL estiver definida) com fallback para candles simulados determinísticos.
// O resto do app só usa getCandles / getPayout / refreshPayouts / refreshHealth.
//
// Além do REST, o candleData também escuta o WebSocket `liveFeed`:
//   • quando chega msg.type==='health' → aplica imediatamente no store global
//     (assim temos atualizações a cada ~5 s sem polling REST).
//   • quando o status do WS muda → refletimos no store (wsStatus, reconnectAttempts).
//   • o polling REST de health continua existindo como fallback se o WS cair.
import {
  bridgeEnabled, getIQSessionToken, fetchBridgeCandles, fetchIQBinaryActives,
  fetchBridgePayouts, fetchBridgeHealth,
} from '../services/bridgeApi.js';
import { applyHealthSnapshot, getStatus, setStatus } from '../services/dataStatus.js';
import { liveFeed, liveWsEnabled } from '../services/liveFeed.js';
import { selectTopPayoutAssets } from '../lib/assetRanking.js';

export { selectTopPayoutAssets };

export const TIMEFRAMES = [
  { id: 'M1', minutes: 1, label: 'M1' },
  { id: 'M5', minutes: 5, label: 'M5' },
  { id: 'M15', minutes: 15, label: 'M15' },
];

export const PERIODS = [
  { id: '24h', hours: 24, label: '24 horas' },
  { id: '72h', hours: 72, label: '72 horas' },
  { id: '7d', hours: 168, label: '7 dias' },
  { id: '30d', hours: 720, label: '30 dias' },
];

// vol = volatilidade por raiz-de-minuto (fração do preço); payout padrão em %
export const ASSETS = [
  { id: 'EURUSD', name: 'EUR/USD', type: 'Forex', base: 1.085, decimals: 5, vol: 0.00009, payout: 87 },
  { id: 'GBPUSD', name: 'GBP/USD', type: 'Forex', base: 1.27, decimals: 5, vol: 0.0001, payout: 85 },
  { id: 'USDJPY', name: 'USD/JPY', type: 'Forex', base: 151.2, decimals: 3, vol: 0.0001, payout: 86 },
  { id: 'AUDCAD', name: 'AUD/CAD', type: 'Forex', base: 0.905, decimals: 5, vol: 0.00008, payout: 82 },
  { id: 'EURJPY', name: 'EUR/JPY', type: 'Forex', base: 164.1, decimals: 3, vol: 0.00012, payout: 85 },
  { id: 'GBPJPY', name: 'GBP/JPY', type: 'Forex', base: 192.4, decimals: 3, vol: 0.00014, payout: 84 },
  { id: 'BTCUSD', name: 'Bitcoin', type: 'Cripto', base: 64000, decimals: 2, vol: 0.00032, payout: 80 },
  { id: 'ETHUSD', name: 'Ethereum', type: 'Cripto', base: 3200, decimals: 2, vol: 0.00038, payout: 80 },
  { id: 'US30', name: 'Dow Jones', type: 'Índice', base: 39000, decimals: 1, vol: 0.00018, payout: 82 },
  { id: 'US500', name: 'S&P 500', type: 'Índice', base: 5200, decimals: 2, vol: 0.00016, payout: 82 },
  { id: 'US100', name: 'Nasdaq 100', type: 'Índice', base: 18200, decimals: 1, vol: 0.0002, payout: 82 },
  { id: 'GER30', name: 'DAX 40', type: 'Índice', base: 18000, decimals: 1, vol: 0.00017, payout: 81 },
];

export const getAsset = (id) => ASSETS.find((a) => a.id === id);
export const getTimeframe = (id) => TIMEFRAMES.find((t) => t.id === id);

function isValidCandle(candle) {
  return candle !== null &&
    typeof candle === 'object' &&
    [candle.time, candle.open, candle.high, candle.low, candle.close].every(Number.isFinite) &&
    candle.high >= Math.max(candle.open, candle.close) &&
    candle.low <= Math.min(candle.open, candle.close) &&
    candle.high >= candle.low;
}

function normalizeCandles(candles, asset, tf) {
  if (!Array.isArray(candles)) {
    throw new TypeError(`A fonte retornou candles inválidos para ${asset} (${tf}): era esperada uma lista.`);
  }
  const valid = candles.filter(isValidCandle);
  if (valid.length !== candles.length) {
    console.warn(
      `[candleData] Ignorando ${candles.length - valid.length} candle(s) inválido(s) de ${asset} (${tf}); padrões que cruzem lacunas serão cancelados.`,
    );
  }
  return valid;
}

export function getPricePrecision(assetId) {
  const activeAsset = getStatus().activeAssets.find((asset) => asset.id === assetId);
  if (activeAsset) return activeAsset.pricePrecision;
  return getAsset(assetId)?.decimals;
}
export function getPriceTick(assetId) {
  const activeAsset = getStatus().activeAssets.find((asset) => asset.id === assetId);
  if (activeAsset) return activeAsset.priceTick;
  const precision = getAsset(assetId)?.decimals;
  return Number.isInteger(precision) ? 10 ** -precision : undefined;
}
let activeRefreshPromise = null;

function displayIQAsset(ticker) {
  const otc = /-OTC$/i.test(ticker);
  const symbol = ticker.replace(/-OTC$/i, '');
  const forexPair = symbol.match(/^([A-Z]{3})([A-Z]{3})$/);
  const name = forexPair ? `${forexPair[1]}/${forexPair[2]}` : symbol;
  return `${name}${otc ? ' (OTC)' : ''}`;
}

export function getAvailableAssets({ analysisOnly = false } = {}) {
  const status = getStatus();
  if (getIQSessionToken()) {
    if (!status.activeAssetsAt) return [];
    return analysisOnly
      ? status.activeAssets.filter((asset) => asset.analysisSupported)
      : status.activeAssets;
  }
  return ASSETS;
}

export function getTopPayoutAssets(limit = 10) {
  if (!getIQSessionToken()) return [];
  return selectTopPayoutAssets(getStatus().activeAssets, limit);
}

export async function refreshIQActives() {
  if (!bridgeEnabled || !getIQSessionToken()) {
    setStatus({ activeAssets: [], activeAssetsAt: 0 });
    return [];
  }
  if (activeRefreshPromise) return activeRefreshPromise;
  activeRefreshPromise = (async () => {
    const rows = await fetchIQBinaryActives();
    if (!Array.isArray(rows)) {
      throw new TypeError('A ponte retornou uma lista inválida de ativos IQ Option.');
    }
    const activeAssets = rows
      .filter((row) => typeof row?.asset === 'string' && row.asset.length > 0)
      .map((row) => ({
        id: row.asset,
        name: displayIQAsset(row.asset),
        type: /-OTC$/i.test(row.asset) ? 'OTC' : 'Binária',
        payout: Number.isFinite(row.payout) ? row.payout : 0,
        isOpen: row.is_open === true,
        analysisSupported: row.candles_supported === true,
        pricePrecision: Number.isInteger(row.price_precision) && row.price_precision >= 0 && row.price_precision <= 12
          ? row.price_precision
          : undefined,
        priceTick: Number.isFinite(row.price_tick) && row.price_tick > 0
          ? row.price_tick
          : undefined,
      }));
    const previousStatus = getStatus();
    const previouslyDynamic = new Set(previousStatus.activeAssets.map((asset) => asset.id));
    const staticPayouts = Object.fromEntries(
      Object.entries(previousStatus.payouts).filter(([asset]) => !previouslyDynamic.has(asset)),
    );
    setStatus({
      activeAssets,
      activeAssetsAt: Date.now(),
      payouts: {
        ...staticPayouts,
        ...Object.fromEntries(activeAssets.map((asset) => [asset.id, asset.payout])),
      },
      payoutsAt: Date.now(),
    });
    return activeAssets;
  })();
  try {
    return await activeRefreshPromise;
  } finally {
    activeRefreshPromise = null;
  }
}

// Dynamic IQ assets never use synthetic payout values.
export const getPayout = (assetId) => {
  const status = getStatus();
  const activeAsset = status.activeAssets.find((asset) => asset.id === assetId);
  return activeAsset?.payout ?? status.payouts[assetId] ?? getAsset(assetId)?.payout ?? 85;
};

const isIQBinaryAsset = (assetId) =>
  getStatus().activeAssets.some((asset) => asset.id === assetId);

/* ---------- Gerador determinístico ----------
   O retorno de cada vela depende SÓ de (ativo, timeframe, índice absoluto da vela),
   então o mesmo candle tem sempre o mesmo resultado e novas velas aparecem com o passar do tempo. */
function hash2(a, b) {
  let h = (a ^ Math.imul(b | 0, 0x9e3779b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
const strSeed = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return h >>> 0; };
const rnd = (seed, k, j) => hash2(seed + j * 7919, k);
const gauss = (seed, k, j) => Math.sqrt(-2 * Math.log(Math.max(rnd(seed, k, j), 1e-9))) * Math.cos(2 * Math.PI * rnd(seed, k, j + 1));

export function generateSimulatedCandles(assetId, tfId, hours, nowMs = Date.now()) {
  const asset = getAsset(assetId), tf = getTimeframe(tfId);
  const stepMs = tf.minutes * 60000;
  const lastClosed = Math.floor(nowMs / stepMs) - 1;
  const count = Math.round((hours * 60) / tf.minutes);
  const seed = strSeed(assetId + tfId);
  const volTf = asset.vol * Math.sqrt(tf.minutes);
  const round = (v) => Number(v.toFixed(asset.decimals));
  const candles = [];
  let prev = asset.base;
  for (let k = lastClosed - count + 1; k <= lastClosed; k++) {
    const regime = 0.6 + rnd(seed, Math.floor(k / 200), 50) * 1.0; // regimes de volatilidade
    const drift = (rnd(seed, Math.floor(k / 40), 60) - 0.5) * 0.5 * volTf; // microtendências
    const vol = volTf * regime;
    const open = prev;
    const close = round(open * Math.exp(drift + vol * gauss(seed, k, 1)));
    const high = round(Math.max(open, close) + Math.abs(gauss(seed, k, 3)) * vol * 0.45 * open);
    const low = round(Math.min(open, close) - Math.abs(gauss(seed, k, 5)) * vol * 0.45 * open);
    candles.push({ time: Math.floor((k * stepMs) / 1000), open: round(open), high, low, close });
    prev = close;
  }
  return candles;
}

// Candles reais da ponte; se ela estiver offline, usa simulados e marca o badge "dados simulados"
export async function getCandles({ asset, tf, hours }) {
  const isDynamicAsset = isIQBinaryAsset(asset);
  if (bridgeEnabled && getIQSessionToken() && getStatus().bridgeOnline !== false) {
    try {
      const candles = await fetchBridgeCandles(asset, tf, hours);
      const normalizedCandles = normalizeCandles(candles, asset, tf);
      if (normalizedCandles.length > 0) {
        setStatus({ candles: 'live', bridgeOnline: true });
        return { candles: normalizedCandles, source: 'live' };
      }
      if (isDynamicAsset) {
        throw new Error(`A IQ Option não retornou candles para ${asset}.`);
      }
    } catch (err) {
      if (isDynamicAsset) throw err;
      console.warn('[ponte] falha ao buscar candles, usando simulados:', err.message);
      setStatus({ bridgeOnline: false });
    }
  }
  if (isDynamicAsset) {
    throw new Error(`Não foi possível buscar candles reais de ${asset} na IQ Option.`);
  }
  if (!getAsset(asset)) {
    throw new RangeError(`Ativo desconhecido: ${asset}`);
  }
  if (getStatus().candles !== 'simulated') setStatus({ candles: 'simulated' });
  return { candles: generateSimulatedCandles(asset, tf, hours), source: 'simulated' };
}

export async function refreshPayouts() {
  if (!bridgeEnabled || !getIQSessionToken()) return;
  try {
    const payouts = await fetchBridgePayouts();
    setStatus({ payouts, payoutsAt: Date.now(), bridgeOnline: true });
  } catch (err) {
    setStatus({ bridgeOnline: false });
  }
}

export async function refreshHealth() {
  if (!bridgeEnabled || !getIQSessionToken()) return;
  try {
    const snap = await fetchBridgeHealth();
    applyHealthSnapshot(snap, 'rest');
  } catch (err) {
    setStatus({ health: null, bridgeOnline: false, wsStatus: getStatus().wsStatus });
  }
}

/* ---------- Listener WS para health e estado WS ---------- */
if (liveWsEnabled && typeof liveFeed.subscribe === 'function') {
  // (1) Health mensagens do WS: aplica imediatamente.
  liveFeed.subscribe((msg) => {
    try {
      if (msg && msg.type === 'health') {
        applyHealthSnapshot(msg, 'ws');
      }
    } catch (e) {
      console.warn('[candleData] applyHealthSnapshot from WS failed:', e);
    }
  });
  // (2) Status do WS para o painel (DataBadge / Dashboard usam).
  if (typeof liveFeed.onStatusChange === 'function') {
    const applyWsStatus = (st) => {
      setStatus({
        wsStatus: st.status,
        wsLastMsgAt: st.lastMessageAt,
        wsReconnectAttempts: st.reconnectAttempts,
      });
    };
    applyWsStatus(liveFeed.getStatus());
    liveFeed.onStatusChange(applyWsStatus);
  }
  // (3) Polling REST fallback (15 s quando WS está 'open', 8 s quando WS caiu
  //     para recuperar rápido).
  let fallbackInterval = setInterval(() => {
    const st = getStatus();
    const wsIsOpen = st.wsStatus === 'open';
    // Não batemos no REST a todo minuto quando WS está saudável: reduzimos 15 s.
    if (wsIsOpen) {
      // refreshHealth REST a cada ~4 intervalos (60 s) quando WS está open.
      if (Math.random() < 1 / 4) void refreshHealth();
    } else {
      void refreshHealth();
    }
  }, 15000);
  try {
    if (typeof window !== 'undefined') {
      window.addEventListener('beforeunload', () => {
        if (fallbackInterval) { clearInterval(fallbackInterval); fallbackInterval = null; }
      });
    }
  } catch (_) { /* ssr guard */ }
}

// Bootstrap inicial: payouts + health (REST) na carga, depois WS assume (se habilitado).
if (bridgeEnabled && getIQSessionToken() && typeof window !== 'undefined') {
  void refreshPayouts();
  void refreshHealth();
}
