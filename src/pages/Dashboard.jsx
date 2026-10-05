import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Wifi, WifiOff, Radio, ArrowRight, Link2, Sparkles, Send } from 'lucide-react';
import { getAvailableAssets, getPayout } from '../data/candleData.js';
import { IMPLEMENTED_STRATEGIES } from '../data/strategies.js';
import { getCatalogSnapshot, refreshCatalog, subscribeCatalog } from '../lib/strategyValidation.js';
import { useDataStatus } from '../services/dataStatus.js';
import { fmtPct, fmtNum, fmtUnits, fmtDateTime } from '../lib/stats.js';
import { PageHeader, StatCard, Loading, ConfidenceBadge, DataBadge, Badge, signClass } from '../components/ui.jsx';

export default function Dashboard() {
  const ds = useDataStatus();
  const activeAssets = getAvailableAssets();
  const [rows, setRows] = useState(() => getCatalogSnapshot().rows);
  const [loading, setLoading] = useState(rows.length === 0);
  useEffect(() => {
    const unsubscribe = subscribeCatalog(({ rows: updated }) => {
      setRows(updated);
      setLoading(false);
    });
    refreshCatalog().catch((error) => {
      console.error('[Dashboard] falha ao carregar catálogo:', error);
      setLoading(false);
    });
    return unsubscribe;
  }, []);

  const approved = rows.filter((row) => row.eligible);
  const avgWin = approved.length ? approved.reduce((sum, row) => sum + row.stats.winRate, 0) / approved.length : 0;
  const avgPayout = ds.activeAssetsAt && activeAssets.length
    ? activeAssets.reduce((sum, asset) => sum + getPayout(asset.id), 0) / activeAssets.length
    : null;
  const ranking = approved.sort((a, b) => b.stats.expectancy - a.stats.expectancy).slice(0, 10);

  return (
    <>
      <PageHeader title="Dashboard" subtitle="Visão geral de estratégias catalogadas e saúde da conexão com a corretora.">
        <DataBadge />
      </PageHeader>

      {/* Banner de Direcionamento Rápido / Fluxo Operacional */}
      <div className="card mb-5 border-neon/30 bg-gradient-to-r from-panel via-panel2/80 to-neon/[0.06] p-5">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <span className="flex h-2 w-2 rounded-full bg-neon animate-ping" />
              <span className="text-xs font-bold uppercase tracking-wider text-neon">Central Operacional</span>
            </div>
            <h3 className="text-lg font-bold text-white">
              Pronto para monitorar e enviar sinais em tempo real?
            </h3>
            <p className="text-xs text-zinc-300 max-w-2xl">
              O <strong>Radar Live</strong> cataloga M1 (1h) e M5 (2h), valida a convergência de estratégias e despacha os sinais automaticamente para o seu canal do Telegram com placar de vitórias.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2 shrink-0">
            {ds.iqConnected ? (
              <Link to="/radar" className="btn-primary">
                <Radio className="h-4 w-4 text-ink animate-pulse" />
                Abrir Radar Live
                <ArrowRight className="h-4 w-4 ml-1" />
              </Link>
            ) : (
              <Link to="/conexao-iq" className="btn-primary">
                <Link2 className="h-4 w-4 text-ink" />
                Conectar IQ Option
                <ArrowRight className="h-4 w-4 ml-1" />
              </Link>
            )}
            <Link to="/scanner" className="btn-ghost text-xs">
              Filtrar Catálogo (Scanner)
            </Link>
          </div>
        </div>
      </div>

      {/* Status da conexão com a IQ Option (vem do /health + mensagens health do WS) */}
      <div className="card mb-4 flex flex-col gap-3 p-4">
        <div className="flex flex-wrap items-center gap-3">
          {ds.bridgeOnline === null && <><WifiOff className="h-5 w-5 text-zinc-500" /><span className="text-sm text-zinc-400">Ponte não configurada. Usando dados simulados (defina <code>VITE_BRIDGE_URL</code> no <code>.env</code>).</span></>}
          {ds.bridgeOnline === false && <><WifiOff className="h-5 w-5 text-loss" /><span className="text-sm text-loss">Ponte offline — exibindo dados simulados.</span></>}
          {ds.bridgeOnline && (
            <>
              <Wifi className="h-5 w-5 text-neon" />
              <span className="text-sm text-zinc-300">Ponte online · IQ Option:</span>
              <Badge tone={ds.iqConnected ? 'neon' : 'loss'}>{ds.iqConnected ? 'conectada (real · somente consulta)' : 'desconectada'}</Badge>
              <Badge tone={ds.subscriptionsExpected === 0 ? 'gray' : (ds.subscriptionsActive === ds.subscriptionsExpected ? 'neon' : 'warn')}>
                streams {ds.subscriptionsActive}/{ds.subscriptionsExpected}
              </Badge>
              {ds.latencyMs != null && <span className="text-xs text-zinc-400">Latência: <span className={ds.latencyMs < 1500 ? 'text-neon' : 'text-warn'}>{Math.round(ds.latencyMs)} ms</span></span>}
            </>
          )}
        </div>
        {ds.bridgeOnline && (
          <div className="flex flex-wrap items-center gap-3 border-t border-line/60 pt-3">
            <Badge tone={(ds.counts?.ok || 0) > 0 ? 'neon' : 'gray'}>ok: {ds.counts?.ok || 0}</Badge>
            <Badge tone={(ds.counts?.stale || 0) > 0 ? 'warn' : 'gray'}>stale: {ds.counts?.stale || 0}</Badge>
            <Badge tone={(ds.counts?.market_closed || 0) > 0 ? 'loss' : 'gray'}>mercado fechado: {ds.counts?.market_closed || 0}</Badge>
            {(ds.counts?.missing || 0) > 0 && <Badge tone="gray">faltando: {ds.counts?.missing}</Badge>}
            <span className="ml-auto text-xs text-zinc-500">
              Último candle EURUSD · M1: {ds.health?.last_candle?.EURUSD?.M1 ? fmtDateTime(ds.health.last_candle.EURUSD.M1) : (ds.health?.last_candle?.EURUSD ? fmtDateTime(ds.health.last_candle.EURUSD) : '—')}
            </span>
          </div>
        )}
        {ds.bridgeOnline && ds.staleList && ds.staleList.length > 0 && (
          <div className="rounded-md border border-warn/30 bg-warn/[0.03] p-3 text-xs">
            <div className="mb-1 font-semibold text-warn">Ativos com atraso no streaming (stale):</div>
            <ul className="grid grid-cols-1 gap-1 sm:grid-cols-2 md:grid-cols-3">
              {ds.staleList.slice(0, 18).map((s, i) => (
                <li key={i} className="flex items-center gap-2 text-zinc-300">
                  <span className="font-mono text-white">{s.asset}</span>
                  <span className="text-zinc-500">·</span>
                  <span className="font-mono">{s.tf}</span>
                  <span className="ml-auto text-warn">
                    {typeof s.lagSeconds === 'number'
                      ? (s.lagSeconds > 60 ? `${Math.floor(s.lagSeconds / 60)}m${s.lagSeconds % 60}s` : `${s.lagSeconds}s`)
                      : '?'} atraso
                  </span>
                </li>
              ))}
              {ds.staleList.length > 18 && <li className="text-zinc-500">+ {ds.staleList.length - 18} mais…</li>}
            </ul>
          </div>
        )}
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <StatCard label="Estratégias implementadas" value={IMPLEMENTED_STRATEGIES.length} />
        <StatCard label={ds.activeAssetsAt ? 'Ativos binários abertos' : 'Ativos de exemplo'} value={activeAssets.length} />
        <StatCard label="Configurações aprovadas" value={loading ? '…' : fmtNum(approved.length)} />
        <StatCard label="Win rate médio" value={loading ? '…' : fmtPct(avgWin)} />
        <StatCard label="Payout médio da plataforma" value={avgPayout == null ? '—' : fmtPct(avgPayout, 0)} />
        <StatCard label="Configurações analisadas" value={loading ? '…' : fmtNum(rows.length)} />
      </div>

      <h2 className="mb-3 mt-8 text-lg font-bold text-white">Melhores configurações aprovadas</h2>
      {loading ? <Loading /> : ranking.length === 0 ? (
        <div className="card p-6 text-sm text-zinc-500">Nenhuma configuração atingiu 10 operações e assertividade acima do break-even com dados reais.</div>
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full">
            <thead className="border-b border-line"><tr>
              {['Estratégia', 'Ativo', 'Operações', 'Assertividade', 'Break-even', 'Expectância', 'Confiança'].map((h) => <th key={h} className="th">{h}</th>)}
            </tr></thead>
            <tbody>
              {ranking.map((r) => (
                <tr key={r.key} className="border-b border-line/60 last:border-0 hover:bg-panel2">
                  <td className="td font-bold"><Link className="text-white hover:text-neon" to={`/estrategias/${r.strategy.id}?asset=${encodeURIComponent(r.asset)}&tf=${r.tf}&validation=1`}>{r.strategy.name}</Link></td>
                  <td className="td">{r.asset}</td>
                  <td className="td">{r.stats.decided}</td>
                  <td className={`td font-bold ${signClass(r.stats.edge)}`}>{fmtPct(r.stats.winRate)}</td>
                  <td className="td text-zinc-500">{fmtPct(r.stats.breakEven)}</td>
                  <td className={`td ${signClass(r.stats.expectancy)}`}>{fmtUnits(r.stats.expectancy, 3)}</td>
                  <td className="td"><ConfidenceBadge confidence={r.stats.confidence} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
