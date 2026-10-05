import { Fragment, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine, CartesianGrid } from 'recharts';
import { getStrategy, isStrategyBacktestEnabled } from '../data/strategies.js';
import { getAvailableAssets, PERIODS } from '../data/candleData.js';
import { runConfig } from '../lib/runner.js';
import { getEvaluationHours, validatePair } from '../lib/strategyValidation.js';
import { useAsync } from '../lib/hooks.js';
import { useDataStatus } from '../services/dataStatus.js';
import { fmtPct, fmtNum, fmtUnits, fmtPrice, fmtDateTime } from '../lib/stats.js';
import { PageHeader, StatCard, Select, Loading, Badge, ConfidenceBadge, DirectionBadge, DataBadge, EmptyState, signClass } from '../components/ui.jsx';
import CandleMiniChart from '../components/CandleMiniChart.jsx';
import BankrollChart from '../components/BankrollChart.jsx';

function ExamplePanel({ title, example, tone }) {
  const sequence = Array.isArray(example.sequence)
    ? example.sequence.map((direction, index) => ({ direction, label: `Vela ${index + 1}` }))
    : [];
  const candles = [
    ...sequence,
    ...(example.candles || []).map((candle) => ({ ...candle, label: candle.time })),
    ...(example.entry ? [{ ...example.entry, label: example.entry.time, entry: true }] : []),
  ];
  return (
    <div className="rounded-lg border border-line bg-black/20 p-3">
      <h4 className={`mb-2 text-xs font-bold ${tone === 'good' ? 'text-neon' : 'text-warn'}`}>{title}</h4>
      {example.blockStart && <p className="mb-2 text-xs text-zinc-500">Bloco iniciado às {example.blockStart}</p>}
      {candles.length > 0 ? <div className="flex flex-wrap gap-2">
        {candles.map((candle, index) => (
          <div key={`${candle.label}-${index}`} className={`min-w-20 rounded border p-2 text-center ${candle.direction === 'CALL' ? 'border-neon/40 bg-neon/5' : candle.direction === 'PUT' ? 'border-loss/40 bg-loss/5' : 'border-warn/40 bg-warn/5'}`}>
            <div className="text-[10px] text-zinc-500">{candle.entry ? 'ENTRADA' : candle.label}</div>
            <div className={`mt-1 text-xs font-bold ${candle.direction === 'CALL' ? 'text-neon' : candle.direction === 'PUT' ? 'text-loss' : 'text-warn'}`}>{candle.direction}</div>
          </div>
        ))}
      </div> : <p className="text-sm text-zinc-300">{example.sequence}</p>}
      {example.expiration && <p className="mt-2 text-xs text-zinc-400">{example.expiration}</p>}
      <p className="mt-2 text-xs font-medium text-zinc-300">{example.expected}</p>
    </div>
  );
}

function StrategyRuleDocumentation({ strategy }) {
  const rule = strategy.rules;
  const fields = [
    ['Timeframe', rule.timeframe],
    ['Candles de referência', rule.referenceCandles],
    ['Ciclo / bloco', rule.cycle],
    ['Condição matemática', rule.condition],
    ['Direção', rule.direction],
    ['Entrada', rule.entry],
    ['Expiração', rule.expiration],
    ['Validação do sinal', rule.signalValidation],
    ['Cancelamento', rule.cancellation],
    ['Doji / empate', rule.dojiAndTie],
    ['Precisão do preço', rule.pricePrecision],
    ['Complexidade', rule.complexity],
    ['Fonte / justificativa', rule.source?.details],
  ];
  return (
    <section className="card mt-4 space-y-4 p-4">
      <div>
        <h3 className="font-bold text-white">Regra operacional completa</h3>
        <p className="mt-1 text-xs text-zinc-500">Status: {strategy.status}. {strategy.notes}</p>
      </div>
      <dl className="grid gap-3 sm:grid-cols-2">
        {fields.filter(([, value]) => value !== null && value !== undefined).map(([label, value]) => (
          <div key={label} className="rounded-lg bg-black/20 p-3">
            <dt className="text-xs font-bold text-zinc-500">{label}</dt>
            <dd className="mt-1 text-sm text-zinc-300">{typeof value === 'object' ? JSON.stringify(value) : value}</dd>
          </div>
        ))}
      </dl>
      <div className="grid gap-3 lg:grid-cols-2">
        <ExamplePanel title="Exemplo de entrada válida" example={rule.validExample} tone="good" />
        <ExamplePanel title="Exemplo de entrada inválida" example={rule.invalidExample} tone="warn" />
      </div>
      {strategy.validation?.approved !== true && (
        <p className="text-sm text-warn">Esta variante ainda não foi aprovada para backtest/scanner.</p>
      )}
    </section>
  );
}

export default function StrategyDetail() {
  const { id } = useParams();
  const strategy = getStrategy(id);
  const ds = useDataStatus();
  const availableAssets = getAvailableAssets({ analysisOnly: true });
  const [sp] = useSearchParams();
  const validationMode = sp.get('validation') === '1';
  const [cfg, setCfg] = useState({
    asset: sp.get('asset') || 'EURUSD',
    tf: strategy?.rules?.timeframe || sp.get('tf') || 'M5',
    hours: sp.get('hours') || '168',
    gale: sp.get('gale') || '0',
  });
  const [open, setOpen] = useState(null);
  const set = (k) => (v) => { setCfg((p) => ({ ...p, [k]: v })); setOpen(null); };

  const { data, loading, error } = useAsync(async () => {
    if (!strategy) return null;
    if (!isStrategyBacktestEnabled(strategy)) return null;
    if (validationMode) {
      const pair = await validatePair(cfg.asset, cfg.tf);
      const validated = pair.strategies.find((item) => item.strategy.id === strategy.id);
      if (!validated) return null;
      const runs = validated.runs.map((run) => ({
        ...run,
        payout: pair.payout,
        source: pair.source,
        candles: pair.candles,
      }));
      return { runs, main: runs[Number(cfg.gale)] };
    }
    const base = { asset: cfg.asset, tf: cfg.tf, hours: Number(cfg.hours), strategy };
    // Roda os 3 níveis para montar a comparação de banca; o nível escolhido define as estatísticas
    const runs = await Promise.all([0, 1, 2].map((g) => runConfig({ ...base, gale: g })));
    return { runs, main: runs[Number(cfg.gale)] };
  }, [id, cfg.asset, cfg.tf, cfg.hours, cfg.gale, ds.payoutsAt, validationMode]);

  if (!strategy) return <EmptyState title="Estratégia não encontrada" text="Volte ao catálogo e escolha uma estratégia." />;
  if (error) return <EmptyState title="Falha ao carregar a análise" text={error.message} />;
  if (!isStrategyBacktestEnabled(strategy)) {
    return (
      <>
        <Link to="/estrategias" className="mb-3 inline-flex items-center gap-1 text-sm text-zinc-500 hover:text-neon"><ArrowLeft className="h-4 w-4" /> Estratégias</Link>
        <PageHeader title={strategy.name} subtitle={strategy.description} />
        <StrategyRuleDocumentation strategy={strategy} />
        {strategy.status === 'REGRA PENDENTE' && (
          <div className="mt-4"><EmptyState title="Aguardando definição" text={strategy.notes} /></div>
        )}
      </>
    );
  }

  const s = data?.main.stats;
  return (
    <>
      <Link to="/estrategias" className="mb-3 inline-flex items-center gap-1 text-sm text-zinc-500 hover:text-neon"><ArrowLeft className="h-4 w-4" /> Estratégias</Link>
      <PageHeader title={strategy.name} subtitle={strategy.description}><DataBadge /></PageHeader>
      <StrategyRuleDocumentation strategy={strategy} />

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="card p-4 lg:col-span-2">
          <div className="mb-3 flex flex-wrap gap-2"><Badge tone="gray">{strategy.category}</Badge><Badge tone="neon">{strategy.rules.timeframe} recomendado</Badge><Badge>{strategy.expiration} {strategy.expiration > 1 ? 'velas' : 'vela'} de expiração</Badge></div>
          <h3 className="text-sm font-bold text-white">Resumo da regra</h3>
          <p className="mt-1 text-sm text-zinc-400">{strategy.ruleSummary}</p>
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <div><h4 className="mb-1 text-xs font-bold text-neon">Prós</h4><ul className="space-y-1 text-sm text-zinc-400">{strategy.rules.pros.map((p) => <li key={p}>+ {p}</li>)}</ul></div>
            <div><h4 className="mb-1 text-xs font-bold text-loss">Contras</h4><ul className="space-y-1 text-sm text-zinc-400">{strategy.rules.cons.map((p) => <li key={p}>− {p}</li>)}</ul></div>
          </div>
        </div>
        <div className="card grid grid-cols-2 content-start gap-3 p-4">
          <Select label="Ativo" value={cfg.asset} onChange={set('asset')} options={availableAssets.map((a) => ({ value: a.id, label: a.name }))} />
          <Select label="Timeframe" value={cfg.tf} onChange={set('tf')} options={[{ value: strategy.timeframe, label: strategy.timeframe }]} />
          {validationMode
            ? <div className="col-span-2 self-end pb-2 text-xs text-zinc-400">Janela avaliada: {getEvaluationHours(cfg.tf) ?? '—'}h · candles anteriores usados só para aquecimento.</div>
            : <Select label="Período" value={cfg.hours} onChange={set('hours')} options={PERIODS.map((p) => ({ value: String(p.hours), label: p.label }))} />}
          <Select label="Gale" value={cfg.gale} onChange={set('gale')} options={[{ value: '0', label: 'Sem Gale' }, { value: '1', label: 'Gale 1' }, { value: '2', label: 'Gale 2' }]} />
        </div>
      </div>

      {loading || !s ? <Loading /> : s.n === 0 ? (
        <div className="mt-6"><EmptyState title="Sem operações nesta configuração" text={validationMode ? 'Não houve operações completas na janela avaliada para esta paridade e timeframe.' : 'Tente um período maior (7 ou 30 dias) ou outro timeframe/ativo.'} /></div>
      ) : (
        <>
          <div className="mt-6 grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-6">
            <StatCard label="Sinais" value={s.n} hint={`${s.wins} WIN · ${s.losses} LOSS · ${s.dojis} DOJI`} />
            <StatCard label="Assertividade" value={fmtPct(s.winRate)} tone={s.edge > 0 ? 'good' : 'bad'} hint={`Break-even ${fmtPct(s.breakEven)} (payout ${fmtPct(data.main.payout, 0)})`} />
            <StatCard label="IC 95% (Wilson)" value={`${fmtNum(s.ci.low, 0)}–${fmtNum(s.ci.high, 0)}%`} hint="Faixa plausível do acerto real" />
            <StatCard label="Expectância / op." value={fmtUnits(s.expectancy, 3)} tone={s.expectancy > 0 ? 'good' : 'bad'} hint="em unidades da entrada base" />
            <StatCard label="ROI" value={fmtPct(s.roi)} tone={s.roi > 0 ? 'good' : 'bad'} hint={`Lucro total ${fmtUnits(s.totalProfit)}`} />
            <StatCard label="Profit factor" value={s.profitFactor == null ? '∞' : fmtNum(s.profitFactor, 2)} tone={s.profitFactor == null || s.profitFactor > 1 ? 'good' : 'bad'} />
            <StatCard label="Drawdown máx." value={fmtPct(s.maxDrawdownPct)} tone="warn" hint={fmtUnits(-s.maxDrawdown, 1)} />
            <StatCard label="Maior seq. de WIN" value={s.maxWinStreak} />
            <StatCard label="Maior seq. de LOSS" value={s.maxLossStreak} tone="bad" />
            <div className="card flex flex-col justify-between p-4"><div className="text-xs font-medium text-zinc-500">Confiança da amostra</div><ConfidenceBadge confidence={s.confidence} /></div>
          </div>

          <div className="mt-6 grid gap-4 lg:grid-cols-2">
            <div className="card p-4">
              <h3 className="mb-3 font-bold text-white">CALL vs PUT</h3>
              <table className="w-full"><thead><tr>{['Direção', 'Sinais', 'WIN', 'LOSS', 'Assertividade'].map((h) => <th key={h} className="th">{h}</th>)}</tr></thead>
                <tbody>{['CALL', 'PUT'].map((d) => { const x = s.byDirection[d]; return (
                  <tr key={d} className="border-t border-line/60"><td className="td"><DirectionBadge direction={d} /></td><td className="td">{x.n}</td><td className="td text-neon">{x.wins}</td><td className="td text-loss">{x.losses}</td><td className={`td font-bold ${signClass(x.winRate - s.breakEven)}`}>{fmtPct(x.winRate)}</td></tr>); })}</tbody></table>
              {Number(cfg.gale) > 0 && <p className="mt-3 text-xs text-zinc-500">WIN por nível — entrada: {s.byLevel[0]} · Gale 1: {s.byLevel[1]} · Gale 2: {s.byLevel[2]}</p>}
            </div>
            <div className="card p-4">
              <h3 className="mb-3 font-bold text-white">Distribuição por blocos <span className="text-xs font-medium text-zinc-500">(assertividade em 5 janelas cronológicas)</span></h3>
              <ResponsiveContainer width="100%" height={190}>
                <BarChart data={s.blocks} margin={{ left: -20, top: 8 }}>
                  <CartesianGrid stroke="#1d2420" vertical={false} />
                  <XAxis dataKey="label" stroke="#52605a" fontSize={11} /><YAxis stroke="#52605a" fontSize={11} domain={[0, 100]} />
                  <Tooltip contentStyle={{ background: '#0b0e0d', border: '1px solid #1d2420', borderRadius: 8 }} formatter={(v, _n, p) => [`${v}% (${p.payload.n} ops)`, 'Assertividade']} />
                  <ReferenceLine y={s.breakEven} stroke="#ffb020" strokeDasharray="4 4" />
                  <Bar dataKey="winRate" fill="#00FF88" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
              <p className="text-xs text-zinc-600">Linha tracejada = break-even. Blocos muito variáveis indicam resultado instável.</p>
            </div>
          </div>

          <div className="card mt-4 p-4">
            <h3 className="mb-3 font-bold text-white">Evolução da banca <span className="text-xs font-medium text-zinc-500">(base 100 u, entrada de 1 u, Gale ×2)</span></h3>
            <BankrollChart curves={data.runs.map((r) => r.stats.equity)} />
          </div>

          <div className="card mt-4 overflow-x-auto p-4">
            <h3 className="mb-3 font-bold text-white">50 operações mais recentes <span className="text-xs font-medium text-zinc-500">(clique para ver os candles)</span></h3>
            <table className="w-full"><thead><tr>{['Data', 'Direção', 'Entrada', 'Saída', 'Resultado', 'Nível', 'Lucro'].map((h) => <th key={h} className="th">{h}</th>)}</tr></thead>
              <tbody>
                {[...data.main.trades].reverse().slice(0, 50).map((t) => (
                  <Fragment key={t.index}>
                    <tr onClick={() => setOpen(open === t.index ? null : t.index)} className="cursor-pointer border-t border-line/60 hover:bg-panel2">
                      <td className="td">{fmtDateTime(t.time)}</td><td className="td"><DirectionBadge direction={t.direction} /></td>
                      <td className="td">{fmtPrice(t.entry)}</td><td className="td">{fmtPrice(t.exit)}</td>
                      <td className="td"><Badge tone={t.result === 'WIN' ? 'neon' : t.result === 'LOSS' ? 'loss' : 'gray'}>{t.result}</Badge></td>
                      <td className="td">{t.level === 0 ? 'Entrada' : `Gale ${t.level}`}</td>
                      <td className={`td ${signClass(t.profit)}`}>{fmtUnits(t.profit)}</td>
                    </tr>
                    {open === t.index && <tr><td colSpan={7} className="p-3"><CandleMiniChart candles={data.main.candles} trade={t} /></td></tr>}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
}
