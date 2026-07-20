import type { DocumentFileTransformPlan } from '../types/documentFileTransformPlan';
import { resolveDocumentFileArchiveTransformResolution } from './documentFileArchiveTransformResolutionService';
import { planDocumentFilePdfMetadataStrip } from './documentFilePdfMetadataStripPlanService';
import { stripDocumentFilePdfInfoMetadata } from './documentFilePdfMetadataStripService';
import { persistDerivedArchiveRepresentationBinding } from './documentFileRepresentationDerivedArchiveBindingPersistenceService';
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

const LOG_PREFIX = '[OfficePilot:pdf-metadata-strip]';

export type PdfMetadataStripOrchestrationResult =
  | {
      readonly kind: 'noop';
      readonly reason:
        | 'missing_transform_plan'
        | 'no_archive_intent'
        | 'strip_plan_unresolved'
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

export interface OrchestratePdfMetadataStripAfterImportInput {
  documentId: string;
  /** Pre-built transform plan; never re-resolved from policy here. */
  transformPlan: DocumentFileTransformPlan | null | undefined;
}

function reportInfrastructureError(error: unknown): void {
  console.error(LOG_PREFIX, error);
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
 * Post-import orchestration for pdf_info_metadata_strip archive materialization.
 * Clears classic Info metadata into a new/deduped committed FileRef and binds archive.
 * Leaves the original FileRef unchanged. Does not claim XMP full removal.
 * Expected skips are no-ops; strip/store/binding failures are logged and returned
 * without throwing, so importInboxDocument can stay successful.
 */
export async function orchestratePdfMetadataStripAfterImport(
  input: OrchestratePdfMetadataStripAfterImportInput,
): Promise<PdfMetadataStripOrchestrationResult> {
  let createdArchiveFileRefId: string | null = null;
  let ownedCreatedBinding: ExactDocumentFileRepresentationBindingKey | null = null;

  try {
    if (input === null || typeof input !== 'object') {
      throw new TypeError('Invalid pdf metadata strip orchestration input');
    }
    if (typeof input.documentId !== 'string' || input.documentId.trim().length === 0) {
      throw new TypeError('Invalid pdf metadata strip orchestration documentId');
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

    const stripPlan = planDocumentFilePdfMetadataStrip({
      transformIntent: archiveIntent,
      resolution,
      sourceMimeType: sourceFileRef.mimeType,
    });

    if (stripPlan.kind !== 'pdf_info_metadata_strip') {
      return { kind: 'noop', reason: 'strip_plan_unresolved' };
    }

    const sourceBytes = await getOriginalDocumentFileBytes(sourceFileRef);
    if (!sourceBytes || sourceBytes.byteLength === 0) {
      return { kind: 'noop', reason: 'missing_bytes' };
    }

    const stripped = await stripDocumentFilePdfInfoMetadata({ bytes: sourceBytes });

    const stored = await storeDocumentFileFromCachedPayload(
      {
        fileName: sourceFileRef.originalFileName,
        mimeType: stripped.mimeType,
        fileSize: stripped.bytes.byteLength,
        bytes: stripped.bytes,
      },
      { lifecycleIntent: 'committed' },
    );

    if (stored.created) {
      createdArchiveFileRefId = stored.fileRef.id;
    }

    if (stored.fileRef.lifecycleStatus !== 'committed') {
      await releaseCreatedArchiveFileRef(createdArchiveFileRefId);
      createdArchiveFileRefId = null;
      throw new TypeError('Pdf metadata strip produced a non-committed FileRef');
    }

    const documentAfterStore = getDocumentById(input.documentId);
    if (!documentAfterStore || documentAfterStore.fileRefId !== document.fileRefId) {
      await releaseCreatedArchiveFileRef(createdArchiveFileRefId);
      createdArchiveFileRefId = null;
      throw new TypeError('Pdf metadata strip must not mutate document.fileRefId');
    }

    const registration = persistDerivedArchiveRepresentationBinding({
      documentId: input.documentId,
      archiveFileRefId: stored.fileRef.id,
    });

    if (registration.kind === 'conflict') {
      await releaseCreatedArchiveFileRef(createdArchiveFileRefId);
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
      createdArchiveFileRefId = null;
      return {
        kind: 'persisted',
        registration: 'created',
        archiveFileRefId: stored.fileRef.id,
        createdArchiveFileRef: stored.created,
      };
    }

    if (registration.kind === 'unchanged') {
      createdArchiveFileRefId = null;
      return {
        kind: 'persisted',
        registration: 'unchanged',
        archiveFileRefId: stored.fileRef.id,
        createdArchiveFileRef: stored.created,
      };
    }

    await releaseCreatedArchiveFileRef(createdArchiveFileRefId);
    return { kind: 'noop', reason: 'strip_plan_unresolved' };
  } catch (error) {
    await rollbackOwnedDerivedRepresentationCreation({
      createdBinding: ownedCreatedBinding,
      createdFileRefId: createdArchiveFileRefId,
      reportError: reportInfrastructureError,
    });
    reportInfrastructureError(error);
    return { kind: 'error', error };
  }
}
