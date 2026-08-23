import type { ClassifiedDocumentKind } from '../types/models';
import type { DocumentClassificationInput } from '../types/models';
import type { AuthorityCutoverKind, CertificateCutoverKind, ContractCutoverKind, CustomerCutoverKind, OcrOnlyRecognizedDataKind, PaymentCutoverKind, ReceiptCutoverKind } from '../config/documentIntelligenceConfig';
import {
  getOcrOnlyRecognizedDataEnabled,
  isOcrOnlyRecognizedDataKind,
} from '../config/documentIntelligenceConfig';
import {
  formatGermanMoney,
  resolveInvoiceAmount,
} from './documentAmountExtractionService';
import {
  cleanLetterheadCandidate,
  stripLetterheadLogoInitial,
  containsMerchantToken,
  extractFieldsWithConfidence,
  isAllFragmentTokens,
  pickCleanerMerchantVariant,
  stripLeadingMerchantNoise,
  toConfidentPlainFields,
} from './documentFieldExtractionService';
import { extractDocumentFeatures } from './documentFeatureExtractionService';
import { buildCanonicalDocumentText, zoneDocumentText } from './documentZoningService';

export type EvidenceBasedRecognizedDataInput = {
  classifiedKind: ClassifiedDocumentKind;
  recognizedText?: string;
  pageTexts?: DocumentClassificationInput['pageTexts'];
};

type RecognizedDataFamily = 'receipt' | 'invoice' | 'payment' | 'authority' | 'certificate' | 'contract' | 'customer';

type ReceiptRecognizedDataConfig = {
  merchantField: string;
};

const RECEIPT_RECOGNIZED_DATA_CONFIG: Record<ReceiptCutoverKind, ReceiptRecognizedDataConfig> = {
  tankbeleg: { merchantField: 'Tankstelle' },
  ec_beleg: { merchantField: 'Lieferant' },
  kassenbeleg: { merchantField: 'Lieferant' },
  kreditkartenbeleg: { merchantField: 'Lieferant' },
  quittung: { merchantField: 'Lieferant' },
};

const OCR_ONLY_KIND_FAMILY: Record<OcrOnlyRecognizedDataKind, RecognizedDataFamily> = {
  tankbeleg: 'receipt',
  ec_beleg: 'receipt',
  kassenbeleg: 'receipt',
  kreditkartenbeleg: 'receipt',
  quittung: 'receipt',
  eingangsrechnung: 'invoice',
  mahnung: 'payment',
  zahlungserinnerung: 'payment',
  finanzamt: 'authority',
  bg_bau: 'authority',
  steuerbescheid: 'authority',
  krankenkasse: 'authority',
  soka_bau: 'authority',
  agentur_fuer_arbeit: 'authority',
  freistellungsbescheinigung: 'certificate',
  unbedenklichkeitsbescheinigung: 'certificate',
  werkvertrag: 'contract',
  subunternehmervertrag: 'contract',
  nachunternehmervertrag: 'contract',
  auftrag: 'customer',
  angebot: 'customer',
  auftragsbestaetigung: 'customer',
};


const CONTRACT_AUFTRAGGEBER_PATTERN = /^auftraggeber(?:in)?\s*[:]\s*(.+)$/i;
const CONTRACT_AUFTRAGNEHMER_PATTERN =
  /^(?:auftragnehmer|subunternehmer|nachunternehmer)\s*[:]\s*(.+)$/i;
const CUSTOMER_PARTY_PATTERN = /^(?:kunde|auftraggeber)\s*[:]\s*(.+)$/i;
const CUSTOMER_BAUSTELLE_PATTERN = /^(?:baustelle|baustellenadresse)\s*[:]\s*(.+)$/i;
const CUSTOMER_AUFTRAGSSUMME_PATTERN = /^(?:auftragssumme|auftragswert)\s*[:]\s*(.+)$/i;
const CUSTOMER_ANGEBOTSSUMME_PATTERN = /^(?:angebotssumme|angebotswert)\s*[:]\s*(.+)$/i;

const CERTIFICATE_HEADER_SKIP_PATTERN =
  /^(?:Betreff|Aussteller|Datum|gültig bis|gueltig bis|Gültigkeit|Gueltigkeit|Freistellungsbescheinigung|Unbedenklichkeitsbescheinigung|§48b)\s*[:]/i;

const AUTHORITY_HEADER_SKIP_PATTERN =
  /^(?:Betreff|Aktenzeichen|Az\.|Beitragsnummer|Datum|Frist|Beitragsbescheid|Festsetzung|Steuernummer|USt|MwSt)\s*[:]/i;

const AUTHORITY_MARKER_LINE_PATTERN =
  /\b(finanzamt|steueramt|steuerbescheid|bg[\s-]?bau|berufsgenossenschaft|krankenkasse|soka[\s-]?bau|zollamt|sozialversicherung|(?:bundes)?agentur\s+für\s+arbeit|bundesagentur|arbeitsagentur|jobcenter|stadtverwaltung|gemeindeverwaltung|landratsamt|ordnungsamt)\b/i;

const BUNDESAGENTUR_CANONICAL_SENDER = 'Bundesagentur für Arbeit';
const BA_AUTHORITY_NAME_PATTERN =
  /\b(?:bundesagentur(?:\s+für\s+arbeit)?|(?:bundes)?agentur\s+für\s+arbeit|arbeitsagentur)\b/i;
const OCR_SENDER_NOISE_PATTERN =
  /seite\s+\d+|von\s+\d+|page\s+\d+|arbeitsbescheinigung|arbeitgeberbescheinigung|§\s*312|sgb\s*iii/i;

const PAYMENT_HEADER_SKIP_PATTERN =
  /^(?:Rechnungs(?:nummer|nr)|Invoice|Inv\.|Mahnung|Zahlungserinnerung|Zahlungsaufforderung|Inkasso|Datum|Offener\s+Betrag|IBAN|zu\s+zahlen|zahlbar|Fälligkeit|Faelligkeit)/i;

const PAYMENT_HINT_PATTERN =
  /\b(\d+\.\s*mahnung|mahnung|zahlungserinnerung|zahlungsaufforderung|inkasso)\b/i;

const RECEIPT_HEADER_SKIP_PATTERN =
  /^(?:HRB|Amtsgericht|Geschäftsf|Geschaeftsf|Kartenzahlung|Vielen Dank|Danke|Girocard|Mastercard|Visa|EC-Karte|Terminal|Summe|Bar\s+gezahlt|Barzahlung)/i;

/**
 * DOCUMENT-RECEIPT-MERCHANT-HEADER-01 — eindeutig ungeeignete Kopfzeilen.
 *
 * Ausschließlich am Zeilenanfang verankert und jeweils durch eine
 * Wortgrenze bzw. das erwartete Folgezeichen abgeschlossen: ein Firmenname
 * darf nicht verschwinden, nur weil „Kasse", „Filiale" oder „Tel" irgendwo in
 * ihm vorkommt („Kassenhaus Meier", „Tellerhaus GmbH", „Filialbäckerei Nord").
 *
 * Bewusst eng gehalten: keine Bewertung von Kandidaten, keine Slogan- oder
 * Adresserkennung. Werbetexte und Straßenzeilen ohne PLZ bleiben eine
 * bekannte, hier nicht gelöste Restlücke.
 */
const RECEIPT_HEADER_CONTACT_SKIP_PATTERN =
  /^(?:tel\.?|telefon|fax|e-?mail|www\.|https?:\/\/|kassierer(?:in)?|kasse|bediener(?:in)?|filiale)\b/i;

const INVOICE_HEADER_SKIP_PATTERN =
  /^(?:Rechnungs(?:nummer|nr)|Invoice|Inv\.|Eingangsrechnung|Datum|Leistung|IBAN|USt|MwSt|Gesamtbetrag|Summe|zu\s+zahlen|zahlbar|Netto|Brutto)/i;

const RECEIPT_NUMBER_PATTERN =
  /\b(?:beleg[\s-]*nr\.?|belegnummer)\s*[:#]?\s*([A-Z0-9][\w./-]{2,})/i;

const INVOICE_TOTAL_LINE_PATTERN =
  /\b(?:gesamtbetrag|rechnungssumme|rechnungsbetrag|endsumme|summe(?:\s+brutto)?|zu\s+zahlen)\s+(\d{1,3}(?:\.\d{3})*,\d{2})\s*(?:€|EUR|eur)?/i;

function isLikelyAmountLine(line: string): boolean {
  return /\d{1,3}(?:[.\s]\d{3})*,\d{2}\s*(?:€|EUR|eur)?\b/i.test(line);
}

function isLikelyDateLine(line: string): boolean {
  return /\b\d{1,2}[./]\d{1,2}[./]\d{2,4}\b/.test(line);
}

/** Register/court footer lines must not become receipt merchants (e.g. HRB / Amtsgericht). */
function isRegistryFooterMerchant(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  return (
    /\b(?:amtsgericht|landgericht|handelsregister|registergericht)\b/i.test(trimmed) ||
    /\bhr[ab]\s*\d/i.test(trimmed)
  );
}

function inferMerchantFromHeader(text: string): string | undefined {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const candidates: string[] = [];

  for (const line of lines.slice(0, 4)) {
    if (RECEIPT_HEADER_SKIP_PATTERN.test(line)) continue;
    if (RECEIPT_HEADER_CONTACT_SKIP_PATTERN.test(line)) continue;
    // Wie in `inferSupplierFromHeader`: eine Zeile, die mit einer deutschen PLZ
    // beginnt, ist eine Anschrift und niemals der Händlername.
    if (/^\d{5}\b/.test(line)) continue;
    if (/^kassenbeleg$/i.test(line)) continue;
    if (isRegistryFooterMerchant(line)) continue;
    if (isLikelyAmountLine(line) && !/tankstelle|markt|bäckerei|baeckerei|shop|store/i.test(line)) {
      continue;
    }
    if (isLikelyDateLine(line)) continue;
    if (line.length < 3) continue;
    // Narrow normalisation only: a receipt header line IS the merchant name, so rubric
    // words ("… Tankstelle München"), places and legal forms must stay. The broad
    // letterhead cleanup would truncate them.
    const cleaned = stripLetterheadLogoInitial(line);
    if (cleaned.length >= 3) candidates.push(cleaned);
  }

  const [first] = candidates;
  if (!first) return undefined;

  /**
   * OFFICEPILOT-RECEIPT-MERCHANT-SELECTION-FIX-01 — der erste brauchbare
   * Kandidat bleibt das Ergebnis, außer ein späterer ist nachweislich derselbe
   * Name ohne den angehängten OCR-Müll. Ohne solchen Kandidaten verschlechtert
   * sich nichts. Derselbe Vertrag gilt im Absenderpfad.
   */
  return pickCleanerMerchantVariant(first, candidates.slice(1));
}

/**
 * OFFICEPILOT-TANKBELEG-TANKSTELLE-FIELD-FIX-01 — bestätigt einen Wert nur, wenn
 * er als eigene Kopfzeile im Dokument steht. Verwendet dieselbe
 * Leading-Noise-Normalisierung wie der Merchant-Vergleich, damit „= NAME" als
 * Bestätigung für „NAME" zählt. Keine zweite Bereinigungslogik.
 */
function isMerchantConfirmedInHeaderLines(value: string, text: string): boolean {
  return text
    .split(/\r?\n/)
    .slice(0, 6)
    .map((line) => stripLeadingMerchantNoise(line.trim()))
    .some((line) => line?.toLowerCase() === value.toLowerCase());
}

function resolveReceiptMerchant(
  kind: ReceiptCutoverKind,
  plain: ReturnType<typeof toConfidentPlainFields>,
  text: string,
): string | undefined {
  const headerMerchant = inferMerchantFromHeader(text);
  const extractedMerchant = (plain.Absender ?? plain.Lieferant)?.trim();

  if (kind === 'tankbeleg') {
    if (headerMerchant) {
      /**
       * OFFICEPILOT-TANKBELEG-TANKSTELLE-FIELD-FIX-01 — der Kopfvorrang bleibt
       * die Regel. Er weicht nur, wenn drei Nachweise zusammenkommen: der
       * bereits bereinigte Absender ist brauchbar, derselbe Name steht als
       * eigene Kopfzeile im Dokument, und der gewählte Kopfkandidat besteht
       * ausschließlich aus Fragmenten und teilt mit ihm kein einziges Wort.
       * Damit gewinnt weder ein zufällig abweichender Absender noch entscheidet
       * die Wortlänge allein — „ABC Bau Ost" gegen „ABC" bleibt der Kopf.
       */
      const confirmedByHeader =
        extractedMerchant &&
        !isRegistryFooterMerchant(extractedMerchant) &&
        !isAllFragmentTokens(extractedMerchant) &&
        isMerchantConfirmedInHeaderLines(extractedMerchant, text);

      if (
        confirmedByHeader &&
        isAllFragmentTokens(headerMerchant) &&
        !containsMerchantToken(headerMerchant, extractedMerchant)
      ) {
        return extractedMerchant;
      }
      return headerMerchant;
    }
    if (extractedMerchant && !isRegistryFooterMerchant(extractedMerchant)) {
      return extractedMerchant;
    }
    return undefined;
  }

  if (extractedMerchant) return extractedMerchant;
  return headerMerchant;
}

function inferSupplierFromHeader(text: string): string | undefined {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  for (const line of lines.slice(0, 4)) {
    if (INVOICE_HEADER_SKIP_PATTERN.test(line)) continue;
    if (isLikelyAmountLine(line)) continue;
    if (isLikelyDateLine(line)) continue;
    if (/^\d{5}\b/.test(line)) continue;
    if (line.length >= 3) return line;
  }

  return undefined;
}

function resolveRecognizedDataFamily(
  kind: ClassifiedDocumentKind,
): RecognizedDataFamily | null {
  if (!isOcrOnlyRecognizedDataKind(kind)) {
    return null;
  }
  return OCR_ONLY_KIND_FAMILY[kind];
}

function extractDocumentFeaturesFromText(
  text: string,
  pageTexts?: DocumentClassificationInput['pageTexts'],
) {
  return extractDocumentFeatures(zoneDocumentText(text, pageTexts));
}

function applyReceiptOcrAmount(
  result: Record<string, string>,
  plain: ReturnType<typeof toConfidentPlainFields>,
  text: string,
  pageTexts?: DocumentClassificationInput['pageTexts'],
): void {
  const features = extractDocumentFeaturesFromText(text, pageTexts);

  const labeledTotal = features.features.find((feature) => feature.id === 'amount.labeled_total');
  if (labeledTotal && typeof labeledTotal.value === 'number' && labeledTotal.value > 0) {
    result.Betrag = formatGermanMoney(labeledTotal.value);
    return;
  }

  const monetaryValues = features.features
    .filter(
      (feature) => feature.id === 'amount.monetary_value' && typeof feature.value === 'number',
    )
    .map((feature) => feature.value as number);
  if (monetaryValues.length > 0) {
    result.Betrag = formatGermanMoney(Math.max(...monetaryValues));
    return;
  }

  if (plain.Betrag?.trim()) {
    result.Betrag = plain.Betrag;
  }
}

function applyInvoiceOcrAmount(
  result: Record<string, string>,
  text: string,
  pageTexts?: DocumentClassificationInput['pageTexts'],
): void {
  const features = extractDocumentFeaturesFromText(text, pageTexts);

  const labeledTotal = features.features.find((feature) => feature.id === 'amount.labeled_total');
  if (labeledTotal && typeof labeledTotal.value === 'number' && labeledTotal.value > 0) {
    result.Betrag = formatGermanMoney(labeledTotal.value);
    return;
  }

  const resolvedInvoiceAmount = resolveInvoiceAmount(text);
  if (resolvedInvoiceAmount.status === 'confirmed' && resolvedInvoiceAmount.value) {
    result.Betrag = formatGermanMoney(resolvedInvoiceAmount.value);
    return;
  }

  const totalLineMatch = text.match(INVOICE_TOTAL_LINE_PATTERN);
  if (totalLineMatch?.[1]) {
    result.Betrag = formatGermanMoney(
      Number.parseFloat(totalLineMatch[1].replace(/\./g, '').replace(',', '.')),
    );
  }
}

function applyOcrReceiptNumber(
  result: Record<string, string>,
  plain: ReturnType<typeof toConfidentPlainFields>,
  text: string,
  pageTexts?: DocumentClassificationInput['pageTexts'],
): void {
  if (plain.Rechnungsnummer?.trim()) {
    result.Belegnummer = plain.Rechnungsnummer;
    return;
  }

  const receiptNumberMatch = text.match(RECEIPT_NUMBER_PATTERN);
  if (receiptNumberMatch?.[1]?.trim()) {
    result.Belegnummer = receiptNumberMatch[1].trim();
    return;
  }

  const features = extractDocumentFeaturesFromText(text, pageTexts);
  const receiptNumberFeature = features.features.find(
    (feature) => feature.id === 'reference.invoice_number',
  );
  if (typeof receiptNumberFeature?.value === 'string' && receiptNumberFeature.value.trim()) {
    result.Belegnummer = receiptNumberFeature.value.trim();
  }
}

function applyInvoiceOcrReference(
  result: Record<string, string>,
  plain: ReturnType<typeof toConfidentPlainFields>,
  text: string,
  pageTexts?: DocumentClassificationInput['pageTexts'],
): void {
  if (plain.Rechnungsnummer?.trim()) {
    result.Rechnungsnummer = plain.Rechnungsnummer;
    return;
  }

  const features = extractDocumentFeaturesFromText(text, pageTexts);
  const invoiceNumberFeature = features.features.find(
    (feature) => feature.id === 'reference.invoice_number',
  );
  if (typeof invoiceNumberFeature?.value === 'string' && invoiceNumberFeature.value.trim()) {
    result.Rechnungsnummer = invoiceNumberFeature.value.trim();
  }
}

function applyInvoiceOcrDeadline(
  result: Record<string, string>,
  plain: ReturnType<typeof toConfidentPlainFields>,
  text: string,
  pageTexts?: DocumentClassificationInput['pageTexts'],
): void {
  if (plain.Frist?.trim()) {
    result.Frist = plain.Frist;
    return;
  }

  const features = extractDocumentFeaturesFromText(text, pageTexts);
  const deadlineFeature = features.features.find((feature) => feature.id === 'date.deadline_date');
  if (typeof deadlineFeature?.value === 'string' && deadlineFeature.value.trim()) {
    result.Frist = deadlineFeature.value.trim();
  }
}

function buildReceiptRecognizedData(
  kind: ReceiptCutoverKind,
  text: string,
  pageTexts?: DocumentClassificationInput['pageTexts'],
): Record<string, string> {
  const receiptConfig = RECEIPT_RECOGNIZED_DATA_CONFIG[kind];
  const result: Record<string, string> = { Dokumentart: kind };
  const fieldsWithConfidence = extractFieldsWithConfidence(text);
  const plain = toConfidentPlainFields(fieldsWithConfidence);

  applyReceiptOcrAmount(result, plain, text, pageTexts);

  if (plain.Datum?.trim()) {
    result.Datum = plain.Datum;
  }

  applyOcrReceiptNumber(result, plain, text, pageTexts);

  const merchant = resolveReceiptMerchant(kind, plain, text);
  if (merchant) {
    result[receiptConfig.merchantField] = merchant;
  }

  return result;
}

function buildInvoiceRecognizedData(
  text: string,
  pageTexts?: DocumentClassificationInput['pageTexts'],
): Record<string, string> {
  const result: Record<string, string> = { Dokumentart: 'eingangsrechnung' };
  const fieldsWithConfidence = extractFieldsWithConfidence(text);
  const plain = toConfidentPlainFields(fieldsWithConfidence);

  applyInvoiceOcrReference(result, plain, text, pageTexts);
  applyInvoiceOcrAmount(result, text, pageTexts);

  if (plain.Datum?.trim()) {
    result.Datum = plain.Datum;
  }

  applyInvoiceOcrDeadline(result, plain, text, pageTexts);

  const supplier = plain.Absender ?? plain.Lieferant;
  if (supplier?.trim()) {
    result.Lieferant = supplier;
    result.Absender = supplier;
  } else {
    const supplierFromHeader = inferSupplierFromHeader(text);
    if (supplierFromHeader) {
      result.Lieferant = supplierFromHeader;
    }
  }

  if (plain.Baustelle?.trim()) {
    result.Baustelle = plain.Baustelle.trim();
  }
  if (plain.Projekt?.trim()) {
    result.Projekt = plain.Projekt.trim();
    result.Bauvorhaben = plain.Projekt.trim();
  }
  if (plain.Vorgang?.trim()) {
    result.Vorgang = plain.Vorgang.trim();
  }

  return result;
}

function inferSupplierFromPaymentHeader(text: string): string | undefined {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  for (const line of lines.slice(0, 4)) {
    if (PAYMENT_HEADER_SKIP_PATTERN.test(line)) continue;
    if (isLikelyAmountLine(line)) continue;
    if (isLikelyDateLine(line)) continue;
    if (/^\d{5}\b/.test(line)) continue;
    if (line.length >= 3) return line;
  }

  return undefined;
}

function applyPaymentOcrAmount(
  result: Record<string, string>,
  text: string,
  pageTexts?: DocumentClassificationInput['pageTexts'],
): void {
  const features = extractDocumentFeaturesFromText(text, pageTexts);
  const monetaryValues = features.features
    .filter(
      (feature) => feature.id === 'amount.monetary_value' && typeof feature.value === 'number',
    )
    .map((feature) => feature.value as number);

  if (monetaryValues.length > 0) {
    result.Betrag = formatGermanMoney(Math.max(...monetaryValues));
  }
}

function applyPaymentOcrReference(
  result: Record<string, string>,
  plain: ReturnType<typeof toConfidentPlainFields>,
  text: string,
  pageTexts?: DocumentClassificationInput['pageTexts'],
): void {
  if (plain.Rechnungsnummer?.trim()) {
    result.Rechnungsnummer = plain.Rechnungsnummer;
    return;
  }

  const features = extractDocumentFeaturesFromText(text, pageTexts);
  const invoiceNumberFeature = features.features.find(
    (feature) => feature.id === 'reference.invoice_number',
  );
  if (typeof invoiceNumberFeature?.value === 'string' && invoiceNumberFeature.value.trim()) {
    result.Rechnungsnummer = invoiceNumberFeature.value.trim();
  }
}

function applyPaymentOcrDeadline(
  result: Record<string, string>,
  plain: ReturnType<typeof toConfidentPlainFields>,
  text: string,
  pageTexts?: DocumentClassificationInput['pageTexts'],
): void {
  if (plain.Frist?.trim()) {
    result.Fälligkeit = plain.Frist;
    return;
  }

  const features = extractDocumentFeaturesFromText(text, pageTexts);
  const deadlineFeature = features.features.find((feature) => feature.id === 'date.deadline_date');
  if (typeof deadlineFeature?.value === 'string' && deadlineFeature.value.trim()) {
    result.Fälligkeit = deadlineFeature.value.trim();
  }
}

function inferPaymentHint(text: string): string | undefined {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  for (const line of lines) {
    const match = line.match(PAYMENT_HINT_PATTERN);
    if (match?.[1]) {
      return match[1].trim();
    }
    if (match?.[0]) {
      return match[0].trim();
    }
  }

  return undefined;
}

function buildPaymentRecognizedData(
  kind: PaymentCutoverKind,
  text: string,
  pageTexts?: DocumentClassificationInput['pageTexts'],
): Record<string, string> {
  const result: Record<string, string> = { Dokumentart: kind };
  const fieldsWithConfidence = extractFieldsWithConfidence(text);
  const plain = toConfidentPlainFields(fieldsWithConfidence);

  applyPaymentOcrReference(result, plain, text, pageTexts);
  applyPaymentOcrAmount(result, text, pageTexts);

  if (plain.Datum?.trim()) {
    result.Datum = plain.Datum;
  }

  applyPaymentOcrDeadline(result, plain, text, pageTexts);

  const supplier = plain.Absender ?? plain.Lieferant;
  if (supplier?.trim()) {
    result.Lieferant = supplier;
  } else {
    const supplierFromHeader = inferSupplierFromPaymentHeader(text);
    if (supplierFromHeader) {
      result.Lieferant = supplierFromHeader;
    }
  }

  const hint = inferPaymentHint(text);
  if (hint) {
    result.Hinweis = hint;
  }

  return result;
}

function isLikelyStreetLine(line: string): boolean {
  return /\b(?:straße|strasse|str\.|weg|platz|allee|gasse|ring)\b/i.test(line);
}

function inferAuthorityFromHeader(text: string): string | undefined {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  for (const line of lines.slice(0, 4)) {
    if (AUTHORITY_MARKER_LINE_PATTERN.test(line)) {
      return line;
    }
  }

  for (const line of lines.slice(0, 4)) {
    if (AUTHORITY_HEADER_SKIP_PATTERN.test(line)) continue;
    if (isLikelyDateLine(line)) continue;
    if (isLikelyStreetLine(line)) continue;
    if (/^\d{5}\b/.test(line)) continue;
    if (line.length >= 3) return line;
  }

  return undefined;
}

function isNoisyAuthoritySenderLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return true;
  if (OCR_SENDER_NOISE_PATTERN.test(trimmed) && !BA_AUTHORITY_NAME_PATTERN.test(trimmed)) {
    return true;
  }
  if (/^seite\b/i.test(trimmed)) return true;
  return false;
}

function resolveAgenturFuerArbeitSender(text: string): string | undefined {
  if (BA_AUTHORITY_NAME_PATTERN.test(text)) {
    return BUNDESAGENTUR_CANONICAL_SENDER;
  }
  return undefined;
}

function applyAuthorityOcrSender(
  result: Record<string, string>,
  plain: ReturnType<typeof toConfidentPlainFields>,
  text: string,
  pageTexts?: DocumentClassificationInput['pageTexts'],
  kind?: AuthorityCutoverKind,
): void {
  if (kind === 'agentur_fuer_arbeit') {
    const agenturSender = resolveAgenturFuerArbeitSender(text);
    if (agenturSender) {
      result.Absender = agenturSender;
    }
    return;
  }

  const features = extractDocumentFeaturesFromText(text, pageTexts);
  const authorityLetter = features.features.find((feature) => feature.id === 'structure.authority_letter');
  const authorityLetterValue = authorityLetter?.rawValue?.trim();
  if (authorityLetterValue && !isNoisyAuthoritySenderLine(authorityLetterValue)) {
    if (BA_AUTHORITY_NAME_PATTERN.test(authorityLetterValue)) {
      result.Absender = BUNDESAGENTUR_CANONICAL_SENDER;
      return;
    }
    // The structure feature keeps the raw header line, so normalise here. Only a safe
    // cleaned value may be written — never undefined or raw text over an already clean
    // Absender that buildAuthorityRecognizedData set from the extracted fields.
    const cleanedAuthority = cleanLetterheadCandidate(authorityLetterValue);
    if (cleanedAuthority) {
      result.Absender = cleanedAuthority;
      return;
    }
  }

  const labeledAuthority = plain.Absender ?? plain.Lieferant;
  if (
    labeledAuthority?.trim() &&
    !isLikelyStreetLine(labeledAuthority) &&
    !isNoisyAuthoritySenderLine(labeledAuthority)
  ) {
    result.Absender = labeledAuthority;
    return;
  }

  const authorityFromHeader = inferAuthorityFromHeader(text);
  if (authorityFromHeader && !isNoisyAuthoritySenderLine(authorityFromHeader)) {
    if (BA_AUTHORITY_NAME_PATTERN.test(authorityFromHeader)) {
      result.Absender = BUNDESAGENTUR_CANONICAL_SENDER;
      return;
    }
    result.Absender = authorityFromHeader;
  }
}

function applyAuthorityOcrReference(
  result: Record<string, string>,
  plain: ReturnType<typeof toConfidentPlainFields>,
  text: string,
  pageTexts?: DocumentClassificationInput['pageTexts'],
): void {
  if (plain.Aktenzeichen?.trim()) {
    result.Aktenzeichen = plain.Aktenzeichen;
    return;
  }

  const features = extractDocumentFeaturesFromText(text, pageTexts);
  const caseReferenceFeature = features.features.find(
    (feature) => feature.id === 'reference.case_reference',
  );
  if (typeof caseReferenceFeature?.value === 'string' && caseReferenceFeature.value.trim()) {
    result.Aktenzeichen = caseReferenceFeature.value.trim();
  }
}

function applyAuthorityOcrDeadline(
  result: Record<string, string>,
  plain: ReturnType<typeof toConfidentPlainFields>,
  text: string,
  pageTexts?: DocumentClassificationInput['pageTexts'],
): void {
  if (plain.Frist?.trim()) {
    result.Frist = plain.Frist;
    return;
  }

  const features = extractDocumentFeaturesFromText(text, pageTexts);
  const deadlineFeature = features.features.find((feature) => feature.id === 'date.deadline_date');
  if (typeof deadlineFeature?.value === 'string' && deadlineFeature.value.trim()) {
    result.Frist = deadlineFeature.value.trim();
  }
}

function applyAuthorityOcrLabeledAmount(
  result: Record<string, string>,
  text: string,
  pageTexts?: DocumentClassificationInput['pageTexts'],
): void {
  const features = extractDocumentFeaturesFromText(text, pageTexts);
  const labeledTotal = features.features.find((feature) => feature.id === 'amount.labeled_total');
  if (labeledTotal && typeof labeledTotal.value === 'number' && labeledTotal.value > 0) {
    result.Betrag = formatGermanMoney(labeledTotal.value);
  }
}

function buildCertificateRecognizedData(
  kind: CertificateCutoverKind,
  text: string,
  pageTexts?: DocumentClassificationInput['pageTexts'],
): Record<string, string> {
  const result: Record<string, string> = { Dokumentart: kind };
  const fieldsWithConfidence = extractFieldsWithConfidence(text);
  const plain = toConfidentPlainFields(fieldsWithConfidence);

  if (plain.Betreff?.trim()) {
    result.Betreff = plain.Betreff;
  } else {
    const subjectLine = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => /^betreff\s*[:]/i.test(line));
    if (subjectLine) {
      result.Betreff = subjectLine.replace(/^betreff\s*[:]\s*/i, '').trim();
    }
  }

  applyCertificateOcrValidUntil(result, text, pageTexts);

  if (plain.Datum?.trim()) {
    result.Datum = plain.Datum;
  }

  const issuer = plain.Absender ?? plain.Lieferant;
  if (issuer?.trim()) {
    result.Aussteller = issuer;
  } else {
    const issuerFromHeader = inferCertificateIssuerFromHeader(text);
    if (issuerFromHeader) {
      result.Aussteller = issuerFromHeader;
    }
  }

  return result;
}

function inferCertificateIssuerFromHeader(text: string): string | undefined {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  for (const line of lines.slice(0, 4)) {
    if (CERTIFICATE_HEADER_SKIP_PATTERN.test(line)) continue;
    if (isLikelyDateLine(line)) continue;
    if (/^\d{5}\b/.test(line)) continue;
    if (/^§48/i.test(line)) continue;
    if (line.length >= 3) return line;
  }

  return undefined;
}

function applyCertificateOcrValidUntil(
  result: Record<string, string>,
  text: string,
  pageTexts?: DocumentClassificationInput['pageTexts'],
): void {
  const features = extractDocumentFeaturesFromText(text, pageTexts);
  const validUntilFeature = features.features.find((feature) => feature.id === 'date.valid_until');
  if (typeof validUntilFeature?.value === 'string' && validUntilFeature.value.trim()) {
    result.Gültig_bis = validUntilFeature.value.trim();
  }
}

function pickLabeledContractValue(text: string, pattern: RegExp): string | undefined {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    const match = trimmed.match(pattern);
    if (match?.[1]?.trim()) {
      return match[1].trim();
    }
  }
  // Flattened PDF text layers often lack line breaks — allow mid-string labels.
  const flags = pattern.flags.includes('i') ? 'iu' : 'u';
  const source = pattern.source.startsWith('^') ? pattern.source.slice(1) : pattern.source;
  const inline = new RegExp(String.raw`(?:^|[\n\r]|[\s·|])${source}`, flags);
  const match = text.match(inline);
  return match?.[1]?.trim() || undefined;
}

function applyContractOcrReference(
  result: Record<string, string>,
  plain: ReturnType<typeof toConfidentPlainFields>,
  text: string,
  pageTexts?: DocumentClassificationInput['pageTexts'],
): void {
  if (plain.Aktenzeichen?.trim()) {
    result.Auftragsnummer = plain.Aktenzeichen;
    return;
  }

  const features = extractDocumentFeaturesFromText(text, pageTexts);
  const caseReferenceFeature = features.features.find(
    (feature) => feature.id === 'reference.case_reference',
  );
  if (typeof caseReferenceFeature?.value === 'string' && caseReferenceFeature.value.trim()) {
    result.Auftragsnummer = caseReferenceFeature.value.trim();
  }
}

function applyContractOcrDate(
  result: Record<string, string>,
  text: string,
  pageTexts?: DocumentClassificationInput['pageTexts'],
): void {
  const features = extractDocumentFeaturesFromText(text, pageTexts);
  const contractDateFeature = features.features.find((feature) => feature.id === 'date.contract_date');
  if (typeof contractDateFeature?.value === 'string' && contractDateFeature.value.trim()) {
    result.Vertragsdatum = contractDateFeature.value.trim();
  }
}

function buildCustomerRecognizedData(
  kind: CustomerCutoverKind,
  text: string,
  pageTexts?: DocumentClassificationInput['pageTexts'],
): Record<string, string> {
  const result: Record<string, string> = { Dokumentart: kind };
  const fieldsWithConfidence = extractFieldsWithConfidence(text);
  const plain = toConfidentPlainFields(fieldsWithConfidence);

  if (plain.Betreff?.trim()) {
    result.Betreff = plain.Betreff;
  }

  const labeledCustomer =
    pickLabeledContractValue(text, CUSTOMER_PARTY_PATTERN) ??
    plain.Kunde?.trim() ??
    plain.Empfänger?.trim() ??
    undefined;
  if (typeof labeledCustomer === 'string' && labeledCustomer.trim()) {
    result.Kunde = labeledCustomer.trim();
    result.Auftraggeber = labeledCustomer.trim();
  }

  const baustelle =
    pickLabeledContractValue(text, CUSTOMER_BAUSTELLE_PATTERN) ?? plain.Baustelle?.trim();
  if (baustelle) {
    result.Baustelle = baustelle;
  }

  if (plain.Projekt?.trim()) {
    result.Projekt = plain.Projekt.trim();
    result.Bauvorhaben = plain.Projekt.trim();
  }
  if (plain.Vorgang?.trim()) {
    result.Vorgang = plain.Vorgang.trim();
  }
  if (plain.Gewerk?.trim()) {
    result.Gewerk = plain.Gewerk.trim();
  }
  if (plain.Absender?.trim()) {
    result.Absender = plain.Absender.trim();
    result.Lieferant = plain.Absender.trim();
  }

  const features = extractDocumentFeaturesFromText(text, pageTexts);
  const caseReferenceFeature = features.features.find(
    (feature) => feature.id === 'reference.case_reference',
  );
  if (typeof caseReferenceFeature?.value === 'string' && caseReferenceFeature.value.trim()) {
    if (kind === 'angebot') {
      result.Angebotsnummer = caseReferenceFeature.value.trim();
    } else {
      result.Auftragsnummer = caseReferenceFeature.value.trim();
    }
  }

  if (kind === 'angebot') {
    const angebotssumme = pickLabeledContractValue(text, CUSTOMER_ANGEBOTSSUMME_PATTERN);
    if (angebotssumme) {
      result.Angebotssumme = angebotssumme;
    }
  } else {
    const auftragssumme = pickLabeledContractValue(text, CUSTOMER_AUFTRAGSSUMME_PATTERN);
    if (auftragssumme) {
      result.Auftragssumme = auftragssumme;
    }
  }

  if (plain.Datum?.trim()) {
    result.Datum = plain.Datum;
  } else {
    const documentDateFeature = features.features.find((feature) => feature.id === 'date.document_date');
    if (typeof documentDateFeature?.value === 'string' && documentDateFeature.value.trim()) {
      result.Datum = documentDateFeature.value.trim();
    }
  }

  return result;
}

function buildContractRecognizedData(
  kind: ContractCutoverKind,
  text: string,
  pageTexts?: DocumentClassificationInput['pageTexts'],
): Record<string, string> {
  const result: Record<string, string> = { Dokumentart: kind };
  const fieldsWithConfidence = extractFieldsWithConfidence(text);
  const plain = toConfidentPlainFields(fieldsWithConfidence);

  if (plain.Betreff?.trim()) {
    result.Betreff = plain.Betreff;
  }

  const auftraggeber =
    pickLabeledContractValue(text, CONTRACT_AUFTRAGGEBER_PATTERN) ??
    plain.Kunde?.trim() ??
    undefined;
  if (auftraggeber) {
    result.Kunde = auftraggeber;
    result.Auftraggeber = auftraggeber;
  }
  // Do not fall back to Absender/letterhead as customer — that is the contractor/issuer.

  if (plain.Projekt?.trim()) {
    result.Projekt = plain.Projekt.trim();
    result.Bauvorhaben = plain.Projekt.trim();
  }
  if (plain.Gewerk?.trim()) {
    result.Gewerk = plain.Gewerk.trim();
  }
  if (plain.Vorgang?.trim()) {
    result.Vorgang = plain.Vorgang.trim();
  }
  if (plain.Absender?.trim()) {
    result.Absender = plain.Absender.trim();
    result.Auftragnehmer = result.Auftragnehmer ?? plain.Absender.trim();
  }

  const auftragnehmer = pickLabeledContractValue(text, CONTRACT_AUFTRAGNEHMER_PATTERN);
  if (auftragnehmer) {
    result.Auftragnehmer = auftragnehmer;
  }

  const baustellenadresse = pickLabeledContractValue(
    text,
    /^(?:baustellenadresse|baustelle)\s*[:]\s*(.+)$/i,
  );
  if (baustellenadresse) {
    result.Baustelle = baustellenadresse;
  } else if (plain.Baustelle?.trim()) {
    result.Baustelle = plain.Baustelle;
  } else {
    const bauvorhaben = pickLabeledContractValue(text, /^bauvorhaben\s*[:]\s*(.+)$/i);
    // Bauvorhaben is a project title — keep as Bauvorhaben/Projekt, not as site.
    if (bauvorhaben) {
      result.Bauvorhaben = result.Bauvorhaben ?? bauvorhaben;
      result.Projekt = result.Projekt ?? bauvorhaben;
    }
  }

  applyContractOcrDate(result, text, pageTexts);
  applyContractOcrReference(result, plain, text, pageTexts);

  return result;
}

function buildAuthorityRecognizedData(
  kind: AuthorityCutoverKind,
  text: string,
  pageTexts?: DocumentClassificationInput['pageTexts'],
): Record<string, string> {
  const result: Record<string, string> = { Dokumentart: kind };
  const fieldsWithConfidence = extractFieldsWithConfidence(text);
  const plain = toConfidentPlainFields(fieldsWithConfidence);

  if (plain.Betreff?.trim()) {
    result.Betreff = plain.Betreff;
  }
  if (plain.Absender?.trim() && kind !== 'agentur_fuer_arbeit') {
    result.Absender = plain.Absender.trim();
    result.Lieferant = plain.Absender.trim();
  }
  if (plain.Aktenzeichen?.trim()) {
    result.Aktenzeichen = plain.Aktenzeichen.trim();
  }

  applyAuthorityOcrReference(result, plain, text, pageTexts);
  applyAuthorityOcrDeadline(result, plain, text, pageTexts);
  applyAuthorityOcrLabeledAmount(result, text, pageTexts);
  applyAuthorityOcrSender(result, plain, text, pageTexts, kind);

  if (plain.Datum?.trim()) {
    result.Datum = plain.Datum;
  }

  return result;
}

export function shouldUseEvidenceBasedRecognizedData(kind: ClassifiedDocumentKind): boolean {
  return isOcrOnlyRecognizedDataKind(kind) && getOcrOnlyRecognizedDataEnabled();
}

export function buildEvidenceBasedRecognizedData(
  input: EvidenceBasedRecognizedDataInput,
): Record<string, string> {
  const family = resolveRecognizedDataFamily(input.classifiedKind);
  const result: Record<string, string> = {
    Dokumentart: input.classifiedKind,
  };

  if (!family) {
    return result;
  }

  const text = buildCanonicalDocumentText(input.recognizedText, input.pageTexts);
  if (!text.trim()) {
    return result;
  }

  if (family === 'receipt') {
    return buildReceiptRecognizedData(input.classifiedKind as ReceiptCutoverKind, text, input.pageTexts);
  }

  if (family === 'invoice') {
    return buildInvoiceRecognizedData(text, input.pageTexts);
  }

  if (family === 'payment') {
    return buildPaymentRecognizedData(input.classifiedKind as PaymentCutoverKind, text, input.pageTexts);
  }

  if (family === 'certificate') {
    return buildCertificateRecognizedData(
      input.classifiedKind as CertificateCutoverKind,
      text,
      input.pageTexts,
    );
  }

  if (family === 'contract') {
    return buildContractRecognizedData(
      input.classifiedKind as ContractCutoverKind,
      text,
      input.pageTexts,
    );
  }

  if (family === 'customer') {
    return buildCustomerRecognizedData(
      input.classifiedKind as CustomerCutoverKind,
      text,
      input.pageTexts,
    );
  }

  return buildAuthorityRecognizedData(input.classifiedKind as AuthorityCutoverKind, text, input.pageTexts);
}
