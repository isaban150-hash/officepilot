import type { UiSessionRestoreIntent, UiSessionSnapshot } from '../../types/uiSessionSnapshot';
import { clearUiSessionSnapshot, loadUiSessionSnapshot } from './uiSessionStore';
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

export function decideUiSessionRestore(input: {
  userId: string | null;
  currentPathname: string;
  currentSearch: string;
  nowMs?: number;
}): UiSessionBootstrapDecision {
  const snapshot = loadUiSessionSnapshot();
  const result = validateUiSessionSnapshot(snapshot, {
    userId: input.userId,
    currentPathname: input.currentPathname,
    currentSearch: input.currentSearch,
    nowMs: input.nowMs,
  });

  if (!result.ok || !snapshot) {
    if (result.reason && result.reason !== 'missing' && result.reason !== 'trivial') {
      clearUiSessionSnapshot();
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
