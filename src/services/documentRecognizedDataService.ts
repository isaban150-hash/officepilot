import type { ClassifiedDocumentKind } from '../types/models';
import type { DocumentClassificationInput } from '../types/models';
import type { ReceiptCutoverKind } from '../config/documentIntelligenceConfig';
import {
  getOcrOnlyRecognizedDataEnabled,
  isOcrOnlyRecognizedDataKind,
} from '../config/documentIntelligenceConfig';
import { formatGermanMoney } from './documentAmountExtractionService';
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

type ReceiptRecognizedDataConfig = {
  merchantField: string;
};

const RECEIPT_RECOGNIZED_DATA_CONFIG: Record<ReceiptCutoverKind, ReceiptRecognizedDataConfig> = {
  tankbeleg: { merchantField: 'Tankstelle' },
  ec_beleg: { merchantField: 'Lieferant' },
  kassenbeleg: { merchantField: 'Lieferant' },
};

const HEADER_SKIP_PATTERN =
  /^(?:HRB|Amtsgericht|Geschäftsf|Geschaeftsf|Kartenzahlung|Vielen Dank|Danke|Girocard|Mastercard|Visa|EC-Karte|Terminal|Summe|Bar\s+gezahlt|Barzahlung)/i;

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
    if (HEADER_SKIP_PATTERN.test(line)) continue;
    if (/^kassenbeleg$/i.test(line)) continue;
    if (isLikelyAmountLine(line) && !/tankstelle|markt|bäckerei|baeckerei|shop|store/i.test(line)) {
      continue;
    }
    if (isLikelyDateLine(line)) continue;
    if (line.length >= 3) return line;
  }

  return undefined;
}

function resolveReceiptConfig(
  kind: ClassifiedDocumentKind,
): ReceiptRecognizedDataConfig | null {
  if (!isOcrOnlyRecognizedDataKind(kind)) {
    return null;
  }
  return RECEIPT_RECOGNIZED_DATA_CONFIG[kind];
}

function applyOcrAmount(
  result: Record<string, string>,
  plain: ReturnType<typeof toConfidentPlainFields>,
  text: string,
  pageTexts?: DocumentClassificationInput['pageTexts'],
): void {
  const zoned = zoneDocumentText(text, pageTexts);
  const features = extractDocumentFeatures(zoned);

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

const RECEIPT_NUMBER_PATTERN =
  /\b(?:beleg[\s-]*nr\.?|belegnummer)\s*[:#]?\s*([A-Z0-9][\w./-]{2,})/i;

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

  const zoned = zoneDocumentText(text, pageTexts);
  const features = extractDocumentFeatures(zoned);
  const receiptNumberFeature = features.features.find(
    (feature) => feature.id === 'reference.invoice_number',
  );
  if (typeof receiptNumberFeature?.value === 'string' && receiptNumberFeature.value.trim()) {
    result.Belegnummer = receiptNumberFeature.value.trim();
  }
}

export function shouldUseEvidenceBasedRecognizedData(kind: ClassifiedDocumentKind): boolean {
  return isOcrOnlyRecognizedDataKind(kind) && getOcrOnlyRecognizedDataEnabled();
}

export function buildEvidenceBasedRecognizedData(
  input: EvidenceBasedRecognizedDataInput,
): Record<string, string> {
  const receiptConfig = resolveReceiptConfig(input.classifiedKind);
  const result: Record<string, string> = {
    Dokumentart: input.classifiedKind,
  };

  if (!receiptConfig) {
    return result;
  }

  const text = buildCanonicalDocumentText(input.recognizedText, input.pageTexts);
  if (!text.trim()) {
    return result;
  }

  const fieldsWithConfidence = extractFieldsWithConfidence(text);
  const plain = toConfidentPlainFields(fieldsWithConfidence);

  applyOcrAmount(result, plain, text, input.pageTexts);

  if (plain.Datum?.trim()) {
    result.Datum = plain.Datum;
  }

  applyOcrReceiptNumber(result, plain, text, input.pageTexts);

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
