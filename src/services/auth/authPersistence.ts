import type { AuthPersistedState, AuthSession } from '../../types/auth';
import {
  getAuthLicensesSnapshot,
  getAuthUsersSnapshot,
  hydrateAuthStore,
  resetAuthStore,
  setCurrentSession,
} from './authStore';

export const AUTH_STORAGE_KEY = 'officepilot-auth';
export const SESSION_STORAGE_KEY = 'officepilot-session';
export const AUTH_STORAGE_VERSION = 1;

export function buildAuthPersistedSnapshot(): AuthPersistedState {
  return {
    version: AUTH_STORAGE_VERSION,
    users: getAuthUsersSnapshot(),
    licenses: getAuthLicensesSnapshot(),
    savedAt: new Date().toISOString(),
  };
}

export function saveAuthState(): void {
  try {
    localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(buildAuthPersistedSnapshot()));
  } catch (error) {
    console.warn('[OfficePilot] Auth-Zustand konnte nicht gespeichert werden.', error);
  }
}

export function loadAuthState(): AuthPersistedState | null {
  try {
    const raw = localStorage.getItem(AUTH_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as AuthPersistedState;
    if (!parsed || parsed.version !== AUTH_STORAGE_VERSION || !Array.isArray(parsed.users)) {
      return null;
    }
    return {
      version: AUTH_STORAGE_VERSION,
      users: parsed.users ?? [],
      licenses: parsed.licenses ?? [],
      savedAt: parsed.savedAt ?? new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

export function loadSessionFromStorage(): AuthSession | null {
  try {
    const raw = sessionStorage.getItem(SESSION_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as AuthSession;
    if (!parsed?.userId) return null;
    if (parsed.expiresAt && new Date(parsed.expiresAt).getTime() < Date.now()) {
      sessionStorage.removeItem(SESSION_STORAGE_KEY);
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function saveSessionToStorage(session: AuthSession | null): void {
  if (!session) {
    sessionStorage.removeItem(SESSION_STORAGE_KEY);
    return;
  }
  sessionStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
}

export function hydrateAuthFromStorage(): AuthSession | null {
  const state = loadAuthState();
  if (state) {
    hydrateAuthStore(state);
  } else {
    resetAuthStore();
  }
  const session = loadSessionFromStorage();
  setCurrentSession(session);
  return session;
}

export function clearAuthStorage(): void {
  localStorage.removeItem(AUTH_STORAGE_KEY);
  sessionStorage.removeItem(SESSION_STORAGE_KEY);
  resetAuthStore();
}
