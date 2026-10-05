import { getApp, getApps, initializeApp } from 'firebase/app';
import {
  getAuth,
  getIdTokenResult,
  onIdTokenChanged,
  signInWithEmailAndPassword,
  signOut,
} from 'firebase/auth';

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

const requiredConfig = [
  'apiKey',
  'authDomain',
  'projectId',
  'messagingSenderId',
  'appId',
];
const missingConfig = requiredConfig.filter((key) => !firebaseConfig[key]);
const firebaseAuth = missingConfig.length === 0
  ? getAuth(getApps().length ? getApp() : initializeApp(firebaseConfig))
  : null;
const adminEmail = (import.meta.env.VITE_FIREBASE_ADMIN_EMAIL || '').trim().toLowerCase();
const ACCESS_EXPIRED_MESSAGE = 'Este acesso não está ativo. Entre em contato com o administrador.';

function requireAuth() {
  if (!firebaseAuth) {
    throw new Error(`Configuração do Firebase ausente: ${missingConfig.join(', ')}. Confira o arquivo .env e reinicie o painel.`);
  }
  return firebaseAuth;
}

function toAppUser(user, claims = {}) {
  if (!user) return null;
  const isAdmin = Boolean(user.email && adminEmail && user.email.toLowerCase() === adminEmail);
  const expiresAt = Number(claims.access_expires_at) * 1000;
  return {
    uid: user.uid,
    email: user.email,
    provider: user.providerData[0]?.providerId || 'password',
    isAdmin,
    expiresAt: isAdmin || !Number.isFinite(expiresAt) ? null : expiresAt,
  };
}

function readableAuthError(error) {
  const messages = {
    'auth/invalid-credential': 'E-mail ou senha incorretos.',
    'auth/invalid-email': 'Informe um e-mail válido.',
    'auth/operation-not-allowed': 'O login por e-mail/senha não está habilitado no Firebase Authentication.',
    'auth/unauthorized-domain': 'Este domínio não está autorizado no Firebase Authentication.',
    'auth/network-request-failed': 'Falha de rede ao acessar o Firebase. Verifique sua conexão.',
    'auth/too-many-requests': 'Muitas tentativas de login. Aguarde e tente novamente.',
  };
  return new Error(messages[error.code] || 'Não foi possível autenticar com o Firebase. Confira as configurações e tente novamente.');
}

async function runAuth(operation) {
  try {
    return await operation(requireAuth());
  } catch (error) {
    if (error instanceof Error && !error.code) throw error;
    throw readableAuthError(error);
  }
}

async function validateSignedInUser(user) {
  const token = await getIdTokenResult(user);
  const appUser = toAppUser(user, token.claims);
  if (!appUser.isAdmin && (!appUser.expiresAt || appUser.expiresAt <= Date.now())) {
    await signOut(requireAuth());
    throw new Error(ACCESS_EXPIRED_MESSAGE);
  }
  return appUser;
}

export async function login(email, password) {
  const credential = await runAuth((auth) =>
    signInWithEmailAndPassword(auth, email.trim(), password));
  return validateSignedInUser(credential.user);
}

export async function logout() {
  await runAuth((auth) => signOut(auth));
}

export function onAuthChange(listener) {
  if (!firebaseAuth) {
    listener(null);
    return () => {};
  }
  let generation = 0;
  return onIdTokenChanged(
    firebaseAuth,
    async (user) => {
      const currentGeneration = ++generation;
      if (!user) {
        listener(null);
        return;
      }
      try {
        const appUser = await validateSignedInUser(user);
        if (currentGeneration === generation) listener(appUser);
      } catch (error) {
        if (currentGeneration === generation) {
          if (error.message !== ACCESS_EXPIRED_MESSAGE) {
            console.error('[auth] Firebase session validation failed:', error);
          }
          listener(null);
        }
      }
    },
    (error) => {
      console.error('[auth] Firebase session listener failed:', error);
      listener(null);
    },
  );
}

export async function getFirebaseIdToken() {
  const user = requireAuth().currentUser;
  if (!user) throw new Error('Faça login novamente para continuar.');
  await validateSignedInUser(user);
  return user.getIdToken();
}
