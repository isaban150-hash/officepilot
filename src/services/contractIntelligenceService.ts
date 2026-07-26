import type {
  ContractIntelligenceResult,
  ContractOrderProposal,
  DocumentPageText,
  EnhancedDetectedOrderPosition,
} from '../types/documentIntelligence';
import type { DetectedPaymentTerm, InboxItem, Vorgang } from '../types/models';
import { getInboxItemById } from './inboxService';
import {
  extractBillOfQuantitiesFromPages,
  extractBillOfQuantitiesPositions,
  sumPositionsNet,
} from './billOfQuantitiesExtractionService';
import {
  CONSTRUCTION_FAMILIES,
  detectContractClauses,
  detectContractType,
  extractAllContractFields,
  extractContractParties,
  looksLikeContractDocument,
  mapPartiesToLegacyFields,
  partitionContractFields,
} from './contractIntelligenceExtraction';
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

function resolveDocumentLabel(
  contractType: ReturnType<typeof detectContractType>,
  hasBoQ: boolean,
): string {
  if (hasBoQ && CONSTRUCTION_FAMILIES.has(contractType.family)) {
    return 'documentIntelligence.label.werkvertragMitLv';
  }
  if (hasBoQ && contractType.family === 'unknown') {
    return 'documentIntelligence.label.leistungsverzeichnis';
  }
  return contractType.labelKey || 'documentIntelligence.label.unknown';
}

function buildOpenReviewHints(result: ContractIntelligenceResult): string[] {
  const hints: string[] = [];
  if (result.reviewRequired) {
    hints.push('documentIntelligence.review.classification');
  }
  if (result.contractType?.status === 'review_required') {
    hints.push('documentIntelligence.review.contractType');
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

function mapFamilyToClassifiedKind(
  family: ReturnType<typeof detectContractType>['family'],
  fallback: ReturnType<typeof detectClassifiedKindWithReason>['kind'],
): ContractIntelligenceResult['classifiedKind'] {
  if (family === 'werkvertrag') return 'werkvertrag';
  if (family === 'subunternehmervertrag') return 'subunternehmervertrag';
  return fallback;
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

  const contractType = detectContractType(recognizedText);
  const looksLikeContract =
    looksLikeContractDocument(recognizedText, pageTexts) ||
    contractType.family !== 'unknown' ||
    segmentation.billOfQuantitiesPages.length > 0;

  if (!looksLikeContract) {
    return null;
  }

  // Real LV heading or confirmed construction family — not segmentation alone
  // (numbered rent/service lines must not invent a Leistungsverzeichnis).
  const allowBoqExtraction =
    CONSTRUCTION_FAMILIES.has(contractType.family) ||
    /leistungsverzeichnis/i.test(recognizedText);

  const positions: EnhancedDetectedOrderPosition[] = [];
  if (allowBoqExtraction) {
    positions.push(
      ...extractBillOfQuantitiesFromPages(pageTexts, segmentation.billOfQuantitiesPages),
    );
    if (positions.length === 0) {
      positions.push(...extractBillOfQuantitiesFromPages(pageTexts));
    }
    if (positions.length === 0 && boqText) {
      positions.push(
        ...extractBillOfQuantitiesFromPages([
          { pageNumber: segmentation.billOfQuantitiesPages[0] ?? 1, text: boqText },
        ]),
      );
    }
    if (positions.length === 0 && recognizedText.trim()) {
      positions.push(...extractBillOfQuantitiesPositions(recognizedText));
    }
  }

  const paymentTerms = detectPaymentTermsFromText(fullCommercialText);
  const parties = extractContractParties(fullCommercialText);
  const allFields = extractAllContractFields(fullCommercialText, pageTexts);
  mapPartiesToLegacyFields(parties, allFields);
  const { commonFields, typeSpecificFields, visibleFields } = partitionContractFields(
    allFields,
    contractType.family,
  );

  const clauses = CONSTRUCTION_FAMILIES.has(contractType.family)
    ? detectContractClauses(recognizedText, pageTexts)
    : detectContractClauses(recognizedText, pageTexts).filter((clause) =>
        ['kuendigung', 'abnahme'].includes(clause.id),
      );

  const contractTotalNet = resolveContractTotalNet(fullCommercialText, pageTexts);
  if (contractTotalNet.status === 'not_found' && positions.length > 0) {
    const summed = sumPositionsNet(positions);
    if (summed > 0) {
      contractTotalNet.value = summed;
      contractTotalNet.status = positions.every((p) => p.reviewStatus === 'confirmed')
        ? 'confirmed'
        : 'review_required';
      contractTotalNet.confidence = contractTotalNet.status === 'confirmed' ? 'medium' : 'low';
      contractTotalNet.sourceText = 'Summe der erkannten Positionen';
    }
  }

  const classified = detectClassifiedKindWithReason({
    recognizedText: fullCommercialText,
    pageTexts,
  });

  const hasBoQ = positions.length > 0 || segmentation.billOfQuantitiesPages.length > 0;
  const classifiedKind = mapFamilyToClassifiedKind(contractType.family, classified.kind);

  const reviewRequired =
    contractType.status === 'review_required' ||
    classified.kind === 'eingangsrechnung' ||
    classified.kind === 'rechnung' ||
    contractTotalNet.status === 'review_required' ||
    positions.some((position) => position.reviewStatus === 'review_required');

  const documentLabelKey = resolveDocumentLabel(contractType, hasBoQ);

  const result: ContractIntelligenceResult = {
    documentLabelKey,
    classifiedKind,
    reviewRequired,
    segmentation,
    contractFields: visibleFields,
    contractType,
    parties,
    commonFields,
    typeSpecificFields,
    positions,
    contractTotalNet: contractTotalNet.status === 'not_found' ? undefined : contractTotalNet,
    paymentTerms,
    clauses,
    progressBillingAllowed: paymentTerms.some(
      (term) => term.type === 'abschlag' || term.type === 'weekly_abschlag',
    ),
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

export function buildContractOrderProposal(
  item: InboxItem,
  /**
   * When provided (including null), skips a second analyzeContractIntelligenceFromInbox.
   * Omit to analyze from the inbox item (standalone callers / tests).
   */
  precomputedIntelligence?: ContractIntelligenceResult | null,
): ContractOrderProposal | null {
  const intelligence =
    precomputedIntelligence !== undefined
      ? precomputedIntelligence
      : analyzeContractIntelligenceFromInbox(item);
  if (!intelligence) return null;

  // Allow contracts without LV (rent, service, unclear) when structured data exists.
  const hasStructuredSignal =
    intelligence.positions.length > 0 ||
    (intelligence.parties?.length ?? 0) > 0 ||
    Object.values(intelligence.contractFields).some((field) => field.status !== 'not_found') ||
    Boolean(intelligence.contractType && intelligence.contractType.family !== 'unknown');

  if (!hasStructuredSignal) return null;

  const fields = intelligence.contractFields;
  const paymentTermsSummary = intelligence.paymentTerms.map((term) => term.label).join(' · ');
  const customerParty =
    intelligence.parties?.find((party) =>
      ['auftraggeber', 'vermieter', 'leasinggeber', 'kaeufer', 'versicherungsnehmer', 'arbeitgeber'].includes(
        party.role,
      ),
    ) ?? null;
  const contractorParty =
    intelligence.parties?.find((party) =>
      [
        'subunternehmer',
        'nachunternehmer',
        'auftragnehmer',
        'mieter',
        'leasingnehmer',
        'verkaeufer',
        'versicherer',
        'arbeitnehmer',
        'dienstleister',
      ].includes(party.role),
    ) ?? null;

  return {
    customer: customerParty?.name ?? fields.auftraggeber?.value ?? item.recognizedData.Kunde ?? '',
    contractor: contractorParty?.name ?? fields.auftragnehmer?.value ?? item.sender ?? '',
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
