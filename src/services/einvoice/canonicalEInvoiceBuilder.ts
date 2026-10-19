/**
 * E-RECHNUNG-04C — der Bauweg vom eingefrorenen Beleg zum Canonical-Modell.
 *
 * Eine einzige Regel trägt diese Datei: **Es gibt genau eine Quelle, und das
 * ist die freigegebene Rechnung.** Kein Kundenstamm, kein Firmenprofil, kein
 * Auftrag, keine Uhr. Fehlt eine Pflichtangabe, wird sie nicht nachgeladen,
 * nicht abgeleitet und nicht geraten — der Bau schlägt mit einem benennbaren
 * Befund fehl.
 *
 * Der Grund ist nicht Formalismus. Eine Rechnung aus dem letzten Jahr mit den
 * Kundendaten von heute wäre kein historischer Beleg mehr, sondern eine
 * Rekonstruktion, die niemand als solche erkennt. 04B hat die Daten deshalb
 * eingefroren; 04C darf diese Arbeit nicht wieder aufweichen.
 *
 * Ebenso gilt: **keine zweite Geldlogik.** Die Beträge stammen aus dem Beleg.
 * Gerechnet wird hier nur, um zu **prüfen**, ob der Beleg in sich stimmt —
 * und wenn nicht, bricht der Bau ab, statt still zu korrigieren.
 *
 * Rein: keine Stores, keine Cloud, kein Zufall, kein `Date.now()`.
 */
import type { CompanyProfile, CustomerBilling, VorgangInvoice } from '../../types/models';
import { formatCompanyLegalName } from '../company/companyLegalName';
import { isFixedAmountAbschlag } from '../invoiceCalculationMode';
import { billingLineTotalCents, fromCents, isValidMoneyNumber, taxCentsFromNet, toCents } from '../invoiceMoney';
import { resolveDocumentKind, resolveTaxCategory, resolveUnitCode } from './einvoiceCodes';
import { normalizeCountryCode } from './einvoiceStandards';
import { toBusinessDay } from '../businessDateService';
import { PRIVATE_RETENTION_NOTICE, hasPrivateRetentionNotice } from '../invoiceTaxService';
import { frozenSettlementShare, splitAbschlagDeductions } from '../invoice/abschlagSkontoSplit';
import { resolveInvoiceNet } from '../invoice/invoiceNetResolution';
import type {
  CanonicalAddress,
  CanonicalAllowance,
  CanonicalBuyer,
  CanonicalDocumentKind,
  CanonicalEInvoice,
  CanonicalEInvoiceIssue,
  CanonicalEInvoiceIssueCode,
  CanonicalEInvoiceProfile,
  CanonicalEInvoiceResult,
  CanonicalLine,
  CanonicalPrepaymentReference,
  CanonicalPrepaymentSettlement,
  CanonicalSeller,
  CanonicalSellerContact,
  CanonicalTaxBreakdown,
  CanonicalTaxCategory,
} from './canonicalEInvoice';

/** Sammelt Befunde in Reihenfolge ihres Auftretens — deterministisch. */
class IssueLog {
  private readonly items: CanonicalEInvoiceIssue[] = [];

  add(code: CanonicalEInvoiceIssueCode, path: string): void {
    this.items.push({ code, path, severity: 'error' });
  }

  get empty(): boolean {
    return this.items.length === 0;
  }

  get all(): CanonicalEInvoiceIssue[] {
    return this.items;
  }
}

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

/**
 * Der Rechtsgrund zum Steuerstatus, wie er auf dem Beleg steht.
 *
 * Ausschliesslich aus `legalNotices` des eingefrorenen Belegs. Ihn aus dem
 * heutigen Firmenprofil nachzuladen wäre derselbe Fehler wie bei den
 * Stammdaten: Der Betrieb kann den Text längst geändert haben.
 */
function frozenExemptionReason(invoice: VorgangInvoice): string {
  /*
   * FINANZ-CORE-01A (AUS-11/EIN-07) — der Hinweis auf die Aufbewahrungspflicht des privaten
   * Empfängers ist kein Grund der Steuerbefreiung (BT-120) und darf einen fehlenden Grund nicht
   * ersetzen. Er steht als Belegnotiz (BT-22), siehe unten.
   */
  return (invoice.legalNotices ?? [])
    .map(text)
    .filter((entry) => entry && entry !== PRIVATE_RETENTION_NOTICE)
    .join(' ');
}

/* ------------------------------------------------------------------ */
/* Beteiligte                                                          */
/* ------------------------------------------------------------------ */

function buildAddress(
  source: { street?: string; zip?: string; city?: string; countryCode?: string; country?: string },
  pathPrefix: string,
  missingAddress: CanonicalEInvoiceIssueCode,
  missingCountry: CanonicalEInvoiceIssueCode,
  issues: IssueLog,
): CanonicalAddress | null {
  const street = text(source.street);
  const zip = text(source.zip);
  const city = text(source.city);
  if (!street || !zip || !city) {
    issues.add(missingAddress, `${pathPrefix}.address`);
  }
  /*
   * Der Ländercode kommt aus dem eingefrorenen Feld oder aus dem ebenfalls
   * eingefrorenen Freitext derselben Anschrift — beides steht im Beleg. Was
   * sich daraus nicht auflösen lässt, fehlt; ein Rückfall auf „DE" wäre eine
   * Behauptung über den Empfänger.
   */
  const countryCode = normalizeCountryCode(source.countryCode) ?? normalizeCountryCode(source.country);
  if (!countryCode) {
    issues.add(missingCountry, `${pathPrefix}.address.countryCode`);
  }
  if (!street || !zip || !city || !countryCode) return null;
  return { street, zip, city, countryCode };
}

function buildSeller(
  snapshot: CompanyProfile | undefined,
  profile: CanonicalEInvoiceProfile,
  issues: IssueLog,
): CanonicalSeller | null {
  if (!snapshot) {
    issues.add('seller_snapshot_missing', 'companySnapshot');
    return null;
  }
  /*
   * FINANZ-CORE-01A (AUS-06) — BT-27 trägt den Namen so, wie der Beleg ihn druckt:
   * Firmenname und Rechtsform. Bisher stand die Rechtsform nur im eigenen Feld, das kein
   * Renderer schrieb — XML und PDF wichen voneinander ab. WEISS-Nacharbeit N14: über
   * `formatCompanyLegalName`, ohne doppelte Rechtsform — dieselbe Regel wie PDF und Mail.
   */
  const companyName = text(snapshot.companyName);
  if (!companyName) issues.add('seller_name_missing', 'companySnapshot.companyName');
  // FINANZ-CORE-01A (WEISS-Nacharbeit N14) — Firmierung ohne doppelte Rechtsform.
  const name = formatCompanyLegalName(companyName, text(snapshot.legalForm));

  const address = buildAddress(
    snapshot,
    'companySnapshot',
    'seller_address_incomplete',
    'seller_country_missing',
    issues,
  );

  /*
   * FINANZ-CORE-01A (AUS-18) — die elektronische Adresse (BT-34) verlangt nur die
   * XRechnung (3.0), EN 16931 nicht.
   */
  const strict = profile === 'xrechnung';
  const email = text(snapshot.email);
  if (!email && strict) issues.add('seller_electronic_address_missing', 'companySnapshot.email');

  /*
   * Eine der beiden Steuerkennungen genügt: Ein Kleinbetrieb führt oft nur
   * eine Steuernummer, ein umsatzsteuerpflichtiger Betrieb eine USt-IdNr.
   * Beide zu verlangen hiesse, gültige Betriebe auszuschliessen.
   */
  const taxNumber = text(snapshot.taxNumber);
  const vatId = text(snapshot.vatId);
  if (!taxNumber && !vatId) {
    issues.add('seller_tax_identity_missing', 'companySnapshot.taxNumber');
  } else if (!vatId && !text(snapshot.registrationNumber)) {
    /*
     * FINANZ-CORE-01A (AUS-03) — EN 16931 BR-CO-26: Ohne USt-IdNr. (BT-31) und
     * ohne Registernummer (BT-30) hat der Verkäufer keine Kennung, an der ihn
     * der Empfänger maschinell erkennt; die Steuernummer (BT-32) zählt dafür
     * nicht. Die Datei würde am Validator scheitern — bisher meldete die App
     * trotzdem „Interne Prüfung bestanden". Die PDF-Rechnung bleibt unberührt.
     */
    issues.add('seller_identifier_missing', 'companySnapshot.vatId');
  }

  /*
   * Der Ansprechpartner ist für eine XRechnung Pflicht (BR-DE-2, BR-DE-5/6/7) —
   * für eine gewöhnliche PDF-Rechnung nicht. Auch hier gilt: Der Betrieb soll
   * weiter Rechnungen schreiben können, ohne die E-Rechnung nutzen zu müssen.
   * FINANZ-CORE-01A (AUS-18) — EN 16931 (ZUGFeRD) verlangt ihn nicht.
   */
  const contactName = text(snapshot.contactPerson);
  const contactPhone = text(snapshot.phone);
  if (strict && (!contactName || !contactPhone || !email)) {
    issues.add('seller_contact_missing', 'companySnapshot.contactPerson');
  }

  if (!companyName || !address || (!taxNumber && !vatId)) return null;
  if (strict && (!email || !contactName || !contactPhone)) return null;

  const seller: CanonicalSeller = { name, address };
  if (email) seller.electronicAddress = { scheme: 'email', value: email };
  /*
   * Ohne Profilpflicht steht der Kontakt (BG-6) nur, wenn es einen Ansprechpartner
   * oder eine Telefonnummer gibt — die E-Mail allein ist schon die elektronische
   * Adresse. Was fehlt, bleibt weg; nichts wird aus anderen Feldern ergänzt.
   */
  if (contactName || contactPhone) {
    const contact: CanonicalSellerContact = {};
    if (contactName) contact.name = contactName;
    if (contactPhone) contact.phone = contactPhone;
    if (email) contact.email = email;
    seller.contact = contact;
  }
  const legalForm = text(snapshot.legalForm);
  if (legalForm) seller.legalForm = legalForm;
  if (taxNumber) seller.taxNumber = taxNumber;
  if (vatId) seller.vatId = vatId;
  const registrationAuthority = text(snapshot.registrationAuthority);
  if (registrationAuthority) seller.registrationAuthority = registrationAuthority;
  const registrationNumber = text(snapshot.registrationNumber);
  if (registrationNumber) seller.registrationNumber = registrationNumber;
  return seller;
}

function buildBuyer(
  snapshot: CustomerBilling | undefined,
  requiresVatId: boolean,
  profile: CanonicalEInvoiceProfile,
  issues: IssueLog,
): CanonicalBuyer | null {
  if (!snapshot) {
    issues.add('buyer_snapshot_missing', 'customerSnapshot');
    return null;
  }
  const name = text(snapshot.name);
  if (!name) issues.add('buyer_name_missing', 'customerSnapshot.name');

  const address = buildAddress(
    snapshot,
    'customerSnapshot',
    'buyer_address_incomplete',
    'buyer_country_missing',
    issues,
  );

  // FINANZ-CORE-01A (AUS-18) — BT-49 verlangt nur die XRechnung (3.0), EN 16931 nicht.
  const strict = profile === 'xrechnung';
  const email = text(snapshot.email);
  if (!email && strict) issues.add('buyer_electronic_address_missing', 'customerSnapshot.email');

  /*
   * Die Käuferreferenz ist für eine gewöhnliche PDF-Rechnung freiwillig und
   * bleibt es — 04B hat sie bewusst nicht zur Freigabebedingung gemacht. Für
   * eine strukturierte Rechnung ist sie Pflicht. Der Unterschied ist Absicht:
   * Der Betrieb soll weiter Rechnungen schreiben können, auch wenn er nie eine
   * E-Rechnung braucht.
   */
  /*
   * FINANZ-CORE-01A (KUN-07) — bei einem öffentlichen Auftraggeber ist die Leitweg-ID
   * die Käuferreferenz (BT-10): Über sie leiten die Rechnungseingangsplattformen den
   * Beleg weiter. Bisher stand sie nie im XML, und BT-10 konnte eine andere Referenz
   * tragen — die Rechnung lief ins Leere. Eine davon abweichende Käuferreferenz geht
   * nicht verloren: Sie steht als Belegnotiz im Dokument (siehe \`buyerReferenceNote\`).
   */
  const leitwegIdForReference = text(snapshot.leitwegId);
  const buyerReference = leitwegIdForReference || text(snapshot.buyerReference);
  // FINANZ-CORE-01A (AUS-18) — Pflicht nur für die XRechnung (BR-DE-15); in EN 16931 optional.
  if (!buyerReference && strict) issues.add('buyer_reference_missing', 'customerSnapshot.buyerReference');

  const vatId = text(snapshot.vatId);
  if (requiresVatId && !vatId) {
    issues.add('buyer_vat_id_missing_for_reverse_charge', 'customerSnapshot.vatId');
  }

  if (!name || !address || (requiresVatId && !vatId)) return null;
  if (strict && (!email || !buyerReference)) return null;

  const buyer: CanonicalBuyer = { name, address };
  if (email) buyer.electronicAddress = { scheme: 'email', value: email };
  if (buyerReference) buyer.buyerReference = buyerReference;
  const contactPerson = text(snapshot.contactPerson);
  if (contactPerson) buyer.contactPerson = contactPerson;
  if (vatId) buyer.vatId = vatId;
  const leitwegId = text(snapshot.leitwegId);
  if (leitwegId) buyer.leitwegId = leitwegId;
  return buyer;
}

/* ------------------------------------------------------------------ */
/* Zeilen                                                              */
/* ------------------------------------------------------------------ */

/** Die Beschreibung einer Pauschalabschlagszeile — stabil, nicht nachgeladen. */
export const FIXED_AMOUNT_LINE_DESCRIPTION = 'Abschlag (Pauschale)';

function buildLines(
  invoice: VorgangInvoice,
  category: CanonicalTaxCategory,
  rate: number,
  issues: IssueLog,
): CanonicalLine[] | null {
  /*
   * Der Pauschalabschlag führt fachlich keine Positionen; sein Betrag steht in
   * `fixedAmountNet`. Eine strukturierte Rechnung braucht mindestens eine
   * Zeile, deshalb entsteht hier genau eine — deterministisch, ausschliesslich
   * aus dem Beleg, und als `synthetic` gekennzeichnet, damit ein Leser sie nie
   * für eine erfasste Leistung hält.
   */
  if (isFixedAmountAbschlag(invoice)) {
    const net = invoice.fixedAmountNet;
    if (typeof net !== 'number' || !Number.isFinite(net) || net <= 0) {
      issues.add('fixed_amount_net_invalid', 'fixedAmountNet');
      return null;
    }
    const amount = fromCents(toCents(net));
    return [
      {
        id: `${invoice.id}:fixed`,
        position: 1,
        description: FIXED_AMOUNT_LINE_DESCRIPTION,
        quantity: 1,
        unit: 'Pauschal',
        unitCode: resolveUnitCode('Pauschal')!,
        unitPrice: amount,
        lineNetAmount: amount,
        category,
        rate,
        synthetic: true,
      },
    ];
  }

  const source = invoice.positions ?? [];
  if (source.length === 0) {
    issues.add('no_invoice_lines', 'positions');
    return null;
  }

  const lines: CanonicalLine[] = [];
  source.forEach((position, index) => {
    const path = `positions[${index}]`;
    const description = text(position.description);
    if (!description) issues.add('line_description_missing', `${path}.description`);

    const unit = text(position.unit);
    const unitCode = resolveUnitCode(unit);
    if (!unitCode) issues.add('unit_code_unknown', `${path}.unit`);

    if (!description || !unitCode) return;
    lines.push({
      // Die Positionskennung des Belegs ist bereits stabil — nichts wird erzeugt.
      id: position.id,
      position: index + 1,
      description,
      quantity: position.quantity,
      unit,
      unitCode,
      unitPrice: position.unitPrice,
      lineNetAmount: position.lineTotal,
      category,
      rate,
    });
  });

  return lines.length === source.length ? lines : null;
}

/* ------------------------------------------------------------------ */
/* Geld — nur prüfen, nie neu rechnen                                  */
/* ------------------------------------------------------------------ */

interface MoneyCheck {
  lineNetTotalCents: number;
  taxCents: number;
  grossCents: number;
  /** FINANZ-CORE-01A (D1) — die abgezogenen Abschläge (brutto, Cent); 0 ohne Abzug. */
  prepaidCents: number;
}

/**
 * Stimmt der Beleg in sich?
 *
 * Gerechnet wird mit denselben Helfern wie überall in OfficeTakt
 * (`lineTotalCents`, `taxCentsFromNet`) — nicht, um die gespeicherten Werte zu
 * ersetzen, sondern um sie zu bestätigen. Weicht etwas ab, ist der Beleg
 * widersprüchlich, und daraus darf keine strukturierte Rechnung entstehen.
 */
function checkMoney(
  invoice: VorgangInvoice,
  lines: CanonicalLine[],
  rate: number,
  issues: IssueLog,
): MoneyCheck | null {
  let lineNetTotalCents = 0;
  lines.forEach((line, index) => {
    const expected = line.synthetic
      ? toCents(line.lineNetAmount)
      : billingLineTotalCents(line.quantity, line.unitPrice);
    if (toCents(line.lineNetAmount) !== expected) {
      issues.add('money_inconsistent', `positions[${index}].lineTotal`);
    }
    lineNetTotalCents += expected;
  });

  /*
   * FC01A-P1-Restkorrektur (lokaler Altbestand) — das Netto nur aus verlässlichen, eingefrorenen
   * Angaben (`resolveInvoiceNet`), nie das Brutto. Ungeklärt entsteht keine E-Rechnung.
   */
  const net = resolveInvoiceNet(invoice);
  if (!net.ok) issues.add('net_unresolved', 'subtotal');
  // Ohne gespeichertes Netto ist nichts weiter zu prüfen; ein widersprüchliches nennt wie bisher
  // zusätzlich die einzelnen Abweichungen (`money_inconsistent`).
  if (!net.ok && !isValidMoneyNumber(invoice.subtotal ?? NaN)) return null;
  const subtotalCents = net.ok ? net.netCents : toCents(invoice.subtotal!);
  if (subtotalCents !== lineNetTotalCents) {
    issues.add('money_inconsistent', 'subtotal');
  }

  const taxCents = taxCentsFromNet(subtotalCents, rate);
  const grossCents = subtotalCents + taxCents;

  /*
   * `amount` ist der gespeicherte Zahlbetrag. FINANZ-CORE-01A (D1) — bei einer
   * Schlussrechnung mit Abzügen ist er brutto minus abgezogene Abschläge (BR-CO-16:
   * BT-115 = BT-112 − BT-113); die Abzüge übersteigen nie den Bruttobetrag.
   */
  const deductionCents = (invoice.previousAbschlagDeductions ?? []).reduce(
    (sum, entry) => sum + toCents(entry.amount),
    0,
  );
  if (deductionCents < 0 || deductionCents > grossCents || toCents(invoice.amount) !== grossCents - deductionCents) {
    issues.add('money_inconsistent', 'amount');
  }

  return issues.empty ? { lineNetTotalCents, taxCents, grossCents, prepaidCents: deductionCents } : null;
}

/* ------------------------------------------------------------------ */
/* Der Bauweg                                                          */
/* ------------------------------------------------------------------ */

/**
 * Das Canonical-Modell zu einer **freigegebenen** Rechnung — oder die Gründe,
 * warum es keines gibt.
 *
 * Der einzige Eingabewert ist der Beleg selbst. Es gibt bewusst keinen
 * zweiten Parameter für „aktuelle Stammdaten", weil es keinen legitimen Grund
 * gäbe, ihn zu benutzen.
 */
/**
 * FINANZ-CORE-01A (STO-09/AUS-08) — welche Darstellung entsteht.
 *
 *  - `original`: die Rechnung selbst. Eine stornierte Rechnung bekommt keine neue
 *    E-Rechnung mehr (eine früher abgelegte Datei bleibt lesbar).
 *  - `correction`: die Rechnungskorrektur einer versendeten, stornierten Rechnung
 *    als Gutschrift (381) mit eigener Nummer (BT-1), eigenem Datum (BT-2) und dem
 *    Bezug auf das Original (BT-25/BT-26). Beträge positiv: die Art 381 sagt, dass
 *    gutgeschrieben wird — das Korrektur-PDF zeigt dieselben Beträge als Gegenbuchung.
 */
export interface BuildCanonicalEInvoiceOptions {
  variant?: 'original' | 'correction';
  /** FINANZ-CORE-01A (AUS-18) — Zielprofil; Standard `xrechnung` (die strengere Prüfung). */
  profile?: CanonicalEInvoiceProfile;
  /**
   * FINANZ-CORE-01A (WEISS-Nacharbeit N02/D1) — wie die abgezogenen Abschläge
   * beglichen sind. Fehlt ein Eintrag, gilt der Abschlag als nicht beglichen:
   * Ohne Nachweis steht kein Betrag als gezahlt in BT-113.
   */
  prepaymentSettlements?: readonly CanonicalPrepaymentSettlement[];
}

export function buildCanonicalEInvoice(
  invoice: VorgangInvoice,
  options: BuildCanonicalEInvoiceOptions = {},
): CanonicalEInvoiceResult {
  const issues = new IssueLog();
  const variant = options.variant ?? 'original';
  const profile = options.profile ?? 'xrechnung';

  /* --- Herkunft ---------------------------------------------------- */
  if (invoice.status !== 'vorbereitet' && invoice.status !== 'versendet') {
    issues.add('source_not_finalized', 'status');
    return { ok: false, issues: issues.all };
  }

  /*
   * Ein interner Storno ist kein Beleg: Er markiert eine Rechnung, die den
   * Betrieb nie verlassen hat. Es gibt nichts zu exportieren — und ein Storno
   * ohne Korrekturbeleg als Rechnung auszugeben wäre schlicht falsch.
   */
  if (invoice.cancelledAt && invoice.cancellationKind !== 'correction') {
    issues.add('internal_cancellation_not_exportable', 'cancellationKind');
    return { ok: false, issues: issues.all };
  }
  if (variant === 'correction' && (!invoice.cancelledAt || invoice.cancellationKind !== 'correction')) {
    issues.add('correction_not_available', 'cancellationKind');
    return { ok: false, issues: issues.all };
  }
  if (variant === 'original' && invoice.cancelledAt) {
    issues.add('cancelled_original_not_exportable', 'cancelledAt');
    return { ok: false, issues: issues.all };
  }

  const documentKind: CanonicalDocumentKind | undefined =
    variant === 'correction' ? 'correction' : resolveDocumentKind(invoice);
  if (!documentKind) {
    issues.add('tax_status_unsupported', 'type');
    return { ok: false, issues: issues.all };
  }

  /* --- Beleg ------------------------------------------------------- */
  /*
   * FINANZ-CORE-01A (SQL-11/AUS-08) — die Korrektur trägt ihre eigene Nummer und das
   * Korrekturdatum (Geschäftstag des Stornos, wie das Korrektur-PDF). Die Nummer
   * des Originals steht in BT-25; zwei Belege mit derselben BT-1 darf es nicht geben.
   */
  const invoiceNumber = variant === 'correction' ? text(invoice.correctionNumber) : text(invoice.number);
  if (!invoiceNumber) {
    if (variant === 'correction') issues.add('correction_number_missing', 'correctionNumber');
    else issues.add('invoice_number_missing', 'number');
  }

  const originalIssueDate = text(invoice.issueDate) || text(invoice.date);
  const issueDate =
    variant === 'correction' && invoice.cancelledAt ? toBusinessDay(invoice.cancelledAt) : originalIssueDate;
  if (!issueDate) issues.add('issue_date_missing', 'issueDate');

  /*
   * Die Währung muss im Beleg stehen. Sie aus dem heutigen Firmenprofil zu
   * holen wäre der Rückgriff auf Stammdaten, den 04B gerade abgeschafft hat —
   * ein Beleg von vor 04B trägt sie nicht und ist deshalb nicht exportierbar.
   */
  const currencyCode = text(invoice.currencyCode);
  if (!currencyCode) issues.add('currency_missing', 'currencyCode');

  /* --- Steuer ------------------------------------------------------ */
  if (invoice.taxStatus === 'unclear') {
    issues.add('tax_status_unclear', 'taxStatus');
  }
  const taxMapping = resolveTaxCategory(invoice.taxStatus);
  if (!taxMapping && invoice.taxStatus !== 'unclear') {
    issues.add('tax_status_unsupported', 'taxStatus');
  }

  const exemptionReason = frozenExemptionReason(invoice);
  if (taxMapping?.requiresReason && !exemptionReason) {
    issues.add('tax_exemption_reason_missing', 'legalNotices');
  }

  /* --- Beteiligte -------------------------------------------------- */
  const seller = buildSeller(invoice.companySnapshot, profile, issues);
  const buyer = buildBuyer(
    invoice.customerSnapshot,
    taxMapping?.category === 'reverse_charge',
    profile,
    issues,
  );

  /* --- Zahlung ----------------------------------------------------- */
  const iban = text(invoice.companySnapshot?.iban);
  // Eine Korrektur wird verrechnet, nicht überwiesen: Sie braucht kein Konto.
  if (variant === 'original' && invoice.companySnapshot && !iban) {
    issues.add('payment_iban_missing', 'companySnapshot.iban');
  }

  /*
   * Die Abzüge einer Schlussrechnung.
   *
   * Sie entstehen aus nicht stornierten Abschlagsrechnungen — das ist der
   * Nachweis, dass **abgerechnet** wurde, nicht dass **bezahlt** wurde.
   *
   * FINANZ-CORE-01A (WEISS-Nacharbeit N02/D1) — BT-113 ist der bereits gezahlte
   * Betrag, und die Schlussrechnung setzt die vereinnahmten Teilentgelte ab
   * (§ 14 Abs. 5 Satz 2 UStG). Bis hierher stand jeder abgezogene Abschlag in
   * BT-113, auch ein unbezahlter. Jetzt muss jeder abgezogene Abschlag beglichen
   * sein — voll bezahlt oder fristgerecht mit dem Skonto des Abschlags; der
   * Zahlungsstand kommt vom Aufrufer (`prepaymentSettlements`), der Builder bleibt
   * rein. Seit N02 lässt schon die Freigabe nur beglichene Abschläge zu; die
   * Prüfung hier fängt Altbelege und später zurückgenommene Zahlungen ab.
   *
   * WEISS-Recheck N02-R1 — ein mit Skonto beglichener Abschlag ist nicht in voller Höhe
   * gezahlt. BT-113 nennt nur das tatsächlich Gezahlte; das gewährte Skonto ist eine
   * Entgeltminderung (§ 17 UStG) und steht als Nachlass auf Belegebene (BG-20) mit der
   * Steuerkategorie des Belegs — es mindert Bemessungsgrundlage (BT-109) und Steuer
   * (BT-110). Der Zahlbetrag BT-115 bleibt der Restbetrag des Belegs. Die Aufteilung ist
   * mit der Freigabe eingefroren (`paidAmount`/`skontoAmount`) — dieselbe, die das PDF
   * druckt (`splitAbschlagDeductions`). Ein Altbeleg mit Skonto ohne eingefrorene
   * Aufteilung wird nicht exportiert (`prepayment_skonto_unfrozen`).
   */
  const settlements = new Map(
    (options.prepaymentSettlements ?? []).map((entry) => [entry.invoiceId, entry] as const),
  );
  const deductions = invoice.previousAbschlagDeductions ?? [];
  deductions.forEach((entry, index) => {
    const settlement = settlements.get(entry.invoiceId);
    if (!settlement?.settled) {
      issues.add('prepayment_not_settled', `previousAbschlagDeductions[${index}]`);
    } else if (!frozenSettlementShare(entry) && toCents(settlement.skonto) > 0) {
      issues.add('prepayment_skonto_unfrozen', `previousAbschlagDeductions[${index}]`);
    }
  });

  /* --- Zeilen ------------------------------------------------------ */
  const lines = taxMapping
    ? buildLines(invoice, taxMapping.category, taxMapping.rate, issues)
    : null;

  if (!issues.empty || !seller || !buyer || !lines || !taxMapping) {
    return { ok: false, issues: issues.all };
  }

  /* --- Geld -------------------------------------------------------- */
  const money = checkMoney(invoice, lines, taxMapping.rate, issues);
  if (!money) return { ok: false, issues: issues.all };

  /* --- Abzüge: gezahlt und Skonto (WEISS-Recheck N02-R1) ------------ */
  const split = splitAbschlagDeductions(
    deductions,
    { subtotalNet: fromCents(money.lineNetTotalCents), taxRate: taxMapping.rate },
    frozenSettlementShare,
  );
  /*
   * FC01A-P1-Restkorrektur (#8, Altformat) — § 14 Abs. 5 Satz 2 UStG verlangt je abgesetztem
   * Teilentgelt auch die darauf entfallende Steuer. Steht das Netto eines Abzugs nicht fest
   * (umsatzsteuerpflichtiger Altabschlag ohne gespeichertes Netto, widersprüchliche Angaben),
   * entsteht keine E-Rechnung — bisher stand dort Brutto als Netto und eine negative Steuer.
   */
  if (!split.netReliable) {
    split.parts.forEach((part, index) => {
      if (part.billedNet === null) issues.add('prepayment_net_unreliable', `previousAbschlagDeductions[${index}]`);
    });
    return { ok: false, issues: issues.all };
  }
  const prepayments: CanonicalPrepaymentReference[] = split.parts.map((part) => ({
    invoiceId: part.deduction.invoiceId,
    invoiceNumber: part.deduction.invoiceNumber,
    date: part.deduction.date,
    // Verlässlich (`split.netReliable`): gespeichert und zum Satz passend, oder steuerfrei gleich dem Brutto.
    netAmount: part.billedNet!,
    grossAmount: part.deduction.amount,
    paidAmount: part.paid,
    skontoAmount: part.skonto,
  }));
  const deductionLabel = (index: number): string => {
    const deduction = deductions[index];
    return deduction?.abschlagNumber ? `Abschlag ${deduction.abschlagNumber}` : 'Abschlag';
  };
  const allowances: CanonicalAllowance[] = split.parts.flatMap((part, index) =>
    part.skonto > 0
      ? [
          {
            amount: part.skontoNet,
            reason: `Skonto auf ${deductionLabel(index)} (Rechnung ${part.deduction.invoiceNumber})`,
            reasonCode: '95',
            category: taxMapping.category,
            rate: taxMapping.rate,
          },
        ]
      : [],
  );
  const taxableCents = money.lineNetTotalCents - toCents(split.skontoNetTotal);
  const taxCents = split.hasSkonto ? toCents(split.taxAfterSkonto) : money.taxCents;
  const taxInclusiveCents = taxableCents + taxCents;
  const prepaidCents = toCents(split.paidTotal);
  const roundingCents = toCents(split.roundingAmount);
  // BR-CO-16: BT-115 = BT-112 − BT-113 + BT-114 — und BT-115 ist der Restbetrag des Belegs.
  if (taxInclusiveCents - prepaidCents + roundingCents !== toCents(invoice.amount)) {
    issues.add('money_inconsistent', 'amount');
    return { ok: false, issues: issues.all };
  }

  /* --- Zusammensetzen ---------------------------------------------- */
  const taxBreakdown: CanonicalTaxBreakdown = {
    category: taxMapping.category,
    rate: taxMapping.rate,
    taxableAmount: fromCents(taxableCents),
    taxAmount: fromCents(taxCents),
  };
  if (taxMapping.requiresReason) taxBreakdown.exemptionReason = exemptionReason;

  const notes: string[] = [];
  if (variant === 'correction') {
    notes.push(
      `Rechnungskorrektur (Storno) zu Rechnung ${text(invoice.number)} vom ${formatGermanDate(originalIssueDate)}. Grund: ${text(invoice.cancelReason)}`,
    );
  }
  /* FINANZ-CORE-01A (KUN-07) — die vom Leitweg abweichende Käuferreferenz bleibt sichtbar. */
  const buyerReferenceNote = text(invoice.customerSnapshot?.buyerReference);
  if (buyer.leitwegId && buyerReferenceNote && buyerReferenceNote !== buyer.leitwegId) {
    notes.push(`Käuferreferenz: ${buyerReferenceNote}`);
  }
  if (prepayments.length > 0) {
    /*
     * FC01A-Nacharbeit (A1) — § 14 Abs. 5 Satz 2 UStG: Abgesetzt werden die vereinnahmten
     * Teilentgelte **und die auf sie entfallenden Steuerbeträge**. BT-113 kennt nur einen
     * Bruttobetrag; Netto und Umsatzsteuer je Abschlag stehen deshalb in dieser Notiz — dieselben
     * Werte wie im PDF und in der Ansicht (AUS-01/N13), aus derselben Aufteilung. Ohne Steuer
     * (§ 13b, § 19, Altbestand ohne Netto) bleibt der Text unverändert.
     */
    const taxParts = (net: number, tax: number): string =>
      toCents(tax) !== 0 ? ` (netto ${formatGermanAmount(net)} EUR, USt ${formatGermanAmount(tax)} EUR)` : '';
    const entries = prepayments.map((entry, index) => {
      const head = `${deductionLabel(index)} (Rechnung ${entry.invoiceNumber} vom ${formatGermanDate(entry.date)})`;
      const part = split.parts[index]!;
      // WEISS-Recheck N02-R1 — mit Skonto beglichen: nur das Gezahlte ist abgesetztes Teilentgelt.
      // Netto steht hier fest (oben geprüft: split.netReliable).
      return entry.skontoAmount > 0
        ? `${head} ${formatGermanAmount(entry.paidAmount)} EUR gezahlt${taxParts(part.paidNet!, part.paidTax!)} von ${formatGermanAmount(entry.grossAmount)} EUR brutto`
        : `${head} ${formatGermanAmount(entry.grossAmount)} EUR brutto${taxParts(part.billedNet!, fromCents(toCents(part.billed) - toCents(part.billedNet!)))}`;
    });
    notes.push(`Abzüglich bereits bezahlter Abschläge: ${entries.join('; ')}`);
    split.parts.forEach((part, index) => {
      if (!(part.skonto > 0)) return;
      const parts =
        part.skontoTax !== 0
          ? ` (netto ${formatGermanAmount(part.skontoNet)} EUR, USt ${formatGermanAmount(part.skontoTax)} EUR)`
          : '';
      notes.push(
        `Skonto auf ${deductionLabel(index)} (Rechnung ${part.deduction.invoiceNumber}): ${formatGermanAmount(part.skonto)} EUR brutto${parts}, als Nachlass auf Belegebene ausgewiesen (Entgeltminderung).`,
      );
    });
  }
  /* FINANZ-CORE-01A (AUS-11/EIN-07) — der Aufbewahrungshinweis des Belegs, wie das PDF ihn druckt. */
  if (hasPrivateRetentionNotice(invoice.legalNotices)) notes.push(PRIVATE_RETENTION_NOTICE);

  const canonical: CanonicalEInvoice = {
    sourceInvoiceId: invoice.id,
    sourceInvoiceNumber: invoiceNumber,
    sourceInvoiceType: invoice.type,
    documentKind,
    businessProcess: 'standard_billing',
    currencyCode,
    issueDate,
    seller,
    buyer,
    payment:
      variant === 'correction'
        ? {
            /*
             * FINANZ-CORE-01A (STO-09/AUS-08) — storniert wird nur ohne Zahlungseingang:
             * Die Gutschrift wird mit der Rechnung verrechnet, es fliesst kein Geld.
             * EN 16931 BR-CO-25 verlangt bei positivem Zahlbetrag eine Fälligkeit oder
             * Zahlungsbedingung — hier die Bedingung, die genau das sagt.
             */
            means: 'settlement',
            payableAmount: invoice.amount,
            termsText: `Gutschrift zur Rechnung ${text(invoice.number)}. Es ist keine Zahlung zu leisten.`,
          }
        : {
            means: 'credit_transfer',
            transfer: buildTransfer(invoice.companySnapshot!, iban),
            payableAmount: invoice.amount,
            ...(text(invoice.paymentDueDate) ? { dueDate: text(invoice.paymentDueDate) } : {}),
            ...(text(invoice.paymentTermsText) ? { termsText: text(invoice.paymentTermsText) } : {}),
            ...(text(invoice.skontoText) ? { skontoText: text(invoice.skontoText) } : {}),
          },
    lines,
    tax: [taxBreakdown],
    ...(allowances.length > 0 ? { allowances } : {}),
    totals: {
      lineNetTotal: fromCents(money.lineNetTotalCents),
      // Ohne Nachlass das Netto des Belegs; mit Skonto-Nachlass gemindert (BT-109).
      // Das geprüfte Netto (gleich der Zeilensumme); ein Altbeleg ohne gespeichertes Netto trägt keins.
      taxExclusiveAmount: split.hasSkonto ? fromCents(taxableCents) : fromCents(money.lineNetTotalCents),
      taxAmount: fromCents(taxCents),
      taxInclusiveAmount: fromCents(taxInclusiveCents),
      billedPrepayments: prepayments,
      prepaidAmount: fromCents(prepaidCents),
      ...(split.hasSkonto ? { allowanceTotal: split.skontoNetTotal } : {}),
      ...(roundingCents !== 0 ? { roundingAmount: fromCents(roundingCents) } : {}),
      // Der gespeicherte Zahlbetrag, unverändert.
      payableAmount: invoice.amount,
    },
    references: buildReferences(invoice, documentKind, originalIssueDate),
    notes,
  };

  const servicePeriod = buildServicePeriod(invoice);
  if (servicePeriod) canonical.servicePeriod = servicePeriod;

  return { ok: true, value: canonical };
}

/** Deutsches Datum für eine Belegnotiz (TT.MM.JJJJ); unbekannte Formate bleiben, wie sie sind. */
function formatGermanDate(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  return match ? `${match[3]}.${match[2]}.${match[1]}` : value;
}

/** Deutscher Betrag für eine Belegnotiz (1.234,50). */
function formatGermanAmount(value: number): string {
  return fromCents(toCents(value)).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/**
 * FINANZ-CORE-01A (EIN-09) — IBAN und BIC ohne Leerzeichen und in Grossbuchstaben.
 * Das Firmenprofil speichert die IBAN oft in Vierergruppen; im XML ist das ein
 * ungültiger Kontowert.
 */
function compactAccountId(value: string): string {
  return value.replace(/\s+/g, '').toUpperCase();
}

function buildTransfer(snapshot: CompanyProfile, ibanInput: string) {
  const iban = compactAccountId(ibanInput);
  const bic = compactAccountId(text(snapshot.bic));
  const accountHolder = text(snapshot.accountHolder);
  return {
    iban,
    ...(bic ? { bic } : {}),
    ...(accountHolder ? { accountHolder } : {}),
  };
}

function buildServicePeriod(invoice: VorgangInvoice) {
  const from = text(invoice.servicePeriodFrom);
  const to = text(invoice.servicePeriodTo);
  return from && to ? { from, to } : undefined;
}

function buildReferences(
  invoice: VorgangInvoice,
  documentKind: CanonicalDocumentKind,
  issueDate: string,
) {
  /*
   * Referenzen entstehen ausschliesslich aus eingefrorenen Belegdaten. Eine
   * Auftragsnummer aus dem heutigen Vorgang nachzuladen wäre derselbe Fehler
   * wie bei den Stammdaten — und `vorgangTitle` ist ein Projekttitel, keine
   * Bestellnummer, also auch kein Ersatz.
   */
  const precedingInvoiceNumbers = (invoice.previousAbschlagDeductions ?? [])
    .map((entry) => text(entry.invoiceNumber))
    .filter(Boolean);

  const references: CanonicalEInvoice['references'] = { precedingInvoiceNumbers };

  if (documentKind === 'correction' && invoice.cancelledAt) {
    references.correction = {
      originalInvoiceId: invoice.id,
      originalInvoiceNumber: text(invoice.number),
      originalIssueDate: text(invoice.issueDate) || text(invoice.date) || issueDate,
      reason: text(invoice.cancelReason),
    };
  }

  return references;
}
