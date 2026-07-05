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

/** Vorbereitet für Sprint 20C – Zahlungen */
export type ExpensePaymentStatus =
  | 'offen'
  | 'teilbezahlt'
  | 'bezahlt'
  | 'ueberfaellig'
  | 'storniert';

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
