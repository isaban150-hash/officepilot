/**
 * STEUERBERATER-06A — der lokale Bestand der Kontierungen.
 *
 * Aufbau wie `expenseStore`: ein Modul-Array, Klone nach aussen, Hydrierung aus
 * der Persistenz. Keine eigene Speicherwelt.
 */
import type { AccountingAssignment, AccountingSourceType } from '../../types/accounting';

let assignments: AccountingAssignment[] = [];

function clone(value: AccountingAssignment): AccountingAssignment {
  return { ...value, sync: value.sync ? { ...value.sync } : undefined };
}

export function getAccountingStoreSnapshot(): AccountingAssignment[] {
  return assignments.map(clone);
}

export function hydrateAccountingStore(items: AccountingAssignment[]): void {
  assignments = items.map(clone);
}

export function resetAccountingStore(): void {
  assignments = [];
}

export function getAllAccountingAssignments(): AccountingAssignment[] {
  return assignments.map(clone);
}

export function getAccountingAssignmentById(id: string): AccountingAssignment | undefined {
  const found = assignments.find((item) => item.id === id);
  return found ? clone(found) : undefined;
}

/**
 * Die Kontierung eines Belegs. Genau eine je Beleg — dieselbe Zusage wie der
 * eindeutige Index in der Datenbank.
 */
export function getAccountingAssignmentForSource(
  sourceType: AccountingSourceType,
  sourceId: string,
): AccountingAssignment | undefined {
  const found = assignments.find(
    (item) => item.sourceType === sourceType && item.sourceId === sourceId,
  );
  return found ? clone(found) : undefined;
}

export function appendAccountingAssignment(next: AccountingAssignment): AccountingAssignment {
  assignments = [...assignments, clone(next)];
  return clone(next);
}

export function replaceAccountingAssignment(
  id: string,
  next: AccountingAssignment,
): AccountingAssignment | null {
  const index = assignments.findIndex((item) => item.id === id);
  if (index < 0) return null;
  const updated = clone(next);
  assignments = [...assignments.slice(0, index), updated, ...assignments.slice(index + 1)];
  return clone(updated);
}

export function deleteAccountingAssignment(id: string): AccountingAssignment | null {
  const index = assignments.findIndex((item) => item.id === id);
  if (index < 0) return null;
  const removed = assignments[index];
  assignments = [...assignments.slice(0, index), ...assignments.slice(index + 1)];
  return clone(removed);
}

export function setAccountingStoreForTests(items: AccountingAssignment[]): void {
  assignments = items.map(clone);
}
