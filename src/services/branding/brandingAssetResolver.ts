/**
 * BRANDING-01D — Asset beschaffen: erst der Cache, dann die Cloud.
 *
 * Die Reihenfolge ist nicht nur eine Frage der Geschwindigkeit, sondern die
 * Voraussetzung dafür, dass ein einmal geladenes historisches Logo auch ohne
 * Netz noch erscheint.
 *
 * Was hier bewusst **nicht** geschieht: ein Ausweichen auf ein anderes Asset.
 * Fehlt das historische Logo, wird das gemeldet. Ein Dokument von damals mit
 * dem Logo von heute zu zeigen wäre eine stille Fälschung — schlimmer als eine
 * leere Stelle.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { LogoAssetReference } from '../../types/branding';
import {
  downloadBrandingAsset,
  verifyBrandingAssetBlob,
  type BrandingAssetDownloadResult,
} from './brandingAssetCloudService';
import { getCachedBrandingAsset, putCachedBrandingAsset } from './brandingAssetCacheService';
import { buildBrandingAssetPath } from './brandingAssetPath';
import { isLogoMimeType } from './brandingSnapshotService';

export async function resolveBrandingAsset(
  workspaceId: string,
  reference: LogoAssetReference,
  client?: SupabaseClient | null,
): Promise<BrandingAssetDownloadResult> {
  /*
   * Zuerst die Referenz prüfen, dann erst der Cache.
   *
   * Sonst könnte ein lokaler Eintrag gefunden und ausgeliefert werden, obwohl
   * die Referenz den Vertrag gar nicht erfüllt — der Download würde sie
   * ablehnen, der Cache nicht. Beide Wege müssen dieselbe Grenze haben, und
   * zwar über dieselben Funktionen, nicht über eine zweite Kopie der Regeln.
   *
   * Der Typ steht dabei vor dem Pfad, genau wie im Download: Eine zur Laufzeit
   * beschädigte Referenz soll denselben Fehler ergeben, unabhängig davon, ob
   * gerade etwas im Cache liegt.
   */
  if (!isLogoMimeType(reference?.mimeType)) {
    return { ok: false, error: 'invalid_mime' };
  }

  const path = buildBrandingAssetPath(workspaceId, reference.assetId);
  if (!path.ok) {
    return { ok: false, error: path.error };
  }

  const cached = await getCachedBrandingAsset(workspaceId, reference.assetId);
  if (cached) {
    const verified = await verifyBrandingAssetBlob(cached, reference.mimeType);
    if (verified.ok) {
      // Treffer: kein Netzzugriff.
      return verified;
    }
    /*
     * Ungültiger Eintrag — er wird übergangen, nicht gelöscht: In V1 gibt es
     * kein Löschen, und ein erneuter Download überschreibt ihn ohnehin.
     */
  }

  const downloaded = await downloadBrandingAsset(workspaceId, reference, client);
  if (!downloaded.ok) {
    return downloaded;
  }

  // Ein fehlgeschlagenes Zwischenspeichern darf das Ergebnis nicht entwerten.
  await putCachedBrandingAsset(workspaceId, reference.assetId, downloaded.blob);
  return downloaded;
}
