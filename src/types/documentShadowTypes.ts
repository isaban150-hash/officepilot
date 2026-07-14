import type { DocumentConflictType } from './documentAnalysis';
import type { ClassifiedDocumentKind } from './models';

export type DiCutoverLane =
  | 'receipt'
  | 'invoice'
  | 'payment'
  | 'authority'
  | 'certificate'
  | 'contract'
  | 'customer'
  | 'legacy';

export type DiMismatchType =
  | 'legacy_vs_productive'
  | 'global_vs_productive'
  | 'lane_near_miss'
  | 'none';

export type DiLaneShadowEvaluation = {
  lane: DiCutoverLane;
  eligible: boolean;
  rejectionReason?: string;
  winnerKind?: ClassifiedDocumentKind;
  laneMargin?: number;
  laneConfidence?: number;
  evidenceRefCount?: number;
};

export type DiClassificationShadowRecord = {
  observedAt: string;
  documentFingerprint: string;
  productiveKind: ClassifiedDocumentKind;
  productiveReasonKey: string;
  cutoverApplied: boolean;
  cutoverLane: DiCutoverLane;
  legacyKind: ClassifiedDocumentKind;
  legacyReasonKey: string;
  globalWinnerKind: ClassifiedDocumentKind | 'unknown';
  globalMargin: number;
  globalConfidence: number;
  laneEvaluations: DiLaneShadowEvaluation[];
  ocrQualityScore: number;
  ocrReadable: boolean;
  conflictTypes: DocumentConflictType[];
  warningCodes: string[];
  mismatchType: DiMismatchType;
};

export const DI_SHADOW_RECORD_ALLOWLIST = [
  'observedAt',
  'documentFingerprint',
  'productiveKind',
  'productiveReasonKey',
  'cutoverApplied',
  'cutoverLane',
  'legacyKind',
  'legacyReasonKey',
  'globalWinnerKind',
  'globalMargin',
  'globalConfidence',
  'laneEvaluations',
  'ocrQualityScore',
  'ocrReadable',
  'conflictTypes',
  'warningCodes',
  'mismatchType',
] as const;

export const DI_LANE_EVALUATION_ALLOWLIST = [
  'lane',
  'eligible',
  'rejectionReason',
  'winnerKind',
  'laneMargin',
  'laneConfidence',
  'evidenceRefCount',
] as const;

const FORBIDDEN_PERSISTENCE_PATTERNS = [
  /\bDE\d{2}\s?(?:\d{4}\s?){3,7}\d{1,4}\b/i,
  /\b[A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){3,7}\s?[A-Z0-9]{1,4}\b/,
  /\b\d{1,3}(?:[.\s]\d{3})*,\d{2}\s*(?:€|EUR)\b/i,
  /@[\w.-]+\.\w{2,}/,
  /\b(?:straße|strasse|str\.|weg|platz|gasse)\b/i,
  /snippet/i,
  /recognizedText/i,
  /sourceFileName/i,
];

export function sanitizeDiClassificationShadowRecord(
  record: DiClassificationShadowRecord,
): DiClassificationShadowRecord {
  const sanitized: DiClassificationShadowRecord = {
    observedAt: record.observedAt,
    documentFingerprint: record.documentFingerprint,
    productiveKind: record.productiveKind,
    productiveReasonKey: record.productiveReasonKey,
    cutoverApplied: record.cutoverApplied,
    cutoverLane: record.cutoverLane,
    legacyKind: record.legacyKind,
    legacyReasonKey: record.legacyReasonKey,
    globalWinnerKind: record.globalWinnerKind,
    globalMargin: roundMetric(record.globalMargin),
    globalConfidence: roundMetric(record.globalConfidence),
    laneEvaluations: record.laneEvaluations.map((evaluation) => ({
      lane: evaluation.lane,
      eligible: evaluation.eligible,
      rejectionReason: evaluation.rejectionReason,
      winnerKind: evaluation.winnerKind,
      laneMargin:
        evaluation.laneMargin === undefined ? undefined : roundMetric(evaluation.laneMargin),
      laneConfidence:
        evaluation.laneConfidence === undefined ? undefined : roundMetric(evaluation.laneConfidence),
      evidenceRefCount: evaluation.evidenceRefCount,
    })),
    ocrQualityScore: roundMetric(record.ocrQualityScore),
    ocrReadable: record.ocrReadable,
    conflictTypes: [...record.conflictTypes],
    warningCodes: [...new Set(record.warningCodes)],
    mismatchType: record.mismatchType,
  };

  assertNoForbiddenPersistenceContent(JSON.stringify(sanitized));
  return sanitized;
}

function roundMetric(value: number): number {
  return Math.round(value * 10000) / 10000;
}

export function assertNoForbiddenPersistenceContent(serialized: string): void {
  for (const pattern of FORBIDDEN_PERSISTENCE_PATTERNS) {
    if (pattern.test(serialized)) {
      throw new Error('di-shadow:forbidden_persistence_content');
    }
  }
}
