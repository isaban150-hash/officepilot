/**
 * E-RECHNUNG-04E2 — die Invariante, dass PDF und XML denselben Beleg zeigen.
 *
 * ## Warum das die wichtigste Datei dieses Blocks ist
 *
 * Bei einer hybriden Rechnung ist der strukturierte XML-Teil fachlich führend.
 * Der Empfänger liest das XML maschinell und bucht danach; den sichtbaren
 * PDF-Teil sieht oft nur noch ein Mensch, der nachschlägt. Gehen beide
 * auseinander, entsteht der schlimmste Fall, den ein Rechnungsprogramm
 * produzieren kann: **ein Beleg, der zwei verschiedene Beträge behauptet** —
 * und beide Seiten halten ihren für den richtigen.
 *
 * Deshalb wird hier nicht argumentiert, sondern verglichen.
 *
 * ## Warum „kommt doch aus demselben Objekt" nicht reicht
 *
 * Beide Seiten stammen aus derselben `VorgangInvoice`. Man könnte daraus
 * schliessen, dass sie gar nicht abweichen *können*. Das ist falsch, und zwar
 * aus drei realen Gründen:
 *
 *  - Es sind **zwei getrennte Ableitungen**: `buildInvoicePrintModelFromInvoice`
 *    für das Papier, `buildCanonicalEInvoice` für das XML. Beide runden, beide
 *    behandeln Sonderfälle, und beide werden künftig unabhängig geändert.
 *  - Der Pauschalfall (`calculation_mode = fixed_amount`) erzeugt seine Zeile
 *    in jeder der beiden Ableitungen **eigenständig**.
 *  - Abzüge aus früheren Abschlägen wirken heute auf den Zahlbetrag im PDF,
 *    sind im XML aber bewusst noch nicht abgebildet (04C,
 *    `final_invoice_deduction_semantics_unsupported`).
 *
 * Eine Annahme hätte all das nicht bemerkt. Ein Vergleich bemerkt es.
 *
 * ## Fail-closed
 *
 * Weicht auch nur ein geprüfter Wert ab, entsteht **kein** Dokument. Lieber
 * kein ZUGFeRD als ein widersprüchliches.
 *
 * Rein: kein Zustand, keine Uhr, kein Netzwerk.
 */
import type { CanonicalEInvoice } from '../canonicalEInvoice';
import { zugferdLineDescription } from './zugferdLinePresentation';
import type { InvoicePrintModel } from '../../../types/models';

export interface ZugferdConsistencyMismatch {
  /** Welcher Wert — stabiler Punktpfad, maschinenlesbar. */
  readonly field: string;
  /** Was im sichtbaren PDF steht. */
  readonly pdf: string;
  /** Was im XML steht. */
  readonly xml: string;
}

export type ZugferdConsistencyResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly mismatches: readonly ZugferdConsistencyMismatch[] };

/**
 * Geldbeträge auf Cent vergleichen.
 *
 * Beide Seiten rechnen in Gleitkomma; `0.1 + 0.2` ist dort nicht `0.3`. Ein
 * Vergleich auf Bitgleichheit würde deshalb Abweichungen melden, die keine
 * sind. Der Cent ist die kleinste Einheit, in der eine Rechnung überhaupt eine
 * Aussage trifft — darunter gibt es nichts zu vergleichen.
 */
function cents(value: number): number {
  return Math.round(value * 100);
}

function money(value: number): string {
  return (cents(value) / 100).toFixed(2);
}

/** Freitext ohne belanglose Unterschiede in Rand- und Mehrfachleerzeichen. */
function normalizeText(value: string | undefined | null): string {
  return (value ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * Prüft, ob das sichtbare Dokument und der strukturierte Datensatz denselben
 * Beleg beschreiben.
 *
 * Geprüft wird ausdrücklich das, worauf jemand Geld überweist oder eine
 * Buchung stützt — nicht das Layout und nicht Formulierungen.
 */
export function checkZugferdPdfXmlConsistency(
  model: InvoicePrintModel,
  canonical: CanonicalEInvoice,
): ZugferdConsistencyResult {
  const mismatches: ZugferdConsistencyMismatch[] = [];
  const check = (field: string, pdf: string, xml: string): void => {
    if (pdf !== xml) mismatches.push({ field, pdf, xml });
  };

  /* --- Belegkopf ------------------------------------------------ */
  check('invoiceNumber', normalizeText(model.invoiceNumber), normalizeText(canonical.sourceInvoiceNumber));
  check('issueDate', normalizeText(model.issueDate), normalizeText(canonical.issueDate));
  check('documentType', model.type, canonical.sourceInvoiceType);

  /*
   * Die Währung steht im PDF nicht als Code, sondern steckt in der
   * Betragsformatierung. Verglichen wird deshalb gegen die Festlegung des
   * Belegs; ein Beleg in anderer Währung als der des XML wäre ein Fehler, den
   * niemand am Papier sähe.
   */
  check('currencyCode', 'EUR', normalizeText(canonical.currencyCode));

  /* --- Verkäufer ------------------------------------------------ */
  check('seller.name', normalizeText(model.company.companyName), normalizeText(canonical.seller.name));
  check('seller.street', normalizeText(model.company.street), normalizeText(canonical.seller.address.street));
  check('seller.zip', normalizeText(model.company.zip), normalizeText(canonical.seller.address.zip));
  check('seller.city', normalizeText(model.company.city), normalizeText(canonical.seller.address.city));
  check('seller.vatId', normalizeText(model.company.vatId), normalizeText(canonical.seller.vatId));
  check('seller.taxNumber', normalizeText(model.company.taxNumber), normalizeText(canonical.seller.taxNumber));

  /* --- Käufer --------------------------------------------------- */
  check('buyer.name', normalizeText(model.customer.name), normalizeText(canonical.buyer.name));
  check('buyer.street', normalizeText(model.customer.street), normalizeText(canonical.buyer.address.street));
  check('buyer.zip', normalizeText(model.customer.zip), normalizeText(canonical.buyer.address.zip));
  check('buyer.city', normalizeText(model.customer.city), normalizeText(canonical.buyer.address.city));

  /* --- Positionen ----------------------------------------------- */
  check('lines.count', String(model.positions.length), String(canonical.lines.length));
  const shared = Math.min(model.positions.length, canonical.lines.length);
  for (let index = 0; index < shared; index += 1) {
    const printed = model.positions[index];
    const structured = canonical.lines[index];
    const at = `lines[${index}]`;
    /*
     * E-RECHNUNG-04E3 — die Beschreibung wird wieder **ausnahmslos** verglichen.
     *
     * In 04E2 musste die erzeugte Zeile des Pauschalabschlags hier ausgenommen
     * werden, weil Papier und Datensatz sie unterschiedlich beschrifteten. Das
     * ist behoben: `zugferdLineDescription` liefert für beide Seiten denselben
     * Text. Verglichen wird deshalb gegen das, was der ZUGFeRD-Renderer
     * tatsächlich schreibt — nicht gegen den kanonischen Rohwert, den die
     * XRechnung weiterhin unverändert verwendet.
     */
    check(
      `${at}.description`,
      normalizeText(printed.description),
      normalizeText(zugferdLineDescription(structured)),
    );
    check(`${at}.quantity`, String(printed.quantity), String(structured.quantity));
    check(`${at}.unit`, normalizeText(printed.unit), normalizeText(structured.unit));
    check(`${at}.unitPrice`, money(printed.unitPrice), money(structured.unitPrice));
    check(`${at}.lineTotal`, money(printed.lineTotal), money(structured.lineNetAmount));
    /*
     * Die Steuerkategorie steht auf dem Papier nicht je Zeile, sondern gilt
     * für den ganzen Beleg. Geprüft wird deshalb, dass die Zeile im XML
     * dieselbe Kategorie und denselben Satz trägt wie die Aufschlüsselung —
     * eine Zeile mit abweichendem Satz wäre im PDF unsichtbar.
     */
    check(`${at}.taxCategory`, canonical.tax[0]?.category ?? '', structured.category);
    check(`${at}.taxRate`, String(model.summary.taxRate), String(structured.rate));
  }

  /* --- Steuer und Summen ---------------------------------------- */
  const tax = canonical.tax[0];
  check('tax.rate', String(model.summary.taxRate), String(tax?.rate ?? ''));
  check('tax.taxableAmount', money(model.summary.subtotalNet), money(tax?.taxableAmount ?? Number.NaN));
  check('tax.amount', money(model.summary.taxAmount), money(tax?.taxAmount ?? Number.NaN));
  check('totals.net', money(model.summary.subtotalNet), money(canonical.totals.taxExclusiveAmount));
  check('totals.tax', money(model.summary.taxAmount), money(canonical.totals.taxAmount));
  check('totals.gross', money(model.summary.grossTotal), money(canonical.totals.taxInclusiveAmount));

  /*
   * Der Zahlbetrag ist der heikelste Wert überhaupt: Auf ihn überweist jemand.
   * Im PDF ist es `amountDue` — nach Abzug bereits abgerechneter Abschläge —,
   * im XML `payableAmount`. Dass beide gleich sein müssen, ist genau der
   * Grund, warum eine Schlussrechnung mit Abzügen in 04C fail-closed ist:
   * Solange das XML die Abzüge nicht ausdrücken kann, darf es auch keinen
   * davon bereinigten Betrag behaupten.
   */
  check('totals.payable', money(model.summary.amountDue), money(canonical.totals.payableAmount));

  /* --- Zahlungsinformationen ------------------------------------ */
  check('payment.iban', normalizeText(model.company.iban).replace(/\s+/g, ''), normalizeText(canonical.payment.transfer.iban).replace(/\s+/g, ''));
  check('payment.dueDate', normalizeText(model.paymentDueDate), normalizeText(canonical.payment.dueDate));

  return mismatches.length === 0 ? { ok: true } : { ok: false, mismatches };
}
