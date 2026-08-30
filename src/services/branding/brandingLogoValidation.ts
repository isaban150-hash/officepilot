/**
 * BRANDING-01C — Prüfung einer hochgeladenen Logo-Datei.
 *
 * Der Übergangspfad `CompanyProfile.logoDataUrl` bleibt bestehen; dieser
 * Baustein sorgt nur dafür, dass dort nichts Unerwartetes landet.
 *
 * Zwei Dinge werden geprüft, und beide sind nötig:
 *
 *  - Die **Grösse**, bevor irgendetwas gelesen wird. Das Logo liegt als Base64
 *    im lokalen Speicher, und Base64 wächst um rund ein Drittel. Ein
 *    Smartphonefoto würde die Quote sprengen.
 *  - Die **tatsächlichen Anfangsbytes**. `file.type` stammt aus der
 *    Dateiendung und ist trivial zu fälschen: Eine als `logo.png` benannte
 *    SVG-Datei meldet `image/png`. Ohne Signaturprüfung wäre die enge
 *    Typliste wirkungslos.
 *
 * Bewusst **keine** Bildverarbeitung: kein Resize, keine Kompression, kein
 * Re-Encoding. Der einzige vorhandene Encoder im Repo schreibt JPEG und würde
 * die Transparenz eines PNG-Logos zerstören. Die Datei wird geprüft, nicht
 * verändert.
 *
 * Kein Store, kein Netz, kein Storage, keine Persistenz, keine UI-Texte — der
 * Aufrufer übersetzt die Fehlercodes.
 */
import { isLogoMimeType } from './brandingSnapshotService';
import type { LogoMimeType } from '../../types/branding';

/** 2 MiB. Ein Briefkopf-Logo liegt typisch bei 20–100 KB; das ist reichlich. */
export const MAX_BRANDING_LOGO_SIZE_BYTES = 2 * 1024 * 1024;

/** So viele Bytes braucht die längste Signaturprüfung (WebP: `RIFF` + `WEBP`). */
const SIGNATURE_BYTE_LENGTH = 12;

export type BrandingLogoValidationError =
  | 'invalid_file'
  | 'file_too_large'
  | 'unsupported_mime'
  | 'signature_mismatch';

export type BrandingLogoValidationResult =
  | { valid: true }
  | { valid: false; error: BrandingLogoValidationError };

function startsWith(bytes: Uint8Array, expected: readonly number[], offset = 0): boolean {
  if (bytes.length < offset + expected.length) return false;
  return expected.every((value, index) => bytes[offset + index] === value);
}

/** `89 50 4E 47 0D 0A 1A 0A` — die vollständige PNG-Signatur. */
function isPngSignature(bytes: Uint8Array): boolean {
  return startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
}

/**
 * `FF D8 FF` — nur diese drei Bytes. Das vierte kennzeichnet das folgende
 * Segment (`E0`, `E1`, `DB` …) und ist je nach Kamera und Werkzeug verschieden;
 * es festzulegen würde gültige Dateien abweisen.
 */
function isJpegSignature(bytes: Uint8Array): boolean {
  return startsWith(bytes, [0xff, 0xd8, 0xff]);
}

/**
 * `RIFF` an Position 0 und `WEBP` an Position 8. Die vier Bytes dazwischen
 * tragen die Dateilänge und dürfen jeden Wert haben — `RIFF` allein bezeichnet
 * nur den Container und käme auch bei einer WAV-Datei vor.
 */
function isWebpSignature(bytes: Uint8Array): boolean {
  return (
    startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) &&
    startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)
  );
}

function signatureMatchesMime(mimeType: LogoMimeType, bytes: Uint8Array): boolean {
  switch (mimeType) {
    case 'image/png':
      return isPngSignature(bytes);
    case 'image/jpeg':
      return isJpegSignature(bytes);
    case 'image/webp':
      return isWebpSignature(bytes);
  }
}

/**
 * Prüft die Datei in fester Reihenfolge: vorhanden, Grösse, angemeldeter Typ,
 * dann die Bytes. Erst danach darf der Aufrufer die vollständige Datei lesen.
 *
 * Lässt sich der Dateianfang nicht lesen, wird abgelehnt — **kein** Rückfall
 * auf `file.type`. Eine Datei, deren Inhalt unklar ist, wird nicht übernommen.
 */
export async function validateBrandingLogoFile(
  file: File | null | undefined,
): Promise<BrandingLogoValidationResult> {
  return validateBrandingLogoBlob(file);
}

/**
 * BRANDING-01D — dieselbe Prüfung für beliebige Binärdaten.
 *
 * `File` erweitert `Blob`; die Dateiprüfung aus 01C ist damit ein Sonderfall
 * dieser Funktion und delegiert an sie. So gibt es genau **eine**
 * Signaturtabelle, **eine** Grössengrenze und **eine** MIME-Liste — auch für
 * den Cloud-Weg, der keine `File`-Objekte kennt.
 *
 * Der Abgleich gegen einen **erwarteten** Typ (etwa aus einer
 * `LogoAssetReference`) gehört bewusst nicht hierher: Das ist ein Vergleich
 * zweier Angaben, keine Prüfung der Datei. Der Aufrufer erledigt ihn und
 * benennt den Fehler in seiner eigenen Sprache — so bleibt das Fehlermodell
 * dieser Datei unverändert, und die Anzeige in den Firmendaten ist nicht
 * betroffen.
 */
export async function validateBrandingLogoBlob(
  blob: Blob | null | undefined,
): Promise<BrandingLogoValidationResult> {
  if (!blob) {
    return { valid: false, error: 'invalid_file' };
  }
  if (blob.size === 0) {
    return { valid: false, error: 'invalid_file' };
  }
  if (blob.size > MAX_BRANDING_LOGO_SIZE_BYTES) {
    return { valid: false, error: 'file_too_large' };
  }
  if (!isLogoMimeType(blob.type)) {
    return { valid: false, error: 'unsupported_mime' };
  }

  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await blob.slice(0, SIGNATURE_BYTE_LENGTH).arrayBuffer());
  } catch {
    return { valid: false, error: 'invalid_file' };
  }

  if (!signatureMatchesMime(blob.type, bytes)) {
    return { valid: false, error: 'signature_mismatch' };
  }

  return { valid: true };
}
