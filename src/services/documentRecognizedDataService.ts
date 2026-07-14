import type { ClassifiedDocumentKind } from '../types/models';
import type { DocumentClassificationInput } from '../types/models';
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

const HEADER_SKIP_PATTERN =
  /^(?:HRB|Amtsgericht|Geschäftsf|Geschaeftsf|Kartenzahlung|Vielen Dank|Danke|Girocard|Mastercard|Visa|EC-Karte)/i;

function isLikelyAmountLine(line: string): boolean {
  return /\d{1,3}(?:[.\s]\d{3})*,\d{2}\s*(?:€|EUR|eur)?\b/i.test(line);
}

function isLikelyDateLine(line: string): boolean {
  return /\b\d{1,2}[./]\d{1,2}[./]\d{2,4}\b/.test(line);
}

function inferTankStationFromText(text: string): string | undefined {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  for (const line of lines.slice(0, 4)) {
    if (HEADER_SKIP_PATTERN.test(line)) continue;
    if (isLikelyAmountLine(line) && !/tankstelle/i.test(line)) continue;
    if (isLikelyDateLine(line)) continue;
    if (line.length >= 3) return line;
  }

  return undefined;
}

export function shouldUseEvidenceBasedRecognizedData(kind: ClassifiedDocumentKind): boolean {
  return isOcrOnlyRecognizedDataKind(kind) && getOcrOnlyRecognizedDataEnabled();
}

export function buildEvidenceBasedRecognizedData(
  input: EvidenceBasedRecognizedDataInput,
): Record<string, string> {
  const result: Record<string, string> = {
    Dokumentart: input.classifiedKind,
  };

  const text = buildCanonicalDocumentText(input.recognizedText, input.pageTexts);
  if (!text.trim()) {
    return result;
  }

  const fieldsWithConfidence = extractFieldsWithConfidence(text);
  const plain = toConfidentPlainFields(fieldsWithConfidence);

  if (plain.Betrag?.trim()) {
    result.Betrag = plain.Betrag;
  } else {
    const zoned = zoneDocumentText(text, input.pageTexts);
    const features = extractDocumentFeatures(zoned);
    const amountFeature = features.features.find((feature) => feature.id === 'amount.monetary_value');
    if (amountFeature && typeof amountFeature.value === 'number' && amountFeature.value > 0) {
      result.Betrag = formatGermanMoney(amountFeature.value);
    }
  }

  if (plain.Datum?.trim()) {
    result.Datum = plain.Datum;
  }

  const station = plain.Absender ?? plain.Lieferant;
  if (station?.trim()) {
    result.Tankstelle = station;
  } else {
    const stationFromHeader = inferTankStationFromText(text);
    if (stationFromHeader) {
      result.Tankstelle = stationFromHeader;
    }
  }

  return result;
}
