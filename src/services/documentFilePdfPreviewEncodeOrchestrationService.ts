import type { DocumentFileTransformPlan } from '../types/documentFileTransformPlan';
import { planDocumentFilePdfDerivativeEncode } from './documentFilePdfDerivativeEncodePlanService';
import { encodeDocumentFilePdfPageToJpeg } from './documentFilePdfPageJpegEncodeService';
import { persistDerivedPreviewRepresentationBinding } from './documentFileRepresentationDerivedPreviewBindingPersistenceService';
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

const LOG_PREFIX = '[OfficePilot:pdf-preview-encode]';

export type PdfPreviewEncodeOrchestrationResult =
  | {
      readonly kind: 'noop';
      readonly reason:
        | 'missing_transform_plan'
        | 'no_preview_intent'
        | 'encode_plan_unresolved'
        | 'missing_document'
        | 'missing_file_ref'
        | 'not_committed'
        | 'missing_bytes';
    }
  | {
      readonly kind: 'persisted';
      readonly registration: 'created' | 'unchanged';
      readonly previewFileRefId: string;
      readonly createdPreviewFileRef: boolean;
    }
  | {
      readonly kind: 'conflict';
    }
  | {
      readonly kind: 'error';
      readonly error: unknown;
    };

export interface OrchestratePdfPreviewEncodeAfterImportInput {
  documentId: string;
  /** Pre-built transform plan; never re-resolved from policy here. */
  transformPlan: DocumentFileTransformPlan | null | undefined;
}

function reportInfrastructureError(error: unknown): void {
  console.error(LOG_PREFIX, error);
}

function previewFileNameFromOriginal(originalFileName: string): string {
  const trimmed = originalFileName.trim();
  const dot = trimmed.lastIndexOf('.');
  const base = dot > 0 ? trimmed.slice(0, dot) : trimmed || 'preview';
  return `${base}.preview.jpg`;
}

async function releaseCreatedPreviewFileRef(fileRefId: string | null): Promise<void> {
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
 * Post-import orchestration for page_1_preview_jpeg_encode.
 * Expected skips are no-ops; encode/store/binding failures are logged and returned
 * without throwing, so importInboxDocument can stay successful.
 */
export async function orchestratePdfPreviewEncodeAfterImport(
  input: OrchestratePdfPreviewEncodeAfterImportInput,
): Promise<PdfPreviewEncodeOrchestrationResult> {
  let createdPreviewFileRefId: string | null = null;
  let ownedCreatedBinding: ExactDocumentFileRepresentationBindingKey | null = null;

  try {
    if (input === null || typeof input !== 'object') {
      throw new TypeError('Invalid pdf preview encode orchestration input');
    }
    if (typeof input.documentId !== 'string' || input.documentId.trim().length === 0) {
      throw new TypeError('Invalid pdf preview encode orchestration documentId');
    }

    const transformPlan = input.transformPlan;
    if (!transformPlan) {
      return { kind: 'noop', reason: 'missing_transform_plan' };
    }

    const previewIntent = transformPlan.intents.find((entry) => entry.intent === 'create_preview');
    if (!previewIntent) {
      return { kind: 'noop', reason: 'no_preview_intent' };
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
      transformIntent: previewIntent,
      sourceMimeType: sourceFileRef.mimeType,
    });

    if (encodePlan.kind !== 'page_1_preview_jpeg_encode') {
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
        fileName: previewFileNameFromOriginal(sourceFileRef.originalFileName),
        mimeType: encoded.mimeType,
        fileSize: encoded.bytes.byteLength,
        bytes: encoded.bytes,
      },
      { lifecycleIntent: 'committed' },
    );

    if (stored.created) {
      createdPreviewFileRefId = stored.fileRef.id;
    }

    if (stored.fileRef.lifecycleStatus !== 'committed') {
      await releaseCreatedPreviewFileRef(createdPreviewFileRefId);
      createdPreviewFileRefId = null;
      throw new TypeError('PDF preview encode produced a non-committed FileRef');
    }

    const documentAfterStore = getDocumentById(input.documentId);
    if (!documentAfterStore || documentAfterStore.fileRefId !== document.fileRefId) {
      await releaseCreatedPreviewFileRef(createdPreviewFileRefId);
      createdPreviewFileRefId = null;
      throw new TypeError('PDF preview encode must not mutate document.fileRefId');
    }

    const registration = persistDerivedPreviewRepresentationBinding({
      documentId: input.documentId,
      previewFileRefId: stored.fileRef.id,
    });

    if (registration.kind === 'conflict') {
      await releaseCreatedPreviewFileRef(createdPreviewFileRefId);
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
      createdPreviewFileRefId = null;
      return {
        kind: 'persisted',
        registration: 'created',
        previewFileRefId: stored.fileRef.id,
        createdPreviewFileRef: stored.created,
      };
    }

    if (registration.kind === 'unchanged') {
      createdPreviewFileRefId = null;
      return {
        kind: 'persisted',
        registration: 'unchanged',
        previewFileRefId: stored.fileRef.id,
        createdPreviewFileRef: stored.created,
      };
    }

    await releaseCreatedPreviewFileRef(createdPreviewFileRefId);
    return { kind: 'noop', reason: 'encode_plan_unresolved' };
  } catch (error) {
    await rollbackOwnedDerivedRepresentationCreation({
      createdBinding: ownedCreatedBinding,
      createdFileRefId: createdPreviewFileRefId,
      reportError: reportInfrastructureError,
    });
    reportInfrastructureError(error);
    return { kind: 'error', error };
  }
}
