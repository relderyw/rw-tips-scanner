import { getFirebaseIdToken } from './authService.js';

const BASE = (import.meta.env.VITE_BRIDGE_URL || 'http://localhost:8000').replace(/\/$/, '');
const SESSION_KEY = 'rwtips_iq_session';

export const bridgeEnabled = Boolean(BASE);
export const getIQSessionToken = () => {
  try {
    return sessionStorage.getItem(SESSION_KEY) || '';
  } catch {
    return '';
  }
};

function setIQSessionToken(token) {
  if (token) sessionStorage.setItem(SESSION_KEY, token);
  else sessionStorage.removeItem(SESSION_KEY);
}

async function request(path, { params = {}, method = 'GET', body, timeoutMs = 15000, authenticate = true } = {}) {
  const url = new URL(BASE + path);
  Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const token = authenticate ? getIQSessionToken() : '';
  if (authenticate && !token) throw new Error('Conecte sua conta IQ Option primeiro.');
  try {
    const response = await fetch(url, {
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const rawDetail = payload?.detail;
      const detail = Array.isArray(rawDetail)
        ? rawDetail.map((item) => item?.msg || JSON.stringify(item)).join('; ')
        : typeof rawDetail === 'string'
          ? rawDetail
          : rawDetail
            ? JSON.stringify(rawDetail)
            : `HTTP ${response.status} em ${path}`;
      throw new Error(detail);
    }
    return payload;
  } finally {
    clearTimeout(timer);
  }
}

export async function connectIQAccount(email, password) {
  const session = await request('/session', {
    method: 'POST',
    body: { email, password },
    timeoutMs: 70000,
    authenticate: false,
  });
  setIQSessionToken(session.token);
  return session;
}

export async function fetchIQSession() {
  return request('/session');
}

export async function disconnectIQAccount() {
  try {
    if (getIQSessionToken()) await request('/session', { method: 'DELETE' });
  } finally {
    setIQSessionToken('');
  }
}

export const fetchBridgeCandles = (asset, tf, hours) =>
  request('/candles', { params: { asset, tf, hours } });
export const fetchIQBinaryActives = () => request('/actives');
export const fetchIQAccount = () => request('/account');
export const fetchIQPositions = (limit = 100) =>
  request('/positions', { params: { limit } });
export const sendTelegramSignal = (signal) =>
  request('/telegram/signal', { method: 'POST', body: signal, timeoutMs: 20000 });
export const updateTelegramSignalResult = (signal_id, outcome) =>
  request('/telegram/signal/result', { method: 'PUT', body: { signal_id, outcome }, timeoutMs: 12000 });
export const fetchTelegramStatus = () => request('/telegram/status');
export const fetchTelegramStats = () => request('/telegram/stats');
export async function createAdminUser({ email, password, days }) {
  const token = await getFirebaseIdToken();
  const response = await fetch(`${BASE}/admin/users`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ email, password, days }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload?.detail || `HTTP ${response.status} ao criar usuário.`);
  }
  return payload;
}
export const fetchBridgePayouts = () => request('/payouts');
export const fetchBridgeHealth = () => request('/health');
