import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseClient, isSupabaseConfigured } from '../../lib/supabase';
import type { WorkspaceRole } from '../../types/workspace';
import { getActiveStorageAccount, getActiveStorageKey } from '../storage/storageScopeService';
import { getWorkspaceStoreSnapshot } from './workspaceStore';
import { reportSessionInvalid } from '../auth/sessionInvalidationService';
import { isWorkspaceNoAccessMessage } from '../sync/syncRoleDenial';

/**
 * EINRICHTUNG-01 (AP1; Vertrag 1.1 Stufe 6, Vertrag 1.3, E3/E5) — die Betriebslizenz des aktiven Betriebs, wie der
 * Server sie meldet (`get_workspace_access`).
 *
 * Die Lizenz gehört dem Inhaber des Betriebs (E3); die eigene Lizenz einer Person spielt dafür keine Rolle. Ist sie
 * nicht wirksam, gilt im Betrieb Nur-Lesen (Vertrag 1.3): lesen, herunterladen, drucken, für Inhaber und Admins
 * sichern — aber nichts schreiben, senden oder einreichen. Der Server bleibt autoritativ; diese Auskunft steuert nur,
 * was die Oberfläche anbietet.
 *
 * - Quelle ist allein die Antwort des Servers. Nie das Profil im Cache, nie Claims, nie die eigene Lizenz. Eine
 *   Abweisung mit Lizenzcode löst sofort eine neue Abfrage aus (AppShell).
 * - Gespeichert je Konto und Betrieb: Die Kenntnis übersteht Neustart und Offline-Start (Verträge 1.7, 1.11) und
 *   gilt nie für ein anderes Konto.
 * - Unbekannt (noch nie bestätigt) heißt nicht Nur-Lesen: Der Server weist dann ab, und die Abweisung löst die
 *   Abfrage aus. Eine Verlängerung übernimmt die Oberfläche mit der nächsten Abfrage.
 * - Späte Antworten (Konto oder Bereich inzwischen gewechselt) werden verworfen.
 */
export type WorkspaceLicenseState = 'effective' | 'expired' | 'inactive';

export interface WorkspaceAccessRecord {
  workspaceId: string;
  userId: string;
  role: WorkspaceRole;
  licenseState: WorkspaceLicenseState;
  licenseEffective: boolean;
  /** Wann der Server den Stand zuletzt bestätigt hat. */
  confirmedAt: string;
  /**
   * EINRICHTUNG-01 (AP7; Vertrag 1.26) — für den Betrieb ist die Löschung beantragt: Nur-Lesen wie bei einer nicht
   * wirksamen Lizenz, bis zum Widerruf. Fehlt das Feld (älterer gespeicherter Stand), gilt es als nicht beantragt.
   */
  deletionPending?: boolean;
  /** Frühester Zeitpunkt der Ausführung (ISO), solange der Antrag offen ist. */
  deletionExecuteAfter?: string | null;
  /** `deleting`: die Ausführung hat begonnen; kein Widerruf mehr. */
  deletionInProgress?: boolean;
}

export type WorkspaceAccessRefreshResult =
  | { ok: true; record: WorkspaceAccessRecord }
  | { ok: false; reason: 'not_configured' | 'no_workspace' | 'auth' | 'no_access' | 'network' | 'invalid' | 'stale' };

export const WORKSPACE_ACCESS_KEY_PREFIX = 'officetakt-workspace-access:';

const ROLES: ReadonlySet<string> = new Set(['owner', 'admin', 'member']);
const LICENSE_STATES: ReadonlySet<string> = new Set(['effective', 'expired', 'inactive']);

const records = new Map<string, WorkspaceAccessRecord | null>();
const listeners = new Set<() => void>();
let version = 0;

function recordKey(workspaceId: string, userId: string): string {
  return `${WORKSPACE_ACCESS_KEY_PREFIX}${userId}:${workspaceId}`;
}

function notify(): void {
  version += 1;
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch {
      // Ein Zuhörer darf die anderen nicht aufhalten.
    }
  }
}

function parseRecord(raw: unknown, workspaceId: string, userId: string): WorkspaceAccessRecord | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  if (value.workspaceId !== workspaceId || value.userId !== userId) return null;
  if (typeof value.role !== 'string' || !ROLES.has(value.role)) return null;
  if (typeof value.licenseState !== 'string' || !LICENSE_STATES.has(value.licenseState)) return null;
  if (typeof value.licenseEffective !== 'boolean') return null;
  if ((value.licenseState === 'effective') !== value.licenseEffective) return null;
  if (typeof value.confirmedAt !== 'string') return null;
  if (value.deletionPending !== undefined && typeof value.deletionPending !== 'boolean') return null;
  if (value.deletionExecuteAfter !== undefined && value.deletionExecuteAfter !== null && typeof value.deletionExecuteAfter !== 'string') return null;
  if (value.deletionInProgress !== undefined && typeof value.deletionInProgress !== 'boolean') return null;
  return value as unknown as WorkspaceAccessRecord;
}

function readStored(workspaceId: string, userId: string): WorkspaceAccessRecord | null {
  try {
    const raw = localStorage.getItem(recordKey(workspaceId, userId));
    return raw ? parseRecord(JSON.parse(raw), workspaceId, userId) : null;
  } catch {
    return null;
  }
}

function store(record: WorkspaceAccessRecord, geaendert: boolean): void {
  records.set(recordKey(record.workspaceId, record.userId), record);
  try {
    localStorage.setItem(recordKey(record.workspaceId, record.userId), JSON.stringify(record));
  } catch {
    // Ohne Speicher gilt der Stand bis zum Neustart; die nächste Abfrage bestätigt ihn erneut.
  }
  if (geaendert) notify();
}

/** Der zuletzt bestätigte Stand für genau dieses Konto in genau diesem Betrieb, sonst `null`. */
export function getWorkspaceAccessRecord(workspaceId: string, userId: string): WorkspaceAccessRecord | null {
  if (!workspaceId || !userId) return null;
  const key = recordKey(workspaceId, userId);
  if (!records.has(key)) records.set(key, readStored(workspaceId, userId));
  return records.get(key) ?? null;
}

/** Nur-Lesen genau dann, wenn der Server bestätigt hat, dass die Betriebslizenz nicht wirksam ist. */
export function isWorkspaceLicenseReadOnly(workspaceId: string | null | undefined, userId: string | null | undefined): boolean {
  if (!workspaceId || !userId) return false;
  return getWorkspaceAccessRecord(workspaceId, userId)?.licenseEffective === false;
}

/** EINRICHTUNG-01 (AP7; 1.26) — Löschung beantragt, wie der Server sie zuletzt bestätigt hat. */
export function isWorkspaceDeletionPending(workspaceId: string | null | undefined, userId: string | null | undefined): boolean {
  if (!workspaceId || !userId) return false;
  return getWorkspaceAccessRecord(workspaceId, userId)?.deletionPending === true;
}

/** Der Stand des aktiven Kontos im aktiven Betrieb (für Hinweise und Hooks). */
export function getActiveWorkspaceAccessRecord(): WorkspaceAccessRecord | null {
  const workspaceId = getWorkspaceStoreSnapshot()?.id;
  const userId = getActiveStorageAccount()?.userId;
  if (!workspaceId || !userId) return null;
  return getWorkspaceAccessRecord(workspaceId, userId);
}

export function subscribeWorkspaceAccess(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Änderungszähler für `useSyncExternalStore`. */
export function getWorkspaceAccessVersion(): number {
  return version;
}

function classifyError(error: { message?: string; code?: string }): 'auth' | 'no_access' | 'network' | 'invalid' {
  const message = error.message ?? '';
  if (message.includes('session_not_active')) {
    // EINRICHTUNG-01 (AP2, B3) — vom Server bestätigt: Diese Sitzung besteht nicht mehr.
    reportSessionInvalid('session_not_active');
    return 'auth';
  }
  if (message.includes('Nicht angemeldet') || error.code === 'PGRST301') return 'auth';
  if (message.includes('Kein Zugriff') || error.code === '42501') return 'no_access';
  if (message.includes('Failed to fetch') || message.includes('Network')) return 'network';
  return 'invalid';
}

/** EINRICHTUNG-01 (AP4, M-10.3) — wer auf einen bestätigten Entzug reagiert (AppShell: isolieren und neu binden). */
type RevokedListener = (info: { workspaceId: string; userId: string }) => void;
const revokedListeners = new Set<RevokedListener>();

export function subscribeWorkspaceAccessRevoked(listener: RevokedListener): () => void {
  revokedListeners.add(listener);
  return () => {
    revokedListeners.delete(listener);
  };
}

function notifyRevoked(info: { workspaceId: string; userId: string }): void {
  for (const listener of [...revokedListeners]) {
    try {
      listener(info);
    } catch {
      // Ein Zuhörer darf die anderen nicht aufhalten.
    }
  }
}

let laufend: Promise<WorkspaceAccessRefreshResult> | null = null;
let laufendFuer: string | null = null;

/**
 * Fragt den Server nach Rolle und Lizenzstand des aktiven Kontos im aktiven Betrieb. Gleichzeitige Aufrufe für
 * denselben Bereich teilen sich eine Anfrage.
 */
export function refreshWorkspaceAccess(client?: SupabaseClient | null): Promise<WorkspaceAccessRefreshResult> {
  if (!isSupabaseConfigured()) return Promise.resolve({ ok: false, reason: 'not_configured' });
  const workspaceId = getWorkspaceStoreSnapshot()?.id;
  const userId = getActiveStorageAccount()?.userId;
  if (!workspaceId || !userId) return Promise.resolve({ ok: false, reason: 'no_workspace' });
  const bereich = getActiveStorageKey();
  const kennung = `${bereich}|${workspaceId}|${userId}`;
  if (laufend && laufendFuer === kennung) return laufend;

  const anfrage = (async (): Promise<WorkspaceAccessRefreshResult> => {
    const supabase = client ?? getSupabaseClient();
    if (!supabase) return { ok: false, reason: 'not_configured' };
    let antwort: { data: unknown; error: { message?: string; code?: string } | null };
    try {
      antwort = (await supabase.rpc('get_workspace_access', { p_workspace_id: workspaceId })) as typeof antwort;
    } catch {
      return { ok: false, reason: 'network' };
    }
    // Späte Antwort: inzwischen anderes Konto, anderer Bereich oder anderer Betrieb.
    if (
      getActiveStorageKey() !== bereich ||
      getActiveStorageAccount()?.userId !== userId ||
      getWorkspaceStoreSnapshot()?.id !== workspaceId
    ) {
      return { ok: false, reason: 'stale' };
    }
    if (antwort.error) {
      const reason = classifyError(antwort.error);
      /*
       * EINRICHTUNG-01 (AP4; Vertrag 1.7, M-10.3) — die Mitgliedschaft in genau diesem Betrieb besteht laut Server nicht
       * mehr (entfernt, verlassen, Rolle entzogen). Das ist ein bestätigter Entzug, kein Netzfehler.
       */
      if (reason === 'no_access' && isWorkspaceNoAccessMessage(antwort.error.message)) {
        notifyRevoked({ workspaceId, userId });
      }
      return { ok: false, reason };
    }
    const data = antwort.data as Record<string, unknown> | null;
    const role = data?.role;
    const licenseState = data?.license_state;
    const licenseEffective = data?.license_effective;
    if (
      !data ||
      data.workspace_id !== workspaceId ||
      typeof role !== 'string' ||
      !ROLES.has(role) ||
      typeof licenseState !== 'string' ||
      !LICENSE_STATES.has(licenseState) ||
      typeof licenseEffective !== 'boolean' ||
      (licenseState === 'effective') !== licenseEffective
    ) {
      return { ok: false, reason: 'invalid' };
    }
    // EINRICHTUNG-01 (AP7; Vertrag 1.26) — Löschantrag: open (Wartefrist) bzw. deleting (Ausführung begonnen).
    const deletion = (data.deletion ?? null) as Record<string, unknown> | null;
    const deletionState = deletion && typeof deletion.state === 'string' ? deletion.state : null;
    const record: WorkspaceAccessRecord = {
      workspaceId,
      userId,
      role: role as WorkspaceRole,
      licenseState: licenseState as WorkspaceLicenseState,
      licenseEffective,
      confirmedAt: new Date().toISOString(),
      deletionPending: deletionState === 'open' || deletionState === 'deleting',
      deletionExecuteAfter: deletionState && typeof deletion?.execute_after === 'string' ? deletion.execute_after : null,
      deletionInProgress: deletionState === 'deleting',
    };
    const vorher = getWorkspaceAccessRecord(workspaceId, userId);
    const geaendert =
      !vorher ||
      vorher.role !== record.role ||
      vorher.licenseState !== record.licenseState ||
      vorher.licenseEffective !== record.licenseEffective ||
      Boolean(vorher.deletionPending) !== Boolean(record.deletionPending) ||
      (vorher.deletionExecuteAfter ?? null) !== (record.deletionExecuteAfter ?? null) ||
      Boolean(vorher.deletionInProgress) !== Boolean(record.deletionInProgress);
    store(record, geaendert);
    return { ok: true, record };
  })();
  laufend = anfrage;
  laufendFuer = kennung;
  void anfrage.finally(() => {
    if (laufend === anfrage) {
      laufend = null;
      laufendFuer = null;
    }
  });
  return anfrage;
}

/** Mindestabstand automatischer Abfragen (Fokus, nach jedem Abgleich); ein bewusster Anlass fragt sofort. */
export const WORKSPACE_ACCESS_REFRESH_MIN_INTERVAL_MS = 20_000;
let letzteAbfrage = 0;

/**
 * Eine Abfrage anstoßen, ohne auf sie zu warten: beim Start, bei Fokus und Netzrückkehr, nach jedem automatischen
 * Abgleich und nach einer Abweisung mit Lizenzcode. So übernimmt die Oberfläche eine Verlängerung oder einen Ablauf
 * mit dem nächsten Abgleich, spätestens beim Neustart (Vertrag 1.7).
 */
export function requestWorkspaceAccessRefresh(options: { force?: boolean } = {}): void {
  const jetzt = Date.now();
  if (!options.force && jetzt - letzteAbfrage < WORKSPACE_ACCESS_REFRESH_MIN_INTERVAL_MS) return;
  letzteAbfrage = jetzt;
  void refreshWorkspaceAccess().catch(() => undefined);
}

export function resetWorkspaceAccessForTests(): void {
  records.clear();
  laufend = null;
  laufendFuer = null;
  letzteAbfrage = 0;
  notify();
}
