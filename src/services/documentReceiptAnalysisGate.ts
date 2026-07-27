/**
 * DOCUMENT-INTAKE-RECEIPT-GUARD-01 — skip receipt analysis for strong contract/LV docs.
 * Reuses existing contract-family signals; does not invent a second classifier.
 */
import type { DocumentClassificationInput } from '../types/models';
import {
  CONSTRUCTION_FAMILIES,
  detectContractType,
} from './contractIntelligenceExtraction';
import { buildCanonicalDocumentText } from './documentZoningService';

const CONSTRUCTION_KIND_HINTS = new Set([
  'werkvertrag',
  'subunternehmervertrag',
  'nachunternehmervertrag',
  'leistungsverzeichnis',
]);

const BOQ_ROW_PATTERN =
  /^\d{1,3}\s+[\d.,]+\s+(?:qm|m²|m2|lfdm|lfm|m|st\.?|stk|stück|std\.?|kg|pauschal)/im;

function countBoqRows(text: string): number {
  let count = 0;
  for (const line of text.split(/\r?\n/)) {
    if (BOQ_ROW_PATTERN.test(line.trim())) count += 1;
    if (count >= 3) return count;
  }
  return count;
}

function hasClearInvoiceOrReceiptSignal(text: string): boolean {
  if (/\bhotelrechnung\b|\btankbeleg\b|\bkassenbeleg\b|\bec[\s-]?beleg\b|\bquittung\b/i.test(text)) {
    return true;
  }
  if (
    /\brechnungsnummer\b|\brechnungsdatum\b|\binvoice\s*no\b/i.test(text) &&
    !/\bwerkvertrag\b|\bbauvertrag\b|\bleistungsverzeichnis\b/i.test(text)
  ) {
    return true;
  }
  return false;
}

/**
 * True when receipt zoning/feature scoring should not run.
 * Requires strong construction/LV evidence — not a lone "Vertrag" token.
 */
export function shouldSkipReceiptAnalysisForContractDocument(
  input: Pick<DocumentClassificationInput, 'recognizedText' | 'pageTexts' | 'kindHint'>,
): boolean {
  if (input.kindHint && CONSTRUCTION_KIND_HINTS.has(input.kindHint)) {
    return true;
  }

  const text = buildCanonicalDocumentText(input.recognizedText, input.pageTexts);
  if (!text.trim()) return false;

  if (hasClearInvoiceOrReceiptSignal(text)) {
    return false;
  }

  const hasWerkHeading = /\bwerkvertrag\b|\bbauvertrag\b|\bsubunternehmervertrag\b/i.test(text);
  const hasLvHeading = /\bleistungsverzeichnis\b/i.test(text);
  const boqRows = countBoqRows(text);
  const hasBauSite = /\bbaustelle\b|\bbauvorhaben\b|\bbaustellenbezeichnung\b/i.test(text);
  const hasParties =
    /\bauftraggeber\b/i.test(text) && /\b(?:auftragnehmer|subunternehmer|nachunternehmer)\b/i.test(text);

  if (hasWerkHeading && (hasLvHeading || boqRows >= 3 || (hasBauSite && hasParties))) {
    return true;
  }

  if (hasLvHeading && boqRows >= 3 && hasParties) {
    return true;
  }

  const contractType = detectContractType(text);
  if (
    CONSTRUCTION_FAMILIES.has(contractType.family) &&
    (hasLvHeading || boqRows >= 3 || hasBauSite)
  ) {
    return true;
  }

  return false;
}
