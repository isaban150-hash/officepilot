import type {
  ContractIntelligenceResult,
  ContractOrderProposal,
  DocumentPageText,
  ExtractedContractField,
} from '../types/documentIntelligence';
import type { DetectedPaymentTerm, InboxItem, Vorgang } from '../types/models';
import { getInboxItemById } from './inboxService';
import {
  extractBillOfQuantitiesFromPages,
  extractBillOfQuantitiesPositions,
  sumPositionsNet,
} from './billOfQuantitiesExtractionService';
import {
  formatGermanMoney,
  resolveContractTotalNet,
} from './documentAmountExtractionService';
import {
  joinSectionText,
  segmentDocumentPages,
  splitTextIntoPages,
} from './documentSegmentationService';
import { getInboxExtractedDocumentText } from './inboxDocumentText';
import { detectClassifiedKindWithReason } from './documentClassificationService';

const CONTRACT_START_MARKERS =
  /werkvertrag|bau[\s-]?subunternehmer|subunternehmervertrag|auftraggeber|vertragsgegenstand/i;

function extractField(
  text: string,
  patterns: RegExp[],
  sourcePage?: number,
): ExtractedContractField {
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match?.[1]?.trim()) {
      return {
        value: match[1].trim().split('\n')[0].trim(),
        status: 'confirmed',
        confidence: 'high',
        sourcePage,
        sourceText: match[0].trim(),
      };
    }
  }
  return { status: 'not_found', confidence: 'low' };
}

function extractContractFields(contractText: string, pageTexts: DocumentPageText[]) {
  const firstPages = joinSectionText(pageTexts, pageTexts.slice(0, 3).map((p) => p.pageNumber));

  return {
    documentType: extractField(firstPages, [/^(?:werkvertrag|bau[\s-]?subunternehmervertrag)/im], 1),
    auftraggeber: extractField(contractText, [/auftraggeber[:\s]+([^\n]+)/i], pageTexts[0]?.pageNumber),
    auftragnehmer: extractField(contractText, [
      /subunternehmer[:\s]+([^\n]+)/i,
      /auftragnehmer[:\s]+([^\n]+)/i,
      /nachunternehmer[:\s]+([^\n]+)/i,
    ], pageTexts[0]?.pageNumber),
    baustelle: extractField(contractText, [
      /baustelle[:\s]+([^\n]+)/i,
      /bauvorhaben[:\s]+([^\n]+)/i,
      /baustellenadresse[:\s]+([^\n]+)/i,
    ]),
    vertragsdatum: extractField(contractText, [/vertragsdatum[:\s]+([^\n]+)/i, /datum[:\s]+(\d{1,2}\.\d{1,2}\.\d{4})/i]),
    zahlungsbedingungen: extractField(contractText, [/zahlungsbedingungen[:\s]+([^\n]+)/i, /zahlungsziel[:\s]+([^\n]+)/i]),
    vertragsgegenstand: extractField(contractText, [/vertragsgegenstand[:\s]+([^\n]+)/i, /leistung[:\s]+([^\n]+)/i]),
  };
}

function hasContractStart(pageTexts: DocumentPageText[]): boolean {
  const intro = pageTexts
    .slice(0, 3)
    .map((page) => page.text)
    .join('\n')
    .toLowerCase();
  return CONTRACT_START_MARKERS.test(intro);
}

function resolveDocumentLabel(
  segmentation: ReturnType<typeof segmentDocumentPages>,
  hasBoQ: boolean,
): string {
  if (segmentation.contractCorePages.length > 0 && hasBoQ) {
    return 'documentIntelligence.label.werkvertragMitLv';
  }
  if (segmentation.contractCorePages.length > 0) {
    return 'documentIntelligence.label.werkvertrag';
  }
  if (hasBoQ) {
    return 'documentIntelligence.label.leistungsverzeichnis';
  }
  return 'documentIntelligence.label.unknown';
}

function buildOpenReviewHints(result: ContractIntelligenceResult): string[] {
  const hints: string[] = [];
  if (result.reviewRequired) {
    hints.push('documentIntelligence.review.classification');
  }
  if (result.contractTotalNet?.status === 'review_required') {
    hints.push('documentIntelligence.review.contractTotal');
  }
  if (result.positions.some((position) => position.reviewStatus === 'review_required')) {
    hints.push('documentIntelligence.review.positions');
  }
  for (const field of Object.values(result.contractFields)) {
    if (field?.status === 'review_required') {
      hints.push('documentIntelligence.review.contractField');
      break;
    }
  }
  return hints;
}

export function analyzeContractIntelligenceFromText(
  recognizedText: string,
  pageTextsInput?: DocumentPageText[],
): ContractIntelligenceResult | null {
  const pageTexts = pageTextsInput ?? splitTextIntoPages(recognizedText);
  if (pageTexts.length === 0 || !recognizedText.trim()) return null;

  const segmentation = segmentDocumentPages(pageTexts);
  const contractText = joinSectionText(pageTexts, segmentation.contractCorePages);
  const boqText = joinSectionText(pageTexts, segmentation.billOfQuantitiesPages);
  const fullCommercialText = contractText || recognizedText;

  if (!hasContractStart(pageTexts) && segmentation.billOfQuantitiesPages.length === 0) {
    return null;
  }

  const positions = extractBillOfQuantitiesFromPages(pageTexts, segmentation.billOfQuantitiesPages);
  if (positions.length === 0) {
    positions.push(...extractBillOfQuantitiesFromPages(pageTexts));
  }
  if (positions.length === 0 && boqText) {
    positions.push(...extractBillOfQuantitiesFromPages([{ pageNumber: segmentation.billOfQuantitiesPages[0] ?? 1, text: boqText }]));
  }
  if (positions.length === 0 && recognizedText.trim()) {
    positions.push(...extractBillOfQuantitiesPositions(recognizedText));
  }

  const paymentTerms = detectPaymentTermsFromText(fullCommercialText);
  const contractFields = extractContractFields(fullCommercialText, pageTexts);
  const contractTotalNet = resolveContractTotalNet(fullCommercialText, pageTexts);

  if (contractTotalNet.status === 'not_found' && positions.length > 0) {
    const summed = sumPositionsNet(positions);
    if (summed > 0) {
      contractTotalNet.value = summed;
      contractTotalNet.status = positions.every((p) => p.reviewStatus === 'confirmed') ? 'confirmed' : 'review_required';
      contractTotalNet.confidence = contractTotalNet.status === 'confirmed' ? 'medium' : 'low';
      contractTotalNet.sourceText = 'Summe der erkannten Positionen';
    }
  }

  const classified = detectClassifiedKindWithReason({
    recognizedText: fullCommercialText,
    pageTexts,
  });

  const hasBoQ = positions.length > 0 || segmentation.billOfQuantitiesPages.length > 0;
  const reviewRequired =
    classified.kind === 'eingangsrechnung' ||
    classified.kind === 'rechnung' ||
    contractTotalNet.status === 'review_required' ||
    positions.some((position) => position.reviewStatus === 'review_required');

  const result: ContractIntelligenceResult = {
    documentLabelKey: resolveDocumentLabel(segmentation, hasBoQ),
    classifiedKind: hasBoQ && hasContractStart(pageTexts) ? 'werkvertrag' : classified.kind,
    reviewRequired,
    segmentation,
    contractFields,
    positions,
    contractTotalNet: contractTotalNet.status === 'not_found' ? undefined : contractTotalNet,
    paymentTerms,
    progressBillingAllowed: paymentTerms.some((term) => term.type === 'abschlag' || term.type === 'weekly_abschlag'),
    finalInvoiceMentioned: paymentTerms.some((term) => term.type === 'schlussrechnung'),
    technicalAttachmentCount: segmentation.technicalAttachmentPages.length,
    openReviewHints: [],
  };

  result.openReviewHints = buildOpenReviewHints(result);
  return result;
}

export function analyzeContractIntelligenceFromInbox(item: InboxItem): ContractIntelligenceResult | null {
  const recognizedText = getInboxExtractedDocumentText(item);
  const pageTextsRaw = item.recognizedData._pageTexts;
  const pageTexts = pageTextsRaw ? (JSON.parse(pageTextsRaw) as DocumentPageText[]) : undefined;
  return analyzeContractIntelligenceFromText(recognizedText, pageTexts);
}

export function buildContractOrderProposal(item: InboxItem): ContractOrderProposal | null {
  const intelligence = analyzeContractIntelligenceFromInbox(item);
  if (!intelligence || intelligence.positions.length === 0) return null;

  const fields = intelligence.contractFields;
  const paymentTermsSummary = intelligence.paymentTerms.map((term) => term.label).join(' · ');

  return {
    customer: fields.auftraggeber?.value ?? item.recognizedData.Kunde ?? '',
    contractor: fields.auftragnehmer?.value ?? item.sender ?? '',
    constructionSite: fields.baustelle?.value ?? item.recognizedData.Baustelle ?? '',
    contractDate: fields.vertragsdatum?.value,
    positionCount: intelligence.positions.length,
    contractTotalNet:
      intelligence.contractTotalNet?.value !== undefined
        ? formatGermanMoney(intelligence.contractTotalNet.value)
        : undefined,
    paymentTermsSummary,
    progressBillingHint: intelligence.progressBillingAllowed
      ? 'documentIntelligence.hint.progressBilling'
      : undefined,
    technicalAttachmentsLabel:
      intelligence.technicalAttachmentCount > 0
        ? 'documentIntelligence.hint.technicalAttachments'
        : undefined,
    reviewHints: intelligence.openReviewHints,
    positions: intelligence.positions,
    intelligence,
  };
}

export function detectPaymentTermsFromText(text: string): DetectedPaymentTerm[] {
  const terms: DetectedPaymentTerm[] = [];

  if (/14\s*tage.*(?:skonto|2\s*%)/i.test(text) || /2\s*%.*14\s*tage/i.test(text)) {
    terms.push({ type: 'skonto', label: '2 % Skonto bei 14 Tagen', value: '2/14' });
  }

  if (/30\s*tage\s*netto/i.test(text)) {
    terms.push({ type: 'net_days', label: '30 Tage netto', value: '30' });
  } else if (/14\s*tage\s*netto/i.test(text)) {
    terms.push({ type: 'net_days', label: '14 Tage netto', value: '14' });
  }

  if (/abschlagsrechnung(?:en)?\s+(?:sind\s+)?(?:möglich|zulässig|vereinbart|wöchentlich)/i.test(text)) {
    terms.push({ type: 'abschlag', label: 'Abschlagsrechnungen möglich' });
  }

  if (/wöchentlich(?:e|en)?\s+abschlagsrechnungen|abschlagsrechnungen\s+sind\s+wöchentlich/i.test(text)) {
    terms.push({ type: 'weekly_abschlag', label: 'Wöchentliche Abschläge' });
  }

  if (/schlussrechnung/i.test(text)) {
    terms.push({ type: 'schlussrechnung', label: 'Schlussrechnung vorgesehen' });
  }

  return terms;
}

export interface ContractSkontoOffer {
  percent: number;
  days: number;
  text: string;
}

export function getContractSkontoOfferForVorgang(vorgang: Vorgang): ContractSkontoOffer | null {
  if (!vorgang.createdFromInboxId) return null;
  const item = getInboxItemById(vorgang.createdFromInboxId);
  if (!item) return null;
  const intelligence = analyzeContractIntelligenceFromInbox(item);
  if (!intelligence) return null;

  const skontoTerm = intelligence.paymentTerms.find((term) => term.type === 'skonto');
  if (!skontoTerm?.value) return null;

  const [percentRaw, daysRaw] = skontoTerm.value.split('/');
  const percent = Number(percentRaw);
  const days = Number(daysRaw);
  if (!Number.isFinite(percent) || !Number.isFinite(days) || percent <= 0 || days <= 0) {
    return null;
  }

  return {
    percent,
    days,
    text: `Bei Zahlung innerhalb von ${days} Tagen gewähren wir ${percent} % Skonto.`,
  };
}
