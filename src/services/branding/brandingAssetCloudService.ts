/**
 * BRANDING-01D — Branding-Assets in Supabase Storage.
 *
 * Zwei Eigenschaften tragen den Entwurf:
 *
 *  - **Unveränderlich.** Ein Logo wird nie überschrieben. Ein neues Logo ist
 *    ein neues Asset mit neuer Kennung; das alte bleibt, damit ein historisches
 *    Dokument seine Referenz behält. Der Client sendet `upsert: false`, und der
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
import {
  buildBrandingAssetPath,
  generateBrandingAssetId,
  isValidBrandingWorkspaceId,
  SecureRandomUnavailableError,
} from './brandingAssetPath';

export const BRANDING_ASSET_BUCKET = 'branding-assets';

export type BrandingAssetError =
  | 'not_configured'
  | 'invalid_workspace'
  | 'invalid_asset'
  | 'invalid_mime'
  | 'file_too_large'
  | 'signature_mismatch'
  | 'mime_mismatch'
  /** Weder `crypto.randomUUID` noch `crypto.getRandomValues` verfügbar. */
  | 'secure_random_unavailable'
  | 'forbidden'
  | 'conflict'
  | 'not_found'
  | 'network'
  | 'unknown';

export type BrandingAssetUploadResult =
  | { ok: true; reference: LogoAssetReference }
  | { ok: false; error: BrandingAssetError };

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
   * ungültigen Workspace soll gar keine Zufallskennung erzeugt werden.
   */
  if (!isValidBrandingWorkspaceId(workspaceId)) {
    return { ok: false, error: 'invalid_workspace' };
  }

  /*
   * `generateBrandingAssetId` wirft absichtlich, wenn keine sichere
   * Zufallsquelle da ist. Das ist ein erwartbarer Infrastrukturfall — er
   * gehört in den Ergebnisvertrag und nicht als abgelehntes Promise nach
   * aussen. Andere Ausnahmen werden bewusst **nicht** verschluckt.
   */
  let assetId: string;
  try {
    assetId = generateBrandingAssetId();
  } catch (error) {
    if (error instanceof SecureRandomUnavailableError) {
      return { ok: false, error: 'secure_random_unavailable' };
    }
    throw error;
  }

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
      return { ok: false, error: mapStorageError(error) };
    }
  } catch (error) {
    return { ok: false, error: mapStorageError((error ?? {}) as { message?: string }) };
  }

  return { ok: true, reference: { assetId, mimeType } };
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
