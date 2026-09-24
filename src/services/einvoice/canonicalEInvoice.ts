/**
 * E-RECHNUNG-04C — das formatneutrale Rechnungsmodell und sein Ergebnisvertrag.
 *
 * Zwischen dem eingefrorenen OfficeTakt-Beleg und einem späteren XML steht
 * genau eine Schicht. Sie beantwortet alle fachlichen Fragen — welche
 * Steuerkategorie, welcher Einheitencode, welche Belegart, ob überhaupt
 * exportierbar — und lässt dem Renderer in 04D nur noch das Serialisieren.
 *
 * Was hier **nicht** steht, ist ebenso wichtig: kein Logo, kein Layout, kein
 * Template, keine Seitenzahl, keine deutsche Überschrift, kein Namensraum und
 * kein XML-Code. Ein Renderer, der eigene Fachlogik braucht, wäre ein zweiter
 * Ort, an dem sich die Wahrheit ändern kann.
 *
 * Rein: keine Stores, keine Cloud, keine Uhr, kein Zufall.
 */
import type { InvoiceDocumentType } from '../../types/models';

/* ------------------------------------------------------------------ */
/* Belegart — semantisch, nie ein externer Codewert                    */
/* ------------------------------------------------------------------ */

/**
 * Die Belegarten, die OfficeTakt kennt, in formatneutraler Form.
 *
 * Der externe Dokumenttypcode (380, 381, 386 …) gehört in den Renderer und
 * bewusst nicht hierher: Er ist eine Eigenschaft des Zielformats, nicht des
 * Geschäftsvorfalls. Stünde er hier, zöge sich eine Formatentscheidung quer
 * durch die Fachlogik.
 */
export type CanonicalDocumentKind =
  | 'invoice'
  | 'partial_invoice'
  | 'prepayment_invoice_quantity'
  | 'prepayment_invoice_fixed'
  | 'final_invoice'
  | 'correction';

/**
 * Der Geschäftsvorfall, semantisch.
 *
 * XRechnung verlangt später eine Prozesskennung als URI. Der Nutzer soll
 * niemals einen URI eintippen, und OfficeTakt kennt heute genau einen Fall:
 * die gewöhnliche Rechnungsstellung. Der technische Wert entsteht deshalb erst
 * im Renderer aus diesem semantischen Wert.
 */
export type CanonicalBusinessProcess = 'standard_billing';

/* ------------------------------------------------------------------ */
/* Steuer                                                              */
/* ------------------------------------------------------------------ */

/**
 * Die Steuerkategorien, die aus den OfficeTakt-Steuerstatus **eindeutig**
 * folgen. Bewusst nur diese drei: Jede weitere Kategorie (Ausfuhr,
 * innergemeinschaftlich, nicht steuerbar) setzt einen Rechtsgrund voraus, den
 * der Beleg heute nicht trägt — siehe `einvoiceCodes.ts`.
 */
export type CanonicalTaxCategory =
  /** Regelsteuersatz. */
  | 'standard'
  /** Steuerschuldnerschaft des Leistungsempfängers. */
  | 'reverse_charge'
  /** Steuerbefreit — bei OfficeTakt ausschliesslich der Kleinunternehmer. */
  | 'exempt';

export interface CanonicalTaxBreakdown {
  category: CanonicalTaxCategory;
  /** Prozentsatz, wie im Beleg — nicht neu berechnet. */
  rate: number;
  taxableAmount: number;
  taxAmount: number;
  /**
   * Der Rechtsgrund im Klartext, wie er auf dem Beleg steht.
   *
   * Bei `standard` abwesend, sonst zwingend: Eine Rechnung ohne Steuer, die
   * nicht sagt warum, ist unvollständig — und der Text ist bereits Teil des
   * eingefrorenen Belegs (`legalNotices`), wird also nicht erfunden.
   */
  exemptionReason?: string;
}

/* ------------------------------------------------------------------ */
/* Beteiligte                                                          */
/* ------------------------------------------------------------------ */

export interface CanonicalAddress {
  street: string;
  zip: string;
  city: string;
  countryCode: string;
}

/**
 * Eine elektronische Adresse.
 *
 * Heute immer eine E-Mail. Das Feld trägt die Art trotzdem ausdrücklich, damit
 * der Renderer die Formatkennung daraus ableiten kann, ohne sie zu raten — und
 * damit eine spätere zweite Adressart nicht als stiller Bedeutungswechsel
 * eines Textfelds ankommt.
 */
export interface CanonicalElectronicAddress {
  scheme: 'email';
  value: string;
}

/**
 * Der Ansprechpartner des Rechnungsstellers.
 *
 * Alle drei Angaben sind Pflicht, nicht aus Vorsicht, sondern aus der Regel:
 * XRechnung verlangt die Gruppe "Seller contact" (BG-6) und darin
 * Ansprechpartner, Telefon und E-Mail (BR-DE-2 sowie BR-DE-5/6/7). Ohne sie
 * weist der offizielle Validator die Rechnung ab — geprüft, nicht vermutet.
 *
 * Alle drei liegen seit 04B eingefroren im Firmen-Snapshot; sie werden hier
 * gelesen und nie aus dem heutigen Profil nachgeladen.
 */
export interface CanonicalSellerContact {
  name: string;
  phone: string;
  email: string;
}

export interface CanonicalSeller {
  name: string;
  legalForm?: string;
  address: CanonicalAddress;
  electronicAddress: CanonicalElectronicAddress;
  contact: CanonicalSellerContact;
  /** Steuernummer; mindestens eine der beiden Kennungen muss dastehen. */
  taxNumber?: string;
  vatId?: string;
  registrationAuthority?: string;
  registrationNumber?: string;
}

export interface CanonicalBuyer {
  name: string;
  contactPerson?: string;
  address: CanonicalAddress;
  electronicAddress: CanonicalElectronicAddress;
  vatId?: string;
  /** Die Käuferreferenz dieses Belegs — nie aus Stammdaten nachgeladen. */
  buyerReference: string;
  /**
   * Die Leitweg-ID des Empfängers, sofern eingefroren.
   *
   * Reines Routing- und Auditdatum. Auch wenn sie denselben Wert wie die
   * Käuferreferenz trägt, bleibt `buyerReference` das Belegfeld — zwei Quellen
   * für dieselbe Aussage wären genau die Verwechslung, die 04B vermieden hat.
   */
  leitwegId?: string;
}

/* ------------------------------------------------------------------ */
/* Zahlung                                                             */
/* ------------------------------------------------------------------ */

export interface CanonicalPaymentTransfer {
  iban: string;
  bic?: string;
  accountHolder?: string;
}

export interface CanonicalPayment {
  /** Überweisung — der einzige Weg, den ein OfficeTakt-Beleg heute ausweist. */
  means: 'credit_transfer';
  transfer: CanonicalPaymentTransfer;
  dueDate?: string;
  termsText?: string;
  skontoText?: string;
  payableAmount: number;
}

/* ------------------------------------------------------------------ */
/* Zeilen und Summen                                                   */
/* ------------------------------------------------------------------ */

export interface CanonicalLine {
  /** Stabil und deterministisch — aus dem Beleg, nie neu erzeugt. */
  id: string;
  /** Fortlaufend ab 1, in der Reihenfolge des Belegs. */
  position: number;
  description: string;
  quantity: number;
  /** Die OfficeTakt-Einheit, wie sie auf dem Papier steht. */
  unit: string;
  /** Der standardisierte Code dazu. */
  unitCode: string;
  unitPrice: number;
  lineNetAmount: number;
  category: CanonicalTaxCategory;
  rate: number;
  /**
   * Die Zeile steht nicht im Beleg, sondern folgt zwingend aus ihm.
   *
   * Genau ein Fall: der Pauschalabschlag, der fachlich keine Positionen führt,
   * für den eine strukturierte Rechnung aber mindestens eine Zeile braucht.
   */
  synthetic?: true;
}

export interface CanonicalTotals {
  lineNetTotal: number;
  taxExclusiveAmount: number;
  taxAmount: number;
  taxInclusiveAmount: number;
  /**
   * Bereits abgerechnete Abschläge dieses Auftrags.
   *
   * Ausdrücklich **nicht** „bereits bezahlt": Die Liste entsteht aus
   * `getPreviousAbschlagDeductions` und filtert auf nicht stornierte
   * Abschlagsrechnungen — über deren Bezahlung sagt sie nichts. Sie steht hier,
   * damit die Information nicht verlorengeht; wie sie in einem Zielformat
   * auszudrücken ist, ist in 04C bewusst noch offen (siehe
   * `final_invoice_deduction_semantics_unsupported`).
   */
  billedPrepayments: CanonicalPrepaymentReference[];
  payableAmount: number;
}

export interface CanonicalPrepaymentReference {
  invoiceId: string;
  invoiceNumber: string;
  date: string;
  netAmount: number;
  grossAmount: number;
}

/* ------------------------------------------------------------------ */
/* Referenzen                                                          */
/* ------------------------------------------------------------------ */

export interface CanonicalCorrectionReference {
  originalInvoiceId: string;
  originalInvoiceNumber: string;
  originalIssueDate: string;
  reason: string;
}

export interface CanonicalReferences {
  /** Auftragsnummer — nur, wenn sie im Beleg eingefroren ist. */
  orderReference?: string;
  /** Vorangegangene Rechnungen dieses Auftrags, soweit eingefroren. */
  precedingInvoiceNumbers: string[];
  correction?: CanonicalCorrectionReference;
}

/* ------------------------------------------------------------------ */
/* Das Modell                                                          */
/* ------------------------------------------------------------------ */

export interface CanonicalServicePeriod {
  from: string;
  to: string;
}

export interface CanonicalEInvoice {
  sourceInvoiceId: string;
  sourceInvoiceNumber: string;
  sourceInvoiceType: InvoiceDocumentType;
  documentKind: CanonicalDocumentKind;
  businessProcess: CanonicalBusinessProcess;
  currencyCode: string;
  issueDate: string;
  servicePeriod?: CanonicalServicePeriod;
  seller: CanonicalSeller;
  buyer: CanonicalBuyer;
  payment: CanonicalPayment;
  lines: CanonicalLine[];
  tax: CanonicalTaxBreakdown[];
  totals: CanonicalTotals;
  references: CanonicalReferences;
}

/* ------------------------------------------------------------------ */
/* Befunde                                                             */
/* ------------------------------------------------------------------ */

/**
 * Die stabilen Befunde des Builders.
 *
 * Sie sind technische Kennungen, keine Meldungen: Eine Oberfläche übersetzt
 * sie, ein Test prüft sie, ein Protokoll speichert sie. Ein freier deutscher
 * Text als einzige Schnittstelle wäre in allen drei Fällen unbrauchbar.
 */
export type CanonicalEInvoiceIssueCode =
  /* Herkunft */
  | 'source_not_finalized'
  | 'internal_cancellation_not_exportable'
  /* Beleg */
  | 'invoice_number_missing'
  | 'issue_date_missing'
  | 'currency_missing'
  | 'no_invoice_lines'
  | 'money_inconsistent'
  /* Verkäufer */
  | 'seller_snapshot_missing'
  | 'seller_name_missing'
  | 'seller_address_incomplete'
  | 'seller_country_missing'
  | 'seller_electronic_address_missing'
  // XRechnung BR-DE-2 / BR-DE-5/6/7 — Ansprechpartner, Telefon, E-Mail.
  | 'seller_contact_missing'
  | 'seller_tax_identity_missing'
  | 'payment_iban_missing'
  /* Käufer */
  | 'buyer_snapshot_missing'
  | 'buyer_name_missing'
  | 'buyer_address_incomplete'
  | 'buyer_country_missing'
  | 'buyer_electronic_address_missing'
  | 'buyer_reference_missing'
  | 'buyer_vat_id_missing_for_reverse_charge'
  /* Steuer */
  | 'tax_status_unclear'
  | 'tax_status_unsupported'
  | 'tax_exemption_reason_missing'
  /* Positionen */
  | 'unit_code_unknown'
  | 'line_description_missing'
  | 'fixed_amount_net_invalid'
  /* Noch nicht sicher abbildbar */
  | 'final_invoice_deduction_semantics_unsupported';

export interface CanonicalEInvoiceIssue {
  code: CanonicalEInvoiceIssueCode;
  /** Wo im Beleg — Punktpfad, stabil und maschinenlesbar. */
  path: string;
  /**
   * `error` verhindert den Export. Andere Stufen gibt es bewusst noch nicht:
   * Ein „Hinweis", der nichts verhindert, würde in 04C nur suggerieren, es sei
   * etwas geprüft worden. Das Feld steht trotzdem, damit eine spätere Stufe
   * kein Vertragsbruch ist.
   */
  severity: 'error';
}

export type CanonicalEInvoiceResult =
  | { ok: true; value: CanonicalEInvoice }
  | { ok: false; issues: CanonicalEInvoiceIssue[] };
