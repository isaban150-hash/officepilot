import {
  createEmptyUiSessionLiveChrome,
  type UiSessionLiveChrome,
  type UiSessionSnapshot,
} from '../../types/uiSessionSnapshot';
import { buildUiSessionRouteKey } from './uiSessionRoute';

let liveChrome: UiSessionLiveChrome = createEmptyUiSessionLiveChrome();
let pendingApply: UiSessionSnapshot | null = null;
let restoreConsumedKey: string | null = null;
let continueWorkingDismissed = false;

const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

export function subscribeUiSessionLive(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getUiSessionLiveChrome(): UiSessionLiveChrome {
  return liveChrome;
}

export function patchUiSessionLiveChrome(patch: Partial<UiSessionLiveChrome>): void {
  liveChrome = {
    ...liveChrome,
    ...patch,
    panelState: patch.panelState
      ? { ...liveChrome.panelState, ...patch.panelState }
      : liveChrome.panelState,
    selection: patch.selection
      ? { ...liveChrome.selection, ...patch.selection }
      : liveChrome.selection,
    list: patch.list ? { ...liveChrome.list, ...patch.list } : liveChrome.list,
    drafts: patch.drafts ? { ...liveChrome.drafts, ...patch.drafts } : liveChrome.drafts,
    expandedSections: patch.expandedSections ?? liveChrome.expandedSections,
  };
  notify();
}

export function resetUiSessionLiveChrome(): void {
  liveChrome = createEmptyUiSessionLiveChrome();
  notify();
}

export function setPendingUiSessionApply(snapshot: UiSessionSnapshot | null): void {
  pendingApply = snapshot;
}

export function getPendingUiSessionApply(): UiSessionSnapshot | null {
  return pendingApply;
}

/**
 * GLOBAL-WORKSPACE-CONTINUITY-01B — verglichen wird der **Arbeitsplatz**, nicht
 * die vollständige Adresse.
 *
 * Sonst verfehlte ein Schnappschuss von `/vorgaenge/A?vtab=order` die aktuelle
 * Adresse `/vorgaenge/A` — obwohl es derselbe Arbeitsplatz ist und der Tab
 * gerade aus dem Schnappschuss kommen soll.
 */
export function takePendingUiSessionApply(routeKey: string): UiSessionSnapshot | null {
  if (!pendingApply) return null;
  const snapKey = buildUiSessionRouteKey(
    pendingApply.route.pathname,
    pendingApply.route.search,
  );
  if (snapKey !== routeKey) return null;
  if (restoreConsumedKey === `${pendingApply.id}:${routeKey}`) return null;
  const snap = pendingApply;
  restoreConsumedKey = `${snap.id}:${routeKey}`;
  pendingApply = null;
  return snap;
}

export function markContinueWorkingDismissed(dismissed: boolean): void {
  continueWorkingDismissed = dismissed;
}

export function wasContinueWorkingDismissed(): boolean {
  return continueWorkingDismissed;
}

export function resetUiSessionLiveState(): void {
  liveChrome = createEmptyUiSessionLiveChrome();
  pendingApply = null;
  restoreConsumedKey = null;
  continueWorkingDismissed = false;
}

/** @deprecated Use resetUiSessionLiveState */
export function resetUiSessionLiveStateForTests(): void {
  resetUiSessionLiveState();
}
