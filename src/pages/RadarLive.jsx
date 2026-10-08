import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Check, Clipboard, RefreshCw, TrendingUp, TrendingDown, Zap, Send, ShieldAlert, Clock, AlertTriangle } from 'lucide-react';
import {
  getPricePrecision, getPriceTick, getTopPayoutAssets, refreshIQActives,
} from '../data/candleData.js';
import { appendLiveCandle, invalidateCache } from '../lib/runner.js';
import { runBacktest } from '../lib/backtestEngine.js';
import {
  getApprovedSignals, invalidatePairValidation, validatePair, VALIDATION_REFRESH_MS, VALIDATION_TIMEFRAMES,
} from '../lib/strategyValidation.js';
import {
  fetchTelegramStatus, fetchTelegramStats, getIQSessionToken, sendTelegramSignal, updateTelegramSignalResult,
} from '../services/bridgeApi.js';
import { useDataStatus } from '../services/dataStatus.js';
import { liveFeed, liveWsEnabled } from '../services/liveFeed.js';
import { fmtPct, fmtDateTime } from '../lib/stats.js';
import { formatSignalMessage, formatSignalMessagePlain, getSignalClockTime, isRecentSignal } from '../lib/signalMessage.js';
import { isActiveSession, getNextSessionOpen, detectCorrelatedSignals } from '../lib/marketSession.js';
import { PageHeader, Loading, EmptyState, DirectionBadge, DataBadge, Badge, signClass } from '../components/ui.jsx';

const LOOKBACK = 3;
const HIGHLIGHT_MS = 3000;
const RADAR_ASSET_LIMIT = 10;

/**
 * Varredura em AMBOS os timeframes para um ativo.
 * Regra de estabilidade para traders profissionais:
 * 1. Prioriza convergência real (M1 + M5). Se houver, seleciona a estratégia CAMPEÃ do ativo.
 * 2. Se não houver convergência, seleciona apenas a MELHOR estratégia isolada do ativo.
 * Isso impede definitivamente que um par flutue em 3, 4 ou 5 estratégias simultaneamente.
 */
async function scanAssetBothTfs(asset, onPairValidated) {
  const pairsByTf = {};
  const signalsByTf = {};

  for (const tf of VALIDATION_TIMEFRAMES) {
    try {
      const pair = await validatePair(asset.id, tf);
      await onPairValidated?.(asset.id, tf, pair.candles);
      pairsByTf[tf] = pair;
      signalsByTf[tf] = getApprovedSignals(pair, LOOKBACK).map((signal) => ({
        ...signal,
        tf,
        pair,
      }));
    } catch (error) {
      console.warn(`[RadarLive] falha ao analisar ${asset.id}/${tf}:`, error);
      pairsByTf[tf] = null;
      signalsByTf[tf] = [];
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  // Agrupa sinais por estratégia para detectar convergência
  const strategiesM1 = new Map(
    (signalsByTf['M1'] || []).map((s) => [s.strategy.id, s]),
  );
  const strategiesM5 = new Map(
    (signalsByTf['M5'] || []).map((s) => [s.strategy.id, s]),
  );

  const convergentList = [];
  const processedStrategies = new Set();

  // Convergentes: mesma estratégia sinalizada em M1 e M5 com mesma direção
  for (const [stratId, m1Signal] of strategiesM1) {
    const m5Signal = strategiesM5.get(stratId);
    if (m5Signal && m1Signal.direction === m5Signal.direction) {
      // Usa o TF com maior assertividade
      const bestSignal = (m1Signal.stats?.winRate ?? 0) >= (m5Signal.stats?.winRate ?? 0) ? m1Signal : m5Signal;
      convergentList.push({
        ...bestSignal,
        convergent: true,
        m1Signal,
        m5Signal,
        statsM1: m1Signal.stats,
        statsM5: m5Signal.stats,
      });
      processedStrategies.add(stratId);
    }
  }

  // SE HOUVER SINAIS CONVERGENTES:
  // Retorna APENAS o sinal campeão deste ativo (maior edge / win rate).
  // Elimina ruído de múltiplas estratégias disputando a mesma paridade.
  if (convergentList.length > 0) {
    convergentList.sort((a, b) => {
      const edgeA = (a.stats?.winRate ?? 0) - (a.stats?.breakEven ?? 50);
      const edgeB = (b.stats?.winRate ?? 0) - (b.stats?.breakEven ?? 50);
      return (edgeB - edgeA) || ((b.stats?.winRate ?? 0) - (a.stats?.winRate ?? 0));
    });
    return [convergentList[0]];
  }

  // SE NÃO HOUVER CONVERGÊNCIA:
  // Seleciona no máximo A MELHOR estratégia isolada para o ativo.
  const allIsolated = [];
  for (const [stratId, signal] of strategiesM1) {
    if (!processedStrategies.has(stratId)) allIsolated.push({ ...signal, convergent: false });
  }
  for (const [stratId, signal] of strategiesM5) {
    if (!processedStrategies.has(stratId)) allIsolated.push({ ...signal, convergent: false });
  }

  if (allIsolated.length > 0) {
    allIsolated.sort((a, b) => {
      const edgeA = (a.stats?.winRate ?? 0) - (a.stats?.breakEven ?? 50);
      const edgeB = (b.stats?.winRate ?? 0) - (b.stats?.breakEven ?? 50);
      return (edgeB - edgeA) || ((b.stats?.winRate ?? 0) - (a.stats?.winRate ?? 0));
    });
    return [allIsolated[0]];
  }

  return [];
}

/**
 * Varredura completa de todos os assets.
 */
async function fullScanSignals(assets, onPairValidated) {
  const out = [];
  const errors = [];
  for (const asset of assets) {
    try {
      const signals = await scanAssetBothTfs(asset, onPairValidated);
      const inSession = isActiveSession(asset.id);
      const nextOpen = getNextSessionOpen(asset.id);
      signals.forEach((signal) => {
        const tf = signal.tf;
        out.push({
          key: `${asset.id}|${signal.strategy.id}|${tf}|${signal.time}`,
          asset: asset.id,
          assetName: asset.name,
          strategy: signal.strategy,
          direction: signal.direction,
          tf,
          time: signal.time,
          ago: Math.max(0, (signal.pair?.candles?.length ?? 1) - 1 - signal.index),
          stats: signal.stats,
          statsM1: signal.statsM1 ?? null,
          statsM5: signal.statsM5 ?? null,
          convergent: signal.convergent ?? false,
          inSession,
          nextOpen,
          highlightedUntil: 0,
        });
      });
    } catch (error) {
      console.warn(`[RadarLive] falha ao analisar ${asset.id}:`, error);
      errors.push(`${asset.name}: ${error.message}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return {
    signals: out.sort((a, b) => {
      // Convergentes primeiro, depois por winRate
      if (b.convergent !== a.convergent) return b.convergent ? 1 : -1;
      return b.time - a.time || b.stats.winRate - a.stats.winRate;
    }),
    errors,
  };
}

export default function RadarLive() {
  const ds = useDataStatus();
  const topAssets = useMemo(
    () => getTopPayoutAssets(RADAR_ASSET_LIMIT),
    [ds.activeAssets, ds.activeAssetsAt],
  );
  const [tick, setTick] = useState(0);
  const [nowTick, setNowTick] = useState(0);
  const [signals, setSignals] = useState([]);
  const [scanErrors, setScanErrors] = useState([]);
  const [telegramStates, setTelegramStates] = useState({});
  const [copiedSignalKey, setCopiedSignalKey] = useState('');
  const [telegramConfigured, setTelegramConfigured] = useState(null);
  const [telegramStatusError, setTelegramStatusError] = useState('');
  const [sessionStats, setSessionStats] = useState({ greens: 0, reds: 0 });
  const [autoSendTelegram, setAutoSendTelegram] = useState(() => {
    try {
      const saved = localStorage.getItem('rw_auto_send_telegram');
      return saved !== null ? saved === 'true' : true;
    } catch (_) {
      return true;
    }
  });
  const telegramStatesRef = useRef(new Map());
  const pendingTelegramResultsRef = useRef(new Map());
  const knownSignalKeysRef = useRef(new Set());
  const [loading, setLoading] = useState(true);

  const handleToggleAutoSend = useCallback(() => {
    setAutoSendTelegram((prev) => {
      const next = !prev;
      try {
        localStorage.setItem('rw_auto_send_telegram', String(next));
      } catch (_) {}
      return next;
    });
  }, []);

  const refreshSessionStats = useCallback(async () => {
    if (!getIQSessionToken()) return;
    try {
      const stats = await fetchTelegramStats();
      setSessionStats({ greens: stats.greens ?? 0, reds: stats.reds ?? 0 });
    } catch (_) {
      // Silencioso — estatísticas são informativas
    }
  }, []);

  const buildSignalMessage = useCallback((signal, stats) => {
    const currentStats = stats ?? sessionStats;
    return formatSignalMessage({
      strategy: signal.strategy.name,
      assetId: signal.asset,
      iqName: signal.asset, // O asset.id já é o ticker real da IQ (ex: EURUSD-op)
      direction: signal.direction,
      tf: signal.tf,
      time: signal.time,
      winRate: signal.stats?.winRate,
      totalTrades: signal.stats?.decided ?? signal.stats?.n,
      convergent: signal.convergent,
      sessionStats: currentStats,
    });
  }, [sessionStats]);

  const buildSignalMessagePlain = useCallback((signal, stats) => {
    const currentStats = stats ?? sessionStats;
    return formatSignalMessagePlain({
      strategy: signal.strategy.name,
      assetId: signal.asset,
      iqName: signal.asset,
      direction: signal.direction,
      tf: signal.tf,
      time: signal.time,
      winRate: signal.stats?.winRate,
      totalTrades: signal.stats?.decided ?? signal.stats?.n,
      convergent: signal.convergent,
      sessionStats: currentStats,
    });
  }, [sessionStats]);

  const notifyTelegram = useCallback(async (signal) => {
    if (telegramStatesRef.current.has(signal.key)) return;
    if (!isRecentSignal(signal.time, signal.tf)) {
      telegramStatesRef.current.set(signal.key, { status: 'old' });
      setTelegramStates((previous) => ({ ...previous, [signal.key]: { status: 'old' } }));
      return;
    }

    telegramStatesRef.current.set(signal.key, { status: 'sending' });
    setTelegramStates((previous) => ({ ...previous, [signal.key]: { status: 'sending' } }));
    try {
      // Busca stats atualizados antes de enviar
      let currentStats = sessionStats;
      try {
        const fresh = await fetchTelegramStats();
        currentStats = { greens: fresh.greens ?? 0, reds: fresh.reds ?? 0 };
        setSessionStats(currentStats);
      } catch (_) { /* stats são informativos */ }

      const messageText = buildSignalMessage(signal, currentStats);
      await sendTelegramSignal({
        signal_id: signal.key,
        strategy: signal.strategy.name,
        asset: signal.asset,
        direction: signal.direction,
        timeframe: signal.tf,
        signal_time: getSignalClockTime(signal.time, signal.tf),
        message_text: messageText,
      });
      pendingTelegramResultsRef.current.set(signal.key, signal);
      telegramStatesRef.current.set(signal.key, { status: 'sent' });
      setTelegramStates((previous) => ({ ...previous, [signal.key]: { status: 'sent' } }));
    } catch (error) {
      telegramStatesRef.current.set(signal.key, { status: 'failed', error: error.message });
      setTelegramStates((previous) => ({
        ...previous,
        [signal.key]: { status: 'failed', error: error.message },
      }));
      console.error(`[RadarLive] falha ao enviar sinal ${signal.key} ao Telegram:`, error);
    }
  }, [sessionStats, buildSignalMessage]);

  const settleTelegramResults = useCallback(async (asset, timeframe, candles) => {
    const pending = [...pendingTelegramResultsRef.current.entries()]
      .filter(([, signal]) => signal.asset === asset && signal.tf === timeframe);
    for (const [key, signal] of pending) {
      let trade;
      try {
        trade = runBacktest(candles, signal.strategy, {
          gale: 0,
          direction: 'ALL',
          pricePrecision: getPricePrecision(asset),
          minimumTick: getPriceTick(asset),
        }).find((candidate) => candidate.time === signal.time);
      } catch (error) {
        console.warn(`[RadarLive] não foi possível calcular o resultado ${key}:`, error);
        continue;
      }
      if (!trade) continue;
      if (trade.result === 'DOJI') {
        pendingTelegramResultsRef.current.delete(key);
        continue;
      }
      if (trade.result !== 'WIN' && trade.result !== 'LOSS') continue;

      try {
        await updateTelegramSignalResult(key, trade.result);
        pendingTelegramResultsRef.current.delete(key);
        const status = trade.result === 'WIN' ? 'green' : 'red';
        telegramStatesRef.current.set(key, { status });
        setTelegramStates((previous) => ({ ...previous, [key]: { status } }));
        // Atualiza stats locais imediatamente
        setSessionStats((prev) => ({
          greens: prev.greens + (trade.result === 'WIN' ? 1 : 0),
          reds: prev.reds + (trade.result === 'LOSS' ? 1 : 0),
        }));
        // Re-busca do servidor para sincronizar
        void refreshSessionStats();
      } catch (error) {
        console.error(`[RadarLive] falha ao atualizar resultado do sinal ${key}:`, error);
      }
    }
  }, [refreshSessionStats]);

  const retryTelegram = useCallback((signal) => {
    telegramStatesRef.current.delete(signal.key);
    void notifyTelegram(signal);
  }, [notifyTelegram]);

  const copySignal = useCallback(async (signal) => {
    try {
      const plainText = buildSignalMessagePlain(signal);
      await navigator.clipboard.writeText(plainText);
      setCopiedSignalKey(signal.key);
      setTimeout(() => setCopiedSignalKey((current) => current === signal.key ? '' : current), 2000);
    } catch (error) {
      console.error('[RadarLive] não foi possível copiar a mensagem do sinal:', error);
    }
  }, [buildSignalMessagePlain]);

  const refreshTelegramStatus = useCallback(async () => {
    if (!getIQSessionToken()) {
      setTelegramConfigured(false);
      setTelegramStatusError('');
      return;
    }
    try {
      const status = await fetchTelegramStatus();
      setTelegramConfigured(Boolean(status.configured));
      setTelegramStatusError('');
    } catch (error) {
      setTelegramConfigured(false);
      setTelegramStatusError(error.message);
    }
  }, []);

  useEffect(() => { void refreshTelegramStatus(); }, [refreshTelegramStatus]);
  useEffect(() => { void refreshSessionStats(); }, [refreshSessionStats]);

  useEffect(() => {
    const timer = setInterval(() => setTick((value) => value + 1), VALIDATION_REFRESH_MS);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    const timer = setInterval(() => setNowTick((value) => (value + 1) % 1000000), 1000);
    return () => clearInterval(timer);
  }, []);

  // Refresca stats do Telegram a cada 30s
  useEffect(() => {
    if (!getIQSessionToken()) return undefined;
    const timer = setInterval(() => void refreshSessionStats(), 30_000);
    return () => clearInterval(timer);
  }, [refreshSessionStats]);

  const bridgeOnline = ds.bridgeOnline;
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    if (!getIQSessionToken() || !topAssets.length) {
      setSignals([]);
      setScanErrors([]);
      setLoading(false);
      return () => { cancelled = true; };
    }
    fullScanSignals(topAssets, settleTelegramResults).then((result) => {
      if (cancelled) return;
      result.signals.forEach((signal) => knownSignalKeysRef.current.add(signal.key));
      setSignals(result.signals);
      setScanErrors(result.errors);
      if (telegramConfigured && autoSendTelegram) {
        // Envia apenas convergentes em sessão de mercado ativa
        result.signals
          .filter((s) => s.convergent && s.inSession)
          .forEach((signal) => { void notifyTelegram(signal); });
      }
      setLoading(false);
    }).catch((error) => {
      console.warn('[RadarLive] falha ao verificar sinais:', error);
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [tick, ds.payoutsAt, ds.activeAssetsAt, bridgeOnline, topAssets, telegramConfigured, autoSendTelegram, notifyTelegram, settleTelegramResults]);

  const handleLiveCandle = useCallback(async (message) => {
    if (!message || message.type !== 'candle') return;
    const candle = message.candle;
    if (!candle || typeof candle.time !== 'number') return;
    const asset = message.asset;
    if (!topAssets.some((activeAsset) => activeAsset.id === asset)) return;
    const hasPendingForAsset = [...pendingTelegramResultsRef.current.values()]
      .some((signal) => signal.asset === asset);
    const isMonitoredTf = VALIDATION_TIMEFRAMES.includes(message.tf);
    if (!isMonitoredTf && !hasPendingForAsset) return;
    appendLiveCandle(asset, message.tf, candle);

    // FIX #5: invalida o pairCache para este ativo/tf para que o scan use os
    // candles atualizados (com a nova vela) em vez dos stats em cache.
    if (isMonitoredTf) {
      invalidatePairValidation(asset, message.tf);
    }

    // Settle resultados para qualquer TF com sinais pendentes
    if (hasPendingForAsset) {
      let pair;
      try {
        pair = await validatePair(asset, message.tf);
      } catch (_) { /* ignora */ }
      if (pair?.candles?.length) {
        await settleTelegramResults(asset, message.tf, pair.candles);
      }
    }

    // Re-analisa convergência para o ativo
    const assetObj = topAssets.find((a) => a.id === asset);
    if (!assetObj) return;

    const signals = await scanAssetBothTfs(assetObj, settleTelegramResults);
    const highlightUntil = Date.now() + HIGHLIGHT_MS;
    const inSession = isActiveSession(asset);
    const nextOpen = getNextSessionOpen(asset);
    const fresh = signals.map((signal) => ({
      key: `${asset}|${signal.strategy.id}|${signal.tf}|${signal.time}`,
      asset,
      assetName: assetObj.name,
      strategy: signal.strategy,
      direction: signal.direction,
      tf: signal.tf,
      time: signal.time,
      ago: Math.max(0, (signal.pair?.candles?.length ?? 1) - 1 - signal.index),
      stats: signal.stats,
      statsM1: signal.statsM1 ?? null,
      statsM5: signal.statsM5 ?? null,
      convergent: signal.convergent ?? false,
      inSession,
      nextOpen,
      highlightedUntil: highlightUntil,
    }));

    const addedSignals = fresh.filter((signal) => !knownSignalKeysRef.current.has(signal.key));
    addedSignals.forEach((signal) => knownSignalKeysRef.current.add(signal.key));
    if (telegramConfigured && autoSendTelegram) {
      // Auto-envia apenas convergentes em sessão ativa
      addedSignals
        .filter((s) => s.convergent && s.inSession)
        .forEach((signal) => { void notifyTelegram(signal); });
    }
    setSignals((previous) => {
      if (!addedSignals.length) return previous;
      return [...addedSignals, ...previous]
        .sort((a, b) => {
          if (b.convergent !== a.convergent) return b.convergent ? 1 : -1;
          return b.time - a.time || b.stats.winRate - a.stats.winRate;
        })
        .slice(0, 200);
    });
  }, [topAssets, telegramConfigured, autoSendTelegram, notifyTelegram, settleTelegramResults]);

  useEffect(() => {
    if (!liveWsEnabled) return undefined;
    let queue = Promise.resolve();
    const unsubscribe = liveFeed.subscribe((message) => {
      queue = queue.then(() => handleLiveCandle(message)).catch((error) => {
        console.warn('[RadarLive] atualização do candle falhou:', error);
      });
    });
    return unsubscribe;
  }, [handleLiveCandle]);

  const refresh = async () => {
    try {
      await refreshIQActives();
    } catch (error) {
      console.error('[RadarLive] falha ao atualizar ativos e payouts IQ:', error);
      setScanErrors([`Não foi possível atualizar os payouts da IQ Option: ${error.message}`]);
      return;
    }
    invalidateCache();
    invalidatePairValidation();
    setTick((value) => value + 1);
  };

  const displaySignals = useMemo(() => {
    void nowTick;
    return signals;
  }, [signals, nowTick]);
  const now = Date.now();

  const correlationWarnings = useMemo(
    () => detectCorrelatedSignals(displaySignals),
    [displaySignals],
  );

  const totalSession = sessionStats.greens + sessionStats.reds;
  const sessionPct = totalSession > 0 ? Math.round((sessionStats.greens / totalSession) * 100) : null;

  return (
    <>
      <PageHeader title="Radar Live" subtitle="Prioriza sinais CONVERGENTES (M1+M5) com significância estatística (min 30 ops, edge ≥ 5%). Sinais isolados exigem envio manual.">
        <DataBadge />
      </PageHeader>

      {/* Painel de sessão: Greens / Reds */}
      {getIQSessionToken() && totalSession > 0 && (
        <div className="card mb-4 p-3 sm:p-4">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs font-semibold text-zinc-300">Resumo da Sessão</span>
            <span className="text-[11px] text-zinc-500">resultado dos sinais enviados</span>
          </div>
          <div className="flex flex-wrap items-center gap-4">
            <div className="flex items-center gap-2">
              <span className="flex h-8 w-8 items-center justify-center rounded-full bg-neon/10">
                <TrendingUp className="h-4 w-4 text-neon" />
              </span>
              <div>
                <div className="text-xl font-bold text-neon">{sessionStats.greens}</div>
                <div className="text-[10px] text-zinc-500 uppercase tracking-wider">Green</div>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <span className="flex h-8 w-8 items-center justify-center rounded-full bg-red-500/10">
                <TrendingDown className="h-4 w-4 text-red-400" />
              </span>
              <div>
                <div className="text-xl font-bold text-red-400">{sessionStats.reds}</div>
                <div className="text-[10px] text-zinc-500 uppercase tracking-wider">Red</div>
              </div>
            </div>
            {sessionPct !== null && (
              <div className="ml-auto text-right">
                <div className={`text-2xl font-bold ${sessionPct >= 60 ? 'text-neon' : sessionPct >= 50 ? 'text-amber-300' : 'text-red-400'}`}>
                  {sessionPct}%
                </div>
                <div className="text-[10px] text-zinc-500 uppercase tracking-wider">Assertividade</div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Alerta de Correlação de Risco */}
      {correlationWarnings.length > 0 && (
        <div className="card mb-4 border border-amber-500/40 bg-amber-500/10 p-3 sm:p-4">
          <div className="flex items-start gap-3">
            <ShieldAlert className="h-5 w-5 text-amber-400 shrink-0 mt-0.5" />
            <div>
              <div className="text-xs font-bold text-amber-200 uppercase tracking-wide">
                Atenção à Correlação — Risco Duplicado
              </div>
              <div className="text-xs text-amber-300/80 mt-1 space-y-1">
                {correlationWarnings.map((w, i) => (
                  <div key={i}>
                    • Ativos do grupo <strong>{w.label}</strong> com sinais simultâneos de <strong>{w.direction}</strong> ({w.assets.join(', ')}). Evite operar múltiplos pares da mesma correlação ao mesmo tempo para não duplicar exposição ao mesmo risco macroeconômico.
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      <div className="card mb-4 flex flex-wrap items-end gap-3 p-3 sm:p-4">
        <div className="pb-2 text-xs text-zinc-500">
          <span className="font-semibold text-zinc-300">Top {RADAR_ASSET_LIMIT} payouts</span>
          <span className="mx-2 text-zinc-700">·</span>
          {topAssets.length} ativos
          <span className="mx-2 text-zinc-700">·</span>
          ranking atualizado a cada 60 s
        </div>
        <button className="btn-ghost" onClick={refresh}><RefreshCw className="h-4 w-4" /> Atualizar</button>
        {liveWsEnabled && (
          <div className="ml-auto flex items-center gap-2 pb-2 text-xs text-zinc-500">
            <span className={`h-2 w-2 rounded-full ${liveFeed.status === 'open' ? 'bg-neon' : 'bg-zinc-600'}`} />
            <span>Ao vivo</span>
          </div>
        )}
      </div>

      {topAssets.length > 0 && (
        <div className="card mb-4 p-3 sm:p-4">
          <div className="mb-2 flex items-center justify-between gap-2">
            <span className="text-xs font-semibold text-zinc-300">Ativos monitorados</span>
            <span className="text-[11px] text-zinc-500">ordenados por payout</span>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {topAssets.map((asset) => (
              <Badge key={asset.id} tone="neon">{asset.name} · {fmtPct(asset.payout, 0)}</Badge>
            ))}
          </div>
        </div>
      )}

      {/* Card de Controle: Envio Automático ao Telegram */}
      {getIQSessionToken() && (
        <div className="card mb-4 p-4 border border-line bg-gradient-to-r from-panel via-panel to-panel2 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className={`flex h-11 w-11 items-center justify-center rounded-xl shrink-0 ${
              telegramConfigured
                ? (autoSendTelegram ? 'bg-neon/15 text-neon shadow-glowSm' : 'bg-zinc-800 text-zinc-500')
                : 'bg-amber-500/15 text-amber-400'
            }`}>
              <Send className="h-5 w-5" />
            </div>
            <div>
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-bold text-white text-sm">Envio Automático ao Telegram</span>
                {telegramConfigured ? (
                  <span className={`rounded-full px-2 py-0.5 text-[10px] font-extrabold uppercase tracking-wide ${
                    autoSendTelegram ? 'bg-neon/20 text-neon border border-neon/30' : 'bg-zinc-800 text-zinc-400 border border-zinc-700'
                  }`}>
                    {autoSendTelegram ? '🟢 Ativado' : '⏸️ Pausado (Manual)'}
                  </span>
                ) : (
                  <span className="rounded-full bg-amber-500/20 px-2 py-0.5 text-[10px] font-bold text-amber-300 border border-amber-500/30">
                    ⚠️ Bot Não Configurado
                  </span>
                )}
              </div>
              <p className="text-xs text-zinc-400 mt-1 max-w-xl">
                {telegramConfigured
                  ? (autoSendTelegram
                      ? 'Sinais convergentes (M1+M5) em sessão ativa são enviados automaticamente para o canal no minuto exato da entrada.'
                      : 'Envio automático pausado. Os sinais continuam sendo detectados e você pode enviá-los clicando em "Enviar Telegram" no card do sinal.')
                  : (telegramStatusError
                      ? `Erro na comunicação com Telegram: ${telegramStatusError}`
                      : 'Configure TELEGRAM_BOT_TOKEN e TELEGRAM_CHAT_ID no servidor para ativar o bot.')}
              </p>
            </div>
          </div>

          {telegramConfigured && (
            <div className="flex items-center gap-3 shrink-0 self-end sm:self-center bg-panel2/80 px-3 py-2 rounded-lg border border-line">
              <span className="text-xs font-semibold text-zinc-300">
                {autoSendTelegram ? 'Envio Automático' : 'Envio Manual'}
              </span>
              <button
                type="button"
                role="switch"
                aria-checked={autoSendTelegram}
                onClick={handleToggleAutoSend}
                className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${
                  autoSendTelegram ? 'bg-neon' : 'bg-zinc-700'
                }`}
              >
                <span
                  className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow-lg ring-0 transition duration-200 ease-in-out ${
                    autoSendTelegram ? 'translate-x-5' : 'translate-x-0'
                  }`}
                />
              </button>
            </div>
          )}
        </div>
      )}

      {scanErrors.length > 0 && (
        <div className="mb-4 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-sm text-amber-200" role="status">
          Alguns ativos do Top {RADAR_ASSET_LIMIT} não puderam ser analisados: {scanErrors.join(' · ')}
        </div>
      )}

      {!getIQSessionToken() ? (
        <EmptyState title="Conecte sua conta IQ Option" text="O Radar seleciona os ativos abertos com maior payout diretamente da sua conta.">
          <Link className="btn-primary mt-4 inline-flex" to="/conexao-iq">Conectar IQ Option</Link>
        </EmptyState>
      ) : !topAssets.length ? (
        <EmptyState title="Nenhum ativo disponível para o Radar" text="Aguarde a atualização dos ativos ou confira se a IQ Option retornou ativos abertos com candles suportados." />
      ) : loading && !displaySignals.length ? <Loading text="Catalogando M1 (1h) e M5 (2h) para detectar convergências…" /> : !displaySignals.length ? (
        <EmptyState title="Nenhum sinal aprovado neste momento" text="Aguardando convergência entre M1 e M5. Estratégias precisam de dados reais da corretora, mínimo 30 operações e edge estatístico de 5% acima do break-even." />
      ) : (
        <div className="space-y-3">
          <div className="flex items-center justify-between px-1">
            <h2 className="text-sm font-semibold text-zinc-200">Sinais aprovados</h2>
            <div className="flex items-center gap-3">
              <span className="flex items-center gap-1 text-xs text-[#00FF88]">
                <Zap className="h-3 w-3" />
                {displaySignals.filter((s) => s.convergent).length} convergentes
              </span>
              <span className="text-xs text-zinc-500">
                {displaySignals.filter((s) => !s.convergent).length} isolados
              </span>
            </div>
          </div>
          {displaySignals.map((signal) => {
            const highlighted = signal.highlightedUntil && signal.highlightedUntil > now;
            const convergent = signal.convergent;
            return (
              <div
                key={signal.key}
                className={
                  'card flex flex-col gap-3 p-3 transition-shadow sm:flex-row sm:items-center sm:justify-between sm:p-4 ' +
                  (highlighted ? 'ring-1 ring-[#00FF88] shadow-[0_0_20px_-4px_rgba(0,255,136,0.5)] ' : '') +
                  (convergent ? 'border-l-2 border-l-[#00FF88]/60 ' : '')
                }
              >
                <div className="min-w-0 flex-1">
                  <div className="mb-2 flex flex-wrap items-center gap-2">
                    {convergent && (
                      <span className="flex items-center gap-1 rounded-full bg-[#00FF88]/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-[#00FF88]">
                        <Zap className="h-2.5 w-2.5" /> CONVERGENTE
                      </span>
                    )}
                    <Link
                      to={`/estrategias/${signal.strategy.id}?asset=${encodeURIComponent(signal.asset)}&tf=${signal.tf}&validation=1`}
                      className="truncate text-sm font-bold text-zinc-100 hover:text-neon"
                    >
                      {signal.strategy.name}
                    </Link>
                    {highlighted && !convergent ? (
                      <span className="rounded-full bg-zinc-700/60 px-2 py-0.5 text-[10px] font-semibold uppercase text-zinc-300">Novo</span>
                    ) : null}
                    {!signal.inSession && (
                      <span className="flex items-center gap-1 rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-semibold text-amber-300 border border-amber-500/30">
                        <Clock className="h-2.5 w-2.5" /> Fora de Sessão {signal.nextOpen ? `(abre ${signal.nextOpen})` : ''}
                      </span>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                    <span className="font-bold text-white">{signal.asset}</span>
                    <DirectionBadge direction={signal.direction} />
                    <Badge tone="gray">{signal.tf}</Badge>
                    <span className="text-xs text-zinc-400">Entrada {getSignalClockTime(signal.time, signal.tf)}</span>
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                    <span className="text-zinc-500">
                      {signal.ago === 0 ? 'Última vela' : `Há ${signal.ago} ${signal.ago > 1 ? 'velas' : 'vela'}`} · {fmtDateTime(signal.time)}
                    </span>
                    <span className="text-zinc-700">|</span>
                    {convergent && signal.statsM1 && signal.statsM5 ? (
                      <>
                        <span className="text-zinc-500">
                          M1 <span className={`font-semibold ${signClass(signal.statsM1.edge)}`}>{fmtPct(signal.statsM1.winRate)}</span>
                          {' · '}
                          M5 <span className={`font-semibold ${signClass(signal.statsM5.edge)}`}>{fmtPct(signal.statsM5.winRate)}</span>
                        </span>
                      </>
                    ) : (
                      <span className="text-zinc-500">
                        Histórico <span className={`font-semibold ${signClass(signal.stats.edge)}`}>{fmtPct(signal.stats.winRate)}</span> em {signal.stats.decided} ops
                      </span>
                    )}
                    {signal.stats?.ci && (
                      <>
                        <span className="text-zinc-700">|</span>
                        <span className="text-zinc-500" title={`Intervalo de Confiança de Wilson 95%: a probabilidade real de acerto estimada está entre ${fmtPct(signal.stats.ci.low, 1)} e ${fmtPct(signal.stats.ci.high, 1)}`}>
                          IC 95%: <span className="font-mono text-zinc-300">[{fmtPct(signal.stats.ci.low, 0)} – {fmtPct(signal.stats.ci.high, 0)}]</span>
                        </span>
                      </>
                    )}
                  </div>
                </div>

                <div className="flex shrink-0 flex-wrap items-center gap-2">
                  {telegramStates[signal.key]?.status === 'sending' ? (
                    <span className="text-xs text-zinc-400">Enviando…</span>
                  ) : telegramStates[signal.key]?.status === 'sent' ? (
                    <span className="text-xs text-neon">✓ Telegram</span>
                  ) : telegramStates[signal.key]?.status === 'green' ? (
                    <span className="text-xs font-semibold text-neon">🟢 Green</span>
                  ) : telegramStates[signal.key]?.status === 'red' ? (
                    <span className="text-xs font-semibold text-red-400">🔴 Red</span>
                  ) : telegramStates[signal.key]?.status === 'failed' ? (
                    <button
                      className="max-w-48 text-left text-xs text-red-400 hover:underline"
                      title={telegramStates[signal.key].error}
                      onClick={() => retryTelegram(signal)}
                    >
                      Falha · tentar novamente
                    </button>
                  ) : telegramStates[signal.key]?.status === 'old' ? (
                    <span className="text-xs text-amber-300">Fora da janela</span>
                  ) : telegramConfigured && !convergent ? (
                    <button
                      className="btn-ghost px-3 py-2 text-xs"
                      onClick={() => notifyTelegram(signal)}
                    >
                      Enviar Telegram
                    </button>
                  ) : null}
                  <button className="btn-ghost px-3 py-2" onClick={() => void copySignal(signal)}>
                    {copiedSignalKey === signal.key ? <Check className="h-4 w-4" /> : <Clipboard className="h-4 w-4" />}
                    {copiedSignalKey === signal.key ? 'Copiado' : 'Copiar'}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}
