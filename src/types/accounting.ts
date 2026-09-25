/**
 * STEUERBERATER-06A — Kontierung für die spätere Steuerberaterübergabe.
 *
 * Eine Kontierung ist **Metadaten neben dem Beleg**, nie eine Änderung an ihm.
 * Betrag, Steuerbetrag, Steuerstatus, Zahlungen und Zahlungsstatus bleiben
 * ausschliesslich Sache des Quellbelegs (05B–05E); hier steht nur, auf welches
 * Sachkonto er nach Meinung des Betriebs gehört und ob das jemand bestätigt
 * hat.
 *
 * Bewusst **keine** doppelte Buchführung: kein Gegenkonto, kein Buchungssatz,
 * keine Festschreibung, kein Export. Das wären Versprechen, die diese Schicht
 * nicht einlösen kann.
 */
import type { SyncMeta } from './sync';

/**
 * Der Kontenrahmen des Betriebs. Genau die beiden, die ein Handwerksbetrieb in
 * Deutschland üblicherweise führt; kein „sonstiger" Platzhalter, der nichts
 * bedeutet.
 */
export type ChartOfAccounts = 'SKR03' | 'SKR04';

export const CHART_OF_ACCOUNTS_VALUES: readonly ChartOfAccounts[] = ['SKR03', 'SKR04'];

/** Welcher Beleg kontiert wird. */
export type AccountingSourceType = 'expense' | 'invoice';

/**
 * Der Prüfstand einer Kontierung.
 *
 *   `needs_review`        — es liegt etwas vor, aber niemand hat es bestätigt.
 *                           **Jeder Vorschlag startet hier**, ausnahmslos.
 *   `confirmed`           — ein Mensch hat ausdrücklich bestätigt.
 *   `needs_clarification` — es fehlt eine fachliche Grundlage (etwa ein
 *                           unklarer Steuerstatus). Nicht dasselbe wie
 *                           „noch nicht angesehen".
 */
export type AccountingAssignmentStatus = 'needs_review' | 'confirmed' | 'needs_clarification';

/**
 * Woher die Kontierung stammt.
 *
 * `suggested` heisst: OfficeTakt hat etwas vorgeschlagen. Das ist eine Aussage
 * über die Herkunft, nicht über die Gültigkeit — ein Vorschlag ist nie eine
 * Übernahme.
 */
export type AccountingAssignmentOrigin = 'suggested' | 'manual';

/**
 * Die steuerliche Behandlung, wie sie **am Quellbeleg** steht.
 *
 * Bewusst dieselbe Aufzählung wie `TaxStatus` und keine eigene Steuerwelt:
 * Kontierung rechnet nichts, sie trägt nur weiter, was 05B festgestellt hat.
 * `unclear` bleibt `unclear` — daraus wird keine Sicherheit erfunden.
 */
export type AccountingTaxTreatment =
  | 'standard_19'
  | 'standard_7'
  | 'kleinunternehmer_19'
  | 'reverse_charge_13b'
  | 'tax_free'
  | 'unclear';

export interface AccountingAssignment {
  id: string;
  sourceType: AccountingSourceType;
  /** `Expense.id` bzw. `VorgangInvoice.id` — die vorhandene stabile Kennung. */
  sourceId: string;
  /** Der Kontenrahmen, der **beim Kontieren** galt; eingefroren, nicht nachgezogen. */
  chartOfAccounts: ChartOfAccounts;
  /**
   * Das Sachkonto. Leer heisst „noch keins" — und genau das ist der
   * Normalfall, solange kein verifizierter Kontenkatalog vorliegt. Lieber kein
   * Konto als ein falsches.
   */
  accountNumber: string;
  accountLabel: string;
  taxTreatment: AccountingTaxTreatment;
  bookingText: string;
  /** Warum dieser Vorschlag — in Produktsprache, für den Nutzer lesbar. */
  suggestionReason?: string;
  status: AccountingAssignmentStatus;
  origin: AccountingAssignmentOrigin;
  suggestedAt?: string;
  confirmedAt?: string;
  /** Wer bestätigt hat, soweit ein Nutzerkontext vorliegt. */
  confirmedBy?: string;
  createdAt: string;
  updatedAt: string;
  sync?: SyncMeta;
}

/** Was der Vorschlagsdienst zurückgibt — noch keine Kontierung, nur ein Angebot. */
export interface AccountingSuggestion {
  accountNumber: string;
  accountLabel: string;
  taxTreatment: AccountingTaxTreatment;
  bookingText: string;
  /** In Produktsprache; erscheint als Begründung neben dem Vorschlag. */
  reason: string;
  /**
   * `needs_review` oder `needs_clarification` — **nie** `confirmed`. Der Typ
   * schliesst das aus, damit kein Aufrufer versehentlich eine bestätigte
   * Kontierung erzeugt.
   */
  status: Exclude<AccountingAssignmentStatus, 'confirmed'>;
}

/** Ein steuerlich relevanter Beleg mit seinem Kontierungsstand. */
export interface AccountingChecklistEntry {
  sourceType: AccountingSourceType;
  sourceId: string;
  belegnummer: string;
  datum: string;
  gegenpartei: string;
  brutto: number;
  /** `null`: für diesen Beleg wurde noch gar nichts angelegt. */
  status: AccountingAssignmentStatus | null;
  accountNumber: string;
  bookingText: string;
  /** Storniert oder Gutschrift — bleibt in der Liste, nie stillschweigend weg. */
  hinweis?: string;
}

export interface AccountingChecklist {
  monthKey: string;
  chartOfAccounts: ChartOfAccounts;
  totalRelevantDocuments: number;
  /*
   * 01H — die vier Zähler sind disjunkt und ergeben zusammen
   * `totalRelevantDocuments`.
   */
  confirmedCount: number;
  /** Kontierung vorhanden, aber noch nicht bestätigt — ohne die nicht kontierten. */
  needsReviewCount: number;
  needsClarificationCount: number;
  /** Belege ohne jede Kontierung. */
  unassignedCount: number;
  /** Alles, was noch nicht bestätigt ist. */
  openEntries: AccountingChecklistEntry[];
  confirmedEntries: AccountingChecklistEntry[];
}
