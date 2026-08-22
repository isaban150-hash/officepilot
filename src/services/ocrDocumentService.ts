import { createMockInboxItemFromUpload } from './inboxUploadFactory';
import {
  loadCachedDocumentFileFromUpload,
  stableFileFromCachedPayload,
  type CachedDocumentFilePayload,
} from './cachedDocumentFileService';
import { extractTextFromPdfBytes } from './uploadTextExtractionService';
import { extractPdfTextViaOcr, shouldRunPdfOcr } from './pdfOcrFallbackService';
import { getPdfPageCount } from './pdfDocumentService';
import { recognizeImageOrCanvas } from './tesseractOcrService';
import type { DocumentLayoutPage } from '../types/documentLayout';
import {
  extractVisibleFactsFromLayout,
  type DocumentVisibleFact,
} from './documentSpatialFieldExtractionService';
import type { DocumentFactAssignment } from './document/documentFactAiService';
import {
  assessTextQuality,
  buildDisplayPreviewLines,
  sanitizeExtractedText,
} from './textQualityService';
import type { DocumentUnderstandingSummary, DocumentAiAction } from '../types/models';
import {
  buildDocumentAiActions,
  buildDocumentUnderstandingSummary,
} from './documentIntakeUnderstandingService';
import { getDocumentDisplayLabelKey } from './documentDisplayLabelService';
import type { TranslationKey } from '../i18n';
import type { UploadDocumentKind } from '../types/models';

export const OCR_TEXT_HINT_KEYS = {
  partial: 'scan.ocr.partialHint',
  noText: 'scan.ocr.noText',
  unsupportedFormat: 'scan.ocr.unsupportedFormat',
} as const satisfies Record<string, TranslationKey>;

export type DocumentTextSourceType = 'pdf' | 'image';
export type OcrConfidenceLevel = 'high' | 'medium' | 'low' | 'none';
export type DocumentTextExtractionMethod = 'pdf_direct' | 'pdf_ocr' | 'image_ocr';

export type DocumentTextErrorCode =
  | 'unsupported_format'
  | 'no_text'
  | 'ocr_failed'
  | 'heic_unsupported'
  | 'heic_conversion_failed'
  | 'password_required'
  | 'pdf_corrupt';

export interface DocumentTextExtractionResult {
  recognizedText: string;
  displayText: string;
  confidence: OcrConfidenceLevel;
  pageCount?: number;
  pagesProcessed?: number;
  pageTexts?: Array<{ pageNumber: number; text: string; items?: Array<{ str?: string }> }>;
  sourceType: DocumentTextSourceType;
  extractionMethod?: DocumentTextExtractionMethod;
  ocrAttempted?: boolean;
  errorCode?: DocumentTextErrorCode;
  messageKey?: TranslationKey;
  qualityHintKey?: TranslationKey;
  /**
   * SCAN-OCR-EVIDENCE-01B — optional; only the image path fills these. Older
   * drafts without them keep working on the flat-text path.
   */
  layout?: DocumentLayoutPage;
  visibleFacts?: DocumentVisibleFact[];
  semanticFactAssignments?: DocumentFactAssignment[];
}

export interface OcrPreviewSummary {
  documentTypeLabelKey: TranslationKey;
  sender?: string;
  previewLines: string[];
  previewPartialHint?: boolean;
  understanding?: DocumentUnderstandingSummary;
  aiActions?: DocumentAiAction[];
}

type ImageOcrExtractor = (file: File) => Promise<{ text: string; confidence: number }>;

let imageOcrExtractorOverride: ImageOcrExtractor | null = null;

export function setImageOcrExtractorForTests(extractor: ImageOcrExtractor | null): void {
  imageOcrExtractorOverride = extractor;
}

function fileExtension(name: string): string {
  const index = name.lastIndexOf('.');
  return index === -1 ? '' : name.slice(index).toLowerCase();
}

function deriveConfidence(textLength: number, ocrScore?: number, qualityScore?: number): OcrConfidenceLevel {
  if (textLength <= 0) return 'none';
  if (ocrScore !== undefined) {
    if (ocrScore >= 75 && textLength >= 40) return 'high';
    if (ocrScore >= 45 || textLength >= 25) return 'medium';
    return 'low';
  }
  if (qualityScore !== undefined) {
    if (qualityScore >= 70 && textLength >= 40) return 'high';
    if (qualityScore >= 45 || textLength >= 20) return 'medium';
    return 'low';
  }
  if (textLength >= 100) return 'high';
  if (textLength >= 20) return 'medium';
  return 'low';
}

function buildQualityHintKey(
  confidence: OcrConfidenceLevel,
  hasText: boolean,
  partialRecognition = false,
): TranslationKey | undefined {
  if (!hasText) return OCR_TEXT_HINT_KEYS.noText;
  if (confidence === 'low' || partialRecognition) return OCR_TEXT_HINT_KEYS.partial;
  return undefined;
}

function finalizeResult(
  partial: Omit<DocumentTextExtractionResult, 'qualityHintKey' | 'displayText'> & {
    qualityHintKey?: TranslationKey;
    displayText?: string;
    partialRecognition?: boolean;
  },
): DocumentTextExtractionResult {
  const hasText = partial.recognizedText.trim().length > 0;
  const confidence = hasText ? partial.confidence : 'none';
  const displayText =
    partial.displayText ??
    (hasText ? sanitizeExtractedText(partial.recognizedText) : '');
  const qualityHintKey =
    partial.qualityHintKey ??
    buildQualityHintKey(confidence, hasText, partial.partialRecognition);

  if (!hasText && !partial.errorCode) {
    return {
      ...partial,
      displayText: '',
      confidence: 'none',
      errorCode: 'no_text',
      messageKey: OCR_TEXT_HINT_KEYS.noText,
      qualityHintKey,
      recognizedText: '',
    };
  }

  return {
    ...partial,
    displayText,
    confidence,
    qualityHintKey,
  };
}

function pickBestPdfVariant(
  directText: string,
  ocrText: string,
  ocrConfidence: number,
): {
  text: string;
  method: DocumentTextExtractionMethod;
  quality: ReturnType<typeof assessTextQuality>;
  ocrScore?: number;
} {
  const directQuality = assessTextQuality(directText);
  const ocrQuality = assessTextQuality(ocrText);

  if (directQuality.readable && directQuality.score >= ocrQuality.score) {
    return {
      text: directQuality.sanitizedText,
      method: 'pdf_direct',
      quality: directQuality,
    };
  }

  if (ocrQuality.readable || ocrQuality.score > directQuality.score) {
    return {
      text: ocrQuality.sanitizedText || ocrText.trim(),
      method: 'pdf_ocr',
      quality: ocrQuality,
      ocrScore: ocrConfidence,
    };
  }

  return {
    text: directQuality.sanitizedText || directText.trim(),
    method: 'pdf_direct',
    quality: directQuality,
  };
}

function resolveSourceTypeFromMeta(fileName: string, mimeType: string): DocumentTextSourceType | 'unsupported' {
  const ext = fileExtension(fileName);
  if (mimeType === 'application/pdf' || ext === '.pdf') return 'pdf';
  if (
    mimeType.startsWith('image/') ||
    ['.jpg', '.jpeg', '.png', '.heic', '.heif'].includes(ext)
  ) {
    return 'image';
  }
  return 'unsupported';
}

function estimatePdfPageCount(bytes: Uint8Array): number | undefined {
  const decoded = new TextDecoder('latin1').decode(bytes);
  const matches = decoded.match(/\/Type\s*\/Page\b/g);
  return matches && matches.length > 0 ? matches.length : undefined;
}

async function extractFromPdfBytes(
  bytes: Uint8Array,
  stableFile: File,
): Promise<DocumentTextExtractionResult> {
  const pageCount = await resolvePdfPageCount(bytes);
  const directExtraction = await extractTextFromPdfBytes(bytes);
  const directRaw = directExtraction.text;
  const directQuality = assessTextQuality(directRaw);

  let recognizedText = directQuality.sanitizedText;
  let extractionMethod: DocumentTextExtractionMethod = 'pdf_direct';
  let ocrScore: number | undefined;
  let quality = directQuality;
  let pagesProcessed: number | undefined;
  let pageTexts: Array<{ pageNumber: number; text: string }> | undefined = directExtraction.pageTexts;
  let ocrAttempted = false;
  let pdfErrorCode: DocumentTextErrorCode | undefined;

  if (shouldRunPdfOcr(directQuality)) {
    ocrAttempted = true;
    const ocr = await extractPdfTextViaOcr(stableFile, { pageCount, directTextQuality: directQuality });
    pagesProcessed = ocr.pagesProcessed;
    pageTexts = ocr.pageTexts;

    if (ocr.errorCode === 'password_required') {
      pdfErrorCode = 'password_required';
    } else if (ocr.errorCode === 'pdf_corrupt' || ocr.errorCode === 'render_failed') {
      pdfErrorCode = 'pdf_corrupt';
    }

    const picked = pickBestPdfVariant(directRaw, ocr.text, ocr.confidence);
    if (!directQuality.readable || picked.method === 'pdf_ocr') {
      recognizedText = picked.text;
      extractionMethod = picked.method;
      quality = picked.quality;
      ocrScore = picked.ocrScore;
    }
  }

  const confidence = deriveConfidence(recognizedText.length, ocrScore, quality.score);
  const partialRecognition = Boolean(recognizedText) && !quality.readable;

  if (!recognizedText.trim() && pdfErrorCode) {
    return finalizeResult({
      recognizedText: '',
      displayText: '',
      confidence: 'none',
      pageCount,
      pagesProcessed,
      pageTexts,
      sourceType: 'pdf',
      extractionMethod,
      ocrAttempted,
      errorCode: pdfErrorCode,
    });
  }

  return finalizeResult({
    recognizedText,
    displayText: recognizedText,
    confidence,
    pageCount,
    pagesProcessed,
    pageTexts,
    sourceType: 'pdf',
    extractionMethod,
    ocrAttempted,
    partialRecognition,
    qualityHintKey: partialRecognition ? OCR_TEXT_HINT_KEYS.partial : undefined,
  });
}

async function resolvePdfPageCount(bytes: Uint8Array): Promise<number | undefined> {
  try {
    return await getPdfPageCount(bytes);
  } catch {
    return estimatePdfPageCount(bytes);
  }
}

async function extractFromImage(file: File): Promise<DocumentTextExtractionResult> {
  try {
    let text = '';
    let score = 0;
    let layout: DocumentLayoutPage | undefined;

    if (imageOcrExtractorOverride) {
      const result = await imageOcrExtractorOverride(file);
      text = result.text;
      score = result.confidence;
    } else {
      const result = await recognizeImageOrCanvas(file);
      text = result.text;
      score = result.confidence;
      layout = result.layout;
    }

    // Visible facts are derived once, right here — no second analysis path.
    const visibleFacts = layout ? extractVisibleFactsFromLayout(layout) : undefined;

    const quality = assessTextQuality(text);
    const recognizedText = quality.sanitizedText || text.trim();
    const confidence = deriveConfidence(recognizedText.length, score, quality.score);
    const partialRecognition = Boolean(recognizedText) && !quality.readable;

    return finalizeResult({
      recognizedText,
      displayText: recognizedText,
      confidence,
      pageCount: 1,
      sourceType: 'image',
      extractionMethod: 'image_ocr',
      partialRecognition,
      layout,
      visibleFacts,
      errorCode: recognizedText ? undefined : 'no_text',
      messageKey: recognizedText ? undefined : OCR_TEXT_HINT_KEYS.noText,
      qualityHintKey: partialRecognition ? OCR_TEXT_HINT_KEYS.partial : undefined,
    });
  } catch {
    return finalizeResult({
      recognizedText: '',
      displayText: '',
      confidence: 'none',
      sourceType: 'image',
      errorCode: 'ocr_failed',
      messageKey: OCR_TEXT_HINT_KEYS.noText,
    });
  }
}

export async function extractDocumentTextFromCache(
  payload: CachedDocumentFilePayload,
): Promise<DocumentTextExtractionResult> {
  const stableFile = stableFileFromCachedPayload(payload);

  const sourceType = resolveSourceTypeFromMeta(payload.fileName, payload.mimeType);

  if (sourceType === 'unsupported') {
    return finalizeResult({
      recognizedText: '',
      displayText: '',
      confidence: 'none',
      sourceType: 'image',
      errorCode: 'unsupported_format',
      messageKey: OCR_TEXT_HINT_KEYS.unsupportedFormat,
    });
  }

  if (sourceType === 'pdf') {
    return extractFromPdfBytes(payload.bytes, stableFile);
  }

  return extractFromImage(stableFile);
}

export async function extractDocumentText(file: File): Promise<DocumentTextExtractionResult> {
  const loaded = await loadCachedDocumentFileFromUpload(file);
  if (!loaded.success) {
    if (loaded.error === 'heic_conversion_failed') {
      return finalizeResult({
        recognizedText: '',
        displayText: '',
        confidence: 'none',
        sourceType: 'image',
        errorCode: 'heic_conversion_failed',
      });
    }
    if (loaded.error === 'unsupported_photo_format') {
      return finalizeResult({
        recognizedText: '',
        displayText: '',
        confidence: 'none',
        sourceType: 'image',
        errorCode: 'heic_unsupported',
      });
    }
    if (loaded.error === 'invalid_type') {
      return finalizeResult({
        recognizedText: '',
        displayText: '',
        confidence: 'none',
        sourceType: 'image',
        errorCode: 'unsupported_format',
        messageKey: OCR_TEXT_HINT_KEYS.unsupportedFormat,
      });
    }
    if (loaded.error === 'file_too_large') {
      return finalizeResult({
        recognizedText: '',
        displayText: '',
        confidence: 'none',
        sourceType: 'image',
        errorCode: 'unsupported_format',
        messageKey: OCR_TEXT_HINT_KEYS.unsupportedFormat,
      });
    }
    return finalizeResult({
      recognizedText: '',
      displayText: '',
      confidence: 'none',
      sourceType: 'image',
      errorCode: 'ocr_failed',
      messageKey: OCR_TEXT_HINT_KEYS.noText,
    });
  }

  return extractDocumentTextFromCache(loaded.payload);
}

export function buildOcrPreviewSummary(
  fileName: string,
  recognizedText: string,
  kindHint?: UploadDocumentKind,
): OcrPreviewSummary {
  const item = createMockInboxItemFromUpload({
    sourceFileName: fileName,
    recognizedText,
    kind: kindHint,
  });

  const understanding = buildDocumentUnderstandingSummary(item, { recognizedText });
  const aiActions = buildDocumentAiActions(item.classifiedKind ?? 'sonstiges', understanding);
  const { lines: previewLines, usesPartialHint } = buildDisplayPreviewLines(recognizedText);
  const kind = item.classifiedKind ?? 'sonstiges';

  return {
    documentTypeLabelKey: getDocumentDisplayLabelKey(kind, item.documentType),
    sender: understanding.sender ?? (item.sender?.trim() || undefined),
    previewLines,
    previewPartialHint: usesPartialHint,
    understanding,
    aiActions,
  };
}
