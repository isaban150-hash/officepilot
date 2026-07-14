import { buildDocumentAnalysisFromLegacy } from './documentAnalysisLegacyAdapter';
import { validateDocumentAnalysisResult } from '../types/documentAnalysis';
import type { DocumentAnalysisResult } from '../types/documentAnalysis';
import type { DocumentClassificationInput, DocumentClassificationResult } from '../types/models';
import type { DocumentFeatureExtractionResult } from '../types/documentFeatures';
import type { DocumentZonedText } from '../types/documentZoning';
import { runReceiptAnalysisPipeline } from './documentReceiptAnalysisPipelineService';
import type { ReceiptScoringResult } from './documentReceiptCandidateScoringService';

let shadowInvocationCount = 0;

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
): void {
  shadowInvocationCount += 1;

  try {
    const pipeline = runReceiptAnalysisPipeline(input);
    if (!pipeline?.valid) {
      return;
    }

    const analysis = buildShadowScoredDocumentAnalysis({
      classification,
      recognizedText: pipeline.recognizedText,
      zonedText: pipeline.zonedText,
      featureResult: pipeline.featureResult,
      mergedEvidenceIndex: pipeline.mergedEvidenceIndex,
      scoringResult: pipeline.scoringResult,
      ocrQuality: pipeline.ocrQuality,
    });
    const validation = validateDocumentAnalysisResult(analysis);
    if (!validation.valid) {
      return;
    }
  } catch {
    // Shadow analysis must never affect the productive legacy workflow.
  }
}
