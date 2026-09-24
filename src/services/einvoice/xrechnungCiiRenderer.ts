/**
 * E-RECHNUNG-04D — der XRechnung-Renderer in der Syntax UN/CEFACT CII.
 *
 * Er bekommt ein fertiges `CanonicalEInvoice` und serialisiert es. Mehr nicht:
 * keine Stammdaten, keine Summen, keine Steuerentscheidung, keine Einheit, kein
 * Ländercode, keine Käuferreferenz. Alles Fachliche ist in 04C entschieden; was
 * hier noch dazukommt, sind ausschliesslich **technische Kennungen des
 * Zielformats**.
 *
 * Die Struktur stammt nicht aus dem Gedächtnis, sondern aus den offiziellen
 * Artefakten, die für die Abnahme ohnehin gebraucht werden:
 *
 *   - KoSIT Validator-Konfiguration XRechnung 3.0.2, Stand 2026-08-31
 *     (`scenarios.xml`, Schematron `XRechnung-CII-validation.xsl`)
 *   - KoSIT XRechnung-Testsuite, Stand 2026-08-31, gültige CII-Instanzen
 *
 * Die Elementreihenfolge ist im CII-Schema verbindlich und hier bewusst so
 * geschrieben, wie die geprüften Instanzen sie zeigen.
 *
 * Rein: kein Zustand, keine Uhr, kein Zufall, kein Netzwerk.
 */
import type {
  CanonicalDocumentKind,
  CanonicalEInvoice,
  CanonicalLine,
  CanonicalTaxCategory,
} from './canonicalEInvoice';
import { EINVOICE_STANDARDS } from './einvoiceStandards';
import {
  XML_DECLARATION,
  XmlUnrepresentableCharacterError,
  formatXmlAmount,
  formatXmlDate102,
  formatXmlPercent,
  formatXmlQuantity,
  xmlLeaf,
  xmlNode,
} from './einvoiceXmlWriter';

/* ------------------------------------------------------------------ */
/* Technische Kennungen — zentral und versionsgebunden                 */
/* ------------------------------------------------------------------ */

/**
 * Die Kennungen, die XRechnung 3.0 technisch verlangt.
 *
 * Der Guideline-Identifier ist wörtlich der, auf den die offizielle
 * Validator-Konfiguration ihr CII-Szenario auswählt:
 *
 *     <match>exists(/rsm:CrossIndustryInvoice[…GuidelineSpecifiedDocumentContextParameter/ram:ID/text()
 *            = 'urn:cen.eu:en16931:2017#compliant#urn:xeinkauf.de:kosit:xrechnung_3.0'])</match>
 *
 * Stimmt er nicht, prüft der Validator gar nicht erst als XRechnung. Deshalb
 * steht er hier an einer Stelle, an die Version gebunden und getestet — und
 * nirgends als Nutzereingabe.
 */
export const XRECHNUNG_CII = {
  guidelineId: `urn:cen.eu:en16931:2017#compliant#urn:xeinkauf.de:kosit:xrechnung_${EINVOICE_STANDARDS.xrechnung.generation}`,
  /** Der Geschäftsprozess der gewöhnlichen Rechnungsstellung. */
  businessProcessId: 'urn:fdc:peppol.eu:2017:poacc:billing:01:1.0',
  namespaces: [
    ['xmlns:rsm', 'urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100'],
    ['xmlns:ram', 'urn:un:unece:uncefact:data:standard:ReusableAggregateBusinessInformationEntity:100'],
    ['xmlns:qdt', 'urn:un:unece:uncefact:data:standard:QualifiedDataType:100'],
    ['xmlns:udt', 'urn:un:unece:uncefact:data:standard:UnqualifiedDataType:100'],
  ] as ReadonlyArray<readonly [string, string]>,
} as const;

/**
 * Der Dokumenttypcode je Belegart.
 *
 * Nicht geraten: Die zulässige Menge steht in BR-DE-17 der
 * XRechnung-3.0.2-Regeln und lautet 326, 380, 384, 389, 381, 875, 876, 877.
 *
 * Für einen Handwerksbetrieb ist daran das Wichtigste, dass es die Bau-Codes
 * überhaupt gibt: 875 ist ausdrücklich die Abschlagsrechnung, 877 die
 * Schlussrechnung, 326 die Teilrechnung. Sie alle auf 380 abzubilden wäre
 * technisch zulässig gewesen und fachlich ärmer — der Empfänger sähe nicht
 * mehr, welche Art Beleg er bekommt.
 *
 * Ein mengenbasierter und ein pauschaler Abschlag sind fachlich derselbe
 * Belegtyp; sie unterscheiden sich nur darin, wie ihre Zeilen entstehen.
 */
const DOCUMENT_TYPE_CODES: Readonly<Record<CanonicalDocumentKind, string>> = {
  invoice: '380',
  partial_invoice: '326',
  prepayment_invoice_quantity: '875',
  prepayment_invoice_fixed: '875',
  final_invoice: '877',
  correction: '384',
};

/**
 * Die Steuerkategorie als Code der Liste UNTDID 5305.
 *
 * `S` Regelsteuersatz, `AE` Steuerschuldnerschaft des Leistungsempfängers,
 * `E` steuerbefreit — alle drei kommen in den offiziellen Testinstanzen genau
 * so vor. Die übrigen Kategorien (`Z`, `G`, `K`, `O`) entstehen gar nicht
 * erst, weil 04C die dazugehörigen Fälle nicht freigibt.
 */
const TAX_CATEGORY_CODES: Readonly<Record<CanonicalTaxCategory, string>> = {
  standard: 'S',
  reverse_charge: 'AE',
  exempt: 'E',
};

/**
 * Die Kennung einer elektronischen Adresse (Codeliste EAS).
 *
 * `EM` für E-Mail — in den offiziellen Instanzen durchgängig als
 * `<ram:URIID schemeID="EM">`. Der Wert `email` aus dem Canonical-Modell ist
 * die **fachliche** Art; hierher gehört der technische Code.
 */
const ELECTRONIC_ADDRESS_SCHEMES: Readonly<Record<'email', string>> = { email: 'EM' };

/** Steuerregistrierung: `VA` für die USt-IdNr., `FC` für die Steuernummer. */
const TAX_REGISTRATION_VAT = 'VA';
const TAX_REGISTRATION_FISCAL = 'FC';

/** Überweisung (SEPA credit transfer) nach UNTDID 4461. */
const PAYMENT_MEANS_CREDIT_TRANSFER = '58';

/** Die Fassung des Erzeugers — Teil der Artefaktkennung, siehe 04D/V. */
export const XRECHNUNG_GENERATOR_VERSION = 'officetakt-cii-1';

/* ------------------------------------------------------------------ */
/* Ergebnis                                                            */
/* ------------------------------------------------------------------ */

export interface XRechnungRenderIssue {
  code: 'xml_control_character' | 'xml_value_invalid';
  detail: string;
}

export type XRechnungRenderResult =
  | { ok: true; xml: string }
  | { ok: false; issues: XRechnungRenderIssue[] };

/* ------------------------------------------------------------------ */
/* Renderer                                                            */
/* ------------------------------------------------------------------ */

export function renderXRechnungCii(canonical: CanonicalEInvoice): XRechnungRenderResult {
  try {
    return { ok: true, xml: render(canonical) };
  } catch (error) {
    /*
     * Ein nicht darstellbares Zeichen oder ein unbrauchbarer Zahlen-/Datumswert
     * bricht den Bau ab. Kein Zeichen wird stillschweigend entfernt und kein
     * Wert ersetzt: Ein Beleg, dem der Serialisierer heimlich etwas wegnimmt,
     * ist nicht mehr der Beleg des Betriebs.
     */
    if (error instanceof XmlUnrepresentableCharacterError) {
      return { ok: false, issues: [{ code: 'xml_control_character', detail: error.message }] };
    }
    return {
      ok: false,
      issues: [{ code: 'xml_value_invalid', detail: error instanceof Error ? error.message : 'unknown' }],
    };
  }
}

function render(c: CanonicalEInvoice): string {
  const body = xmlNode(
    'rsm:CrossIndustryInvoice',
    [renderContext(c), renderDocument(c), renderTransaction(c)],
    0,
    XRECHNUNG_CII.namespaces,
  );
  // Abschliessender Zeilenumbruch: eine Datei, kein Fragment.
  return `${XML_DECLARATION}\n${body}\n`;
}

function renderContext(c: CanonicalEInvoice): string {
  return xmlNode(
    'rsm:ExchangedDocumentContext',
    [
      xmlNode(
        'ram:BusinessProcessSpecifiedDocumentContextParameter',
        [xmlLeaf('ram:ID', businessProcessId(c), [], 6)],
        4,
      ),
      xmlNode(
        'ram:GuidelineSpecifiedDocumentContextParameter',
        [xmlLeaf('ram:ID', XRECHNUNG_CII.guidelineId, [], 6)],
        4,
      ),
    ],
    2,
  );
}

function businessProcessId(c: CanonicalEInvoice): string {
  // Heute kennt das Produkt genau einen Geschäftsvorfall; der Fall ist
  // trotzdem ausgeschrieben, damit ein zweiter kein stiller Sonderweg wird.
  switch (c.businessProcess) {
    case 'standard_billing':
    default:
      return XRECHNUNG_CII.businessProcessId;
  }
}

function renderDocument(c: CanonicalEInvoice): string {
  /*
   * Der Rechtsgrund einer Steuerbefreiung steht zusätzlich als Belegnotiz —
   * so erscheint er in jeder Darstellung des Empfängers und nicht nur in der
   * Steueraufschlüsselung. `ADU` ist der in den offiziellen Instanzen
   * verwendete Notiztyp.
   */
  const reason = c.tax[0]?.exemptionReason;
  return xmlNode(
    'rsm:ExchangedDocument',
    [
      xmlLeaf('ram:ID', c.sourceInvoiceNumber, [], 4),
      xmlLeaf('ram:TypeCode', DOCUMENT_TYPE_CODES[c.documentKind], [], 4),
      xmlNode(
        'ram:IssueDateTime',
        [xmlLeaf('udt:DateTimeString', formatXmlDate102(c.issueDate), [['format', '102']], 6)],
        4,
      ),
      reason
        ? xmlNode(
            'ram:IncludedNote',
            [xmlLeaf('ram:Content', reason, [], 6), xmlLeaf('ram:SubjectCode', 'ADU', [], 6)],
            4,
          )
        : null,
    ],
    2,
  );
}

function renderTransaction(c: CanonicalEInvoice): string {
  return xmlNode(
    'rsm:SupplyChainTradeTransaction',
    [
      ...c.lines.map(renderLine),
      renderAgreement(c),
      // Im CII-Schema Pflichtelement der Sequenz; OfficeTakt liefert dazu
      // keine eigenen Angaben, deshalb bewusst leer.
      '    <ram:ApplicableHeaderTradeDelivery/>',
      renderSettlement(c),
    ],
    2,
  );
}

function renderLine(line: CanonicalLine): string {
  const categoryCode = TAX_CATEGORY_CODES[line.category];
  return xmlNode(
    'ram:IncludedSupplyChainTradeLineItem',
    [
      xmlNode(
        'ram:AssociatedDocumentLineDocument',
        [xmlLeaf('ram:LineID', String(line.position), [], 8)],
        6,
      ),
      xmlNode('ram:SpecifiedTradeProduct', [xmlLeaf('ram:Name', line.description, [], 8)], 6),
      xmlNode(
        'ram:SpecifiedLineTradeAgreement',
        [
          xmlNode(
            'ram:NetPriceProductTradePrice',
            [xmlLeaf('ram:ChargeAmount', formatXmlAmount(line.unitPrice), [], 10)],
            8,
          ),
        ],
        6,
      ),
      xmlNode(
        'ram:SpecifiedLineTradeDelivery',
        [
          xmlLeaf(
            'ram:BilledQuantity',
            formatXmlQuantity(line.quantity),
            [['unitCode', line.unitCode]],
            8,
          ),
        ],
        6,
      ),
      xmlNode(
        'ram:SpecifiedLineTradeSettlement',
        [
          xmlNode(
            'ram:ApplicableTradeTax',
            [
              xmlLeaf('ram:TypeCode', 'VAT', [], 10),
              xmlLeaf('ram:CategoryCode', categoryCode, [], 10),
              xmlLeaf('ram:RateApplicablePercent', formatXmlPercent(line.rate), [], 10),
            ],
            8,
          ),
          xmlNode(
            'ram:SpecifiedTradeSettlementLineMonetarySummation',
            [xmlLeaf('ram:LineTotalAmount', formatXmlAmount(line.lineNetAmount), [], 10)],
            8,
          ),
        ],
        6,
      ),
    ],
    4,
  );
}

function renderAgreement(c: CanonicalEInvoice): string {
  return xmlNode(
    'ram:ApplicableHeaderTradeAgreement',
    [
      xmlLeaf('ram:BuyerReference', c.buyer.buyerReference, [], 6),
      renderSeller(c),
      renderBuyer(c),
    ],
    4,
  );
}

function renderSeller(c: CanonicalEInvoice): string {
  const s = c.seller;
  /*
   * Optionales bleibt weg, wenn es keinen Wert hat — kein `<ram:BIC/>`, kein
   * leerer Ansprechpartner. Ein leeres Element behauptet, das Datum gebe es
   * und sei leer; die Abwesenheit sagt die Wahrheit.
   */
  return xmlNode(
    'ram:SellerTradeParty',
    [
      xmlLeaf('ram:Name', s.name, [], 8),
      s.registrationNumber
        ? xmlNode(
            'ram:SpecifiedLegalOrganization',
            [xmlLeaf('ram:ID', s.registrationNumber, [], 10)],
            8,
          )
        : null,
      /*
       * Seller contact (BG-6) — Pflicht nach BR-DE-2, mit Name, Telefon und
       * E-Mail nach BR-DE-5/6/7. Die Reihenfolge folgt dem CII-Schema und den
       * offiziellen Testinstanzen: der Kontakt steht vor der Anschrift.
       */
      xmlNode(
        'ram:DefinedTradeContact',
        [
          xmlLeaf('ram:PersonName', s.contact.name, [], 10),
          xmlNode(
            'ram:TelephoneUniversalCommunication',
            [xmlLeaf('ram:CompleteNumber', s.contact.phone, [], 12)],
            10,
          ),
          xmlNode(
            'ram:EmailURIUniversalCommunication',
            [xmlLeaf('ram:URIID', s.contact.email, [], 12)],
            10,
          ),
        ],
        8,
      ),
      renderPostalAddress(s.address, 8),
      xmlNode(
        'ram:URIUniversalCommunication',
        [
          xmlLeaf(
            'ram:URIID',
            s.electronicAddress.value,
            [['schemeID', ELECTRONIC_ADDRESS_SCHEMES[s.electronicAddress.scheme]]],
            10,
          ),
        ],
        8,
      ),
      /*
       * Die Reihenfolge ist nicht beliebig: Die USt-IdNr. steht zuerst, weil
       * sie die überörtlich gültige Kennung ist. Beide dürfen vorkommen; 04C
       * verlangt mindestens eine.
       */
      s.vatId
        ? xmlNode(
            'ram:SpecifiedTaxRegistration',
            [xmlLeaf('ram:ID', s.vatId, [['schemeID', TAX_REGISTRATION_VAT]], 10)],
            8,
          )
        : null,
      s.taxNumber
        ? xmlNode(
            'ram:SpecifiedTaxRegistration',
            [xmlLeaf('ram:ID', s.taxNumber, [['schemeID', TAX_REGISTRATION_FISCAL]], 10)],
            8,
          )
        : null,
    ],
    6,
  );
}

function renderBuyer(c: CanonicalEInvoice): string {
  const b = c.buyer;
  return xmlNode(
    'ram:BuyerTradeParty',
    [
      xmlLeaf('ram:Name', b.name, [], 8),
      b.contactPerson
        ? xmlNode('ram:DefinedTradeContact', [xmlLeaf('ram:PersonName', b.contactPerson, [], 10)], 8)
        : null,
      renderPostalAddress(b.address, 8),
      xmlNode(
        'ram:URIUniversalCommunication',
        [
          xmlLeaf(
            'ram:URIID',
            b.electronicAddress.value,
            [['schemeID', ELECTRONIC_ADDRESS_SCHEMES[b.electronicAddress.scheme]]],
            10,
          ),
        ],
        8,
      ),
      b.vatId
        ? xmlNode(
            'ram:SpecifiedTaxRegistration',
            [xmlLeaf('ram:ID', b.vatId, [['schemeID', TAX_REGISTRATION_VAT]], 10)],
            8,
          )
        : null,
    ],
    6,
  );
}

function renderPostalAddress(address: CanonicalEInvoice['seller']['address'], indent: number): string {
  return xmlNode(
    'ram:PostalTradeAddress',
    [
      xmlLeaf('ram:PostcodeCode', address.zip, [], indent + 2),
      xmlLeaf('ram:LineOne', address.street, [], indent + 2),
      xmlLeaf('ram:CityName', address.city, [], indent + 2),
      xmlLeaf('ram:CountryID', address.countryCode, [], indent + 2),
    ],
    indent,
  );
}

function renderSettlement(c: CanonicalEInvoice): string {
  const tax = c.tax[0]!;
  const transfer = c.payment.transfer;

  return xmlNode(
    'ram:ApplicableHeaderTradeSettlement',
    [
      xmlLeaf('ram:InvoiceCurrencyCode', c.currencyCode, [], 6),
      xmlNode(
        'ram:SpecifiedTradeSettlementPaymentMeans',
        [
          xmlLeaf('ram:TypeCode', PAYMENT_MEANS_CREDIT_TRANSFER, [], 8),
          xmlNode(
            'ram:PayeePartyCreditorFinancialAccount',
            [xmlLeaf('ram:IBANID', transfer.iban, [], 10)],
            8,
          ),
        ],
        6,
      ),
      xmlNode(
        'ram:ApplicableTradeTax',
        [
          xmlLeaf('ram:CalculatedAmount', formatXmlAmount(tax.taxAmount), [], 8),
          xmlLeaf('ram:TypeCode', 'VAT', [], 8),
          tax.exemptionReason ? xmlLeaf('ram:ExemptionReason', tax.exemptionReason, [], 8) : null,
          xmlLeaf('ram:BasisAmount', formatXmlAmount(tax.taxableAmount), [], 8),
          xmlLeaf('ram:CategoryCode', TAX_CATEGORY_CODES[tax.category], [], 8),
          xmlLeaf('ram:RateApplicablePercent', formatXmlPercent(tax.rate), [], 8),
        ],
        6,
      ),
      c.servicePeriod
        ? xmlNode(
            'ram:BillingSpecifiedPeriod',
            [
              xmlNode(
                'ram:StartDateTime',
                [xmlLeaf('udt:DateTimeString', formatXmlDate102(c.servicePeriod.from), [['format', '102']], 10)],
                8,
              ),
              xmlNode(
                'ram:EndDateTime',
                [xmlLeaf('udt:DateTimeString', formatXmlDate102(c.servicePeriod.to), [['format', '102']], 10)],
                8,
              ),
            ],
            6,
          )
        : null,
      renderPaymentTerms(c),
      xmlNode(
        'ram:SpecifiedTradeSettlementHeaderMonetarySummation',
        [
          xmlLeaf('ram:LineTotalAmount', formatXmlAmount(c.totals.lineNetTotal), [], 8),
          xmlLeaf('ram:TaxBasisTotalAmount', formatXmlAmount(c.totals.taxExclusiveAmount), [], 8),
          xmlLeaf(
            'ram:TaxTotalAmount',
            formatXmlAmount(c.totals.taxAmount),
            [['currencyID', c.currencyCode]],
            8,
          ),
          xmlLeaf('ram:GrandTotalAmount', formatXmlAmount(c.totals.taxInclusiveAmount), [], 8),
          xmlLeaf('ram:DuePayableAmount', formatXmlAmount(c.totals.payableAmount), [], 8),
        ],
        6,
      ),
      c.references.correction
        ? xmlNode(
            'ram:InvoiceReferencedDocument',
            [xmlLeaf('ram:IssuerAssignedID', c.references.correction.originalInvoiceNumber, [], 8)],
            6,
          )
        : null,
    ],
    4,
  );
}

function renderPaymentTerms(c: CanonicalEInvoice): string | null {
  /*
   * Zahlungstext und Skonto sind zwei Angaben desselben Belegs und gehören in
   * dieselbe Beschreibung. Fehlen beide und gibt es kein Fälligkeitsdatum,
   * entfällt der Block ganz — statt als leeres Element dazustehen.
   */
  const description = [c.payment.termsText, c.payment.skontoText]
    .map((value) => (value ?? '').trim())
    .filter(Boolean)
    .join(' ');
  if (!description && !c.payment.dueDate) return null;

  return xmlNode(
    'ram:SpecifiedTradePaymentTerms',
    [
      description ? xmlLeaf('ram:Description', description, [], 8) : null,
      c.payment.dueDate
        ? xmlNode(
            'ram:DueDateDateTime',
            [xmlLeaf('udt:DateTimeString', formatXmlDate102(c.payment.dueDate), [['format', '102']], 10)],
            8,
          )
        : null,
    ],
    6,
  );
}
