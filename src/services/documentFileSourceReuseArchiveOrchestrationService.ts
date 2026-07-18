import type { DocumentFileTransformPlan } from '../types/documentFileTransformPlan';
import { resolveDocumentFileTransformArchiveMaterialization } from './documentFileTransformArchiveMaterializationService';
import { planDocumentFileRepresentationSourceReuseBinding } from './documentFileRepresentationSourceReuseBindingPlanService';
import { persistSourceReuseArchiveRepresentationBinding } from './documentFileRepresentationSourceReuseArchiveBindingPersistenceService';
import { getDocumentById } from './documentService';
import { getDocumentFileRefById } from './documentFileStoreService';

const LOG_PREFIX = '[OfficePilot:source-reuse-archive-binding]';

export type SourceReuseArchiveOrchestrationResult =
  | {
      readonly kind: 'noop';
      readonly reason:
        | 'missing_transform_plan'
        | 'no_archive_intent'
        | 'unresolved'
        | 'missing_document'
        | 'missing_file_ref'
        | 'not_committed';
    }
  | {
      readonly kind: 'persisted';
      readonly registration: 'created' | 'unchanged';
    }
  | {
      readonly kind: 'conflict';
    }
  | {
      readonly kind: 'error';
      readonly error: unknown;
    };

export interface OrchestrateSourceReuseArchiveBindingAfterImportInput {
  documentId: string;
  /** Pre-built transform plan; never re-resolved from document/FileRef here. */
  transformPlan: DocumentFileTransformPlan | null | undefined;
}

function reportInfrastructureError(error: unknown): void {
  console.error(LOG_PREFIX, error);
}

/**
 * Thin post-import orchestration for source-reuse archive bindings.
 * Expected skips are no-ops; unexpected failures are logged and returned as error
 * without throwing, so the import path can stay successful.
 */
export function orchestrateSourceReuseArchiveBindingAfterImport(
  input: OrchestrateSourceReuseArchiveBindingAfterImportInput,
): SourceReuseArchiveOrchestrationResult {
  try {
    if (input === null || typeof input !== 'object') {
      throw new TypeError('Invalid source reuse archive orchestration input');
    }
    if (typeof input.documentId !== 'string' || input.documentId.trim().length === 0) {
      throw new TypeError('Invalid source reuse archive orchestration documentId');
    }

    const transformPlan = input.transformPlan;
    if (!transformPlan) {
      return { kind: 'noop', reason: 'missing_transform_plan' };
    }

    const archiveIntent = transformPlan.intents.find((entry) => entry.intent === 'create_archive');
    if (!archiveIntent) {
      return { kind: 'noop', reason: 'no_archive_intent' };
    }

    const materialization = resolveDocumentFileTransformArchiveMaterialization({
      transformIntent: archiveIntent,
      hints: transformPlan.hints,
    });
    if (materialization.kind === 'unresolved') {
      return { kind: 'noop', reason: 'unresolved' };
    }

    const document = getDocumentById(input.documentId);
    if (!document) {
      return { kind: 'noop', reason: 'missing_document' };
    }
    if (!document.fileRefId) {
      return { kind: 'noop', reason: 'missing_file_ref' };
    }

    const fileRef = getDocumentFileRefById(document.fileRefId);
    if (!fileRef) {
      return { kind: 'noop', reason: 'missing_file_ref' };
    }
    if (fileRef.lifecycleStatus !== 'committed') {
      return { kind: 'noop', reason: 'not_committed' };
    }

    const bindingPlan = planDocumentFileRepresentationSourceReuseBinding({
      materialization,
      sourceFileRefId: document.fileRefId,
    });

    const registration = persistSourceReuseArchiveRepresentationBinding({
      documentId: input.documentId,
      plan: bindingPlan,
    });

    if (registration.kind === 'conflict') {
      return { kind: 'conflict' };
    }
    if (registration.kind === 'created' || registration.kind === 'unchanged') {
      return { kind: 'persisted', registration: registration.kind };
    }

    return { kind: 'noop', reason: 'unresolved' };
  } catch (error) {
    reportInfrastructureError(error);
    return { kind: 'error', error };
  }
}
