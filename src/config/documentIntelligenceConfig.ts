import type { ClassifiedDocumentKind } from '../types/models';

export const RECEIPT_SCORING_CUTOVER = {
  enabled: true,
  allowedKinds: ['tankbeleg'],
  minConfidence: 0.85,
  minMargin: 0.25,
  minOcrScore: 0.60,
  minEvidenceRefs: 2,
} as const satisfies {
  enabled: boolean;
  allowedKinds: readonly ClassifiedDocumentKind[];
  minConfidence: number;
  minMargin: number;
  minOcrScore: number;
  minEvidenceRefs: number;
};

export const DI_RECEIPT_SCORING_REASON_KEY = 'classification.detect.diReceiptScoring';

let cutoverEnabledOverride: boolean | null = null;

export function getReceiptScoringCutoverEnabled(): boolean {
  if (cutoverEnabledOverride !== null) {
    return cutoverEnabledOverride;
  }
  return RECEIPT_SCORING_CUTOVER.enabled;
}

export function setReceiptScoringCutoverEnabledForTests(value: boolean | null): void {
  cutoverEnabledOverride = value;
}

export function isReceiptScoringCutoverKind(
  kind: ClassifiedDocumentKind,
): kind is (typeof RECEIPT_SCORING_CUTOVER.allowedKinds)[number] {
  return RECEIPT_SCORING_CUTOVER.allowedKinds.includes(
    kind as (typeof RECEIPT_SCORING_CUTOVER.allowedKinds)[number],
  );
}
