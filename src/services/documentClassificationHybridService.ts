import {
  getAuthorityScoringCutoverEnabled,
  getCertificateScoringCutoverEnabled,
  getContractScoringCutoverEnabled,
  getCustomerScoringCutoverEnabled,
  getInvoiceScoringCutoverEnabled,
  getPaymentScoringCutoverEnabled,
  getReceiptScoringCutoverEnabled,
} from '../config/documentIntelligenceConfig';
import type { DiCutoverLane } from '../types/documentShadowTypes';
import type { DocumentClassificationInput } from '../types/models';
import type { DetectionResult } from './documentClassificationService';
import { evaluateAuthorityCutoverEligibility } from './documentAuthorityCutoverService';
import { evaluateCertificateCutoverEligibility } from './documentCertificateCutoverService';
import { evaluateContractCutoverEligibility } from './documentContractCutoverService';
import { evaluateCustomerCutoverEligibility } from './documentCustomerCutoverService';
import { evaluateInvoiceCutoverEligibility } from './documentInvoiceCutoverService';
import { evaluatePaymentCutoverEligibility } from './documentPaymentCutoverService';
import {
  runReceiptAnalysisPipeline,
  type ReceiptAnalysisPipelineResult,
} from './documentReceiptAnalysisPipelineService';
import { evaluateReceiptCutoverEligibility } from './documentReceiptCutoverService';
import { resolveCutoverLaneFromResolution } from './documentHybridLaneEvaluationService';

export type ClassificationDetectionResolution = {
  detection: DetectionResult;
  cutoverApplied: boolean;
};

export type HybridClassificationContext = {
  resolution: ClassificationDetectionResolution;
  cutoverLane: DiCutoverLane;
  pipeline: ReceiptAnalysisPipelineResult | null;
};

function hasUploadKindHint(input: DocumentClassificationInput): boolean {
  return Boolean(input.kindHint && input.kindHint !== 'werbung');
}

function isAnyCutoverEnabled(): boolean {
  return (
    getReceiptScoringCutoverEnabled() ||
    getInvoiceScoringCutoverEnabled() ||
    getPaymentScoringCutoverEnabled() ||
    getAuthorityScoringCutoverEnabled() ||
    getCertificateScoringCutoverEnabled() ||
    getContractScoringCutoverEnabled() ||
    getCustomerScoringCutoverEnabled()
  );
}

function resolveClassificationFromPipeline(
  input: DocumentClassificationInput,
  legacyDetection: DetectionResult,
  pipeline: ReceiptAnalysisPipelineResult | null,
): ClassificationDetectionResolution {
  if (hasUploadKindHint(input)) {
    return { detection: legacyDetection, cutoverApplied: false };
  }

  if (!isAnyCutoverEnabled()) {
    return { detection: legacyDetection, cutoverApplied: false };
  }

  if (getReceiptScoringCutoverEnabled()) {
    const receiptCutover = evaluateReceiptCutoverEligibility(pipeline);
    if (receiptCutover.eligible && receiptCutover.detection) {
      return {
        detection: receiptCutover.detection,
        cutoverApplied: true,
      };
    }
  }

  if (getInvoiceScoringCutoverEnabled()) {
    const invoiceCutover = evaluateInvoiceCutoverEligibility(pipeline);
    if (invoiceCutover.eligible && invoiceCutover.detection) {
      return {
        detection: invoiceCutover.detection,
        cutoverApplied: true,
      };
    }
  }

  if (getPaymentScoringCutoverEnabled()) {
    const paymentCutover = evaluatePaymentCutoverEligibility(pipeline);
    if (paymentCutover.eligible && paymentCutover.detection) {
      return {
        detection: paymentCutover.detection,
        cutoverApplied: true,
      };
    }
  }

  if (getAuthorityScoringCutoverEnabled()) {
    const authorityCutover = evaluateAuthorityCutoverEligibility(pipeline);
    if (authorityCutover.eligible && authorityCutover.detection) {
      return {
        detection: authorityCutover.detection,
        cutoverApplied: true,
      };
    }
  }

  if (getCertificateScoringCutoverEnabled()) {
    const certificateCutover = evaluateCertificateCutoverEligibility(pipeline);
    if (certificateCutover.eligible && certificateCutover.detection) {
      return {
        detection: certificateCutover.detection,
        cutoverApplied: true,
      };
    }
  }

  if (getContractScoringCutoverEnabled()) {
    const contractCutover = evaluateContractCutoverEligibility(pipeline);
    if (contractCutover.eligible && contractCutover.detection) {
      return {
        detection: contractCutover.detection,
        cutoverApplied: true,
      };
    }
  }

  if (getCustomerScoringCutoverEnabled()) {
    const customerCutover = evaluateCustomerCutoverEligibility(pipeline);
    if (customerCutover.eligible && customerCutover.detection) {
      return {
        detection: customerCutover.detection,
        cutoverApplied: true,
      };
    }
  }

  return { detection: legacyDetection, cutoverApplied: false };
}

export function resolveHybridClassification(
  input: DocumentClassificationInput,
  legacyDetection: DetectionResult,
): HybridClassificationContext {
  if (hasUploadKindHint(input) || !isAnyCutoverEnabled()) {
    const resolution = resolveClassificationFromPipeline(input, legacyDetection, null);
    return {
      resolution,
      cutoverLane: 'legacy',
      pipeline: null,
    };
  }

  const pipeline = runReceiptAnalysisPipeline(input);
  const resolution = resolveClassificationFromPipeline(input, legacyDetection, pipeline);
  const cutoverLane = resolveCutoverLaneFromResolution(
    resolution.cutoverApplied,
    resolution.detection.reasonKey,
  );

  return {
    resolution,
    cutoverLane,
    pipeline,
  };
}

export function resolveClassificationDetection(
  input: DocumentClassificationInput,
  legacyDetection: DetectionResult,
): ClassificationDetectionResolution {
  return resolveHybridClassification(input, legacyDetection).resolution;
}
