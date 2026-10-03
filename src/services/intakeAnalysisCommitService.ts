/**
 * EINGANG-01D-1 — die Einschätzung eines Eingangs wird beim Übernehmen
 * festgeschrieben, nicht erst beim ersten Öffnen der Detailseite.
 *
 * Drei Bausteine, alle serviceseitig (keine UI-Lebensdauer):
 *   - `commitIntakeDocumentAnalysis` — dieselbe deterministische Analyse wie
 *     beim Öffnen, gespeichert nur, wenn noch keine vorliegt (`onlyIfMissing`).
 *   - `scheduleIntakeDocumentAnalysisCommit` — für große/mehrseitige
 *     Dokumente nach dem Zeichnen, damit Speichern reaktionsschnell bleibt;
 *     mit unabhängigem Zeitgeber, falls `requestAnimationFrame` nicht läuft
 *     (verdeckter Tab). Läuft genau einmal.
 *   - `scheduleIntakeAnalysisRecovery` — nach dem Laden eines Bestands: Ging
 *     ein geplanter Commit verloren (Reload, Tab geschlossen), wird er aus dem
 *     lokal gespeicherten Volltext nachgeholt. Ohne lokalen Volltext nichts —
 *     keine neue OCR, keine Datei, keine KI, nichts Geratenes.
 */
import { analyzeUploadedDocument, commitUploadedDocumentAnalysis } from './intakeWorkflowService';
import { getDocumentWorkResult } from './documentWorkResultStoreService';
import { getInboxItemById, getInboxStoreSnapshot } from './inboxService';
import { scheduleAfterPaint } from './scheduleAfterPaint';
import type { InboxItem } from '../types/models';

/** Spätester Start des verzögerten Commits, auch ohne Zeichnen. */
export const INTAKE_ANALYSIS_FALLBACK_MS = 1_000;
/** Recovery startet erst nach dem App-Start und arbeitet in kleinen Schritten. */
export const INTAKE_ANALYSIS_RECOVERY_DELAY_MS = 2_000;
const INTAKE_ANALYSIS_RECOVERY_STEP_MS = 50;
const INTAKE_ANALYSIS_RECOVERY_MAX_PER_RUN = 20;

export function commitIntakeDocumentAnalysis(inboxItemId: string): void {
  try {
    if (getDocumentWorkResult(inboxItemId)) return;
    const analysis = analyzeUploadedDocument(inboxItemId);
    if (analysis) commitUploadedDocumentAnalysis(analysis, 'onlyIfMissing');
  } catch (error) {
    console.warn('[documentWorkResult] commit at intake failed', error);
  }
}

export function scheduleIntakeDocumentAnalysisCommit(inboxItemId: string): void {
  let done = false;
  let cancelPaint: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const run = () => {
    if (done) return;
    done = true;
    if (timer !== undefined) clearTimeout(timer);
    cancelPaint?.();
    commitIntakeDocumentAnalysis(inboxItemId);
  };
  timer = setTimeout(run, INTAKE_ANALYSIS_FALLBACK_MS);
  cancelPaint = scheduleAfterPaint(run);
}

function hasLocalSourceText(item: InboxItem): boolean {
  const text = item.recognizedData?._extractedText;
  return typeof text === 'string' && text.trim().length > 0;
}

/** Eingänge, deren Einschätzung fehlt, obwohl der Volltext hier vorliegt. */
export function findInboxItemsMissingIntakeAnalysis(): string[] {
  return getInboxStoreSnapshot()
    .filter((item) => !item.sync?.deleted && hasLocalSourceText(item) && !getDocumentWorkResult(item.id))
    .map((item) => item.id);
}

/** Holt fehlende Einschätzungen sofort nach (für Recovery-Schritte und Tests). */
export function recoverMissingIntakeAnalysesNow(limit = INTAKE_ANALYSIS_RECOVERY_MAX_PER_RUN): number {
  let recovered = 0;
  for (const id of findInboxItemsMissingIntakeAnalysis().slice(0, limit)) {
    commitIntakeDocumentAnalysis(id);
    if (getDocumentWorkResult(id)) recovered += 1;
  }
  return recovered;
}

let cancelActiveRecovery: (() => void) | null = null;

/** Bestandswechsel/Abmelden: eine geplante Recovery des alten Bestands verwerfen. */
export function cancelIntakeAnalysisRecovery(): void {
  cancelActiveRecovery?.();
}

/**
 * Nach dem Laden eines Bestands: verzögert, ein Eingang je Schritt, damit der
 * App-Start nie blockiert. Ein neuer Aufruf (anderer Bereich) ersetzt den alten.
 */
export function scheduleIntakeAnalysisRecovery(): () => void {
  cancelActiveRecovery?.();
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let queue: string[] | null = null;

  const step = () => {
    if (cancelled) return;
    // Einmal beim ersten Schritt festgelegt; ein Fehlschlag hält die übrigen nicht auf.
    queue ??= findInboxItemsMissingIntakeAnalysis().slice(0, INTAKE_ANALYSIS_RECOVERY_MAX_PER_RUN);
    const nextId = queue.shift();
    if (!nextId) return;
    if (getInboxItemById(nextId)) commitIntakeDocumentAnalysis(nextId);
    timer = setTimeout(step, INTAKE_ANALYSIS_RECOVERY_STEP_MS);
  };

  timer = setTimeout(step, INTAKE_ANALYSIS_RECOVERY_DELAY_MS);
  const cancel = () => {
    cancelled = true;
    if (timer !== undefined) clearTimeout(timer);
    if (cancelActiveRecovery === cancel) cancelActiveRecovery = null;
  };
  cancelActiveRecovery = cancel;
  return cancel;
}
