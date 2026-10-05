import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { History, RefreshCw, Wallet } from 'lucide-react';
import { Badge, EmptyState, Loading, PageHeader } from '../components/ui.jsx';
import { fetchIQAccount, fetchIQPositions, getIQSessionToken } from '../services/bridgeApi.js';

function formatMoney(value, currency) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return '—';
  const formatted = new Intl.NumberFormat('pt-BR', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);
  return `${formatted} ${currency || ''}`.trim();
}

function formatDate(value) {
  if (value == null || value === '') return '—';
  const numeric = Number(value);
  const date = Number.isFinite(numeric)
    ? new Date(numeric < 1e12 ? numeric * 1000 : numeric)
    : new Date(value);
  return Number.isNaN(date.getTime())
    ? '—'
    : new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' }).format(date);
}

export default function AccountEntries() {
  const [account, setAccount] = useState(null);
  const [positions, setPositions] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const hasSession = Boolean(getIQSessionToken());

  const load = useCallback(async () => {
    setBusy(true);
    setError('');
    const [accountResult, historyResult] = await Promise.allSettled([
      fetchIQAccount(),
      fetchIQPositions(100),
    ]);
    const failures = [];
    if (accountResult.status === 'fulfilled') {
      setAccount(accountResult.value);
    } else {
      setAccount(null);
      failures.push(`Saldo: ${accountResult.reason.message || 'não disponível'}`);
    }
    if (historyResult.status === 'fulfilled' && Array.isArray(historyResult.value)) {
      setPositions(historyResult.value);
    } else {
      failures.push(historyResult.status === 'rejected'
        ? `Histórico: ${historyResult.reason.message || 'não disponível'}`
        : 'A ponte retornou um histórico inválido.');
    }
    setError(failures.join(' · '));
    setBusy(false);
  }, []);

  useEffect(() => {
    if (hasSession) void load();
  }, [hasSession, load]);

  return (
    <>
      <PageHeader
        title="Entradas da conta"
        subtitle="Saldo atual e histórico recente consultados diretamente na conta real. Somente leitura; nenhuma ordem é enviada."
      >
        {hasSession && (
          <button className="btn-ghost" type="button" disabled={busy} onClick={load}>
            <RefreshCw className={`h-4 w-4 ${busy ? 'animate-spin' : ''}`} /> Atualizar
          </button>
        )}
      </PageHeader>

      {!hasSession ? (
        <div className="card p-6">
          <EmptyState
            title="Conecte sua conta real"
            text="Para consultar o saldo e as entradas, conecte sua conta IQ Option."
          />
          <div className="mt-4 text-center">
            <Link className="btn-primary" to="/conexao-iq">Conectar IQ Option</Link>
          </div>
        </div>
      ) : (
        <>
          <div className="mb-4 grid gap-3 sm:grid-cols-2">
            <div className="card flex items-center gap-4 p-5">
              <Wallet className="h-6 w-6 text-neon" />
              <div>
                <div className="text-xs text-zinc-500">Saldo atual · conta real</div>
                <div className="mt-1 text-2xl font-bold text-white">
                  {account ? formatMoney(account.balance, account.currency) : '—'}
                </div>
              </div>
            </div>
            <div className="card flex items-center gap-4 p-5">
              <History className="h-6 w-6 text-neon" />
              <div>
                <div className="text-xs text-zinc-500">Entradas recentes carregadas</div>
                <div className="mt-1 text-2xl font-bold text-white">{positions.length}</div>
              </div>
              <Badge tone="gray">até 100</Badge>
            </div>
          </div>

          {error && <p className="mb-4 rounded-lg border border-loss/30 p-3 text-sm text-loss" role="alert">{error}</p>}

          {busy && positions.length === 0 ? <Loading text="Carregando saldo e histórico…" /> : positions.length === 0 ? (
            <div className="card p-6">
              <EmptyState
                title={error ? 'Não foi possível carregar o histórico' : 'Nenhuma entrada encontrada'}
                text={error ? 'Confira a conexão da conta IQ Option e tente atualizar.' : 'A conta não retornou entradas recentes para os tipos de opções consultados.'}
              />
            </div>
          ) : (
            <div className="card overflow-x-auto">
              <table className="w-full min-w-[820px]">
                <thead className="border-b border-line">
                  <tr>
                    {['Abertura', 'Ativo', 'Tipo', 'Direção', 'Valor', 'Resultado', 'Status'].map((heading) => (
                      <th className="th" key={heading}>{heading}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {positions.map((position, index) => {
                    const profit = Number(position.profit);
                    const hasProfit = Number.isFinite(profit);
                    const direction = String(position.direction || '—').toUpperCase();
                    const status = String(position.status || '—').replaceAll('_', ' ');
                    return (
                      <tr key={position.id || `${position.asset_id}-${position.open_time}-${index}`} className="border-b border-line/60 last:border-0">
                        <td className="td">{formatDate(position.open_time)}</td>
                        <td className="td font-bold text-white">{position.asset || position.asset_id || '—'}</td>
                        <td className="td">{position.instrument_type || '—'}</td>
                        <td className="td">{direction}</td>
                        <td className="td">{formatMoney(position.amount, account?.currency)}</td>
                        <td className={`td font-bold ${hasProfit ? (profit > 0 ? 'text-neon' : profit < 0 ? 'text-loss' : 'text-zinc-300') : 'text-zinc-500'}`}>
                          {hasProfit ? formatMoney(profit, account?.currency) : '—'}
                        </td>
                        <td className="td"><Badge tone={status.toLowerCase() === 'closed' ? 'gray' : 'warn'}>{status}</Badge></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </>
  );
}
