import { OFFICEPILOT_LEGAL_DISCLAIMER } from '../config/legalDisclaimer';

export interface BrainCompanySnapshot {
  companyName: string;
  contactPerson: string;
  street: string;
  zip: string;
  city: string;
  email: string;
  taxNumber: string;
  vatId: string;
}

export interface BrainVorgangSnapshot {
  id: string;
  title: string;
  customer: string;
  status: string;
  baustelle: string;
  invoiceCount: number;
}

export interface BrainInvoiceSnapshot {
  number: string;
  vorgangTitle: string;
  customer: string;
  openAmount: number;
  paymentStatus: string;
}

export interface BrainInvoiceTotalsSnapshot {
  openReceivables: number;
  overdueReceivables: number;
  openInvoiceCount: number;
  overdueInvoiceCount: number;
}

export interface BrainExpenseSnapshot {
  id: string;
  title: string;
  supplierName: string;
  openAmount: number;
  paymentStatus: string;
}

export interface BrainTaskSnapshot {
  id: string;
  title: string;
  dueDate?: string | null;
  done: boolean;
}

export interface BrainDocumentSnapshot {
  id: string;
  title: string;
  category: string;
  issuer: string;
}

export interface BrainInboxSnapshot {
  id: string;
  title: string;
  sender: string;
  status: string;
  documentType: string;
}

export interface BrainKnowledgeSnapshot {
  scope: string;
  category: string;
  displayText: string;
}

export interface BrainNoteSnapshot {
  vorgangTitle: string;
  body: string;
  occurredAt: string;
}

export interface BrainCommunicationSnapshot {
  type: string;
  excerpt: string;
  timestamp: string;
  channel?: string;
}

export interface BrainSnapshot {
  generatedAt: string;
  referenceDate: string;
  company: BrainCompanySnapshot;
  vorgaenge: BrainVorgangSnapshot[];
  invoiceTotals: BrainInvoiceTotalsSnapshot;
  invoices: BrainInvoiceSnapshot[];
  expenses: BrainExpenseSnapshot[];
  expenseOpenCount: number;
  tasksOpen: BrainTaskSnapshot[];
  tasksToday: BrainTaskSnapshot[];
  documents: BrainDocumentSnapshot[];
  inbox: BrainInboxSnapshot[];
  knowledge: BrainKnowledgeSnapshot[];
  notes: BrainNoteSnapshot[];
  communicationHistory: BrainCommunicationSnapshot[];
}

export type BrainAnswerSource = 'ai' | 'unavailable';

export interface BrainAnswer {
  question: string;
  text: string;
  source: BrainAnswerSource;
  disclaimer: string;
  generatedAt: string;
  errorCode?: string;
}

export const BRAIN_ANSWER_DISCLAIMER =
  `${OFFICEPILOT_LEGAL_DISCLAIMER} Antworten basieren nur auf den lokal gespeicherten Daten und können unvollständig sein.`;
