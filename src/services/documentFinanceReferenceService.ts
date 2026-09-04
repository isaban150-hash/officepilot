/**
 * DOCUMENT-ACCOUNTING-REFERENCE-SAFETY-01B — ein eingegangenes Dokument findet
 * seinen Bezugsbeleg, statt einen neuen zu erzeugen.
 *
 * Der belegte Fehler: „Zahlung prüfen" auf einer Mahnung lief über
 * `createExpenseFromInbox` → `addExpense`. Eine Mahnung ist aber kein Beleg,
 * sondern ein **Verweis** auf einen bereits vorhandenen. Wer zweimal darauf
 * tippte, hatte die Verbindlichkeit doppelt in den Büchern.
 *
 * Dieser Dienst sucht nur und entscheidet nichts. Er legt nichts an, ändert
 * keinen Zahlungsstatus und trägt keine Zahlung ein. Die fachliche Wahrheit
 * bleibt `Expense` und `VorgangInvoice`; hier entsteht ausschliesslich die
 * Verbindung — und auch die erst nach ausdrücklicher Bestätigung.
 *
 * Ausdrücklich getrennt von `dunningDocumentationService`: Der beschreibt
 * Mahnungen, die **wir versenden**. Hier geht es um Post, die **bei uns
 * eingeht**. Dieselbe Vokabel, zwei Richtungen — sie dürfen sich nie treffen.
 */
import type { ClassifiedDocumentKind, InboxItem } from '../types/models';
import type { Expense } from '../types/expense';
import type {
  DocumentFinanceReference,
  DocumentFinanceReferenceDirection,
} from '../types/documentFinanceReference';
import { getAllExpenses } from './expenseService';
import { calculateExpensePaymentSummary } from './expensePaymentCalculations';
import { normalizeDedupePart } from './expenseNormalize';
import { getInboxItemById, patchInboxItem } from './inboxService';

/**
 * Dokumentarten, die auf einen bestehenden Beleg **verweisen**, statt selbst
 * einer zu sein. Für sie darf niemals eine Ausgabe entstehen.
 *
 * Bewusst eng gehalten: Gutschrift und Storno verweisen fachlich ebenfalls auf
 * eine Ursprungsrechnung, führen aber zu einer eigenen Buchung mit umgekehrtem
 * Vorzeichen. Sie gehören damit **nicht** in diese Liste und bleiben einem
 * eigenen Block vorbehalten.
 */
const FINANCE_REFERENCE_ONLY_KINDS = new Set<ClassifiedDocumentKind>([
  'mahnung',
  'zahlungserinnerung',
]);

export function isFinanceReferenceOnlyKind(
  kind: ClassifiedDocumentKind | undefined,
): boolean {
  return kind !== undefined && FINANCE_REFERENCE_ONLY_KINDS.has(kind);
}

export type DocumentFinanceMatchStatus =
  | 'exact'
  | 'ambiguous'
  | 'not_found'
  | 'already_linked'
  | 'conflict'
  | 'paid_conflict';

export interface DocumentFinanceCandidate {
  targetType: 'expense';
  targetId: string;
  supplierName: string;
  invoiceNumber: string;
  grossAmount: number;
  openAmount: number;
  paidAmount: number;
  paymentStatus: Expense['paymentStatus'];
}

export interface DocumentFinanceReferenceMatch {
  status: DocumentFinanceMatchStatus;
  direction: DocumentFinanceReferenceDirection;
  /** Die im Dokument erkannte Nummer, normalisiert für den Vergleich. */
  referenceNumber: string;
  counterpartyKey: string;
  candidates: DocumentFinanceCandidate[];
  /** Nur bei `exact`, `paid_conflict` und `already_linked` gesetzt. */
  matched: DocumentFinanceCandidate | null;
  /** Die bereits bestätigte Verbindung, falls vorhanden. */
  confirmed: DocumentFinanceReference | null;
  /**
   * Der im Dokument genannte Betrag weicht vom Beleg ab — bei Mahnkosten der
   * Normalfall. Er zerstört den Treffer nicht, bleibt aber sichtbar.
   */
  amountMismatch: boolean;
  documentAmount: number | null;
}

/*
 * ————— zentrale Feldauflösung —————
 *
 * Bewusst hier und nicht in einer Oberflächenkomponente: Es gibt genau eine
 * Stelle, an der aus `recognizedData` eine Referenznummer, eine Gegenpartei und
 * ein Betrag werden. Sonst entstünde in jeder Ansicht eine eigene Lesart.
 */

const REFERENCE_NUMBER_FIELDS = [
  'Rechnungsnummer',
  'rechnungsnummer',
  'Belegnummer',
  'belegnummer',
  'Referenznummer',
  'referenznummer',
  'Referenz',
  'referenz',
] as const;

const AMOUNT_FIELDS = ['Betrag', 'betrag', 'Amount', 'Offener Betrag'] as const;

/** `RE-4711`, `re 4711` und `RE4711` sollen denselben Beleg treffen. */
export function normalizeReferenceNumber(value: string | undefined): string {
  return (value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function resolveDocumentReferenceNumber(item: InboxItem): string {
  for (const field of REFERENCE_NUMBER_FIELDS) {
    const raw = item.recognizedData?.[field]?.trim();
    if (raw) return raw;
  }
  return '';
}

export function resolveDocumentCounterpartyKey(item: InboxItem): string {
  return normalizeDedupePart(item.sender ?? '');
}

function parseGermanAmount(value: string | undefined): number | null {
  if (!value?.trim()) return null;
  const cleaned = value.replace(/[^\d,.-]/g, '').replace(/\./g, '').replace(',', '.');
  const parsed = Number.parseFloat(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

export function resolveDocumentAmount(item: InboxItem): number | null {
  for (const field of AMOUNT_FIELDS) {
    const parsed = parseGermanAmount(item.recognizedData?.[field]);
    if (parsed !== null && parsed !== 0) return parsed;
  }
  return null;
}

function toCandidate(expense: Expense): DocumentFinanceCandidate {
  const summary = calculateExpensePaymentSummary(expense);
  return {
    targetType: 'expense',
    targetId: expense.id,
    supplierName: expense.supplierName,
    invoiceNumber: expense.invoiceNumber,
    grossAmount: expense.grossAmount,
    openAmount: summary.openAmount,
    paidAmount: summary.paidAmount,
    paymentStatus: summary.status,
  };
}

/**
 * Der Auflöser.
 *
 * Rangfolge der Signale: Referenznummer, dann Gegenpartei, dann Richtung. Der
 * **Betrag stützt nur** — er entscheidet nie. Eine Mahnung nennt wegen
 * Mahnkosten regelmässig einen höheren Betrag als die Rechnung; ein Match
 * daran scheitern zu lassen wäre so falsch wie ein Match allein darauf zu
 * gründen.
 *
 * Ohne Referenznummer gibt es **keinen** sicheren Treffer: Lieferant plus
 * Betrag reichen nicht, und ein falsch verbundener Beleg ist schlimmer als ein
 * ungelöster.
 */
export function resolveDocumentFinanceReference(
  item: InboxItem,
  options?: { direction?: DocumentFinanceReferenceDirection },
): DocumentFinanceReferenceMatch {
  const direction = options?.direction ?? 'incoming_payable';
  const referenceRaw = resolveDocumentReferenceNumber(item);
  const referenceNumber = normalizeReferenceNumber(referenceRaw);
  const counterpartyKey = resolveDocumentCounterpartyKey(item);
  const documentAmount = resolveDocumentAmount(item);
  const confirmed = item.financeReference ?? null;

  const base = {
    direction,
    referenceNumber,
    counterpartyKey,
    confirmed,
    documentAmount,
    amountMismatch: false,
  };

  /*
   * Eine bereits bestätigte Verbindung ist Wahrheit und wird nie still
   * umgehängt. Zeigt der Beleg nicht mehr existent oder widersprechen die
   * erkannten Daten, ist das ein Prüffall — kein Anlass, neu zu verbinden.
   */
  if (confirmed) {
    const target = getAllExpenses().find((expense) => expense.id === confirmed.targetId);
    if (!target) {
      return { ...base, status: 'conflict', candidates: [], matched: null };
    }
    const candidate = toCandidate(target);
    const stillMatches =
      normalizeReferenceNumber(target.invoiceNumber) === referenceNumber &&
      normalizeDedupePart(target.supplierName) === counterpartyKey;
    return {
      ...base,
      status: stillMatches || !referenceNumber ? 'already_linked' : 'conflict',
      candidates: [candidate],
      matched: candidate,
      amountMismatch: documentAmount !== null && documentAmount !== target.grossAmount,
    };
  }

  if (direction !== 'incoming_payable') {
    // Ausgehende Forderungen sind in diesem Block bewusst nicht aufgelöst.
    return { ...base, status: 'not_found', candidates: [], matched: null };
  }

  if (!referenceNumber) {
    return { ...base, status: 'not_found', candidates: [], matched: null };
  }

  const byNumber = getAllExpenses().filter(
    (expense) => normalizeReferenceNumber(expense.invoiceNumber) === referenceNumber,
  );
  if (byNumber.length === 0) {
    return { ...base, status: 'not_found', candidates: [], matched: null };
  }

  /*
   * Die Gegenpartei gehört zur Identität. „RE-4711" von Lieferant A und
   * „RE-4711" von Lieferant B sind zwei verschiedene Belege — eine globale
   * Suche allein über die Nummer mit erstem Treffer wäre ein Buchungsfehler.
   */
  const byCounterparty = counterpartyKey
    ? byNumber.filter((expense) => normalizeDedupePart(expense.supplierName) === counterpartyKey)
    : [];

  if (byCounterparty.length === 0) {
    return {
      ...base,
      status: byNumber.length > 0 ? 'conflict' : 'not_found',
      candidates: byNumber.map(toCandidate),
      matched: null,
    };
  }

  if (byCounterparty.length > 1) {
    return {
      ...base,
      status: 'ambiguous',
      candidates: byCounterparty.map(toCandidate),
      matched: null,
    };
  }

  const expense = byCounterparty[0]!;
  const candidate = toCandidate(expense);
  const amountMismatch = documentAmount !== null && documentAmount !== expense.grossAmount;

  /*
   * Bereits vollständig bezahlt: Die Mahnung ist dann kein Zahlungsauftrag,
   * sondern ein Widerspruch. OfficePilot behauptet weder das eine noch das
   * andere — es legt den Konflikt offen und rührt die Zahlungen nicht an.
   */
  if (candidate.openAmount <= 0 && candidate.paidAmount > 0) {
    return { ...base, status: 'paid_conflict', candidates: [candidate], matched: candidate, amountMismatch };
  }

  return { ...base, status: 'exact', candidates: [candidate], matched: candidate, amountMismatch };
}

export type ConfirmFinanceReferenceResult =
  | { ok: true; item: InboxItem }
  | { ok: false; reason: 'document_missing' | 'target_missing' | 'already_linked' | 'persist_failed' };

/**
 * Der **einzige** Weg, wie eine Belegverbindung entsteht — und er verlangt eine
 * ausdrückliche Nutzeraktion.
 *
 * Was hier ausdrücklich nicht passiert: keine Ausgabe wird angelegt, keine
 * Zahlung eingetragen, kein Zahlungsstatus verändert, kein Betrag erhöht. Es
 * wird ein Verweis gespeichert, sonst nichts.
 *
 * Eine bestehende Verbindung wird nicht überschrieben. Wer wirklich umhängen
 * will, muss die alte zuerst lösen — sonst könnte eine spätere Neuerkennung
 * eine geprüfte Zuordnung still verschieben.
 */
export function confirmDocumentFinanceReference(
  itemId: string,
  target: { targetType: 'expense'; targetId: string },
  options?: { now?: string },
): ConfirmFinanceReferenceResult {
  const item = getInboxItemById(itemId);
  if (!item) return { ok: false, reason: 'document_missing' };
  if (item.financeReference) return { ok: false, reason: 'already_linked' };

  const expense = getAllExpenses().find((entry) => entry.id === target.targetId);
  if (!expense) return { ok: false, reason: 'target_missing' };

  const reference: DocumentFinanceReference = {
    direction: 'incoming_payable',
    targetType: 'expense',
    targetId: expense.id,
    referenceNumber: resolveDocumentReferenceNumber(item) || expense.invoiceNumber,
    counterpartyKey: normalizeDedupePart(expense.supplierName),
    confirmedAt: options?.now ?? new Date().toISOString(),
  };

  const updated = patchInboxItem(itemId, { financeReference: reference });
  return updated ? { ok: true, item: updated } : { ok: false, reason: 'persist_failed' };
}
