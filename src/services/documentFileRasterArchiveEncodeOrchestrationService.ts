import type { DocumentFileTransformPlan } from '../types/documentFileTransformPlan';
import { resolveDocumentFileArchiveTransformResolution } from './documentFileArchiveTransformResolutionService';
import { planDocumentFileRasterArchiveEncode } from './documentFileRasterArchiveEncodePlanService';
import { encodeDocumentFileRasterToJpeg } from './documentFileRasterEncodeService';
import { persistDerivedArchiveRepresentationBinding } from './documentFileRepresentationDerivedArchiveBindingPersistenceService';
import {
  rollbackOwnedDerivedRepresentationCreation,
  type ExactDocumentFileRepresentationBindingKey,
} from './documentFileRepresentationDerivedBindingRollbackService';
import {
  createDocumentFileDerivativeOrchestrationErrorResult,
  reportDocumentFileDerivativeStepError,
} from './documentFileDerivativeErrorReportingService';
import type { DocumentFileDerivativeStepErrorCode } from '../types/documentFileDerivativeStepOutcome';
import { getDocumentById } from './documentService';
import {
  getDocumentFileRefById,
  getOriginalDocumentFileBytes,
  storeDocumentFileFromCachedPayload,
} from './documentFileStoreService';
import { releaseDocumentFileIfUnreferenced } from './documentFileReferenceService';
import { persistAll } from './persistenceService';

const LOG_PREFIX = '[OfficePilot:raster-archive-encode]';
const STEP_ID = 'raster_archive' as const;

export type RasterArchiveEncodeOrchestrationResult =
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
      readonly errorCode: DocumentFileDerivativeStepErrorCode;
    };

export interface OrchestrateRasterArchiveEncodeAfterImportInput {
  documentId: string;
  /** Pre-built transform plan; never re-resolved from policy here. */
  transformPlan: DocumentFileTransformPlan | null | undefined;
}

function reportCode(errorCode: DocumentFileDerivativeStepErrorCode): void {
  reportDocumentFileDerivativeStepError(LOG_PREFIX, STEP_ID, errorCode);
}

function archiveFileNameFromOriginal(originalFileName: string): string {
  const trimmed = originalFileName.trim();
  const dot = trimmed.lastIndexOf('.');
  const base = dot > 0 ? trimmed.slice(0, dot) : trimmed || 'archive';
  return `${base}.jpg`;
}

async function releaseCreatedArchiveFileRef(fileRefId: string | null): Promise<void> {
  if (!fileRefId) {
    return;
  }
  try {
    await releaseDocumentFileIfUnreferenced(fileRefId);
  } catch {
    reportCode('cleanup_failed');
  }
}

/**
 * Post-import orchestration for raster_jpeg_reencode archive materialization.
 * Expected skips are no-ops; encode/store/binding failures are logged and returned
 * without throwing, so importInboxDocument can stay successful.
 */
export async function orchestrateRasterArchiveEncodeAfterImport(
  input: OrchestrateRasterArchiveEncodeAfterImportInput,
): Promise<RasterArchiveEncodeOrchestrationResult> {
  let createdArchiveFileRefId: string | null = null;
  let ownedCreatedBinding: ExactDocumentFileRepresentationBindingKey | null = null;

  try {
    if (input === null || typeof input !== 'object') {
      throw new TypeError('Invalid raster archive encode orchestration input');
    }
    if (typeof input.documentId !== 'string' || input.documentId.trim().length === 0) {
      throw new TypeError('Invalid raster archive encode orchestration documentId');
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

    const encodePlan = planDocumentFileRasterArchiveEncode({
      transformIntent: archiveIntent,
      resolution,
      sourceMimeType: sourceFileRef.mimeType,
    });

    if (encodePlan.kind !== 'raster_jpeg_reencode') {
      return { kind: 'noop', reason: 'encode_plan_unresolved' };
    }

    const sourceBytes = await getOriginalDocumentFileBytes(sourceFileRef);
    if (!sourceBytes || sourceBytes.byteLength === 0) {
      return { kind: 'noop', reason: 'missing_bytes' };
    }

    const encoded = await encodeDocumentFileRasterToJpeg({
      bytes: sourceBytes,
      sourceMimeType: encodePlan.sourceMimeType,
    });

    const stored = await storeDocumentFileFromCachedPayload(
      {
        fileName: archiveFileNameFromOriginal(sourceFileRef.originalFileName),
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
      throw new TypeError('Raster archive encode produced a non-committed FileRef');
    }

    // Original document.fileRefId must remain unchanged throughout.
    const documentAfterStore = getDocumentById(input.documentId);
    if (!documentAfterStore || documentAfterStore.fileRefId !== document.fileRefId) {
      await releaseCreatedArchiveFileRef(createdArchiveFileRefId);
      createdArchiveFileRefId = null;
      throw new TypeError('Raster archive encode must not mutate document.fileRefId');
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
    return { kind: 'noop', reason: 'encode_plan_unresolved' };
  } catch {
    await rollbackOwnedDerivedRepresentationCreation({
      createdBinding: ownedCreatedBinding,
      createdFileRefId: createdArchiveFileRefId,
      reportError: reportCode,
    });
    reportCode('unexpected_failure');
    return createDocumentFileDerivativeOrchestrationErrorResult('unexpected_failure');
  }
}
