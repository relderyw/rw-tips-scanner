import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Search } from 'lucide-react';
import { STRATEGIES, CATEGORIES, STATUS, isStrategyBacktestEnabled } from '../data/strategies.js';
import { PageHeader, Badge, EmptyState } from '../components/ui.jsx';

const statusTone = {
  [STATUS.IMPLEMENTED]: 'neon',
  [STATUS.VALIDATION_PENDING]: 'warn',
  [STATUS.RULE_PENDING]: 'warn',
  [STATUS.DISABLED]: 'gray',
};

export default function Strategies() {
  const [q, setQ] = useState('');
  const [cat, setCat] = useState('ALL');
  const implementedCount = STRATEGIES.filter(isStrategyBacktestEnabled).length;
  const rulePendingCount = STRATEGIES.filter((strategy) => strategy.status === STATUS.RULE_PENDING).length;
  const validationPendingCount = STRATEGIES.filter((strategy) => strategy.status === STATUS.VALIDATION_PENDING).length;

  const list = useMemo(() => STRATEGIES.filter((strategy) =>
    (cat === 'ALL' || strategy.category === cat) &&
    (strategy.name + strategy.description + strategy.category).toLowerCase().includes(q.toLowerCase())), [q, cat]);

  return (
    <>
      <PageHeader
        title="Estratégias"
        subtitle={`${implementedCount} implementada${implementedCount === 1 ? '' : 's'} · ${validationPendingCount} aguardando validação · ${rulePendingCount} aguardando regra.`}
      />
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <div className="relative w-full sm:w-72">
          <Search className="absolute left-3 top-2.5 h-4 w-4 text-zinc-600" />
          <input className="input pl-9" placeholder="Buscar estratégia…" value={q} onChange={(event) => setQ(event.target.value)} />
        </div>
        <div className="flex flex-wrap gap-2">
          {['ALL', ...CATEGORIES].map((category) => (
            <button key={category} onClick={() => setCat(category)}
              className={`rounded-full border px-3 py-1 text-xs font-bold transition ${cat === category ? 'border-neon bg-neon text-black' : 'border-line text-zinc-400 hover:border-neon/50'}`}>
              {category === 'ALL' ? 'Todas' : category}
            </button>
          ))}
        </div>
      </div>

      {list.length === 0 ? <EmptyState title="Nada encontrado" text="Tente outro termo ou limpe o filtro de categoria." /> : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {list.map((strategy) => {
            const enabled = isStrategyBacktestEnabled(strategy);
            const rule = strategy.rules;
            return (
              <div key={strategy.id} className={`card flex flex-col gap-3 p-4 ${enabled ? 'transition hover:border-neon/50 hover:shadow-glowSm' : 'opacity-90'}`}>
                <div className="flex items-start justify-between gap-2">
                  <h3 className="font-bold text-white">{strategy.name}</h3>
                  <div className="flex flex-wrap justify-end gap-1">
                    <Badge tone="gray">{strategy.category}</Badge>
                    <Badge tone={statusTone[strategy.status]}>{strategy.status}</Badge>
                  </div>
                </div>
                <p className="text-sm text-zinc-500">{strategy.description}</p>
                <p className="text-xs text-zinc-300">{strategy.ruleSummary}</p>
                <div className="grid grid-cols-2 gap-2 text-xs text-zinc-400">
                  <p><span className="text-zinc-600">Timeframe:</span> {rule.timeframe ?? 'Não definido'}</p>
                  <p><span className="text-zinc-600">Referências:</span> {rule.referenceCandles ?? 'Não definida'}</p>
                  <p><span className="text-zinc-600">Entrada:</span> {rule.entry ?? 'Não definida'}</p>
                  <p><span className="text-zinc-600">Expiração:</span> {rule.expiration ?? 'Não definida'}</p>
                </div>
                {(rule.pros.length > 0 || rule.cons.length > 0) && (
                  <div className="grid grid-cols-2 gap-3 text-xs">
                    <div><h4 className="mb-1 font-bold text-neon">Prós</h4><ul className="space-y-1 text-zinc-400">{rule.pros.map((item) => <li key={item}>+ {item}</li>)}</ul></div>
                    <div><h4 className="mb-1 font-bold text-loss">Contras</h4><ul className="space-y-1 text-zinc-400">{rule.cons.map((item) => <li key={item}>− {item}</li>)}</ul></div>
                  </div>
                )}
                <div className="mt-auto flex items-center gap-2 text-xs text-zinc-400">
                  {rule.timeframe && <Badge tone="neon">{rule.timeframe}</Badge>}
                  {rule.complexity && <Badge>Complexidade {rule.complexity}</Badge>}
                </div>
                <Link className="text-sm font-bold text-neon hover:text-white" to={`/estrategias/${strategy.id}`}>
                  Ver regra completa
                </Link>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}
