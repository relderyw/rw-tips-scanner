import { useState } from 'react';
import { Navigate, useNavigate, useLocation } from 'react-router-dom';
import { Send } from 'lucide-react';
import { useAuth } from '../context/AuthContext.jsx';
import { Loading } from '../components/ui.jsx';

export default function Login() {
  const { user, authReady, login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  if (!authReady) return <Loading text="Verificando sessão…" />;
  if (user) return <Navigate to={location.state?.from || '/'} replace />;

  async function run(fn) {
    setError(''); setBusy(true);
    try { await fn(); navigate(location.state?.from || '/', { replace: true }); }
    catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }

  return (
    <div className="grid min-h-screen place-items-center px-4">
      <div className="card-glow w-full max-w-sm p-6">
        <div className="mb-6 flex flex-col items-center gap-3 text-center">
          <img src="/rw.png" alt="RW TIPS" className="h-32 w-32 rounded-2xl object-cover shadow-glow" />
          <div>
            <div className="text-xl font-bold text-white glow-text">RW TIPS</div>
            <div className="text-xs text-zinc-500">Strategy Scanner</div>
          </div>
        </div>

        <div className="space-y-3">
          <input className="input" type="email" placeholder="E-mail" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          <input className="input" type="password" placeholder="Senha" autoComplete="current-password"
            value={password} onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && run(() => login(email, password))} />
          {error && <p className="text-sm text-loss" role="alert">{error}</p>}
          <button className="btn-primary w-full" disabled={busy}
            onClick={() => run(() => login(email, password))}>
            Entrar
          </button>
          <a
            className="btn-ghost w-full"
            href="https://t.me/assuncaoIII"
            target="_blank"
            rel="noreferrer"
          >
            <Send className="h-4 w-4" /> Falar com @assuncaoIII no Telegram
          </a>
        </div>
        <p className="mt-5 text-[11px] leading-relaxed text-zinc-600">
          Acesso criado pelo administrador. Entre em contato pelo Telegram para solicitar uma conta.
        </p>
      </div>
    </div>
  );
}
