import { useEffect, useState, useCallback, useMemo } from 'react';
import { Link } from 'react-router-dom';
import {
  LayoutDashboard,
  TrendingUp,
  TrendingDown,
  Target,
  DollarSign,
  Calendar,
  Send,
  RefreshCw,
  Ban,
  CheckCircle2,
  Clock,
  ArrowUpRight,
  ShieldAlert,
  Zap,
} from 'lucide-react';
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  Legend,
} from 'recharts';
import {
  fetchDashboardStats,
  sendTelegramDailySummary,
  getIQSessionToken,
  fetchScannerBlacklist,
  addAssetToBlacklist,
  removeAssetFromBlacklist,
} from '../services/bridgeApi.js';
import { PageHeader, DataBadge } from '../components/ui.jsx';

// Helpers de formatação de data
const getTodayStr = () => new Date().toISOString().slice(0, 10);
const getPastDateStr = (daysAgo) => {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return d.toISOString().slice(0, 10);
};

export default function Dashboard() {
  // Filtros
  const [periodPreset, setPeriodPreset] = useState('today'); // 'today' | 'yesterday' | '7d' | '30d' | 'all' | 'custom'
  const [startDate, setStartDate] = useState(getTodayStr());
  const [endDate, setEndDate] = useState(getTodayStr());
  const [accountFilter, setAccountFilter] = useState('both'); // 'both' | 'real' | 'demo'

  // Dados
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState(null);
  const [blacklist, setBlacklist] = useState([]);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [sendingSummary, setSendingSummary] = useState(false);
  const [summaryChoiceOpen, setSummaryChoiceOpen] = useState(false);

  // Manipulação de presets de data
  const handlePresetChange = (preset) => {
    setPeriodPreset(preset);
    const today = getTodayStr();
    if (preset === 'today') {
      setStartDate(today);
      setEndDate(today);
    } else if (preset === 'yesterday') {
      const y = getPastDateStr(1);
      setStartDate(y);
      setEndDate(y);
    } else if (preset === '7d') {
      setStartDate(getPastDateStr(7));
      setEndDate(today);
    } else if (preset === '30d') {
      setStartDate(getPastDateStr(30));
      setEndDate(today);
    } else if (preset === 'all') {
      setStartDate('2024-01-01');
      setEndDate(today);
    }
  };

  // Carrega lista de blacklist
  const loadBlacklist = useCallback(async () => {
    if (!getIQSessionToken()) return;
    try {
      const res = await fetchScannerBlacklist();
      if (res?.blacklist) setBlacklist(res.blacklist);
    } catch (_) {}
  }, []);

  // Carrega estatísticas com os filtros atuais
  const loadStats = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetchDashboardStats({
        startDate: periodPreset === 'all' ? '2020-01-01' : startDate,
        endDate: endDate,
        accountType: accountFilter,
      });
      if (res && typeof res.total_trades === 'number') {
        setData(res);
      } else {
        setData({
          start_date: startDate,
          end_date: endDate,
          account_filter: accountFilter,
          total_trades: 0,
          total_greens: 0,
          total_reds: 0,
          winrate: 0.0,
          total_profit: 0.0,
          timeline: [],
          asset_performance: [],
          recent_trades: [],
        });
      }
    } catch (err) {
      console.warn('Falha ao obter dashboard stats:', err);
      setData((prev) => prev || {
        start_date: startDate,
        end_date: endDate,
        account_filter: accountFilter,
        total_trades: 0,
        total_greens: 0,
        total_reds: 0,
        winrate: 0.0,
        total_profit: 0.0,
        timeline: [],
        asset_performance: [],
        recent_trades: [],
      });
    } finally {
      setLoading(false);
    }
  }, [periodPreset, startDate, endDate, accountFilter]);

  useEffect(() => {
    loadStats();
    loadBlacklist();
  }, [loadStats, loadBlacklist]);

  // Enviar resumo para o Telegram com escolha da modalidade
  const handleSendTelegramSummary = async (type = 'both') => {
    setSendingSummary(true);
    setSummaryChoiceOpen(false);
    setNotice('');
    setError('');
    try {
      await sendTelegramDailySummary(type);
      const label = type === 'real' ? 'Conta Real' : type === 'demo' ? 'Conta Demo' : 'Real & Demo (Consolidado)';
      setNotice(`✅ Relatório diário (${label}) enviado com sucesso ao seu canal do Telegram!`);
      setTimeout(() => setNotice(''), 5000);
    } catch (e) {
      setError(`Falha ao entregar relatório ao Telegram: ${e.message}`);
    } finally {
      setSendingSummary(false);
    }
  };

  // Alternar Blacklist
  const handleToggleBlacklist = async (asset) => {
    const clean = String(asset).replace('/', '').toUpperCase();
    const isBlocked = blacklist.some((b) => b.replace('/', '').toUpperCase() === clean);
    try {
      if (isBlocked) {
        const res = await removeAssetFromBlacklist(clean);
        setBlacklist(res.blacklist || []);
        setNotice(`Ativo ${asset} removido da Blacklist.`);
      } else {
        const res = await addAssetToBlacklist(clean);
        setBlacklist(res.blacklist || []);
        setNotice(`Ativo ${asset} adicionado à Blacklist.`);
      }
      setTimeout(() => setNotice(''), 3000);
    } catch (e) {
      setError(`Erro ao atualizar blacklist: ${e.message}`);
    }
  };

  const isBlocked = (asset) => {
    const clean = String(asset).replace('/', '').toUpperCase();
    return blacklist.some((b) => b.replace('/', '').toUpperCase() === clean);
  };

  return (
    <>
      <PageHeader
        title="Dashboard Geral & Assertividade"
        subtitle="Métricas operacionais consolidadas, histórico de Greens/Reds, análise por ativo e filtro flexível de datas."
      >
        <DataBadge />
      </PageHeader>

      {/* Avisos & Erros */}
      {notice && (
        <div className="mb-4 flex items-center gap-2 rounded-xl border border-emerald-500/40 bg-emerald-500/10 p-3 text-xs font-semibold text-emerald-400 shadow-glowSm">
          <CheckCircle2 className="h-4 w-4 shrink-0" />
          <span>{notice}</span>
        </div>
      )}
      {error && (
        <div className="mb-4 flex items-center gap-2 rounded-xl border border-red-500/40 bg-red-500/10 p-3 text-xs font-semibold text-red-400">
          <ShieldAlert className="h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* BARRA DE FILTROS SUPERIOR */}
      <div className="card mb-6 p-4 sm:p-5 border-line bg-panel">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          {/* Seletor de Período */}
          <div className="flex flex-wrap items-center gap-2">
            <span className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-zinc-400 mr-1">
              <Calendar className="h-3.5 w-3.5 text-neon" />
              Período:
            </span>
            {[
              { id: 'today', label: 'Hoje' },
              { id: 'yesterday', label: 'Ontem' },
              { id: '7d', label: '7 Dias' },
              { id: '30d', label: '30 Dias' },
              { id: 'all', label: 'Todo o Histórico' },
              { id: 'custom', label: 'Personalizado' },
            ].map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => handlePresetChange(item.id)}
                className={`rounded-lg px-3 py-1.5 text-xs font-bold transition-all ${
                  periodPreset === item.id
                    ? 'bg-neon/15 text-neon border border-neon/40 shadow-glowSm'
                    : 'bg-panel2 text-zinc-400 hover:text-white border border-line'
                }`}
              >
                {item.label}
              </button>
            ))}
          </div>

          {/* Filtro de Conta (Real / Demo / Ambos) */}
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-bold uppercase tracking-wider text-zinc-400 mr-1">
              Conta:
            </span>
            {[
              { id: 'both', label: '🌐 Todas (Ambos)' },
              { id: 'real', label: '💎 Real' },
              { id: 'demo', label: '🎮 Demo' },
            ].map((acc) => (
              <button
                key={acc.id}
                type="button"
                onClick={() => setAccountFilter(acc.id)}
                className={`rounded-lg px-3 py-1.5 text-xs font-bold transition-all ${
                  accountFilter === acc.id
                    ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/40 shadow-glowSm'
                    : 'bg-panel2 text-zinc-400 hover:text-white border border-line'
                }`}
              >
                {acc.label}
              </button>
            ))}
          </div>
        </div>

        {/* Inputs de Data Personalizada se selecionado */}
        {periodPreset === 'custom' && (
          <div className="mt-4 flex flex-wrap items-center gap-3 pt-3 border-t border-line/60">
            <div className="flex items-center gap-2">
              <label className="text-xs font-semibold text-zinc-400">De:</label>
              <input
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                className="input text-xs py-1.5 px-3 font-mono"
              />
            </div>
            <div className="flex items-center gap-2">
              <label className="text-xs font-semibold text-zinc-400">Até:</label>
              <input
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                className="input text-xs py-1.5 px-3 font-mono"
              />
            </div>
            <button
              type="button"
              onClick={loadStats}
              className="btn-primary text-xs py-1.5 px-3 flex items-center gap-1.5"
            >
              <RefreshCw className="h-3 w-3" />
              Filtrar
            </button>
          </div>
        )}

        {/* Ações Rápidas: Atualizar & Enviar Resumo ao Telegram */}
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 pt-3 border-t border-line/60">
          <div className="flex items-center gap-2 text-xs text-zinc-400">
            <span>Intervalo ativo:</span>
            <span className="font-mono text-white font-bold">
              {startDate === endDate ? startDate : `${startDate} até ${endDate}`}
            </span>
          </div>

          <div className="flex items-center gap-2 relative">
            <button
              type="button"
              onClick={loadStats}
              disabled={loading}
              className="btn-ghost text-xs px-3 py-1.5 flex items-center gap-1.5"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
              Atualizar Dados
            </button>

            {/* Botão com Dropdown para Envio de Resumo ao Telegram */}
            <div className="relative">
              <button
                type="button"
                onClick={() => setSummaryChoiceOpen((v) => !v)}
                disabled={sendingSummary}
                className="btn-ghost text-xs px-3 py-1.5 border-emerald-500/40 text-emerald-400 hover:bg-emerald-500/10 flex items-center gap-1.5"
              >
                {sendingSummary ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
                Enviar Resumo Telegram
              </button>

              {summaryChoiceOpen && (
                <div className="absolute right-0 top-full mt-1 w-64 rounded-xl bg-panel border border-line shadow-2xl p-2 z-50 space-y-1">
                  <div className="px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-zinc-400">
                    Escolha a conta para o resumo diário:
                  </div>
                  <button
                    type="button"
                    onClick={() => handleSendTelegramSummary('real')}
                    className="w-full text-left px-3 py-2 rounded-lg text-xs font-semibold text-white hover:bg-panel2 flex items-center gap-2 transition"
                  >
                    <span>💎</span> Resumo: Conta Real
                  </button>
                  <button
                    type="button"
                    onClick={() => handleSendTelegramSummary('demo')}
                    className="w-full text-left px-3 py-2 rounded-lg text-xs font-semibold text-white hover:bg-panel2 flex items-center gap-2 transition"
                  >
                    <span>🎮</span> Resumo: Conta Demo
                  </button>
                  <button
                    type="button"
                    onClick={() => handleSendTelegramSummary('both')}
                    className="w-full text-left px-3 py-2 rounded-lg text-xs font-semibold text-neon hover:bg-neon/10 flex items-center gap-2 transition border-t border-line/50 pt-2"
                  >
                    <span>🌐</span> Resumo: Ambas (Consolidado)
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* CARDS DE MÉTRICAS PRINCIPAIS */}
      <div className="grid grid-cols-2 sm:grid-cols-2 lg:grid-cols-5 gap-4 mb-6">
        <div className="card p-4 border-line bg-panel">
          <div className="flex items-center justify-between mb-1">
            <span className="text-[11px] font-bold uppercase tracking-wider text-zinc-400">Total Operações</span>
            <Target className="h-4 w-4 text-zinc-400" />
          </div>
          <div className="text-2xl font-black text-white font-mono">{data?.total_trades || 0}</div>
          <span className="text-[10px] text-zinc-500">no período filtrado</span>
        </div>

        <div className="card p-4 border-emerald-500/30 bg-emerald-500/[0.04]">
          <div className="flex items-center justify-between mb-1">
            <span className="text-[11px] font-bold uppercase tracking-wider text-emerald-400">Vitórias (Greens)</span>
            <TrendingUp className="h-4 w-4 text-emerald-400" />
          </div>
          <div className="text-2xl font-black text-emerald-400 font-mono">{data?.total_greens || 0}</div>
          <span className="text-[10px] text-emerald-500/80">operações vencedoras</span>
        </div>

        <div className="card p-4 border-red-500/30 bg-red-500/[0.04]">
          <div className="flex items-center justify-between mb-1">
            <span className="text-[11px] font-bold uppercase tracking-wider text-red-400">Derrotas (Reds)</span>
            <TrendingDown className="h-4 w-4 text-red-400" />
          </div>
          <div className="text-2xl font-black text-red-400 font-mono">{data?.total_reds || 0}</div>
          <span className="text-[10px] text-red-500/80">operações com loss</span>
        </div>

        <div className="card p-4 border-neon/30 bg-neon/[0.04]">
          <div className="flex items-center justify-between mb-1">
            <span className="text-[11px] font-bold uppercase tracking-wider text-neon">Assertividade</span>
            <Zap className="h-4 w-4 text-neon" />
          </div>
          <div className="text-2xl font-black text-neon font-mono">{data?.winrate || 0}%</div>
          <span className="text-[10px] text-zinc-500">taxa de acerto global</span>
        </div>

        <div className="card p-4 border-line bg-panel col-span-2 sm:col-span-1">
          <div className="flex items-center justify-between mb-1">
            <span className="text-[11px] font-bold uppercase tracking-wider text-zinc-400">Resultado Líquido</span>
            <DollarSign className="h-4 w-4 text-zinc-400" />
          </div>
          <div
            className={`text-2xl font-black font-mono ${
              (data?.total_profit || 0) >= 0 ? 'text-emerald-400' : 'text-red-400'
            }`}
          >
            {(data?.total_profit || 0) >= 0 ? `+$${(data?.total_profit || 0).toFixed(2)}` : `-$${Math.abs(data?.total_profit || 0).toFixed(2)}`}
          </div>
          <span className="text-[10px] text-zinc-500">estimativa P&L</span>
        </div>
      </div>

      {/* GRÁFICO INTERATIVO DE DESEMPENHO NO TEMPO */}
      {data?.timeline && data.timeline.length > 0 && (
        <div className="card mb-6 p-5 border-line bg-panel">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h3 className="text-sm font-bold text-white flex items-center gap-2">
                <LayoutDashboard className="h-4 w-4 text-neon" />
                Evolução Operacional no Período (Greens vs Reds)
              </h3>
              <p className="text-xs text-zinc-400">Volume de vitórias e derrotas distribuídos ao longo do tempo.</p>
            </div>
            <div className="flex items-center gap-3 text-xs">
              <span className="flex items-center gap-1.5 text-emerald-400 font-semibold">
                <span className="h-2 w-2 rounded-full bg-emerald-400" /> Greens
              </span>
              <span className="flex items-center gap-1.5 text-red-400 font-semibold">
                <span className="h-2 w-2 rounded-full bg-red-400" /> Reds
              </span>
            </div>
          </div>

          <div className="h-64 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={data.timeline} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#27272a" />
                <XAxis dataKey="date" stroke="#71717a" tick={{ fontSize: 11 }} />
                <YAxis stroke="#71717a" tick={{ fontSize: 11 }} />
                <Tooltip
                  contentStyle={{ backgroundColor: '#18181b', borderColor: '#3f3f46', borderRadius: '0.75rem', fontSize: '12px' }}
                />
                <Bar dataKey="greens" fill="#10b981" radius={[4, 4, 0, 0]} name="Greens" />
                <Bar dataKey="reds" fill="#ef4444" radius={[4, 4, 0, 0]} name="Reds" />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      {/* ANÁLISE POR ATIVO & BLACKLIST */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-6">
        {/* Tabela de Ativos */}
        <div className="card p-5 border-line bg-panel lg:col-span-2">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h3 className="text-sm font-bold text-white">Desempenho por Ativo no Período</h3>
              <p className="text-xs text-zinc-400">Assertividade calculada para cada paridade operada.</p>
            </div>
            <span className="text-xs text-zinc-500 font-mono">{data?.asset_performance?.length || 0} ativos</span>
          </div>

          {(!data?.asset_performance || data.asset_performance.length === 0) ? (
            <div className="py-8 text-center text-xs text-zinc-500">
              Nenhuma operação registrada para os filtros selecionados.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead>
                  <tr className="border-b border-line text-zinc-400">
                    <th className="pb-2 font-semibold">Ativo</th>
                    <th className="pb-2 font-semibold">Trades</th>
                    <th className="pb-2 font-semibold">Greens</th>
                    <th className="pb-2 font-semibold">Reds</th>
                    <th className="pb-2 font-semibold">Winrate</th>
                    <th className="pb-2 font-semibold">P&L</th>
                    <th className="pb-2 font-semibold text-right">Ação</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line/40">
                  {data.asset_performance.map((item) => {
                    const blocked = isBlocked(item.asset);
                    return (
                      <tr key={item.asset} className="hover:bg-panel2/50 transition">
                        <td className="py-2.5 font-bold text-white flex items-center gap-1.5">
                          {item.asset}
                          {blocked && (
                            <span className="rounded bg-red-500/20 px-1 py-0.2 text-[9px] font-extrabold text-red-400">
                              BLACKLIST
                            </span>
                          )}
                        </td>
                        <td className="py-2.5 font-mono text-zinc-300">{item.trades}</td>
                        <td className="py-2.5 font-mono text-emerald-400 font-bold">{item.greens}</td>
                        <td className="py-2.5 font-mono text-red-400 font-bold">{item.reds}</td>
                        <td className="py-2.5">
                          <span
                            className={`font-mono font-bold ${
                              item.winrate >= 70 ? 'text-neon' : item.winrate >= 55 ? 'text-amber-300' : 'text-red-400'
                            }`}
                          >
                            {item.winrate}%
                          </span>
                        </td>
                        <td
                          className={`py-2.5 font-mono font-bold ${
                            item.profit >= 0 ? 'text-emerald-400' : 'text-red-400'
                          }`}
                        >
                          {item.profit >= 0 ? `+$${item.profit.toFixed(2)}` : `-$${Math.abs(item.profit).toFixed(2)}`}
                        </td>
                        <td className="py-2.5 text-right">
                          <button
                            type="button"
                            onClick={() => handleToggleBlacklist(item.asset)}
                            className={`btn-ghost text-[10px] px-2 py-1 ${
                              blocked
                                ? 'border-red-500/40 text-red-400 hover:bg-red-500/10'
                                : 'text-zinc-400 hover:text-white'
                            }`}
                            title={blocked ? 'Remover da Blacklist' : 'Bloquear ativo na Blacklist'}
                          >
                            <Ban className="h-3 w-3 mr-1 inline" />
                            {blocked ? 'Desbloquear' : 'Bloquear'}
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Card Informativo & Ações Rápidas */}
        <div className="space-y-4">
          <div className="card p-5 border-line bg-panel space-y-3">
            <h4 className="text-xs font-bold uppercase tracking-wider text-neon flex items-center gap-1.5">
              <Zap className="h-3.5 w-3.5" />
              Dicas de Gestão de Risco
            </h4>
            <p className="text-xs text-zinc-300 leading-relaxed">
              Ativos com assertividade inferior a <strong>60%</strong> no período ou com sequência de losses podem ser
              adicionados diretamente à <strong>Blacklist</strong>. O robô rejeitará sinais desses ativos até serem desbloqueados.
            </p>
            <div className="pt-2 border-t border-line/60">
              <Link to="/" className="btn-primary w-full text-xs py-2 flex items-center justify-center gap-1.5">
                Ir para Mesa Operacional
                <ArrowUpRight className="h-3.5 w-3.5" />
              </Link>
            </div>
          </div>

          <div className="card p-5 border-line bg-panel space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-white">Blacklist do Robô</span>
              <span className="text-xs font-mono text-neon">{blacklist.length} bloqueados</span>
            </div>
            {blacklist.length === 0 ? (
              <p className="text-xs text-zinc-500">Nenhum ativo bloqueado no momento.</p>
            ) : (
              <div className="flex flex-wrap gap-1.5 pt-1">
                {blacklist.map((b) => (
                  <span
                    key={b}
                    className="flex items-center gap-1 rounded bg-red-500/15 border border-red-500/30 px-2 py-0.5 text-xs font-bold text-red-300"
                  >
                    {b}
                    <button
                      type="button"
                      onClick={() => handleToggleBlacklist(b)}
                      className="hover:text-white"
                      title="Remover da Blacklist"
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* HISTÓRICO DE ENTRADAS RECENTES NO PERÍODO */}
      <div className="card p-5 border-line bg-panel">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h3 className="text-sm font-bold text-white flex items-center gap-2">
              <Clock className="h-4 w-4 text-neon" />
              Histórico Detalhado das Entradas no Período
            </h3>
            <p className="text-xs text-zinc-400">Lista com registro de ordens executadas e monitoradas.</p>
          </div>
          <span className="text-xs font-mono text-zinc-500">
            {data?.recent_trades?.length || 0} registradas
          </span>
        </div>

        {(!data?.recent_trades || data.recent_trades.length === 0) ? (
          <div className="py-8 text-center text-xs text-zinc-500">
            Nenhuma entrada registrada para este filtro de data e conta.
          </div>
        ) : (
          <div className="space-y-2">
            {data.recent_trades.map((tr, idx) => {
              const isWin = tr.outcome === 'WIN';
              return (
                <div
                  key={idx}
                  className="flex items-center justify-between rounded-xl bg-panel2 border border-line px-3 py-2.5 text-xs hover:border-zinc-600 transition"
                >
                  <div className="flex items-center gap-3">
                    <span
                      className={`font-black px-2 py-0.5 rounded text-[11px] ${
                        isWin ? 'bg-emerald-500/20 text-emerald-400' : 'bg-red-500/20 text-red-400'
                      }`}
                    >
                      {isWin ? 'GREEN' : 'RED'}
                    </span>
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-bold text-white">{tr.asset}</span>
                        <span className="text-zinc-500 font-mono text-[11px]">{tr.direction}</span>
                        <span className="text-zinc-500 font-mono text-[10px]">[{tr.timeframe}]</span>
                        <span
                          className={`rounded px-1 py-0.2 text-[9px] font-bold ${
                            tr.account_type === 'REAL' ? 'bg-cyan-500/20 text-cyan-300' : 'bg-amber-500/20 text-amber-300'
                          }`}
                        >
                          {tr.account_type === 'REAL' ? 'REAL' : 'DEMO'}
                        </span>
                      </div>
                      <span className="text-[10px] text-zinc-500">
                        {tr.date} às {tr.time}
                      </span>
                    </div>
                  </div>

                  <div className="text-right">
                    <span
                      className={`font-bold font-mono text-sm block ${
                        isWin ? 'text-emerald-400' : 'text-red-400'
                      }`}
                    >
                      {tr.profit >= 0 ? `+$${tr.profit.toFixed(2)}` : `-$${Math.abs(tr.profit).toFixed(2)}`}
                    </span>
                    <span className="text-[10px] text-zinc-500">Entrada: ${tr.stake.toFixed(2)}</span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </>
  );
}
