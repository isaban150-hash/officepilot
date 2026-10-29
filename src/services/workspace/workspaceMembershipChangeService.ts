/**
 * EINRICHTUNG-01 (AP4; Vertrag 1.7, M-10.3 bis M-10.5, M-11, M-13) — die Bindung an einen Betrieb ändert sich.
 *
 * Betriebswahl, Verlassen, angenommene Einladung und bestätigter Entzug laufen über denselben Weg: Die gemerkte Bindung
 * wird vergessen und die App neu geladen. Danach entscheidet `ensure_personal_workspace` (gewählter Betrieb zuerst) über
 * die Bindung; im Arbeitsspeicher bleibt nichts vom bisherigen Betrieb, späte Antworten der alten Seite gibt es nicht
 * mehr, und offene Aufträge bleiben an ihren Ursprungsbereich gebunden (DOKUMENTE-01 R1).
 *
 * Ein bestätigter Entzug wird je Konto gemerkt: Weder ein Offline-Start noch die Rückkehr aus dem Seiten-Cache zeigt
 * den entzogenen Betrieb wieder (M-10.3). Offline ist ein Entzug nicht erkennbar; es gibt keine behauptete Sofortwirkung
 * (M-10.4). Eine spätere neue Mitgliedschaft hebt die Markierung auf.
 */
import { forgetRememberedWorkspaceBinding, prepareWorkspaceCloudBootstrapRetry, requestWorkspaceRebind } from './workspaceCloudBootstrapService';

const REVOKED_KEY_PREFIX = 'officetakt-revoked-workspaces:';
const NOTICE_KEY = 'officetakt.notice.workspaceChange';

export type WorkspaceChangeNotice =
  | { kind: 'revoked'; workspaceName: string }
  | { kind: 'left'; workspaceName: string }
  | { kind: 'switched'; workspaceName: string }
  | { kind: 'accepted'; workspaceName: string }
  | { kind: 'owner'; workspaceName: string }
  /* N-M2.2 — der eigene Übergabeantrag wurde angenommen, bevor der Widerruf ankam. */
  | { kind: 'handedOver'; workspaceName: string };

/** Abhängigkeiten als Objekt, damit Tests das Neuladen ersetzen können. */
export const workspaceChangeDeps = {
  reloadTo(path: string): void {
    window.location.assign(path);
  },
};

function readRevoked(userId: string): string[] {
  try {
    const raw = localStorage.getItem(`${REVOKED_KEY_PREFIX}${userId}`);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string') : [];
  } catch {
    return [];
  }
}

function writeRevoked(userId: string, ids: string[]): void {
  try {
    if (ids.length === 0) localStorage.removeItem(`${REVOKED_KEY_PREFIX}${userId}`);
    else localStorage.setItem(`${REVOKED_KEY_PREFIX}${userId}`, JSON.stringify([...new Set(ids)].slice(-50)));
  } catch {
    // ohne Speicher gilt die Markierung bis zum Neuladen nicht; der Server bleibt maßgeblich
  }
}

export function markWorkspaceRevoked(userId: string, workspaceId: string): void {
  if (!userId || !workspaceId) return;
  writeRevoked(userId, [...readRevoked(userId), workspaceId]);
}

export function isWorkspaceRevoked(userId: string | null | undefined, workspaceId: string | null | undefined): boolean {
  if (!userId || !workspaceId) return false;
  return readRevoked(userId).includes(workspaceId);
}

export function clearWorkspaceRevoked(userId: string, workspaceId: string): void {
  if (!userId || !workspaceId) return;
  writeRevoked(userId, readRevoked(userId).filter((id) => id !== workspaceId));
}

function storeNotice(notice: WorkspaceChangeNotice | undefined): void {
  try {
    if (notice) sessionStorage.setItem(NOTICE_KEY, JSON.stringify(notice));
  } catch {
    // ein fehlender Hinweis ändert nichts an der Bindung
  }
}

/** Der Hinweis nach dem Neuladen — genau einmal. */
export function takeWorkspaceChangeNotice(): WorkspaceChangeNotice | null {
  try {
    const raw = sessionStorage.getItem(NOTICE_KEY);
    if (!raw) return null;
    sessionStorage.removeItem(NOTICE_KEY);
    const parsed = JSON.parse(raw) as Partial<WorkspaceChangeNotice> | null;
    if (!parsed || typeof parsed.workspaceName !== 'string') return null;
    if (!['revoked', 'left', 'switched', 'accepted', 'owner', 'handedOver'].includes(String(parsed.kind))) return null;
    return parsed as WorkspaceChangeNotice;
  } catch {
    return null;
  }
}

/** Neu binden: gemerkte Bindung vergessen, Hinweis merken, App neu laden. */
export function rebindWorkspace(input: { userId: string | null | undefined; notice?: WorkspaceChangeNotice; path?: string }): void {
  forgetRememberedWorkspaceBinding(input.userId ?? null);
  // Der nächste Start fragt den Server, statt die gespeicherte Provisionierung des bisherigen Betriebs zu nutzen.
  requestWorkspaceRebind(input.userId ?? null);
  prepareWorkspaceCloudBootstrapRetry();
  storeNotice(input.notice);
  workspaceChangeDeps.reloadTo(input.path ?? '/');
}

/** M-10.3 — bestätigter Entzug: markieren und neu binden. */
export function handleConfirmedWorkspaceRevocation(input: { userId: string; workspaceId: string; workspaceName: string }): void {
  markWorkspaceRevoked(input.userId, input.workspaceId);
  rebindWorkspace({ userId: input.userId, notice: { kind: 'revoked', workspaceName: input.workspaceName } });
}
