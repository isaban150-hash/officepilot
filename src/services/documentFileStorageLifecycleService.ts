import type { DocumentFileRef } from '../types/documentFileRef';

export { DOCUMENT_FILE_LIFECYCLE_STATUSES } from '../types/documentFileRef';
export type { DocumentFileLifecycleStatus } from '../types/documentFileRef';

const DEFAULT_TEMP_TTL_MS = 24 * 60 * 60 * 1000;

export function buildCommittedLifecycleFields(createdAt: string): {
  lifecycleStatus: 'committed';
  committedAt: string;
} {
  return {
    lifecycleStatus: 'committed',
    committedAt: createdAt,
  };
}

export function buildTempLifecycleFields(ttlMs = DEFAULT_TEMP_TTL_MS): {
  lifecycleStatus: 'temp';
  expiresAt: string;
} {
  return {
    lifecycleStatus: 'temp',
    expiresAt: new Date(Date.now() + ttlMs).toISOString(),
  };
}

export function normalizeDocumentFileRefLifecycle(ref: DocumentFileRef): DocumentFileRef {
  if (ref.lifecycleStatus === 'committed') {
    return {
      ...ref,
      committedAt: ref.committedAt ?? ref.createdAt,
    };
  }
  if (ref.lifecycleStatus) {
    return { ...ref };
  }
  return {
    ...ref,
    ...buildCommittedLifecycleFields(ref.createdAt),
  };
}

export function migrateDocumentFileRefsToCommitted(refs: DocumentFileRef[]): DocumentFileRef[] {
  return refs.map(normalizeDocumentFileRefLifecycle);
}

export function isCommittedFileRefLifecycle(ref: DocumentFileRef): boolean {
  return ref.lifecycleStatus === 'committed' || !ref.lifecycleStatus;
}
