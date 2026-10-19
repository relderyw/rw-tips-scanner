import { useCallback, useEffect, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { KeyRound, Pencil, RefreshCw, Trash2, UserPlus, X } from 'lucide-react';
import { useAuth } from '../context/AuthContext.jsx';
import { Badge, PageHeader } from '../components/ui.jsx';
import {
  createAdminUser,
  deleteAdminUser,
  listAdminUsers,
  renewAdminUser,
  updateAdminUser,
} from '../services/bridgeApi.js';

function formatExpiry(value) {
  if (!value) return 'Sem validade';
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' }).format(date);
}

function expiryTone(value) {
  if (!value) return 'gray';
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) return 'gray';
  if (time <= Date.now()) return 'loss';
  if (time - Date.now() <= 3 * 86400000) return 'warn';
  return 'neon';
}

const emptyForm = { email: '', password: '', days: '30' };

export default function Administrator() {
  const { user } = useAuth();
  const [form, setForm] = useState(emptyForm);
  const [users, setUsers] = useState([]);
  const [busy, setBusy] = useState(false);
  const [loadingList, setLoadingList] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [editing, setEditing] = useState(null);
  const [renewing, setRenewing] = useState(null);
  const [editForm, setEditForm] = useState({ email: '', password: '' });
  const [renewDays, setRenewDays] = useState('30');

  const loadUsers = useCallback(async () => {
    setLoadingList(true);
    try {
      const result = await listAdminUsers();
      setUsers(result.users || []);
      setError('');
    } catch (requestError) {
      setError(requestError.message || 'Não foi possível listar os usuários.');
    } finally {
      setLoadingList(false);
    }
  }, []);

  useEffect(() => {
    if (user?.isAdmin) loadUsers();
  }, [user, loadUsers]);

  if (!user?.isAdmin) return <Navigate to="/" replace />;

  function updateField(setter, field) {
    return (event) => setter((current) => ({ ...current, [field]: event.target.value }));
  }

  async function handleCreate(event) {
    event.preventDefault();
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await createAdminUser({
        email: form.email.trim(),
        password: form.password,
        days: Number(form.days),
      });
      setNotice(`Acesso criado para ${result.email}. Válido até ${formatExpiry(result.expires_at)}.`);
      setForm(emptyForm);
      await loadUsers();
    } catch (requestError) {
      setError(requestError.message || 'Não foi possível criar a conta.');
    } finally {
      setBusy(false);
    }
  }

  async function handleEdit(event) {
    event.preventDefault();
    if (!editing) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await updateAdminUser(editing.uid, {
        email: editForm.email.trim(),
        password: editForm.password.trim(),
      });
      setNotice(`Usuário ${result.email} atualizado.`);
      setEditing(null);
      await loadUsers();
    } catch (requestError) {
      setError(requestError.message || 'Não foi possível editar o usuário.');
    } finally {
      setBusy(false);
    }
  }

  async function handleRenew(event) {
    event.preventDefault();
    if (!renewing) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await renewAdminUser(renewing.uid, Number(renewDays));
      setNotice(`Validade de ${result.email} renovada até ${formatExpiry(result.expires_at)}.`);
      setRenewing(null);
      await loadUsers();
    } catch (requestError) {
      setError(requestError.message || 'Não foi possível renovar a validade.');
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete(target) {
    if (target.is_admin) return;
    const confirmed = window.confirm(`Excluir o usuário ${target.email}? Esta ação não pode ser desfeita.`);
    if (!confirmed) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await deleteAdminUser(target.uid);
      setNotice(`Usuário ${target.email} excluído.`);
      if (editing?.uid === target.uid) setEditing(null);
      if (renewing?.uid === target.uid) setRenewing(null);
      await loadUsers();
    } catch (requestError) {
      setError(requestError.message || 'Não foi possível excluir o usuário.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader
        title="Administrador"
        subtitle="Crie, edite e renove acessos. Cada conta só permanece logada em um dispositivo por vez."
      />

      <form className="card max-w-xl space-y-4 p-5" onSubmit={handleCreate}>
        <h2 className="text-sm font-bold text-white">Novo usuário</h2>
        <label className="block text-sm text-zinc-400">
          E-mail
          <input
            className="input mt-1"
            type="email"
            autoComplete="off"
            required
            maxLength={254}
            value={form.email}
            onChange={updateField(setForm, 'email')}
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
            value={form.password}
            onChange={updateField(setForm, 'password')}
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
            value={form.days}
            onChange={updateField(setForm, 'days')}
          />
        </label>
        {error && <p className="text-sm text-loss" role="alert">{error}</p>}
        {notice && (
          <div className="rounded-lg border border-neon/30 bg-neon/5 p-3 text-sm text-neon" role="status">
            {notice}
          </div>
        )}
        <button className="btn-primary" type="submit" disabled={busy}>
          {busy ? <><KeyRound className="h-4 w-4 animate-pulse" /> Salvando…</> : <><UserPlus className="h-4 w-4" /> Criar usuário</>}
        </button>
      </form>

      {editing && (
        <form className="card mt-4 max-w-xl space-y-4 p-5" onSubmit={handleEdit}>
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-bold text-white">Editar {editing.email}</h2>
            <button className="btn-ghost px-2 py-1" type="button" onClick={() => setEditing(null)} aria-label="Fechar edição">
              <X className="h-4 w-4" />
            </button>
          </div>
          <label className="block text-sm text-zinc-400">
            E-mail
            <input
              className="input mt-1"
              type="email"
              required
              maxLength={254}
              value={editForm.email}
              onChange={updateField(setEditForm, 'email')}
            />
          </label>
          <label className="block text-sm text-zinc-400">
            Nova senha (opcional)
            <input
              className="input mt-1"
              type="password"
              autoComplete="new-password"
              minLength={6}
              maxLength={128}
              value={editForm.password}
              onChange={updateField(setEditForm, 'password')}
            />
          </label>
          <button className="btn-primary" type="submit" disabled={busy}>
            <Pencil className="h-4 w-4" /> Salvar alterações
          </button>
        </form>
      )}

      {renewing && (
        <form className="card mt-4 max-w-xl space-y-4 p-5" onSubmit={handleRenew}>
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-bold text-white">Renovar {renewing.email}</h2>
            <button className="btn-ghost px-2 py-1" type="button" onClick={() => setRenewing(null)} aria-label="Fechar renovação">
              <X className="h-4 w-4" />
            </button>
          </div>
          <p className="text-sm text-zinc-500">A nova validade começa agora e vale pelos dias informados.</p>
          <label className="block text-sm text-zinc-400">
            Dias
            <input
              className="input mt-1"
              type="number"
              min={1}
              max={3650}
              required
              value={renewDays}
              onChange={(event) => setRenewDays(event.target.value)}
            />
          </label>
          <button className="btn-primary" type="submit" disabled={busy}>
            <RefreshCw className="h-4 w-4" /> Renovar validade
          </button>
        </form>
      )}

      <div className="card mt-6 overflow-x-auto">
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <h2 className="text-sm font-bold text-white">Usuários</h2>
          <button className="btn-ghost" type="button" onClick={loadUsers} disabled={loadingList || busy}>
            <RefreshCw className={`h-4 w-4 ${loadingList ? 'animate-spin' : ''}`} /> Atualizar
          </button>
        </div>
        <table className="min-w-full">
          <thead>
            <tr>
              <th className="th">E-mail</th>
              <th className="th">Validade</th>
              <th className="th">Ações</th>
            </tr>
          </thead>
          <tbody>
            {users.map((item) => (
              <tr key={item.uid} className="border-t border-line">
                <td className="td text-zinc-200">
                  <div className="flex items-center gap-2">
                    {item.email}
                    {item.is_admin && <Badge tone="neon">Admin</Badge>}
                  </div>
                </td>
                <td className="td">
                  {item.is_admin ? (
                    <Badge tone="gray">Ilimitado</Badge>
                  ) : (
                    <Badge tone={expiryTone(item.expires_at)}>{formatExpiry(item.expires_at)}</Badge>
                  )}
                </td>
                <td className="td">
                  {item.is_admin ? (
                    <span className="text-xs text-zinc-600">Conta protegida</span>
                  ) : (
                    <div className="flex flex-wrap gap-2">
                      <button
                        className="btn-ghost px-2 py-1"
                        type="button"
                        disabled={busy}
                        onClick={() => {
                          setRenewing(null);
                          setEditing(item);
                          setEditForm({ email: item.email || '', password: '' });
                        }}
                      >
                        <Pencil className="h-3.5 w-3.5" /> Editar
                      </button>
                      <button
                        className="btn-ghost px-2 py-1"
                        type="button"
                        disabled={busy}
                        onClick={() => {
                          setEditing(null);
                          setRenewing(item);
                          setRenewDays('30');
                        }}
                      >
                        <RefreshCw className="h-3.5 w-3.5" /> Renovar
                      </button>
                      <button
                        className="btn-ghost px-2 py-1 text-loss hover:border-loss/50 hover:text-loss"
                        type="button"
                        disabled={busy}
                        onClick={() => handleDelete(item)}
                      >
                        <Trash2 className="h-3.5 w-3.5" /> Excluir
                      </button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
            {!loadingList && users.length === 0 && (
              <tr>
                <td className="td text-zinc-500" colSpan={3}>Nenhum usuário encontrado.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
