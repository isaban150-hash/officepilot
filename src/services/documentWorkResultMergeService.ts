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
    businessInterpretation: preserveSemanticCore(previous, nextProjected, fingerprintChanged),
    overlay,
  };
}

/**
 * DOKUMENTVERSTAENDNIS-01C — der semantische Kern überlebt eine erneute Analyse.
 *
 * Der belegte Fehler: Beim Öffnen eines gespeicherten Eingangsposten läuft die
 * Analyse noch einmal. Sie arbeitet dann auf dem **gespeicherten** Posten, und
 * der trägt seinen Volltext nicht mehr mit sich — ihr Ergebnis hat deshalb
 * keinen semantischen Kern. Weil hier bisher `...nextProjected` vollständig
 * gewann, überschrieb das leere Ergebnis den beim Hochladen berechneten Kern.
 * Die Bedeutung eines Schreibens verschwand also beim ersten Wiederöffnen,
 * obwohl sie auf der Platte lag.
 *
 * Übernommen wird ausschliesslich das fehlende Feld, und nur solange der
 * Quelltext derselbe ist: Hat sich der Fingerabdruck geändert, gehört die alte
 * Bedeutung zu einem anderen Inhalt und darf nicht weiterleben. Dasselbe
 * Prinzip, nach dem direkt darüber schon die Arbeitsbereichsbindung erhalten
 * bleibt.
 */
function preserveSemanticCore(
  previous: DocumentWorkResult,
  nextProjected: DocumentWorkResult,
  fingerprintChanged: boolean,
): DocumentWorkResult['businessInterpretation'] {
  const next = nextProjected.businessInterpretation;
  if (fingerprintChanged) return next;

  const bewahrt = previous.businessInterpretation?.semantic;
  if (!bewahrt) return next;
  /* Die neue Auswertung hat einen eigenen Kern — sie ist die jüngere Wahrheit. */
  if (next?.semantic) return next;
  if (!next) return next;

  return { ...next, semantic: bewahrt };
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
