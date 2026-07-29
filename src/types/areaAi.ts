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
  /** Short core answer shown first (e.g. "Nein." or an honest unclear statement). */
  directAnswer?: string;
  /** Document-grounded reasoning that follows the core answer. */
  explanation?: string;
  /** True when answer rests on incomplete/uncertain document data or AI issues. */
  uncertain?: boolean;
  /** User-visible concrete uncertainty notes (not a generic disclaimer alone). */
  uncertaintyNotes?: string[];
}

/**
 * DOCUMENT-ASSIST-02B — ephemeral dialog turn (never persist, never TruthView).
 */
export type DocumentAiPriorTurnRole = 'user' | 'assistant';

export type DocumentAiPriorTurn = {
  role: DocumentAiPriorTurnRole;
  text: string;
  /** Assistant turns: prior answer was uncertain — do not harden on follow-up. */
  uncertain?: boolean;
  uncertaintyNotes?: string[];
};

export interface DocumentAiContext {
  sourceType: 'document' | 'inbox';
  title: string;
  issuerOrSender: string;
  category: string;
  classifiedKind?: string | null;
  deadline?: string;
  validUntil?: string | null;
  issueDate?: string | null;
  amountHint?: string | null;
  recognizedText?: string;
  recognizedDataLines: string[];
  /** Runtime-only: test/sample/demo/draft markers in title or text. */
  documentNature?: 'test_or_sample' | 'unknown';
  /** Only set when a confirmed Vorgang link exists. */
  linkedVorgangId?: string | null;
  linkedVorgangTitle?: string;
  digitalFolderPath?: string;
  paperFolderLabel?: string;
  letterSummary?: {
    about: string;
    deadline: string;
    nextSteps: string;
  };
  missingDocuments: string[];
  tags: string[];
  /** Precomputed data-quality notes for the prompt and UI. */
  uncertainFieldNotes: string[];
  missingFieldNotes: string[];
  /**
   * DOCUMENT-WORK-RESULT-01B — compact resolved facts (confirmed/corrected).
   * Prefer over raw KI hints when no conflict. Never implies actions.
   */
  documentWorkTruthFactLines?: string[];
  /** Unresolved overlay conflicts — must not be treated as decided. */
  documentWorkTruthConflictLines?: string[];
  /**
   * DOCUMENT-ASSIST-02A — user-confirmed fact lines only (Fill-Confirm + overlay).
   * Highest prompt priority; OCR must not override these.
   */
  confirmedUserFactLines?: string[];
  /** True when a confirmed user value covers amount — suppress OCR amountHint. */
  suppressAmountHint?: boolean;
  /** True when a confirmed user value covers deadline — suppress structured OCR deadline. */
  suppressStructuredDeadline?: boolean;
  /** True when a confirmed user value covers sender/counterparty. */
  suppressIssuerHint?: boolean;
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
