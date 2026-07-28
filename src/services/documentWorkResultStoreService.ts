import type { DocumentWorkResult } from '../types/documentWorkResult';
import { DOCUMENT_WORK_RESULT_SCHEMA_VERSION } from '../types/documentWorkResult';

let results: DocumentWorkResult[] = [];

function cloneResult(entry: DocumentWorkResult): DocumentWorkResult {
  return JSON.parse(JSON.stringify(entry)) as DocumentWorkResult;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Structural + schema guard for hydration. Never throws for bad entries.
 */
export function isValidDocumentWorkResultEntry(entry: unknown): entry is DocumentWorkResult {
  if (!entry || typeof entry !== 'object') return false;
  const candidate = entry as Partial<DocumentWorkResult>;
  if (candidate.schemaVersion !== DOCUMENT_WORK_RESULT_SCHEMA_VERSION) return false;
  if (!isNonEmptyString(candidate.inboxItemId)) return false;
  if (!isNonEmptyString(candidate.analyzedAt)) return false;
  if (!isNonEmptyString(candidate.analysisVersion)) return false;
  if (!isNonEmptyString(candidate.sourceFingerprint)) return false;
  if (!candidate.specialistRefs || typeof candidate.specialistRefs !== 'object') return false;
  if (!Array.isArray(candidate.overlay)) return false;
  if (
    candidate.businessInterpretation !== null &&
    (typeof candidate.businessInterpretation !== 'object' ||
      candidate.businessInterpretation === undefined)
  ) {
    return false;
  }
  return true;
}

function assertValidEntry(entry: DocumentWorkResult): void {
  if (!isValidDocumentWorkResultEntry(entry)) {
    throw new TypeError('Invalid document work result entry');
  }
}

/**
 * Replace in-memory Document Work Result snapshots. Does not persist by itself.
 * Invalid / unknown-schema entries are skipped so App hydration never aborts.
 */
export function hydrateDocumentWorkResultStore(entries: readonly unknown[] = []): void {
  if (!Array.isArray(entries)) {
    console.warn(
      '[OfficePilot] Ungültige documentWorkResults – Document-Work-Result-Store wird geleert.',
    );
    results = [];
    return;
  }
  const next: DocumentWorkResult[] = [];
  for (const entry of entries) {
    if (!isValidDocumentWorkResultEntry(entry)) {
      console.warn(
        '[OfficePilot] DocumentWorkResult-Eintrag übersprungen (ungültig oder unbekannte schemaVersion).',
      );
      continue;
    }
    next.push(cloneResult(entry));
  }
  results = next;
}

export function resetDocumentWorkResultStoreForTests(): void {
  results = [];
}

export function getDocumentWorkResultStoreSnapshot(): DocumentWorkResult[] {
  return results.map(cloneResult);
}

export function replaceDocumentWorkResultStore(entries: readonly DocumentWorkResult[]): void {
  if (!Array.isArray(entries)) {
    throw new TypeError('Invalid document work result store replace input');
  }
  results = entries.map((entry) => {
    assertValidEntry(entry);
    return cloneResult(entry);
  });
}

export type GetDocumentWorkResultOptions = {
  /**
   * When both the snapshot and this option carry a non-empty workspace id,
   * a mismatch yields null (foreign workspace). Missing workspace on either
   * side remains readable for backward compatibility.
   */
  workspaceId?: string | null;
};

function workspaceMismatch(
  entryWorkspaceId: string | null | undefined,
  requestedWorkspaceId: string | null | undefined,
): boolean {
  if (!isNonEmptyString(requestedWorkspaceId)) return false;
  if (!isNonEmptyString(entryWorkspaceId)) return false;
  return entryWorkspaceId !== requestedWorkspaceId;
}

export function getDocumentWorkResult(
  inboxItemId: string,
  options?: GetDocumentWorkResultOptions,
): DocumentWorkResult | null {
  if (typeof inboxItemId !== 'string' || inboxItemId.trim().length === 0) {
    throw new TypeError('Invalid document work result inboxItemId');
  }
  const found = results.find((entry) => entry.inboxItemId === inboxItemId);
  if (!found) return null;
  if (workspaceMismatch(found.workspaceId, options?.workspaceId)) {
    return null;
  }
  return cloneResult(found);
}

export function upsertDocumentWorkResult(entry: DocumentWorkResult): DocumentWorkResult {
  assertValidEntry(entry);
  const cloned = cloneResult(entry);
  const index = results.findIndex((existing) => existing.inboxItemId === cloned.inboxItemId);
  if (index >= 0) {
    results[index] = cloned;
  } else {
    results.push(cloned);
  }
  return cloneResult(cloned);
}

export function removeDocumentWorkResultForInboxItem(inboxItemId: string): number {
  if (typeof inboxItemId !== 'string' || inboxItemId.trim().length === 0) {
    throw new TypeError('Invalid document work result inboxItemId');
  }
  const before = results.length;
  results = results.filter((entry) => entry.inboxItemId !== inboxItemId);
  return before - results.length;
}
