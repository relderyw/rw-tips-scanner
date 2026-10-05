// Cliente WebSocket singleton para a ponte /ws.
// Responsabilidades:
//   • Autenticação via primeira mensagem {type:"auth", token}.
//   • Reconexão automática com backoff exponencial (1s → 2s → 4s → 8s → 16s → 30s, capped).
//   • subscribe(handler) → retorna unsubscribe().
//   • getStatus() → { status, lastMessageAt, reconnectAttempts }.
//
// Só abre conexão quando existe uma sessão IQ Option ativa no browser.
// Se a configuração estiver faltando, status fica 'disabled'.
const BASE = (import.meta.env.VITE_BRIDGE_URL || 'http://localhost:8000').replace(/\/$/, '');
import { getIQSessionToken } from './bridgeApi.js';

const WS_ENABLED = Boolean(BASE);

// Se WS não estiver configurado, exportamos um cliente "vazio" que funciona
// como no-op (painel cai em polling REST / fallback simulado como antes).
class NoopLiveFeed {
  status = 'disabled';
  lastMessageAt = 0;
  reconnectAttempts = 0;
  connect() {}
  disconnect() {}
  subscribe() { return () => {}; }
  getStatus() {
    return { status: this.status, lastMessageAt: this.lastMessageAt, reconnectAttempts: 0 };
  }
}

class LiveFeedClient {
  constructor() {
    this.status = 'closed'; // connecting | authenticating | open | closed | disabled
    this.lastMessageAt = 0;
    this.reconnectAttempts = 0;
    this._handlers = new Set();
    this._statusListeners = new Set();
    this._ws = null;
    this._reconnectTimer = null;
    this._authTimer = null;
    this._shouldReconnect = true; // false após disconnect() explícito.
    this._backoffMs = 1000;
  }

  // ---- API pública ----
  connect() {
    if (!WS_ENABLED) { this.status = 'disabled'; return; }
    if (!getIQSessionToken()) { this._setStatus('disabled'); return; }
    if (this._ws && (this.status === 'connecting' || this.status === 'authenticating' || this.status === 'open')) {
      // Já conectado ou em andamento; não faz nada.
      return;
    }
    this._shouldReconnect = true;
    this._open();
  }

  disconnect() {
    this._shouldReconnect = false;
    this._clearReconnectTimer();
    this._clearAuthTimer();
    if (this._ws) {
      try { this._ws.close(1000, 'client disconnect'); } catch (_) {}
      this._ws = null;
    }
    this._setStatus('closed');
  }

  subscribe(handler) {
    if (typeof handler !== 'function') return () => {};
    this._handlers.add(handler);
    return () => this._handlers.delete(handler);
  }

  onStatusChange(listener) {
    if (typeof listener !== 'function') return () => {};
    this._statusListeners.add(listener);
    return () => this._statusListeners.delete(listener);
  }

  getStatus() {
    return {
      status: this.status,
      lastMessageAt: this.lastMessageAt,
      reconnectAttempts: this.reconnectAttempts,
    };
  }

  // ---- Internos ----
  _setStatus(s) {
    this.status = s;
    try {
      this._statusListeners.forEach((fn) => {
        try { fn(this.getStatus()); } catch (e) { console.warn('[liveFeed] status listener error', e); }
      });
    } catch (_) {}
  }

  _emit(msg) {
    this.lastMessageAt = Date.now();
    this._handlers.forEach((fn) => {
      try { fn(msg); } catch (e) { console.warn('[liveFeed] handler error', e); }
    });
  }

  _clearReconnectTimer() {
    if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
  }

  _clearAuthTimer() {
    if (this._authTimer) { clearTimeout(this._authTimer); this._authTimer = null; }
  }

  _wsUrl() {
    // Converte http:// → ws://, https:// → wss://
    const base = BASE;
    if (base.startsWith('http://')) return 'ws://' + base.slice(7) + '/ws';
    if (base.startsWith('https://')) return 'wss://' + base.slice(8) + '/ws';
    if (base.startsWith('ws://') || base.startsWith('wss://')) return base.replace(/\/$/, '') + '/ws';
    // Default: assume http local.
    return 'ws://' + base + '/ws';
  }

  _open() {
    this._setStatus('connecting');
    let ws;
    try { ws = new WebSocket(this._wsUrl()); } catch (e) {
      console.warn('[liveFeed] construtor WebSocket falhou:', e);
      this._scheduleReconnect();
      return;
    }
    this._ws = ws;

    // Timeout de auth (5 s) — se, depois de open, não recebermos o handshake de auth
    // do servidor (esperamos resposta por recebimento de health ou não), marcamos
    // falha e reconectamos. Na prática, o servidor fecha 4401 se não mandarmos
    // auth em 5 s; mas garantimos do lado cliente também.
    ws.onopen = () => {
      this._setStatus('authenticating');
      // Primeira mensagem: auth.
      try {
        ws.send(JSON.stringify({ type: 'auth', token: getIQSessionToken() }));
      } catch (e) {
        console.warn('[liveFeed] send auth falhou:', e);
        try { ws.close(); } catch (_) {}
        return;
      }
      // Se em 7s ainda não estivermos 'open' (nenhuma msg recebida), fecha e reconecta.
      this._clearAuthTimer();
      this._authTimer = setTimeout(() => {
        if (this.status === 'authenticating') {
          console.warn('[liveFeed] timeout autenticação (não recebemos nenhuma msg do servidor). Reconectando…');
          try { ws.close(); } catch (_) {}
        }
      }, 7000);
    };

    ws.onmessage = (ev) => {
      let msg = null;
      try {
        msg = (typeof ev.data === 'string') ? JSON.parse(ev.data) : null;
      } catch (e) {
        console.warn('[liveFeed] msg WS não é JSON:', ev.data);
      }
      if (!msg || typeof msg !== 'object') return;
      // Qualquer mensagem válida depois de authenticating → autenticou OK.
      if (this.status === 'authenticating') {
        this._clearAuthTimer();
        this._setStatus('open');
        this.reconnectAttempts = 0;
        this._backoffMs = 1000; // reset backoff ao conectar com sucesso.
      }
      if (msg.type === 'health' || msg.type === 'candle') {
        this._emit(msg);
      } else {
        // Mensagens de outros tipos são repassadas, mas por enquanto não usadas.
        this._emit(msg);
      }
    };

    ws.onerror = (ev) => {
      console.warn('[liveFeed] WS error. (Detalhes escondidos pelo browser.) Tentativa atual:', this.reconnectAttempts);
      this._clearAuthTimer();
      this._setStatus('closed');
      // onerror é sempre seguido por onclose (via spec); agendamos reconnect ali.
    };

    ws.onclose = (ev) => {
      this._clearAuthTimer();
      const prevStatus = this.status;
      this._setStatus('closed');
      const code = ev && ev.code;
      const reason = ev && ev.reason;
      // Token rejeitado: não reconectamos com a mesma sessão inválida.
      if (code === 4401) {
        console.warn('[liveFeed] Servidor rejeitou a sessão IQ (code=4401). Reconecte sua conta IQ Option. Desligando reconexão automática.');
        this._shouldReconnect = false;
        return;
      }
      if (code === 4000) {
        console.warn('[liveFeed] Servidor desconectou por client slow (code=4000). Reconectaremos…');
      }
      if (this._shouldReconnect) this._scheduleReconnect();
    };
  }

  _scheduleReconnect() {
    this._clearReconnectTimer();
    this.reconnectAttempts += 1;
    // Backoff capped 30 s, com jitter ±15% para não sincronizar vários clients na mesma hora.
    const jitter = 0.85 + Math.random() * 0.3;
    const delay = Math.min(30000, this._backoffMs) * jitter;
    console.info(`[liveFeed] Reconectando em ${(delay/1000).toFixed(1)}s… (tentativa ${this.reconnectAttempts})`);
    this._setStatus('connecting'); // feedback visual de espera.
    this._reconnectTimer = setTimeout(() => {
      this._backoffMs = Math.min(30000, this._backoffMs * 2);
      this._open();
    }, delay);
  }
}

// Singleton (única conexão por aba).
const instance = WS_ENABLED ? new LiveFeedClient() : new NoopLiveFeed();

// Conecta automaticamente ao importar o módulo. O app não precisa de bootstrap
// explícito; se houver URL e token de sessão, conectamos logo.
if (WS_ENABLED && getIQSessionToken()) {
  try { instance.connect(); } catch (e) { console.warn('[liveFeed] connect inicial falhou:', e); }
}

export default instance;
export const liveFeed = instance;
export const liveWsEnabled = WS_ENABLED;
