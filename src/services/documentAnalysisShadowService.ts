import { buildDocumentAnalysisFromLegacy } from './documentAnalysisLegacyAdapter';
import {
  extractDocumentFeatures,
  mergeFeatureEvidenceIndex,
  validateFeatureExtractionResult,
} from './documentFeatureExtractionService';
import { scoreReceiptCandidates } from './documentReceiptCandidateScoringService';
import {
  buildCanonicalDocumentText,
  buildEvidenceIndex,
  validateZoneEvidenceIndex,
  zoneDocumentText,
} from './documentZoningService';
import type { DocumentAnalysisResult } from '../types/documentAnalysis';
import { clampAnalysisConfidence, validateDocumentAnalysisResult } from '../types/documentAnalysis';
import type { DocumentClassificationInput, DocumentClassificationResult } from '../types/models';
import type { DocumentFeatureExtractionResult } from '../types/documentFeatures';
import type { DocumentZonedText } from '../types/documentZoning';
import { assessTextQuality } from './textQualityService';
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
    const recognizedText = buildCanonicalDocumentText(input.recognizedText, input.pageTexts);
    if (!recognizedText) {
      return;
    }

    const zonedText = zoneDocumentText(recognizedText, input.pageTexts);
    const zoneEvidenceIndex = buildEvidenceIndex(zonedText);
    if (!validateZoneEvidenceIndex(zoneEvidenceIndex)) {
      return;
    }

    const featureResult = extractDocumentFeatures(zonedText);
    if (!validateFeatureExtractionResult(featureResult)) {
      return;
    }

    const mergedEvidenceIndex = mergeFeatureEvidenceIndex(zoneEvidenceIndex, featureResult);
    if (!validateZoneEvidenceIndex(mergedEvidenceIndex)) {
      return;
    }

    const scoringResult = scoreReceiptCandidates(featureResult.features);

    const quality = assessTextQuality(recognizedText);
    const ocrQuality = {
      score: clampAnalysisConfidence(quality.score / 100),
      readable: quality.readable,
      partialRecognition: !quality.readable && quality.wordCount > 0,
    };
    const analysis = buildShadowScoredDocumentAnalysis({
      classification,
      recognizedText,
      zonedText,
      featureResult,
      mergedEvidenceIndex,
      scoringResult,
      ocrQuality,
    });
    const validation = validateDocumentAnalysisResult(analysis);
    if (!validation.valid) {
      return;
    }
  } catch {
    // Shadow analysis must never affect the productive legacy workflow.
  }
}
