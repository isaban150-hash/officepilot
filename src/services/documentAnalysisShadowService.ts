import { getDiShadowObservabilityEnabled } from '../config/documentIntelligenceConfig';
import { buildDocumentAnalysisFromLegacy } from './documentAnalysisLegacyAdapter';
import { validateDocumentAnalysisResult } from '../types/documentAnalysis';
import type { DocumentAnalysisResult } from '../types/documentAnalysis';
import type { DocumentClassificationInput, DocumentClassificationResult } from '../types/models';
import type { ClassifiedDocumentKind } from '../types/models';
import type { DocumentFeatureExtractionResult } from '../types/documentFeatures';
import type {
  DiClassificationShadowRecord,
  DiMismatchType,
} from '../types/documentShadowTypes';
import type { DocumentZonedText } from '../types/documentZoning';
import type { DetectionResult } from './documentClassificationService';
import type { HybridClassificationContext } from './documentClassificationHybridService';
import {
  buildHybridLaneEvaluations,
  hasLaneNearMiss,
} from './documentHybridLaneEvaluationService';
import { runReceiptAnalysisPipeline } from './documentReceiptAnalysisPipelineService';
import type { ReceiptScoringResult } from './documentReceiptCandidateScoringService';
import { appendDiShadowRecord } from './documentShadowPersistenceService';
import { sha256Bytes } from './sha256Digest';

let shadowInvocationCount = 0;

export function buildDocumentFingerprint(input: DocumentClassificationInput): string {
  const textLength = (input.recognizedText ?? '').length;
  const pageCount = input.pageTexts?.length ?? 0;
  const hintFlags = [
    input.kindHint ? 'k' : '',
    input.senderHint ? 's' : '',
    input.titleHint ? 't' : '',
  ].join('');
  const payload = `${textLength}:${pageCount}:${hintFlags}`;
  const digest = sha256Bytes(new TextEncoder().encode(payload));
  return [...digest].map((value) => value.toString(16).padStart(2, '0')).join('');
}

function resolveMismatchType(input: {
  productiveKind: DocumentClassificationResult['classifiedKind'];
  legacyKind: ClassifiedDocumentKind;
  globalWinnerKind: DiClassificationShadowRecord['globalWinnerKind'];
  cutoverApplied: boolean;
  laneEvaluations: DiClassificationShadowRecord['laneEvaluations'];
}): DiMismatchType {
  if (input.productiveKind !== input.legacyKind) {
    return 'legacy_vs_productive';
  }

  if (!input.cutoverApplied && hasLaneNearMiss(input.laneEvaluations)) {
    return 'lane_near_miss';
  }

  if (input.globalWinnerKind !== 'unknown' && input.globalWinnerKind !== input.productiveKind) {
    return 'global_vs_productive';
  }

  return 'none';
}

export function buildDiClassificationShadowRecord(input: {
  classification: DocumentClassificationResult;
  legacyDetection: DetectionResult;
  hybridContext: HybridClassificationContext;
  classificationInput: DocumentClassificationInput;
}): DiClassificationShadowRecord {
  const { classification, legacyDetection, hybridContext, classificationInput } = input;
  const pipeline = hybridContext.pipeline;
  const globalWinnerKind = pipeline?.scoringResult.winnerKind ?? 'unknown';
  const laneEvaluations = buildHybridLaneEvaluations(pipeline);
  const warningCodes = [...(pipeline?.scoringResult.warnings ?? [])];

  if (globalWinnerKind !== 'unknown' && globalWinnerKind !== classification.classifiedKind) {
    warningCodes.push('shadow:classification_mismatch');
  }
  if (classification.classifiedKind !== legacyDetection.kind) {
    warningCodes.push('shadow:legacy_productive_mismatch');
  }

  const conflictTypes = [
    ...new Set((pipeline?.scoringResult.conflicts ?? []).map((conflict) => conflict.type)),
  ];

  return {
    observedAt: new Date().toISOString(),
    documentFingerprint: buildDocumentFingerprint(classificationInput),
    productiveKind: classification.classifiedKind,
    productiveReasonKey: classification.detectionReasonKey,
    cutoverApplied: hybridContext.resolution.cutoverApplied,
    cutoverLane: hybridContext.cutoverLane,
    legacyKind: legacyDetection.kind,
    legacyReasonKey: legacyDetection.reasonKey,
    globalWinnerKind,
    globalMargin: pipeline?.scoringResult.margin ?? 0,
    globalConfidence: pipeline?.scoringResult.confidence ?? 0,
    laneEvaluations,
    ocrQualityScore: pipeline?.ocrQuality.score ?? 0,
    ocrReadable: pipeline?.ocrQuality.readable ?? false,
    conflictTypes,
    warningCodes: [...new Set(warningCodes)],
    mismatchType: resolveMismatchType({
      productiveKind: classification.classifiedKind,
      legacyKind: legacyDetection.kind,
      globalWinnerKind,
      cutoverApplied: hybridContext.resolution.cutoverApplied,
      laneEvaluations,
    }),
  };
}

export function buildShadowScoredDocumentAnalysis(input: {
  classification: DocumentClassificationResult;
  recognizedText: string;
  zonedText: DocumentZonedText;
  featureResult: DocumentFeatureExtractionResult;
  mergedEvidenceIndex: Record<string, import('../types/documentAnalysis').EvidenceRef>;
  scoringResult: ReceiptScoringResult;
  ocrQuality: DocumentAnalysisResult['ocrQuality'];
}): DocumentAnalysisResult {
  const legacyAnalysis = buildDocumentAnalysisFromLegacy({
    classification: input.classification,
    recognizedText: input.recognizedText,
    zonedText: input.zonedText,
    ocrQuality: input.ocrQuality,
  });

  const winner = input.scoringResult.candidates[0];
  const warnings = [
    ...legacyAnalysis.warnings.filter((warning) => warning !== 'legacy:no_weighted_candidate_scoring'),
    ...input.scoringResult.warnings,
  ];

  if (input.scoringResult.winnerKind !== input.classification.classifiedKind) {
    warnings.push('shadow:classification_mismatch');
  }

  const evidenceIndex = {
    ...input.mergedEvidenceIndex,
    ...legacyAnalysis.evidenceIndex,
  };

  return {
    ...legacyAnalysis,
    classification: {
      family: winner?.family ?? legacyAnalysis.classification.family,
      kind: input.scoringResult.winnerKind,
      candidates: input.scoringResult.candidates,
      confidence: input.scoringResult.confidence,
      margin: input.scoringResult.margin,
      needsReview:
        input.scoringResult.needsReview || legacyAnalysis.classification.needsReview,
      source: 'rules',
      reviewStatus: input.scoringResult.reviewStatus,
    },
    evidenceIndex,
    conflicts: input.scoringResult.conflicts,
    warnings,
  };
}

export function getLegacyAnalysisShadowInvocationCountForTests(): number {
  return shadowInvocationCount;
}

export function resetLegacyAnalysisShadowInvocationCountForTests(): void {
  shadowInvocationCount = 0;
}

export function runLegacyDocumentAnalysisShadow(
  classification: DocumentClassificationResult,
  input: DocumentClassificationInput,
  options: {
    legacyDetection: DetectionResult;
    hybridContext: HybridClassificationContext;
  },
): void {
  shadowInvocationCount += 1;

  try {
    const pipeline = options.hybridContext.pipeline ?? runReceiptAnalysisPipeline(input);
    if (pipeline?.valid) {
      const analysis = buildShadowScoredDocumentAnalysis({
        classification,
        recognizedText: pipeline.recognizedText,
        zonedText: pipeline.zonedText,
        featureResult: pipeline.featureResult,
        mergedEvidenceIndex: pipeline.mergedEvidenceIndex,
        scoringResult: pipeline.scoringResult,
        ocrQuality: pipeline.ocrQuality,
      });
      validateDocumentAnalysisResult(analysis);
    }

    if (!getDiShadowObservabilityEnabled()) {
      return;
    }

    const record = buildDiClassificationShadowRecord({
      classification,
      legacyDetection: options.legacyDetection,
      hybridContext: options.hybridContext,
      classificationInput: input,
    });
    appendDiShadowRecord(record);
  } catch {
    // Shadow analysis must never affect the productive legacy workflow.
  }
}
