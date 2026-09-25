/**
 * FINANZ-SYNC-BLOCKER-01B — was genau nicht übertragen wurde.
 *
 * Die Sync-Seite konnte bisher nur zählen: „3 Änderungen nicht übertragen".
 * Für den Betrieb ist das zu wenig — es sagt weder, welcher Beleg betroffen
 * ist, noch ob sich Warten lohnt oder ob jemand etwas tun muss.
 *
 * Hier entsteht die Beschreibung dafür, und zwar aus dem, was schon da ist:
 * dem Auftrag selbst und den vorhandenen Beständen. Kein neuer Zustand, keine
 * zweite Buchführung über Fehler.
 *
 * Zwei Regeln:
 *
 *   - **Kein Enum, kein Stacktrace.** Der rohe Servertext wird auf einen
 *     Grund in Nutzersprache abgebildet. Was sich nicht zuordnen lässt, bekommt
 *     den allgemeinen Grund — nicht den Rohtext.
 *   - **Fehler und Konflikt sind nicht dasselbe.** Ein Konflikt wartet auf eine
 *     Entscheidung, ein Fehler auf einen neuen Versuch. Wer beides gleich
 *     anzeigt, schickt den Nutzer auf den falschen Knopf.
 */
import type { SyncOutboxEntry } from '../../types/sync';
import type { TranslationKey } from '../../i18n';
import { getAccountingStoreSnapshot } from '../accounting/accountingStore';
import { getAccountingPeriodStoreSnapshot } from '../accounting/accountingPeriodStore';
import { getExpenseStoreSnapshot } from '../expenseStore';
import { getWorkspaceSettingsSnapshot } from '../workspace/workspaceStore';
import type { WorkspaceSettings } from '../../types/workspace';
import { isSupabaseSyncAllowed } from './cloudSyncAllowlist';

export type SyncFailureKind = 'error' | 'conflict' | 'waiting' | 'local_only';

export interface SyncOutboxDescription {
  readonly id: string;
  readonly entityType: SyncOutboxEntry['entityType'];
  readonly entityId: string;
  readonly kind: SyncFailureKind;
  /** Woran der Nutzer den Eintrag wiedererkennt; `null`, wenn nichts Besseres da ist. */
  readonly label: string | null;
  readonly reasonKey: TranslationKey;
  /** Ob ein erneuter Versuch überhaupt Aussicht auf Erfolg hat. */
  readonly retryable: boolean;
  readonly attempts: number;
}

/**
 * Den rohen Servertext auf einen Grund abbilden.
 *
 * Die Zuordnung geht nach dem, was der Server tatsächlich sagt. Trifft nichts
 * zu, bleibt es beim allgemeinen Grund — lieber unscharf als irreführend.
 */
export function mapSyncErrorReason(
  message: string | undefined,
  status: SyncOutboxEntry['status'],
  /**
   * FINANZ-SYNC-BLOCKER-01G — steht die Entscheidung wirklich schon bereit?
   *
   * „Bitte entscheiden" ohne Entscheidungsmöglichkeit war der halbfertige
   * Zustand aus der Abnahme. Ist der Konflikt noch nicht mit beiden Werten
   * aufgebaut, wird auch nicht zur Entscheidung aufgefordert.
   */
  decisionReady = true,
): TranslationKey {
  if (status === 'blocked') {
    return decisionReady
      ? 'sync.failure.reason.conflict'
      : 'sync.failure.reason.conflictPending';
  }
  if (!message) return 'sync.failure.reason.unknown';

  if (message.includes('Unbekannter Entity-Typ')) return 'sync.failure.reason.notDeployed';
  /*
   * FINANZ-SYNC-BLOCKER-01C — PostgREST meldet eine fehlende Funktion nicht mit
   * ihrem Fehlercode im Text, sondern mit "Could not find the function ... in
   * the schema cache". Genau diesen Satz sieht der Betrieb, solange die
   * Kontierungs-Migrationen remote noch nicht angewendet sind — er gehoert
   * uebersetzt und nicht roh angezeigt.
   */
  if (
    /PGRST205|PGRST202|does not exist|existiert nicht/i.test(message) ||
    /Could not find the (function|table)|schema cache/i.test(message)
  ) {
    return 'sync.failure.reason.notDeployed';
  }
  if (message.includes('nicht gefunden')) return 'sync.failure.reason.missingLocal';
  if (message.includes('Versionskonflikt')) return 'sync.failure.reason.conflict';
  if (message.includes('Nicht angemeldet')) return 'sync.failure.reason.auth';
  if (message.includes('Kein Zugriff')) return 'sync.failure.reason.permission';
  if (/Failed to fetch|Network|NetworkError/i.test(message)) return 'sync.failure.reason.network';
  if (message.includes('accounting_') || message.includes('closure_') || message.includes('period_')) {
    return 'sync.failure.reason.rejected';
  }
  if (message.includes('Sendenachweis')) return 'sync.failure.reason.notSent';
  return 'sync.failure.reason.unknown';
}

function shorten(value: string, max = 48): string {
  const trimmed = value.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

/**
 * Eine Bezeichnung, an der der Nutzer den Eintrag wiedererkennt.
 *
 * Bewusst nur für die Typen, bei denen eine sinnvolle Bezeichnung greifbar ist.
 * Für alles andere gibt es `null` — eine erfundene Bezeichnung wäre schlechter
 * als keine.
 */
export function describeSyncEntity(
  entityType: SyncOutboxEntry['entityType'],
  entityId: string,
): string | null {
  switch (entityType) {
    case 'accounting_assignment': {
      const zuordnung = getAccountingStoreSnapshot().find((item) => item.id === entityId);
      if (!zuordnung) return null;
      const beleg = getExpenseStoreSnapshot().find((item) => item.id === zuordnung.sourceId);
      const name = beleg?.invoiceNumber?.trim() || beleg?.title?.trim() || zuordnung.bookingText.trim();
      const konto = zuordnung.accountNumber.trim();
      if (name && konto) return shorten(`${name} · ${konto}`);
      return name ? shorten(name) : konto || null;
    }
    case 'accounting_period_closure': {
      const abschluss = getAccountingPeriodStoreSnapshot().find((item) => item.id === entityId);
      if (!abschluss) return null;
      return `${abschluss.monthKey} · Revision ${abschluss.revision}`;
    }
    case 'expense': {
      const beleg = getExpenseStoreSnapshot().find((item) => item.id === entityId);
      if (!beleg) return null;
      return shorten(beleg.invoiceNumber?.trim() || beleg.title?.trim() || beleg.supplierName?.trim() || '');
    }
    case 'workspace_settings': {
      const settings = getWorkspaceSettingsSnapshot();
      const offen = settings?.pendingKeys ?? [];
      return offen.length > 0 ? shorten(offen.join(', ')) : null;
    }
    default:
      return null;
  }
}

function kindFor(entry: SyncOutboxEntry): SyncFailureKind {
  if (!isSupabaseSyncAllowed(entry.entityType)) return 'local_only';
  if (entry.status === 'blocked') return 'conflict';
  if (entry.status === 'error' || entry.status === 'failed') return 'error';
  return 'waiting';
}

/**
 * Liegt zu diesem Auftrag eine ausführbare Entscheidung vor?
 *
 * Nur die Einstellungen kennen einen Feldkonflikt mit beiden Werten. Für alles
 * andere bleibt es beim bisherigen Konflikttext.
 */
function decisionReadyFor(entry: SyncOutboxEntry, settings: WorkspaceSettings | null): boolean {
  if (entry.entityType !== 'workspace_settings') return true;
  return (settings?.conflict?.fields.length ?? 0) > 0;
}

export function describeSyncOutboxEntry(entry: SyncOutboxEntry): SyncOutboxDescription {
  const kind = kindFor(entry);
  const label = describeSyncEntity(entry.entityType, entry.entityId);
  const decisionReady = decisionReadyFor(entry, getWorkspaceSettingsSnapshot());
  /*
   * Ein Konflikt ist nicht „wiederholbar" — er wartet auf eine Entscheidung.
   * Ein nur lokaler Eintrag ebenfalls nicht; er verlässt das Gerät nie.
   */
  const retryable =
    kind === 'error' ? (entry.lastErrorRetryable ?? true) : kind === 'waiting' ? true : false;

  return {
    id: entry.id,
    entityType: entry.entityType,
    entityId: entry.entityId,
    kind,
    label,
    reasonKey:
      kind === 'local_only'
        ? 'sync.outboxReason.localOnly'
        : kind === 'waiting'
          ? 'sync.failure.reason.waiting'
          : mapSyncErrorReason(entry.lastErrorMessage, entry.status, decisionReady),
    retryable,
    attempts: entry.retryCount,
  };
}
