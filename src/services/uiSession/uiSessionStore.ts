/**
 * UiSessionStore — save/load/validate/delete for UiSessionSnapshot.
 * sessionStorage primary; TTL localStorage secondary for tab-kill.
 * Never mixed with domain AppPersistedState.
 */
import type { UiSessionSnapshot } from '../../types/uiSessionSnapshot';
import { UI_SESSION_SCHEMA_VERSION } from '../../types/uiSessionSnapshot';
import { buildUiSessionRouteKey } from './uiSessionRoute';

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

/**
 * GLOBAL-WORKSPACE-CONTINUITY-01B — mehrere Arbeitsplätze statt eines Platzes.
 *
 * Bis hierher hielt der Speicher genau **einen** Schnappschuss. Wer von Vorgang
 * A nach B ging und zurückkam, fand seinen Arbeitsstand überschrieben — das war
 * die systemische Ursache hinter „OfficePilot hat mich zurückgesetzt".
 *
 * Jetzt liegt unter denselben zwei Schlüsseln eine kleine, nach letzter Nutzung
 * geordnete Liste. Kein neuer Speichermechanismus, kein neuer Schlüssel, kein
 * zweites Resume-System — nur ein Wert mehr pro Eintrag.
 */
const UI_SESSION_MAP_VERSION = 1 as const;
/**
 * Acht Arbeitsplätze decken jeden realen Wechselrhythmus ab (Vorgang, dessen
 * Rechnung, ein zweiter Vorgang, Eingang, Liste) und halten den Speicher klein
 * — auf iOS ist Speicherdruck ein realer Faktor, siehe die Persistenzfehler
 * aus den Positionsblöcken.
 */
export const UI_SESSION_MAX_ENTRIES = 8;

type UiSessionEntry = { key: string; snapshot: UiSessionSnapshot };
type UiSessionMap = { version: typeof UI_SESSION_MAP_VERSION; entries: UiSessionEntry[] };

function isSnapshotShape(value: unknown): value is UiSessionSnapshot {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<UiSessionSnapshot>;
  if (typeof candidate.id !== 'string' || typeof candidate.scopeKey !== 'string') return false;
  if (typeof candidate.savedAt !== 'string' || !candidate.route?.pathname) return false;
  return true;
}

/**
 * Der Eintragsschlüssel trennt Ablage-Scope, Workspace, Arbeitsplatz und
 * Entität. Ein Schnappschuss kann damit niemals bei einem anderen Benutzer,
 * einem anderen Workspace oder einer anderen Entität auftauchen — die
 * inhaltliche Prüfung in `uiSessionValidation` bleibt davon unberührt.
 */
export function buildUiSessionEntryKey(snapshot: UiSessionSnapshot): string {
  const routeKey = buildUiSessionRouteKey(snapshot.route.pathname, snapshot.route.search);
  return [
    snapshot.scopeKey,
    snapshot.workspaceId ?? '',
    routeKey,
    `${snapshot.entityType}:${snapshot.entityId ?? ''}`,
  ].join('|');
}

/**
 * Liest die Liste. Ein alter Einzelschnappschuss wird dabei übernommen; alles
 * Unbekannte wird still verworfen, nie halb übernommen.
 */
function parseMap(raw: string | null): UiSessionMap | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;

  const candidate = parsed as Partial<UiSessionMap>;
  if (candidate.version === UI_SESSION_MAP_VERSION && Array.isArray(candidate.entries)) {
    const entries = candidate.entries.filter(
      (entry): entry is UiSessionEntry =>
        Boolean(entry) &&
        typeof (entry as UiSessionEntry).key === 'string' &&
        isSnapshotShape((entry as UiSessionEntry).snapshot),
    );
    return { version: UI_SESSION_MAP_VERSION, entries };
  }

  // Altformat: genau ein Schnappschuss ohne Umschlag.
  if (isSnapshotShape(parsed)) {
    const snapshot = parsed as UiSessionSnapshot;
    return {
      version: UI_SESSION_MAP_VERSION,
      entries: [{ key: buildUiSessionEntryKey(snapshot), snapshot }],
    };
  }
  return null;
}

function readMap(): UiSessionMap {
  if (canUseSessionStorage()) {
    const fromSession = parseMap(sessionStorage.getItem(UI_SESSION_STORAGE_KEY));
    if (fromSession && fromSession.entries.length > 0) return fromSession;
  }
  if (canUseLocalStorage()) {
    const fromLocal = parseMap(localStorage.getItem(UI_SESSION_TTL_STORAGE_KEY));
    if (fromLocal) return fromLocal;
  }
  return { version: UI_SESSION_MAP_VERSION, entries: [] };
}

function writeMap(map: UiSessionMap): void {
  const serialized = JSON.stringify(map);
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

/** Zuletzt geschriebener Eintrag steht vorn; überzählige fallen hinten heraus. */
export function saveUiSessionSnapshot(snapshot: UiSessionSnapshot): void {
  const key = buildUiSessionEntryKey(snapshot);
  const map = readMap();
  const rest = map.entries.filter((entry) => entry.key !== key);
  writeMap({
    version: UI_SESSION_MAP_VERSION,
    entries: [{ key, snapshot }, ...rest].slice(0, UI_SESSION_MAX_ENTRIES),
  });
}

/**
 * Der zuletzt benutzte Arbeitsplatz — die Grundlage für „Weiterarbeiten" auf
 * einer beliebigen Seite. Die Prüfung, ob er hierher passt, bleibt Sache von
 * `validateUiSessionSnapshot`.
 */
export function loadUiSessionSnapshot(): UiSessionSnapshot | null {
  return readMap().entries[0]?.snapshot ?? null;
}

/** Der Arbeitsstand genau dieses Arbeitsplatzes, unabhängig von der Reihenfolge. */
export function loadUiSessionSnapshotForRoute(
  pathname: string,
  search = '',
): UiSessionSnapshot | null {
  const routeKey = buildUiSessionRouteKey(pathname, search);
  const map = readMap();
  const hit = map.entries.find(
    (entry) =>
      buildUiSessionRouteKey(entry.snapshot.route.pathname, entry.snapshot.route.search) ===
      routeKey,
  );
  return hit?.snapshot ?? null;
}

/** Entfernt genau einen Arbeitsstand — etwa, wenn seine Entität verschwunden ist. */
export function removeUiSessionSnapshot(snapshot: UiSessionSnapshot): void {
  const key = buildUiSessionEntryKey(snapshot);
  const map = readMap();
  const entries = map.entries.filter((entry) => entry.key !== key);
  if (entries.length === map.entries.length) return;
  writeMap({ version: UI_SESSION_MAP_VERSION, entries });
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
