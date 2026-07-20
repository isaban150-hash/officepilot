import type { DocumentFileTransformPlan } from '../types/documentFileTransformPlan';
import { planDocumentFilePdfDerivativeEncode } from './documentFilePdfDerivativeEncodePlanService';
import { encodeDocumentFilePdfPageToJpeg } from './documentFilePdfPageJpegEncodeService';
import { persistDerivedThumbnailRepresentationBinding } from './documentFileRepresentationDerivedThumbnailBindingPersistenceService';
import {
  rollbackOwnedDerivedRepresentationCreation,
  type ExactDocumentFileRepresentationBindingKey,
} from './documentFileRepresentationDerivedBindingRollbackService';
import { getDocumentById } from './documentService';
import {
  getDocumentFileRefById,
  getOriginalDocumentFileBytes,
  storeDocumentFileFromCachedPayload,
} from './documentFileStoreService';
import { releaseDocumentFileIfUnreferenced } from './documentFileReferenceService';
import { persistAll } from './persistenceService';

const LOG_PREFIX = '[OfficePilot:pdf-thumbnail-encode]';

export type PdfThumbnailEncodeOrchestrationResult =
  | {
      readonly kind: 'noop';
      readonly reason:
        | 'missing_transform_plan'
        | 'no_thumbnail_intent'
        | 'encode_plan_unresolved'
        | 'missing_document'
        | 'missing_file_ref'
        | 'not_committed'
        | 'missing_bytes';
    }
  | {
      readonly kind: 'persisted';
      readonly registration: 'created' | 'unchanged';
      readonly thumbnailFileRefId: string;
      readonly createdThumbnailFileRef: boolean;
    }
  | {
      readonly kind: 'conflict';
    }
  | {
      readonly kind: 'error';
      readonly error: unknown;
    };

export interface OrchestratePdfThumbnailEncodeAfterImportInput {
  documentId: string;
  /** Pre-built transform plan; never re-resolved from policy here. */
  transformPlan: DocumentFileTransformPlan | null | undefined;
}

function reportInfrastructureError(error: unknown): void {
  console.error(LOG_PREFIX, error);
}

function thumbnailFileNameFromOriginal(originalFileName: string): string {
  const trimmed = originalFileName.trim();
  const dot = trimmed.lastIndexOf('.');
  const base = dot > 0 ? trimmed.slice(0, dot) : trimmed || 'thumbnail';
  return `${base}.thumb.jpg`;
}

async function releaseCreatedThumbnailFileRef(fileRefId: string | null): Promise<void> {
  if (!fileRefId) {
    return;
  }
  try {
    await releaseDocumentFileIfUnreferenced(fileRefId);
  } catch (error) {
    reportInfrastructureError(error);
  }
}

/**
 * Post-import orchestration for page_1_thumbnail_jpeg_encode.
 * Expected skips are no-ops; encode/store/binding failures are logged and returned
 * without throwing, so importInboxDocument can stay successful.
 */
export async function orchestratePdfThumbnailEncodeAfterImport(
  input: OrchestratePdfThumbnailEncodeAfterImportInput,
): Promise<PdfThumbnailEncodeOrchestrationResult> {
  let createdThumbnailFileRefId: string | null = null;
  let ownedCreatedBinding: ExactDocumentFileRepresentationBindingKey | null = null;

  try {
    if (input === null || typeof input !== 'object') {
      throw new TypeError('Invalid pdf thumbnail encode orchestration input');
    }
    if (typeof input.documentId !== 'string' || input.documentId.trim().length === 0) {
      throw new TypeError('Invalid pdf thumbnail encode orchestration documentId');
    }

    const transformPlan = input.transformPlan;
    if (!transformPlan) {
      return { kind: 'noop', reason: 'missing_transform_plan' };
    }

    const thumbnailIntent = transformPlan.intents.find(
      (entry) => entry.intent === 'create_thumbnail',
    );
    if (!thumbnailIntent) {
      return { kind: 'noop', reason: 'no_thumbnail_intent' };
    }

    const document = getDocumentById(input.documentId);
    if (!document) {
      return { kind: 'noop', reason: 'missing_document' };
    }
    if (!document.fileRefId) {
      return { kind: 'noop', reason: 'missing_file_ref' };
    }

    const sourceFileRef = getDocumentFileRefById(document.fileRefId);
    if (!sourceFileRef) {
      return { kind: 'noop', reason: 'missing_file_ref' };
    }
    if (sourceFileRef.lifecycleStatus !== 'committed') {
      return { kind: 'noop', reason: 'not_committed' };
    }

    const encodePlan = planDocumentFilePdfDerivativeEncode({
      transformIntent: thumbnailIntent,
      sourceMimeType: sourceFileRef.mimeType,
    });

    if (encodePlan.kind !== 'page_1_thumbnail_jpeg_encode') {
      return { kind: 'noop', reason: 'encode_plan_unresolved' };
    }

    const sourceBytes = await getOriginalDocumentFileBytes(sourceFileRef);
    if (!sourceBytes || sourceBytes.byteLength === 0) {
      return { kind: 'noop', reason: 'missing_bytes' };
    }

    const encoded = await encodeDocumentFilePdfPageToJpeg({
      bytes: sourceBytes,
      pageNumber: encodePlan.pageNumber,
      quality: encodePlan.quality,
      maxEdge: encodePlan.maxEdge,
    });

    const stored = await storeDocumentFileFromCachedPayload(
      {
        fileName: thumbnailFileNameFromOriginal(sourceFileRef.originalFileName),
        mimeType: encoded.mimeType,
        fileSize: encoded.bytes.byteLength,
        bytes: encoded.bytes,
      },
      { lifecycleIntent: 'committed' },
    );

    if (stored.created) {
      createdThumbnailFileRefId = stored.fileRef.id;
    }

    if (stored.fileRef.lifecycleStatus !== 'committed') {
      await releaseCreatedThumbnailFileRef(createdThumbnailFileRefId);
      createdThumbnailFileRefId = null;
      throw new TypeError('PDF thumbnail encode produced a non-committed FileRef');
    }

    const documentAfterStore = getDocumentById(input.documentId);
    if (!documentAfterStore || documentAfterStore.fileRefId !== document.fileRefId) {
      await releaseCreatedThumbnailFileRef(createdThumbnailFileRefId);
      createdThumbnailFileRefId = null;
      throw new TypeError('PDF thumbnail encode must not mutate document.fileRefId');
    }

    const registration = persistDerivedThumbnailRepresentationBinding({
      documentId: input.documentId,
      thumbnailFileRefId: stored.fileRef.id,
    });

    if (registration.kind === 'conflict') {
      await releaseCreatedThumbnailFileRef(createdThumbnailFileRefId);
      return { kind: 'conflict' };
    }

    if (registration.kind === 'created') {
      ownedCreatedBinding = {
        documentId: registration.binding.documentId,
        kind: registration.binding.kind,
        fileRefId: registration.binding.fileRefId,
      };
      persistAll();
      ownedCreatedBinding = null;
      createdThumbnailFileRefId = null;
      return {
        kind: 'persisted',
        registration: 'created',
        thumbnailFileRefId: stored.fileRef.id,
        createdThumbnailFileRef: stored.created,
      };
    }

    if (registration.kind === 'unchanged') {
      createdThumbnailFileRefId = null;
      return {
        kind: 'persisted',
        registration: 'unchanged',
        thumbnailFileRefId: stored.fileRef.id,
        createdThumbnailFileRef: stored.created,
      };
    }

    await releaseCreatedThumbnailFileRef(createdThumbnailFileRefId);
    return { kind: 'noop', reason: 'encode_plan_unresolved' };
  } catch (error) {
    await rollbackOwnedDerivedRepresentationCreation({
      createdBinding: ownedCreatedBinding,
      createdFileRefId: createdThumbnailFileRefId,
      reportError: reportInfrastructureError,
    });
    reportInfrastructureError(error);
    return { kind: 'error', error };
  }
}
