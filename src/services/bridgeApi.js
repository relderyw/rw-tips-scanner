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

async function request(path, { params = {}, method = 'GET', body, timeoutMs = 40000, authenticate = true } = {}) {
  const url = new URL(BASE + path);
  Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const token = getIQSessionToken();
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
    if (response.status === 401 && token) {
      setIQSessionToken('');
    }
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
  } catch (err) {
    if (err.name === 'AbortError' || String(err?.message || '').toLowerCase().includes('abort')) {
      throw new Error('Tempo limite excedido ao consultar a IQ Option.');
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export async function connectIQAccount(email, password, account_type = 'PRACTICE') {
  const session = await request('/session', {
    method: 'POST',
    body: { email, password, account_type },
    timeoutMs: 70000,
    authenticate: false,
  });
  setIQSessionToken(session.token);
  return session;
}

export async function switchIQAccountType(account_type) {
  return request('/session/account-type', {
    method: 'POST',
    body: { account_type },
  });
}

export const fetchScannerSignals = (limit = 50) =>
  request('/scanner/signals', { params: { limit } });

export const fetchScannerConfig = () =>
  request('/scanner/config');

export const updateScannerConfig = (config) =>
  request('/scanner/config', { method: 'POST', body: config });

export const fetchBestStrategies = (top_n = 15) =>
  request('/scanner/best-strategies', { params: { top_n } });

export const fetchScannerBlacklist = () =>
  request('/scanner/blacklist');

export const addAssetToBlacklist = (asset) =>
  request('/scanner/blacklist', { method: 'POST', body: { asset, action: 'add' } });

export const removeAssetFromBlacklist = (asset) =>
  request('/scanner/blacklist', { method: 'POST', body: { asset, action: 'remove' } });

export const fetchDailyAssetStats = (accountType = 'both', date = null) =>
  request('/scanner/daily-stats', { params: { account_type: accountType, ...(date ? { date } : {}) } });

export const sendTelegramDailySummary = (accountType = 'both') =>
  request('/telegram/daily-summary', {
    method: 'POST',
    params: { account_type: accountType },
    body: { account_type: accountType },
    authenticate: false,
  });

export const fetchDashboardStats = ({ startDate, endDate, accountType = 'both' } = {}) =>
  request('/scanner/dashboard-stats', {
    params: {
      account_type: accountType,
      ...(startDate ? { start_date: startDate } : {}),
      ...(endDate ? { end_date: endDate } : {}),
    },
    authenticate: false,
  });

export async function fetchIQSession() {
  return request('/session', { authenticate: false });
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
export const fetchTopPayoutActives = (minPayout = 70, limit = 10, force = false) =>
  request('/actives/top', { params: { min_payout: minPayout, limit, force: Boolean(force) } });
export const fetchIQAccount = () => request('/account');
export const fetchIQPositions = (limit = 100) =>
  request('/positions', { params: { limit } });
export const sendTelegramSignal = (signal) =>
  request('/telegram/signal', { method: 'POST', body: signal, timeoutMs: 8000 });
export const updateTelegramSignalResult = (signal_id, outcome) =>
  request('/telegram/signal/result', { method: 'PUT', body: { signal_id, outcome }, timeoutMs: 12000 });
export const fetchTelegramStatus = () => request('/telegram/status');
export const fetchTelegramStats = () => request('/telegram/stats');
function adminErrorMessage(payload, fallback) {
  const rawDetail = payload?.detail;
  if (Array.isArray(rawDetail)) {
    return rawDetail.map((item) => item?.msg || JSON.stringify(item)).join('; ');
  }
  if (typeof rawDetail === 'string' && rawDetail.trim()) return rawDetail;
  if (rawDetail) return JSON.stringify(rawDetail);
  return fallback;
}

async function firebaseRequest(path, { method = 'GET', body, token } = {}) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(adminErrorMessage(payload, `HTTP ${response.status} em ${path}`));
  }
  return payload;
}

async function adminRequest(path, options = {}) {
  const token = await getFirebaseIdToken();
  return firebaseRequest(path, { ...options, token });
}

export const listAdminUsers = () => adminRequest('/admin/users');
export const createAdminUser = ({ email, password, days }) =>
  adminRequest('/admin/users', { method: 'POST', body: { email, password, days } });
export const updateAdminUser = (uid, { email, password }) =>
  adminRequest(`/admin/users/${encodeURIComponent(uid)}`, {
    method: 'PATCH',
    body: {
      ...(email ? { email } : {}),
      ...(password ? { password } : {}),
    },
  });
export const deleteAdminUser = (uid) =>
  adminRequest(`/admin/users/${encodeURIComponent(uid)}`, { method: 'DELETE' });
export const renewAdminUser = (uid, days) =>
  adminRequest(`/admin/users/${encodeURIComponent(uid)}/renew`, {
    method: 'POST',
    body: { days },
  });
export const registerAppSession = (idToken) =>
  firebaseRequest('/auth/session', { method: 'POST', token: idToken });
export const fetchBridgePayouts = () => request('/payouts');
export const fetchBridgeHealth = () => request('/app-health').catch(() => request('/health'));
