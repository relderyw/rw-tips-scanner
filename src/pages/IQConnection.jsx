import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  RefreshCw, Unplug, Wifi, Radio, ArrowRight, CheckCircle2,
  ScanSearch, Shield, Zap, Send, TrendingUp, Sliders, AlertCircle
} from 'lucide-react';
import { PageHeader } from '../components/ui.jsx';
import {
  getIQSessionToken, connectIQAccount, disconnectIQAccount, fetchIQSession,
  fetchBridgeHealth, fetchBridgePayouts, switchIQAccountType,
  fetchScannerConfig, updateScannerConfig, fetchScannerSignals,
  fetchBestStrategies, sendTelegramSignal, fetchTelegramStatus
} from '../services/bridgeApi.js';
import { applyHealthSnapshot, setStatus } from '../services/dataStatus.js';
import { liveFeed } from '../services/liveFeed.js';
import { invalidateCache } from '../lib/runner.js';
import { invalidatePairValidation, refreshCatalog } from '../lib/strategyValidation.js';
import { refreshIQActives, refreshTopPayoutActives } from '../data/candleData.js';

export default function IQConnection() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [accountType, setAccountType] = useState('PRACTICE');
  const [currentAccountType, setCurrentAccountType] = useState('PRACTICE');
  const [accountEmail, setAccountEmail] = useState('');
  const [connected, setConnected] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  // Scanner config state
  const [autoTrade, setAutoTrade] = useState(false);
  const [stake, setStake] = useState('2.0');
  const [minConfidence, setMinConfidence] = useState('75');
  const [minPayout, setMinPayout] = useState('80');
  const [scannerSaving, setScannerSaving] = useState(false);
  const [topAssets, setTopAssets] = useState([]);

  // Best strategies and signals state
  const [bestStrategies, setBestStrategies] = useState([]);
  const [signals, setSignals] = useState([]);
  const [telegramOk, setTelegramOk] = useState(true);
  const [testingTelegram, setTestingTelegram] = useState(false);

  useEffect(() => {
    if (!getIQSessionToken()) return undefined;
    let active = true;
    (async () => {
      try {
        const session = await fetchIQSession();
        if (!active) return;
        setAccountEmail(session.email);
        setConnected(Boolean(session.connected));
        setCurrentAccountType(session.account_type || 'PRACTICE');
        liveFeed.connect();
      } catch (requestError) {
        if (!active) return;
        setError(requestError.message);
        liveFeed.disconnect();
        setConnected(false);
        return;
      }
      try {
        const [health, payouts, scannerCfg, stratList, sigList, tgStatus] = await Promise.all([
          fetchBridgeHealth(),
          fetchBridgePayouts(),
          fetchScannerConfig().catch(() => ({})),
          fetchBestStrategies(10).catch(() => []),
          fetchScannerSignals(10).catch(() => []),
          fetchTelegramStatus().catch(() => ({ configured: true }))
        ]);
        if (!active) return;
        applyHealthSnapshot(health, 'rest');
        setStatus({ payouts, payoutsAt: Date.now() });
        await refreshIQActives();

        if (scannerCfg) {
          setAutoTrade(Boolean(scannerCfg.auto_trade));
          if (scannerCfg.stake) setStake(String(scannerCfg.stake));
          if (scannerCfg.min_confidence) setMinConfidence(String(scannerCfg.min_confidence));
          if (scannerCfg.min_payout) {
            setMinPayout(String(scannerCfg.min_payout));
            try { localStorage.setItem('rwtips_min_payout', String(scannerCfg.min_payout)); } catch (_) {}
          }
        }
        if (Array.isArray(stratList)) setBestStrategies(stratList);
        if (Array.isArray(sigList)) setSignals(sigList);
        if (tgStatus?.configured !== undefined) setTelegramOk(tgStatus.configured);
        // Payout-first: carrega apenas ativos com payout >= limiar configurado
        try {
          const threshold = scannerCfg?.min_payout || 80;
          const top = await refreshTopPayoutActives(threshold, 10);
          if (Array.isArray(top)) setTopAssets(top);
        } catch (_) { /* fallback silencioso */ }
      } catch (requestError) {
        if (active) setError(`Conta conectada, mas houve falha ao carregar métricas: ${requestError.message}`);
      }
    })();
    return () => { active = false; };
  }, []);

  const handleConnect = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const session = await connectIQAccount(email, password, accountType);
      setAccountEmail(session.email);
      setConnected(true);
      setCurrentAccountType(session.account_type || accountType);
      setPassword('');
      setEmail('');
      setStatus({ bridgeOnline: true, candles: 'unknown' });
      liveFeed.connect();
      invalidateCache();
      invalidatePairValidation();
      const [health, payouts, stratList] = await Promise.all([
        fetchBridgeHealth(),
        fetchBridgePayouts(),
        fetchBestStrategies(10).catch(() => [])
      ]);
      applyHealthSnapshot(health, 'rest');
      setStatus({ payouts, payoutsAt: Date.now() });
      if (Array.isArray(stratList)) setBestStrategies(stratList);
      // Payout-first connect: carrega top ativos imediatamente
      const threshold = parseInt(minPayout, 10) || 80;
      const top = await refreshTopPayoutActives(threshold, 10).catch(() => []);
      if (Array.isArray(top)) setTopAssets(top);
      refreshCatalog({ force: true }).catch((catalogError) => {
        console.error('[IQConnection] falha ao atualizar catálogo:', catalogError);
      });
      setNotice(`Conta ${accountType === 'REAL' ? 'REAL' : 'DEMO (PRACTICE)'} conectada com sucesso! Scanner ativo.`);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusy(false);
    }
  };

  const handleSwitchAccount = async (targetType) => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const res = await switchIQAccountType(targetType);
      setCurrentAccountType(res.account_type);
      setNotice(`Conta alternada para modo: ${res.account_type.toUpperCase()}`);
    } catch (e) {
      setError(`Falha ao trocar tipo de conta: ${e.message}`);
    } finally {
      setBusy(false);
    }
  };

  const handleSaveScannerConfig = async (e) => {
    e.preventDefault();
    setScannerSaving(true);
    setError('');
    setNotice('');
    try {
      const payoutThreshold = parseInt(minPayout, 10) || 80;
      try { localStorage.setItem('rwtips_min_payout', String(payoutThreshold)); } catch (_) {}
      const res = await updateScannerConfig({
        auto_trade: autoTrade,
        stake: parseFloat(stake) || 2.0,
        min_confidence: parseInt(minConfidence, 10) || 75,
        min_payout: payoutThreshold,
      });
      setAutoTrade(res.auto_trade);
      setNotice('Parâmetros do scanner e auto-trade salvos com sucesso!');
      // Atualiza a lista de ativos com o novo limiar de payout
      const top = await refreshTopPayoutActives(payoutThreshold, 10).catch(() => []);
      if (Array.isArray(top)) setTopAssets(top);
    } catch (e) {
      setError(`Falha ao salvar configuração do scanner: ${e.message}`);
    } finally {
      setScannerSaving(false);
    }
  };

  const handleTestTelegram = async () => {
    setTestingTelegram(true);
    setError('');
    setNotice('');
    try {
      const now = new Date();
      const timeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
      const res = await sendTelegramSignal({
        signal_id: `test_${Date.now()}`,
        strategy: 'EMA Cross + Bollinger Bounce (Teste)',
        asset: 'EURUSD',
        direction: 'CALL',
        timeframe: 'M1',
        signal_time: timeStr,
        message_text: `🔔 *SINAL DE TESTE RW TIPS*\n━━━━━━━━━━━━━━━━━━━━━━\n📈 *CALL*  |  *EURUSD*\n⏱ Timeframe: *1 minuto (M1)*\n⚡ Assertividade: *85%*\n💰 Payout: *87%*\n👤 Modo: *🔵 CONTA DEMO (TESTE)*\n🕐 Horário: *${timeStr}*\n━━━━━━━━━━━━━━━━━━━━━━\n🔍 *Padrões:*\n  ✦ EMA9 > EMA21\n  ✦ BB Lower Bounce\n━━━━━━━━━━━━━━━━━━━━━━\n✅ _Conexão Telegram funcionando perfeitamente!_`,
      });
      if (res.sent) {
        setNotice('✅ Mensagem de teste enviada com sucesso para o canal do Telegram!');
      } else {
        setNotice('Sinal já processado.');
      }
    } catch (e) {
      setError(`Falha ao enviar sinal de teste ao Telegram: ${e.message}`);
    } finally {
      setTestingTelegram(false);
    }
  };

  const handleDisconnect = async () => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await disconnectIQAccount();
      setNotice('Conta IQ Option desconectada.');
    } catch (requestError) {
      setError(`Sessão local encerrada: ${requestError.message}`);
    } finally {
      liveFeed.disconnect();
      invalidateCache();
      invalidatePairValidation();
      await refreshCatalog();
      setConnected(false);
      setAccountEmail('');
      setStatus({
        candles: 'simulated', bridgeOnline: false, iqConnected: false, health: null,
        subscriptionsActive: 0, subscriptionsExpected: 0,
        activeAssets: [], activeAssetsAt: 0, payouts: {}, payoutsAt: 0,
      });
      setBusy(false);
    }
  };

  const isDemo = currentAccountType.toUpperCase().includes('PRACTICE') || currentAccountType.toUpperCase().includes('DEMO');

  return (
    <>
      <PageHeader
        title="Painel de Conexão IQ Option & Scanner"
        subtitle="Analise paridades abertas, configure entradas na conta Demo ou Real e envie sinais com alta assertividade ao Telegram."
      />

      {connected ? (
        <div className="space-y-6 max-w-4xl">
          {/* Card Principal: Status da Conexão e Toggle Demo / Real */}
          <div className="card p-6 border-neon/30 bg-gradient-to-br from-panel via-panel to-neon/[0.04]">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
              <div className="flex items-center gap-4">
                <div className={`flex h-12 w-12 items-center justify-center rounded-xl ${isDemo ? 'bg-blue-500/15 text-blue-400' : 'bg-emerald-500/15 text-emerald-400'} shadow-glowSm`}>
                  <Wifi className="h-6 w-6 animate-pulse" />
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-bold text-white text-base">IQ Option Conectada</span>
                    <span className={`rounded-full px-2.5 py-0.5 text-xs font-bold uppercase tracking-wide ${isDemo ? 'bg-blue-500/20 text-blue-400 border border-blue-500/30' : 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'}`}>
                      {isDemo ? '🔵 Conta Demo (Treinamento)' : '🔴 Conta Real'}
                    </span>
                  </div>
                  <div className="text-sm text-zinc-400 font-mono mt-0.5">{accountEmail}</div>
                </div>
              </div>

              {/* Botão de Alternar Modo Demo / Real */}
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => handleSwitchAccount(isDemo ? 'REAL' : 'PRACTICE')}
                  className={`btn text-xs font-semibold px-3 py-2 rounded-lg transition-all ${isDemo ? 'bg-emerald-600/20 text-emerald-400 border border-emerald-500/40 hover:bg-emerald-600/30' : 'bg-blue-600/20 text-blue-400 border border-blue-500/40 hover:bg-blue-600/30'}`}
                >
                  <Shield className="h-3.5 w-3.5 mr-1" />
                  {isDemo ? 'Migrar para Conta Real' : 'Mudar para Conta Demo'}
                </button>
                <button
                  className="btn-ghost text-xs text-zinc-400 hover:text-loss"
                  disabled={busy}
                  onClick={handleDisconnect}
                >
                  <Unplug className="h-3.5 w-3.5" /> Desconectar
                </button>
              </div>
            </div>
          </div>

          {/* Configuração do Scanner de Sinais & Entradas Automáticas */}
          <div className="card p-6 border-line">
            <div className="flex items-center justify-between mb-4 pb-3 border-b border-line">
              <div className="flex items-center gap-2">
                <Sliders className="h-5 w-5 text-neon" />
                <h3 className="text-base font-bold text-white">Configuração do Scanner & Entradas Automáticas</h3>
              </div>
              <span className="text-xs text-zinc-400">Opera na conta ativa: <strong>{isDemo ? 'Demo (Treino)' : 'Real'}</strong></span>
            </div>

            <form onSubmit={handleSaveScannerConfig} className="grid grid-cols-1 md:grid-cols-2 gap-4 items-end">
              {/* Auto-trade toggle — spans full width on mobile, 1 col on md */}
              <div className="md:col-span-2">
                <label className="block text-xs font-semibold text-zinc-300 mb-1">
                  Entrada Automática na IQ Option
                </label>
                <button
                  type="button"
                  onClick={() => setAutoTrade(!autoTrade)}
                  className={`w-full py-2 px-3 rounded-lg text-xs font-bold flex items-center justify-center gap-2 border transition-all ${autoTrade ? 'bg-neon/15 text-neon border-neon/40 shadow-glowSm' : 'bg-panel2 text-zinc-400 border-line hover:text-white'}`}
                >
                  <Zap className={`h-4 w-4 ${autoTrade ? 'text-neon animate-pulse' : 'text-zinc-500'}`} />
                  {autoTrade ? 'LIGADO (Executando entradas)' : 'DESLIGADO (Somente Sinais)'}
                </button>
              </div>

              <div>
                <label className="block text-xs font-semibold text-zinc-300 mb-1">
                  Valor da Entrada ($ Stake)
                </label>
                <input
                  type="number"
                  step="0.5"
                  min="1"
                  max="1000"
                  value={stake}
                  onChange={(e) => setStake(e.target.value)}
                  className="input text-sm font-mono w-full"
                  placeholder="2.0"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-zinc-300 mb-1">
                  Assertividade / Confiança Mínima (%)
                </label>
                <input
                  type="number"
                  min="50"
                  max="99"
                  value={minConfidence}
                  onChange={(e) => setMinConfidence(e.target.value)}
                  className="input text-sm font-mono w-full"
                  placeholder="75"
                />
              </div>

              {/* ── NOVO: Payout mínimo ─────────────────────────────────── */}
              <div className="md:col-span-2">
                <label className="block text-xs font-semibold text-zinc-300 mb-1">
                  Payout Mínimo dos Ativos (%) — lista atualiza a cada 5 min
                </label>
                <div className="flex items-center gap-3">
                  <input
                    id="minPayout"
                    type="range"
                    min="50"
                    max="99"
                    step="1"
                    value={minPayout}
                    onChange={(e) => setMinPayout(e.target.value)}
                    className="flex-1 accent-neon"
                  />
                  <span className="text-neon font-mono font-bold text-sm w-14 text-center">≥ {minPayout}%</span>
                </div>
                <p className="text-[11px] text-zinc-500 mt-1">
                  Somente ativos com payout ≥ {minPayout}% serão analisados pelo scanner. Quanto maior, mais seletivo.
                </p>
              </div>

              <div className="md:col-span-2 flex justify-between items-center pt-2">
                <p className="text-xs text-zinc-500">
                  {autoTrade
                    ? `⚠️ Atenção: Cada sinal disparado com confiança ≥ ${minConfidence}% abrirá ordem de $${stake} na sua conta ${isDemo ? 'Demo' : 'Real'}.`
                    : 'ℹ️ Modo Seguro: Os sinais serão analisados e enviados ao Telegram sem abrir ordens automáticas.'}
                </p>
                <button type="submit" disabled={scannerSaving} className="btn-primary text-xs px-4 py-2">
                  {scannerSaving ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
                  Salvar Parâmetros
                </button>
              </div>
            </form>
          </div>

          {/* Integração Telegram */}
          <div className="card p-5 border-line flex flex-col sm:flex-row items-center justify-between gap-4 bg-panel2/40">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-sky-500/15 text-sky-400">
                <Send className="h-5 w-5" />
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-white text-sm">Canal do Telegram Conectado</span>
                  <span className="rounded-full bg-emerald-500/20 text-emerald-400 text-[10px] px-2 py-0.5 font-bold">
                    ID: -1001981134607
                  </span>
                </div>
                <p className="text-xs text-zinc-400 mt-0.5">
                  Sinais técnicos de reversão e tendência enviados instantaneamente antes da abertura da vela.
                </p>
              </div>
            </div>
            <button
              type="button"
              disabled={testingTelegram}
              onClick={handleTestTelegram}
              className="btn-ghost text-xs border border-sky-500/30 text-sky-400 hover:bg-sky-500/10 whitespace-nowrap"
            >
              {testingTelegram ? <RefreshCw className="h-3.5 w-3.5 animate-spin mr-1" /> : <Send className="h-3.5 w-3.5 mr-1" />}
              Enviar Sinal de Teste
            </button>
          </div>

          {/* ── Top Ativos por Payout ───────────────────────────────── */}
          {topAssets.length > 0 && (
            <div className="card p-6 border-line">
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-2">
                  <TrendingUp className="h-5 w-5 text-emerald-400" />
                  <h3 className="text-base font-bold text-white">Top Ativos por Payout — Paridades Ativas</h3>
                  <span className="rounded-full bg-zinc-800 text-zinc-400 text-[10px] px-2 py-0.5 font-bold">≥ {minPayout}% | cache 5 min</span>
                </div>
                <button
                  type="button"
                  onClick={async () => {
                    const top = await refreshTopPayoutActives(parseInt(minPayout, 10) || 80, 10).catch(() => []);
                    if (Array.isArray(top)) setTopAssets(top);
                  }}
                  className="btn-ghost text-xs text-zinc-400 hover:text-white"
                >
                  <RefreshCw className="h-3.5 w-3.5 mr-1" /> Atualizar
                </button>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-2">
                {topAssets.slice(0, 10).map((asset, i) => (
                  <div
                    key={asset.id}
                    className="flex flex-col items-center justify-center rounded-xl bg-panel2 border border-line p-3 gap-1 hover:border-neon/40 transition-colors"
                  >
                    <span className="text-[10px] font-bold text-zinc-400">#{i + 1}</span>
                    <span className="font-bold text-white text-xs text-center">{asset.name || asset.id}</span>
                    <span className={`text-xs font-mono font-bold ${
                      asset.payout >= 90 ? 'text-neon' : asset.payout >= 85 ? 'text-emerald-400' : 'text-yellow-400'
                    }`}>{asset.payout}%</span>
                    <span className={`text-[10px] px-1.5 py-0.5 rounded font-semibold ${
                      asset.isOpen ? 'bg-emerald-500/15 text-emerald-400' : 'bg-red-500/15 text-red-400'
                    }`}>{asset.isOpen ? 'ABERTO' : 'FECHADO'}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Melhores Estratégias por Paridade x Timeframe */}
          <div className="card p-6 border-line">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <TrendingUp className="h-5 w-5 text-neon" />
                <h3 className="text-base font-bold text-white">Estratégias Mais Assertivas no Momento (IQ Historical)</h3>
              </div>
              <button
                type="button"
                onClick={async () => {
                  const res = await fetchBestStrategies(10);
                  if (Array.isArray(res)) setBestStrategies(res);
                }}
                className="btn-ghost text-xs text-zinc-400 hover:text-white"
              >
                <RefreshCw className="h-3.5 w-3.5 mr-1" /> Recalcular
              </button>
            </div>

            {bestStrategies.length > 0 ? (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="bg-panel2 text-zinc-400 font-semibold border-b border-line">
                    <tr>
                      <th className="py-2.5 px-3">Paridade</th>
                      <th className="py-2.5 px-3">Timeframe</th>
                      <th className="py-2.5 px-3">Estratégia Técnica</th>
                      <th className="py-2.5 px-3 text-right">Assertividade</th>
                      <th className="py-2.5 px-3 text-right">Sinais / Histórico</th>
                      <th className="py-2.5 px-3 text-right">Payout</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line font-mono">
                    {bestStrategies.map((s, idx) => (
                      <tr key={idx} className="hover:bg-panel2/50 transition-colors">
                        <td className="py-2 px-3 font-bold text-white">{s.asset}</td>
                        <td className="py-2 px-3">
                          <span className="px-2 py-0.5 rounded bg-zinc-800 text-zinc-300 font-bold">{s.timeframe}</span>
                        </td>
                        <td className="py-2 px-3 text-zinc-300 font-sans">{s.strategy}</td>
                        <td className="py-2 px-3 text-right">
                          <span className={`font-bold ${s.winrate >= 75 ? 'text-neon' : s.winrate >= 60 ? 'text-yellow-400' : 'text-zinc-400'}`}>
                            {s.winrate}%
                          </span>
                        </td>
                        <td className="py-2 px-3 text-right text-zinc-400">
                          {s.wins}W / {s.losses}L ({s.signals_count})
                        </td>
                        <td className="py-2 px-3 text-right text-zinc-300">
                          {s.payout}%
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="text-xs text-zinc-500 py-4 text-center">
                Coletando dados de velas das paridades abertas para calcular a assertividade...
              </p>
            )}

            <div className="mt-5 pt-4 border-t border-line flex flex-wrap items-center justify-between gap-3">
              <Link to="/radar" className="btn-primary text-xs">
                <Radio className="h-4 w-4 mr-1 text-ink animate-pulse" />
                Acessar Radar Live Completo
                <ArrowRight className="h-4 w-4 ml-1" />
              </Link>
              <Link to="/scanner" className="btn-ghost text-xs">
                <ScanSearch className="h-3.5 w-3.5 mr-1" /> Catálogo Geral de Ativos
              </Link>
            </div>
          </div>
        </div>
      ) : (
        <div className="card max-w-xl p-6 border-line">
          <form className="space-y-4" onSubmit={handleConnect}>
            {/* Escolha da Conta: Demo ou Real */}
            <div>
              <label className="block text-xs font-semibold text-zinc-300 mb-2">
                Modo da Conta IQ Option:
              </label>
              <div className="grid grid-cols-2 gap-3">
                <button
                  type="button"
                  onClick={() => setAccountType('PRACTICE')}
                  className={`p-3 rounded-xl border text-left transition-all ${accountType === 'PRACTICE' ? 'bg-blue-500/10 border-blue-500/50 text-white shadow-glowSm' : 'bg-panel2 border-line text-zinc-400 hover:text-white'}`}
                >
                  <div className="font-bold text-sm flex items-center gap-1.5 text-blue-400">
                    <span>🔵</span> Conta Demo
                  </div>
                  <div className="text-[11px] text-zinc-400 mt-1">
                    Ideal para testar assertividade e entradas sem risco real.
                  </div>
                </button>

                <button
                  type="button"
                  onClick={() => setAccountType('REAL')}
                  className={`p-3 rounded-xl border text-left transition-all ${accountType === 'REAL' ? 'bg-emerald-500/10 border-emerald-500/50 text-white shadow-glowSm' : 'bg-panel2 border-line text-zinc-400 hover:text-white'}`}
                >
                  <div className="font-bold text-sm flex items-center gap-1.5 text-emerald-400">
                    <span>🔴</span> Conta Real
                  </div>
                  <div className="text-[11px] text-zinc-400 mt-1">
                    Opera diretamente na sua banca real na IQ Option.
                  </div>
                </button>
              </div>
            </div>

            <label className="block text-sm text-zinc-400">
              E-mail da IQ Option
              <input
                className="input mt-1 w-full"
                type="email"
                autoComplete="username"
                required
                placeholder="seu_email@exemplo.com"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            </label>

            <label className="block text-sm text-zinc-400">
              Senha da IQ Option
              <input
                className="input mt-1 w-full"
                type="password"
                autoComplete="current-password"
                required
                placeholder="••••••••"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </label>

            <div className="rounded-lg bg-panel2 p-3 border border-line text-xs text-zinc-400 flex items-start gap-2">
              <AlertCircle className="h-4 w-4 text-neon shrink-0 mt-0.5" />
              <span>
                As credenciais são autenticadas diretamente pela biblioteca oficial da IQ Option via WebSocket criptografado. Você pode alternar entre Demo e Real a qualquer momento após conectar.
              </span>
            </div>

            <button className="btn-primary w-full py-2.5 text-sm font-bold" type="submit" disabled={busy}>
              {busy ? (
                <><RefreshCw className="h-4 w-4 animate-spin mr-1" /> Conectando à IQ Option…</>
              ) : (
                <><Wifi className="h-4 w-4 mr-1" /> Conectar em Modo {accountType === 'REAL' ? 'Real' : 'Demo (Treino)'}</>
              )}
            </button>
          </form>
        </div>
      )}

      {error && <p className="mt-4 text-sm text-loss max-w-xl font-semibold" role="alert">{error}</p>}
      {notice && <p className="mt-4 text-sm text-neon max-w-xl font-semibold" role="status">{notice}</p>}
    </>
  );
}
