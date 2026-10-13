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
import type { ServicePeriodOutputCode } from './einvoiceOutputRule';
import type { XRechnungRenderIssue } from './xrechnungCiiRenderer';

const TEXTE: Readonly<Record<CanonicalEInvoiceIssueCode, string>> = {
  source_not_finalized: 'Die Rechnung ist noch nicht freigegeben.',
  internal_cancellation_not_exportable:
    'Diese Rechnung wurde vor dem Versand zurückgezogen. Dafür gibt es keine E-Rechnung.',
  // FINANZ-CORE-01A (AUS-08/STO-09) — Original und Korrektur sind zwei Belege.
  cancelled_original_not_exportable:
    'Diese Rechnung ist storniert. Eine neue E-Rechnung entsteht nur noch für die Rechnungskorrektur (Gutschrift); eine früher erzeugte Datei bleibt abrufbar.',
  correction_number_missing:
    'Diese Rechnungskorrektur stammt aus der Zeit vor der eigenen Korrekturnummer. Ohne eigene Belegnummer lässt sich keine E-Rechnung dazu erzeugen.',
  correction_not_available: 'Zu dieser Rechnung gibt es keine Rechnungskorrektur.',

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
  /*
   * FINANZ-CORE-01A (AUS-18) — diese vier Angaben verlangt nur die XRechnung; der
   * ZUGFeRD-Weg (EN 16931) meldet sie nicht mehr. Die Texte sagen deshalb wieder
   * ausdrücklich „XRechnung".
   */
  seller_electronic_address_missing:
    'Für die XRechnung fehlt in den Firmendaten der Rechnung eine E-Mail-Adresse (elektronische Adresse).',
  seller_contact_missing:
    'Für die XRechnung braucht der Absender einen Ansprechpartner mit Telefonnummer und E-Mail-Adresse.',
  seller_tax_identity_missing:
    'In den Firmendaten der Rechnung fehlt die Steuernummer oder die USt-IdNr.',
  seller_identifier_missing:
    'Für die E-Rechnung braucht der Absender eine USt-IdNr. oder eine Handelsregisternummer (EN 16931, BR-CO-26). Die Steuernummer allein genügt dafür nicht.',
  payment_iban_missing: 'In den Firmendaten der Rechnung fehlt die IBAN.',

  buyer_snapshot_missing: 'Der Rechnung fehlen die eingefrorenen Kundendaten.',
  buyer_name_missing: 'Beim Rechnungsempfänger fehlt der Name.',
  buyer_address_incomplete:
    'Beim Rechnungsempfänger fehlt ein Teil der Anschrift (Straße, PLZ oder Ort).',
  buyer_country_missing: 'Beim Rechnungsempfänger fehlt der Ländercode.',
  buyer_electronic_address_missing:
    'Für die XRechnung fehlt beim Rechnungsempfänger eine E-Mail-Adresse (elektronische Adresse).',
  buyer_reference_missing:
    'Für die XRechnung fehlt die Käuferreferenz (bei öffentlichen Auftraggebern die Leitweg-ID).',
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

  // FINANZ-CORE-01A (D1) — wird nicht mehr erzeugt; der Text bleibt für ältere Protokolle.
  // FINANZ-CORE-01A (WEISS-Nacharbeit N02/D1) — BT-113 ist der bereits gezahlte Betrag.
  prepayment_not_settled:
    'Die Schlussrechnung zieht einen Abschlag ab, der noch nicht vollständig bezahlt ist. In der E-Rechnung stehen abgezogene Abschläge als bereits gezahlter Betrag — bitte zuerst die Zahlung zum Abschlag erfassen.',
  // FINANZ-CORE-01A (WEISS-Recheck N02-R1) — gezahlt und Skonto müssen getrennt eingefroren sein.
  prepayment_skonto_unfrozen:
    'Die Schlussrechnung zieht einen mit Skonto beglichenen Abschlag ab, wurde aber freigegeben, bevor Zahlung und Skonto getrennt festgehalten wurden. Eine E-Rechnung würde das Skonto als Zahlung ausweisen — bitte die Schlussrechnung korrigieren (stornieren und neu freigeben).',
  final_invoice_deduction_semantics_unsupported:
    'Schlussrechnungen mit Abzug bereits abgerechneter Abschläge konnten früher nicht als E-Rechnung ausgegeben werden.',
};

/**
 * Der Hinweis, der über den Einzelbefunden steht, wenn es an eingefrorenen
 * Daten liegt — also fast immer bei älteren Rechnungen.
 */
export const LEGACY_INVOICE_HINT =
  'Diese ältere Rechnung enthält nicht alle eingefrorenen Daten, die für eine E-Rechnung benötigt werden. '
  + 'Die Angaben lassen sich nachträglich nicht ergänzen, ohne den Beleg zu verändern; '
  + 'für neue Rechnungen genügt es, die Stammdaten zu vervollständigen.';

export function describeCanonicalIssue(issue: CanonicalEInvoiceIssue): string {
  return TEXTE[issue.code] ?? 'Für diese Rechnung lässt sich keine E-Rechnung erzeugen.';
}

/**
 * GO-LIVE-SECURITY-01 — warum eine E-Rechnung wie PDF und Druck wartet. Die
 * Bestätigung steht im Panel darüber; wer sie nicht geben darf, sieht dort den
 * Rollenhinweis.
 */
const LEISTUNGSZEITRAUM: Readonly<Record<ServicePeriodOutputCode, string>> = {
  service_period: 'Der Leistungszeitraum fehlt oder ist ungültig.',
  service_period_order: 'Der Leistungszeitraum beginnt nach seinem Ende.',
  service_period_unconfirmed:
    'Der Leistungszeitraum ist nicht bestätigt. Wie PDF und Druck ist die E-Rechnung erst nach der Bestätigung durch Inhaber oder Verwaltung möglich.',
};

export function describeServicePeriodOutputBlocker(code: ServicePeriodOutputCode): string {
  return LEISTUNGSZEITRAUM[code];
}

/** GO-LIVE-SECURITY-01 — Gerät eines Mitglieds: Die Cloud trägt die Bestätigung (noch) nicht nachweislich. */
export const SERVICE_PERIOD_UNVERIFIED_TEXT =
  'Die Bestätigung des Leistungszeitraums ließ sich nicht mit der Cloud abgleichen. Die E-Rechnung ist erst danach möglich – bitte mit Internetverbindung erneut versuchen.';

export function describeRenderIssue(issue: XRechnungRenderIssue): string {
  return issue.code === 'xml_control_character'
    ? 'Ein Text dieser Rechnung enthält ein Zeichen, das in einer E-Rechnung nicht zulässig ist.'
    : 'Die E-Rechnung liess sich technisch nicht erzeugen.';
}

/**
 * Deuten die Befunde auf einen Altbeleg hin?
 *
 * FINANZ-CORE-01A (KUN-02) — allein die fehlende Währung. Seit 04B trägt jede
 * freigegebene Rechnung ihre Währung; fehlt sie, stammt der Beleg sicher von
 * davor. Käuferreferenz und Ländercode fehlen dagegen auch neuen Rechnungen
 * (ein Kunde ohne diese Angaben) — dort war der Satz „Diese ältere Rechnung
 * …" schlicht falsch, und sein Rat, die Stammdaten zu ergänzen, half einer
 * Auftragsrechnung mit eingefrorener Auftragsanschrift nicht. Die
 * Einzelbefunde sagen, was fehlt.
 */
export function looksLikeLegacyInvoice(issues: readonly CanonicalEInvoiceIssue[]): boolean {
  const legacy: CanonicalEInvoiceIssueCode[] = ['currency_missing'];
  return issues.some((issue) => legacy.includes(issue.code));
}
