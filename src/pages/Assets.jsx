import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { RefreshCw } from 'lucide-react';
import { getIQSessionToken } from '../services/bridgeApi.js';
import { useDataStatus } from '../services/dataStatus.js';
import { refreshIQActives } from '../data/candleData.js';
import { fmtPct } from '../lib/stats.js';
import { Badge, DataBadge, EmptyState, Loading, PageHeader } from '../components/ui.jsx';

export default function Assets() {
  const status = useDataStatus();
  const connected = Boolean(getIQSessionToken());
  const [loading, setLoading] = useState(connected && !status.activeAssetsAt);
  const [error, setError] = useState('');

  const refresh = async () => {
    setLoading(true);
    setError('');
    try {
      await refreshIQActives();
    } catch (requestError) {
      setError(requestError.message === 'Not Found'
        ? 'A ponte está desatualizada. Reinicie o servidor Python para carregar a nova rota de ativos.'
        : requestError.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (connected && !status.activeAssetsAt) void refresh();
  }, [connected, status.activeAssetsAt]);

  const assets = status.activeAssets;

  return (
    <>
      <PageHeader
        title="Ativos binários da IQ Option"
        subtitle="Lista ao vivo dos ativos binários abertos na sua conta, com payout informado pela plataforma."
      >
        <DataBadge />
        {connected && (
          <button className="btn-ghost" onClick={refresh} disabled={loading}>
            <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} /> Atualizar
          </button>
        )}
      </PageHeader>

      {error && status.activeAssetsAt > 0 && <p className="mb-4 text-sm text-loss" role="alert">{error}</p>}

      {!connected ? (
        <EmptyState
          title="Conecte sua conta IQ Option"
          text="A lista de ativos e os payouts só podem ser lidos da plataforma depois de conectar sua conta."
        >
          <Link className="btn-primary mt-4 inline-flex" to="/conexao-iq">Conectar IQ Option</Link>
        </EmptyState>
      ) : loading && !status.activeAssetsAt ? (
        <Loading text="Carregando ativos abertos da IQ Option…" />
      ) : error && !status.activeAssetsAt ? (
        <EmptyState title="Falha ao consultar os ativos da IQ Option" text={error}>
          <button className="btn-ghost mt-4" onClick={refresh} disabled={loading}>
            <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} /> Tentar novamente
          </button>
        </EmptyState>
      ) : assets.length === 0 ? (
        <EmptyState
          title="Nenhum ativo binário aberto"
          text="A IQ Option não retornou ativos binários abertos para esta conta. Atualize a lista ou tente novamente mais tarde."
        />
      ) : (
        <>
          <div className="mb-3 flex flex-wrap items-center gap-2 text-xs text-zinc-500">
            <Badge tone="neon">{assets.length} ativos abertos</Badge>
            <span>Ativos sem mapeamento de candles na biblioteca ficam visíveis, mas não podem ser analisados.</span>
          </div>
          <div className="card overflow-x-auto">
            <table className="w-full">
              <thead className="border-b border-line">
                <tr>
                  {['Ativo', 'Tipo', 'Payout atual', 'Mercado', 'Análise'].map((heading) => (
                    <th key={heading} className="th">{heading}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {assets.map((asset) => (
                  <tr key={asset.id} className="border-b border-line/60 last:border-0 hover:bg-panel2">
                    <td className="td font-bold text-white">{asset.name}</td>
                    <td className="td">{asset.type}</td>
                    <td className="td font-bold text-neon">{asset.payout ? fmtPct(asset.payout, 0) : '—'}</td>
                    <td className="td"><Badge tone="neon">Aberto</Badge></td>
                    <td className="td">
                      {asset.analysisSupported ? (
                        <Link
                          className="font-bold text-zinc-300 hover:text-neon"
                          to={`/scanner?asset=${encodeURIComponent(asset.id)}`}
                        >
                          Analisar estratégias
                        </Link>
                      ) : <span className="text-xs text-zinc-600">Candles não suportados</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {status.activeAssetsAt > 0 && (
            <p className="mt-3 text-right text-xs text-zinc-600">
              Atualizado às {new Date(status.activeAssetsAt).toLocaleTimeString()}
            </p>
          )}
        </>
      )}
    </>
  );
}
