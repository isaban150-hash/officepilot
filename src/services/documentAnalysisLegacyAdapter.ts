import type { DocumentClassificationResult } from '../types/models';
import type {
  AnalysisSource,
  DocumentAnalysisFacts,
  DocumentAnalysisRecommendations,
  DocumentAnalysisResult,
  DocumentCandidate,
  DocumentZone,
  EvidenceBackedFact,
  EvidenceRef,
  ReviewStatus,
} from '../types/documentAnalysis';
import { clampAnalysisConfidence } from '../types/documentAnalysis';

export type DocumentAnalysisLegacyAdapterInput = {
  classification: DocumentClassificationResult;
  recognizedText?: string;
  ocrQuality?: {
    score: number;
    readable: boolean;
    partialRecognition: boolean;
  };
};

const DETECTION_EVIDENCE_ID = 'legacy:detection';
const DEFAULT_SENDER = 'Unbekannter Absender';

const TAX_ADVISOR_KINDS = new Set([
  'eingangsrechnung',
  'rechnung',
  'ausgangsrechnung',
  'gutschrift',
  'quittung',
  'kassenbeleg',
  'ec_beleg',
  'kreditkartenbeleg',
  'tankbeleg',
  'reparaturrechnung',
  'mahnung',
  'zahlungserinnerung',
  'freistellungsbescheinigung',
  'unbedenklichkeitsbescheinigung',
  'steuerbescheid',
  'umsatzsteuerbescheinigung',
  'lohnabrechnung',
  'kontoauszug',
]);

type OcrTextMatch = {
  snippet: string;
  startOffset: number;
  endOffset: number;
  startLine: number;
  endLine: number;
};

type FactBuildResult = {
  facts: DocumentAnalysisFacts;
  evidenceIndex: Record<string, EvidenceRef>;
  warnings: string[];
  includedFactKeys: Set<string>;
};

export function isValidLegacyAdapterInput(
  input: DocumentAnalysisLegacyAdapterInput | null | undefined,
): input is DocumentAnalysisLegacyAdapterInput {
  if (!input?.classification) {
    return false;
  }

  const { classification } = input;
  return (
    typeof classification.classifiedKind === 'string' &&
    classification.classifiedKind.length > 0 &&
    typeof classification.documentType === 'string' &&
    classification.documentType.length > 0 &&
    typeof classification.detectionReasonKey === 'string' &&
    classification.detectionReasonKey.length > 0 &&
    Array.isArray(classification.actions)
  );
}

function inferLegacyConfidence(classification: DocumentClassificationResult): number {
  const reasonKey = classification.detectionReasonKey;
  if (
    reasonKey.includes('uploadHint') ||
    reasonKey.includes('explicit') ||
    reasonKey.includes('filename')
  ) {
    return 0.85;
  }
  if (reasonKey.includes('fallback') || reasonKey.includes('advertisement')) {
    return 0.45;
  }
  if (classification.suggestedVorgang?.confidence === 'high') {
    return 0.85;
  }
  if (classification.suggestedVorgang?.confidence === 'medium') {
    return 0.65;
  }
  return 0.65;
}

function inferNeedsReview(
  classification: DocumentClassificationResult,
  confidence: number,
  ocrQuality: DocumentAnalysisResult['ocrQuality'],
): boolean {
  if (classification.isAdvertisement) return true;
  if (confidence < 0.6) return true;
  if (!ocrQuality.readable) return true;
  if (ocrQuality.partialRecognition) return true;
  if (classification.detectionReasonKey.includes('fallback')) return true;
  return false;
}

function inferReviewStatus(needsReview: boolean): ReviewStatus {
  return needsReview ? 'needs_review' : 'auto_accepted';
}

function lineNumberAtOffset(text: string, offset: number): number {
  return text.slice(0, offset).split(/\r?\n/).length;
}

function matchSubstring(text: string, needle: string): OcrTextMatch | null {
  if (!needle.trim() || !text.trim()) {
    return null;
  }

  const index = text.toLowerCase().indexOf(needle.toLowerCase());
  if (index < 0) {
    return null;
  }

  const snippet = text.slice(index, index + needle.length);
  return {
    snippet,
    startOffset: index,
    endOffset: index + snippet.length,
    startLine: lineNumberAtOffset(text, index),
    endLine: lineNumberAtOffset(text, index + snippet.length),
  };
}

function matchRegex(text: string, pattern: RegExp): OcrTextMatch | null {
  const match = pattern.exec(text);
  if (!match?.[0]) {
    return null;
  }

  const snippet = match[0];
  const index = match.index;
  return {
    snippet,
    startOffset: index,
    endOffset: index + snippet.length,
    startLine: lineNumberAtOffset(text, index),
    endLine: lineNumberAtOffset(text, index + snippet.length),
  };
}

function buildOcrEvidenceRef(
  id: string,
  match: OcrTextMatch,
  zone: DocumentZone = 'body',
): EvidenceRef {
  return {
    id,
    zone,
    snippet: match.snippet,
    startOffset: match.startOffset,
    endOffset: match.endOffset,
    startLine: match.startLine,
    endLine: match.endLine,
  };
}

function parseGermanAmount(value: string): number | undefined {
  const normalized = value
    .replace(/[^\d,.-]/g, '')
    .replace(/\./g, '')
    .replace(',', '.');
  const amount = Number.parseFloat(normalized);
  return Number.isFinite(amount) ? amount : undefined;
}

function buildLegacyFact<T>(
  value: T,
  confidence: number,
  evidenceRefs: string[],
): EvidenceBackedFact<T> {
  return {
    value,
    confidence: clampAnalysisConfidence(confidence),
    source: 'legacy',
    evidenceRefs,
    reviewStatus: 'auto_accepted',
  };
}

function findSenderMatch(text: string, sender: string): OcrTextMatch | null {
  if (!sender.trim() || sender === DEFAULT_SENDER) {
    return null;
  }

  const directMatch = matchSubstring(text, sender);
  if (directMatch) {
    return directMatch;
  }

  const labeledMatch = matchRegex(
    text,
    /^(?:absender|von|lieferant|aussteller|anbieter)\s*[:]\s*(.+)$/im,
  );
  if (!labeledMatch) {
    return null;
  }

  const value = labeledMatch.snippet.split(':').slice(1).join(':').trim();
  if (!value) {
    return null;
  }

  return matchSubstring(text, value) ?? labeledMatch;
}

function findAmountMatch(text: string): OcrTextMatch | null {
  return matchRegex(text, /\b(\d{1,3}(?:[.\s]\d{3})*,\d{2})\s*€?/i);
}

function findDateMatch(text: string): OcrTextMatch | null {
  return matchRegex(text, /\b(\d{1,2}[./]\d{1,2}[./]\d{2,4})\b/);
}

function findDueDateMatch(text: string): OcrTextMatch | null {
  return matchRegex(
    text,
    /(?:frist|fällig(?:keit| am)?|zahlbar bis|bis zum)\s*[:.]?\s*(\d{1,2}[./]\d{1,2}[./]\d{2,4})/i,
  );
}

function findReferenceMatches(text: string): OcrTextMatch[] {
  const matches: OcrTextMatch[] = [];
  const patterns = [
    /(?:rechnungs(?:nummer|nr\.?)|invoice(?:\s*no\.?)?|beleg(?:nummer|nr\.?))\s*[:#]?\s*([A-Z0-9][\w./-]{2,})/gi,
    /(?:aktenzeichen|az\.?|referenz)\s*[:#]?\s*([A-Z0-9][\w./-]{2,})/gi,
  ];

  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const value = match[1] ?? match[0];
      const located = matchSubstring(text, value);
      if (located) {
        matches.push(located);
      }
    }
  }

  return matches;
}

function findRecipientMatch(text: string): OcrTextMatch | null {
  const labeledMatch = matchRegex(
    text,
    /^(?:empfänger|empfaenger|an|kunde|mandant)\s*[:]\s*(.+)$/im,
  );
  if (!labeledMatch) {
    return null;
  }

  const value = labeledMatch.snippet.split(':').slice(1).join(':').trim();
  if (!value) {
    return null;
  }

  return matchSubstring(text, value) ?? labeledMatch;
}

function hasLegacyCandidateValue(value: string | null | undefined): value is string {
  return Boolean(value?.trim()) && value !== DEFAULT_SENDER;
}

function appendMissingEvidenceWarning(
  warnings: string[],
  legacyValuePresent: boolean,
  included: boolean,
): void {
  if (legacyValuePresent && !included && !warnings.includes('legacy_fact_without_evidence')) {
    warnings.push('legacy_fact_without_evidence');
  }
}

function buildFacts(
  classification: DocumentClassificationResult,
  recognizedText: string | undefined,
  confidence: number,
): FactBuildResult {
  const evidenceIndex: Record<string, EvidenceRef> = {};
  const warnings: string[] = [];
  const includedFactKeys = new Set<string>();
  const facts: DocumentAnalysisFacts = {};
  const data = classification.recognizedData;
  const text = recognizedText?.trim() ?? '';

  if (text) {
    const senderMatch = findSenderMatch(text, classification.sender);
    if (senderMatch) {
      const evidenceId = 'legacy:sender';
      evidenceIndex[evidenceId] = buildOcrEvidenceRef(evidenceId, senderMatch, 'header');
      facts.sender = buildLegacyFact(
        senderMatch.snippet.includes(':')
          ? senderMatch.snippet.split(':').slice(1).join(':').trim()
          : classification.sender,
        confidence,
        [evidenceId],
      );
      includedFactKeys.add('sender');
    }

    const recipientMatch = findRecipientMatch(text);
    if (recipientMatch) {
      const evidenceId = 'legacy:recipient';
      evidenceIndex[evidenceId] = buildOcrEvidenceRef(evidenceId, recipientMatch, 'header');
      facts.recipient = buildLegacyFact(
        recipientMatch.snippet.split(':').slice(1).join(':').trim(),
        confidence,
        [evidenceId],
      );
      includedFactKeys.add('recipient');
    }

    const dateMatch = findDateMatch(text);
    if (dateMatch) {
      const evidenceId = 'legacy:documentDate';
      evidenceIndex[evidenceId] = buildOcrEvidenceRef(evidenceId, dateMatch, 'body');
      const normalizedDate = dateMatch.snippet.match(/\d{1,2}[./]\d{1,2}[./]\d{2,4}/)?.[0];
      if (normalizedDate) {
        facts.documentDate = buildLegacyFact(normalizedDate, confidence, [evidenceId]);
        includedFactKeys.add('documentDate');
      }
    }

    const dueDateMatch = findDueDateMatch(text);
    if (dueDateMatch) {
      const evidenceId = 'legacy:dueDate';
      evidenceIndex[evidenceId] = buildOcrEvidenceRef(evidenceId, dueDateMatch, 'body');
      const normalizedDueDate = dueDateMatch.snippet.match(/\d{1,2}[./]\d{1,2}[./]\d{2,4}/)?.[0];
      if (normalizedDueDate) {
        facts.dueDate = buildLegacyFact(normalizedDueDate, confidence, [evidenceId]);
        includedFactKeys.add('dueDate');
      }
    }

    const amountMatch = findAmountMatch(text);
    if (amountMatch) {
      const evidenceId = 'legacy:grossAmount';
      evidenceIndex[evidenceId] = buildOcrEvidenceRef(evidenceId, amountMatch, 'body');
      const parsedAmount = parseGermanAmount(amountMatch.snippet);
      if (parsedAmount !== undefined) {
        facts.grossAmount = buildLegacyFact(parsedAmount, confidence, [evidenceId]);
        includedFactKeys.add('grossAmount');
      }
    }

    const referenceMatches = findReferenceMatches(text);
    if (referenceMatches.length > 0) {
      facts.referenceNumbers = referenceMatches.map((referenceMatch, index) => {
        const evidenceId = `legacy:reference:${index}`;
        evidenceIndex[evidenceId] = buildOcrEvidenceRef(evidenceId, referenceMatch, 'body');
        const value =
          referenceMatch.snippet.match(/[A-Z0-9][\w./-]{2,}/i)?.[0] ?? referenceMatch.snippet.trim();
        includedFactKeys.add(`reference:${index}`);
        return buildLegacyFact(value, confidence, [evidenceId]);
      });
    }
  }

  appendMissingEvidenceWarning(
    warnings,
    hasLegacyCandidateValue(classification.sender),
    includedFactKeys.has('sender'),
  );
  appendMissingEvidenceWarning(
    warnings,
    hasLegacyCandidateValue(data.Kunde ?? data.Lieferant),
    includedFactKeys.has('recipient'),
  );
  appendMissingEvidenceWarning(
    warnings,
    hasLegacyCandidateValue(data.Datum),
    includedFactKeys.has('documentDate'),
  );
  appendMissingEvidenceWarning(
    warnings,
    hasLegacyCandidateValue(classification.deadline ?? data.Frist ?? data.Fälligkeit),
    includedFactKeys.has('dueDate'),
  );
  appendMissingEvidenceWarning(
    warnings,
    hasLegacyCandidateValue(data.Betrag),
    includedFactKeys.has('grossAmount'),
  );
  appendMissingEvidenceWarning(
    warnings,
    hasLegacyCandidateValue(data.Rechnungsnummer ?? data.Aktenzeichen ?? data.Betreff),
    referenceMatchesIncluded(includedFactKeys),
  );

  return { facts, evidenceIndex, warnings, includedFactKeys };
}

function referenceMatchesIncluded(includedFactKeys: Set<string>): boolean {
  return [...includedFactKeys].some((key) => key.startsWith('reference:'));
}

function buildRecommendations(
  classification: DocumentClassificationResult,
  confidence: number,
  detectionEvidenceId: string,
): DocumentAnalysisRecommendations {
  const filingValue =
    classification.digitalFolder.path?.trim() ||
    classification.paperFiling.label?.trim() ||
    classification.recommendedAction;

  const recommendations: DocumentAnalysisRecommendations = {
    requestedActions: classification.actions.map((action) => ({
      value: action.id,
      source: 'legacy' as AnalysisSource,
      confidence: clampAnalysisConfidence(confidence),
      evidenceRefs: [detectionEvidenceId],
    })),
  };

  if (filingValue) {
    recommendations.filingCategory = {
      value: filingValue,
      source: 'legacy',
      confidence: clampAnalysisConfidence(confidence),
    };
  }

  if (TAX_ADVISOR_KINDS.has(classification.classifiedKind)) {
    recommendations.taxAdvisorRelevant = {
      value: classification.digitalFolder.path?.includes('Steuerberater') ?? false,
      source: 'legacy',
      confidence: clampAnalysisConfidence(confidence),
    };
  }

  return recommendations;
}

function buildLegacyCandidate(
  classification: DocumentClassificationResult,
  confidence: number,
  detectionEvidenceId: string,
): DocumentCandidate {
  return {
    kind: classification.classifiedKind,
    family: classification.documentType,
    score: 1,
    confidence: clampAnalysisConfidence(confidence),
    positiveEvidenceRefs: [detectionEvidenceId],
    negativeEvidenceRefs: [],
    structuralEvidenceRefs: [],
    missingRequiredFeatures: [
      'zone_segmentation',
      'weighted_candidate_scoring',
      'evidence_backed_field_extraction',
    ],
    conflicts: [],
  };
}

function buildEvidenceRef(
  id: string,
  snippet: string,
  zone: DocumentZone = 'unknown',
): EvidenceRef {
  return {
    id,
    zone,
    snippet: snippet.trim(),
  };
}

function resolveOcrQuality(
  input: DocumentAnalysisLegacyAdapterInput,
): DocumentAnalysisResult['ocrQuality'] {
  if (input.ocrQuality) {
    return {
      score: clampAnalysisConfidence(input.ocrQuality.score),
      readable: input.ocrQuality.readable,
      partialRecognition: input.ocrQuality.partialRecognition,
    };
  }

  return {
    score: 0,
    readable: false,
    partialRecognition: false,
  };
}

export function buildDocumentAnalysisFromLegacy(
  input: DocumentAnalysisLegacyAdapterInput,
): DocumentAnalysisResult {
  if (!isValidLegacyAdapterInput(input)) {
    throw new TypeError('invalid_legacy_adapter_input');
  }

  const { classification } = input;
  const confidence = inferLegacyConfidence(classification);
  const ocrQuality = resolveOcrQuality(input);
  const needsReview = inferNeedsReview(classification, confidence, ocrQuality);
  const reviewStatus = inferReviewStatus(needsReview);

  const evidenceIndex: Record<string, EvidenceRef> = {
    [DETECTION_EVIDENCE_ID]: buildEvidenceRef(
      DETECTION_EVIDENCE_ID,
      classification.detectionReasonKey,
      'unknown',
    ),
  };

  const factBundle = buildFacts(classification, input.recognizedText, confidence);
  Object.assign(evidenceIndex, factBundle.evidenceIndex);

  const candidate = buildLegacyCandidate(classification, confidence, DETECTION_EVIDENCE_ID);
  const warnings = [
    'legacy:no_weighted_candidate_scoring',
    'legacy:no_document_zone_segmentation',
    ...factBundle.warnings,
  ];

  return {
    version: 'v1',
    classification: {
      family: classification.documentType,
      kind: classification.classifiedKind,
      candidates: [candidate],
      confidence: clampAnalysisConfidence(confidence),
      margin: 0,
      needsReview,
      source: 'legacy',
      reviewStatus,
    },
    facts: factBundle.facts,
    recommendations: buildRecommendations(classification, confidence, DETECTION_EVIDENCE_ID),
    evidenceIndex,
    conflicts: [],
    warnings,
    ocrQuality,
  };
}

export function buildDocumentAnalysisFromLegacyClassification(
  classification: DocumentClassificationResult,
  options: Omit<DocumentAnalysisLegacyAdapterInput, 'classification'> = {},
): DocumentAnalysisResult {
  return buildDocumentAnalysisFromLegacy({
    classification,
    ...options,
  });
}
