import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider } from './context/AuthContext.jsx';
import RequireAuth from './components/RequireAuth.jsx';
import Layout from './components/Layout.jsx';
import Login from './pages/Login.jsx';
import Dashboard from './pages/Dashboard.jsx';
import Scanner from './pages/Scanner.jsx';
import Strategies from './pages/Strategies.jsx';
import StrategyDetail from './pages/StrategyDetail.jsx';
import Assets from './pages/Assets.jsx';
import RadarLive from './pages/RadarLive.jsx';
import IQConnection from './pages/IQConnection.jsx';
import AccountEntries from './pages/AccountEntries.jsx';
import Administrator from './pages/Administrator.jsx';

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route element={<RequireAuth><Layout /></RequireAuth>}>
            <Route index element={<Dashboard />} />
            <Route path="scanner" element={<Scanner />} />
            <Route path="estrategias" element={<Strategies />} />
            <Route path="estrategias/:id" element={<StrategyDetail />} />
            <Route path="ativos" element={<Assets />} />
            <Route path="radar" element={<RadarLive />} />
            <Route path="conexao-iq" element={<IQConnection />} />
            <Route path="entradas" element={<AccountEntries />} />
            <Route path="administrador" element={<Administrator />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}
