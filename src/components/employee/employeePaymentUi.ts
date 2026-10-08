/**
 * P1 MITARBEITERZAHLUNGEN — kleine, reine Hilfen für die Oberfläche.
 *
 * Keine Fachlogik: Prüfung, Bestätigung und Storno bleiben in den Diensten.
 */
import type { TranslationKey } from '../../i18n';
import type { CompanyDocument } from '../../types/models';
import type { EmployeePaymentKind, EmployeePaymentMethod } from '../../types/employee';
import { getSyncOutboxSnapshot } from '../../services/sync/syncOutboxService';
import { isSupabaseSyncAllowed } from '../../services/sync/cloudSyncAllowlist';
import { isPayoutReceiptDocumentId } from '../../services/employee/payoutReceiptDocumentId';

/** Heute als `YYYY-MM-DD` in der Ortszeit des Geräts — nicht in UTC. */
export function todayIsoLocal(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function kindLabelKey(kind: EmployeePaymentKind): TranslationKey {
  return `employeePayment.kind.${kind}` as TranslationKey;
}

export function methodLabelKey(method: EmployeePaymentMethod): TranslationKey {
  return `employeePayment.method.${method}` as TranslationKey;
}

/** Der fachliche Hinweis je Art — beim Vorschuss wörtlich „nicht als Aufwand". */
export function kindHintKey(kind: EmployeePaymentKind): TranslationKey {
  return `employeePayment.hint.${kind === 'reimbursement' ? 'reimbursement' : kind}` as TranslationKey;
}

/** Ersetzt `{name}`-Platzhalter in einem übersetzten Text. */
export function fillText(text: string, values: Record<string, string | number>): string {
  return Object.entries(values).reduce((acc, [key, value]) => acc.split(`{${key}}`).join(String(value)), text);
}

/** Werden Mitarbeiter und Mitarbeiterzahlungen auf diesem Stand in die Cloud übertragen? */
export function isEmployeeCloudSyncActive(): boolean {
  return isSupabaseSyncAllowed('employee') && isSupabaseSyncAllowed('employee_payment');
}

/** Liegt für diese Zahlung noch ein unbestätigter Cloud-Auftrag vor? */
export function isEmployeePaymentCloudPending(paymentId: string): boolean {
  return getSyncOutboxSnapshot().some(
    (entry) =>
      entry.entityType === 'employee_payment' &&
      entry.entityId === paymentId &&
      entry.status !== 'completed',
  );
}

/**
 * Als Nachweis wählbar ist jedes aktive Dokument außer einer erzeugten
 * Auszahlungsquittung und außer Dokumenten mit Rechnungsbezug — der Beleg einer
 * Mitarbeiterzahlung ist ein Archivdokument.
 */
export function isSelectableEmployeeProofDocument(document: CompanyDocument): boolean {
  return !isPayoutReceiptDocumentId(document.id) && !document.linkedInvoiceId?.trim();
}
