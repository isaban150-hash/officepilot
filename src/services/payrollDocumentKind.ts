/**
 * P1 MITARBEITERZAHLUNGEN — Lohnunterlagen sind kein Ausgabenbeleg.
 *
 * Eine Lohnabrechnung bucht der Steuerberater; die tatsächliche Auszahlung an
 * den Mitarbeiter erfasst OfficeTakt als Mitarbeiterzahlung. Würde dieselbe
 * Lohnabrechnung zusätzlich als Ausgabe gebucht, erschienen Lohnkosten doppelt.
 *
 * Bewusst eine eigene, enge Liste — **nicht** `FINANCE_REFERENCE_ONLY_KINDS`:
 * Jene trägt die Mahnungslogik (Zahlungsprüfung, Rechnungsbezug) und würde
 * Lohnunterlagen fachlich falsch behandeln.
 */
import type { ClassifiedDocumentKind } from '../types/models';

export const PAYROLL_DOCUMENT_KINDS: ReadonlySet<ClassifiedDocumentKind> = new Set<ClassifiedDocumentKind>([
  'lohnabrechnung',
  'lohnunterlagen',
]);

export function isPayrollDocumentKind(kind: ClassifiedDocumentKind | string | undefined | null): boolean {
  return typeof kind === 'string' && PAYROLL_DOCUMENT_KINDS.has(kind as ClassifiedDocumentKind);
}
