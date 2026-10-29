/**
 * FINANZ-CORE-01A (systemische Gesamtnacharbeit, D1/D7, Produktentscheidung) — was eine Abschlussrevision gegenüber
 * der Cloud ist. Eine Quelle für Abschluss, Ausgabe-Gate, Paket und Oberfläche.
 *
 * Positive Evidenz: „angenommen“ ist eine Revision nur, wenn der Server sie gegen seinen eigenen Finanzbestand geprüft
 * und angenommen hat (Antwort auf den Abschluss oder Abzug einer servervalidierten Zeile, Fassung 5, derselbe
 * Fingerabdruck). Ein Lese- oder Schreibfehler, eine fehlende Antwort oder ein alter Client erzeugen diesen Nachweis
 * nie. Im Betrieb ohne Cloud ist eine Revision sichtbar „lokal“ — zulässig, aber nie als serverbestätigt dargestellt.
 */
import { isSupabaseConfigured } from '../../lib/supabase';
import { isFinallyDeniedOutboxEntry } from '../sync/syncRoleDenial';
import { closureFingerprintVersion } from './accountingPeriodFingerprint';
import type { AccountingPeriodClosure, AccountingPeriodRevisionStatus } from '../../types/accountingPeriod';
import type { SyncOutboxEntry } from '../../types/sync';

export interface ClosureStatusContext {
  /** Arbeitet der Betrieb mit der Cloud? Ohne Cloud ist jede Revision lokal. */
  readonly cloudMode: boolean;
  readonly outbox: readonly SyncOutboxEntry[];
}

/** Betrieb mit Cloud: Abschlüsse brauchen die Annahme durch den Server. */
export function isClosureCloudMode(): boolean {
  return isSupabaseConfigured();
}

/** Aktiv ist eine Revision, die weder wieder geöffnet noch vom Server abgewiesen wurde. */
export function isActiveClosure(closure: Pick<AccountingPeriodClosure, 'reopenedAt' | 'cloudAbweisung'>): boolean {
  return !closure.reopenedAt && !closure.cloudAbweisung;
}

/** Der Server hat genau diese Revision geprüft und angenommen (Fassung 5 oder 6, derselbe Fingerabdruck). */
export function isClosureServerConfirmed(closure: AccountingPeriodClosure): boolean {
  return (
    closure.server?.validiert === true &&
    closure.server.fingerprint === closure.fingerprint &&
    (closureFingerprintVersion(closure) === 5 || closureFingerprintVersion(closure) === 6)
  );
}

export function resolveClosureRevisionStatus(
  closure: AccountingPeriodClosure,
  context: ClosureStatusContext,
): AccountingPeriodRevisionStatus {
  if (closure.cloudAbweisung) return 'abgewiesen';
  if (isClosureServerConfirmed(closure)) return 'angenommen';
  if (!context.cloudMode) return 'lokal';
  const auftraege = context.outbox.filter(
    (entry) => entry.entityType === 'accounting_period_closure' && entry.entityId === closure.id,
  );
  if (auftraege.some((entry) => entry.status === 'blocked')) return 'konflikt';
  // Rollen- oder Rechteabweisung: endgültig für diesen Auftrag (erneut senden erst nach bewusster Entscheidung).
  if (auftraege.some((entry) => isFinallyDeniedOutboxEntry(entry))) return 'abgewiesen';
  // Ältere Fassung oder eine Serverzeile ohne Prüfung: lesbar, nie serverzertifiziert.
  // P1-KORREKTUR A04-WEISS-R2 — ausstehend kann nur noch eine Revision der Fassung 6 sein; nur sie nimmt der Server an.
  if (closureFingerprintVersion(closure) !== 6 || (closure.sync?.version ?? 0) > 0) return 'historisch';
  return 'ausstehend';
}

export function buildClosureRevisionStatusMap(
  closures: readonly AccountingPeriodClosure[],
  context: ClosureStatusContext,
): Record<string, AccountingPeriodRevisionStatus> {
  const result: Record<string, AccountingPeriodRevisionStatus> = {};
  for (const closure of closures) result[closure.id] = resolveClosureRevisionStatus(closure, context);
  return result;
}
