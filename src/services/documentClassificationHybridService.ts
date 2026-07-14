import { getReceiptScoringCutoverEnabled } from '../config/documentIntelligenceConfig';
import type { DocumentClassificationInput } from '../types/models';
import type { DetectionResult } from './documentClassificationService';
import { runReceiptAnalysisPipeline } from './documentReceiptAnalysisPipelineService';
import { evaluateReceiptCutoverEligibility } from './documentReceiptCutoverService';

export type ClassificationDetectionResolution = {
  detection: DetectionResult;
  cutoverApplied: boolean;
};

function hasUploadKindHint(input: DocumentClassificationInput): boolean {
  return Boolean(input.kindHint && input.kindHint !== 'werbung');
}

export function resolveClassificationDetection(
  input: DocumentClassificationInput,
  legacyDetection: DetectionResult,
): ClassificationDetectionResolution {
  if (!getReceiptScoringCutoverEnabled() || hasUploadKindHint(input)) {
    return { detection: legacyDetection, cutoverApplied: false };
  }

  const pipeline = runReceiptAnalysisPipeline(input);
  const cutover = evaluateReceiptCutoverEligibility(pipeline);

  if (!cutover.eligible || !cutover.detection) {
    return { detection: legacyDetection, cutoverApplied: false };
  }

  return {
    detection: cutover.detection,
    cutoverApplied: true,
  };
}
