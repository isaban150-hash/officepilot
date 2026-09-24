/**
 * E-RECHNUNG-04E2 — der ZUGFeRD-2.5.2-Renderer, Profil EN16931, Syntax CII.
 *
 * ## Warum eine eigene Datei und nicht ein Schalter im XRechnung-Renderer
 *
 * Beide Formate benutzen UN/CEFACT CII und denselben kanonischen
 * Rechnungsinhalt. Es wäre also verlockend, den bestehenden Renderer um einen
 * Parameter „Profil" zu erweitern. Genau das ist hier bewusst **nicht**
 * geschehen:
 *
 *  - Die bestehende XRechnung 3.0.2 ist gegen den offiziellen KoSIT-Validator
 *    abgenommen und ihre Ausgabe liegt als Goldfiles byteweise fest. Ein
 *    Umbau an dieser Stelle riskiert genau das, wofür 04D bezahlt wurde.
 *  - Die Profile werden **auseinanderlaufen**. XRechnung kennt die `BR-DE-*`,
 *    ZUGFeRD EN16931 kennt sie nicht; XRechnung verlangt eine Leitweg-ID und
 *    einen Peppol-Geschäftsprozess, ZUGFeRD nicht. Ein gemeinsamer Renderer
 *    mit zwei Profilen müsste diese Unterschiede in Bedingungen abbilden, und
 *    jede davon wäre eine Stelle, an der das eine Format das andere kaputt
 *    machen kann.
 *
 * Geteilt wird deshalb genau das, was ohnehin geteilt war und dessen Ausgabe
 * unverändert bleibt: das kanonische Modell aus 04C, der XML-Schreiber und die
 * Einheiten-/Steuercodes. Kein Byte des XRechnung-Pfades wird angefasst.
 *
 * ## Die fachlichen Werte kommen nicht von hier
 *
 * Dieser Renderer serialisiert. Er rechnet nichts, fragt keine Stammdaten,
 * entscheidet keine Steuerkategorie und keine Einheit. Alles Fachliche ist in
 * 04C entschieden und im eingefrorenen Beleg-Snapshot festgehalten — damit
 * PDF und XML zwangsläufig dasselbe sagen.
 *
 * Herkunft aller technischen Kennungen: siehe `zugferdProfile.ts`.
 *
 * Rein: kein Zustand, keine Uhr, kein Zufall, kein Netzwerk.
 */
import type {
  CanonicalDocumentKind,
  CanonicalEInvoice,
  CanonicalLine,
  CanonicalTaxCategory,
} from '../canonicalEInvoice';
import {
  XML_DECLARATION,
  XmlUnrepresentableCharacterError,
  formatXmlAmount,
  formatXmlDate102,
  formatXmlPercent,
  formatXmlQuantity,
  xmlLeaf,
  xmlNode,
} from '../einvoiceXmlWriter';
import { ZUGFERD_EN16931_GUIDELINE_ID, ZUGFERD_NAMESPACES } from './zugferdProfile';
import { zugferdLineDescription } from './zugferdLinePresentation';

/* ------------------------------------------------------------------ */
/* Codes                                                               */
/* ------------------------------------------------------------------ */

/**
 * Der Dokumenttypcode (BT-3) je Belegart.
 *
 * Absichtlich dieselbe Zuordnung wie im XRechnung-Pfad — und das ist geprüft,
 * nicht angenommen: Das EN16931-Schematron von ZUGFeRD 2.5.2 verlangt für
 * BT-3 lediglich einen **nicht leeren** Wert und schränkt die Werteliste
 * nirgends ein. Es ist damit erlaubnisreicher als XRechnungs `BR-DE-17`, das
 * auf 326, 380, 384, 389, 381, 875, 876, 877 begrenzt.
 *
 * Die hier verwendete Menge ist eine echte Teilmenge davon. Das heisst: Was
 * die strengere Regel zulässt, lässt die weniger strenge erst recht zu — die
 * Codes bleiben also gültig, **ohne** dass sie aus dem anderen Profil blind
 * übernommen wären.
 *
 * Fachlich tragen sie das, was ein Handwerksbetrieb braucht: 875 ist die
 * Abschlagsrechnung, 877 die Schlussrechnung, 326 die Teilrechnung. Alles auf
 * 380 abzubilden wäre zulässig und ärmer.
 */
const DOCUMENT_TYPE_CODES: Readonly<Record<CanonicalDocumentKind, string>> = {
  invoice: '380',
  partial_invoice: '326',
  prepayment_invoice_quantity: '875',
  prepayment_invoice_fixed: '875',
  final_invoice: '877',
  correction: '384',
};

/** Steuerkategorie nach UNTDID 5305 — wie im CII üblich und profilunabhängig. */
const TAX_CATEGORY_CODES: Readonly<Record<CanonicalTaxCategory, string>> = {
  standard: 'S',
  reverse_charge: 'AE',
  exempt: 'E',
};

/** Kennung einer elektronischen Adresse (Codeliste EAS): `EM` für E-Mail. */
const ELECTRONIC_ADDRESS_SCHEMES: Readonly<Record<'email', string>> = { email: 'EM' };

/** Steuerregistrierung: `VA` für die USt-IdNr., `FC` für die Steuernummer. */
const TAX_REGISTRATION_VAT = 'VA';
const TAX_REGISTRATION_FISCAL = 'FC';

/** Überweisung (SEPA credit transfer) nach UNTDID 4461. */
const PAYMENT_MEANS_CREDIT_TRANSFER = '58';

/* ------------------------------------------------------------------ */
/* Ergebnis                                                            */
/* ------------------------------------------------------------------ */

export interface ZugferdRenderIssue {
  code: 'xml_control_character' | 'xml_value_invalid';
  detail: string;
}

export type ZugferdRenderResult =
  | { ok: true; xml: string }
  | { ok: false; issues: ZugferdRenderIssue[] };

/* ------------------------------------------------------------------ */
/* Renderer                                                            */
/* ------------------------------------------------------------------ */

export function renderZugferdEn16931Cii(canonical: CanonicalEInvoice): ZugferdRenderResult {
  try {
    return { ok: true, xml: render(canonical) };
  } catch (error) {
    /*
     * Kein Zeichen wird stillschweigend entfernt und kein Wert ersetzt. Beim
     * hybriden Format ist der XML-Teil fachlich führend — ein Serialisierer,
     * der daran heimlich etwas ändert, verfälscht den Beleg und nicht nur
     * seine Darstellung.
     */
    if (error instanceof XmlUnrepresentableCharacterError) {
      return { ok: false, issues: [{ code: 'xml_control_character', detail: error.message }] };
    }
    return {
      ok: false,
      issues: [
        {
          code: 'xml_value_invalid',
          detail: error instanceof Error ? error.message : 'unknown',
        },
      ],
    };
  }
}

function render(c: CanonicalEInvoice): string {
  const body = xmlNode(
    'rsm:CrossIndustryInvoice',
    [renderContext(c), renderDocument(c), renderTransaction(c)],
    0,
    ZUGFERD_NAMESPACES,
  );
  return `${XML_DECLARATION}\n${body}\n`;
}

/**
 * Der Profilkontext.
 *
 * Hier steckt der wesentliche Unterschied zum XRechnung-Pfad, und zwar
 * zweifach:
 *
 *  1. Die Guideline-Kennung ist `urn:cen.eu:en16931:2017` — ohne jeden
 *     Zusatz. Der XRechnung-Wert trägt `#compliant#…xrechnung_3.0` und würde
 *     den Prüfer ein anderes Profil wählen lassen.
 *  2. Der Geschäftsprozess (BT-23) **fehlt bewusst**. XRechnung verlangt ihn
 *     und OfficeTakt setzt dort die Peppol-Kennung. ZUGFeRD EN16931 verlangt
 *     ihn nicht, und OfficeTakt nimmt an keinem Peppol-Prozess teil. Ihn
 *     trotzdem zu schreiben wäre eine unbelegte Behauptung; ein leeres
 *     Element wäre schlimmer.
 */
function renderContext(c: CanonicalEInvoice): string {
  // Heute kennt das Produkt genau einen Geschäftsvorfall.
  void c.businessProcess;
  return xmlNode(
    'rsm:ExchangedDocumentContext',
    [
      xmlNode(
        'ram:GuidelineSpecifiedDocumentContextParameter',
        [xmlLeaf('ram:ID', ZUGFERD_EN16931_GUIDELINE_ID, [], 6)],
        4,
      ),
    ],
    2,
  );
}

function renderDocument(c: CanonicalEInvoice): string {
  /*
   * Der Rechtsgrund einer Steuerbefreiung steht zusätzlich als Belegnotiz, so
   * erscheint er in jeder Darstellung des Empfängers und nicht nur in der
   * Steueraufschlüsselung. `ADU` ist der übliche Notiztyp.
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
      renderDelivery(c),
      renderSettlement(c),
    ],
    2,
  );
}

/**
 * Die Lieferangaben (BG-13) mit dem Liefer-/Leistungsdatum BT-72.
 *
 * Das Element selbst ist im CII-Schema Pflicht (kein `minOccurs="0"`), sein
 * Inhalt dagegen vollständig optional. Ein leeres `<ram:…Delivery/>` ist damit
 * schemagültig — und löst trotzdem `PEPPOL-EN16931-R008` aus: „Document MUST
 * not contain empty elements". Der erste Prüflauf dieses Renderers hat genau
 * das gemeldet.
 *
 * Gefüllt wird es mit dem **Ende des Leistungszeitraums**. Das ist keine
 * Hilfskonstruktion, um eine Warnung loszuwerden, sondern die fachlich
 * richtige Angabe: BT-72 ist das Datum, an dem die Leistung erbracht wurde,
 * und genau das hält OfficeTakt in `servicePeriodTo` fest. Der Zeitraum selbst
 * steht zusätzlich als BG-14 in der Abrechnung; beides nebeneinander ist
 * zulässig und sagt dem Empfänger mehr als eines von beidem.
 *
 * Fehlt der Zeitraum, bleibt das Element leer — ein Lieferdatum zu erfinden
 * wäre schlimmer als eine Warnung. Praktisch tritt der Fall nicht auf: Eine
 * Rechnung lässt sich ohne bestätigten Leistungszeitraum gar nicht
 * finalisieren (`invoiceValidationService`, `service_period` und
 * `service_period_unconfirmed`), und nur finalisierte Belege sind
 * exportierbar.
 */
function renderDelivery(c: CanonicalEInvoice): string {
  if (!c.servicePeriod) return '    <ram:ApplicableHeaderTradeDelivery/>';
  return xmlNode(
    'ram:ApplicableHeaderTradeDelivery',
    [
      xmlNode(
        'ram:ActualDeliverySupplyChainEvent',
        [
          xmlNode(
            'ram:OccurrenceDateTime',
            [
              xmlLeaf(
                'udt:DateTimeString',
                formatXmlDate102(c.servicePeriod.to),
                [['format', '102']],
                10,
              ),
            ],
            8,
          ),
        ],
        6,
      ),
    ],
    4,
  );
}

function renderLine(line: CanonicalLine): string {
  return xmlNode(
    'ram:IncludedSupplyChainTradeLineItem',
    [
      xmlNode(
        'ram:AssociatedDocumentLineDocument',
        [xmlLeaf('ram:LineID', String(line.position), [], 8)],
        6,
      ),
      /*
       * E-RECHNUNG-04E3 — dieselbe Beschreibung wie der sichtbare Teil des
       * Hybriddokuments. Siehe `zugferdLinePresentation`.
       */
      xmlNode(
        'ram:SpecifiedTradeProduct',
        [xmlLeaf('ram:Name', zugferdLineDescription(line), [], 8)],
        6,
      ),
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
              xmlLeaf('ram:CategoryCode', TAX_CATEGORY_CODES[line.category], [], 10),
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
  /*
   * Die Käuferreferenz (BT-10) ist in EN16931 optional — anders als bei
   * XRechnung, wo `BR-DE-15` sie erzwingt. 04C verlangt sie trotzdem für
   * jeden Beleg, weil der Empfänger sonst nicht zuordnen kann; wäre sie
   * einmal leer, entfällt das Element, statt leer dazustehen.
   */
  return xmlNode(
    'ram:ApplicableHeaderTradeAgreement',
    [
      c.buyer.buyerReference?.trim()
        ? xmlLeaf('ram:BuyerReference', c.buyer.buyerReference, [], 6)
        : null,
      renderSeller(c),
      renderBuyer(c),
    ],
    4,
  );
}

function renderSeller(c: CanonicalEInvoice): string {
  const s = c.seller;
  /*
   * Optionales bleibt weg, wenn es keinen Wert hat. Ein leeres Element
   * behauptet, das Datum gebe es und sei leer; die Abwesenheit sagt die
   * Wahrheit. ZUGFeRD 2.5.2 prüft das an mehreren Stellen ausdrücklich.
   *
   * Der Verkäuferkontakt ist in EN16931 — anders als bei XRechnung
   * (`BR-DE-2`) — **nicht** Pflicht. OfficeTakt liefert ihn trotzdem, weil
   * das Feld seit 04D-FIX1 im Snapshot steht und ein Empfänger mit
   * Ansprechpartner besser bedient ist.
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

function renderPostalAddress(
  address: CanonicalEInvoice['seller']['address'],
  indent: number,
): string {
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
                [
                  xmlLeaf(
                    'udt:DateTimeString',
                    formatXmlDate102(c.servicePeriod.from),
                    [['format', '102']],
                    10,
                  ),
                ],
                8,
              ),
              xmlNode(
                'ram:EndDateTime',
                [
                  xmlLeaf(
                    'udt:DateTimeString',
                    formatXmlDate102(c.servicePeriod.to),
                    [['format', '102']],
                    10,
                  ),
                ],
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
            [
              xmlLeaf(
                'udt:DateTimeString',
                formatXmlDate102(c.payment.dueDate),
                [['format', '102']],
                10,
              ),
            ],
            8,
          )
        : null,
    ],
    6,
  );
}
