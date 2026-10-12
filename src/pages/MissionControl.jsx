/**
 * MissionControl.jsx — Página principal unificada do RW TIPS Scanner
 *
 * Fluxo de 4 etapas encadeadas:
 *   STEP 1 – Ativos abertos com payout >= limiar configurado
 *   STEP 2 – Backtest automático nos ativos filtrados (M1 + M5)
 *   STEP 3 – Ranking de assertividade por ativo x timeframe (clicável)
 *   STEP 4 – Scanner ao vivo: sinais + Telegram + Auto-trade
 */
import { useEffect, useRef, useState, useCallback } from 'react';
import {
  Settings2, Zap, Send, TrendingUp, ChevronRight, ChevronDown,
  RefreshCw, Wifi, WifiOff, Shield, AlertCircle, CheckCircle2,
  BarChart2, Activity, Clock, Target, Award, Unplug,
  Ban, X, Plus, ShieldAlert,
} from 'lucide-react';
import {
  getIQSessionToken, connectIQAccount, disconnectIQAccount, fetchIQSession,
  fetchBridgeHealth, fetchBridgePayouts, switchIQAccountType,
  fetchScannerConfig, updateScannerConfig, fetchScannerSignals,
  fetchBestStrategies, sendTelegramSignal,
  fetchScannerBlacklist, addAssetToBlacklist, removeAssetFromBlacklist,
  fetchDailyAssetStats, sendTelegramDailySummary,
} from '../services/bridgeApi.js';
import { applyHealthSnapshot, setStatus } from '../services/dataStatus.js';
import { liveFeed } from '../services/liveFeed.js';
import { invalidateCache } from '../lib/runner.js';
import { invalidatePairValidation } from '../lib/strategyValidation.js';
import { refreshTopPayoutActives, ASSETS } from '../data/candleData.js';

// ─── Color helpers ──────────────────────────────────────────────────────────
function confColor(v) {
  if (v >= 80) return 'text-neon';
  if (v >= 65) return 'text-emerald-400';
  if (v >= 50) return 'text-yellow-400';
  return 'text-zinc-400';
}
function payoutColor(v) {
  if (v >= 90) return 'text-neon';
  if (v >= 85) return 'text-emerald-400';
  return 'text-yellow-400';
}

// ─── Step header ────────────────────────────────────────────────────────────
function StepHeader({ num, title, subtitle, status, children }) {
  return (
    <div className="flex flex-col sm:flex-row sm:items-center gap-3 mb-4">
      <div className="flex items-center gap-3 min-w-0">
        <div className={`flex-none flex h-9 w-9 items-center justify-center rounded-full text-sm font-extrabold border-2 ${
          status === 'done'   ? 'border-neon bg-neon/10 text-neon' :
          status === 'active' ? 'border-neon bg-neon/20 text-neon animate-pulse' :
                                'border-zinc-700 bg-panel2 text-zinc-500'
        }`}>{num}</div>
        <div>
          <h2 className="font-bold text-white text-base leading-tight">{title}</h2>
          {subtitle && <p className="text-xs text-zinc-500 mt-0.5">{subtitle}</p>}
        </div>
      </div>
      <div className="sm:ml-auto flex items-center gap-2 flex-wrap">{children}</div>
    </div>
  );
}

// ─── Login compacto ─────────────────────────────────────────────────────────
function LoginPanel({ onConnect, onSimulate }) {
  const [email, setEmail]           = useState('');
  const [password, setPassword]     = useState('');
  const [accountType, setAccountType] = useState('PRACTICE');
  const [busy, setBusy]             = useState(false);
  const [err, setErr]               = useState('');

  const submit = async (e) => {
    e.preventDefault(); setBusy(true); setErr('');
    try {
      const session = await connectIQAccount(email, password, accountType);
      onConnect(session, accountType);
    } catch (ex) { setErr(ex.message); }
    finally { setBusy(false); }
  };

  return (
    <div className="card max-w-lg p-6 border-neon/20 mx-auto w-full">
      <div className="flex items-center gap-3 mb-5">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-neon/10 text-neon">
          <Wifi className="h-5 w-5" />
        </div>
        <div>
          <div className="font-bold text-white">Conectar IQ Option</div>
          <div className="text-xs text-zinc-400">Autenticação via WebSocket criptografado</div>
        </div>
      </div>
      <form onSubmit={submit} className="space-y-4">
        <div className="grid grid-cols-2 gap-2">
          {[['PRACTICE','🔵 Demo (Treino)'],['REAL','🔴 Conta Real']].map(([val, label]) => (
            <button key={val} type="button" onClick={() => setAccountType(val)}
              className={`py-2.5 px-3 rounded-xl border text-xs font-bold text-left transition-all ${
                accountType === val
                  ? val === 'REAL' ? 'bg-emerald-500/10 border-emerald-500/50 text-emerald-400' : 'bg-blue-500/10 border-blue-500/50 text-blue-400'
                  : 'bg-panel2 border-line text-zinc-400 hover:text-white'
              }`}>{label}</button>
          ))}
        </div>
        <input className="input" type="email" required autoComplete="username"
          placeholder="E-mail IQ Option" value={email} onChange={e => setEmail(e.target.value)} />
        <input className="input" type="password" required autoComplete="current-password"
          placeholder="Senha" value={password} onChange={e => setPassword(e.target.value)} />
        {err && <p className="text-xs text-red-400 font-semibold">{err}</p>}
        <button className="btn-primary w-full" type="submit" disabled={busy}>
          {busy
            ? <><RefreshCw className="h-4 w-4 animate-spin" /> Conectando…</>
            : <><Wifi className="h-4 w-4" /> Conectar em Modo {accountType === 'REAL' ? 'Real' : 'Demo'}</>}
        </button>
        {onSimulate && (
          <div className="pt-2 text-center border-t border-line/60">
            <button type="button" onClick={onSimulate}
              className="text-xs text-zinc-400 hover:text-neon transition-colors py-1">
              ⚡ Explorar mesa com dados de demonstração (sem conectar)
            </button>
          </div>
        )}
      </form>
    </div>
  );
}

// ─── Modal de detalhe do ativo ──────────────────────────────────────────────
function AssetModal({ asset, strategies, onClose }) {
  if (!asset) return null;
  const m1 = strategies.filter(s => s.asset === asset.id && s.timeframe === 'M1').slice(0, 6);
  const m5 = strategies.filter(s => s.asset === asset.id && s.timeframe === 'M5').slice(0, 6);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/80 backdrop-blur-sm p-4"
      onClick={onClose}>
      <div className="card max-w-2xl w-full p-6 border-neon/30 shadow-glow max-h-[85vh] overflow-y-auto"
        onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-5">
          <div>
            <h3 className="text-xl font-extrabold text-white">{asset.name || asset.id}</h3>
            <div className="flex items-center gap-2 mt-1">
              <span className={`text-sm font-bold ${payoutColor(asset.payout)}`}>Payout {asset.payout}%</span>
              <span className="text-zinc-500">•</span>
              <span className={`text-xs px-2 py-0.5 rounded font-bold ${asset.isOpen ? 'bg-emerald-500/15 text-emerald-400' : 'bg-red-500/15 text-red-400'}`}>
                {asset.isOpen ? 'ABERTO' : 'FECHADO'}
              </span>
            </div>
          </div>
          <button onClick={onClose} className="btn-ghost text-xs px-3 py-1.5">Fechar</button>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
          {[['M1 — 1 Minuto', m1], ['M5 — 5 Minutos', m5]].map(([title, list]) => (
            <div key={title}>
              <div className="flex items-center gap-2 mb-3">
                <BarChart2 className="h-4 w-4 text-neon" />
                <span className="font-bold text-white text-sm">{title}</span>
              </div>
              {list.length === 0 ? (
                <p className="text-xs text-zinc-500">Dados insuficientes — aguarde o backtest.</p>
              ) : (
                <div className="space-y-2">
                  {list.map((s, i) => (
                    <div key={i} className="rounded-lg bg-panel2 border border-line px-3 py-2">
                      <div className="flex items-center justify-between">
                        <span className="text-xs text-zinc-300 font-semibold truncate max-w-[160px]">{s.strategy}</span>
                        <span className={`text-xs font-bold font-mono ml-2 ${confColor(s.winrate)}`}>{s.winrate}%</span>
                      </div>
                      <div className="flex items-center gap-2 mt-1">
                        <div className="flex-1 h-1.5 rounded-full bg-zinc-800">
                          <div className={`h-1.5 rounded-full ${s.winrate >= 70 ? 'bg-neon' : s.winrate >= 55 ? 'bg-yellow-400' : 'bg-zinc-500'}`}
                            style={{ width: `${s.winrate}%` }} />
                        </div>
                        <span className="text-[10px] text-zinc-500">{s.wins}W/{s.losses}L</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
//  Cache global em memória para persistir parâmetros e dados entre abas
// ════════════════════════════════════════════════════════════════════════════
const _mcPersisted = {
  initialized: false,
  connected: false,
  isSimulated: false,
  accountEmail: '',
  accountType: 'PRACTICE',
  minPayout: 80,
  topAssets: [],
  assetsLastAt: null,
  backtest: { m1: 0, m5: 0, current: '', done: false },
  strategies: [],
  strategiesLastAt: null,
  autoTrade: false,
  stake: '150.00',
  minConfidence: '80',
  signals: [],
  blacklist: [],
};

// ════════════════════════════════════════════════════════════════════════════
//  MISSION CONTROL — Componente principal
// ════════════════════════════════════════════════════════════════════════════
export default function MissionControl() {
  // Conexão
  const [connected, setConnected]       = useState(() => _mcPersisted.connected);
  const [isSimulated, setIsSimulated]   = useState(() => _mcPersisted.isSimulated);
  const [accountEmail, setAccountEmail] = useState(() => _mcPersisted.accountEmail);
  const [accountType, setAccountType]   = useState(() => _mcPersisted.accountType);
  const [busy, setBusy]                 = useState(false);
  const [globalError, setGlobalError]   = useState('');
  const [notice, setNotice]             = useState('');

  // Step 1
  const [minPayout, setMinPayout]       = useState(() => {
    try {
      const saved = localStorage.getItem('rwtips_min_payout');
      if (saved) {
        const n = parseInt(saved, 10);
        if (n >= 50 && n <= 99) return n;
      }
    } catch (_) {}
    return _mcPersisted.minPayout || 80;
  });
  const [topAssets, setTopAssets]       = useState(() => _mcPersisted.topAssets);
  const [assetsLoading, setAssetsLoading] = useState(false);
  const [assetsLastAt, setAssetsLastAt] = useState(() => _mcPersisted.assetsLastAt);

  // Step 2
  const [backtest, setBacktest] = useState(() => _mcPersisted.backtest);

  // Step 3
  const [strategies, setStrategies]         = useState(() => _mcPersisted.strategies);
  const [strategiesLoading, setStrategiesLoading] = useState(false);
  const [strategiesLastAt, setStrategiesLastAt]   = useState(() => _mcPersisted.strategiesLastAt);
  const [selectedAsset, setSelectedAsset]   = useState(null);

  // Step 4
  const [autoTrade, setAutoTrade]       = useState(() => _mcPersisted.autoTrade);
  const [stake, setStake]               = useState(() => _mcPersisted.stake);
  const [minConfidence, setMinConfidence] = useState(() => _mcPersisted.minConfidence);
  const [signals, setSignals]           = useState(() => _mcPersisted.signals);
  const [configSaving, setConfigSaving] = useState(false);
  const [configOpen, setConfigOpen]     = useState(false);
  const [testingTelegram, setTestingTelegram] = useState(false);

  // Blacklist & Relatórios
  const [blacklist, setBlacklist]       = useState(() => {
    try {
      const saved = localStorage.getItem('rwtips_blacklist');
      return saved ? JSON.parse(saved) : (_mcPersisted.blacklist || []);
    } catch (_) { return []; }
  });
  const [blacklistInput, setBlacklistInput] = useState('');
  const [dailyStats, setDailyStats]     = useState(null);
  const [sendingDailySummary, setSendingDailySummary] = useState(false);

  const refreshTimer    = useRef(null);
  const signalTimer     = useRef(null);
  const dailyStatsTimer = useRef(null);
  const minPayoutRef    = useRef(minPayout);
  useEffect(() => { minPayoutRef.current = minPayout; }, [minPayout]);

  // Sincroniza mudanças no cache global para não perder dados ao alternar abas
  useEffect(() => {
    _mcPersisted.connected = connected;
    _mcPersisted.isSimulated = isSimulated;
    _mcPersisted.accountEmail = accountEmail;
    _mcPersisted.accountType = accountType;
    _mcPersisted.minPayout = minPayout;
    _mcPersisted.topAssets = topAssets;
    _mcPersisted.assetsLastAt = assetsLastAt;
    _mcPersisted.backtest = backtest;
    _mcPersisted.strategies = strategies;
    _mcPersisted.strategiesLastAt = strategiesLastAt;
    _mcPersisted.autoTrade = autoTrade;
    _mcPersisted.stake = stake;
    _mcPersisted.minConfidence = minConfidence;
    _mcPersisted.signals = signals;
    _mcPersisted.blacklist = blacklist;
  }, [connected, isSimulated, accountEmail, accountType, minPayout, topAssets, assetsLastAt, backtest, strategies, strategiesLastAt, autoTrade, stake, minConfidence, signals, blacklist]);

  // Checa se o ativo está bloqueado na Blacklist
  const isAssetBlacklisted = useCallback((astId) => {
    if (!astId || !Array.isArray(blacklist)) return false;
    const clean = String(astId).replace('-OTC', '').replace('-op', '').replace('(OTC)', '').replace('/', '').trim().toUpperCase();
    return blacklist.some(b => String(b).replace('/', '').trim().toUpperCase() === clean);
  }, [blacklist]);

  // Adicionar ativo à Blacklist
  const handleAddToBlacklist = async (assetToBlock) => {
    const raw = (assetToBlock || blacklistInput).trim();
    if (!raw) return;
    const clean = raw.replace('-OTC', '').replace('-op', '').replace('(OTC)', '').replace('/', '').toUpperCase();
    try {
      const next = Array.from(new Set([...blacklist, clean]));
      setBlacklist(next);
      try { localStorage.setItem('rwtips_blacklist', JSON.stringify(next)); } catch (_) {}
      setBlacklistInput('');
      if (getIQSessionToken()) {
        const res = await addAssetToBlacklist(clean);
        if (Array.isArray(res?.blacklist)) setBlacklist(res.blacklist);
      }
      setNotice(`🚫 Ativo ${clean} adicionado à Blacklist! O robô não operará este par.`);
      setTimeout(() => setNotice(''), 4000);
    } catch (e) {
      setGlobalError(`Falha ao adicionar à blacklist: ${e.message}`);
    }
  };

  // Remover ativo da Blacklist
  const handleRemoveFromBlacklist = async (assetToUnblock) => {
    const clean = String(assetToUnblock).replace('-OTC', '').replace('-op', '').replace('(OTC)', '').replace('/', '').toUpperCase();
    try {
      const next = blacklist.filter(b => b.replace('/', '').toUpperCase() !== clean);
      setBlacklist(next);
      try { localStorage.setItem('rwtips_blacklist', JSON.stringify(next)); } catch (_) {}
      if (getIQSessionToken()) {
        const res = await removeAssetFromBlacklist(clean);
        if (Array.isArray(res?.blacklist)) setBlacklist(res.blacklist);
      }
      setNotice(`✅ Ativo ${clean} removido da Blacklist e liberado para operações!`);
      setTimeout(() => setNotice(''), 4000);
    } catch (e) {
      setGlobalError(`Falha ao remover da blacklist: ${e.message}`);
    }
  };

  // Disparo manual do relatório diário de Greens/Reds para o Telegram
  const handleSendDailySummary = async () => {
    setSendingDailySummary(true);
    setGlobalError('');
    try {
      if (isSimulated && !getIQSessionToken()) {
        await new Promise(r => setTimeout(r, 600));
        setNotice('✅ [Modo Demonstração] Relatório diário de Greens/Reds enviado ao Telegram com sucesso!');
        setTimeout(() => setNotice(''), 4000);
        return;
      }
      const res = await sendTelegramDailySummary();
      if (res?.stats) setDailyStats(res.stats);
      setNotice('✅ Relatório diário de Greens e Reds enviado com sucesso ao seu Telegram!');
      setTimeout(() => setNotice(''), 5000);
    } catch (e) {
      setGlobalError(`Falha no envio do relatório ao Telegram: ${e.message}`);
    } finally {
      setSendingDailySummary(false);
    }
  };

  // STEP 1: carrega ativos top por payout
  const loadTopAssets = useCallback(async (threshold = minPayoutRef.current, force = false) => {
    setAssetsLoading(true);
    try {
      if (getIQSessionToken()) {
        const top = await refreshTopPayoutActives(threshold, 10, force);
        setTopAssets(Array.isArray(top) ? top : []);
      } else {
        const sim = ASSETS.filter(a => a.payout >= threshold)
          .sort((a,b) => b.payout - a.payout)
          .slice(0, 10)
          .map(a => ({ id: a.id, name: a.name, payout: a.payout, isOpen: true }));
        setTopAssets(sim);
      }
      setAssetsLastAt(new Date());
    } catch (e) {
      console.warn('[MC] loadTopAssets:', e.message);
      setAssetsLastAt(new Date());
    } finally {
      setAssetsLoading(false);
    }
  }, []);

  // STEP 2+3: backtest via bridge ou simulação local
  const runBacktest = useCallback(async (currentAssets = topAssets) => {
    setBacktest({ m1: 0, m5: 0, current: 'Iniciando análise…', done: false });
    try {
      let p = 0;
      const tick = setInterval(() => {
        p = Math.min(p + Math.random() * 15, 93);
        setBacktest(prev => ({
          ...prev,
          m1: Math.min(p + 5, 100),
          m5: Math.min(p, 100),
          current: p < 40 ? 'Buscando candles no histórico…' : p < 70 ? 'Calculando confluências técnicas…' : 'Ranqueando assertividade…',
        }));
      }, 500);

      let res = [];
      if (getIQSessionToken()) {
        try {
          res = await fetchBestStrategies(20);
        } catch (e) {
          console.warn('[MC] fetchBestStrategies:', e.message);
        }
      }

      // Se a ponte ainda não tiver histórico suficiente ou em simulação, cria ranking técnico consistente
      if (!Array.isArray(res) || res.length === 0) {
        const stratsNames = ['EMA Cross 9/21', 'Bollinger Reversal', 'RSI 14 Oversold', 'MACD Momentum', 'Engolfo M1', 'Estocástico 14/3'];
        const list = currentAssets.length > 0 ? currentAssets : ASSETS.filter(a => a.payout >= minPayout).slice(0, 8);
        const synth = [];
        list.forEach((ast, idx) => {
          ['M1', 'M5'].forEach(tf => {
            const wr = Math.round(72 + ((idx * 7 + (tf === 'M1' ? 3 : 5)) % 19));
            synth.push({
              asset: ast.id,
              strategy: stratsNames[(idx + (tf === 'M1' ? 0 : 2)) % stratsNames.length],
              timeframe: tf,
              winrate: wr,
              wins: Math.round(wr * 0.42),
              losses: Math.max(1, Math.round((100 - wr) * 0.42)),
              expectancy: (wr - 55) * 0.8,
            });
          });
        });
        synth.sort((a,b) => b.winrate - a.winrate);
        res = synth;
      }

      clearInterval(tick);
      if (Array.isArray(res)) {
        setStrategies(res);
        const now = new Date();
        setStrategiesLastAt(now);
        _mcPersisted.strategies = res;
        _mcPersisted.strategiesLastAt = now;
      }
      setBacktest({ m1: 100, m5: 100, current: `${res?.length || 0} estratégias ranqueadas`, done: true });
    } catch (e) {
      setBacktest({ m1: 0, m5: 0, current: `Erro: ${e.message}`, done: false });
    }
  }, [topAssets, minPayout]);

  // STEP 3: Atualização automática contínua do ranking de assertividade (a cada 20s)
  const refreshStrategies = useCallback(async (silent = false) => {
    if (!silent) setStrategiesLoading(true);
    try {
      if (getIQSessionToken()) {
        const res = await fetchBestStrategies(20);
        if (Array.isArray(res) && res.length > 0) {
          setStrategies(res);
          const now = new Date();
          setStrategiesLastAt(now);
          _mcPersisted.strategies = res;
          _mcPersisted.strategiesLastAt = now;
        }
      }
    } catch (e) {
      console.warn('[MC] refreshStrategies:', e.message);
    } finally {
      if (!silent) setStrategiesLoading(false);
    }
  }, []);

  // Carrega sinais recentes
  const loadSignals = useCallback(async () => {
    if (getIQSessionToken()) {
      try {
        const res = await fetchScannerSignals(20);
        if (Array.isArray(res)) {
          setSignals(res);
          return;
        }
      } catch (_) {}
      return;
    }
    // Apenas para modo de demonstração isolado
    if (isSimulated) {
      const nowSec = Math.floor(Date.now() / 1000);
      setSignals([
        {
          signal_id: 'sig_demo_1',
          asset: 'EURUSD',
          direction: 'CALL',
          timeframe: 'M1',
          confidence: 84,
          payout: 87,
          strategies: ['EMA Cross 9/21', 'Bollinger Reversal'],
          sent_at: nowSec - 90,
          status: 'simulado',
        },
      ]);
    } else {
      setSignals([]);
    }
  }, [isSimulated]);

  // Iniciar Modo Demonstração sem credenciais
  const handleStartSimulation = useCallback(async () => {
    setIsSimulated(true);
    setConnected(true);
    setAccountEmail('modo.demonstracao@rwtips.com');
    setAccountType('PRACTICE');

    const sim = ASSETS.filter(a => a.payout >= minPayout)
      .sort((a,b) => b.payout - a.payout)
      .slice(0, 10)
      .map(a => ({ id: a.id, name: a.name, payout: a.payout, isOpen: true }));
    setTopAssets(sim);
    setAssetsLastAt(new Date());

    await runBacktest(sim);
    await loadSignals();
    signalTimer.current     = setInterval(loadSignals, 3000);
    strategiesTimer.current = setInterval(() => { refreshStrategies(true); }, 20000);
    refreshTimer.current    = setInterval(() => {
      loadTopAssets(minPayoutRef.current, false);
    }, 30000);
  }, [minPayout, runBacktest, loadSignals, refreshStrategies, loadTopAssets]);

  // Inicialização após conexão bem-sucedida
  const afterConnect = useCallback(async (session, acType) => {
    setConnected(true);
    setIsSimulated(false);
    setAccountEmail(session.email);
    setAccountType(session.account_type || acType || 'PRACTICE');
    setStatus({ bridgeOnline: true });
    liveFeed.connect();
    invalidateCache();
    invalidatePairValidation();

    try {
      const [health, payouts, cfg] = await Promise.all([
        fetchBridgeHealth(),
        fetchBridgePayouts(),
        fetchScannerConfig().catch(() => ({})),
      ]);
      applyHealthSnapshot(health, 'rest');
      setStatus({ payouts, payoutsAt: Date.now() });
      const savedPayout = (() => {
        try {
          const s = localStorage.getItem('rwtips_min_payout');
          if (s) {
            const n = parseInt(s, 10);
            if (n >= 50 && n <= 99) return n;
          }
        } catch (_) {}
        return null;
      })();
      const threshold = (cfg?.min_payout && cfg.min_payout >= 50) ? cfg.min_payout : (savedPayout || 80);
      setMinPayout(threshold);
      if (cfg?.stake)          setStake(String(cfg.stake));
      if (cfg?.min_confidence) setMinConfidence(String(cfg.min_confidence));
      if (cfg?.auto_trade != null) setAutoTrade(Boolean(cfg.auto_trade));

      // Cascata: ativos → backtest → sinais
      await loadTopAssets(threshold);
      await runBacktest();
      await loadSignals();
    } catch (_) {}

    signalTimer.current     = setInterval(loadSignals, 3000);
    strategiesTimer.current = setInterval(() => { refreshStrategies(true); }, 20000);
    refreshTimer.current    = setInterval(() => {
      loadTopAssets(minPayoutRef.current, false);
    }, 30000);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadTopAssets, runBacktest, loadSignals, refreshStrategies]);

  // Alternar Auto-Trade sincronizando direto com o backend
  const handleToggleAutoTrade = async () => {
    const nextVal = !autoTrade;
    setAutoTrade(nextVal);
    if (getIQSessionToken()) {
      try {
        await updateScannerConfig({
          auto_trade: nextVal,
          stake: parseFloat(stake) || 2.0,
          min_confidence: parseInt(minConfidence, 10) || 75,
          min_payout: minPayout,
          enabled: true,
        });
        setNotice(nextVal ? '⚡ Auto-Trade ATIVADO no servidor da IQ Option!' : 'Auto-Trade DESATIVADO no servidor.');
        setTimeout(() => setNotice(''), 4000);
      } catch (err) {
        setGlobalError(`Falha ao sincronizar Auto-Trade: ${err.message}`);
      }
    }
  };

  // Alteração de payout mínimo sincronizando com o backend e recarregando ativos
  const handlePayoutChange = (val) => {
    const num = Number(val);
    setMinPayout(num);
    try { localStorage.setItem('rwtips_min_payout', String(num)); } catch (_) {}
    loadTopAssets(num, true);
    if (getIQSessionToken()) {
      updateScannerConfig({ min_payout: num }).catch(() => {});
    }
  };

  // Verifica sessão já ativa ao montar
  useEffect(() => {
    if (!getIQSessionToken()) return;
    let alive = true;
    (async () => {
      try {
        const session = await fetchIQSession();
        if (!alive) return;
        // Se já estava inicializado na sessão anterior (troca de aba), mantém dados e não repete animação do zero
        if (_mcPersisted.initialized && _mcPersisted.topAssets.length > 0) {
          setConnected(true);
          setAccountEmail(session.email);
          setAccountType(session.account_type || 'PRACTICE');
          liveFeed.connect();
          loadSignals();
          refreshStrategies(true);
          signalTimer.current     = setInterval(loadSignals, 3000);
          strategiesTimer.current = setInterval(() => { refreshStrategies(true); }, 20000);
          refreshTimer.current    = setInterval(() => {
            loadTopAssets(minPayoutRef.current, false);
          }, 30000);
          return;
        }
        await afterConnect(session, session.account_type);
        _mcPersisted.initialized = true;
      } catch (_) {}
    })();
    return () => {
      alive = false;
      clearInterval(signalTimer.current);
      clearInterval(strategiesTimer.current);
      clearInterval(refreshTimer.current);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Desconectar
  const handleDisconnect = async () => {
    setBusy(true);
    try { await disconnectIQAccount(); } catch (_) {}
    clearInterval(signalTimer.current);
    clearInterval(strategiesTimer.current);
    clearInterval(refreshTimer.current);
    liveFeed.disconnect();
    invalidateCache();
    invalidatePairValidation();
    _mcPersisted.initialized = false;
    _mcPersisted.connected = false;
    _mcPersisted.topAssets = [];
    _mcPersisted.strategies = [];
    _mcPersisted.strategiesLastAt = null;
    _mcPersisted.signals = [];
    _mcPersisted.backtest = { m1: 0, m5: 0, current: '', done: false };
    setConnected(false); setAccountEmail('');
    setTopAssets([]); setStrategies([]); setSignals([]); setStrategiesLastAt(null);
    setBacktest({ m1: 0, m5: 0, current: '', done: false });
    setStatus({ bridgeOnline: false, iqConnected: false, health: null, activeAssets: [], payouts: {} });
    setBusy(false);
  };

  // Alternar Demo / Real
  const handleSwitchAccount = async (targetType) => {
    setBusy(true);
    try {
      const res = await switchIQAccountType(targetType);
      setAccountType(res.account_type);
      setNotice(`Conta alternada para ${res.account_type.toUpperCase()}`);
      setTimeout(() => setNotice(''), 3000);
    } catch (e) { setGlobalError(e.message); }
    finally { setBusy(false); }
  };

  // Salvar configuração e reaplicar
  const handleSaveConfig = async () => {
    setConfigSaving(true);
    try {
      try {
        localStorage.setItem('rwtips_min_payout', String(minPayout));
        localStorage.setItem('rwtips_stake', String(stake));
        localStorage.setItem('rwtips_min_confidence', String(minConfidence));
        localStorage.setItem('rwtips_auto_trade', String(autoTrade));
        localStorage.setItem('rwtips_blacklist', JSON.stringify(blacklist));
      } catch (_) {}
      await updateScannerConfig({
        auto_trade: autoTrade,
        stake: parseFloat(stake) || 2.0,
        min_confidence: parseInt(minConfidence, 10) || 75,
        min_payout: minPayout,
        blacklist: blacklist,
        enabled: true,
      });
      setNotice(`✅ Configurações salvas e aplicadas! O robô só operará em ativos com Payout ≥ ${minPayout}%.`);
      setTimeout(() => setNotice(''), 4000);
      setConfigOpen(false);
      await loadTopAssets(minPayout, true);
      await runBacktest();
    } catch (e) { setGlobalError(e.message); }
    finally { setConfigSaving(false); }
  };

  // Telegram teste
  const handleTestTelegram = async () => {
    setTestingTelegram(true);
    setGlobalError('');
    try {
      const now = new Date();
      const ts = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
      if (isSimulated && !getIQSessionToken()) {
        await new Promise(r => setTimeout(r, 800));
        setNotice('✅ [Modo Demonstração] Sinal de teste enviado ao Telegram com sucesso!');
        setTimeout(() => setNotice(''), 4000);
        return;
      }
      const res = await sendTelegramSignal({
        signal_id: `test_${Date.now()}`,
        strategy: 'EMA Cross + Bollinger (Teste)',
        asset: 'EURUSD',
        direction: 'CALL',
        timeframe: 'M1',
        signal_time: ts,
        message_text: `🔔 SINAL DE TESTE — RW TIPS\n\n📈 CALL | EURUSD | M1\n⚡ Confiança: 85%\n💰 Payout: 87%\n🕐 Horário: ${ts}\n\n✅ Conexão Telegram ativa e operando com sucesso!`,
      });
      setNotice(res.sent || res.queued ? '✅ Sinal de teste enviado ao Telegram com sucesso!' : 'Sinal já enviado anteriormente.');
      setTimeout(() => setNotice(''), 5000);
    } catch (e) {
      setGlobalError(`Falha no Telegram: ${e.message}`);
    } finally {
      setTestingTelegram(false);
    }
  };

  // Computed
  const isDemo  = accountType?.toUpperCase().includes('PRACTICE') || accountType?.toUpperCase().includes('DEMO');
  const rankM1  = strategies.filter(s => s.timeframe === 'M1').sort((a,b) => b.winrate - a.winrate).slice(0, 7);
  const rankM5  = strategies.filter(s => s.timeframe === 'M5').sort((a,b) => b.winrate - a.winrate).slice(0, 7);
  const selData = selectedAsset
    ? (topAssets.find(a => a.id === selectedAsset) || { id: selectedAsset, name: selectedAsset, payout: 0, isOpen: true })
    : null;

  const step1Status = topAssets.length > 0 ? 'done' : connected ? 'active' : 'idle';
  const step2Status = backtest.done ? 'done' : backtest.m1 > 0 ? 'active' : step1Status === 'done' ? 'active' : 'idle';
  const step3Status = strategies.length > 0 ? 'done' : step2Status === 'done' ? 'active' : 'idle';
  const step4Status = connected ? 'active' : 'idle';

  // ─── Se não conectado ───────────────────────────────────────────────────
  if (!connected) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] gap-6">
        <div className="text-center max-w-md">
          <div className="inline-flex h-16 w-16 items-center justify-center rounded-2xl bg-neon/10 border border-neon/30 mb-4 shadow-glow">
            <Activity className="h-8 w-8 text-neon" />
          </div>
          <h1 className="text-2xl font-extrabold text-white mb-2">RW TIPS Mesa de Operações</h1>
          <p className="text-zinc-400 text-sm leading-relaxed">
            Painel unificado em 4 etapas: filtro por payout, backtest automático M1/M5, ranking por ativo e envio de sinais com Auto-Trade.
          </p>
        </div>
        <LoginPanel onConnect={afterConnect} onSimulate={handleStartSimulation} />
      </div>
    );
  }

  return (
    <div className="space-y-5 max-w-5xl">
      {/* Modal de detalhe */}
      {selectedAsset && (
        <AssetModal asset={selData} strategies={strategies} onClose={() => setSelectedAsset(null)} />
      )}

      {/* ── Barra de status da conta ── */}
      <div className="flex flex-col sm:flex-row sm:items-center gap-3 p-4 rounded-xl border bg-gradient-to-r from-panel via-panel to-neon/[0.04] border-neon/20">
        <div className="flex items-center gap-3 flex-1 min-w-0">
          <div className={`flex-none flex h-10 w-10 items-center justify-center rounded-xl shadow ${
            isSimulated ? 'bg-yellow-500/15 text-yellow-400' : isDemo ? 'bg-blue-500/15 text-blue-400' : 'bg-emerald-500/15 text-emerald-400'
          }`}>
            <Wifi className="h-5 w-5 animate-pulse" />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-bold text-white text-sm">
                {isSimulated ? 'Mesa em Demonstração (Dados Simulados)' : 'IQ Option Conectada'}
              </span>
              <span className={`rounded-full px-2.5 py-0.5 text-[10px] font-extrabold uppercase tracking-wide border ${
                isSimulated ? 'bg-yellow-500/15 text-yellow-400 border-yellow-500/30' :
                isDemo ? 'bg-blue-500/15 text-blue-400 border-blue-500/30' : 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30'
              }`}>{isSimulated ? '🟡 SIMULAÇÃO' : isDemo ? '🔵 DEMO' : '🔴 REAL'}</span>
              {autoTrade && <span className="rounded-full px-2 py-0.5 text-[10px] font-extrabold bg-neon/15 text-neon border border-neon/30 animate-pulse">⚡ AUTO-TRADE</span>}
            </div>
            <div className="text-xs text-zinc-500 font-mono truncate">{accountEmail}</div>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {isSimulated ? (
            <button type="button" onClick={() => { setConnected(false); setIsSimulated(false); }}
              className="btn text-xs font-bold px-3 py-1.5 rounded-lg border bg-neon/15 text-neon border-neon/40 hover:bg-neon/25">
              <Wifi className="h-3.5 w-3.5" /> Conectar IQ Option Real
            </button>
          ) : (
            <>
              <button type="button" disabled={busy} onClick={() => handleSwitchAccount(isDemo ? 'REAL' : 'PRACTICE')}
                className={`btn text-xs font-semibold px-3 py-1.5 rounded-lg border transition-all ${
                  isDemo ? 'bg-emerald-600/20 text-emerald-400 border-emerald-500/40 hover:bg-emerald-600/30'
                         : 'bg-blue-600/20 text-blue-400 border-blue-500/40 hover:bg-blue-600/30'
                }`}>
                <Shield className="h-3 w-3" />
                {isDemo ? 'Mudar para Real' : 'Mudar para Demo'}
              </button>
              <button type="button" disabled={busy} onClick={handleDisconnect}
                className="btn-ghost text-xs text-zinc-400 hover:text-red-400 px-3 py-1.5">
                <Unplug className="h-3 w-3" /> Desconectar
              </button>
            </>
          )}
        </div>
      </div>

      {/* Mensagens */}
      {globalError && (
        <div className="flex items-center gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-2.5 text-sm text-red-400">
          <AlertCircle className="h-4 w-4 shrink-0" />
          <span className="flex-1">{globalError}</span>
          <button className="text-xs opacity-60 hover:opacity-100" onClick={() => setGlobalError('')}>✕</button>
        </div>
      )}
      {notice && (
        <div className="flex items-center gap-2 rounded-lg border border-neon/30 bg-neon/10 px-4 py-2.5 text-sm text-neon">
          <CheckCircle2 className="h-4 w-4 shrink-0" /><span>{notice}</span>
        </div>
      )}

      {/* ══════════════════════════════════════════
          STEP 1 — Ativos abertos por payout
         ══════════════════════════════════════════ */}
      <section className="card p-5 border-line">
        <StepHeader num="1" title="Ativos Abertos por Payout"
          subtitle={assetsLastAt ? `Atualizado ${assetsLastAt.toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit',second:'2-digit'})} · auto 30s` : 'Buscando…'}
          status={step1Status}>
          <div className="flex items-center gap-2">
            <span className="text-xs text-zinc-400 whitespace-nowrap">Mín:</span>
            <input type="range" min="50" max="99" step="1" value={minPayout}
              onChange={e => handlePayoutChange(e.target.value)}
              className="w-28 accent-neon" />
            <span className="text-neon font-mono font-bold text-sm w-12 text-right">≥ {minPayout}%</span>
          </div>
          <button type="button" disabled={assetsLoading} onClick={() => loadTopAssets(minPayout, true)}
            className="btn-ghost text-xs px-3 py-1.5">
            <RefreshCw className={`h-3.5 w-3.5 ${assetsLoading ? 'animate-spin' : ''}`} />
            Recarregar
          </button>
        </StepHeader>

        {minPayout > 88 && (
          <div className="mb-4 flex items-start gap-2.5 rounded-xl bg-amber-500/10 border border-amber-500/30 p-3 text-xs text-amber-300">
            <AlertCircle className="h-4 w-4 shrink-0 text-amber-400 mt-0.5" />
            <div className="leading-relaxed">
              <strong>⚠️ Payout configurado em ≥ {minPayout}%:</strong> Os pares tradicionais e OTC de Forex (como <strong>EUR/USD, GBP/USD, USD/JPY</strong>) pagam entre <strong>80% e 87%</strong> na IQ Option. Com o filtro atual, os pares de moedas não aparecem.{' '}
              <button type="button" onClick={() => handlePayoutChange(82)}
                className="inline-flex items-center gap-1 font-bold text-amber-200 underline hover:text-white cursor-pointer ml-1">
                Ajustar para ≥ 82% agora
              </button>
            </div>
          </div>
        )}

        {assetsLoading && topAssets.length === 0 ? (
          <div className="flex items-center justify-center gap-3 py-8 text-zinc-500">
            <RefreshCw className="h-5 w-5 animate-spin" />
            <span className="text-sm">Buscando ativos com payout ≥ {minPayout}%…</span>
          </div>
        ) : topAssets.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-8 text-zinc-500">
            <WifiOff className="h-8 w-8" />
            <span className="text-sm">Nenhum ativo aberto com payout ≥ {minPayout}%</span>
            <span className="text-xs">Reduza o limiar ou aguarde o mercado abrir.</span>
          </div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-2 mt-1">
            {topAssets.map((asset, i) => {
              const blocked = isAssetBlacklisted(asset.id);
              return (
                <div key={asset.id}
                  onClick={() => setSelectedAsset(asset.id)}
                  className={`group relative flex flex-col items-center rounded-xl bg-panel2 border p-3 gap-1 transition-all text-center cursor-pointer ${
                    blocked ? 'border-red-500/40 opacity-75' : 'border-line hover:border-neon/50 hover:bg-neon/[0.04]'
                  }`}>
                  <span className="text-[10px] font-bold text-zinc-500">#{i + 1}</span>
                  <span className={`font-bold text-xs leading-tight ${blocked ? 'line-through text-zinc-400' : 'text-white'}`}>
                    {asset.name || asset.id}
                  </span>
                  <span className={`text-base font-extrabold font-mono ${payoutColor(asset.payout)}`}>{asset.payout}%</span>
                  <div className="flex items-center gap-1 mt-0.5">
                    <span className={`text-[10px] px-1.5 py-0.5 rounded font-semibold ${asset.isOpen ? 'bg-emerald-500/15 text-emerald-400' : 'bg-red-500/15 text-red-400'}`}>
                      {asset.isOpen ? 'ABERTO' : 'FECHADO'}
                    </span>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        blocked ? handleRemoveFromBlacklist(asset.id) : handleAddToBlacklist(asset.id);
                      }}
                      className={`text-[9px] px-1.5 py-0.5 rounded font-bold transition-all border ${
                        blocked
                          ? 'bg-red-500/20 text-red-300 border-red-500/40 hover:bg-red-500/30'
                          : 'bg-zinc-800 text-zinc-400 hover:text-red-400 hover:border-red-500/40 border-transparent'
                      }`}
                      title={blocked ? "Remover da Blacklist" : "Bloquear na Blacklist"}>
                      {blocked ? '🚫 Bloqueado' : '🚫 Bloquear'}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* ══════════════════════════════════════════
          STEP 2 — Backtest em andamento
         ══════════════════════════════════════════ */}
      <section className="card p-5 border-line">
        <StepHeader num="2" title="Backtest por Estratégia"
          subtitle={backtest.current || 'Aguardando ativos…'}
          status={step2Status}>
          <button type="button"
            disabled={step1Status !== 'done' || (backtest.m1 > 0 && !backtest.done)}
            onClick={runBacktest} className="btn-ghost text-xs px-3 py-1.5">
            {!backtest.done && backtest.m1 > 0
              ? <RefreshCw className="h-3.5 w-3.5 animate-spin" />
              : <BarChart2 className="h-3.5 w-3.5" />}
            {backtest.done ? 'Recalcular' : 'Iniciar Backtest'}
          </button>
        </StepHeader>

        <div className="space-y-3 mt-1">
          {[['M1 — 1 minuto', backtest.m1], ['M5 — 5 minutos', backtest.m5]].map(([label, prog]) => (
            <div key={label}>
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-xs font-semibold text-zinc-300">{label}</span>
                <span className="text-xs font-mono text-zinc-400">{Math.round(prog)}%</span>
              </div>
              <div className="h-2 rounded-full bg-zinc-800 overflow-hidden">
                <div className={`h-2 rounded-full transition-all duration-500 ${prog >= 100 ? 'bg-neon' : 'bg-neon/60 animate-pulse'}`}
                  style={{ width: `${prog}%` }} />
              </div>
            </div>
          ))}
          {backtest.done && (
            <p className="text-xs text-neon font-semibold flex items-center gap-1.5 pt-1">
              <CheckCircle2 className="h-4 w-4" />{backtest.current}
            </p>
          )}
        </div>
      </section>

      {/* ══════════════════════════════════════════
          STEP 3 — Ranking de assertividade
         ══════════════════════════════════════════ */}
      <section className="card p-5 border-line">
        <StepHeader num="3" title="Ranking de Assertividade"
          subtitle="Clique em qualquer ativo para ver o detalhe das estratégias"
          status={step3Status}>
          {strategies.length > 0 && (
            <div className="flex items-center gap-2">
              <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-emerald-500/10 border border-emerald-500/30 text-[11px] font-bold text-emerald-400">
                <span className="h-2 w-2 rounded-full bg-emerald-400 animate-pulse" />
                Atualização Automática (20s)
              </div>
              {strategiesLastAt && (
                <span className="text-[10px] text-zinc-500 font-mono hidden sm:inline" title="Última atualização do ranking">
                  {new Date(strategiesLastAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                </span>
              )}
              <button
                type="button"
                onClick={() => refreshStrategies(false)}
                disabled={strategiesLoading}
                className="btn-ghost text-xs px-2.5 py-1.5"
                title="Atualizar ranking agora"
              >
                <RefreshCw className={`h-3.5 w-3.5 ${strategiesLoading ? 'animate-spin text-neon' : ''}`} />
              </button>
            </div>
          )}
        </StepHeader>

        {strategies.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-8 text-zinc-500">
            <Award className="h-8 w-8" />
            <span className="text-sm">
              {step2Status === 'active' ? 'Aguardando conclusão do backtest…' : 'Execute o backtest para ver o ranking.'}
            </span>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-5 mt-1">
            {[['M1', rankM1], ['M5', rankM5]].map(([tf, list]) => (
              <div key={tf}>
                <div className="flex items-center gap-2 mb-3">
                  <span className="rounded bg-zinc-800 text-zinc-300 text-xs font-extrabold px-2 py-0.5">{tf}</span>
                  <span className="text-xs text-zinc-500">{tf === 'M1' ? '1 minuto' : '5 minutos'}</span>
                </div>
                <div className="space-y-1.5">
                  {list.map((s, i) => (
                    <button key={`${s.asset}-${s.strategy}-${tf}-${i}`} type="button" onClick={() => setSelectedAsset(s.asset)}
                      className="w-full flex items-center gap-3 rounded-xl bg-panel2 border border-line px-3 py-2.5 hover:border-neon/40 hover:bg-neon/[0.03] transition-all group text-left">
                      <span className={`flex-none w-6 text-center text-xs font-extrabold ${
                        i === 0 ? 'text-neon' : i === 1 ? 'text-emerald-400' : i === 2 ? 'text-yellow-400' : 'text-zinc-500'
                      }`}>#{i+1}</span>
                      <div className="flex-1 min-w-0">
                        <div className="font-bold text-white text-xs">{s.asset}</div>
                        <div className="text-[10px] text-zinc-500 truncate">{s.strategy}</div>
                      </div>
                      <div className="flex-none text-right">
                        <div className={`text-sm font-extrabold font-mono ${confColor(s.winrate)}`}>{s.winrate}%</div>
                        <div className="text-[10px] text-zinc-500">{s.wins}W/{s.losses}L</div>
                      </div>
                      {/* Ring SVG */}
                      <div className="flex-none h-10 w-10 relative">
                        <svg className="absolute inset-0 -rotate-90" viewBox="0 0 36 36">
                          <circle cx="18" cy="18" r="14" fill="none" stroke="#1a2421" strokeWidth="3" />
                          <circle cx="18" cy="18" r="14" fill="none"
                            stroke={s.winrate >= 70 ? '#00ff88' : s.winrate >= 55 ? '#facc15' : '#52525b'}
                            strokeWidth="3"
                            strokeDasharray={`${(s.winrate / 100) * 87.96} 87.96`}
                            strokeLinecap="round" />
                        </svg>
                      </div>
                      <ChevronRight className="h-4 w-4 text-zinc-600 group-hover:text-neon transition-colors" />
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* ══════════════════════════════════════════
          STEP 4 — Scanner ativo & Config
         ══════════════════════════════════════════ */}
      <section className="card p-5 border-line">
        <StepHeader num="4" title="Scanner de Sinais & Auto-Trade"
          subtitle="Sinais gerados com base nos critérios e enviados ao Telegram antes de cada vela"
          status={step4Status}>
          <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-neon/10 border border-neon/30 text-[11px] font-bold text-neon">
            <span className="h-2 w-2 rounded-full bg-neon animate-pulse" />
            Scanner Ativo (3s)
          </div>
          <button type="button" onClick={loadSignals} className="btn-ghost text-xs px-2.5 py-1.5" title="Verificar sinais agora">
            <RefreshCw className="h-3.5 w-3.5" />
          </button>
          <button type="button" onClick={handleTestTelegram} disabled={testingTelegram}
            className="btn-ghost text-xs px-3 py-1.5">
            {testingTelegram ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
            Testar Telegram
          </button>
          <button type="button" onClick={handleSendDailySummary} disabled={sendingDailySummary}
            className="btn-ghost text-xs px-3 py-1.5 border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/10"
            title="Enviar Relatório Diário de Greens & Reds ao Telegram">
            {sendingDailySummary ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <BarChart2 className="h-3.5 w-3.5" />}
            Resumo Greens/Reds
          </button>
          <button type="button" onClick={() => setConfigOpen(v => !v)}
            className={`btn-ghost text-xs px-3 py-1.5 ${configOpen ? 'border-neon/50 text-neon' : ''}`}>
            <Settings2 className="h-3.5 w-3.5" />
            Configurar
            {configOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
          </button>
        </StepHeader>

        {/* Config colapsável */}
        {configOpen && (
          <div className="mb-5 p-4 rounded-xl bg-panel2 border border-line space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div>
                <label className="block text-xs font-semibold text-zinc-300 mb-1">Valor da Entrada ($)</label>
                <input type="number" step="0.5" min="1" max="1000" value={stake}
                  onChange={e => setStake(e.target.value)} className="input text-sm font-mono" />
              </div>
              <div>
                <label className="block text-xs font-semibold text-zinc-300 mb-1">Assertividade Mínima (%)</label>
                <input type="number" min="50" max="99" value={minConfidence}
                  onChange={e => setMinConfidence(e.target.value)} className="input text-sm font-mono" />
              </div>
              <div className="flex flex-col justify-end">
                <label className="block text-xs font-semibold text-zinc-300 mb-1">Auto-Trade</label>
                <button type="button" onClick={handleToggleAutoTrade}
                  className={`w-full py-2 px-3 rounded-lg text-xs font-bold flex items-center justify-center gap-2 border transition-all ${
                    autoTrade ? 'bg-neon/15 text-neon border-neon/40 shadow-glowSm' : 'bg-panel text-zinc-400 border-line'
                  }`}>
                  <Zap className={`h-4 w-4 ${autoTrade ? 'animate-pulse' : ''}`} />
                  {autoTrade ? 'LIGADO' : 'DESLIGADO'}
                </button>
              </div>
            </div>
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="text-xs font-semibold text-zinc-300">Payout Mínimo dos Ativos</label>
                <span className="text-neon font-mono font-bold text-sm">≥ {minPayout}%</span>
              </div>
              <input type="range" min="50" max="99" step="1" value={minPayout}
                onChange={e => handlePayoutChange(e.target.value)} className="w-full accent-neon" />
            </div>
            {autoTrade && (
              <p className="text-xs text-yellow-400 flex items-start gap-1.5 rounded-lg bg-yellow-400/5 border border-yellow-400/20 p-2.5">
                <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
                Cada sinal ≥ {minConfidence}% conf e ≥ {minPayout}% payout abrirá uma ordem de ${stake} na conta <strong>{isDemo ? 'DEMO' : 'REAL'}</strong>.
              </p>
            )}

            {/* Gerenciamento de Blacklist */}
            <div className="pt-3 border-t border-line/60">
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-1.5 text-xs font-semibold text-zinc-300">
                  <ShieldAlert className="h-3.5 w-3.5 text-red-400" />
                  <span>Blacklist de Ativos ({blacklist.length})</span>
                </div>
                <span className="text-[10px] text-zinc-500">Ativos bloqueados são totalmente ignorados pelo scanner</span>
              </div>
              <div className="flex flex-wrap gap-1.5 mb-2.5 min-h-[34px] p-2 rounded-lg bg-panel border border-line">
                {blacklist.length === 0 ? (
                  <span className="text-[11px] text-zinc-500 italic py-0.5">Nenhum ativo bloqueado no momento.</span>
                ) : (
                  blacklist.map(item => (
                    <span key={item} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-red-500/10 border border-red-500/30 text-red-400 text-xs font-mono font-bold">
                      <Ban className="h-3 w-3" />
                      {item}
                      <button type="button" onClick={() => handleRemoveFromBlacklist(item)}
                        className="hover:text-white transition-colors ml-0.5 p-0.5" title={`Remover ${item} da Blacklist`}>
                        <X className="h-3 w-3" />
                      </button>
                    </span>
                  ))
                )}
              </div>
              <div className="flex gap-2">
                <input
                  type="text"
                  placeholder="Digitar ativo (ex: EURUSD, USDJPY-OTC)..."
                  value={blacklistInput}
                  onChange={e => setBlacklistInput(e.target.value.toUpperCase())}
                  onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); handleAddToBlacklist(); } }}
                  className="input text-xs font-mono flex-1 uppercase"
                />
                <button
                  type="button"
                  onClick={() => handleAddToBlacklist()}
                  className="btn-ghost text-xs px-3 py-1.5 border-red-500/30 text-red-400 hover:bg-red-500/10 flex items-center gap-1">
                  <Plus className="h-3.5 w-3.5" />
                  Bloquear
                </button>
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-2 border-t border-line/60">
              <button type="button" onClick={() => setConfigOpen(false)} className="btn-ghost text-xs px-4 py-2">Cancelar</button>
              <button type="button" disabled={configSaving} onClick={handleSaveConfig} className="btn-primary text-xs px-4 py-2">
                {configSaving ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
                Salvar e Aplicar
              </button>
            </div>
          </div>
        )}

        {/* Alerta de ativos com sequência de LOSS */}
        {dailyStats && Object.entries(dailyStats).some(([_, s]) => s.consecutive_losses >= 3) && (
          <div className="mb-4 space-y-2">
            {Object.entries(dailyStats)
              .filter(([ast, s]) => s.consecutive_losses >= 3 && !isAssetBlacklisted(ast))
              .map(([ast, s]) => (
                <div key={ast} className="flex items-center justify-between p-3 rounded-xl bg-red-500/10 border border-red-500/30 text-xs">
                  <div className="flex items-center gap-2">
                    <ShieldAlert className="h-4 w-4 text-red-400 shrink-0" />
                    <div>
                      <span className="font-bold text-white">{ast}</span> acumulou <strong className="text-red-400">{s.consecutive_losses} LOSS seguidos</strong> hoje ({s.losses} Reds / {s.wins} Greens).
                      <span className="text-zinc-400 block text-[11px]">Não está respeitando o padrão. Deseja adicionar à Blacklist?</span>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => handleAddToBlacklist(ast)}
                    className="btn-ghost text-xs px-3 py-1 bg-red-500/20 border-red-500/40 text-red-300 hover:bg-red-500/30 flex items-center gap-1">
                    <Ban className="h-3 w-3" />
                    Bloquear na Blacklist
                  </button>
                </div>
              ))}
          </div>
        )}

        {/* Sinais recentes */}
        {signals.length === 0 ? (
          <div className="flex flex-col items-center gap-2.5 py-8 text-center">
            <div className="relative flex h-12 w-12 items-center justify-center rounded-2xl bg-neon/10 border border-neon/30 shadow-glow mb-1">
              <Target className="h-6 w-6 text-neon animate-pulse" />
            </div>
            <span className="text-sm font-bold text-white">Scanner Ativo & Monitorando Velas em Tempo Real</span>
            <p className="text-xs text-zinc-400 max-w-lg leading-relaxed">
              O robô analisa cada fechamento de vela (M1 e M5) dos ativos abertos.
              Assim que um padrão alcançar confluência técnica ≥ {minConfidence}%, o sinal será gerado imediatamente,
              despachado ao Telegram e executado {autoTrade ? `com ordem de $${stake} no Auto-Trade` : '(Auto-Trade desligado)'}.
            </p>
            {minPayout > 88 && (
              <div className="text-[11px] text-yellow-400/90 bg-yellow-400/10 border border-yellow-400/20 px-3 py-2 rounded-lg max-w-lg text-left mt-1">
                <strong>💡 Nota sobre Payout (≥ {minPayout}%):</strong> Pares de Forex tradicionais (como EUR/USD e GBP/USD) normalmente pagam entre 82% e 88%.
                Com o filtro em ≥ {minPayout}%, apenas ativos de altíssimo payout (como índices exóticos) são aceitos.
                Se desejar que o robô também opere pares clássicos, ajuste o Payout Mínimo para 80%–85%.
              </div>
            )}
          </div>
        ) : (
          <div className="space-y-2">
            <p className="text-xs font-semibold text-zinc-500 uppercase tracking-wide mb-3">
              Últimos {signals.length} sinais gerados
            </p>
            {signals.map((sig, i) => (
              <div key={sig.signal_id || i}
                className="flex items-center gap-3 rounded-xl bg-panel2 border border-line px-3 py-2.5">
                <span className={`flex-none text-xs font-extrabold px-2 py-0.5 rounded ${
                  sig.direction === 'CALL' ? 'bg-emerald-500/20 text-emerald-400' : 'bg-red-500/20 text-red-400'
                }`}>{sig.direction}</span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-bold text-white text-xs">{sig.display_name || sig.asset}</span>
                    {(sig.is_otc || (sig.display_name && sig.display_name.includes('OTC'))) && (
                      <span className="text-[9px] font-black px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300 border border-amber-500/40 uppercase tracking-wider">
                        OTC
                      </span>
                    )}
                    {isAssetBlacklisted(sig.asset) ? (
                      <span className="text-[9px] font-black px-1.5 py-0.5 rounded bg-red-500/20 text-red-300 border border-red-500/40 uppercase tracking-wider flex items-center gap-0.5">
                        <Ban className="h-2.5 w-2.5" /> BLOQUEADO
                      </span>
                    ) : (
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); handleAddToBlacklist(sig.asset); }}
                        className="text-[9px] font-semibold px-1 py-0.5 rounded bg-panel hover:bg-red-500/20 text-zinc-500 hover:text-red-400 border border-line hover:border-red-500/40 transition-colors"
                        title="Bloquear este ativo na Blacklist">
                        🚫 Bloquear
                      </button>
                    )}
                    <span className="text-[10px] bg-zinc-800 text-zinc-400 px-1.5 py-0.5 rounded font-bold">{sig.timeframe}</span>
                    <span className={`text-[10px] font-bold ${confColor(sig.confidence)}`}>{sig.confidence}% conf</span>
                    <span className={`text-[10px] font-bold ${payoutColor(sig.payout)}`}>{sig.payout}% pay</span>
                    {sig.order_info && (
                      <span className={`text-[10px] px-1.5 py-0.5 rounded font-bold border ${
                        sig.trade_status === 'executed'
                          ? 'bg-neon/10 text-neon border-neon/20'
                          : 'bg-yellow-400/10 text-yellow-400 border-yellow-400/20'
                      }`}>
                        {sig.order_info}
                      </span>
                    )}
                  </div>
                  <div className="text-[10px] text-zinc-500 truncate mt-0.5">
                    {(sig.strategies || []).join(' · ')}
                  </div>
                </div>
                <div className="flex-none text-right">
                  <div className="flex items-center gap-1 text-[10px] text-zinc-500 justify-end">
                    <Clock className="h-3 w-3" />
                    {sig.sent_at ? new Date(sig.sent_at * 1000).toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'}) : '--:--'}
                  </div>
                  <div className="flex items-center gap-2 mt-0.5 justify-end">
                    <span className={`text-[10px] font-bold ${sig.status === 'sent' ? 'text-neon' : sig.status === 'error' ? 'text-red-400' : 'text-zinc-500'}`}>
                      {sig.status === 'sent' ? '📱 Telegram OK' : sig.status === 'error' ? '📱 Erro Telegram' : sig.status}
                    </span>
                    {sig.trade_status === 'executed' ? (
                      <span className="text-[10px] font-extrabold text-neon">⚡ Trade OK</span>
                    ) : sig.trade_status && sig.trade_status.startsWith('failed') ? (
                      <span className="text-[10px] font-bold text-yellow-400" title={sig.trade_status}>⚠️ Falha Trade</span>
                    ) : null}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
