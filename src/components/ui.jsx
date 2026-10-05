// Componentes de interface reutilizáveis.
import { Loader2, FlaskConical, Wifi, WifiOff } from 'lucide-react';
import { useDataStatus } from '../services/dataStatus.js';

export function PageHeader({ title, subtitle, children }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-2xl font-bold text-white sm:text-3xl">{title}</h1>
        {subtitle && <p className="mt-1 max-w-2xl text-sm text-zinc-500">{subtitle}</p>}
      </div>
      <div className="flex items-center gap-2">{children}</div>
    </div>
  );
}

export function StatCard({ label, value, hint, tone }) {
  const color = tone === 'good' ? 'text-neon' : tone === 'bad' ? 'text-loss' : tone === 'warn' ? 'text-warn' : 'text-white';
  return (
    <div className="card p-4">
      <div className="text-xs font-medium text-zinc-500">{label}</div>
      <div className={`mt-1 text-2xl font-bold ${color}`}>{value}</div>
      {hint && <div className="mt-1 text-xs text-zinc-600">{hint}</div>}
    </div>
  );
}

export function Field({ label, children }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-zinc-500">{label}</span>
      {children}
    </label>
  );
}

export function Select({ label, value, onChange, options }) {
  return (
    <Field label={label}>
      <select className="input" value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    </Field>
  );
}

export function Loading({ text = 'Calculando backtests…' }) {
  return (
    <div className="flex items-center justify-center gap-3 py-16 text-sm text-zinc-500" role="status">
      <Loader2 className="h-5 w-5 animate-spin text-neon" /> {text}
    </div>
  );
}

export function EmptyState({ title, text, children }) {
  return (
    <div className="card px-6 py-12 text-center">
      <div className="font-bold text-white">{title}</div>
      <p className="mx-auto mt-1 max-w-md text-sm text-zinc-500">{text}</p>
      {children}
    </div>
  );
}

const TONES = {
  neon: 'border-neon/40 text-neon bg-neon/10',
  warn: 'border-warn/40 text-warn bg-warn/10',
  loss: 'border-loss/40 text-loss bg-loss/10',
  gray: 'border-line text-zinc-400 bg-panel2',
};
export function Badge({ tone = 'gray', children }) {
  return <span className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs font-bold ${TONES[tone]}`}>{children}</span>;
}

export const ConfidenceBadge = ({ confidence }) => <Badge tone={confidence.tone}>{confidence.level}</Badge>;

export function DirectionBadge({ direction }) {
  return <Badge tone={direction === 'CALL' ? 'neon' : 'loss'}>{direction}</Badge>;
}

// Badge "dados simulados" / "dados reais" conforme a fonte usada pela última chamada,
// + um mini badge secundário do estado WebSocket (browser ↔ ponte) quando WS estiver
// configurado.
function WsBadge() {
  const st = useDataStatus();
  if (!st || st.wsStatus === 'unknown' || st.wsStatus === 'disabled') return null;
  if (st.wsStatus === 'open') {
    return <Badge tone="neon"><Wifi className="h-3 w-3" /> WS ao vivo</Badge>;
  }
  if (st.wsStatus === 'connecting' || st.wsStatus === 'authenticating') {
    return <Badge tone="warn"><Loader2 className="h-3 w-3 animate-spin" /> WS conectando</Badge>;
  }
  if (st.wsStatus === 'closed') {
    const attempts = st.wsReconnectAttempts || 0;
    return <Badge tone="loss"><WifiOff className="h-3 w-3" /> WS caiu{attempts ? ` · retry ${attempts}` : ''}</Badge>;
  }
  return null;
}
export function DataBadge() {
  const { candles, bridgeOnline } = useDataStatus();
  let primary = null;
  if (candles === 'live') primary = <Badge tone="neon"><Wifi className="h-3 w-3" /> dados reais · IQ Option</Badge>;
  else if (candles === 'cache') primary = <Badge tone="neon"><Wifi className="h-3 w-3" /> dados em cache · IQ</Badge>;
  else if (candles === 'simulated') primary = <Badge tone="warn"><FlaskConical className="h-3 w-3" /> dados simulados</Badge>;
  else if (bridgeOnline === false) primary = <Badge tone="loss"><WifiOff className="h-3 w-3" /> ponte offline · simulados</Badge>;
  else primary = <Badge tone="gray"><WifiOff className="h-3 w-3" /> carregando fonte…</Badge>;
  return (
    <div className="flex flex-wrap items-center gap-2">
      {primary}
      <WsBadge />
    </div>
  );
}

// Cor do valor conforme positivo/negativo
export const signClass = (v) => (v > 0 ? 'text-neon' : v < 0 ? 'text-loss' : 'text-zinc-300');
