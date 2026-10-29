import type { ClassifiedDocumentKind, DigitalFolder, PaperFilingRule, PaymentMethod, TaxStatus } from './models';
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
 * P1-KORREKTURBLOCK A-04 — wie die Aufteilung in Netto und Steuer **belegt** ist.
 *
 *  - `belegt`   — Netto und Steuer stehen so auf dem Beleg (ein Steuersatz).
 *  - `gemischt` — Netto und Steuer stehen auf dem Beleg, als Summen über mehrere Steuersätze.
 *  - `offen`    — die Aufteilung ist nicht belegt. Netto und Steuer tragen dann Platzhalter (Netto = Brutto,
 *                 Steuer 0), weil der Serververtrag (`upsert_workspace_expense`) drei stimmige Beträge verlangt —
 *                 sie sind **keine Aussage über die Steuer**: Anzeige, Export, Buchung und Abschluss werten sie
 *                 als unbekannt.
 *
 * Bei einem Steuerstatus ohne Umsatzsteuer (steuerfrei, Kleinunternehmer, §13b) ist die Aufteilung durch den
 * Status selbst belegt (echte Nullsteuer). Fehlt das Feld (Altbestand vor A-04), gilt der gespeicherte Stand;
 * ein Altbeleg mit Regel- oder unklarem Steuerstatus, 0 € Steuer und Netto = Brutto wird nur lesend als
 * Prüfbedarf erkannt (`resolveExpenseTaxSplitState`), nie umgerechnet.
 */
export type ExpenseTaxSplit = 'belegt' | 'gemischt' | 'offen';

/**
 * P1-KORREKTURBLOCK A-04 — Vorsteuerabzug zur belegten Steuer. Fehlt das Feld, gilt wie bisher „voll“.
 * Nur bei belegter Steuer ungleich 0 von Bedeutung; bei `teilweise` steht der abziehbare Betrag in
 * `deductibleTaxAmount`.
 */
export type ExpenseInputTaxDeduction = 'voll' | 'teilweise' | 'keiner';

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
  /** 02B — optional; dieselbe Zahlungsart wie bei Rechnungszahlungen. */
  method?: PaymentMethod;
  /**
   * BARZAHLUNG-V1 BLOCK 1 — der Beleg, der **diese** Zahlung beweist.
   *
   * Die Kennung eines `CompanyDocument` aus dem Archiv, nie eine Kopie der
   * Datei: Das Original bleibt, wo es hingehört, und es entsteht keine
   * zweite Ablage.
   *
   * Bewusst an der Zahlung und nicht an der Ausgabe — sonst verschmelzen die
   * Nachweise zweier Teilzahlungen zu einem Haufen, und niemand kann mehr
   * sagen, welche Quittung zu welchem Geld gehört.
   *
   * Optional: Nicht jede Barzahlung hat sofort eine fotografierte Quittung.
   * Fehlt sie, ist sie schlicht nicht erfasst — daraus wird keine
   * steuerliche Aussage abgeleitet.
   */
  proofDocumentId?: string;
  createdAt: string;
  /**
   * FINANZ-CORE-01A (Gesamtnacharbeit INV-08) — der Nutzer hat diese Zahlung ausdrücklich als
   * Überzahlung bestätigt. Die Bestätigung reist mit an den Server (`p_overpayment_acknowledged`); ohne
   * sie weist der Server eine Zahlung über den offenen Betrag ab, auch für einen alten Client.
   */
  overpaymentAcknowledged?: boolean;
}

/**
 * FINANZ-CORE-01A (Restnacharbeit END18-R3) — eine Zahlung, die der Server endgültig abgewiesen hat und
 * die er nachweislich nicht kennt. Sie zählt nirgends (Saldo, offene Posten, Monatsmappe, Export,
 * Abschluss), bleibt aber als Nachweis sichtbar: keine stille Löschung, kein automatischer neuer Versuch.
 */
export interface RejectedExpensePayment extends ExpensePayment {
  /** Wann der Abgleich die Abweisung festgestellt hat. */
  rejectedAt: string;
  /** Die Serverbegründung des endgültig abgewiesenen Auftrags. */
  reason: string;
  /** Der Auftrag, der abgewiesen wurde (Nachweis im Sync-Protokoll). */
  outboxId: string;
}

/** Welche lokale Belegänderung der Server endgültig abgewiesen hat. */
export type RejectedExpenseChangeKind = 'update' | 'cancel' | 'delete' | 'create' | 'payment_reverse';

/**
 * FINANZ-CORE-01A (Restnacharbeit END18-R3) — eine lokale Belegänderung, die der Server endgültig
 * abgewiesen hat. Der Beleg trägt danach wieder den Serverstand; festgehalten wird, was versucht wurde.
 */
export interface RejectedExpenseChange {
  outboxId: string;
  kind: RejectedExpenseChangeKind;
  reason: string;
  rejectedAt: string;
  /** Die abgewiesenen Werte (nur Geld und Zustand), zur Anzeige. */
  attempted?: {
    grossAmount?: number;
    netAmount?: number;
    taxAmount?: number;
    status?: ExpenseStatus;
    deleted?: boolean;
  };
  /** Bei `payment_reverse`: die Zahlung, deren Rücknahme abgewiesen wurde. */
  paymentId?: string;
}

/**
 * FINANZ-CORE-01A (Bericht 20, END19-R1/R2) — eine endgültige Abweisung, die ein vollständiger Abzug ohne
 * sichtbare Wirkung geklärt hat: Der Server kannte die Zahlung bereits (angenommen, nur ein späterer Schritt
 * oder die Wiederholung wurde abgewiesen) oder es gab nichts zurückzunehmen (abgewiesene Rücknahme einer dem
 * Server unbekannten bzw. dort schon stornierten Zahlung). Mit `rejectedPayments`/`rejectedChanges` ist so jede
 * endgültige Abweisung nach dem Abgleich belegt; vorher sperrt sie den Monatsabschluss.
 */
export interface ReconciledExpenseRejection {
  outboxId: string;
  outcome: 'server_confirmed' | 'nothing_to_undo';
  reason: string;
  reconciledAt: string;
  paymentId?: string;
}

export interface ExpensePaymentInput {
  date: string;
  amount: number;
  reference?: string;
  note?: string;
  method?: PaymentMethod;
  /** BLOCK 1 — optionaler Zahlungsnachweis; siehe `ExpensePayment`. */
  proofDocumentId?: string;
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
  /**
   * BEREICH-7-V1 — die Auftragsposition, die aus **dieser** Zuordnung durch
   * Weiterberechnung entstanden ist.
   *
   * Bewusst ein eigenes Feld und keine Umdeutung von `orderPositionId`: Jenes
   * beantwortet „aus welcher Auftragsposition stammt diese Kostenzuordnung",
   * dieses „in welche Auftragsposition wurde sie weiterberechnet". Zwei
   * Bedeutungen in einem Feld lassen sich später nicht mehr auseinanderhalten.
   *
   * Der Marker lebt an der Zuordnung, weil sie das einzige Objekt ist, das
   * Beleg **und** Auftrag kennt — und weil sie über den vorhandenen
   * Expense-Payload bereits synchronisiert. Der Rechnungsentwurf käme nicht in
   * Frage: Er ist ausdrücklich geräte-lokal (`invoiceDraftDurabilityService`).
   */
  rebilledOrderPositionId?: string;
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
  /** A-04 — siehe `ExpenseTaxSplit`; fehlt bei Altbestand. */
  taxSplit?: ExpenseTaxSplit;
  /** A-04 — siehe `ExpenseInputTaxDeduction`; fehlt = voll abziehbar. */
  inputTaxDeduction?: ExpenseInputTaxDeduction;
  /** A-04 — abziehbare Vorsteuer bei `inputTaxDeduction = 'teilweise'` (Vorzeichen wie die Steuer). */
  deductibleTaxAmount?: number;
  currency: string;
  paymentStatus: ExpensePaymentStatus;
  payments?: ExpensePayment[];
  /** END18-R3 — endgültig abgewiesene, dem Server unbekannte Zahlungen; zählen nirgends. */
  rejectedPayments?: RejectedExpensePayment[];
  /** END18-R3 — endgültig abgewiesene Belegänderungen; der Beleg trägt den Serverstand. */
  rejectedChanges?: RejectedExpenseChange[];
  /** Bericht 20 — endgültige Abweisungen, die der Abgleich ohne sichtbare Wirkung geklärt hat (lokaler Nachweis). */
  reconciledRejections?: ReconciledExpenseRejection[];
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
  /** Angegeben heisst: vom Beleg. Fehlt ein Betrag, wird er nie aus einem Steuersatz geschätzt (A-04). */
  netAmount?: number;
  taxAmount?: number;
  grossAmount: number;
  /**
   * A-04 — die ausdrückliche Angabe zur Steueraufteilung. Fehlt sie und fehlen Netto und Steuer, ist die
   * Aufteilung bei einem Steuerstatus mit Umsatzsteuer oder `unclear` **offen** (nie „0 € Steuer“).
   */
  taxSplit?: ExpenseTaxSplit;
  inputTaxDeduction?: ExpenseInputTaxDeduction;
  deductibleTaxAmount?: number;
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
