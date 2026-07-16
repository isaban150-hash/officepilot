import type {
  ClassifiedDocumentKind,
  DocumentClassificationInput,
  UploadDocumentKind,
} from '../types/models';
import type {
  StorageEvidenceRef,
  StorageRecommendation,
  StorageRecommendationLevel,
} from '../types/storageRecommendation';
import type { CachedDocumentFilePayload } from './cachedDocumentFileService';
import type { DocumentTextExtractionResult } from './ocrDocumentService';
import type { DuplicateMatch } from './documentDuplicateService';
import { findDuplicateByContentHash } from './documentDuplicateService';
import {
  classifyDocument,
  suggestDigitalFolder,
  suggestRelatedVorgang,
} from './documentClassificationService';
import { defaultPriority } from './documentClassificationCatalog';
import { computeBufferContentHash } from './documentFileHashService';
import {
  extractFieldsWithConfidence,
  listUncertainFieldKeys,
  toConfidentPlainFields,
} from './documentFieldExtractionService';
import {
  isCustomerAssignmentMissing,
  isUnknownPresentationValue,
  resolvePresentationCustomer,
  resolveRecognitionStatus,
  resolveSteuerberaterPresentation,
  type PresentationContext,
} from './documentResultPresentationService';
import { assessTextQuality } from './textQualityService';

const ARCHIVE_REQUIRED_KINDS = new Set<ClassifiedDocumentKind>([
  'mahnung',
  'zahlungserinnerung',
  'steuerbescheid',
  'umsatzsteuerbescheid',
  'freistellungsbescheinigung',
  'unbedenklichkeitsbescheinigung',
]);

const HIGH_PRIORITY_AUTHORITY_KINDS = new Set<ClassifiedDocumentKind>(['finanzamt', 'bg_bau']);

const ARCHIVE_RECOMMENDED_KINDS = new Set<ClassifiedDocumentKind>([
  'eingangsrechnung',
  'rechnung',
  'ausgangsrechnung',
  'gutschrift',
  'tankbeleg',
  'kassenbeleg',
  'quittung',
  'ec_beleg',
  'kreditkartenbeleg',
  'reparaturrechnung',
  'werkvertrag',
  'subunternehmervertrag',
  'nachunternehmervertrag',
  'angebot',
  'auftrag',
  'auftragsbestaetigung',
  'aok',
  'barmer',
  'tk',
  'dak',
  'ikk',
  'knappschaft',
  'pflegekasse',
  'krankenkasse',
  'soka_bau',
]);

const CUSTOMER_ASSIGNMENT_KINDS = new Set<ClassifiedDocumentKind>([
  'auftrag',
  'angebot',
  'werkvertrag',
  'auftragsbestaetigung',
]);

const CRITICAL_FIELD_KINDS = new Set<ClassifiedDocumentKind>([
  'mahnung',
  'zahlungserinnerung',
  'eingangsrechnung',
  'rechnung',
  'steuerbescheid',
  'finanzamt',
]);

const TAX_DISCLAIMER_KEY = 'storageRecommendation.disclaimer.notLegalAdvice';

let evidenceCounter = 0;

function nextEvidenceId(prefix: string): string {
  evidenceCounter += 1;
  return `${prefix}-${evidenceCounter}`;
}

function resetEvidenceCounterForTests(): void {
  evidenceCounter = 0;
}

function inferClassificationConfidence(detectionReasonKey: string): number {
  if (
    detectionReasonKey.includes('explicit') ||
    detectionReasonKey.includes('filename') ||
    detectionReasonKey.includes('uploadHint')
  ) {
    return 0.9;
  }
  if (detectionReasonKey.includes('keyword') || detectionReasonKey.includes('hint')) {
    return 0.7;
  }
  if (detectionReasonKey === 'classification.detect.fallback') {
    return 0.35;
  }
  return 0.55;
}

function ocrConfidenceFactor(confidence: DocumentTextExtractionResult['confidence']): number {
  switch (confidence) {
    case 'high':
      return 1;
    case 'medium':
      return 0.85;
    case 'low':
      return 0.55;
    default:
      return 0.3;
  }
}

function hasConfidentDeadline(text: string): boolean {
  const fields = extractFieldsWithConfidence(text);
  const deadline = fields.Frist;
  return Boolean(deadline && deadline.confidence !== 'low' && deadline.value.trim());
}

function asRecognizedData(fields: ReturnType<typeof toConfidentPlainFields>): Record<string, string> {
  return fields as Record<string, string>;
}

function hasSecureVorgangAssignment(
  text: string,
  sender: string,
  title: string,
): boolean {
  const confident = toConfidentPlainFields(extractFieldsWithConfidence(text));
  if (confident.Vorgang?.trim() || confident.Baustelle?.trim() || confident.Projekt?.trim()) {
    return true;
  }
  const suggested = suggestRelatedVorgang(asRecognizedData(confident), sender, title);
  return suggested?.confidence === 'high' || suggested?.confidence === 'medium';
}

function resolveSenderFromEvidence(text: string, senderHint?: string): string | undefined {
  if (senderHint?.trim()) return senderHint.trim();
  const confident = toConfidentPlainFields(extractFieldsWithConfidence(text));
  const sender = confident.Absender ?? confident.Lieferant;
  return isUnknownPresentationValue(sender) ? undefined : sender?.trim();
}

function isClearAdvertisement(
  input: DocumentClassificationInput,
  detectionReasonKey: string,
  isAdvertisement: boolean,
): boolean {
  return (
    input.kindHint === 'werbung' ||
    detectionReasonKey === 'classification.detect.advertisement' ||
    isAdvertisement
  );
}

function resolveKindLevel(
  kind: ClassifiedDocumentKind,
  text: string,
  hasVorgang: boolean,
): { level: StorageRecommendationLevel; reasonKeys: string[] } {
  if (ARCHIVE_REQUIRED_KINDS.has(kind)) {
    return {
      level: 'archive_required',
      reasonKeys: [`storageRecommendation.reason.kind.${kind}`],
    };
  }

  if (HIGH_PRIORITY_AUTHORITY_KINDS.has(kind) && defaultPriority(kind) === 'hoch') {
    if (hasConfidentDeadline(text)) {
      return {
        level: 'archive_required',
        reasonKeys: [`storageRecommendation.reason.authorityDeadline.${kind}`],
      };
    }
    return {
      level: 'archive_recommended',
      reasonKeys: [`storageRecommendation.reason.kind.${kind}`],
    };
  }

  if (kind === 'baustellenfoto') {
    if (hasVorgang) {
      return {
        level: 'archive_recommended',
        reasonKeys: ['storageRecommendation.reason.baustellenfotoWithVorgang'],
      };
    }
    return {
      level: 'temporary_only',
      reasonKeys: ['storageRecommendation.reason.baustellenfotoTemporary'],
    };
  }

  if (ARCHIVE_RECOMMENDED_KINDS.has(kind)) {
    return {
      level: 'archive_recommended',
      reasonKeys: [`storageRecommendation.reason.kind.${kind}`],
    };
  }

  if (kind === 'sonstiges' || kind === 'brief' || kind === 'agentur_fuer_arbeit') {
    return {
      level: 'review_required',
      reasonKeys: [`storageRecommendation.reason.kind.${kind}`],
    };
  }

  return {
    level: 'review_required',
    reasonKeys: ['storageRecommendation.reason.unclearClassification'],
  };
}

function needsReviewGate(input: {
  kind: ClassifiedDocumentKind;
  documentType: PresentationContext['documentType'];
  detectionReasonKey: string;
  text: string;
  extraction: DocumentTextExtractionResult;
  uncertainFieldKeys: string[];
  presentationCustomer?: string;
  site?: string;
}): { required: boolean; reasonKeys: string[] } {
  const reasons: string[] = [];

  if (input.kind === 'sonstiges' || input.kind === 'brief') {
    reasons.push(`storageRecommendation.reason.kind.${input.kind}`);
  }

  if (input.detectionReasonKey === 'classification.detect.fallback') {
    reasons.push('storageRecommendation.reason.fallbackClassification');
  }

  if (input.extraction.confidence === 'none' || input.extraction.confidence === 'low') {
    reasons.push('storageRecommendation.reason.lowOcrQuality');
  }

  const quality = assessTextQuality(input.text);
  if (!quality.readable && quality.wordCount > 0) {
    reasons.push('storageRecommendation.reason.partialRecognition');
  }

  if (
    input.uncertainFieldKeys.length > 0 &&
    CRITICAL_FIELD_KINDS.has(input.kind) &&
    input.extraction.confidence !== 'high'
  ) {
    reasons.push('storageRecommendation.reason.uncertainCriticalFields');
  }

  const context: PresentationContext = {
    kind: input.kind,
    documentType: input.documentType,
    customer: input.presentationCustomer,
    site: input.site,
  };

  if (CUSTOMER_ASSIGNMENT_KINDS.has(input.kind) && isCustomerAssignmentMissing(context)) {
    reasons.push('storageRecommendation.reason.missingCustomer');
  }

  if (inferClassificationConfidence(input.detectionReasonKey) < 0.5) {
    reasons.push('storageRecommendation.reason.insufficientEvidence');
  }

  return { required: reasons.length > 0, reasonKeys: reasons };
}

function shouldApplyReviewOverArchive(
  baseLevel: StorageRecommendationLevel,
  reviewRequired: boolean,
): boolean {
  if (!reviewRequired) return false;
  return baseLevel === 'archive_required' || baseLevel === 'archive_recommended';
}

function buildEvidenceRefs(input: {
  detectionReasonKey: string;
  confidentFieldKeys: string[];
  duplicateMatch?: DuplicateMatch | null;
  hashChecked: boolean;
  folderFromCatalog: boolean;
}): StorageEvidenceRef[] {
  const refs: StorageEvidenceRef[] = [
    {
      id: nextEvidenceId('rules'),
      source: 'rules',
      detectionReasonKey: input.detectionReasonKey,
    },
  ];

  for (const fieldKey of input.confidentFieldKeys) {
    refs.push({
      id: nextEvidenceId('ocr'),
      source: 'ocr',
      fieldKey,
    });
  }

  if (input.folderFromCatalog) {
    refs.push({
      id: nextEvidenceId('catalog'),
      source: 'catalog',
    });
  }

  if (input.duplicateMatch) {
    refs.push({
      id: nextEvidenceId('duplicate'),
      source: 'duplicate',
      matchedEntityId: input.duplicateMatch.id,
    });
  } else if (input.hashChecked) {
    refs.push({
      id: nextEvidenceId('hash'),
      source: 'hash',
    });
  }

  return refs;
}

function resolveDisclaimer(
  level: StorageRecommendationLevel,
  steuerberaterHint: ReturnType<typeof resolveSteuerberaterPresentation>['status'],
): string | undefined {
  if (level === 'discard_recommended') return undefined;
  if (
    level === 'archive_required' ||
    steuerberaterHint === 'mark' ||
    steuerberaterHint === 'check'
  ) {
    return TAX_DISCLAIMER_KEY;
  }
  return undefined;
}

export async function findDuplicateByPayloadBytes(
  bytes: Uint8Array,
): Promise<{ match: DuplicateMatch | null; contentHash: string | null }> {
  try {
    const contentHash = await computeBufferContentHash(bytes);
    return {
      contentHash,
      match: findDuplicateByContentHash(contentHash),
    };
  } catch {
    return { contentHash: null, match: null };
  }
}

export async function buildStorageRecommendation(input: {
  cachedFile: CachedDocumentFilePayload;
  recognizedText: string;
  extraction: DocumentTextExtractionResult;
  kindHint?: UploadDocumentKind;
  sourceFileName?: string;
}): Promise<StorageRecommendation> {
  const text = input.recognizedText.trim();
  const classificationInput: DocumentClassificationInput = {
    sourceFileName: input.sourceFileName ?? input.cachedFile.fileName,
    kindHint: input.kindHint,
    recognizedText: text,
  };

  const classification = classifyDocument(classificationInput);
  const kind = classification.classifiedKind;
  const detectionReasonKey = classification.detectionReasonKey;

  const fieldsWithConfidence = extractFieldsWithConfidence(text);
  const confidentFields = toConfidentPlainFields(fieldsWithConfidence);
  const uncertainFieldKeys = listUncertainFieldKeys(fieldsWithConfidence);
  const presentationCustomer = resolvePresentationCustomer(null, asRecognizedData(confidentFields));
  const sender = resolveSenderFromEvidence(text) ?? 'Absender nicht eindeutig erkannt.';
  const title = input.sourceFileName ?? input.cachedFile.fileName;
  const hasVorgang = hasSecureVorgangAssignment(text, sender, title);
  const suggestedVorgang = suggestRelatedVorgang(asRecognizedData(confidentFields), sender, title);

  const duplicateLookup = await findDuplicateByPayloadBytes(input.cachedFile.bytes);
  const duplicateMatch = duplicateLookup.match;

  const steuerberater = resolveSteuerberaterPresentation(kind);
  const presentationContext: PresentationContext = {
    kind,
    documentType: classification.documentType,
    customer: presentationCustomer,
    site: confidentFields.Baustelle ?? confidentFields.Projekt,
  };
  const recognitionStatus = resolveRecognitionStatus(
    presentationContext,
    uncertainFieldKeys.length,
  );

  let level: StorageRecommendationLevel;
  let reasonKeys: string[];

  if (duplicateMatch) {
    level = 'duplicate_detected';
    reasonKeys = ['storageRecommendation.reason.duplicateDetected'];
  } else if (
    isClearAdvertisement(classificationInput, detectionReasonKey, classification.isAdvertisement ?? false)
  ) {
    level = 'discard_recommended';
    reasonKeys = ['storageRecommendation.reason.discardAdvertisement'];
  } else {
    const kindResult = resolveKindLevel(kind, text, hasVorgang);
    level = kindResult.level;
    reasonKeys = [...kindResult.reasonKeys];

    const reviewGate = needsReviewGate({
      kind,
      documentType: classification.documentType,
      detectionReasonKey,
      text,
      extraction: input.extraction,
      uncertainFieldKeys,
      presentationCustomer,
      site: confidentFields.Baustelle ?? confidentFields.Projekt,
    });

    if (shouldApplyReviewOverArchive(level, reviewGate.required)) {
      level = 'review_required';
      reasonKeys = [...new Set([...reasonKeys, ...reviewGate.reasonKeys])];
    } else if (reviewGate.required && level !== 'temporary_only' && level !== 'discard_recommended') {
      level = 'review_required';
      reasonKeys = [...new Set([...reasonKeys, ...reviewGate.reasonKeys])];
    }
  }

  const recommendedFolder = suggestDigitalFolder(kind, {
    customer: presentationCustomer ?? confidentFields.Kunde,
    vorgangTitle: confidentFields.Vorgang ?? suggestedVorgang?.vorgangTitle,
    sender,
  });

  let confidence = inferClassificationConfidence(detectionReasonKey);
  confidence *= ocrConfidenceFactor(input.extraction.confidence);
  if (uncertainFieldKeys.length > 0) confidence -= 0.15;
  if (recognitionStatus === 'assign_customer') confidence -= 0.2;
  if (recognitionStatus === 'review') confidence -= 0.1;
  if (duplicateMatch) confidence = 1;
  confidence = Math.max(0, Math.min(1, confidence));

  const confidentFieldKeys = Object.keys(confidentFields).filter(
    (key) => !isUnknownPresentationValue(confidentFields[key as keyof typeof confidentFields]),
  );

  const evidenceRefs = buildEvidenceRefs({
    detectionReasonKey,
    confidentFieldKeys,
    duplicateMatch,
    hashChecked: duplicateLookup.contentHash !== null,
    folderFromCatalog: true,
  });

  const disclaimerKey = resolveDisclaimer(level, steuerberater.status);

  return {
    level,
    reasonKeys,
    evidenceRefs,
    recommendedFolder,
    requiresUserConfirmation: true,
    duplicateFileRefId: duplicateMatch?.fileRefId,
    duplicateMatch: duplicateMatch
      ? { type: duplicateMatch.type, id: duplicateMatch.id, title: duplicateMatch.title }
      : undefined,
    confidence,
    recognitionStatus,
    steuerberaterHint: steuerberater.status,
    disclaimerKey,
    computedAt: new Date().toISOString(),
  };
}

export { resetEvidenceCounterForTests, TAX_DISCLAIMER_KEY };
