// Mini-gráfico SVG de candles ao redor de uma operação, com marcadores de entrada e saída.
export default function CandleMiniChart({ candles, trade }) {
  const from = Math.max(0, trade.index - 14);
  const to = Math.min(candles.length - 1, trade.endIndex + 4);
  const view = candles.slice(from, to + 1);
  const W = 520, H = 170, pad = 10;
  const hi = Math.max(...view.map((c) => c.high)), lo = Math.min(...view.map((c) => c.low));
  const y = (v) => pad + ((hi - v) / (hi - lo || 1)) * (H - pad * 2);
  const step = (W - pad * 2) / view.length;
  const x = (i) => pad + (i - from) * step + step / 2;
  const win = trade.result === 'WIN';
  const entryIndex = trade.entryIndex ?? trade.index;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full rounded-lg border border-line bg-ink" role="img" aria-label="Candles da operação">
      {entryIndex !== trade.index && <line x1={x(trade.index)} x2={x(trade.index)} y1={0} y2={H} stroke="#8A8A8A" strokeDasharray="3 3" opacity=".6" />}
      <line x1={x(entryIndex)} x2={x(entryIndex)} y1={0} y2={H} stroke="#00FF88" strokeDasharray="3 3" opacity=".6" />
      <line x1={x(trade.endIndex)} x2={x(trade.endIndex)} y1={0} y2={H} stroke={win ? '#00FF88' : '#ff4d5e'} strokeDasharray="3 3" opacity=".6" />
      {view.map((c, k) => {
        const i = from + k, up = c.close >= c.open, color = up ? '#00FF88' : '#ff4d5e';
        const top = y(Math.max(c.open, c.close)), bot = y(Math.min(c.open, c.close));
        return (
          <g key={i}>
            <line x1={x(i)} x2={x(i)} y1={y(c.high)} y2={y(c.low)} stroke={color} />
            <rect x={x(i) - step * 0.32} y={top} width={step * 0.64} height={Math.max(1.5, bot - top)} fill={color} />
          </g>
        );
      })}
      <text x={x(entryIndex) + 4} y={14} fill="#00FF88" fontSize="11" fontWeight="700">ENTRADA {trade.direction}</text>
      <text x={Math.min(x(trade.endIndex) + 4, W - 60)} y={30} fill={win ? '#00FF88' : '#ff4d5e'} fontSize="11" fontWeight="700">{trade.result}</text>
    </svg>
  );
}
