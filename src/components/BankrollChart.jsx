import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend } from 'recharts';

// Evolução da banca (base 100 u) para Sem Gale / Gale 1 / Gale 2
export default function BankrollChart({ curves }) {
  const max = Math.max(...curves.map((c) => c.length));
  const data = Array.from({ length: max }, (_, i) => ({
    n: i, g0: curves[0]?.[i]?.bankroll, g1: curves[1]?.[i]?.bankroll, g2: curves[2]?.[i]?.bankroll,
  }));
  return (
    <ResponsiveContainer width="100%" height={280}>
      <LineChart data={data} margin={{ left: -10, right: 8, top: 8 }}>
        <CartesianGrid stroke="#1d2420" />
        <XAxis dataKey="n" stroke="#52605a" fontSize={11} />
        <YAxis stroke="#52605a" fontSize={11} domain={['auto', 'auto']} />
        <Tooltip contentStyle={{ background: '#0b0e0d', border: '1px solid #1d2420', borderRadius: 8 }} labelFormatter={(n) => `Operação ${n}`} />
        <Legend />
        <Line type="monotone" dataKey="g0" name="Sem Gale" stroke="#00FF88" dot={false} strokeWidth={2} connectNulls />
        <Line type="monotone" dataKey="g1" name="Gale 1" stroke="#ffb020" dot={false} strokeWidth={2} connectNulls />
        <Line type="monotone" dataKey="g2" name="Gale 2" stroke="#ff4d5e" dot={false} strokeWidth={2} connectNulls />
      </LineChart>
    </ResponsiveContainer>
  );
}
