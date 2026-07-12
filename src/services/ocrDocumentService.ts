import { createMockInboxItemFromUpload } from './inboxUploadFactory';
import { isHeicUploadFile } from './documentUploadValidation';
import { extractTextFromPdfBytes } from './uploadTextExtractionService';
import { extractPdfTextViaOcr, shouldRunPdfOcr } from './pdfOcrFallbackService';
import { getPdfPageCount } from './pdfDocumentService';
import { recognizeImageOrCanvas } from './tesseractOcrService';
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
import type { UploadDocumentKind } from '../types/models';

export type DocumentTextSourceType = 'pdf' | 'image';
export type OcrConfidenceLevel = 'high' | 'medium' | 'low' | 'none';
export type DocumentTextExtractionMethod = 'pdf_direct' | 'pdf_ocr' | 'image_ocr';

export type DocumentTextErrorCode =
  | 'unsupported_format'
  | 'no_text'
  | 'ocr_failed'
  | 'heic_unsupported'
  | 'password_required'
  | 'pdf_corrupt';

export interface DocumentTextExtractionResult {
  recognizedText: string;
  displayText: string;
  confidence: OcrConfidenceLevel;
  pageCount?: number;
  pagesProcessed?: number;
  pageTexts?: Array<{ pageNumber: number; text: string }>;
  sourceType: DocumentTextSourceType;
  extractionMethod?: DocumentTextExtractionMethod;
  ocrAttempted?: boolean;
  errorCode?: DocumentTextErrorCode;
  message?: string;
  qualityHint?: string;
}

export interface OcrPreviewSummary {
  documentTypeLabel: string;
  sender?: string;
  previewLines: string[];
  classifiedKind?: string;
  understanding?: DocumentUnderstandingSummary;
  aiActions?: DocumentAiAction[];
}

type ImageOcrExtractor = (file: File) => Promise<{ text: string; confidence: number }>;

let imageOcrExtractorOverride: ImageOcrExtractor | null = null;

const NO_TEXT_MESSAGE =
  'Ich konnte keinen verwertbaren Text erkennen. Bitte fotografieren Sie das Dokument gerade und mit gutem Licht.';

const PARTIAL_TEXT_HINT =
  'Der Text konnte nur teilweise erkannt werden. Bitte prüfen Sie das Ergebnis.';

const UNSUPPORTED_FORMAT_MESSAGE =
  'Dieses Dateiformat wird nicht unterstützt. Bitte JPG, PNG oder PDF verwenden.';

export function setImageOcrExtractorForTests(extractor: ImageOcrExtractor | null): void {
  imageOcrExtractorOverride = extractor;
}

function fileExtension(name: string): string {
  const index = name.lastIndexOf('.');
  return index === -1 ? '' : name.slice(index).toLowerCase();
}

function resolveSourceType(file: File): DocumentTextSourceType | 'unsupported' {
  const ext = fileExtension(file.name);
  if (file.type === 'application/pdf' || ext === '.pdf') return 'pdf';
  if (
    file.type.startsWith('image/') ||
    ['.jpg', '.jpeg', '.png', '.heic', '.heif'].includes(ext)
  ) {
    return 'image';
  }
  return 'unsupported';
}

function isHeicFile(file: File): boolean {
  return isHeicUploadFile(file);
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

function buildQualityHint(
  confidence: OcrConfidenceLevel,
  hasText: boolean,
  partialRecognition = false,
): string | undefined {
  if (!hasText) return NO_TEXT_MESSAGE;
  if (confidence === 'low' || partialRecognition) return PARTIAL_TEXT_HINT;
  return undefined;
}

function estimatePdfPageCount(bytes: Uint8Array): number | undefined {
  const decoded = new TextDecoder('latin1').decode(bytes);
  const matches = decoded.match(/\/Type\s*\/Page\b/g);
  return matches && matches.length > 0 ? matches.length : undefined;
}

function finalizeResult(
  partial: Omit<DocumentTextExtractionResult, 'qualityHint' | 'displayText'> & {
    qualityHint?: string;
    displayText?: string;
    partialRecognition?: boolean;
  },
): DocumentTextExtractionResult {
  const hasText = partial.recognizedText.trim().length > 0;
  const confidence = hasText ? partial.confidence : 'none';
  const displayText =
    partial.displayText ??
    (hasText ? sanitizeExtractedText(partial.recognizedText) : '');
  const qualityHint =
    partial.qualityHint ??
    buildQualityHint(confidence, hasText, partial.partialRecognition);

  if (!hasText && !partial.errorCode) {
    return {
      ...partial,
      displayText: '',
      confidence: 'none',
      errorCode: 'no_text',
      message: NO_TEXT_MESSAGE,
      qualityHint,
      recognizedText: '',
    };
  }

  return {
    ...partial,
    displayText,
    confidence,
    qualityHint,
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

async function extractFromPdf(file: File): Promise<DocumentTextExtractionResult> {
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const pageCount = await resolvePdfPageCount(bytes);
  const directRaw = extractTextFromPdfBytes(bytes);
  const directQuality = assessTextQuality(directRaw);

  let recognizedText = directQuality.sanitizedText;
  let extractionMethod: DocumentTextExtractionMethod = 'pdf_direct';
  let ocrScore: number | undefined;
  let quality = directQuality;
  let pagesProcessed: number | undefined;
  let pageTexts: Array<{ pageNumber: number; text: string }> | undefined;
  let ocrAttempted = false;
  let pdfErrorCode: DocumentTextErrorCode | undefined;
  let pdfErrorMessage: string | undefined;

  if (shouldRunPdfOcr(directQuality)) {
    ocrAttempted = true;
    const ocr = await extractPdfTextViaOcr(file, { pageCount, directTextQuality: directQuality });
    pagesProcessed = ocr.pagesProcessed;
    pageTexts = ocr.pageTexts;

    if (ocr.errorCode === 'password_required') {
      pdfErrorCode = 'password_required';
      pdfErrorMessage = ocr.message;
    } else if (ocr.errorCode === 'pdf_corrupt' || ocr.errorCode === 'render_failed') {
      pdfErrorCode = 'pdf_corrupt';
      pdfErrorMessage = ocr.message;
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
      message: pdfErrorMessage,
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
    qualityHint: partialRecognition ? PARTIAL_TEXT_HINT : undefined,
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

    if (imageOcrExtractorOverride) {
      const result = await imageOcrExtractorOverride(file);
      text = result.text;
      score = result.confidence;
    } else {
      const result = await recognizeImageOrCanvas(file);
      text = result.text;
      score = result.confidence;
    }

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
      errorCode: recognizedText ? undefined : 'no_text',
      message: recognizedText ? undefined : NO_TEXT_MESSAGE,
      qualityHint: partialRecognition ? PARTIAL_TEXT_HINT : undefined,
    });
  } catch {
    if (isHeicFile(file)) {
      return finalizeResult({
        recognizedText: '',
        displayText: '',
        confidence: 'none',
        sourceType: 'image',
        errorCode: 'heic_unsupported',
      });
    }

    return finalizeResult({
      recognizedText: '',
      displayText: '',
      confidence: 'none',
      sourceType: 'image',
      errorCode: 'ocr_failed',
      message: NO_TEXT_MESSAGE,
    });
  }
}

export async function extractDocumentText(file: File): Promise<DocumentTextExtractionResult> {
  if (isHeicUploadFile(file)) {
    return finalizeResult({
      recognizedText: '',
      displayText: '',
      confidence: 'none',
      sourceType: 'image',
      errorCode: 'heic_unsupported',
    });
  }

  const sourceType = resolveSourceType(file);

  if (sourceType === 'unsupported') {
    return finalizeResult({
      recognizedText: '',
      displayText: '',
      confidence: 'none',
      sourceType: 'image',
      errorCode: 'unsupported_format',
      message: UNSUPPORTED_FORMAT_MESSAGE,
    });
  }

  if (sourceType === 'pdf') {
    return extractFromPdf(file);
  }

  return extractFromImage(file);
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
  const previewLines = buildDisplayPreviewLines(recognizedText, PARTIAL_TEXT_HINT);

  return {
    documentTypeLabel: item.documentType,
    sender: understanding.sender ?? (item.sender?.trim() || undefined),
    previewLines,
    classifiedKind: item.classifiedKind,
    understanding,
    aiActions,
  };
}

export {
  NO_TEXT_MESSAGE,
  PARTIAL_TEXT_HINT,
  UNSUPPORTED_FORMAT_MESSAGE,
};
