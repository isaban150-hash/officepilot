/**
 * FINANZ-CORE-01A (WEISS-Nacharbeit N09) — eine Kontierungswahrheit je Beleg.
 *
 * Der Server hält je Beleg genau eine aktive Kontierung (eindeutiger Index auf
 * Betrieb, Belegart, Beleg). Lokal konnten trotzdem zwei entstehen: zwei Geräte legen
 * offline je einen Vorschlag an; die zweite Anlage kommt nie in die Cloud, der Abzug
 * bringt die erste dazu. Danach wählte die Detailansicht die erste Zeile im Speicher,
 * der Export die letzte — die eine zeigte „bestätigt", der andere fand „zu prüfen" und
 * erzeugte keine Buchung.
 *
 * Jetzt wählen alle Leser dieselbe Zeile, nach einer festen Regel:
 *
 *   1. die Zeile, die der Server kennt (`sync.version > 0`) — sie ist die eine Wahrheit;
 *   2. dann die bestätigte;
 *   3. dann die zuletzt geänderte;
 *   4. dann die Kennung (stabil, damit kein Leser würfelt).
 *
 * Der Abgleich räumt nie übertragene Doppelungen zusätzlich weg
 * (`mergeAccountingFromPull`); diese Regel ist die zweite Linie.
 */
import type { AccountingAssignment, AccountingSourceType } from '../../types/accounting';

export function accountingSourceKey(assignment: Pick<AccountingAssignment, 'sourceType' | 'sourceId'>): string {
  return `${assignment.sourceType}:${assignment.sourceId}`;
}

function serverKnown(assignment: AccountingAssignment): boolean {
  return (assignment.sync?.version ?? 0) > 0;
}

/** Negativ: `a` ist die kanonische Zeile vor `b`. */
export function compareAccountingCanonical(a: AccountingAssignment, b: AccountingAssignment): number {
  if (serverKnown(a) !== serverKnown(b)) return serverKnown(a) ? -1 : 1;
  const aConfirmed = a.status === 'confirmed';
  const bConfirmed = b.status === 'confirmed';
  if (aConfirmed !== bConfirmed) return aConfirmed ? -1 : 1;
  if (a.updatedAt !== b.updatedAt) return a.updatedAt > b.updatedAt ? -1 : 1;
  return a.id.localeCompare(b.id);
}

/** Aktive (nicht gelöschte) Kontierungen. */
function active(assignment: AccountingAssignment): boolean {
  return !assignment.sync?.deleted;
}

export function pickCanonicalAccountingAssignment(
  candidates: readonly AccountingAssignment[],
): AccountingAssignment | undefined {
  return [...candidates].filter(active).sort(compareAccountingCanonical)[0];
}

/** Je Beleg genau die kanonische Kontierung. */
export function canonicalAccountingAssignmentsBySource(
  assignments: readonly AccountingAssignment[],
): Map<string, AccountingAssignment> {
  const bySource = new Map<string, AccountingAssignment>();
  for (const assignment of assignments) {
    if (!active(assignment)) continue;
    const key = accountingSourceKey(assignment);
    const current = bySource.get(key);
    if (!current || compareAccountingCanonical(assignment, current) < 0) bySource.set(key, assignment);
  }
  return bySource;
}

export function findCanonicalAccountingAssignment(
  assignments: readonly AccountingAssignment[],
  sourceType: AccountingSourceType,
  sourceId: string,
): AccountingAssignment | undefined {
  return pickCanonicalAccountingAssignment(
    assignments.filter((item) => item.sourceType === sourceType && item.sourceId === sourceId),
  );
}

/**
 * FINANZ-CORE-01A (WEISS-Nacharbeit N06) — eine geklärte Steuerbehandlung. „Unklar"
 * ist eine offene Frage, keine Behandlung.
 */
export function isResolvedAccountingTaxTreatment(value: AccountingAssignment['taxTreatment'] | undefined): boolean {
  return value !== undefined && value !== 'unclear';
}

/**
 * FINANZ-CORE-01A (WEISS-Nacharbeit N06) — eine Steuerwahrheit je Beleg: Die
 * Steuerbehandlung der Kontierung ist der Steuerstatus des Belegs (so entsteht sie im
 * Vorschlag, und so folgt sie ihm bei jeder Belegänderung). Trägt eine Bestätigung eine
 * andere Steuer als der Beleg, galt sie einem anderen Stand. Ohne bekannten Steuerstatus
 * des Belegs (`undefined`) zählt nur die Kontierung selbst.
 */
export function isAccountingTaxInLineWithSource(
  taxTreatment: string | undefined,
  sourceTaxTreatment: string | undefined,
): boolean {
  if (!isResolvedAccountingTaxTreatment(taxTreatment as AccountingAssignment['taxTreatment'] | undefined)) return false;
  return sourceTaxTreatment === undefined || sourceTaxTreatment === taxTreatment;
}

/**
 * FINANZ-CORE-01A (WEISS-Nacharbeit N06) — der wirksame Stand einer Kontierung. Ein
 * Altbestand „bestätigt" mit ungeklärter Steuer (vor N06 möglich) gilt überall als
 * „zu prüfen": in der Übersicht, im Export und im Monatsabschluss. Ebenso eine
 * Bestätigung, deren Steuer nicht (mehr) dem Steuerstatus des Belegs entspricht.
 */
export function effectiveAccountingStatus(
  assignment: Pick<AccountingAssignment, 'status' | 'taxTreatment'>,
  sourceTaxTreatment?: string,
): AccountingAssignment['status'] {
  return assignment.status === 'confirmed' &&
    !isAccountingTaxInLineWithSource(assignment.taxTreatment, sourceTaxTreatment)
    ? 'needs_review'
    : assignment.status;
}
