import { OFFICEPILOT_LEGAL_DISCLAIMER } from '../config/legalDisclaimer';

export const AREA_AI_DISCLAIMER =
  `${OFFICEPILOT_LEGAL_DISCLAIMER} Antworten basieren nur auf den lokal gespeicherten Daten und können unvollständig sein.`;

export type AreaAiAnswerSource = 'ai' | 'unavailable';

export interface AreaAiAnswer {
  question: string;
  text: string;
  source: AreaAiAnswerSource;
  disclaimer: string;
  generatedAt: string;
  errorCode?: string;
  warnings?: string[];
}

export interface DocumentAiContext {
  sourceType: 'document' | 'inbox';
  title: string;
  issuerOrSender: string;
  category: string;
  deadline?: string;
  validUntil?: string | null;
  issueDate?: string | null;
  recognizedText?: string;
  recognizedDataLines: string[];
  linkedVorgangTitle?: string;
  letterSummary?: {
    about: string;
    deadline: string;
    nextSteps: string;
  };
  missingDocuments: string[];
  tags: string[];
}

export interface VorgangAiContext {
  id: string;
  title: string;
  customer: string;
  baustelle: string;
  status: string;
  notes: Array<{ body: string; occurredAt: string }>;
  openTasks: Array<{ title: string; dueDate?: string }>;
  invoices: Array<{
    number: string;
    openAmount: number;
    paymentStatus: string;
    dueDate?: string;
  }>;
  linkedDocuments: Array<{ title: string; category: string }>;
  openInvoiceTotal: number;
}
