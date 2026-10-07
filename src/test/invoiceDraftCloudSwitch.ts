/**
 * CLOUD-SYNC S5 — der Notausschalter des Rechnungsentwurfs-Syncs für Tests.
 *
 * Seit Phase 2 ist `invoice_draft` freigegeben: Eine Rechnungsfreigabe beginnt
 * nur mit einem vollständig in der Cloud angekommenen Entwurf (Entwurfsbindung
 * `clientDraftId` + erwartete Version). Tests, die Freigabe-, Seiten- oder
 * Wiederaufnahmemechanik **ohne** Cloud-Entwurf prüfen, erklären mit diesem
 * Schalter ausdrücklich ihre Umgebung: Entwurfs-Sync aus — die Freigabe läuft
 * dann wie vor S5 ohne Bindung, die der Server unverändert annimmt. Alle
 * übrigen Typen bleiben wie freigegeben.
 *
 * Den gebundenen Weg prüfen `invoiceDraftCloudFinalizeS5.test.ts`,
 * `invoiceDraftCloudSyncS5.test.ts` und `invoiceDraftDiscardS5.test.tsx`.
 *
 * Nach `vi.restoreAllMocks()` erneut aufrufen.
 */
import { vi } from 'vitest';
import * as allowlist from '../services/sync/cloudSyncAllowlist';

export function disableInvoiceDraftCloudSyncForTests(): void {
  vi.spyOn(allowlist, 'isSupabaseSyncAllowed').mockImplementation(
    (type) => type !== 'invoice_draft' && allowlist.SUPABASE_SYNC_ALLOWLIST.has(type),
  );
}
