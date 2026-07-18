import type { DocumentFileRepresentationBindingRegistrationResult } from '../types/documentFileRepresentationBindingRegistration';
import type { DocumentFileRepresentationSourceReuseBindingPlan } from '../types/documentFileRepresentationSourceReuseBindingPlan';
import { createDocumentFileRepresentationBinding } from './documentFileRepresentationBindingService';
import { registerDocumentFileRepresentationBinding } from './documentFileRepresentationBindingRegistrationService';
import {
  getDocumentFileRepresentationBindingStoreSnapshot,
  replaceDocumentFileRepresentationBindingStore,
} from './documentFileRepresentationBindingStoreService';
import { getDocumentById } from './documentService';
import { getDocumentFileRefById } from './documentFileStoreService';
import { persistAll } from './persistenceService';

export interface PersistSourceReuseArchiveRepresentationBindingInput {
  documentId: string;
  plan: DocumentFileRepresentationSourceReuseBindingPlan;
}

function assertSourceReuseArchivePlan(
  plan: unknown,
): asserts plan is DocumentFileRepresentationSourceReuseBindingPlan {
  if (
    plan === null ||
    typeof plan !== 'object' ||
    (plan as { mode?: unknown }).mode !== 'reuse_source_file' ||
    (plan as { targetKind?: unknown }).targetKind !== 'archive' ||
    typeof (plan as { sourceFileRefId?: unknown }).sourceFileRefId !== 'string' ||
    (plan as { sourceFileRefId: string }).sourceFileRefId.length === 0 ||
    (plan as { sourceFileRefId: string }).sourceFileRefId.trim().length === 0
  ) {
    throw new TypeError('Invalid source reuse archive binding plan');
  }
}

/**
 * Persist archive → source FileRef for a CompanyDocument after source_reuse materialization.
 * Uses pure registration; writes store only for created/unchanged; never replaces on conflict.
 */
export function persistSourceReuseArchiveRepresentationBinding(
  input: PersistSourceReuseArchiveRepresentationBindingInput,
): DocumentFileRepresentationBindingRegistrationResult {
  if (input === null || typeof input !== 'object') {
    throw new TypeError('Invalid source reuse archive binding persistence input');
  }

  if (typeof input.documentId !== 'string' || input.documentId.trim().length === 0) {
    throw new TypeError('Invalid source reuse archive binding documentId');
  }

  assertSourceReuseArchivePlan(input.plan);

  const document = getDocumentById(input.documentId);
  if (!document) {
    throw new TypeError('Document not found for source reuse archive binding');
  }

  if (!document.fileRefId || document.fileRefId !== input.plan.sourceFileRefId) {
    throw new TypeError('Document original fileRefId must match source reuse archive plan');
  }

  const sourceFileRef = getDocumentFileRefById(input.plan.sourceFileRefId);
  if (!sourceFileRef) {
    throw new TypeError('Source FileRef not found for source reuse archive binding');
  }

  if (sourceFileRef.lifecycleStatus !== 'committed') {
    throw new TypeError('Source FileRef must be committed for source reuse archive binding');
  }

  const binding = createDocumentFileRepresentationBinding({
    documentId: input.documentId,
    kind: 'archive',
    fileRefId: input.plan.sourceFileRefId,
  });

  const result = registerDocumentFileRepresentationBinding({
    bindings: getDocumentFileRepresentationBindingStoreSnapshot(),
    binding,
  });

  if (result.kind === 'conflict') {
    return result;
  }

  replaceDocumentFileRepresentationBindingStore(result.bindings);
  if (result.kind === 'created') {
    persistAll();
  }

  return result;
}
