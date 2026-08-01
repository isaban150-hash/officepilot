/**
 * HEIC-SUPPORT-01A — normalize iPhone HEIC/HEIF to JPEG before the document pipeline.
 * Lazy-loads heic-to only when a HEIC file is detected.
 */
import { isHeicUploadFile } from './documentUploadValidation';

export type HeicNormalizeError = 'heic_conversion_failed';

export type PrepareUploadFileResult =
  | { success: true; file: File; convertedFromHeic: boolean }
  | { success: false; error: HeicNormalizeError };

type HeicToFn = (options: {
  blob: Blob;
  type: 'image/jpeg' | 'image/png';
  quality?: number;
}) => Promise<Blob>;

let heicToOverride: HeicToFn | null = null;

/** Test seam — inject a fake converter (no WASM in unit tests). */
export function setHeicToConverterForTests(converter: HeicToFn | null): void {
  heicToOverride = converter;
}

function jpegFileNameFromHeic(fileName: string): string {
  const base = fileName.replace(/\.(heic|heif)$/i, '');
  return `${base || 'photo'}.jpg`;
}

async function loadHeicTo(): Promise<HeicToFn> {
  if (heicToOverride) return heicToOverride;
  const mod = await import('heic-to');
  return mod.heicTo as HeicToFn;
}

/**
 * Converts HEIC/HEIF to a JPEG File. Non-HEIC files pass through unchanged.
 */
export async function prepareUploadFileForPipeline(file: File): Promise<PrepareUploadFileResult> {
  if (!isHeicUploadFile(file)) {
    return { success: true, file, convertedFromHeic: false };
  }

  try {
    const heicTo = await loadHeicTo();
    const jpegBlob = await heicTo({
      blob: file,
      type: 'image/jpeg',
      quality: 0.9,
    });
    if (!jpegBlob || jpegBlob.size <= 0) {
      return { success: false, error: 'heic_conversion_failed' };
    }
    const jpegFile = new File([jpegBlob], jpegFileNameFromHeic(file.name), {
      type: 'image/jpeg',
      lastModified: file.lastModified,
    });
    return { success: true, file: jpegFile, convertedFromHeic: true };
  } catch {
    return { success: false, error: 'heic_conversion_failed' };
  }
}
