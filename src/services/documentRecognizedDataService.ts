import type { ClassifiedDocumentKind } from '../types/models';
import type { DocumentClassificationInput } from '../types/models';
import type { AuthorityCutoverKind, CertificateCutoverKind, ContractCutoverKind, OcrOnlyRecognizedDataKind, PaymentCutoverKind, ReceiptCutoverKind } from '../config/documentIntelligenceConfig';
import {
  getOcrOnlyRecognizedDataEnabled,
  isOcrOnlyRecognizedDataKind,
} from '../config/documentIntelligenceConfig';
import {
  formatGermanMoney,
  resolveInvoiceAmount,
} from './documentAmountExtractionService';
import {
  extractFieldsWithConfidence,
  toConfidentPlainFields,
} from './documentFieldExtractionService';
import { extractDocumentFeatures } from './documentFeatureExtractionService';
import { buildCanonicalDocumentText, zoneDocumentText } from './documentZoningService';

export type EvidenceBasedRecognizedDataInput = {
  classifiedKind: ClassifiedDocumentKind;
  recognizedText?: string;
  pageTexts?: DocumentClassificationInput['pageTexts'];
};

type RecognizedDataFamily = 'receipt' | 'invoice' | 'payment' | 'authority' | 'certificate' | 'contract';

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
  freistellungsbescheinigung: 'certificate',
  unbedenklichkeitsbescheinigung: 'certificate',
  werkvertrag: 'contract',
  subunternehmervertrag: 'contract',
  nachunternehmervertrag: 'contract',
};


const CONTRACT_AUFTRAGGEBER_PATTERN = /^auftraggeber(?:in)?\s*[:]\s*(.+)$/i;
const CONTRACT_AUFTRAGNEHMER_PATTERN =
  /^(?:auftragnehmer|subunternehmer|nachunternehmer)\s*[:]\s*(.+)$/i;

const CERTIFICATE_HEADER_SKIP_PATTERN =
  /^(?:Betreff|Aussteller|Datum|gültig bis|gueltig bis|Gültigkeit|Gueltigkeit|Freistellungsbescheinigung|Unbedenklichkeitsbescheinigung|§48b)\s*[:]/i;

const AUTHORITY_HEADER_SKIP_PATTERN =
  /^(?:Betreff|Aktenzeichen|Az\.|Datum|Frist|Beitragsbescheid|Festsetzung|Steuernummer|USt|MwSt)\s*[:]/i;

const AUTHORITY_MARKER_LINE_PATTERN =
  /\b(finanzamt|steueramt|steuerbescheid|bg[\s-]?bau|berufsgenossenschaft|zollamt|sozialversicherung|agentur\s+für\s+arbeit|jobcenter|stadtverwaltung|gemeindeverwaltung|landratsamt|ordnungsamt)\b/i;

const PAYMENT_HEADER_SKIP_PATTERN =
  /^(?:Rechnungs(?:nummer|nr)|Invoice|Inv\.|Mahnung|Zahlungserinnerung|Zahlungsaufforderung|Inkasso|Datum|Offener\s+Betrag|IBAN|zu\s+zahlen|zahlbar|Fälligkeit|Faelligkeit)/i;

const PAYMENT_HINT_PATTERN =
  /\b(\d+\.\s*mahnung|mahnung|zahlungserinnerung|zahlungsaufforderung|inkasso)\b/i;

const RECEIPT_HEADER_SKIP_PATTERN =
  /^(?:HRB|Amtsgericht|Geschäftsf|Geschaeftsf|Kartenzahlung|Vielen Dank|Danke|Girocard|Mastercard|Visa|EC-Karte|Terminal|Summe|Bar\s+gezahlt|Barzahlung)/i;

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

function inferMerchantFromHeader(text: string): string | undefined {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  for (const line of lines.slice(0, 4)) {
    if (RECEIPT_HEADER_SKIP_PATTERN.test(line)) continue;
    if (/^kassenbeleg$/i.test(line)) continue;
    if (isLikelyAmountLine(line) && !/tankstelle|markt|bäckerei|baeckerei|shop|store/i.test(line)) {
      continue;
    }
    if (isLikelyDateLine(line)) continue;
    if (line.length >= 3) return line;
  }

  return undefined;
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

  const merchant = plain.Absender ?? plain.Lieferant;
  if (merchant?.trim()) {
    result[receiptConfig.merchantField] = merchant;
  } else {
    const merchantFromHeader = inferMerchantFromHeader(text);
    if (merchantFromHeader) {
      result[receiptConfig.merchantField] = merchantFromHeader;
    }
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
  } else {
    const supplierFromHeader = inferSupplierFromHeader(text);
    if (supplierFromHeader) {
      result.Lieferant = supplierFromHeader;
    }
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

function applyAuthorityOcrSender(
  result: Record<string, string>,
  plain: ReturnType<typeof toConfidentPlainFields>,
  text: string,
  pageTexts?: DocumentClassificationInput['pageTexts'],
): void {
  const features = extractDocumentFeaturesFromText(text, pageTexts);
  const authorityLetter = features.features.find((feature) => feature.id === 'structure.authority_letter');
  if (authorityLetter?.rawValue?.trim()) {
    result.Absender = authorityLetter.rawValue.trim();
    return;
  }

  const labeledAuthority = plain.Absender ?? plain.Lieferant;
  if (labeledAuthority?.trim() && !isLikelyStreetLine(labeledAuthority)) {
    result.Absender = labeledAuthority;
    return;
  }

  const authorityFromHeader = inferAuthorityFromHeader(text);
  if (authorityFromHeader) {
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
  return undefined;
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

  const auftraggeber = pickLabeledContractValue(text, CONTRACT_AUFTRAGGEBER_PATTERN);
  if (auftraggeber) {
    result.Kunde = auftraggeber;
    result.Auftraggeber = auftraggeber;
  } else if (plain.Absender?.trim()) {
    result.Kunde = plain.Absender;
    result.Auftraggeber = plain.Absender;
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
    if (bauvorhaben) {
      result.Baustelle = bauvorhaben;
    } else if (plain.Projekt?.trim()) {
      result.Baustelle = plain.Projekt;
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

  applyAuthorityOcrReference(result, plain, text, pageTexts);
  applyAuthorityOcrDeadline(result, plain, text, pageTexts);
  applyAuthorityOcrLabeledAmount(result, text, pageTexts);
  applyAuthorityOcrSender(result, plain, text, pageTexts);

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

  return buildAuthorityRecognizedData(input.classifiedKind as AuthorityCutoverKind, text, input.pageTexts);
}
