import {
  getInvoiceScoringCutoverEnabled,
  getReceiptScoringCutoverEnabled,
} from '../config/documentIntelligenceConfig';
import type { DocumentClassificationInput } from '../types/models';
import type { DetectionResult } from './documentClassificationService';
import { evaluateInvoiceCutoverEligibility } from './documentInvoiceCutoverService';
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
  if (hasUploadKindHint(input)) {
    return { detection: legacyDetection, cutoverApplied: false };
  }

  const receiptEnabled = getReceiptScoringCutoverEnabled();
  const invoiceEnabled = getInvoiceScoringCutoverEnabled();

  if (!receiptEnabled && !invoiceEnabled) {
    return { detection: legacyDetection, cutoverApplied: false };
  }

  const pipeline = runReceiptAnalysisPipeline(input);

  if (receiptEnabled) {
    const receiptCutover = evaluateReceiptCutoverEligibility(pipeline);
    if (receiptCutover.eligible && receiptCutover.detection) {
      return {
        detection: receiptCutover.detection,
        cutoverApplied: true,
      };
    }
  }

  if (invoiceEnabled) {
    const invoiceCutover = evaluateInvoiceCutoverEligibility(pipeline);
    if (invoiceCutover.eligible && invoiceCutover.detection) {
      return {
        detection: invoiceCutover.detection,
        cutoverApplied: true,
      };
    }
  }

  return { detection: legacyDetection, cutoverApplied: false };
}
