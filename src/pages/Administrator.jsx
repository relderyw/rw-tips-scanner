import { useState } from 'react';
import { Navigate } from 'react-router-dom';
import { KeyRound, UserPlus } from 'lucide-react';
import { useAuth } from '../context/AuthContext.jsx';
import { PageHeader } from '../components/ui.jsx';
import { createAdminUser } from '../services/bridgeApi.js';

function formatExpiry(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat('pt-BR', { dateStyle: 'long', timeStyle: 'short' }).format(date);
}

export default function Administrator() {
  const { user } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [days, setDays] = useState('30');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [createdUser, setCreatedUser] = useState(null);

  if (!user?.isAdmin) return <Navigate to="/" replace />;

  async function handleSubmit(event) {
    event.preventDefault();
    setBusy(true);
    setError('');
    setCreatedUser(null);
    try {
      const result = await createAdminUser({
        email: email.trim(),
        password,
        days: Number(days),
      });
      setCreatedUser(result);
      setEmail('');
      setPassword('');
      setDays('30');
    } catch (requestError) {
      setError(requestError.message || 'Não foi possível criar a conta.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader
        title="Administrador"
        subtitle="Crie acessos ao aplicativo e defina por quantos dias cada conta permanecerá válida."
      />
      <form className="card max-w-xl space-y-4 p-5" onSubmit={handleSubmit}>
        <label className="block text-sm text-zinc-400">
          E-mail
          <input
            className="input mt-1"
            type="email"
            autoComplete="off"
            required
            maxLength={254}
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </label>
        <label className="block text-sm text-zinc-400">
          Senha temporária
          <input
            className="input mt-1"
            type="password"
            autoComplete="new-password"
            required
            minLength={6}
            maxLength={128}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </label>
        <label className="block text-sm text-zinc-400">
          Dias de validade
          <input
            className="input mt-1"
            type="number"
            min={1}
            max={3650}
            required
            value={days}
            onChange={(event) => setDays(event.target.value)}
          />
        </label>
        {error && <p className="text-sm text-loss" role="alert">{error}</p>}
        {createdUser && (
          <div className="rounded-lg border border-neon/30 bg-neon/5 p-3 text-sm text-neon" role="status">
            Acesso criado para {createdUser.email}. Válido até {formatExpiry(createdUser.expires_at)}.
          </div>
        )}
        <button className="btn-primary" type="submit" disabled={busy}>
          {busy ? <><KeyRound className="h-4 w-4 animate-pulse" /> Criando acesso…</> : <><UserPlus className="h-4 w-4" /> Criar usuário</>}
        </button>
      </form>
    </>
  );
}
