/**
 * Overlay merge / protection rules for Document Work Result re-analysis.
 *
 * 01A/FIX-01: preserve overlay entries only. Do not apply confirmed values
 * onto BusinessInterpretation (that is a later sprint).
 */
import type {
  DocumentWorkResult,
  DocumentWorkResultOverlayEntry,
} from '../types/documentWorkResult';

function cloneOverlayEntry(entry: DocumentWorkResultOverlayEntry): DocumentWorkResultOverlayEntry {
  return {
    slotId: entry.slotId,
    status: entry.status,
    value: entry.value === undefined ? null : JSON.parse(JSON.stringify(entry.value)),
    updatedAt: entry.updatedAt,
    analysisVersionAtWrite: entry.analysisVersionAtWrite,
    reviewConflict: entry.reviewConflict,
    conflictReason: entry.conflictReason,
  };
}

/**
 * Apply previous overlay onto a fresh projection.
 * - user_confirmed / user_corrected: preserved (never silently replaced)
 * - discarded: preserved
 * - fingerprint change: mark protected entries as reviewConflict (idempotent, no duplicate entries)
 * - analysisVersion change: overlay kept; snapshot core replaced by `next`
 */
export function mergeDocumentWorkResultOnReanalysis(
  previous: DocumentWorkResult | null | undefined,
  nextProjected: DocumentWorkResult,
): DocumentWorkResult {
  if (!previous) {
    return {
      ...nextProjected,
      overlay: [],
    };
  }

  const fingerprintChanged = previous.sourceFingerprint !== nextProjected.sourceFingerprint;
  const overlay = previous.overlay.map((entry) => {
    const cloned = cloneOverlayEntry(entry);
    if (
      fingerprintChanged &&
      (cloned.status === 'user_confirmed' ||
        cloned.status === 'user_corrected' ||
        cloned.status === 'discarded')
    ) {
      // Idempotent: already-conflicted entries stay a single overlay row.
      if (cloned.reviewConflict && cloned.conflictReason === 'source_fingerprint_changed') {
        return cloned;
      }
      return {
        ...cloned,
        reviewConflict: true,
        conflictReason: 'source_fingerprint_changed',
      };
    }
    return cloned;
  });

  return {
    ...nextProjected,
    // Preserve workspace binding from previous when next omits it.
    workspaceId: nextProjected.workspaceId ?? previous.workspaceId ?? null,
    overlay,
  };
}

/** Upsert a single overlay entry (test / future confirm UI). */
export function upsertDocumentWorkResultOverlayEntry(
  result: DocumentWorkResult,
  entry: DocumentWorkResultOverlayEntry,
): DocumentWorkResult {
  const overlay = result.overlay.filter((existing) => existing.slotId !== entry.slotId);
  overlay.push(cloneOverlayEntry(entry));
  return { ...result, overlay };
}

/**
 * Resolve overlay metadata for a slot (does not apply values to BI).
 */
export function resolveDocumentWorkResultOverlaySlot(
  result: DocumentWorkResult,
  slotId: string,
): DocumentWorkResultOverlayEntry | null {
  return result.overlay.find((entry) => entry.slotId === slotId) ?? null;
}
