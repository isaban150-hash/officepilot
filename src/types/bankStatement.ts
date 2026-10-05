/**
 * BANKABGLEICH-V1 BLOCK 1 — das Vorschaumodell eines eingelesenen Kontoauszugs.
 *
 * Bewusst **nicht persistent**: Block 1 liest eine Datei, zeigt sie und
 * vergisst sie wieder. Es gibt deshalb hier keine `sync`-Meta, keine
 * Workspace-Kennung und keinen Abgleichstatus — all das gehört zu Block 2 und
 * später, und ein Feld, das heute niemand füllt, wäre ein Versprechen, das der
 * Code nicht hält.
 *
 * Was hier dagegen schon richtig stehen muss, ist die **Kontofähigkeit**: Eine
 * Bewegung gehört immer zu genau einem Bankkonto. Block 1 verwaltet keine
 * Konten, aber `BankStatementPreview` trägt die Herkunft als Datei, nicht als
 * stillschweigend einziges Konto — so kann Block 2 Konten einführen, ohne dass
 * irgendwo die Annahme „es gibt nur eines" herausgebrochen werden muss.
 */

/** Warum eine Zeile nicht übernommen werden konnte — je Zeile genau ein Grund. */
export type BankStatementRowProblem =
  | 'date_unreadable'
  | 'amount_unreadable'
  | 'column_count_mismatch'
  | 'row_empty';

/** Warum eine ganze Datei nicht gelesen werden konnte. */
export type BankStatementFileProblem =
  | 'file_unreadable'
  | 'encoding_unsupported'
  | 'no_header'
  | 'no_delimiter'
  | 'missing_required_column'
  | 'no_rows';

/**
 * Eine verstandene Bankbewegung aus der Vorschau.
 *
 * `amountCents` ist vorzeichenbehaftet: positiv ist Eingang, negativ ist
 * Ausgang. Eine getrennte Richtungsangabe gäbe es zweimal zu pflegen und
 * könnte dem Betrag widersprechen.
 */
export interface BankStatementRow {
  /** Stabil **innerhalb dieser Vorschau** — keine fachliche Kennung. */
  id: string;
  /** 1-basiert, wie der Nutzer die Datei im Tabellenprogramm sieht. */
  rowNumber: number;
  bookingDate: string;
  valueDate?: string;
  amountCents: number;
  currency?: string;
  counterparty?: string;
  counterpartyIban?: string;
  purpose?: string;
  bankReference?: string;
  /**
   * Diese Bewegung sieht einer anderen in **derselben Datei** zum Verwechseln
   * ähnlich. Kein Fehler und kein Grund zum Entfernen — nur ein Hinweis.
   */
  possibleDuplicate?: boolean;
}

/** Eine Zeile, die nicht übernommen wurde — mit Grund und Rohtext zum Wiedererkennen. */
export interface BankStatementRowIssue {
  rowNumber: number;
  problem: BankStatementRowProblem;
  /** Gekürzter Rohtext, damit der Nutzer die Zeile in seiner Datei findet. */
  excerpt: string;
}

/** Welche Spalte die Erkennung wo gefunden hat — für die sichtbare Zusammenfassung. */
export interface BankStatementColumnMapping {
  bookingDate: string;
  /** BLOCK 2 — die Spalte des **eigenen** Kontos, falls die Bank sie mitgibt. */
  ownAccount?: string;
  valueDate?: string;
  amount?: string;
  debit?: string;
  credit?: string;
  counterparty?: string;
  counterpartyIban?: string;
  purpose?: string;
  bankReference?: string;
}

export interface BankStatementPreview {
  fileName: string;
  /**
   * BLOCK 2 — das eigene Konto laut Datei, sonst leer.
   *
   * Geht in die Eindeutigkeit ein, damit dieselbe Bewegung auf zwei Konten
   * nicht als dieselbe gilt.
   */
  accountKey: string;
  /** Das erkannte Trennzeichen — sichtbar, damit eine Fehldeutung auffällt. */
  delimiter: ';' | ',';
  columns: BankStatementColumnMapping;
  rows: BankStatementRow[];
  issues: BankStatementRowIssue[];
  duplicateCount: number;
}

export type BankStatementParseResult =
  | { ok: true; preview: BankStatementPreview }
  | { ok: false; problem: BankStatementFileProblem; detail?: string };
