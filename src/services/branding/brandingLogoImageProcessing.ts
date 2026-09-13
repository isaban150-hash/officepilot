import { isLogoMimeType } from './brandingSnapshotService';
import {
  MAX_BRANDING_LOGO_SIZE_BYTES,
  validateBrandingLogoBlob,
  type BrandingLogoValidationError,
} from './brandingLogoValidation';
import type { LogoMimeType } from '../../types/branding';

/**
 * SETTINGS-01B3 — Vorbereitung eines Firmenlogos vor dem dauerhaften Upload.
 *
 * Ablauf: Signatur prüfen (echte Bytes, keine Endung) → dekodieren (defekte
 * Dateien, SVG/HTML-Tarnung, 0×0 fallen hier) → bei Bedarf **proportional**
 * auf höchstens `MAX_LOGO_EDGE_PX` verkleinern → endgültige 2-MB-Grenze
 * durchsetzen. Nie hochskalieren; PNG bleibt PNG (Transparenz), JPEG bleibt
 * JPEG; WebP wird nur dann als WebP neu kodiert, wenn der Browser es kann —
 * sonst verlustfrei als PNG. Die Browser-Orientierung (EXIF) übernimmt der
 * Dekoder (`imageOrientation: 'from-image'`).
 *
 * Keine zweite Bildbibliothek: Browser-APIs genügen. Die eigentliche
 * Bildarbeit ist über `deps` austauschbar, damit die Regeln ohne Canvas
 * geprüft werden können.
 */
export const MAX_LOGO_EDGE_PX = 1600;

/** Auswahlgrenze vor der Verarbeitung — ein Kamerabild darf gross sein. */
export const MAX_LOGO_INPUT_SIZE_BYTES = 20 * 1024 * 1024;

export type BrandingLogoPrepareError =
  | BrandingLogoValidationError
  /** Dekodierung fehlgeschlagen oder leere Abmessungen — kein brauchbares Bild. */
  | 'decode_failed'
  /** Auch nach dem sicheren Verkleinern über der Uploadgrenze. */
  | 'too_large_after_processing';

export interface PreparedBrandingLogo {
  blob: Blob;
  mimeType: LogoMimeType;
  width: number;
  height: number;
  /** Das Bild wurde verkleinert (Original war grösser als die Kante). */
  resized: boolean;
  originalWidth: number;
  originalHeight: number;
}

export type BrandingLogoPrepareResult =
  | { ok: true; logo: PreparedBrandingLogo }
  | { ok: false; error: BrandingLogoPrepareError };

export interface DecodedLogoImage {
  width: number;
  height: number;
  /** Zeichenquelle für den Encoder (Bitmap/Bild); im Test beliebig. */
  source: unknown;
  close?: () => void;
}

export interface BrandingLogoImageDeps {
  decode: (blob: Blob) => Promise<DecodedLogoImage | null>;
  /** Kodiert die Quelle in der Zielgrösse; `null`, wenn der Browser das Format nicht kann. */
  encode: (
    image: DecodedLogoImage,
    target: { width: number; height: number },
    mimeType: LogoMimeType,
  ) => Promise<Blob | null>;
}

/** Zielgrösse: proportional, nie über die Kante, nie hochskaliert. */
export function computeLogoTargetSize(
  width: number,
  height: number,
  maxEdge: number = MAX_LOGO_EDGE_PX,
): { width: number; height: number; resized: boolean } {
  const longest = Math.max(width, height);
  if (longest <= maxEdge) return { width, height, resized: false };
  const factor = maxEdge / longest;
  return {
    width: Math.max(1, Math.round(width * factor)),
    height: Math.max(1, Math.round(height * factor)),
    resized: true,
  };
}

async function browserDecode(blob: Blob): Promise<DecodedLogoImage | null> {
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
      return {
        width: bitmap.width,
        height: bitmap.height,
        source: bitmap,
        close: () => bitmap.close(),
      };
    } catch {
      return null;
    }
  }
  if (typeof Image === 'undefined' || typeof URL === 'undefined') return null;
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve({ width: image.naturalWidth, height: image.naturalHeight, source: image });
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(null);
    };
    image.src = url;
  });
}

async function browserEncode(
  image: DecodedLogoImage,
  target: { width: number; height: number },
  mimeType: LogoMimeType,
): Promise<Blob | null> {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = target.width;
  canvas.height = target.height;
  const context = canvas.getContext('2d');
  if (!context) return null;
  // Transparenz bleibt: nichts wird vorab gefüllt; JPEG hat ohnehin keinen Alphakanal.
  context.drawImage(image.source as CanvasImageSource, 0, 0, target.width, target.height);
  const quality = mimeType === 'image/png' ? undefined : 0.9;
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, mimeType, quality));
  if (!blob || blob.type !== mimeType) return null;
  return blob;
}

export const BROWSER_LOGO_IMAGE_DEPS: BrandingLogoImageDeps = {
  decode: browserDecode,
  encode: browserEncode,
};

let activeDeps: BrandingLogoImageDeps = BROWSER_LOGO_IMAGE_DEPS;

/** Nur für Tests: Dekoder/Encoder ohne Canvas ersetzen (`null` = Browser). */
export function setBrandingLogoImageDepsForTests(deps: BrandingLogoImageDeps | null): void {
  activeDeps = deps ?? BROWSER_LOGO_IMAGE_DEPS;
}

export async function prepareBrandingLogo(
  file: Blob | null | undefined,
  deps: BrandingLogoImageDeps = activeDeps,
): Promise<BrandingLogoPrepareResult> {
  if (!file || file.size === 0) return { ok: false, error: 'invalid_file' };
  if (file.size > MAX_LOGO_INPUT_SIZE_BYTES) return { ok: false, error: 'file_too_large' };
  if (!isLogoMimeType(file.type)) return { ok: false, error: 'unsupported_mime' };

  // Signaturprüfung auf den echten Bytes — unabhängig von der Uploadgrenze.
  const signature = await validateBrandingLogoBlob(file, { maxSizeBytes: MAX_LOGO_INPUT_SIZE_BYTES });
  if (!signature.valid) return { ok: false, error: signature.error };
  const mimeType = file.type;

  const decoded = await deps.decode(file);
  if (!decoded || !(decoded.width > 0) || !(decoded.height > 0)) {
    decoded?.close?.();
    return { ok: false, error: 'decode_failed' };
  }

  try {
    const target = computeLogoTargetSize(decoded.width, decoded.height);
    if (!target.resized) {
      if (file.size > MAX_BRANDING_LOGO_SIZE_BYTES) {
        return { ok: false, error: 'too_large_after_processing' };
      }
      return {
        ok: true,
        logo: {
          blob: file,
          mimeType,
          width: decoded.width,
          height: decoded.height,
          resized: false,
          originalWidth: decoded.width,
          originalHeight: decoded.height,
        },
      };
    }

    let outputMime: LogoMimeType = mimeType;
    let encoded = await deps.encode(decoded, target, outputMime);
    if (!encoded && mimeType === 'image/webp') {
      // Kein WebP-Encoder im Browser: verlustfrei als PNG, Transparenz bleibt.
      outputMime = 'image/png';
      encoded = await deps.encode(decoded, target, outputMime);
    }
    if (!encoded) return { ok: false, error: 'decode_failed' };
    if (encoded.size > MAX_BRANDING_LOGO_SIZE_BYTES) {
      return { ok: false, error: 'too_large_after_processing' };
    }
    return {
      ok: true,
      logo: {
        blob: encoded,
        mimeType: outputMime,
        width: target.width,
        height: target.height,
        resized: true,
        originalWidth: decoded.width,
        originalHeight: decoded.height,
      },
    };
  } finally {
    decoded.close?.();
  }
}
