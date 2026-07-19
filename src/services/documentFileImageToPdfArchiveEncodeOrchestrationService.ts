import type { DocumentFileTransformPlan } from '../types/documentFileTransformPlan';
import { resolveDocumentFileArchiveTransformResolution } from './documentFileArchiveTransformResolutionService';
import { planDocumentFileImageToPdfArchiveEncode } from './documentFileImageToPdfArchiveEncodePlanService';
import { encodeDocumentFileImageToPdf } from './documentFileImageToPdfWriteService';
import { persistDerivedArchiveRepresentationBinding } from './documentFileRepresentationDerivedArchiveBindingPersistenceService';
import {
  getDocumentFileRepresentationBindingStoreSnapshot,
  replaceDocumentFileRepresentationBindingStore,
} from './documentFileRepresentationBindingStoreService';
import { getDocumentById } from './documentService';
import {
  getDocumentFileRefById,
  getOriginalDocumentFileBytes,
  storeDocumentFileFromCachedPayload,
} from './documentFileStoreService';
import { releaseDocumentFileIfUnreferenced } from './documentFileReferenceService';

const LOG_PREFIX = '[OfficePilot:image-to-pdf-archive-encode]';

export type ImageToPdfArchiveEncodeOrchestrationResult =
  | {
      readonly kind: 'noop';
      readonly reason:
        | 'missing_transform_plan'
        | 'no_archive_intent'
        | 'encode_plan_unresolved'
        | 'missing_document'
        | 'missing_file_ref'
        | 'not_committed'
        | 'missing_bytes';
    }
  | {
      readonly kind: 'persisted';
      readonly registration: 'created' | 'unchanged';
      readonly archiveFileRefId: string;
      readonly createdArchiveFileRef: boolean;
    }
  | {
      readonly kind: 'conflict';
    }
  | {
      readonly kind: 'error';
      readonly error: unknown;
    };

export interface OrchestrateImageToPdfArchiveEncodeAfterImportInput {
  documentId: string;
  /** Pre-built transform plan; never re-resolved from policy here. */
  transformPlan: DocumentFileTransformPlan | null | undefined;
}

function reportInfrastructureError(error: unknown): void {
  console.error(LOG_PREFIX, error);
}

function archivePdfFileNameFromOriginal(originalFileName: string): string {
  const trimmed = originalFileName.trim();
  const dot = trimmed.lastIndexOf('.');
  const base = dot > 0 ? trimmed.slice(0, dot) : trimmed || 'archive';
  return `${base}.pdf`;
}

async function releaseCreatedArchiveFileRef(fileRefId: string | null): Promise<void> {
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
 * Post-import orchestration for image_to_pdf archive materialization.
 * Expected skips are no-ops; encode/store/binding failures are logged and returned
 * without throwing, so importInboxDocument can stay successful.
 */
export async function orchestrateImageToPdfArchiveEncodeAfterImport(
  input: OrchestrateImageToPdfArchiveEncodeAfterImportInput,
): Promise<ImageToPdfArchiveEncodeOrchestrationResult> {
  let createdArchiveFileRefId: string | null = null;
  const bindingsBefore = getDocumentFileRepresentationBindingStoreSnapshot();

  try {
    if (input === null || typeof input !== 'object') {
      throw new TypeError('Invalid image to pdf archive encode orchestration input');
    }
    if (typeof input.documentId !== 'string' || input.documentId.trim().length === 0) {
      throw new TypeError('Invalid image to pdf archive encode orchestration documentId');
    }

    const transformPlan = input.transformPlan;
    if (!transformPlan) {
      return { kind: 'noop', reason: 'missing_transform_plan' };
    }

    const archiveIntent = transformPlan.intents.find((entry) => entry.intent === 'create_archive');
    if (!archiveIntent) {
      return { kind: 'noop', reason: 'no_archive_intent' };
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

    const resolution = resolveDocumentFileArchiveTransformResolution({
      transformIntent: archiveIntent,
      hints: transformPlan.hints,
      sourceMimeType: sourceFileRef.mimeType,
    });

    const encodePlan = planDocumentFileImageToPdfArchiveEncode({
      transformIntent: archiveIntent,
      resolution,
      sourceMimeType: sourceFileRef.mimeType,
    });

    if (encodePlan.kind !== 'image_to_pdf') {
      return { kind: 'noop', reason: 'encode_plan_unresolved' };
    }

    const sourceBytes = await getOriginalDocumentFileBytes(sourceFileRef);
    if (!sourceBytes || sourceBytes.byteLength === 0) {
      return { kind: 'noop', reason: 'missing_bytes' };
    }

    const encoded = await encodeDocumentFileImageToPdf({
      bytes: sourceBytes,
      sourceMimeType: encodePlan.sourceMimeType,
    });

    const stored = await storeDocumentFileFromCachedPayload(
      {
        fileName: archivePdfFileNameFromOriginal(sourceFileRef.originalFileName),
        mimeType: encoded.mimeType,
        fileSize: encoded.bytes.byteLength,
        bytes: encoded.bytes,
      },
      { lifecycleIntent: 'committed' },
    );

    if (stored.created) {
      createdArchiveFileRefId = stored.fileRef.id;
    }

    if (stored.fileRef.lifecycleStatus !== 'committed') {
      await releaseCreatedArchiveFileRef(createdArchiveFileRefId);
      createdArchiveFileRefId = null;
      throw new TypeError('Image to pdf archive encode produced a non-committed FileRef');
    }

    const documentAfterStore = getDocumentById(input.documentId);
    if (!documentAfterStore || documentAfterStore.fileRefId !== document.fileRefId) {
      await releaseCreatedArchiveFileRef(createdArchiveFileRefId);
      createdArchiveFileRefId = null;
      throw new TypeError('Image to pdf archive encode must not mutate document.fileRefId');
    }

    const registration = persistDerivedArchiveRepresentationBinding({
      documentId: input.documentId,
      archiveFileRefId: stored.fileRef.id,
    });

    if (registration.kind === 'conflict') {
      await releaseCreatedArchiveFileRef(createdArchiveFileRefId);
      return { kind: 'conflict' };
    }

    if (registration.kind === 'created' || registration.kind === 'unchanged') {
      createdArchiveFileRefId = null;
      return {
        kind: 'persisted',
        registration: registration.kind,
        archiveFileRefId: stored.fileRef.id,
        createdArchiveFileRef: stored.created,
      };
    }

    await releaseCreatedArchiveFileRef(createdArchiveFileRefId);
    return { kind: 'noop', reason: 'encode_plan_unresolved' };
  } catch (error) {
    try {
      replaceDocumentFileRepresentationBindingStore(bindingsBefore);
    } catch (restoreError) {
      reportInfrastructureError(restoreError);
    }
    await releaseCreatedArchiveFileRef(createdArchiveFileRefId);
    reportInfrastructureError(error);
    return { kind: 'error', error };
  }
}
