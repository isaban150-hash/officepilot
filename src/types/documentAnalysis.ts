import type { ClassifiedDocumentKind } from './models';

export type DocumentAnalysisVersion = 'v1';

export type DocumentZone =
  | 'header'
  | 'body'
  | 'table'
  | 'footer'
  | 'unknown';

export type AnalysisSource =
  | 'ocr'
  | 'rules'
  | 'legacy'
  | 'ai'
  | 'user';

export type ReviewStatus =
  | 'auto_accepted'
  | 'needs_review'
  | 'user_confirmed'
  | 'user_corrected';

export type EvidenceRef = {
  id: string;
  zone: DocumentZone;
  snippet: string;
  startOffset?: number;
  endOffset?: number;
  startLine?: number;
  endLine?: number;
  pageNumber?: number;
};

export type EvidenceBackedFact<T> = {
  value: T;
  confidence: number;
  source: AnalysisSource;
  evidenceRefs: string[];
  reviewStatus: ReviewStatus;
};

export type DocumentConflictType =
  | 'footer_dominates_body'
  | 'candidates_too_close'
  | 'amount_mismatch'
  | 'date_ambiguous'
  | 'insufficient_evidence'
  | 'ocr_unreadable'
  | 'other';

export type DocumentConflict = {
  type: DocumentConflictType;
  severity: 'info' | 'warning' | 'critical';
  evidenceRefs: string[];
};

export type DocumentCandidate = {
  kind: ClassifiedDocumentKind | 'unknown';
  family: string;
  score: number;
  confidence: number;
  positiveEvidenceRefs: string[];
  negativeEvidenceRefs: string[];
  structuralEvidenceRefs: string[];
  missingRequiredFeatures: string[];
  conflicts: DocumentConflictType[];
};

export type DocumentAnalysisFacts = {
  sender?: EvidenceBackedFact<string>;
  recipient?: EvidenceBackedFact<string>;
  documentDate?: EvidenceBackedFact<string>;
  dueDate?: EvidenceBackedFact<string>;
  grossAmount?: EvidenceBackedFact<number>;
  netAmount?: EvidenceBackedFact<number>;
  taxAmount?: EvidenceBackedFact<number>;
  taxRate?: EvidenceBackedFact<number>;
  referenceNumbers?: EvidenceBackedFact<string>[];
};

export type DocumentAnalysisRecommendations = {
  filingCategory?: {
    value: string;
    source: AnalysisSource;
    confidence: number;
  };
  taxAdvisorRelevant?: {
    value: boolean;
    source: AnalysisSource;
    confidence: number;
  };
  requestedActions: Array<{
    value: string;
    source: AnalysisSource;
    confidence: number;
    evidenceRefs: string[];
  }>;
};

export type DocumentAnalysisResult = {
  version: DocumentAnalysisVersion;
  classification: {
    family: string;
    kind: ClassifiedDocumentKind | 'unknown';
    candidates: DocumentCandidate[];
    confidence: number;
    margin: number;
    needsReview: boolean;
    source: AnalysisSource;
    reviewStatus: ReviewStatus;
  };
  facts: DocumentAnalysisFacts;
  recommendations: DocumentAnalysisRecommendations;
  evidenceIndex: Record<string, EvidenceRef>;
  conflicts: DocumentConflict[];
  warnings: string[];
  ocrQuality: {
    score: number;
    readable: boolean;
    partialRecognition: boolean;
  };
};

export type DocumentAnalysisValidationResult = {
  valid: boolean;
  errors: string[];
};

const DOCUMENT_ZONES: readonly DocumentZone[] = [
  'header',
  'body',
  'table',
  'footer',
  'unknown',
];

const ANALYSIS_SOURCES: readonly AnalysisSource[] = [
  'ocr',
  'rules',
  'legacy',
  'ai',
  'user',
];

const REVIEW_STATUSES: readonly ReviewStatus[] = [
  'auto_accepted',
  'needs_review',
  'user_confirmed',
  'user_corrected',
];

const EVIDENCE_REQUIRED_SOURCES: readonly AnalysisSource[] = ['ocr', 'rules', 'ai'];

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isConfidenceInRange(value: number): boolean {
  return value >= 0 && value <= 1;
}

function pushError(errors: string[], message: string): void {
  errors.push(message);
}

function collectMissingEvidenceRefs(
  refs: string[],
  evidenceIndex: Record<string, EvidenceRef>,
  path: string,
  errors: string[],
): void {
  for (const refId of refs) {
    if (!refId.trim()) {
      pushError(errors, `${path}: empty evidence reference id`);
      continue;
    }
    if (!(refId in evidenceIndex)) {
      pushError(errors, `${path}: missing evidence id "${refId}" in evidenceIndex`);
    }
  }
}

function validateConfidenceValue(
  value: unknown,
  path: string,
  errors: string[],
): void {
  if (!isFiniteNumber(value)) {
    pushError(errors, `${path}: confidence must be a finite number`);
    return;
  }
  if (!isConfidenceInRange(value)) {
    pushError(errors, `${path}: confidence must be between 0 and 1`);
  }
}

export function clampAnalysisConfidence(value: number): number {
  if (!isFiniteNumber(value)) {
    return 0;
  }
  if (value < 0) {
    return 0;
  }
  if (value > 1) {
    return 1;
  }
  return value;
}

export function isValidEvidenceRef(ref: EvidenceRef | null | undefined): ref is EvidenceRef {
  if (!ref || typeof ref !== 'object') {
    return false;
  }
  if (typeof ref.id !== 'string' || ref.id.trim() === '') {
    return false;
  }
  if (!DOCUMENT_ZONES.includes(ref.zone)) {
    return false;
  }
  if (typeof ref.snippet !== 'string' || ref.snippet.trim() === '') {
    return false;
  }

  const optionalNumbers: Array<keyof EvidenceRef> = [
    'startOffset',
    'endOffset',
    'startLine',
    'endLine',
    'pageNumber',
  ];
  for (const key of optionalNumbers) {
    const value = ref[key];
    if (value !== undefined && !isFiniteNumber(value)) {
      return false;
    }
  }

  return true;
}

export function hasEvidenceForFact(
  fact: EvidenceBackedFact<unknown>,
  evidenceIndex: Record<string, EvidenceRef>,
): boolean {
  if (fact.source === 'user') {
    return true;
  }

  if (fact.evidenceRefs.length === 0) {
    return false;
  }

  return fact.evidenceRefs.every(
    (refId) => refId.trim() !== '' && refId in evidenceIndex && isValidEvidenceRef(evidenceIndex[refId]),
  );
}

function validateFactEvidence(
  fact: EvidenceBackedFact<unknown>,
  evidenceIndex: Record<string, EvidenceRef>,
  path: string,
  errors: string[],
): void {
  validateConfidenceValue(fact.confidence, `${path}.confidence`, errors);

  if (!ANALYSIS_SOURCES.includes(fact.source)) {
    pushError(errors, `${path}.source: invalid analysis source`);
  }
  if (!REVIEW_STATUSES.includes(fact.reviewStatus)) {
    pushError(errors, `${path}.reviewStatus: invalid review status`);
  }

  collectMissingEvidenceRefs(fact.evidenceRefs, evidenceIndex, `${path}.evidenceRefs`, errors);

  if (EVIDENCE_REQUIRED_SOURCES.includes(fact.source) && !hasEvidenceForFact(fact, evidenceIndex)) {
    pushError(errors, `${path}: ${fact.source} fact requires valid evidence`);
  }
}

function validateRecommendationConfidence(
  confidence: number,
  path: string,
  errors: string[],
): void {
  validateConfidenceValue(confidence, path, errors);
}

export function validateDocumentAnalysisResult(
  result: DocumentAnalysisResult,
): DocumentAnalysisValidationResult {
  const errors: string[] = [];

  if (result.version !== 'v1') {
    pushError(errors, 'version: must be "v1"');
  }

  if (typeof result.classification.family !== 'string' || result.classification.family.trim() === '') {
    pushError(errors, 'classification.family: required non-empty string');
  }

  if (!ANALYSIS_SOURCES.includes(result.classification.source)) {
    pushError(errors, 'classification.source: invalid analysis source');
  }
  if (!REVIEW_STATUSES.includes(result.classification.reviewStatus)) {
    pushError(errors, 'classification.reviewStatus: invalid review status');
  }

  validateConfidenceValue(result.classification.confidence, 'classification.confidence', errors);
  validateConfidenceValue(result.classification.margin, 'classification.margin', errors);
  validateConfidenceValue(result.ocrQuality.score, 'ocrQuality.score', errors);

  if (typeof result.ocrQuality.readable !== 'boolean') {
    pushError(errors, 'ocrQuality.readable: required boolean');
  }
  if (typeof result.ocrQuality.partialRecognition !== 'boolean') {
    pushError(errors, 'ocrQuality.partialRecognition: required boolean');
  }

  if (!Array.isArray(result.warnings)) {
    pushError(errors, 'warnings: required array');
  }
  if (!Array.isArray(result.conflicts)) {
    pushError(errors, 'conflicts: required array');
  }
  if (!result.recommendations || !Array.isArray(result.recommendations.requestedActions)) {
    pushError(errors, 'recommendations.requestedActions: required array');
  }
  if (!result.facts || typeof result.facts !== 'object') {
    pushError(errors, 'facts: required object');
  }
  if (!result.evidenceIndex || typeof result.evidenceIndex !== 'object') {
    pushError(errors, 'evidenceIndex: required object');
  }

  const evidenceIndex = result.evidenceIndex ?? {};

  for (const [evidenceId, evidenceRef] of Object.entries(evidenceIndex)) {
    if (!isValidEvidenceRef(evidenceRef)) {
      pushError(errors, `evidenceIndex["${evidenceId}"]: invalid or empty evidence ref`);
      continue;
    }
    if (evidenceRef.id !== evidenceId) {
      pushError(errors, `evidenceIndex["${evidenceId}"]: id must match record key`);
    }
  }

  const facts = result.facts ?? {};
  const factEntries: Array<[string, EvidenceBackedFact<unknown> | EvidenceBackedFact<unknown>[] | undefined]> = [
    ['sender', facts.sender],
    ['recipient', facts.recipient],
    ['documentDate', facts.documentDate],
    ['dueDate', facts.dueDate],
    ['grossAmount', facts.grossAmount],
    ['netAmount', facts.netAmount],
    ['taxAmount', facts.taxAmount],
    ['taxRate', facts.taxRate],
    ['referenceNumbers', facts.referenceNumbers],
  ];

  for (const [factName, factValue] of factEntries) {
    if (!factValue) {
      continue;
    }
    if (Array.isArray(factValue)) {
      factValue.forEach((fact, index) => {
        validateFactEvidence(fact, evidenceIndex, `facts.${factName}[${index}]`, errors);
      });
      continue;
    }
    validateFactEvidence(factValue, evidenceIndex, `facts.${factName}`, errors);
  }

  const recommendations = result.recommendations;
  if (recommendations?.filingCategory) {
    if (typeof recommendations.filingCategory.value !== 'string' || recommendations.filingCategory.value.trim() === '') {
      pushError(errors, 'recommendations.filingCategory.value: required non-empty string');
    }
    validateRecommendationConfidence(
      recommendations.filingCategory.confidence,
      'recommendations.filingCategory.confidence',
      errors,
    );
  }
  if (recommendations?.taxAdvisorRelevant) {
    validateRecommendationConfidence(
      recommendations.taxAdvisorRelevant.confidence,
      'recommendations.taxAdvisorRelevant.confidence',
      errors,
    );
  }
  recommendations?.requestedActions?.forEach((action, index) => {
    const path = `recommendations.requestedActions[${index}]`;
    if (typeof action.value !== 'string' || action.value.trim() === '') {
      pushError(errors, `${path}.value: required non-empty string`);
    }
    validateRecommendationConfidence(action.confidence, `${path}.confidence`, errors);
    collectMissingEvidenceRefs(action.evidenceRefs, evidenceIndex, `${path}.evidenceRefs`, errors);
  });

  result.classification.candidates.forEach((candidate, index) => {
    const path = `classification.candidates[${index}]`;
    if (typeof candidate.family !== 'string' || candidate.family.trim() === '') {
      pushError(errors, `${path}.family: required non-empty string`);
    }
    validateConfidenceValue(candidate.confidence, `${path}.confidence`, errors);
    collectMissingEvidenceRefs(candidate.positiveEvidenceRefs, evidenceIndex, `${path}.positiveEvidenceRefs`, errors);
    collectMissingEvidenceRefs(candidate.negativeEvidenceRefs, evidenceIndex, `${path}.negativeEvidenceRefs`, errors);
    collectMissingEvidenceRefs(
      candidate.structuralEvidenceRefs,
      evidenceIndex,
      `${path}.structuralEvidenceRefs`,
      errors,
    );
  });

  if (result.classification.candidates.length > 0) {
    const winnerPresent = result.classification.candidates.some(
      (candidate) => candidate.kind === result.classification.kind,
    );
    if (!winnerPresent) {
      pushError(
        errors,
        'classification.kind: winner kind must be present in candidates when candidates are provided',
      );
    }
  }

  result.conflicts.forEach((conflict, index) => {
    const path = `conflicts[${index}]`;
    collectMissingEvidenceRefs(conflict.evidenceRefs, evidenceIndex, `${path}.evidenceRefs`, errors);
    if (conflict.severity === 'critical' && !result.classification.needsReview) {
      pushError(errors, `${path}: critical conflict requires classification.needsReview to be true`);
    }
  });

  return {
    valid: errors.length === 0,
    errors,
  };
}
