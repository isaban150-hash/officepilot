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
import { isFixedAmountAbschlag } from '../invoiceCalculationMode';
import { fromCents, lineTotalCents, taxCentsFromNet, toCents } from '../invoiceMoney';
import { resolveDocumentKind, resolveTaxCategory, resolveUnitCode } from './einvoiceCodes';
import { normalizeCountryCode } from './einvoiceStandards';
import type {
  CanonicalAddress,
  CanonicalBuyer,
  CanonicalDocumentKind,
  CanonicalEInvoice,
  CanonicalEInvoiceIssue,
  CanonicalEInvoiceIssueCode,
  CanonicalEInvoiceResult,
  CanonicalLine,
  CanonicalPrepaymentReference,
  CanonicalSeller,
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
  return (invoice.legalNotices ?? []).map(text).filter(Boolean).join(' ');
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
  issues: IssueLog,
): CanonicalSeller | null {
  if (!snapshot) {
    issues.add('seller_snapshot_missing', 'companySnapshot');
    return null;
  }
  const name = text(snapshot.companyName);
  if (!name) issues.add('seller_name_missing', 'companySnapshot.companyName');

  const address = buildAddress(
    snapshot,
    'companySnapshot',
    'seller_address_incomplete',
    'seller_country_missing',
    issues,
  );

  const email = text(snapshot.email);
  if (!email) issues.add('seller_electronic_address_missing', 'companySnapshot.email');

  /*
   * Eine der beiden Steuerkennungen genügt: Ein Kleinbetrieb führt oft nur
   * eine Steuernummer, ein umsatzsteuerpflichtiger Betrieb eine USt-IdNr.
   * Beide zu verlangen hiesse, gültige Betriebe auszuschliessen.
   */
  const taxNumber = text(snapshot.taxNumber);
  const vatId = text(snapshot.vatId);
  if (!taxNumber && !vatId) {
    issues.add('seller_tax_identity_missing', 'companySnapshot.taxNumber');
  }

  /*
   * Der Ansprechpartner ist für eine strukturierte Rechnung Pflicht
   * (BR-DE-2, BR-DE-5/6/7) — für eine gewöhnliche PDF-Rechnung nicht. Auch
   * hier gilt: Der Betrieb soll weiter Rechnungen schreiben können, ohne die
   * E-Rechnung nutzen zu müssen.
   */
  const contactName = text(snapshot.contactPerson);
  const contactPhone = text(snapshot.phone);
  if (!contactName || !contactPhone || !email) {
    issues.add('seller_contact_missing', 'companySnapshot.contactPerson');
  }

  if (!name || !address || !email || (!taxNumber && !vatId) || !contactName || !contactPhone) {
    return null;
  }

  const seller: CanonicalSeller = {
    name,
    address,
    electronicAddress: { scheme: 'email', value: email },
    contact: { name: contactName, phone: contactPhone, email },
  };
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

  const email = text(snapshot.email);
  if (!email) issues.add('buyer_electronic_address_missing', 'customerSnapshot.email');

  /*
   * Die Käuferreferenz ist für eine gewöhnliche PDF-Rechnung freiwillig und
   * bleibt es — 04B hat sie bewusst nicht zur Freigabebedingung gemacht. Für
   * eine strukturierte Rechnung ist sie Pflicht. Der Unterschied ist Absicht:
   * Der Betrieb soll weiter Rechnungen schreiben können, auch wenn er nie eine
   * E-Rechnung braucht.
   */
  const buyerReference = text(snapshot.buyerReference);
  if (!buyerReference) issues.add('buyer_reference_missing', 'customerSnapshot.buyerReference');

  const vatId = text(snapshot.vatId);
  if (requiresVatId && !vatId) {
    issues.add('buyer_vat_id_missing_for_reverse_charge', 'customerSnapshot.vatId');
  }

  if (!name || !address || !email || !buyerReference || (requiresVatId && !vatId)) return null;

  const buyer: CanonicalBuyer = {
    name,
    address,
    electronicAddress: { scheme: 'email', value: email },
    buyerReference,
  };
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
      : lineTotalCents(line.quantity, line.unitPrice);
    if (toCents(line.lineNetAmount) !== expected) {
      issues.add('money_inconsistent', `positions[${index}].lineTotal`);
    }
    lineNetTotalCents += expected;
  });

  const subtotalCents = toCents(invoice.subtotal);
  if (subtotalCents !== lineNetTotalCents) {
    issues.add('money_inconsistent', 'subtotal');
  }

  const taxCents = taxCentsFromNet(subtotalCents, rate);
  const grossCents = subtotalCents + taxCents;

  /*
   * `amount` ist der gespeicherte Zahlbetrag. Bei einer Schlussrechnung mit
   * Abzügen liegt er darunter — dieser Fall wird an anderer Stelle ohnehin
   * abgewiesen, deshalb wird hier nur der abzugsfreie Beleg geprüft.
   */
  const deductionCents = (invoice.previousAbschlagDeductions ?? []).reduce(
    (sum, entry) => sum + toCents(entry.amount),
    0,
  );
  if (deductionCents === 0 && toCents(invoice.amount) !== grossCents) {
    issues.add('money_inconsistent', 'amount');
  }

  return issues.empty ? { lineNetTotalCents, taxCents, grossCents } : null;
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
export function buildCanonicalEInvoice(invoice: VorgangInvoice): CanonicalEInvoiceResult {
  const issues = new IssueLog();

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

  const documentKind = resolveDocumentKind(invoice);
  if (!documentKind) {
    issues.add('tax_status_unsupported', 'type');
    return { ok: false, issues: issues.all };
  }

  /* --- Beleg ------------------------------------------------------- */
  const invoiceNumber = text(invoice.number);
  if (!invoiceNumber) issues.add('invoice_number_missing', 'number');

  const issueDate = text(invoice.issueDate) || text(invoice.date);
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
  const seller = buildSeller(invoice.companySnapshot, issues);
  const buyer = buildBuyer(
    invoice.customerSnapshot,
    taxMapping?.category === 'reverse_charge',
    issues,
  );

  /* --- Zahlung ----------------------------------------------------- */
  const iban = text(invoice.companySnapshot?.iban);
  if (invoice.companySnapshot && !iban) {
    issues.add('payment_iban_missing', 'companySnapshot.iban');
  }

  /*
   * Die Abzüge einer Schlussrechnung.
   *
   * Sie entstehen aus nicht stornierten Abschlagsrechnungen — das ist der
   * Nachweis, dass **abgerechnet** wurde, nicht dass **bezahlt** wurde. Der
   * Zahlungsstand einer Rechnung liegt in `payments`/`paymentStatus` und
   * gehört ausdrücklich nicht zum Beleg; er verlässt den Client nicht einmal.
   *
   * Sie in einem Zielformat als bereits gezahlten Betrag auszuweisen, wäre
   * deshalb eine Behauptung über Geldflüsse, die OfficeTakt nicht kennt. Bis
   * geklärt ist, wie eine Schlussrechnung ihre Vorausrechnungen korrekt
   * ausdrückt, wird dieser Fall nicht exportiert.
   */
  const prepayments: CanonicalPrepaymentReference[] = (invoice.previousAbschlagDeductions ?? []).map(
    (entry) => ({
      invoiceId: entry.invoiceId,
      invoiceNumber: entry.invoiceNumber,
      date: entry.date,
      netAmount: entry.subtotal,
      grossAmount: entry.amount,
    }),
  );
  if (prepayments.length > 0) {
    issues.add('final_invoice_deduction_semantics_unsupported', 'previousAbschlagDeductions');
  }

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

  /* --- Zusammensetzen ---------------------------------------------- */
  const taxBreakdown: CanonicalTaxBreakdown = {
    category: taxMapping.category,
    rate: taxMapping.rate,
    taxableAmount: fromCents(money.lineNetTotalCents),
    taxAmount: fromCents(money.taxCents),
  };
  if (taxMapping.requiresReason) taxBreakdown.exemptionReason = exemptionReason;

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
    payment: {
      means: 'credit_transfer',
      transfer: buildTransfer(invoice.companySnapshot!, iban),
      payableAmount: invoice.amount,
      ...(text(invoice.paymentDueDate) ? { dueDate: text(invoice.paymentDueDate) } : {}),
      ...(text(invoice.paymentTermsText) ? { termsText: text(invoice.paymentTermsText) } : {}),
      ...(text(invoice.skontoText) ? { skontoText: text(invoice.skontoText) } : {}),
    },
    lines,
    tax: [taxBreakdown],
    totals: {
      lineNetTotal: fromCents(money.lineNetTotalCents),
      taxExclusiveAmount: invoice.subtotal,
      taxAmount: fromCents(money.taxCents),
      taxInclusiveAmount: fromCents(money.grossCents),
      billedPrepayments: prepayments,
      // Der gespeicherte Zahlbetrag, unverändert.
      payableAmount: invoice.amount,
    },
    references: buildReferences(invoice, documentKind, issueDate),
  };

  const servicePeriod = buildServicePeriod(invoice);
  if (servicePeriod) canonical.servicePeriod = servicePeriod;

  return { ok: true, value: canonical };
}

function buildTransfer(snapshot: CompanyProfile, iban: string) {
  const bic = text(snapshot.bic);
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
