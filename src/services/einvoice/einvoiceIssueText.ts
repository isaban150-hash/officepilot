/**
 * E-RECHNUNG-04D — die Befunde aus 04C in Sätzen, die ein Betrieb versteht.
 *
 * Ein roher Code wie `buyer_reference_missing` ist für einen Test richtig und
 * für den Nutzer wertlos. Er sagt nicht, was fehlt, wo es einzutragen ist und
 * ob er selbst etwas tun kann.
 *
 * Zwei Dinge sagen diese Texte deshalb bewusst **nicht**:
 *
 *  - Sie bieten nie an, fehlende Angaben aus den heutigen Stammdaten zu
 *    ergänzen. Bei einem freigegebenen Beleg wäre das eine nachträgliche
 *    Veränderung seiner Aussage.
 *  - Sie behaupten nie, eine Rechnung sei offiziell geprüft. Die interne
 *    Prüfung ist etwas anderes als eine Validierung durch die zuständige
 *    Stelle, und der Unterschied gehört nicht verwischt.
 *
 * Rein: kein React, keine Übersetzungstabelle — die Sätze stehen hier, weil
 * sie nur an dieser einen Stelle gebraucht werden und ihre Genauigkeit vom
 * Zusammenhang lebt.
 */
import type { CanonicalEInvoiceIssue, CanonicalEInvoiceIssueCode } from './canonicalEInvoice';
import type { XRechnungRenderIssue } from './xrechnungCiiRenderer';

const TEXTE: Readonly<Record<CanonicalEInvoiceIssueCode, string>> = {
  source_not_finalized: 'Die Rechnung ist noch nicht freigegeben.',
  internal_cancellation_not_exportable:
    'Diese Rechnung wurde vor dem Versand zurückgezogen. Dafür gibt es keine E-Rechnung.',

  invoice_number_missing: 'Der Rechnung fehlt die Rechnungsnummer.',
  issue_date_missing: 'Der Rechnung fehlt das Rechnungsdatum.',
  currency_missing: 'Der Rechnung fehlt die Währung.',
  no_invoice_lines: 'Die Rechnung enthält keine Positionen.',
  money_inconsistent:
    'Die gespeicherten Beträge dieser Rechnung passen nicht zusammen. Es wird keine E-Rechnung erzeugt.',

  seller_snapshot_missing: 'Der Rechnung fehlen die eingefrorenen Firmendaten.',
  seller_name_missing: 'In den Firmendaten der Rechnung fehlt der Firmenname.',
  seller_address_incomplete:
    'In den Firmendaten der Rechnung fehlt ein Teil der Anschrift (Straße, PLZ oder Ort).',
  seller_country_missing: 'In den Firmendaten der Rechnung fehlt der Ländercode.',
  seller_electronic_address_missing:
    'In den Firmendaten der Rechnung fehlt eine E-Mail-Adresse für die elektronische Adresse.',
  seller_contact_missing:
    'Für die XRechnung braucht der Absender einen Ansprechpartner mit Telefonnummer und E-Mail-Adresse.',
  seller_tax_identity_missing:
    'In den Firmendaten der Rechnung fehlt die Steuernummer oder die USt-IdNr.',
  payment_iban_missing: 'In den Firmendaten der Rechnung fehlt die IBAN.',

  buyer_snapshot_missing: 'Der Rechnung fehlen die eingefrorenen Kundendaten.',
  buyer_name_missing: 'Beim Rechnungsempfänger fehlt der Name.',
  buyer_address_incomplete:
    'Beim Rechnungsempfänger fehlt ein Teil der Anschrift (Straße, PLZ oder Ort).',
  buyer_country_missing: 'Beim Rechnungsempfänger fehlt der Ländercode.',
  buyer_electronic_address_missing:
    'Beim Rechnungsempfänger fehlt eine E-Mail-Adresse für die elektronische Adresse.',
  buyer_reference_missing: 'Für die XRechnung fehlt die Käuferreferenz.',
  buyer_vat_id_missing_for_reverse_charge:
    'Bei Steuerschuldnerschaft des Leistungsempfängers (§ 13b) braucht der Empfänger eine USt-IdNr.',

  tax_status_unclear:
    'Die Steuerentscheidung dieser Rechnung ist „unklar". Eine E-Rechnung braucht eine eindeutige Steuerart.',
  tax_status_unsupported:
    'Die Steuerart dieser Rechnung lässt sich nicht eindeutig einer E-Rechnungs-Kategorie zuordnen.',
  tax_exemption_reason_missing:
    'Zur steuerfreien Rechnung fehlt der Rechtsgrund auf dem Beleg.',

  unit_code_unknown:
    'Eine Position verwendet eine Einheit, für die es keinen standardisierten Code gibt.',
  line_description_missing: 'Einer Position fehlt die Beschreibung.',
  fixed_amount_net_invalid: 'Dem Pauschalabschlag fehlt ein gültiger Nettobetrag.',

  final_invoice_deduction_semantics_unsupported:
    'Schlussrechnungen mit Abzug bereits abgerechneter Abschläge können noch nicht als E-Rechnung ausgegeben werden.',
};

/**
 * Der Hinweis, der über den Einzelbefunden steht, wenn es an eingefrorenen
 * Daten liegt — also fast immer bei älteren Rechnungen.
 */
export const LEGACY_INVOICE_HINT =
  'Diese ältere Rechnung enthält nicht alle eingefrorenen Daten, die für eine XRechnung benötigt werden. '
  + 'Die Angaben lassen sich nachträglich nicht ergänzen, ohne den Beleg zu verändern; '
  + 'für neue Rechnungen genügt es, die Stammdaten zu vervollständigen.';

export function describeCanonicalIssue(issue: CanonicalEInvoiceIssue): string {
  return TEXTE[issue.code] ?? 'Für diese Rechnung lässt sich keine XRechnung erzeugen.';
}

export function describeRenderIssue(issue: XRechnungRenderIssue): string {
  return issue.code === 'xml_control_character'
    ? 'Ein Text dieser Rechnung enthält ein Zeichen, das in einer XRechnung nicht zulässig ist.'
    : 'Die XRechnung liess sich technisch nicht erzeugen.';
}

/**
 * Deuten die Befunde auf einen Altbeleg hin?
 *
 * Kennzeichen sind genau die Angaben, die es vor 04B noch nicht gab. Fehlt
 * dagegen etwa die IBAN, ist das kein Altbestandsproblem, sondern eine
 * unvollständige Firmenangabe — und der Hinweis wäre irreführend.
 */
export function looksLikeLegacyInvoice(issues: readonly CanonicalEInvoiceIssue[]): boolean {
  const legacy: CanonicalEInvoiceIssueCode[] = [
    'currency_missing',
    'buyer_country_missing',
    'buyer_reference_missing',
  ];
  return issues.some((issue) => legacy.includes(issue.code));
}
