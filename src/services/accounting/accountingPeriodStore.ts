/**
 * STEUERBERATER-06B — der lokale Bestand der Abschlussrevisionen.
 *
 * Aufbau wie die übrigen Speicher. Eine Besonderheit: Hier wird **angehängt**,
 * nicht ersetzt. Eine vorhandene Revision zu überschreiben wäre kein
 * Schreibfehler, sondern eine Fälschung des Nachweises — deshalb gibt es dafür
 * gar keine Funktion.
 */
import type { AccountingPeriodClosure } from '../../types/accountingPeriod';
import { isActiveClosure } from './accountingPeriodRevisionStatus';

let closures: AccountingPeriodClosure[] = [];

function clone(value: AccountingPeriodClosure): AccountingPeriodClosure {
  return {
    ...value,
    manifest: {
      ...value.manifest,
      entries: value.manifest.entries.map((entry) => ({ ...entry })),
      ...(value.manifest.payments ? { payments: value.manifest.payments.map((payment) => ({ ...payment })) } : {}),
      ...(value.manifest.employeePayments
        ? { employeePayments: value.manifest.employeePayments.map((payment) => ({ ...payment })) }
        : {}),
      ...(value.manifest.offenePosten ? { offenePosten: value.manifest.offenePosten.map((posten) => ({ ...posten })) } : {}),
    },
    sync: value.sync ? { ...value.sync } : undefined,
  };
}

export function getAccountingPeriodStoreSnapshot(): AccountingPeriodClosure[] {
  return closures.map(clone);
}

export function hydrateAccountingPeriodStore(items: AccountingPeriodClosure[]): void {
  closures = items.map(clone);
}

export function resetAccountingPeriodStore(): void {
  closures = [];
}

export function getAllAccountingPeriodClosures(): AccountingPeriodClosure[] {
  return closures.map(clone);
}

/** Alle Revisionen eines Monats, neueste zuerst. */
export function getClosuresForMonth(monthKey: string): AccountingPeriodClosure[] {
  return closures
    .filter((item) => item.monthKey === monthKey)
    .sort((a, b) => b.revision - a.revision)
    .map(clone);
}

/**
 * Die noch nicht wieder geöffnete Revision, falls es eine gibt. Systemische Gesamtnacharbeit (D7): Eine vom Server
 * endgültig abgewiesene Revision ist nicht aktiv — sie bleibt in der Historie, der Monat ist wieder abschließbar.
 */
export function getActiveClosureForMonth(monthKey: string): AccountingPeriodClosure | undefined {
  const found = closures.find((item) => item.monthKey === monthKey && isActiveClosure(item));
  return found ? clone(found) : undefined;
}

export function appendAccountingPeriodClosure(
  next: AccountingPeriodClosure,
): AccountingPeriodClosure {
  closures = [...closures, clone(next)];
  return clone(next);
}

/**
 * Setzt die Öffnungsspur auf eine Revision.
 *
 * Bewusst die **einzige** Änderung, die eine bestehende Revision erfährt:
 * Fingerprint, Manifest, Abschlusszeitpunkt und Revisionsnummer bleiben
 * unberührt. Wiederöffnen heisst „ab hier gilt sie nicht mehr", nicht „sie war
 * anders".
 */
export function markClosureReopened(
  id: string,
  reopenedAt: string,
  reopenedBy: string | undefined,
  reopenReason: string | undefined,
): AccountingPeriodClosure | null {
  const index = closures.findIndex((item) => item.id === id);
  if (index < 0) return null;
  const updated: AccountingPeriodClosure = {
    ...closures[index],
    reopenedAt,
    reopenedBy,
    reopenReason,
    updatedAt: reopenedAt,
  };
  closures = [...closures.slice(0, index), updated, ...closures.slice(index + 1)];
  return clone(updated);
}

/**
 * Systemische Gesamtnacharbeit (D5) — eine Änderung zurücknehmen, die nie gespeichert wurde.
 *
 * Abschluss und Wiederöffnung speichern sofort. Scheitert das Speichern, nimmt die Persistenz zwar den Sendeauftrag
 * zurück, der Speicher hier hätte die Revision aber behalten — ein Abschluss, der weder gespeichert noch je gesendet
 * würde. Deshalb: mit `previous` den Stand vor der Änderung wiederherstellen, ohne `previous` die eben angehängte,
 * ungespeicherte Revision entfernen. Für gespeicherte Revisionen gibt es weiterhin keinen solchen Weg.
 */
export function revertUnsavedAccountingPeriodClosure(id: string, previous: AccountingPeriodClosure | null): void {
  const index = closures.findIndex((item) => item.id === id);
  if (index < 0) return;
  closures = previous
    ? [...closures.slice(0, index), clone(previous), ...closures.slice(index + 1)]
    : [...closures.slice(0, index), ...closures.slice(index + 1)];
}

export function setAccountingPeriodStoreForTests(items: AccountingPeriodClosure[]): void {
  closures = items.map(clone);
}
