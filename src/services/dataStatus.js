// Pequeno store global (sem libs) com o estado da fonte de dados: simulado/real, payouts, health da ponte e do WS.
import { useSyncExternalStore } from 'react';

let state = {
  // Fonte usada pela última fetch de candles. Valores: 'unknown' | 'live' | 'simulated' | 'cache'.
  candles: 'unknown',
  payouts: {},
  payoutsAt: 0,
  activeAssets: [],
  activeAssetsAt: 0,

  // Health RAW vindo do REST /health (schema completo do endpoint estendido).
  health: null,

  // Campos derivados/úteis do health (precomputados para UI não refazer):
  bridgeOnline: null,        // null/false/true (conseguiu alcançar a ponte)
  iqConnected: false,        // health.connected (ponte ↔ IQ Option)
  latencyMs: null,           // health.latency_ms (último candle)
  counts: { ok: 0, stale: 0, market_closed: 0, missing: 0 },
  subscriptionsActive: 0,
  subscriptionsExpected: 0,
  staleList: [],             // [{asset,tf,lagSeconds}]

  // Estado específico do WebSocket do browser ↔ ponte.
  wsStatus: 'unknown',       // disabled | connecting | authenticating | open | closed | unknown
  wsLastMsgAt: 0,            // Date.now()
  wsReconnectAttempts: 0,
};
const subs = new Set();

export const getStatus = () => state;
export function setStatus(patch) {
  state = { ...state, ...patch };
  subs.forEach((fn) => fn());
}
const subscribe = (fn) => { subs.add(fn); return () => subs.delete(fn); };
export const useDataStatus = () => useSyncExternalStore(subscribe, getStatus);

/**
 * Aplica um `health` vindo ou do REST `/health` ou da mensagem WS `type:health`.
 * Normaliza os campos derivados e atomiza o patch no `setStatus`.
 * Chamado por candleData.js.
 */
export function applyHealthSnapshot(snapshot, fromSource = 'rest') {
  if (!snapshot || typeof snapshot !== 'object') return;
  const counts = { ok: 0, stale: 0, market_closed: 0, missing: 0 };
  const staleList = [];
  // Por padrão, o `/health` estendido expõe por ativo uma map tf → status+lag.
  // Fallback robusto: se não vier `per_asset_tf`, usamos zeros.
  const perAsset = snapshot.per_asset_tf || snapshot.perTf || {};
  const ASSETS_IDS = [
    'EURUSD','GBPUSD','USDJPY','AUDCAD','EURJPY','GBPJPY',
    'BTCUSD','ETHUSD','US30','US500','US100','GER30',
  ];
  const TFS = ['M1','M5','M15'];
  // Counts usam o campo top-level por conveniência, se existirem.
  counts.ok = typeof snapshot.count_ok === 'number'
    ? snapshot.count_ok
    : Object.values(perAsset).reduce((n, values) => n + Object.values(values || {}).filter((v) => v?.status === 'ok').length, 0);
  counts.stale = typeof snapshot.count_stale === 'number'
    ? snapshot.count_stale
    : Object.values(perAsset).reduce((n, values) => n + Object.values(values || {}).filter((v) => v?.status === 'stale').length, 0);
  counts.market_closed = typeof snapshot.count_market_closed === 'number'
    ? snapshot.count_market_closed
    : Object.values(perAsset).reduce((n, values) => n + Object.values(values || {}).filter((v) => v?.status === 'market_closed').length, 0);
  const expectedStreams = typeof snapshot.subscriptions_expected === 'number'
    ? snapshot.subscriptions_expected
    : ASSETS_IDS.length * TFS.length;
  counts.missing = Math.max(0, expectedStreams - (counts.ok + counts.stale + counts.market_closed));
  // Lista stale (preenche a partir de per_asset_tf).
  if (perAsset && typeof perAsset === 'object') {
    for (const asset of Object.keys(perAsset)) {
      const tfMap = perAsset[asset] || {};
      for (const tf of Object.keys(tfMap)) {
        const s = tfMap[tf] || {};
        if (s.status === 'stale') {
          staleList.push({ asset, tf, lagSeconds: s.lag_seconds ?? s.lagSeconds ?? null });
        }
      }
    }
  }
  setStatus({
    health: snapshot,
    bridgeOnline: true,
    iqConnected: Boolean(snapshot.connected),
    latencyMs: typeof snapshot.latency_ms === 'number' ? snapshot.latency_ms : null,
    counts,
    subscriptionsActive: typeof snapshot.subscriptions_active === 'number' ? snapshot.subscriptions_active : 0,
    subscriptionsExpected: typeof snapshot.subscriptions_expected === 'number' ? snapshot.subscriptions_expected : 0,
    staleList: staleList.sort((a, b) => (b.lagSeconds || 0) - (a.lagSeconds || 0)),
  });
  return true;
}
