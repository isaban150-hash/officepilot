import type { DocumentFileTransformArchiveMaterializationResult } from '../types/documentFileTransformArchiveMaterialization';
import type { DocumentFileRepresentationSourceReuseBindingPlan } from '../types/documentFileRepresentationSourceReuseBindingPlan';

export interface PlanDocumentFileRepresentationSourceReuseBindingInput {
  materialization: DocumentFileTransformArchiveMaterializationResult;
  sourceFileRefId: string;
}

function assertSourceReuseMaterialization(
  materialization: unknown,
): asserts materialization is Extract<
  DocumentFileTransformArchiveMaterializationResult,
  { kind: 'source_reuse' }
> {
  if (
    materialization === null ||
    typeof materialization !== 'object' ||
    !('kind' in materialization) ||
    (materialization as { kind: unknown }).kind !== 'source_reuse'
  ) {
    throw new TypeError('Invalid source reuse binding materialization');
  }
}

function assertSourceFileRefId(sourceFileRefId: unknown): asserts sourceFileRefId is string {
  if (typeof sourceFileRefId !== 'string') {
    throw new TypeError('Invalid source reuse binding sourceFileRefId');
  }
  // Reject empty / whitespace-only; do not trim — caller string is returned unchanged.
  if (sourceFileRefId.length === 0 || sourceFileRefId.trim().length === 0) {
    throw new TypeError('Invalid source reuse binding sourceFileRefId');
  }
}

/**
 * Pure plan: archive role reuses an existing FileRef after source_reuse materialization.
 * Does not persist, check FileRef existence, or evaluate hints/capabilities.
 */
export function planDocumentFileRepresentationSourceReuseBinding(
  input: PlanDocumentFileRepresentationSourceReuseBindingInput,
): DocumentFileRepresentationSourceReuseBindingPlan {
  if (input === null || typeof input !== 'object') {
    throw new TypeError('Invalid source reuse binding input');
  }

  assertSourceReuseMaterialization(input.materialization);
  assertSourceFileRefId(input.sourceFileRefId);

  return Object.freeze({
    mode: 'reuse_source_file',
    targetKind: 'archive',
    sourceFileRefId: input.sourceFileRefId,
  });
}
