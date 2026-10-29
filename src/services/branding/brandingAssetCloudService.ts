/**
 * BRANDING-01D — Branding-Assets in Supabase Storage.
 *
 * Zwei Eigenschaften tragen den Entwurf:
 *
 *  - **Unveränderlich.** Ein Logo wird nie überschrieben. Ein neues Logo ist
 *    ein neues Asset mit neuer Kennung; das alte bleibt, damit ein historisches
 *    Dokument seine Referenz behält. Seit EINRICHTUNG-01 (AP6) ist die Kennung
 *    die SHA-256-Prüfsumme der Bytes: gleicher Inhalt, gleiches Objekt. Der Client sendet `upsert: false`, und der
 *    Bucket hat keine UPDATE-Policy — selbst ein versehentliches `upsert: true`
 *    könnte serverseitig nichts ersetzen.
 *  - **Streng geprüft, bevor geschrieben wird.** Was einmal im Bucket liegt,
 *    lässt sich in V1 nicht mehr löschen. Fehlerhafte Bytes dürfen deshalb gar
 *    nicht erst hochgeladen werden — auch dann nicht, wenn ein künftiger
 *    Aufrufer nicht durch die Firmendaten-Oberfläche gelaufen ist.
 *
 * Der Dienst verändert keine Geschäftsdaten: kein Firmenprofil, kein
 * Branding-Profil, kein Snapshot, keine Outbox, keine Oberfläche.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseClient } from '../../lib/supabase';
import type { LogoAssetReference, LogoMimeType } from '../../types/branding';
import { isLogoMimeType } from './brandingSnapshotService';
import {
  MAX_BRANDING_LOGO_SIZE_BYTES,
  validateBrandingLogoBlob,
} from './brandingLogoValidation';
import { buildBrandingAssetPath, isValidBrandingWorkspaceId } from './brandingAssetPath';
import { digestSha256 } from '../sha256Digest';

export const BRANDING_ASSET_BUCKET = 'branding-assets';

export type BrandingAssetError =
  | 'not_configured'
  | 'invalid_workspace'
  | 'invalid_asset'
  | 'invalid_mime'
  | 'file_too_large'
  | 'signature_mismatch'
  | 'mime_mismatch'
  | 'forbidden'
  | 'conflict'
  | 'not_found'
  | 'network'
  | 'unknown';

export type BrandingAssetUploadResult =
  /** `reused`: dasselbe Objekt lag schon im Pfad des Betriebs (gleicher Inhalt, z. B. Wiederholung nach F-07.3). */
  | { ok: true; reference: LogoAssetReference; reused: boolean }
  | { ok: false; error: BrandingAssetError };

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer)).map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** EINRICHTUNG-01 (AP6; F-07) — Kennung eines Branding-Assets: SHA-256 der Bytes (64 Hexzeichen). */
export async function brandingAssetIdForBlob(blob: Blob): Promise<string> {
  return toHex(await digestSha256(new Uint8Array(await blob.arrayBuffer())));
}

export type BrandingAssetDownloadResult =
  | { ok: true; blob: Blob }
  | { ok: false; error: BrandingAssetError };

/**
 * Storage-Fehler werden nur dort unterschieden, wo es zuverlässig geht.
 *
 * Bewusst keine breite Mustererkennung auf Fehlertexten: Die sind nicht
 * vertraglich zugesichert und ändern sich mit der Bibliothek. Was nicht sicher
 * zuzuordnen ist, bleibt `unknown` — das ist ehrlicher als eine hübsche, aber
 * brüchige Zuordnung.
 */
function mapStorageError(error: { message?: string; statusCode?: string | number }): BrandingAssetError {
  const status = Number(error.statusCode ?? NaN);
  if (status === 409) return 'conflict';
  if (status === 403 || status === 401) return 'forbidden';
  if (status === 404) return 'not_found';

  const message = (error.message ?? '').toLowerCase();
  if (message.includes('already exists') || message.includes('duplicate')) return 'conflict';
  if (message.includes('failed to fetch') || message.includes('network')) return 'network';
  return 'unknown';
}

function resolveClient(client?: SupabaseClient | null): SupabaseClient | null {
  return client ?? getSupabaseClient();
}

/**
 * Lädt ein neues Asset hoch. Die Kennung entsteht **hier** — sie ist von aussen
 * nicht wählbar, damit niemand einen vorhandenen Pfad ansteuern kann.
 *
 * EINRICHTUNG-01 (AP6; Vertrag 1.20, F-07, K7) — die Kennung ist die Prüfsumme der Bytes (inhaltsadressiert, statt
 * einer Zufallskennung): Ein erneutes Hochladen derselben Bytes trifft dasselbe Objekt. Liegt es schon im Pfad des
 * Betriebs (Storage meldet einen Konflikt), wird sein Inhalt geprüft und die Referenz wiederverwendet — höchstens ein
 * Objekt je Inhalt und Betrieb, keine unkontrollierten Duplikate. Weicht der vorhandene Inhalt ab, wird abgewiesen.
 */
export async function uploadBrandingAsset(
  input: { workspaceId: string; blob: Blob; mimeType: LogoMimeType },
  client?: SupabaseClient | null,
): Promise<BrandingAssetUploadResult> {
  const { workspaceId, blob, mimeType } = input;

  if (!isLogoMimeType(mimeType)) {
    return { ok: false, error: 'invalid_mime' };
  }
  // Der angegebene Typ muss zum Blob passen — sonst stünde im Bucket dauerhaft
  // ein Content-Type, der den Inhalt falsch beschreibt.
  if (blob?.type !== mimeType) {
    return { ok: false, error: 'mime_mismatch' };
  }

  const validation = await validateBrandingLogoBlob(blob);
  if (!validation.valid) {
    return {
      ok: false,
      error:
        validation.error === 'file_too_large'
          ? 'file_too_large'
          : validation.error === 'unsupported_mime'
            ? 'invalid_mime'
            : validation.error === 'signature_mismatch'
              ? 'signature_mismatch'
              : 'invalid_asset',
    };
  }

  /*
   * Der Workspace wird geprüft, **bevor** eine Kennung entsteht: Für einen
   * ungültigen Workspace wird weder eine Prüfsumme berechnet noch Storage berührt.
   */
  if (!isValidBrandingWorkspaceId(workspaceId)) {
    return { ok: false, error: 'invalid_workspace' };
  }

  const assetId = await brandingAssetIdForBlob(blob);

  const path = buildBrandingAssetPath(workspaceId, assetId);
  if (!path.ok) {
    return { ok: false, error: path.error };
  }

  const supabase = resolveClient(client);
  if (!supabase) {
    return { ok: false, error: 'not_configured' };
  }

  try {
    const { error } = await supabase.storage
      .from(BRANDING_ASSET_BUCKET)
      .upload(path.path, blob, { contentType: mimeType, upsert: false });
    if (error) {
      const mapped = mapStorageError(error);
      if (mapped !== 'conflict') return { ok: false, error: mapped };
      // Dasselbe Objekt (gleiche Prüfsumme) liegt schon im Pfad dieses Betriebs: Inhalt prüfen, dann wiederverwenden.
      const existing = await downloadBrandingAsset(workspaceId, { assetId, mimeType }, supabase);
      if (!existing.ok) return { ok: false, error: 'conflict' };
      if ((await brandingAssetIdForBlob(existing.blob)) !== assetId) return { ok: false, error: 'conflict' };
      return { ok: true, reference: { assetId, mimeType }, reused: true };
    }
  } catch (error) {
    return { ok: false, error: mapStorageError((error ?? {}) as { message?: string }) };
  }

  return { ok: true, reference: { assetId, mimeType }, reused: false };
}

/**
 * Holt ein Asset. Geprüft wird, was ankommt — nicht, was erwartet wurde:
 * Content-Type, Signatur und Grösse müssen zur Referenz passen.
 *
 * Schlägt etwas fehl, kommt **kein** Asset zurück. Insbesondere kein anderes
 * und nicht das aktuelle Logo: Ein historisches Dokument mit dem heutigen Logo
 * zu zeigen wäre schlimmer, als gar keines zu zeigen.
 */
export async function downloadBrandingAsset(
  workspaceId: string,
  reference: LogoAssetReference,
  client?: SupabaseClient | null,
): Promise<BrandingAssetDownloadResult> {
  if (!isLogoMimeType(reference?.mimeType)) {
    return { ok: false, error: 'invalid_mime' };
  }

  const path = buildBrandingAssetPath(workspaceId, reference.assetId);
  if (!path.ok) {
    return { ok: false, error: path.error };
  }

  const supabase = resolveClient(client);
  if (!supabase) {
    return { ok: false, error: 'not_configured' };
  }

  let blob: Blob | null;
  try {
    const { data, error } = await supabase.storage
      .from(BRANDING_ASSET_BUCKET)
      .download(path.path);
    if (error) {
      return { ok: false, error: mapStorageError(error) };
    }
    blob = data ?? null;
  } catch (error) {
    return { ok: false, error: mapStorageError((error ?? {}) as { message?: string }) };
  }

  return verifyBrandingAssetBlob(blob, reference.mimeType);
}

/**
 * Gemeinsame Eingangsprüfung für alles, was aus Cloud oder Cache kommt.
 * Grösse, Typ und Signatur laufen über denselben Validator wie der Upload —
 * eine Signaturtabelle, eine Grenze, eine MIME-Liste.
 */
export async function verifyBrandingAssetBlob(
  blob: Blob | null | undefined,
  expectedMimeType: LogoMimeType,
): Promise<BrandingAssetDownloadResult> {
  if (!blob) {
    return { ok: false, error: 'not_found' };
  }
  if (blob.type !== expectedMimeType) {
    return { ok: false, error: 'mime_mismatch' };
  }
  if (blob.size > MAX_BRANDING_LOGO_SIZE_BYTES) {
    return { ok: false, error: 'file_too_large' };
  }

  const validation = await validateBrandingLogoBlob(blob);
  if (!validation.valid) {
    return {
      ok: false,
      error: validation.error === 'signature_mismatch' ? 'signature_mismatch' : 'invalid_asset',
    };
  }

  return { ok: true, blob };
}
