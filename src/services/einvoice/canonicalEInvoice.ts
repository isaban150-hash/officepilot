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

/**
 * FINANZ-CORE-01A (AUS-18) — das Zielprofil, für das der Builder prüft.
 *
 * `xrechnung` verlangt zusätzlich zu EN 16931 die Angaben der deutschen CIUS:
 * Käuferreferenz (BR-DE-15), Ansprechpartner mit Telefon und E-Mail (BR-DE-2,
 * BR-DE-5/6/7) und beide elektronischen Adressen (XRechnung 3.0). `en16931`
 * (ZUGFeRD, Profil EN 16931) verlangt sie nicht. Bisher erbte ZUGFeRD diese
 * Pflichten: Ein Betrieb ohne Käuferreferenz oder Ansprechpartner bekam kein
 * ZUGFeRD, obwohl die Norm es zulässt. Was der Beleg trägt, steht in beiden
 * Profilen im Dokument; das Profil entscheidet nur, was fehlen darf.
 */
export type CanonicalEInvoiceProfile = 'xrechnung' | 'en16931';

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
 * Für die XRechnung sind alle drei Angaben Pflicht, nicht aus Vorsicht, sondern
 * aus der Regel: XRechnung verlangt die Gruppe "Seller contact" (BG-6) und darin
 * Ansprechpartner, Telefon und E-Mail (BR-DE-2 sowie BR-DE-5/6/7). Ohne sie
 * weist der offizielle Validator die Rechnung ab — geprüft, nicht vermutet.
 *
 * FINANZ-CORE-01A (AUS-18) — EN 16931 (ZUGFeRD) kennt diese Pflicht nicht; im
 * Profil `en16931` steht nur, was der Beleg trägt. Im Profil `xrechnung`
 * garantiert der Builder alle drei Angaben.
 *
 * Alle drei liegen seit 04B eingefroren im Firmen-Snapshot; sie werden hier
 * gelesen und nie aus dem heutigen Profil nachgeladen.
 */
export interface CanonicalSellerContact {
  name?: string;
  phone?: string;
  email?: string;
}

export interface CanonicalSeller {
  name: string;
  legalForm?: string;
  address: CanonicalAddress;
  /** Im Profil `xrechnung` immer vorhanden (BT-34), in `en16931` optional. */
  electronicAddress?: CanonicalElectronicAddress;
  /** Im Profil `xrechnung` immer vollständig (BG-6), in `en16931` optional. */
  contact?: CanonicalSellerContact;
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
  /** Im Profil `xrechnung` immer vorhanden (BT-49), in `en16931` optional. */
  electronicAddress?: CanonicalElectronicAddress;
  vatId?: string;
  /**
   * Die Käuferreferenz dieses Belegs (BT-10) — nie aus Stammdaten nachgeladen.
   * FINANZ-CORE-01A (KUN-07): Trägt der Beleg eine Leitweg-ID, ist sie BT-10; eine
   * davon abweichende Käuferreferenz steht als Belegnotiz.
   * FINANZ-CORE-01A (AUS-18): im Profil `xrechnung` Pflicht (BR-DE-15), in `en16931` optional.
   */
  buyerReference?: string;
  /** Die Leitweg-ID des Empfängers, sofern eingefroren (dann zugleich BT-10). */
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
  /**
   * Überweisung — der Weg jeder OfficeTakt-Rechnung. FINANZ-CORE-01A (STO-09/AUS-08):
   * `settlement` ist die Verrechnung einer Korrektur (Gutschrift 381). Storniert wird
   * nur ohne Zahlungseingang; es fließt kein Geld, also gibt es kein Konto.
   */
  means: 'credit_transfer' | 'settlement';
  transfer?: CanonicalPaymentTransfer;
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
   * Die Abschläge, die diese Schlussrechnung abzieht.
   *
   * Die Liste entsteht aus `getPreviousAbschlagDeductions` (nicht stornierte
   * Pauschalabschläge) und sagt für sich nichts über deren Bezahlung.
   *
   * FINANZ-CORE-01A (WEISS-Nacharbeit N02/D1) — BT-113 ist der **bereits gezahlte**
   * Betrag. Eine E-Rechnung entsteht deshalb nur, wenn jeder abgezogene Abschlag
   * beglichen ist (`prepaymentSettlements` des Builders, sonst Befund
   * `prepayment_not_settled`). Beglichen heisst: voll bezahlt oder fristgerecht mit
   * dem Skonto des Abschlags; Zahlung und Skonto stehen je Abschlag hier und in der
   * Belegnotiz. Seit N02 lässt die Freigabe ohnehin nur beglichene Abschläge zu.
   */
  billedPrepayments: CanonicalPrepaymentReference[];
  /**
   * BT-113 — was auf die abgezogenen Abschläge tatsächlich gezahlt wurde (brutto); 0 ohne
   * Abzug. WEISS-Recheck N02-R1: Ein mit Skonto beglichener Abschlag zählt hier nur mit
   * dem gezahlten Teil; das Skonto steht als Nachlass (`allowances`).
   */
  prepaidAmount: number;
  /** BT-107 — Summe der Nachlässe auf Belegebene (netto); nur mit Nachlass gesetzt. */
  allowanceTotal?: number;
  /** BT-114 — Rundungsbetrag; nur gesetzt, wenn nicht 0. */
  roundingAmount?: number;
  payableAmount: number;
}

/**
 * FINANZ-CORE-01A (WEISS-Recheck N02-R1) — ein Nachlass auf Belegebene (BG-20): das Skonto,
 * mit dem ein abgezogener Abschlag beglichen wurde. Eine Entgeltminderung (§ 17 UStG), keine
 * Zahlung — sie mindert Bemessungsgrundlage (BT-109) und Steuer (BT-110) der Schlussrechnung.
 */
export interface CanonicalAllowance {
  /** BT-92, netto. */
  amount: number;
  /** BT-97 */
  reason: string;
  /** BT-98 (UNTDID 5189); 95 = Rabatt/Nachlass. */
  reasonCode: string;
  /** BT-95/BT-96 — die Steuerkategorie des Belegs. */
  category: CanonicalTaxCategory;
  rate: number;
}

export interface CanonicalPrepaymentReference {
  invoiceId: string;
  invoiceNumber: string;
  date: string;
  netAmount: number;
  grossAmount: number;
  /** FINANZ-CORE-01A (N02) — tatsächlich auf den Abschlag gezahlt (höchstens `grossAmount`). */
  paidAmount: number;
  /** FINANZ-CORE-01A (N02) — mit dem Skonto des Abschlags gewährt; 0 ohne Skonto. */
  skontoAmount: number;
}

/**
 * FINANZ-CORE-01A (WEISS-Nacharbeit N02/D1) — wie ein abgezogener Abschlag beglichen
 * ist. Der Builder bleibt rein: Zahlungen kennt er nicht selbst, der Aufrufer reicht
 * sie herein (`resolveAbschlagSettlements`).
 */
export interface CanonicalPrepaymentSettlement {
  invoiceId: string;
  /** Tatsächlich gezahlt, höchstens der Abschlagsbetrag. */
  paid: number;
  /** Mit dem Skonto des Abschlags gewährt — nur bei einem beglichenen Abschlag. */
  skonto: number;
  settled: boolean;
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
  /**
   * BT-1. FINANZ-CORE-01A (STO-09/AUS-08) — bei einer Korrektur ihre eigene Nummer
   * aus dem Rechnungskreis, nie die des Originals (das steht in BT-25).
   */
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
  /** FINANZ-CORE-01A (WEISS-Recheck N02-R1) — Nachlässe auf Belegebene (Skonto auf Abschläge). */
  allowances?: CanonicalAllowance[];
  totals: CanonicalTotals;
  references: CanonicalReferences;
  /**
   * FINANZ-CORE-01A — Belegnotizen (BT-22) ohne Themencode: der Bezug der Korrektur
   * und die abgezogenen Abschläge der Schlussrechnung, so wie das PDF sie nennt.
   */
  notes: string[];
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
  /**
   * FINANZ-CORE-01A (AUS-08) — eine stornierte Rechnung bekommt keine neue
   * E-Rechnung als Rechnung mehr; ihre Korrektur entsteht über die Variante
   * `correction`. Eine früher abgelegte Datei bleibt lesbar.
   */
  | 'cancelled_original_not_exportable'
  /** FINANZ-CORE-01A (SQL-11) — eine Korrektur ohne eigene Nummer (Altbestand) ist nicht exportierbar. */
  | 'correction_number_missing'
  | 'correction_not_available'
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
  /**
   * FINANZ-CORE-01A (AUS-03) — EN 16931 BR-CO-26: Der Verkäufer braucht eine
   * Kennung (BT-29), eine Registernummer (BT-30) oder eine USt-IdNr. (BT-31).
   * Die Steuernummer (BT-32) allein genügt nicht.
   */
  | 'seller_identifier_missing'
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
  /**
   * FINANZ-CORE-01A (WEISS-Nacharbeit N02/D1) — ein abgezogener Abschlag ist nicht
   * (voll) beglichen. BT-113 ist der bereits gezahlte Betrag; ein unbezahlter
   * Abschlag darf dort nicht stehen.
   */
  | 'prepayment_not_settled'
  /** WEISS-Recheck N02-R1 — Skonto auf einem Abschlag, aber die Aufteilung ist nicht eingefroren (Altbeleg). */
  | 'prepayment_skonto_unfrozen'
  /**
   * FC01A-P1-Restkorrektur (#8, Altformat) — Netto und Steuer eines abgezogenen Abschlags stehen
   * nicht fest (umsatzsteuerpflichtiger Altabschlag ohne gespeichertes Netto oder widersprüchliche
   * Angaben). Brutto wird nie als Netto ausgegeben.
   */
  | 'prepayment_net_unreliable'
  /**
   * FC01A-P1-Restkorrektur (lokaler Altbestand) — das Netto der Rechnung selbst steht nicht fest
   * (`resolveInvoiceNet`): fehlt und lässt sich aus eingefrorenen Angaben nicht ermitteln, oder
   * widerspricht dem Betrag. Das Brutto wird nie als Netto ausgegeben.
   */
  | 'net_unresolved'
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
