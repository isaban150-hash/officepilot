/**
 * EINRICHTUNG-01 (AP4; M-10.3, M-13.5) — Rückkehr aus dem Seiten-Cache nach einem Betriebswechsel oder Entzug.
 *
 * Ergänzt den Kontoschutz aus DOKUMENTE-01 (`pageCacheAccountGuard`), ohne ihn zu ändern: Stellt der Browser eine
 * frühere Seite samt Arbeitsspeicher wieder her, während inzwischen ein anderer Betrieb gebunden ist (Wechsel in
 * diesem oder einem anderen Tab) oder der Zugang zum Betrieb der Seite bestätigt entzogen wurde, wird neu geladen statt
 * den alten Bestand zu zeigen. Ein anderer Tab erfährt einen Wechsel zusätzlich über das Speicherereignis der gemerkten
 * Bindung und lädt ebenfalls neu.
 */
import { readRememberedWorkspaceBinding } from './workspaceCloudBootstrapService';
import { isWorkspaceRevoked } from './workspaceMembershipChangeService';

export const pageCacheWorkspaceDeps = {
  reload(): void {
    window.location.reload();
  },
};

const BINDING_KEY_PREFIX = 'officetakt-workspace-binding:';

/** Hat sich die Bindung dieses Kontos geändert oder ist der Betrieb der Seite entzogen? */
export function workspaceBindingOutdated(userId: string | null | undefined, boundWorkspaceId: string | null): boolean {
  if (!userId || !boundWorkspaceId) return false;
  if (isWorkspaceRevoked(userId, boundWorkspaceId)) return true;
  const remembered = readRememberedWorkspaceBinding(userId);
  return Boolean(remembered && remembered.workspaceId !== boundWorkspaceId);
}

export function watchPageCacheWorkspace(
  getBoundUserId: () => string | null | undefined,
  getBoundWorkspaceId: () => string | null,
): () => void {
  if (typeof window === 'undefined') return () => undefined;
  const check = () => {
    if (workspaceBindingOutdated(getBoundUserId(), getBoundWorkspaceId())) pageCacheWorkspaceDeps.reload();
  };
  const onPageShow = (event: Event) => {
    if ((event as PageTransitionEvent).persisted) check();
  };
  // M-13.5 — ein anderer Tab hat gewechselt: Die gemerkte Bindung dieses Kontos zeigt auf einen anderen Betrieb.
  const onStorage = (event: StorageEvent) => {
    const userId = getBoundUserId();
    if (!userId || event.key !== `${BINDING_KEY_PREFIX}${userId}`) return;
    check();
  };
  window.addEventListener('pageshow', onPageShow);
  window.addEventListener('storage', onStorage);
  return () => {
    window.removeEventListener('pageshow', onPageShow);
    window.removeEventListener('storage', onStorage);
  };
}
