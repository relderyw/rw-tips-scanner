import { useEffect } from 'react';
import { NavLink, Outlet, Link } from 'react-router-dom';
import { LayoutDashboard, ScanSearch, BookOpen, CandlestickChart, Radio, LogOut, ShieldAlert, Link2, History, UserCog } from 'lucide-react';
import { useAuth } from '../context/AuthContext.jsx';
import { refreshPayouts, refreshHealth, refreshIQActives } from '../data/candleData.js';
import { startCatalogRefresh } from '../lib/strategyValidation.js';
import { disconnectIQAccount } from '../services/bridgeApi.js';
import { liveFeed } from '../services/liveFeed.js';
import { DataBadge } from './ui.jsx';

const NAV = [
  { to: '/radar', label: 'Radar Live', icon: Radio, badge: 'AO VIVO' },
  { to: '/', label: 'Dashboard', icon: LayoutDashboard, end: true },
  { to: '/scanner', label: 'Scanner', icon: ScanSearch },
  { to: '/estrategias', label: 'Estratégias', icon: BookOpen },
  { to: '/ativos', label: 'Ativos', icon: CandlestickChart },
  { to: '/conexao-iq', label: 'Conectar IQ', icon: Link2 },
  { to: '/entradas', label: 'Entradas', icon: History },
  { to: '/administrador', label: 'Administrador', icon: UserCog, adminOnly: true },
];

const linkClass = ({ isActive }) =>
  `flex items-center justify-between rounded-lg px-3 py-2 text-sm font-bold transition ${
    isActive ? 'bg-neon/10 text-neon shadow-glowSm' : 'text-zinc-400 hover:bg-panel2 hover:text-white'
  }`;

function Logo() {
  return (
    <Link to="/" className="flex items-center gap-2">
      <img src="/rw.png" alt="" className="h-9 w-9 rounded-lg object-cover shadow-glow" />
      <span className="text-lg font-bold leading-none text-white">RW TIPS<span className="block text-[11px] font-medium text-neon">Strategy Scanner</span></span>
    </Link>
  );
}

export default function Layout() {
  const { user, logout } = useAuth();
  const handleLogout = async () => {
    try {
      await disconnectIQAccount();
    } catch (error) {
      console.error('[Layout] falha ao encerrar sessão IQ antes do logout:', error);
    } finally {
      liveFeed.disconnect();
      await logout();
    }
  };

  // Payouts e status da ponte são atualizados ao abrir e a cada 60 s (só tem efeito se a ponte estiver configurada)
  useEffect(() => {
    refreshPayouts(); refreshHealth();
    refreshIQActives().catch((error) => console.error('[Layout] falha ao atualizar ativos IQ:', error));
    const t = setInterval(() => {
      refreshPayouts(); refreshHealth();
      refreshIQActives().catch((error) => console.error('[Layout] falha ao atualizar ativos IQ:', error));
    }, 60000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => startCatalogRefresh(), []);

  return (
    <div className="min-h-screen">
      {/* Sidebar (desktop) */}
      <aside className="fixed inset-y-0 left-0 hidden w-60 flex-col border-r border-line bg-panel p-4 lg:flex">
        <Logo />
        <nav className="mt-8 flex flex-col gap-1">
          {NAV.filter((item) => !item.adminOnly || user?.isAdmin).map(({ to, label, icon: Icon, end, badge }) => (
            <NavLink key={to} to={to} end={end} className={linkClass}>
              <span className="flex items-center gap-3">
                <Icon className="h-4 w-4 shrink-0" />
                <span>{label}</span>
              </span>
              {badge && (
                <span className="rounded bg-neon/20 px-1.5 py-0.5 text-[9px] font-extrabold uppercase tracking-wide text-neon animate-pulse">
                  {badge}
                </span>
              )}
            </NavLink>
          ))}
        </nav>
        <div className="mt-auto space-y-3">
          <DataBadge />
          <div className="truncate text-xs text-zinc-500">{user?.email}</div>
          <button onClick={handleLogout} className="btn-ghost w-full"><LogOut className="h-4 w-4" /> Sair</button>
        </div>
      </aside>

      {/* Topo + navegação horizontal (mobile) */}
      <header className="sticky top-0 z-30 border-b border-line bg-ink/95 backdrop-blur lg:hidden">
        <div className="flex items-center justify-between px-4 py-3">
          <Logo />
          <button onClick={handleLogout} aria-label="Sair" className="btn-ghost px-2"><LogOut className="h-4 w-4" /></button>
        </div>
        <nav className="flex gap-1 overflow-x-auto px-3 pb-2">
          {NAV.filter((item) => !item.adminOnly || user?.isAdmin).map(({ to, label, icon: Icon, end, badge }) => (
            <NavLink key={to} to={to} end={end} className={linkClass}>
              <span className="flex items-center gap-2 whitespace-nowrap">
                <Icon className="h-4 w-4 shrink-0" />
                <span>{label}</span>
              </span>
              {badge && (
                <span className="ml-1.5 rounded bg-neon/20 px-1 py-0.2 text-[8px] font-extrabold text-neon">
                  {badge}
                </span>
              )}
            </NavLink>
          ))}
        </nav>
      </header>

      <main className="px-4 pb-20 pt-6 lg:ml-60 lg:px-8 lg:pt-8">
        <div className="mx-auto max-w-7xl"><Outlet /></div>
      </main>

      {/* Aviso fixo */}
      <div className="fixed inset-x-0 bottom-0 z-40 flex items-center justify-center gap-2 border-t border-warn/30 bg-ink/95 px-3 py-2 text-center text-[11px] text-warn backdrop-blur lg:pl-64">
        <ShieldAlert className="h-4 w-4 shrink-0" />
        Resultados históricos não garantem resultados futuros. Opções binárias envolvem alto risco de perda total do capital.
      </div>
    </div>
  );
}
