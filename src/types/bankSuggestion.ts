/**
 * BANKABGLEICH-V1 BLOCK 3 — Zuordnungsvorschläge ohne Geldwirkung.
 *
 * Bewusst **nicht persistent**: Ein Vorschlag ist kein Vorgang, sondern eine
 * Beobachtung über den aktuellen Bestand. Er lässt sich jederzeit aus
 * Bankbewegung, Rechnungen und Ausgaben neu berechnen. Ihn zu speichern
 * hiesse, eine zweite Wahrheit zu führen, die bei der nächsten Zahlung
 * veraltet wäre — und es gäbe eine Tabelle, die aussieht, als sei hier schon
 * etwas zugeordnet.
 *
 * Ebenso bewusst **keine Prozentzahl**: „87 % sicher" hätte keine
 * statistische Grundlage. Stattdessen drei nachvollziehbare Stufen und die
 * Gründe im Klartext.
 */

/** Wie gut ein Kandidat passt — in der Sprache, die der Nutzer liest. */
export type BankSuggestionGrade = 'sehr_passend' | 'passend' | 'moeglich';

/**
 * Warum dieser Kandidat vorgeschlagen wird.
 *
 * Jeder Grund ist einzeln belegbar und wird dem Nutzer genannt — auch der
 * einschränkende (`amount_differs`). Ein Vorschlag ohne nennbaren Grund wäre
 * ein Ratespiel.
 */
export type BankSuggestionReason =
  | 'invoice_number_in_purpose'
  | 'amount_matches_open'
  /** FINANZ-CORE-01A (ZAH-04) — der Betrag gleicht die Rechnung fristgerecht mit Skonto aus. */
  | 'amount_matches_skonto'
  | 'counterparty_matches'
  | 'amount_differs'
  | 'date_before_document';

export interface BankSuggestionCandidate {
  targetType: 'invoice' | 'expense';
  targetId: string;
  /** Rechnungs- bzw. Belegnummer, soweit vorhanden. */
  documentNumber: string;
  /** Kunde bzw. Lieferant — was der Nutzer in der Liste wiedererkennt. */
  partyName: string;
  /** Der **offene** Betrag in Cent, nicht der Gesamtbetrag. */
  openCents: number;
  grade: BankSuggestionGrade;
  reasons: BankSuggestionReason[];
}

/**
 * Das Ergebnis für genau eine Bankbewegung.
 *
 * `ambiguous` ist der Kern des Blocks: Passen mehrere Kandidaten gleich gut,
 * darf keiner als der Treffer dargestellt werden.
 */
export interface BankSuggestionResult {
  bankTransactionId: string;
  /** Welche Welt überhaupt befragt wurde — Eingang sucht Rechnungen, Ausgang Ausgaben. */
  direction: 'incoming' | 'outgoing';
  candidates: BankSuggestionCandidate[];
  ambiguous: boolean;
  /**
   * FINANZ-CORE-01A (ZAH-03) — bereits erfasste, noch keiner Bewegung zugeordnete Zahlungen mit
   * genau diesem Betrag und nahem Datum. Sie werden zum Verknüpfen angeboten, nicht zum Buchen.
   */
  alreadyRecorded?: BankRecordedPaymentMatch[];
}

/** FINANZ-CORE-01A (ZAH-03) — eine schon erfasste Zahlung, die diese Bewegung sein könnte. */
export interface BankRecordedPaymentMatch {
  targetType: 'invoice' | 'expense';
  targetId: string;
  documentNumber: string;
  partyName: string;
  paymentId: string;
  /** Das Datum der erfassten Zahlung (`YYYY-MM-DD`). */
  paymentDate: string;
  amountCents: number;
}
