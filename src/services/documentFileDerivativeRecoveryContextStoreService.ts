import type { DocumentFileDerivativeRecoveryContext } from '../types/documentFileDerivativeRecoveryContext';
import type { DocumentFileTransformPlan } from '../types/documentFileTransformPlan';

let contexts: DocumentFileDerivativeRecoveryContext[] = [];

function cloneTransformPlan(plan: DocumentFileTransformPlan): DocumentFileTransformPlan {
  return Object.freeze({
    policyId: plan.policyId,
    mediaProfile: plan.mediaProfile,
    hints: Object.freeze({
      metadataHandling: plan.hints.metadataHandling,
      colorHandling: plan.hints.colorHandling,
      preferredOutputKind: plan.hints.preferredOutputKind,
    }),
    intents: Object.freeze(
      plan.intents.map((intent) =>
        Object.freeze({
          targetKind: intent.targetKind,
          intent: intent.intent,
          executionIntent: intent.executionIntent,
        }),
      ),
    ),
  }) as DocumentFileTransformPlan;
}

function cloneContext(
  entry: DocumentFileDerivativeRecoveryContext,
): DocumentFileDerivativeRecoveryContext {
  const cloned: DocumentFileDerivativeRecoveryContext = {
    documentId: entry.documentId,
    transformPlan: cloneTransformPlan(entry.transformPlan),
    capturedAt: entry.capturedAt,
    schemaVersion: entry.schemaVersion,
  };
  if (entry.origin) {
    (cloned as { origin?: typeof entry.origin }).origin = Object.freeze({
      policyId: entry.origin.policyId,
      decision: entry.origin.decision,
      mediaProfile: entry.origin.mediaProfile,
    });
  }
  return Object.freeze(cloned);
}

/**
 * Replace in-memory recovery contexts. Does not persist.
 */
export function hydrateDocumentFileDerivativeRecoveryContextStore(
  entries: readonly DocumentFileDerivativeRecoveryContext[] = [],
): void {
  if (!Array.isArray(entries)) {
    throw new TypeError('Invalid derivative recovery context store hydrate input');
  }
  contexts = entries.map(cloneContext);
}

export function resetDocumentFileDerivativeRecoveryContextStoreForTests(): void {
  contexts = [];
}

export function getDocumentFileDerivativeRecoveryContextStoreSnapshot(): DocumentFileDerivativeRecoveryContext[] {
  return contexts.map(cloneContext);
}

export function replaceDocumentFileDerivativeRecoveryContextStore(
  entries: readonly DocumentFileDerivativeRecoveryContext[],
): void {
  if (!Array.isArray(entries)) {
    throw new TypeError('Invalid derivative recovery context store replace input');
  }
  contexts = entries.map(cloneContext);
}

export function findDocumentFileDerivativeRecoveryContext(
  documentId: string,
): DocumentFileDerivativeRecoveryContext | null {
  if (typeof documentId !== 'string' || documentId.trim().length === 0) {
    throw new TypeError('Invalid derivative recovery context documentId');
  }
  const found = contexts.find((entry) => entry.documentId === documentId);
  return found ? cloneContext(found) : null;
}

export function removeDocumentFileDerivativeRecoveryContextsForDocument(
  documentId: string,
): number {
  if (typeof documentId !== 'string' || documentId.trim().length === 0) {
    throw new TypeError('Invalid derivative recovery context documentId');
  }
  const before = contexts.length;
  contexts = contexts.filter((entry) => entry.documentId !== documentId);
  return before - contexts.length;
}
