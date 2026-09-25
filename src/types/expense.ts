import type { ClassifiedDocumentKind, DigitalFolder, PaperFilingRule, TaxStatus } from './models';
import type { SyncMeta } from './sync';

export type ExpenseCategory =
  | 'material'
  | 'werkzeug'
  | 'fahrzeug'
  | 'reise'
  | 'subunternehmer'
  | 'personal'
  | 'versicherung'
  | 'behoerde'
  | 'betrieb'
  | 'leasing'
  | 'gutschrift'
  | 'sonstiges';

export type ExpenseStatus = 'entwurf' | 'gebucht' | 'storniert';

/**
 * Der Zahlstatus einer Ausgabe.
 *
 * FINANZCORE-05B-FIX2 — `gutschrift` ist neu und beschreibt einen Beleg mit
 * negativem Bruttobetrag: eine Lieferantengutschrift.
 *
 * Er ist kein Zwischenzustand auf dem Weg zu „bezahlt", sondern etwas anderes
 * als die übrigen vier: Eine Gutschrift ist keine Verbindlichkeit, die man
 * begleicht, sondern ein Guthaben gegenüber dem Lieferanten. Ohne eigenen Wert
 * musste sie sich einen der bestehenden teilen — und landete bei „bezahlt",
 * obwohl nie Geld geflossen war.
 *
 * Bewusst ein zusätzlicher Wert im vorhandenen Aufzählungstyp und keine zweite
 * Statuswelt: Filter, Sortierung, Abzeichen und Übersetzungen bleiben dieselbe
 * Maschinerie. Kein Listenfilter zielt auf ihn, also erscheint eine Gutschrift
 * weder unter den offenen noch unter den bezahlten Ausgaben — nur unter allen.
 */
/*
 * FINANZCORE-05C — `ueberbezahlt` kommt hinzu, mit derselben Begruendung wie
 * bei den Rechnungen: Eine Ausgabe, auf die zu viel gezahlt wurde, ist nicht
 * dasselbe wie eine beglichene. Ebenfalls rein abgeleitet — die Ausgabe reist
 * als JSON-Nutzlast, es gibt keine Statusspalte.
 */
export type ExpensePaymentStatus =
  | 'offen'
  | 'teilbezahlt'
  | 'bezahlt'
  | 'ueberbezahlt'
  | 'ueberfaellig'
  | 'storniert'
  | 'gutschrift';

export interface ExpensePayment {
  id: string;
  date: string;
  amount: number;
  reference?: string;
  note?: string;
  createdAt: string;
}

export interface ExpensePaymentInput {
  date: string;
  amount: number;
  reference?: string;
  note?: string;
}

export interface ExpensePaymentSummary {
  totalDue: number;
  paidAmount: number;
  openAmount: number;
  overpaidAmount: number;
  status: ExpensePaymentStatus;
}

export interface ExpenseLine {
  id: string;
  description: string;
  quantity: number;
  unit: string;
  netAmount: number;
  taxRate: number;
  grossAmount: number;
}

export interface ExpenseAllocation {
  vorgangId: string;
  vorgangTitle: string;
  amount: number;
  orderPositionId?: string;
}

export interface Expense {
  id: string;
  status: ExpenseStatus;
  category: ExpenseCategory;
  supplierName: string;
  invoiceNumber: string;
  title: string;
  description: string;
  issueDate: string;
  paymentDueDate: string | null;
  taxStatus: TaxStatus;
  netAmount: number;
  taxAmount: number;
  grossAmount: number;
  currency: string;
  paymentStatus: ExpensePaymentStatus;
  payments?: ExpensePayment[];
  positions: ExpenseLine[];
  allocations: ExpenseAllocation[];
  linkedInboxId?: string;
  archiveDocumentId?: string;
  classifiedKind?: ClassifiedDocumentKind;
  recognizedData?: Record<string, string>;
  isCreditNote: boolean;
  dedupeKey: string;
  tags: string[];
  digitalFolder: DigitalFolder;
  paperFolder: PaperFilingRule;
  createdAt: string;
  updatedAt: string;
  cancelledAt?: string;
  cancelReason?: string;
  sync?: SyncMeta;
}

export interface ExpenseInput {
  title: string;
  category: ExpenseCategory;
  supplierName: string;
  invoiceNumber?: string;
  description?: string;
  issueDate: string;
  paymentDueDate?: string | null;
  taxStatus?: TaxStatus;
  netAmount?: number;
  taxAmount?: number;
  grossAmount: number;
  currency?: string;
  status?: ExpenseStatus;
  classifiedKind?: ClassifiedDocumentKind;
  recognizedData?: Record<string, string>;
  isCreditNote?: boolean;
  tags?: string[];
  digitalFolder?: DigitalFolder;
  paperFolder?: PaperFilingRule;
  linkedInboxId?: string;
  archiveDocumentId?: string;
}

export interface ExpenseOverviewItem {
  expense: Expense;
  paymentSummary: ExpensePaymentSummary;
}

export interface ExpenseSummary {
  totalCount: number;
  bookedCount: number;
  draftCount: number;
  cancelledCount: number;
  totalGrossAmount: number;
  byCategory: Partial<Record<ExpenseCategory, number>>;
}
