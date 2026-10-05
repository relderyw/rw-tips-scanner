import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { RefreshCw, Unplug, Wifi, Radio, ArrowRight, CheckCircle2, ScanSearch } from 'lucide-react';
import { PageHeader } from '../components/ui.jsx';
import {
  getIQSessionToken, connectIQAccount, disconnectIQAccount, fetchIQSession,
  fetchBridgeHealth, fetchBridgePayouts,
} from '../services/bridgeApi.js';
import { applyHealthSnapshot, setStatus } from '../services/dataStatus.js';
import { liveFeed } from '../services/liveFeed.js';
import { invalidateCache } from '../lib/runner.js';
import { invalidatePairValidation, refreshCatalog } from '../lib/strategyValidation.js';
import { refreshIQActives } from '../data/candleData.js';

export default function IQConnection() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [accountEmail, setAccountEmail] = useState('');
  const [connected, setConnected] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  useEffect(() => {
    if (!getIQSessionToken()) return undefined;
    let active = true;
    (async () => {
      try {
        const session = await fetchIQSession();
        if (!active) return;
        setAccountEmail(session.email);
        setConnected(Boolean(session.connected));
        liveFeed.connect();
      } catch (requestError) {
        if (!active) return;
        setError(requestError.message);
        liveFeed.disconnect();
        setConnected(false);
        return;
      }
      try {
        const [health, payouts] = await Promise.all([fetchBridgeHealth(), fetchBridgePayouts()]);
        if (!active) return;
        applyHealthSnapshot(health, 'rest');
        setStatus({ payouts, payoutsAt: Date.now() });
        await refreshIQActives();
      } catch (requestError) {
        if (active) setError(`Conta conectada, mas não foi possível carregar o status: ${requestError.message}`);
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
      const session = await connectIQAccount(email, password);
      setAccountEmail(session.email);
      setConnected(true);
      setPassword('');
      setEmail('');
      setStatus({ bridgeOnline: true, candles: 'unknown' });
      liveFeed.connect();
      invalidateCache();
      invalidatePairValidation();
      const [health, payouts] = await Promise.all([fetchBridgeHealth(), fetchBridgePayouts()]);
      applyHealthSnapshot(health, 'rest');
      setStatus({ payouts, payoutsAt: Date.now() });
      await refreshIQActives();
      refreshCatalog({ force: true }).catch((catalogError) => {
        console.error('[IQConnection] falha ao atualizar catálogo após conectar:', catalogError);
      });
      setNotice('Conta real da IQ Option conectada em modo somente consulta.');
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusy(false);
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
      setError(`Sessão local encerrada; a ponte não confirmou o fechamento: ${requestError.message}`);
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

  return (
    <>
      <PageHeader title="Conectar IQ Option" subtitle="Conecte sua conta real para consultar saldo, histórico de entradas e candles em tempo real. O app não envia ordens automáticas na corretora." />

      {connected ? (
        <div className="space-y-6 max-w-2xl">
          {/* Card Principal: Status da Conexão */}
          <div className="card p-5 border-neon/30 bg-gradient-to-br from-panel via-panel to-neon/[0.04]">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
              <div className="flex items-center gap-3">
                <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-neon/15 text-neon shadow-glowSm">
                  <Wifi className="h-6 w-6 animate-pulse" />
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-bold text-white text-base">Conta Real Conectada</span>
                    <span className="rounded-full bg-neon/20 px-2 py-0.5 text-[10px] font-semibold text-neon uppercase tracking-wide">
                      Somente Consulta
                    </span>
                  </div>
                  <div className="text-sm text-zinc-400 font-mono mt-0.5">{accountEmail}</div>
                </div>
              </div>
              <button
                className="btn-ghost text-xs text-zinc-400 hover:text-loss self-start sm:self-center"
                disabled={busy}
                onClick={handleDisconnect}
              >
                <Unplug className="h-3.5 w-3.5" /> Desconectar conta
              </button>
            </div>
          </div>

          {/* O que fazer agora? Guia de 4 Passos */}
          <div className="card p-6 border-line">
            <h3 className="text-base font-bold text-white flex items-center gap-2 mb-1">
              <span>🚀 Próximos Passos Recomendados</span>
            </h3>
            <p className="text-xs text-zinc-400 mb-5">
              Sua conta está sincronizada. Siga o fluxo abaixo para começar a gerar e enviar sinais:
            </p>

            <div className="space-y-3">
              {/* Passo 1 - Concluído */}
              <div className="flex items-start gap-3 rounded-lg border border-neon/20 bg-neon/[0.03] p-3">
                <CheckCircle2 className="h-5 w-5 text-neon shrink-0 mt-0.5" />
                <div className="text-xs">
                  <div className="font-semibold text-white">1. Conexão Estabelecida</div>
                  <div className="text-zinc-400">Stream de velas em tempo real e payouts da IQ Option ativados com sucesso.</div>
                </div>
              </div>

              {/* Passo 2 - Ação Imediata */}
              <div className="flex items-start gap-3 rounded-lg border border-line bg-panel2/60 p-3">
                <div className="flex h-5 w-5 items-center justify-center rounded-full bg-neon text-ink text-[11px] font-bold shrink-0 mt-0.5">
                  2
                </div>
                <div className="text-xs flex-1">
                  <div className="font-semibold text-white">Abra o Radar Live (Sala de Operações)</div>
                  <div className="text-zinc-400 mt-0.5">
                    O Radar analisa simultaneamente <strong>M1 (1h)</strong> e <strong>M5 (2h)</strong> e só gera sinais quando a mesma estratégia converge nos dois timeframes.
                  </div>
                </div>
              </div>

              {/* Passo 3 */}
              <div className="flex items-start gap-3 rounded-lg border border-line bg-panel2/60 p-3">
                <div className="flex h-5 w-5 items-center justify-center rounded-full bg-zinc-700 text-zinc-200 text-[11px] font-bold shrink-0 mt-0.5">
                  3
                </div>
                <div className="text-xs">
                  <div className="font-semibold text-white">Ative o Envio Automático ao Telegram</div>
                  <div className="text-zinc-400 mt-0.5">
                    No Radar Live, ligue a chave de envio automático para despachar as entradas no canal no minuto exato.
                  </div>
                </div>
              </div>

              {/* Passo 4 */}
              <div className="flex items-start gap-3 rounded-lg border border-line bg-panel2/60 p-3">
                <div className="flex h-5 w-5 items-center justify-center rounded-full bg-zinc-700 text-zinc-200 text-[11px] font-bold shrink-0 mt-0.5">
                  4
                </div>
                <div className="text-xs">
                  <div className="font-semibold text-white">Acompanhe o Placar de Greens e Reds</div>
                  <div className="text-zinc-400 mt-0.5">
                    Veja os resultados das entradas atualizados em tempo real no topo do painel e no rodapé das mensagens do Telegram.
                  </div>
                </div>
              </div>
            </div>

            {/* Ação Primária */}
            <div className="mt-6 pt-4 border-t border-line flex flex-wrap items-center gap-3">
              <Link to="/radar" className="btn-primary flex-1 sm:flex-none justify-center">
                <Radio className="h-4 w-4 text-ink animate-pulse" />
                Ir para o Radar Live Agora
                <ArrowRight className="h-4 w-4 ml-1" />
              </Link>
              <Link to="/scanner" className="btn-ghost flex-1 sm:flex-none justify-center text-xs">
                <ScanSearch className="h-3.5 w-3.5" /> Explorar Catálogo (Scanner)
              </Link>
            </div>
          </div>
        </div>
      ) : (
        <div className="card max-w-xl p-5">
          <form className="space-y-3" onSubmit={handleConnect}>
            <label className="block text-sm text-zinc-400">
              E-mail da IQ Option
              <input
                className="input mt-1"
                type="email"
                autoComplete="username"
                required
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            </label>
            <label className="block text-sm text-zinc-400">
              Senha da IQ Option
              <input
                className="input mt-1"
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </label>
            <p className="text-xs text-zinc-500">
              As credenciais são enviadas à ponte para autenticação e mantidas em memória enquanto conectada. Esta integração é somente para consulta de velas e payouts; ela não executa ordens na sua conta.
            </p>
            <button className="btn-primary" type="submit" disabled={busy}>
              {busy ? <><RefreshCw className="h-4 w-4 animate-spin" /> Conectando…</> : <><Wifi className="h-4 w-4" /> Conectar conta real</>}
            </button>
          </form>
        </div>
      )}

      {error && <p className="mt-4 text-sm text-loss max-w-xl" role="alert">{error}</p>}
      {notice && <p className="mt-4 text-sm text-neon max-w-xl" role="status">{notice}</p>}
    </>
  );
}
