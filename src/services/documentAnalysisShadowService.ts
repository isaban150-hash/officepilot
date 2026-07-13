import type { DocumentClassificationInput, DocumentClassificationResult } from '../types/models';
import { clampAnalysisConfidence, validateDocumentAnalysisResult } from '../types/documentAnalysis';
import { assessTextQuality } from './textQualityService';
import { buildDocumentAnalysisFromLegacy } from './documentAnalysisLegacyAdapter';

let shadowInvocationCount = 0;

export function getLegacyAnalysisShadowInvocationCountForTests(): number {
  return shadowInvocationCount;
}

export function resetLegacyAnalysisShadowInvocationCountForTests(): void {
  shadowInvocationCount = 0;
}

function buildRecognizedText(input: DocumentClassificationInput): string | undefined {
  const parts = [
    input.recognizedText,
    ...(input.pageTexts?.map((page) => page.text) ?? []),
  ].filter((part): part is string => Boolean(part?.trim()));

  if (parts.length === 0) {
    return undefined;
  }

  return parts.join('\n');
}

export function runLegacyDocumentAnalysisShadow(
  classification: DocumentClassificationResult,
  input: DocumentClassificationInput,
): void {
  shadowInvocationCount += 1;

  try {
    const recognizedText = buildRecognizedText(input);
    const quality = recognizedText ? assessTextQuality(recognizedText) : null;
    const analysis = buildDocumentAnalysisFromLegacy({
      classification,
      recognizedText,
      ocrQuality: quality
        ? {
            score: clampAnalysisConfidence(quality.score / 100),
            readable: quality.readable,
            partialRecognition: !quality.readable && quality.wordCount > 0,
          }
        : undefined,
    });
    const validation = validateDocumentAnalysisResult(analysis);
    if (!validation.valid) {
      return;
    }
  } catch {
    // Shadow analysis must never affect the productive legacy workflow.
  }
}
