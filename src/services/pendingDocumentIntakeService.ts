import type { UploadDocumentKind } from '../types/models';
import type { CachedDocumentFilePayload } from './cachedDocumentFileService';
import { loadCachedDocumentFileFromUpload, releaseCachedDocumentFile } from './cachedDocumentFileService';
import {
  intakeCachedDocumentFile,
  type DocumentIntakeOptions,
  type DocumentIntakeResult,
} from './documentIntakeService';
import {
  isBlockingExtractionError,
  type DocumentUploadErrorCode,
} from './documentUploadErrorService';
import { isHeicUploadFile } from './documentUploadValidation';
import type { CreateInboxFromUploadOptions } from './inboxUploadFactory';
import type { PersistingUserStorageDecision } from '../types/userStorageDecision';
import type { StorageRecommendation } from '../types/storageRecommendation';
import type { ResolvedStoragePolicy } from '../types/storagePolicy';
import { classifyDocument } from './documentClassificationService';
import {
  buildStorageRecommendation,
} from './storageRecommendationService';
import { resolveStoragePolicy } from './storagePolicyService';
import {
  buildOcrPreviewSummary,
  extractDocumentTextFromCache,
  type DocumentTextExtractionResult,
  type OcrPreviewSummary,
} from './ocrDocumentService';
import { validateUserStorageDecision } from './userStorageDecisionService';

export interface PendingDocumentIntake {
  cachedFile: CachedDocumentFilePayload;
  extraction: DocumentTextExtractionResult;
  preview: OcrPreviewSummary;
  storageRecommendation: StorageRecommendation;
  storagePolicy: ResolvedStoragePolicy;
}

export type ProcessDocumentPreviewResult =
  | { success: true; pending: PendingDocumentIntake }
  | { success: false; error: DocumentUploadErrorCode };

export async function processDocumentFileForPreview(
  file: File,
  options: { selectedKind?: UploadDocumentKind } = {},
): Promise<ProcessDocumentPreviewResult> {
  if (isHeicUploadFile(file)) {
    return { success: false, error: 'heic_unsupported' };
  }

  const loaded = await loadCachedDocumentFileFromUpload(file);
  if (!loaded.success) {
    if (loaded.error === 'unsupported_photo_format') {
      return { success: false, error: 'heic_unsupported' };
    }
    if (loaded.error === 'file_too_large') {
      return { success: false, error: 'file_too_large' };
    }
    return { success: false, error: 'file_read_failed' };
  }

  const extraction = await extractDocumentTextFromCache(loaded.payload);
  if (isBlockingExtractionError(extraction.errorCode)) {
    return { success: false, error: extraction.errorCode ?? 'ocr_failed' };
  }

  const preview = buildOcrPreviewSummary(
    loaded.payload.fileName,
    extraction.recognizedText,
    options.selectedKind,
  );

  const classificationInput = {
    sourceFileName: loaded.payload.fileName,
    kindHint: options.selectedKind,
    recognizedText: extraction.recognizedText,
  };
  const classification = classifyDocument(classificationInput);

  const storageRecommendation = await buildStorageRecommendation({
    cachedFile: loaded.payload,
    recognizedText: extraction.recognizedText,
    extraction,
    kindHint: options.selectedKind,
    sourceFileName: loaded.payload.fileName,
  });

  const storagePolicy = resolveStoragePolicy({
    classifiedKind: classification.classifiedKind,
    detectionReasonKey: classification.detectionReasonKey,
    mimeType: loaded.payload.mimeType,
    fileName: loaded.payload.fileName,
    extractionMethod: extraction.extractionMethod,
    sourceType: extraction.sourceType,
    ocrConfidence: extraction.confidence,
    recognizedText: extraction.recognizedText,
  });

  return {
    success: true,
    pending: {
      cachedFile: loaded.payload,
      extraction,
      preview,
      storageRecommendation,
      storagePolicy,
    },
  };
}

export interface ConfirmPendingDocumentIntakeOptions extends CreateInboxFromUploadOptions {
  userDecision: PersistingUserStorageDecision;
}

export async function confirmPendingDocumentIntake(
  pending: PendingDocumentIntake,
  options: ConfirmPendingDocumentIntakeOptions,
): Promise<DocumentIntakeResult> {
  const validation = validateUserStorageDecision({
    decision: options.userDecision,
    recommendation: pending.storageRecommendation,
    storagePolicy: pending.storagePolicy,
  });

  if (!validation.valid) {
    return { success: false, error: 'navigation_failed' };
  }

  const recognizedText = pending.extraction.recognizedText.trim() || undefined;
  const intakeOptions: DocumentIntakeOptions = {
    ...options,
    sourceFileName: pending.cachedFile.fileName,
    recognizedText,
    pageTexts: pending.extraction.pageTexts,
    userDecision: options.userDecision,
    allowDuplicateIntake: options.userDecision === 'save_duplicate_anyway',
  };

  return intakeCachedDocumentFile(pending.cachedFile, intakeOptions);
}

export function discardPendingDocumentIntake(pending: PendingDocumentIntake | null | undefined): void {
  if (!pending) return;
  releaseCachedDocumentFile(pending.cachedFile);
}
