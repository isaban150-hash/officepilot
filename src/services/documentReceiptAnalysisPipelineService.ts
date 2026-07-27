import type { DocumentAnalysisResult, EvidenceRef } from '../types/documentAnalysis';
import { clampAnalysisConfidence } from '../types/documentAnalysis';
import type { DocumentFeatureExtractionResult } from '../types/documentFeatures';
import type { DocumentZonedText } from '../types/documentZoning';
import type { DocumentClassificationInput } from '../types/models';
import {
  extractDocumentFeatures,
  mergeFeatureEvidenceIndex,
  validateFeatureExtractionResult,
} from './documentFeatureExtractionService';
import {
  scoreReceiptCandidates,
  type ReceiptScoringResult,
} from './documentReceiptCandidateScoringService';
import {
  buildCanonicalDocumentText,
  buildEvidenceIndex,
  validateZoneEvidenceIndex,
  zoneDocumentText,
} from './documentZoningService';
import { assessTextQuality } from './textQualityService';

export type ReceiptAnalysisPipelineResult = {
  valid: boolean;
  recognizedText: string;
  zonedText: DocumentZonedText;
  featureResult: DocumentFeatureExtractionResult;
  mergedEvidenceIndex: Record<string, EvidenceRef>;
  scoringResult: ReceiptScoringResult;
  ocrQuality: DocumentAnalysisResult['ocrQuality'];
};

let receiptPipelineInvocationCount = 0;

export function getReceiptPipelineInvocationCountForTests(): number {
  return receiptPipelineInvocationCount;
}

export function resetReceiptPipelineCountersForTests(): void {
  receiptPipelineInvocationCount = 0;
}

export function runReceiptAnalysisPipeline(
  input: Pick<DocumentClassificationInput, 'recognizedText' | 'pageTexts'>,
): ReceiptAnalysisPipelineResult | null {
  receiptPipelineInvocationCount += 1;

  const recognizedText = buildCanonicalDocumentText(input.recognizedText, input.pageTexts);
  if (!recognizedText) {
    return null;
  }

  const zonedText = zoneDocumentText(recognizedText, input.pageTexts);
  const zoneEvidenceIndex = buildEvidenceIndex(zonedText);
  if (!validateZoneEvidenceIndex(zoneEvidenceIndex)) {
    return {
      valid: false,
      recognizedText,
      zonedText,
      featureResult: { features: [], evidenceIndex: {}, warnings: ['pipeline:invalid_zone_evidence'] },
      mergedEvidenceIndex: zoneEvidenceIndex,
      scoringResult: scoreReceiptCandidates([]),
      ocrQuality: { score: 0, readable: false, partialRecognition: false },
    };
  }

  const featureResult = extractDocumentFeatures(zonedText);
  if (!validateFeatureExtractionResult(featureResult)) {
    return {
      valid: false,
      recognizedText,
      zonedText,
      featureResult,
      mergedEvidenceIndex: zoneEvidenceIndex,
      scoringResult: scoreReceiptCandidates(featureResult.features),
      ocrQuality: { score: 0, readable: false, partialRecognition: false },
    };
  }

  const mergedEvidenceIndex = mergeFeatureEvidenceIndex(zoneEvidenceIndex, featureResult);
  if (!validateZoneEvidenceIndex(mergedEvidenceIndex)) {
    return {
      valid: false,
      recognizedText,
      zonedText,
      featureResult,
      mergedEvidenceIndex,
      scoringResult: scoreReceiptCandidates(featureResult.features),
      ocrQuality: { score: 0, readable: false, partialRecognition: false },
    };
  }

  const quality = assessTextQuality(recognizedText);
  const ocrQuality = {
    score: clampAnalysisConfidence(quality.score / 100),
    readable: quality.readable,
    partialRecognition: !quality.readable && quality.wordCount > 0,
  };

  return {
    valid: true,
    recognizedText,
    zonedText,
    featureResult,
    mergedEvidenceIndex,
    scoringResult: scoreReceiptCandidates(featureResult.features),
    ocrQuality,
  };
}
