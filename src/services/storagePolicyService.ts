import type { ClassifiedDocumentKind } from '../types/models';
import type {
  ResolvedStoragePolicy,
  StorageMediaProfile,
  StoragePolicyId,
} from '../types/storagePolicy';
import { isPdfUpload, isImageUpload } from './documentUploadValidation';
import type {
  DocumentTextExtractionMethod,
  DocumentTextSourceType,
  OcrConfidenceLevel,
} from './ocrDocumentService';
import { getStoragePolicyForKind } from './storagePolicyCatalog';

const FALLBACK_DETECTION_REASON = 'classification.detect.fallback';

const CONSTRUCTION_PHOTO_TEXT_PATTERN =
  /baustelle|baustellenfoto|schaden|fortschritt|material(?:nachweis)?|rohbau|abriss|gerüst|gertüst|mängel|maengel/i;

export interface ResolveStoragePolicyInput {
  classifiedKind: ClassifiedDocumentKind;
  detectionReasonKey: string;
  mimeType: string;
  fileName: string;
  extractionMethod?: DocumentTextExtractionMethod;
  sourceType?: DocumentTextSourceType;
  ocrConfidence?: OcrConfidenceLevel;
  recognizedText?: string;
}

export function resolveStorageMediaProfile(input: {
  mimeType: string;
  fileName: string;
  extractionMethod?: DocumentTextExtractionMethod;
  sourceType?: DocumentTextSourceType;
}): StorageMediaProfile {
  const mime = input.mimeType.trim().toLowerCase();
  const isPdf = isPdfUpload(mime, input.fileName) || input.sourceType === 'pdf';

  if (isPdf) {
    if (input.extractionMethod === 'pdf_ocr') {
      return 'scanned_pdf';
    }
    return 'native_pdf';
  }

  if (
    isImageUpload(mime, input.fileName) ||
    input.sourceType === 'image' ||
    input.extractionMethod === 'image_ocr'
  ) {
    return 'raster_image';
  }

  return 'raster_image';
}

function isWeakRecognition(input: ResolveStoragePolicyInput): boolean {
  return input.ocrConfidence === 'none' || input.ocrConfidence === 'low';
}

function isFallbackClassification(input: ResolveStoragePolicyInput): boolean {
  return (
    input.classifiedKind === 'sonstiges' ||
    input.detectionReasonKey === FALLBACK_DETECTION_REASON
  );
}

function isConfidentConstructionPhoto(input: ResolveStoragePolicyInput): boolean {
  if (input.classifiedKind === 'baustellenfoto') {
    return true;
  }
  if (input.classifiedKind !== 'foto') {
    return false;
  }
  if (isFallbackClassification(input) || isWeakRecognition(input)) {
    return false;
  }
  const text = input.recognizedText?.trim() ?? '';
  if (CONSTRUCTION_PHOTO_TEXT_PATTERN.test(text)) {
    return true;
  }
  return input.detectionReasonKey === 'classification.detect.baustellenfoto';
}

function resolveEffectivePolicyId(
  catalogPolicyId: StoragePolicyId,
  input: ResolveStoragePolicyInput,
): { policyId: StoragePolicyId; overrideApplied: boolean } {
  if (isFallbackClassification(input)) {
    return { policyId: 'temporary_unknown', overrideApplied: catalogPolicyId !== 'temporary_unknown' };
  }

  if (input.classifiedKind === 'foto') {
    if (isConfidentConstructionPhoto(input)) {
      return {
        policyId: 'construction_photo',
        overrideApplied: catalogPolicyId !== 'construction_photo',
      };
    }
    return { policyId: 'temporary_unknown', overrideApplied: false };
  }

  return { policyId: catalogPolicyId, overrideApplied: false };
}

export function resolveStoragePolicy(input: ResolveStoragePolicyInput): ResolvedStoragePolicy {
  const catalogPolicyId = getStoragePolicyForKind(input.classifiedKind);
  const mediaProfile = resolveStorageMediaProfile(input);
  const { policyId, overrideApplied } = resolveEffectivePolicyId(catalogPolicyId, input);

  return {
    policyId,
    catalogPolicyId,
    mediaProfile,
    classifiedKind: input.classifiedKind,
    policyOverrideApplied: overrideApplied,
  };
}
