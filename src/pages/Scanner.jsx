import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { RefreshCw } from 'lucide-react';
import { getAvailableAssets } from '../data/candleData.js';
import { getIQSessionToken } from '../services/bridgeApi.js';
import { IMPLEMENTED_STRATEGIES } from '../data/strategies.js';
import {
  getCatalogSnapshot, refreshCatalog, subscribeCatalog, VALIDATION_TIMEFRAMES,
} from '../lib/strategyValidation.js';
import { useDataStatus } from '../services/dataStatus.js';
import { fmtPct, fmtUnits } from '../lib/stats.js';
import { PageHeader, Select, Field, Loading, EmptyState, ConfidenceBadge, DataBadge, signClass } from '../components/ui.jsx';

const SORTS = {
  expectancy: (a, b) => b.stats.expectancy - a.stats.expectancy,
  winRate: (a, b) => b.stats.winRate - a.stats.winRate,
  signals: (a, b) => b.stats.n - a.stats.n,
  drawdown: (a, b) => a.stats.maxDrawdown - b.stats.maxDrawdown,
};

export default function Scanner() {
  const [searchParams] = useSearchParams();
  const status = useDataStatus();
  const availableAssets = getAvailableAssets({ analysisOnly: true });
  const [f, setF] = useState({
    tf: 'ALL', asset: searchParams.get('asset') || availableAssets[0]?.id || 'ALL', strategy: 'ALL',
    minPayout: '85', minOps: '0', minWin: '0', sort: 'expectancy',
  });
  const [rows, setRows] = useState(() => getCatalogSnapshot().rows);
  const [loading, setLoading] = useState(rows.length === 0);
  const [error, setError] = useState('');
  const set = (k) => (v) => setF((p) => ({ ...p, [k]: v }));

  useEffect(() => {
    if (!searchParams.get('asset') && status.activeAssetsAt && f.asset === 'ALL' && availableAssets.length) {
      setF((previous) => ({ ...previous, asset: availableAssets[0].id }));
      return undefined;
    }
    setLoading(true);
    setError('');
    const unsubscribe = subscribeCatalog(({ rows: updated }) => {
      setRows(updated);
      setLoading(false);
    });
    refreshCatalog({
      assets: f.asset === 'ALL' ? undefined : [f.asset],
    }).catch((error) => {
      console.error('[Scanner] falha ao atualizar catálogo:', error);
      setError(error.message);
      setLoading(false);
    });
    return unsubscribe;
  }, [f.asset, status.activeAssetsAt]);

  const shown = useMemo(() => (rows || [])
    .filter((r) => (f.tf === 'ALL' || r.tf === f.tf)
      && (f.asset === 'ALL' || r.asset === f.asset)
      && (f.strategy === 'ALL' || r.strategy.id === f.strategy)
      && r.stats.n >= Number(f.minOps)
      && r.payout >= Number(f.minPayout)
      && r.stats.winRate >= Number(f.minWin))
    .sort(SORTS[f.sort]), [rows, f.tf, f.asset, f.strategy, f.minOps, f.minPayout, f.minWin, f.sort]);

  return (
    <>
      <PageHeader title="Strategy Scanner" subtitle="Validação por paridade e estratégia: M1 usa 1h e M5 usa 2h; os candles anteriores servem apenas para aquecer os indicadores."><DataBadge /></PageHeader>
      {error && <p className="mb-4 text-sm text-loss" role="alert">{error}</p>}

      <div className="card mb-4 grid grid-cols-2 gap-3 p-4 md:grid-cols-4 xl:grid-cols-6">
        <Select label="Timeframe" value={f.tf} onChange={set('tf')} options={[{ value: 'ALL', label: 'M1 + M5' }, ...VALIDATION_TIMEFRAMES.map((tf) => ({ value: tf, label: tf }))]} />
        <Select
          label="Ativo"
          value={f.asset}
          onChange={set('asset')}
          options={[
            ...(!getIQSessionToken() || !availableAssets.length ? [{ value: 'ALL', label: getIQSessionToken() ? 'Aguardando ativos' : 'Todos' }] : []),
            ...availableAssets.map((a) => ({ value: a.id, label: a.name })),
          ]}
        />
        <Select label="Estratégia" value={f.strategy} onChange={set('strategy')} options={[{ value: 'ALL', label: 'Todas implementadas' }, ...IMPLEMENTED_STRATEGIES.map((s) => ({ value: s.id, label: s.name }))]} />
        <Field label="Payout mínimo (%)"><input className="input" type="number" min="0" max="100" value={f.minPayout} onChange={(e) => set('minPayout')(e.target.value)} /></Field>
        <Field label="Mín. de operações"><input className="input" type="number" min="0" value={f.minOps} onChange={(e) => set('minOps')(e.target.value)} /></Field>
        <Field label="Assertividade mín. (%)"><input className="input" type="number" min="0" max="100" value={f.minWin} onChange={(e) => set('minWin')(e.target.value)} /></Field>
        <Select label="Ordenar por" value={f.sort} onChange={set('sort')} options={[
          { value: 'expectancy', label: 'Expectância' }, { value: 'winRate', label: 'Assertividade' },
          { value: 'signals', label: 'Nº de sinais' }, { value: 'drawdown', label: 'Menor drawdown' }]} />
        <button className="btn-ghost self-end" onClick={() => {
          setLoading(true);
          setError('');
          refreshCatalog({
            assets: f.asset === 'ALL' ? undefined : [f.asset],
            force: true,
          }).catch((error) => {
            console.error('[Scanner] falha ao atualizar catálogo:', error);
            setError(error.message);
            setLoading(false);
          });
        }}><RefreshCw className="h-4 w-4" /> Atualizar catálogo</button>
      </div>

      {loading ? <Loading /> : shown.length === 0 ? (
        <EmptyState title="Nenhuma configuração encontrada" text="Aguarde a análise dos candles reais ou ajuste os filtros. Para gerar sinais, são necessárias 10 operações e assertividade acima do break-even." />
      ) : (
        <>
          <p className="mb-2 text-xs text-zinc-500">{shown.length} configurações (exibindo as 200 primeiras). Aprovada = dados reais, mínimo de 10 operações e assertividade acima do break-even.</p>
          <div className="card overflow-x-auto">
            <table className="w-full">
              <thead className="border-b border-line"><tr>
                {['Estratégia', 'Ativo', 'TF', 'Sinais', 'WIN', 'LOSS', 'Assertividade', 'Payout', 'Break-even', 'Expectância', 'Drawdown', 'Confiança', 'Validação'].map((h) => <th key={h} className="th">{h}</th>)}
              </tr></thead>
              <tbody>
                {shown.slice(0, 200).map((r) => (
                  <tr key={r.key} className="border-b border-line/60 last:border-0 hover:bg-panel2">
                    <td className="td font-bold"><Link className="text-white hover:text-neon" to={`/estrategias/${r.strategy.id}?asset=${encodeURIComponent(r.asset)}&tf=${r.tf}&gale=0&validation=1`}>{r.strategy.name}</Link></td>
                    <td className="td">{r.asset}</td>
                    <td className="td">{r.tf}</td>
                    <td className="td">{r.stats.n}</td>
                    <td className="td text-neon">{r.stats.wins}</td>
                    <td className="td text-loss">{r.stats.losses}</td>
                    <td className={`td font-bold ${signClass(r.stats.edge)}`}>{fmtPct(r.stats.winRate)}</td>
                    <td className="td">{fmtPct(r.payout, 0)}</td>
                    <td className="td text-zinc-500">{fmtPct(r.stats.breakEven)}</td>
                    <td className={`td ${signClass(r.stats.expectancy)}`}>{fmtUnits(r.stats.expectancy, 3)}</td>
                    <td className="td text-zinc-400">{fmtUnits(-r.stats.maxDrawdown, 1)}</td>
                    <td className="td"><ConfidenceBadge confidence={r.stats.confidence} /></td>
                    <td className={`td font-bold ${r.eligible ? 'text-neon' : 'text-zinc-500'}`}>{r.eligible ? 'Aprovada' : (r.source === 'live' ? 'Reprovada' : 'Sem dados reais')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
}
