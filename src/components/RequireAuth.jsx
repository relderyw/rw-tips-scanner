import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import { Loading } from './ui.jsx';

// Bloqueia todas as rotas internas até o usuário estar logado
export default function RequireAuth({ children }) {
  const { user, authReady } = useAuth();
  const location = useLocation();
  if (!authReady) return <Loading text="Verificando sessão…" />;
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  return children;
}
