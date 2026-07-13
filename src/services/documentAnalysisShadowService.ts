import type { DocumentClassificationInput, DocumentClassificationResult } from '../types/models';
import { clampAnalysisConfidence, validateDocumentAnalysisResult } from '../types/documentAnalysis';
import { assessTextQuality } from './textQualityService';
import { buildDocumentAnalysisFromLegacy } from './documentAnalysisLegacyAdapter';
import {
  buildCanonicalDocumentText,
  buildEvidenceIndex,
  validateZoneEvidenceIndex,
  zoneDocumentText,
} from './documentZoningService';

let shadowInvocationCount = 0;

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

    const quality = assessTextQuality(recognizedText);
    const analysis = buildDocumentAnalysisFromLegacy({
      classification,
      recognizedText,
      zonedText,
      ocrQuality: {
        score: clampAnalysisConfidence(quality.score / 100),
        readable: quality.readable,
        partialRecognition: !quality.readable && quality.wordCount > 0,
      },
    });
    const validation = validateDocumentAnalysisResult(analysis);
    if (!validation.valid) {
      return;
    }
  } catch {
    // Shadow analysis must never affect the productive legacy workflow.
  }
}
