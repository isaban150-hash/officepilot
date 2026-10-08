/**
 * P1 MITARBEITERZAHLUNGEN — Mitarbeiter und Zahlungen an Mitarbeiter.
 *
 * Zwei getrennte Wahrheiten:
 *  - `Employee` ist ein schlanker Stammsatz (Name, optional Personalnummer,
 *    aktiv/inaktiv). Er ist **kein** Benutzerkonto, kein Workspace-Mitglied und
 *    keine Rolle; es gibt bewusst keine Verbindung dorthin.
 *  - `EmployeePayment` ist die einzige Wahrheit einer Zahlung an einen
 *    Mitarbeiter. Sie erzeugt weder Ausgabe noch Ausgabenzahlung, Buchung,
 *    Verbindlichkeit oder Bankzuordnung.
 *
 * Nach der Bestätigung sind die Geldfelder unveränderlich. Korrigiert wird
 * über Storno und Neuerfassung; nur der Nachweis (`proofDocumentId`) lässt sich
 * über einen eigenen, geldfreien Schritt ändern, die erzeugte Quittung
 * (`receiptDocumentId`) wird genau einmal gesetzt.
 */
import type { SyncMeta } from './sync';

export type EmployeePaymentKind = 'wage' | 'advance' | 'reimbursement' | 'travel' | 'other';

export const EMPLOYEE_PAYMENT_KINDS: readonly EmployeePaymentKind[] = [
  'wage',
  'advance',
  'reimbursement',
  'travel',
  'other',
];

/** Wie ausgezahlt wurde — reine Angabe, in V1 ohne Bankzuordnung. */
export type EmployeePaymentMethod = 'cash' | 'bank' | 'other';

export const EMPLOYEE_PAYMENT_METHODS: readonly EmployeePaymentMethod[] = ['cash', 'bank', 'other'];

export interface Employee {
  id: string;
  name: string;
  personnelNumber?: string;
  active: boolean;
  createdAt: string;
  createdBy?: string;
  updatedAt: string;
  updatedBy?: string;
  /**
   * `sync.version` ist die zuletzt vom Server bestätigte `row_version`
   * (0 = noch nie gesendet). Der Push sendet sie als Basisversion.
   */
  sync?: SyncMeta;
}

export interface EmployeePayment {
  id: string;
  employeeId: string;
  /** Name zum Zeitpunkt der Bestätigung — eine spätere Umbenennung ändert ihn nicht. */
  employeeName: string;
  /** Personalnummer zum Zeitpunkt der Bestätigung, falls vorhanden. */
  personnelNumber?: string;
  kind: EmployeePaymentKind;
  amount: number;
  /** Auszahlungsdatum, `YYYY-MM-DD`. */
  paymentDate: string;
  paymentMethod: EmployeePaymentMethod;
  /** Nur bei Lohn/Gehalt: `YYYY-MM`. */
  wageMonth?: string;
  purpose?: string;
  note?: string;
  /** `MZ-YYYYMMDD-XXXXXXXX` — bei Bestätigung festgelegt, danach unveränderlich. */
  receiptReference: string;
  /** „Ausgezahlt durch" zum Zeitpunkt der Bestätigung. */
  paidByName?: string;
  /** Die von OfficeTakt erzeugte Auszahlungsquittung (einmal gesetzt). */
  receiptDocumentId?: string;
  /** Unterschriebene Quittung oder anderer Nachweis (geldfrei änderbar). */
  proofDocumentId?: string;
  createdAt: string;
  createdBy?: string;
  reversedAt?: string;
  reversedBy?: string;
  reversalReason?: string;
}

/** Eingaben des Formulars — noch keine Zahlung, nichts wird gespeichert. */
export interface EmployeePaymentDraft {
  employeeId: string;
  kind: EmployeePaymentKind | '';
  amount: string;
  paymentDate: string;
  paymentMethod: EmployeePaymentMethod | '';
  wageMonth?: string;
  purpose?: string;
  note?: string;
  paidByName?: string;
  proofDocumentId?: string;
}

/**
 * Der konkrete Bestätigungsvorgang: geprüfte Werte plus die Kennung, die genau
 * diese Bestätigung trägt. Ein Wiederholungsversuch verwendet denselben Vorgang.
 */
export interface EmployeePaymentConfirmationIntent {
  paymentId: string;
  employeeId: string;
  employeeName: string;
  personnelNumber?: string;
  kind: EmployeePaymentKind;
  amount: number;
  paymentDate: string;
  paymentMethod: EmployeePaymentMethod;
  wageMonth?: string;
  purpose?: string;
  note?: string;
  paidByName?: string;
  proofDocumentId?: string;
}

export type EmployeePaymentStatus = 'active' | 'reversed';

export function isEmployeePaymentReversed(payment: Pick<EmployeePayment, 'reversedAt'>): boolean {
  return Boolean(payment.reversedAt);
}
