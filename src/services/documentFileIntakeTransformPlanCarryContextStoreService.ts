import type { DocumentFileIntakeTransformPlanCarryContext } from '../types/documentFileIntakeTransformPlanCarryContext';

let contexts: DocumentFileIntakeTransformPlanCarryContext[] = [];

function cloneContext(
  entry: DocumentFileIntakeTransformPlanCarryContext,
): DocumentFileIntakeTransformPlanCarryContext {
  return Object.freeze({
    inboxItemId: entry.inboxItemId,
    policyId: entry.policyId,
    userDecision: entry.userDecision,
    mediaProfile: entry.mediaProfile,
    schemaVersion: entry.schemaVersion,
    capturedAt: entry.capturedAt,
  });
}

/**
 * Replace in-memory intake transform-plan carry contexts. Does not persist.
 */
export function hydrateDocumentFileIntakeTransformPlanCarryContextStore(
  entries: readonly DocumentFileIntakeTransformPlanCarryContext[] = [],
): void {
  if (!Array.isArray(entries)) {
    throw new TypeError('Invalid intake transform plan carry store hydrate input');
  }
  contexts = entries.map(cloneContext);
}

export function resetDocumentFileIntakeTransformPlanCarryContextStoreForTests(): void {
  contexts = [];
}

export function getDocumentFileIntakeTransformPlanCarryContextStoreSnapshot(): DocumentFileIntakeTransformPlanCarryContext[] {
  return contexts.map(cloneContext);
}

export function replaceDocumentFileIntakeTransformPlanCarryContextStore(
  entries: readonly DocumentFileIntakeTransformPlanCarryContext[],
): void {
  if (!Array.isArray(entries)) {
    throw new TypeError('Invalid intake transform plan carry store replace input');
  }
  contexts = entries.map(cloneContext);
}

export function findDocumentFileIntakeTransformPlanCarryContext(
  inboxItemId: string,
): DocumentFileIntakeTransformPlanCarryContext | null {
  if (typeof inboxItemId !== 'string' || inboxItemId.trim().length === 0) {
    throw new TypeError('Invalid intake transform plan carry inboxItemId');
  }
  const found = contexts.find((entry) => entry.inboxItemId === inboxItemId);
  return found ? cloneContext(found) : null;
}

export function removeDocumentFileIntakeTransformPlanCarryContextForInboxItem(
  inboxItemId: string,
): number {
  if (typeof inboxItemId !== 'string' || inboxItemId.trim().length === 0) {
    throw new TypeError('Invalid intake transform plan carry inboxItemId');
  }
  const before = contexts.length;
  contexts = contexts.filter((entry) => entry.inboxItemId !== inboxItemId);
  return before - contexts.length;
}
