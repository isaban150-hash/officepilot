import { createMockInboxItemFromUpload } from './inboxUploadFactory';
import { extractTextFromPdfBytes } from './uploadTextExtractionService';
import type { UploadDocumentKind } from '../types/models';

export type DocumentTextSourceType = 'pdf' | 'image';

export type OcrConfidenceLevel = 'high' | 'medium' | 'low' | 'none';

export type DocumentTextErrorCode =
  | 'unsupported_format'
  | 'no_text'
  | 'ocr_failed'
  | 'heic_unsupported';

export interface DocumentTextExtractionResult {
  recognizedText: string;
  confidence: OcrConfidenceLevel;
  pageCount?: number;
  sourceType: DocumentTextSourceType;
  errorCode?: DocumentTextErrorCode;
  message?: string;
  qualityHint?: string;
}

export interface OcrPreviewSummary {
  documentTypeLabel: string;
  sender?: string;
  previewLines: string[];
  classifiedKind?: string;
}

type ImageOcrExtractor = (file: File) => Promise<{ text: string; confidence: number }>;

let imageOcrExtractorOverride: ImageOcrExtractor | null = null;

const NO_TEXT_MESSAGE =
  'Ich konnte keinen verwertbaren Text erkennen. Bitte fotografieren Sie das Dokument gerade und mit gutem Licht.';

const PARTIAL_TEXT_HINT =
  'Der Text konnte nur teilweise erkannt werden. Bitte prüfen Sie das Ergebnis.';

const UNSUPPORTED_FORMAT_MESSAGE =
  'Dieses Dateiformat wird nicht unterstützt. Bitte JPG, PNG oder PDF verwenden.';

const HEIC_UNSUPPORTED_MESSAGE =
  'HEIC wird in diesem Browser nicht unterstützt. Bitte JPG oder PNG verwenden.';

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
  const ext = fileExtension(file.name);
  return ext === '.heic' || ext === '.heif' || file.type === 'image/heic' || file.type === 'image/heif';
}

function deriveConfidence(textLength: number, ocrScore?: number): OcrConfidenceLevel {
  if (textLength <= 0) return 'none';
  if (ocrScore !== undefined) {
    if (ocrScore >= 75 && textLength >= 40) return 'high';
    if (ocrScore >= 45 || textLength >= 25) return 'medium';
    return 'low';
  }
  if (textLength >= 100) return 'high';
  if (textLength >= 20) return 'medium';
  return 'low';
}

function buildQualityHint(confidence: OcrConfidenceLevel, hasText: boolean): string | undefined {
  if (!hasText) return NO_TEXT_MESSAGE;
  if (confidence === 'low') return PARTIAL_TEXT_HINT;
  return undefined;
}

function estimatePdfPageCount(bytes: Uint8Array): number | undefined {
  const decoded = new TextDecoder('latin1').decode(bytes);
  const matches = decoded.match(/\/Type\s*\/Page\b/g);
  return matches && matches.length > 0 ? matches.length : undefined;
}

function finalizeResult(
  partial: Omit<DocumentTextExtractionResult, 'qualityHint'> & { qualityHint?: string },
): DocumentTextExtractionResult {
  const hasText = partial.recognizedText.trim().length > 0;
  const confidence = hasText ? partial.confidence : 'none';
  const qualityHint =
    partial.qualityHint ?? buildQualityHint(confidence, hasText);

  if (!hasText && !partial.errorCode) {
    return {
      ...partial,
      confidence: 'none',
      errorCode: 'no_text',
      message: NO_TEXT_MESSAGE,
      qualityHint,
      recognizedText: '',
    };
  }

  return {
    ...partial,
    confidence,
    qualityHint,
  };
}

async function extractFromPdf(file: File): Promise<DocumentTextExtractionResult> {
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const recognizedText = extractTextFromPdfBytes(bytes);
  const confidence = deriveConfidence(recognizedText.trim().length);

  return finalizeResult({
    recognizedText,
    confidence,
    pageCount: estimatePdfPageCount(bytes),
    sourceType: 'pdf',
  });
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
      const { createWorker } = await import('tesseract.js');
      const worker = await createWorker('deu', 1, {
        logger: () => {},
      });
      const { data } = await worker.recognize(file);
      await worker.terminate();
      text = data.text ?? '';
      score = data.confidence ?? 0;
    }

    const recognizedText = text.trim();
    const confidence = deriveConfidence(recognizedText.length, score);

    return finalizeResult({
      recognizedText,
      confidence,
      pageCount: 1,
      sourceType: 'image',
      errorCode: recognizedText ? undefined : 'no_text',
      message: recognizedText ? undefined : NO_TEXT_MESSAGE,
    });
  } catch {
    if (isHeicFile(file)) {
      return finalizeResult({
        recognizedText: '',
        confidence: 'none',
        sourceType: 'image',
        errorCode: 'heic_unsupported',
        message: HEIC_UNSUPPORTED_MESSAGE,
      });
    }

    return finalizeResult({
      recognizedText: '',
      confidence: 'none',
      sourceType: 'image',
      errorCode: 'ocr_failed',
      message: NO_TEXT_MESSAGE,
    });
  }
}

export async function extractDocumentText(file: File): Promise<DocumentTextExtractionResult> {
  const sourceType = resolveSourceType(file);

  if (sourceType === 'unsupported') {
    return finalizeResult({
      recognizedText: '',
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

  const previewLines = recognizedText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 3);

  return {
    documentTypeLabel: item.documentType,
    sender: item.sender?.trim() || undefined,
    previewLines,
    classifiedKind: item.classifiedKind,
  };
}

export {
  NO_TEXT_MESSAGE,
  PARTIAL_TEXT_HINT,
  UNSUPPORTED_FORMAT_MESSAGE,
  HEIC_UNSUPPORTED_MESSAGE,
};
