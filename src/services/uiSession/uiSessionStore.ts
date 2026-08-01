/**
 * UiSessionStore — save/load/validate/delete for UiSessionSnapshot.
 * sessionStorage primary; TTL localStorage secondary for tab-kill.
 * Never mixed with domain AppPersistedState.
 */
import type { UiSessionSnapshot } from '../../types/uiSessionSnapshot';
import { UI_SESSION_SCHEMA_VERSION } from '../../types/uiSessionSnapshot';

export const UI_SESSION_STORAGE_KEY = 'officepilot-ui-session';
export const UI_SESSION_TTL_STORAGE_KEY = 'officepilot-ui-session-ttl';

function canUseSessionStorage(): boolean {
  try {
    return typeof sessionStorage !== 'undefined';
  } catch {
    return false;
  }
}

function canUseLocalStorage(): boolean {
  try {
    return typeof localStorage !== 'undefined';
  } catch {
    return false;
  }
}

function parseSnapshot(raw: string | null): UiSessionSnapshot | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as UiSessionSnapshot;
    if (!parsed || typeof parsed !== 'object') return null;
    if (typeof parsed.id !== 'string' || typeof parsed.scopeKey !== 'string') return null;
    if (typeof parsed.savedAt !== 'string' || !parsed.route?.pathname) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveUiSessionSnapshot(snapshot: UiSessionSnapshot): void {
  const serialized = JSON.stringify(snapshot);
  if (canUseSessionStorage()) {
    try {
      sessionStorage.setItem(UI_SESSION_STORAGE_KEY, serialized);
    } catch {
      // quota / private mode — ignore
    }
  }
  if (canUseLocalStorage()) {
    try {
      localStorage.setItem(UI_SESSION_TTL_STORAGE_KEY, serialized);
    } catch {
      // ignore
    }
  }
}

/**
 * Load: prefer sessionStorage; fall back to TTL localStorage (browser kill).
 */
export function loadUiSessionSnapshot(): UiSessionSnapshot | null {
  if (canUseSessionStorage()) {
    const fromSession = parseSnapshot(sessionStorage.getItem(UI_SESSION_STORAGE_KEY));
    if (fromSession) return fromSession;
  }
  if (canUseLocalStorage()) {
    return parseSnapshot(localStorage.getItem(UI_SESSION_TTL_STORAGE_KEY));
  }
  return null;
}

export function clearUiSessionSnapshot(): void {
  if (canUseSessionStorage()) {
    try {
      sessionStorage.removeItem(UI_SESSION_STORAGE_KEY);
    } catch {
      // ignore
    }
  }
  if (canUseLocalStorage()) {
    try {
      localStorage.removeItem(UI_SESSION_TTL_STORAGE_KEY);
    } catch {
      // ignore
    }
  }
}

export function resetUiSessionStoreForTests(): void {
  clearUiSessionSnapshot();
}

export function isSupportedUiSessionSchema(version: number): boolean {
  return version === UI_SESSION_SCHEMA_VERSION;
}
