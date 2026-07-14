import {
  getAuthorityScoringCutoverEnabled,
  getCertificateScoringCutoverEnabled,
  getInvoiceScoringCutoverEnabled,
  getPaymentScoringCutoverEnabled,
  getReceiptScoringCutoverEnabled,
} from '../config/documentIntelligenceConfig';
import type { DocumentClassificationInput } from '../types/models';
import type { DetectionResult } from './documentClassificationService';
import { evaluateAuthorityCutoverEligibility } from './documentAuthorityCutoverService';
import { evaluateCertificateCutoverEligibility } from './documentCertificateCutoverService';
import { evaluateInvoiceCutoverEligibility } from './documentInvoiceCutoverService';
import { evaluatePaymentCutoverEligibility } from './documentPaymentCutoverService';
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
  const paymentEnabled = getPaymentScoringCutoverEnabled();
  const authorityEnabled = getAuthorityScoringCutoverEnabled();
  const certificateEnabled = getCertificateScoringCutoverEnabled();

  if (
    !receiptEnabled &&
    !invoiceEnabled &&
    !paymentEnabled &&
    !authorityEnabled &&
    !certificateEnabled
  ) {
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

  if (paymentEnabled) {
    const paymentCutover = evaluatePaymentCutoverEligibility(pipeline);
    if (paymentCutover.eligible && paymentCutover.detection) {
      return {
        detection: paymentCutover.detection,
        cutoverApplied: true,
      };
    }
  }

  if (authorityEnabled) {
    const authorityCutover = evaluateAuthorityCutoverEligibility(pipeline);
    if (authorityCutover.eligible && authorityCutover.detection) {
      return {
        detection: authorityCutover.detection,
        cutoverApplied: true,
      };
    }
  }

  if (certificateEnabled) {
    const certificateCutover = evaluateCertificateCutoverEligibility(pipeline);
    if (certificateCutover.eligible && certificateCutover.detection) {
      return {
        detection: certificateCutover.detection,
        cutoverApplied: true,
      };
    }
  }

  return { detection: legacyDetection, cutoverApplied: false };
}
