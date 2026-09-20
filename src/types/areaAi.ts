import type { DocumentSemanticCore } from './documentSemanticCore';
import type { KnowledgeHit } from './domainKnowledge';
import { OFFICEPILOT_LEGAL_DISCLAIMER } from '../config/legalDisclaimer';

export const AREA_AI_DISCLAIMER =
  `${OFFICEPILOT_LEGAL_DISCLAIMER} Antworten basieren nur auf den lokal gespeicherten Daten und können unvollständig sein.`;

export type AreaAiAnswerSource = 'ai' | 'unavailable';

/**
 * Ein Beleg, wie ihn die Oberflaeche zeigt: Aussage, Herausgeber, Stand, Adresse.
 *
 * Bewusst je **Aussage** und nicht je Antwort — sonst hiesse es am Ende „diese
 * Antwort hat drei Quellen" statt „diese Tatsache stammt von dort".
 */
export interface AreaAiKnowledgeSource {
  statementId: string;
  statement: string;
  sourceTitle: string;
  publisher: string;
  /** Nur https und nur aus dem Bestand; fehlt, wenn die Quelle keine Adresse hat. */
  url?: string;
  /** Der Prueftag des Eintrags, als ISO-Tag. */
  reviewedAt: string;
}

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
  /**
   * DOKUMENT-ASSISTENT-01H3 — die Belege der tatsächlich verwendeten Aussagen.
   *
   * Nur gesetzt, wenn die Antwort belegtes Fachwissen benutzt hat, und nur mit
   * Einträgen aus dem eigenen Bestand. Was das Modell an Quellen behauptet,
   * kommt hier nie an: Es darf höchstens bekannte Kennungen nennen.
   */
  knowledgeSources?: AreaAiKnowledgeSource[];
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
  /**
   * DOKUMENT-ASSISTENT-01E — der semantische Kern aus 01B.
   *
   * Bewusst das **vorhandene** Modell und keine Kopie: Was der Kern sagt, ist
   * belegt und traegt seine Unsicherheit mit sich. Er steht in der
   * Wahrheitsrangfolge direkt hinter den bestaetigten Nutzerwerten und vor
   * allem, was aus `recognizedData` oder dem Volltext stammt.
   *
   * Fehlt er — Altdokumente vor 01B —, bleibt alles wie bisher.
   */
  semantic?: DocumentSemanticCore;
  /**
   * DOKUMENT-ASSISTENT-01F — Auskuenfte aus dem OfficeTakt-Bestand.
   *
   * Bewusst ein eigenes Feld und ein eigener Promptabschnitt: Was im
   * Schreiben steht und was OfficeTakt weiss, sind zwei Wahrheiten. Das
   * Dokument sagt, was gefordert wurde; der Bestand sagt, was tatsaechlich
   * bezahlt, zugeordnet oder erledigt ist. Vermischt ergaebe das einen
   * erfundenen Zahlungsstand.
   *
   * Gefuellt nur, wenn die Frage danach verlangt.
   */
  operationalLines?: string[];
  /**
   * DOKUMENT-ASSISTENT-01H3 — belegtes Fachwissen, sofern die Frage es braucht.
   *
   * Bewusst ein eigenes Feld und ein eigener Promptabschnitt: Was im Schreiben
   * steht und was allgemein gilt, sind zwei verschiedene Dinge. Vermischt
   * entstünde der gefährlichste Satz überhaupt — eine allgemeine Regel, die
   * wie eine Feststellung über diesen Betrieb klingt.
   *
   * Leer, wenn die Frage kein Fachwissen braucht. Das ist der Normalfall.
   */
  knowledge?: KnowledgeHit[];
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
