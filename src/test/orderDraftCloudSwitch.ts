/**
 * CLOUD-SYNC S6 — der Schalter des Entwurfs-Syncs für Tests (Auftrags- und
 * Nachtragsentwurf).
 *
 * Seit Phase 2 sind `order_draft` und `order_amendment_draft` freigegeben:
 * Auftragsanlage und Nachtragsbestätigung beginnen nur mit einem vollständig in
 * der Cloud angekommenen Entwurf (Entwurfsbindung). Tests, die Anlage-,
 * Bestätigungs- oder Seitenmechanik **ohne** Cloud-Entwurf prüfen, erklären mit
 * `disableOrderDraftCloudSyncForTests()` ausdrücklich ihre Umgebung: Entwurfs-Sync
 * aus (Notausschalter) — beide laufen dann wie vor S6 ohne Bindung, die der
 * Server unverändert annimmt. `enableOrderDraftCloudSyncForTests()` hält den
 * freigegebenen Weg auch dann fest, wenn die Freigabeliste ihn einmal wieder
 * abschaltet. Alle übrigen Typen bleiben, wie die Freigabeliste sie führt.
 *
 * Nach `vi.restoreAllMocks()` erneut aufrufen.
 */
import { vi } from 'vitest';
import * as allowlist from '../services/sync/cloudSyncAllowlist';

const S6_TYPES = new Set(['order_draft', 'order_amendment_draft']);

export function enableOrderDraftCloudSyncForTests(): void {
  vi.spyOn(allowlist, 'isSupabaseSyncAllowed').mockImplementation(
    (type) => S6_TYPES.has(type) || allowlist.SUPABASE_SYNC_ALLOWLIST.has(type),
  );
}

export function disableOrderDraftCloudSyncForTests(): void {
  vi.spyOn(allowlist, 'isSupabaseSyncAllowed').mockImplementation(
    (type) => !S6_TYPES.has(type) && allowlist.SUPABASE_SYNC_ALLOWLIST.has(type),
  );
}
