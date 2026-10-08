/**
 * P1 MITARBEITERZAHLUNGEN — was auf einer Auszahlungsquittung steht.
 *
 * Eine reine Funktion über **eine bestätigte Barzahlung** und die Firmendaten
 * zum Zeitpunkt der Erstellung. Kein pdf-lib, kein Speicher, kein Zustand: Die
 * Quittung ist eine Projektion der Zahlung, nie ihre Quelle. Was hier nicht
 * aus der Zahlung kommt, steht nicht auf dem Beleg.
 *
 * Die Quittung wird genau einmal erzeugt und archiviert; danach wird immer
 * dieses Original geöffnet. Deshalb gibt es hier keine Versionen und kein
 * „neu erzeugen mit heutigen Daten".
 */
import type { CompanyProfile } from '../../types/models';
import type { EmployeePayment, EmployeePaymentKind } from '../../types/employee';
import { isEmployeePaymentReversed } from '../../types/employee';
import { formatRegisterLine } from '../invoice/companyDocumentLines';
import { formatEuroAmountInWords } from './amountInWords';
import { isEmployeePaymentReference } from './employeePaymentReference';

export const PAYOUT_RECEIPT_TITLE = 'Auszahlungsquittung';
export const PAYOUT_RECEIPT_SUBTITLE = 'Quittung über eine Barauszahlung';
export const PAYOUT_RECEIPT_CONFIRMATION =
  'Ich bestätige, den oben genannten Betrag in bar erhalten zu haben.';
export const PAYOUT_RECEIPT_ADVANCE_HINT =
  'Hinweis: Diese Zahlung ist ein Vorschuss. Die Verrechnung erfolgt gesondert.';
export const PAYOUT_RECEIPT_CASH_LABEL = 'Bar';

/** Feste deutsche Bezeichnungen — die Quittung ist ein deutscher Geschäftsbeleg. */
export const PAYOUT_RECEIPT_KIND_LABELS: Record<EmployeePaymentKind, string> = {
  wage: 'Lohn/Gehalt',
  advance: 'Vorschuss',
  reimbursement: 'Auslagenerstattung',
  travel: 'Reisekosten',
  other: 'Sonstige Mitarbeiterzahlung',
};

const MONATE = [
  'Januar', 'Februar', 'März', 'April', 'Mai', 'Juni',
  'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember',
];

export interface PayoutReceiptFact {
  label: string;
  value: string;
  /** Leerer Wert, der von Hand ausgefüllt wird — die Quittung zeigt eine Linie. */
  handwritten?: boolean;
}

export interface PayoutReceiptModel {
  paymentId: string;
  reference: string;
  title: string;
  subtitle: string;
  /** Firmenname mit Rechtsform zuerst, danach die Anschrift. */
  companyLines: string[];
  contactLine: string;
  registerLine: string;
  facts: PayoutReceiptFact[];
  amountText: string;
  amountInWords: string | null;
  purpose: string | null;
  note: string | null;
  confirmationText: string;
  advanceHint: string | null;
  recipientName: string;
  paidByName: string | null;
  footerLeft: string;
  /** Erstellzeitpunkt der Zahlung — fester Zeitstempel der PDF-Metadaten. */
  createdAt: string;
}

export type PayoutReceiptModelResult =
  | { ok: true; model: PayoutReceiptModel }
  | { ok: false; reason: 'not_cash' | 'reversed' | 'invalid_payment' };

/** `2026-10-08` → `08.10.2026`; reine Zeichenkette, keine Zeitzonenfrage. */
export function formatReceiptDate(isoDate: string): string {
  const treffer = /^(\d{4})-(\d{2})-(\d{2})/.exec(isoDate.trim());
  if (!treffer) return isoDate.trim();
  return `${treffer[3]}.${treffer[2]}.${treffer[1]}`;
}

/** `2026-10` → `Oktober 2026`. */
export function formatReceiptWageMonth(wageMonth: string): string {
  const treffer = /^(\d{4})-(\d{2})$/.exec(wageMonth.trim());
  if (!treffer) return wageMonth.trim();
  const monat = MONATE[Number(treffer[2]) - 1];
  return monat ? `${monat} ${treffer[1]}` : wageMonth.trim();
}

/** `1234.5` → `1.234,50 €` — ohne Abhängigkeit vom Gebietsschema der Laufzeit. */
export function formatReceiptAmount(amount: number): string {
  const cents = Math.round(amount * 100);
  const negativ = cents < 0;
  const betrag = Math.abs(cents);
  const euro = Math.floor(betrag / 100).toString();
  const cent = (betrag % 100).toString().padStart(2, '0');
  const gruppiert = euro.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${negativ ? '-' : ''}${gruppiert},${cent} €`;
}

function text(value: string | null | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim();
}

/** Firmenzeilen wie im Geschäftsbrief: Name mit Rechtsform, Strasse, Ort, Land. */
export function buildReceiptCompanyLines(company: Partial<CompanyProfile>): string[] {
  const zeilen: string[] = [];
  const name = [text(company.companyName), text(company.legalForm)].filter(Boolean).join(' ');
  if (name) zeilen.push(name);
  if (text(company.street)) zeilen.push(text(company.street));
  const ort = [text(company.zip), text(company.city)].filter(Boolean).join(' ');
  if (ort) zeilen.push(ort);
  if (text(company.country)) zeilen.push(text(company.country));
  return zeilen;
}

/** Erreichbarkeit in einer Zeile; leere Bestandteile entfallen. */
export function buildReceiptContactLine(company: Partial<CompanyProfile>): string {
  return [
    text(company.phone) ? `Telefon ${text(company.phone)}` : '',
    text(company.email),
    text(company.website),
  ]
    .filter(Boolean)
    .join('  ·  ');
}

export function buildPayoutReceiptFilename(reference: string): string {
  const sauber = reference.replace(/[^A-Za-z0-9-]+/g, '');
  return `Auszahlungsquittung_${sauber || 'ohne-Referenz'}.pdf`;
}

/**
 * Das Modell — nur für eine bestätigte, nicht stornierte Barzahlung mit
 * gültiger MZ-Referenz.
 */
export function buildPayoutReceiptModel(
  payment: EmployeePayment,
  company: Partial<CompanyProfile>,
): PayoutReceiptModelResult {
  if (payment.paymentMethod !== 'cash') return { ok: false, reason: 'not_cash' };
  if (isEmployeePaymentReversed(payment)) return { ok: false, reason: 'reversed' };
  if (!isEmployeePaymentReference(payment.receiptReference)) return { ok: false, reason: 'invalid_payment' };
  if (!(payment.amount > 0) || !text(payment.employeeName)) return { ok: false, reason: 'invalid_payment' };

  const reference = payment.receiptReference;
  const recipientName = text(payment.employeeName);
  const personalnummer = text(payment.personnelNumber);
  const lohnmonat = payment.kind === 'wage' ? text(payment.wageMonth) : '';
  const paidByName = text(payment.paidByName) || null;

  const facts: PayoutReceiptFact[] = [
    { label: 'Referenz', value: reference },
    { label: 'Auszahlungsdatum', value: formatReceiptDate(payment.paymentDate) },
    { label: 'Mitarbeiter/in', value: recipientName },
  ];
  if (personalnummer) facts.push({ label: 'Personalnummer', value: personalnummer });
  facts.push({ label: 'Art der Zahlung', value: PAYOUT_RECEIPT_KIND_LABELS[payment.kind] });
  if (lohnmonat) facts.push({ label: 'Lohnmonat', value: formatReceiptWageMonth(lohnmonat) });
  facts.push({ label: 'Zahlungsweg', value: PAYOUT_RECEIPT_CASH_LABEL });
  facts.push(
    paidByName
      ? { label: 'Ausgezahlt durch', value: paidByName }
      : { label: 'Ausgezahlt durch', value: '', handwritten: true },
  );

  return {
    ok: true,
    model: {
      paymentId: payment.id,
      reference,
      title: PAYOUT_RECEIPT_TITLE,
      subtitle: PAYOUT_RECEIPT_SUBTITLE,
      companyLines: buildReceiptCompanyLines(company),
      contactLine: buildReceiptContactLine(company),
      registerLine: formatRegisterLine(company),
      facts,
      amountText: formatReceiptAmount(payment.amount),
      amountInWords: formatEuroAmountInWords(payment.amount),
      purpose: text(payment.purpose) || null,
      note: text(payment.note) || null,
      confirmationText: PAYOUT_RECEIPT_CONFIRMATION,
      advanceHint: payment.kind === 'advance' ? PAYOUT_RECEIPT_ADVANCE_HINT : null,
      recipientName,
      paidByName,
      footerLeft: `${PAYOUT_RECEIPT_TITLE} ${reference}`,
      createdAt: payment.createdAt,
    },
  };
}
