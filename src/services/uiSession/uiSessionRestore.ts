import type { UiSessionRestoreIntent, UiSessionSnapshot } from '../../types/uiSessionSnapshot';
import {
  clearUiSessionSnapshot,
  loadUiSessionSnapshot,
  loadUiSessionSnapshotForRoute,
  removeUiSessionSnapshot,
} from './uiSessionStore';
import { validateUiSessionSnapshot } from './uiSessionValidation';
import {
  markContinueWorkingDismissed,
  setPendingUiSessionApply,
  wasContinueWorkingDismissed,
} from './uiSessionLiveState';
import { applyMainScrollTop } from './uiSessionCapture';
import { patchUiSessionLiveChrome } from './uiSessionLiveState';

export type UiSessionBootstrapDecision = {
  intent: UiSessionRestoreIntent;
  snapshot: UiSessionSnapshot | null;
  reason?: string;
};

/**
 * MOBILE-SAFE-RESUME-01B — sicherer Lesezugriff auf **einen** Entwurfszeiger.
 *
 * Bewusst schmal: die Funktion gibt ausschließlich eine undurchsichtige
 * Entwurfskennung zurück, niemals Inhalte, niemals Oberflächenzustände und
 * niemals eine Bestätigung. Sie prüft vorher denselben Vertrag wie die
 * reguläre Wiederaufnahme — Schema, Storage-Scope, Benutzer, Workspace, TTL,
 * erlaubte Route und Existenz der Entität. Bei Verstoß gibt sie `null` zurück
 * und rührt den Schnappschuss nicht an.
 */
export function readSafeUiSessionDraftPointer(input: {
  draftKey: string;
  userId: string | null;
  currentPathname: string;
  currentSearch: string;
  nowMs?: number;
}): string | null {
  const snapshot = loadUiSessionSnapshot();
  if (!snapshot) return null;

  const result = validateUiSessionSnapshot(snapshot, {
    userId: input.userId,
    currentPathname: input.currentPathname,
    currentSearch: input.currentSearch,
    nowMs: input.nowMs,
  });
  if (!result.ok) return null;

  const raw = snapshot.drafts.values[input.draftKey];
  return typeof raw === 'string' && raw.trim() ? raw : null;
}

export function decideUiSessionRestore(input: {
  userId: string | null;
  currentPathname: string;
  currentSearch: string;
  nowMs?: number;
}): UiSessionBootstrapDecision {
  /*
   * GLOBAL-WORKSPACE-CONTINUITY-01B — zuerst der Arbeitsstand **dieses**
   * Arbeitsplatzes, erst danach der zuletzt benutzte.
   *
   * Vorher gab es nur einen Platz; wer von Vorgang A nach B ging, verlor A. Die
   * Reihenfolge hier ist der Grund, warum die Rückkehr jetzt trägt: Der Eintrag
   * zur aktuellen Route führt zur stillen Wiederaufnahme, der zuletzt benutzte
   * bleibt die Grundlage für „Weiterarbeiten" auf einer fremden Seite.
   */
  const snapshot =
    loadUiSessionSnapshotForRoute(input.currentPathname, input.currentSearch) ??
    loadUiSessionSnapshot();
  const result = validateUiSessionSnapshot(snapshot, {
    userId: input.userId,
    currentPathname: input.currentPathname,
    currentSearch: input.currentSearch,
    nowMs: input.nowMs,
  });

  if (!result.ok || !snapshot) {
    /*
     * Verworfen wird nur der geprüfte Eintrag, nicht die ganze Liste — ein
     * abgelaufener Vorgang darf den Arbeitsstand einer anderen Seite nicht
     * mitnehmen.
     */
    if (snapshot && result.reason && result.reason !== 'missing' && result.reason !== 'trivial') {
      removeUiSessionSnapshot(snapshot);
    }
    return { intent: 'ignore', snapshot: null, reason: result.reason };
  }

  if (result.intent === 'offer' && wasContinueWorkingDismissed()) {
    return { intent: 'ignore', snapshot, reason: 'dismissed' };
  }

  return { intent: result.intent, snapshot };
}

/** Apply chrome from snapshot into live state + scroll (after navigation if needed). */
export function applyUiSessionChrome(snapshot: UiSessionSnapshot): void {
  patchUiSessionLiveChrome({
    activeTab: snapshot.activeTab,
    activeSection: snapshot.activeSection,
    workspaceType: snapshot.workspaceType,
    panelState: snapshot.panelState,
    selection: snapshot.selection,
    expandedSections: snapshot.expandedSections,
    list: snapshot.list,
    drafts: snapshot.drafts,
    resumeLabel: snapshot.resumeLabel,
  });
  setPendingUiSessionApply(snapshot);
  applyMainScrollTop(snapshot.scroll.mainTop);
}

export function discardUiSessionRestore(): void {
  clearUiSessionSnapshot();
  setPendingUiSessionApply(null);
  markContinueWorkingDismissed(true);
}

export function acceptContinueWorking(snapshot: UiSessionSnapshot): void {
  markContinueWorkingDismissed(false);
  setPendingUiSessionApply(snapshot);
  applyUiSessionChrome(snapshot);
}

export function formatUiSessionRelativeTime(
  savedAt: string,
  nowMs: number = Date.now(),
): string {
  const saved = Date.parse(savedAt);
  if (!Number.isFinite(saved)) return '';
  const deltaMin = Math.max(0, Math.round((nowMs - saved) / 60000));
  if (deltaMin < 1) return 'Gerade eben';
  if (deltaMin === 1) return 'Vor 1 Minute';
  if (deltaMin < 60) return `Vor ${deltaMin} Minuten`;
  const hours = Math.round(deltaMin / 60);
  if (hours === 1) return 'Vor 1 Stunde';
  if (hours < 48) return `Vor ${hours} Stunden`;
  const days = Math.round(hours / 24);
  return days === 1 ? 'Vor 1 Tag' : `Vor ${days} Tagen`;
}
