/**
 * BRANDING-01C — Vertragstests der Logo-Prüfung.
 *
 * Der Kern: Ein angemeldeter MIME-Typ beweist nichts. Geprüft wird deshalb
 * durchgehend die Kombination aus `file.type` und tatsächlichen Anfangsbytes.
 *
 * Neutrale synthetische Dateien, kein echtes Bildmaterial nötig.
 */
import { describe, expect, it } from 'vitest';
import {
  MAX_BRANDING_LOGO_SIZE_BYTES,
  validateBrandingLogoFile,
} from './brandingLogoValidation';

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_SIGNATURE = [0xff, 0xd8, 0xff, 0xe0];
const WEBP_SIGNATURE = [
  0x52, 0x49, 0x46, 0x46, // RIFF
  0x24, 0x00, 0x00, 0x00, // Länge — beliebig
  0x57, 0x45, 0x42, 0x50, // WEBP
];

/** Signaturbytes plus Füllmaterial, damit die Datei realistisch lang ist. */
function fileFrom(
  signature: readonly number[],
  type: string,
  options: { totalBytes?: number; name?: string } = {},
): File {
  const total = options.totalBytes ?? signature.length + 32;
  const bytes = new Uint8Array(Math.max(total, signature.length));
  bytes.set(signature, 0);
  return new File([bytes], options.name ?? 'logo', { type });
}

describe('BRANDING-01C Logo-Prüfung', () => {
  it('A — PNG mit gültiger Signatur wird angenommen', async () => {
    await expect(validateBrandingLogoFile(fileFrom(PNG_SIGNATURE, 'image/png'))).resolves.toEqual({
      valid: true,
    });
  });

  it('B — JPEG mit gültiger Signatur wird angenommen', async () => {
    await expect(validateBrandingLogoFile(fileFrom(JPEG_SIGNATURE, 'image/jpeg'))).resolves.toEqual(
      { valid: true },
    );
  });

  it('B2 — das vierte JPEG-Byte ist nicht festgelegt', async () => {
    /* Kameras und Werkzeuge setzen dort verschiedene Segmentkennungen. */
    for (const fourth of [0xe0, 0xe1, 0xdb, 0xee]) {
      const result = await validateBrandingLogoFile(
        fileFrom([0xff, 0xd8, 0xff, fourth], 'image/jpeg'),
      );
      expect(result).toEqual({ valid: true });
    }
  });

  it('C — WebP mit RIFF und WEBP-Marker wird angenommen', async () => {
    await expect(validateBrandingLogoFile(fileFrom(WEBP_SIGNATURE, 'image/webp'))).resolves.toEqual(
      { valid: true },
    );
  });

  it('D/E — nicht unterstützte Typen werden abgewiesen', async () => {
    for (const type of [
      'image/svg+xml',
      'image/gif',
      'image/heic',
      'application/pdf',
      'text/plain',
      '',
    ]) {
      const result = await validateBrandingLogoFile(fileFrom(PNG_SIGNATURE, type));
      expect(result).toEqual({ valid: false, error: 'unsupported_mime' });
    }
  });

  it('F — genau 2 MiB besteht die Grössenprüfung', async () => {
    const file = fileFrom(PNG_SIGNATURE, 'image/png', {
      totalBytes: MAX_BRANDING_LOGO_SIZE_BYTES,
    });
    expect(file.size).toBe(2 * 1024 * 1024);
    await expect(validateBrandingLogoFile(file)).resolves.toEqual({ valid: true });
  });

  it('G — ein Byte darüber wird abgewiesen', async () => {
    const file = fileFrom(PNG_SIGNATURE, 'image/png', {
      totalBytes: MAX_BRANDING_LOGO_SIZE_BYTES + 1,
    });
    expect(file.size).toBe(2 * 1024 * 1024 + 1);
    await expect(validateBrandingLogoFile(file)).resolves.toEqual({
      valid: false,
      error: 'file_too_large',
    });
  });

  it('H — die Grösse entscheidet vor dem Lesen der Bytes', async () => {
    /*
     * Nachweis über die Reihenfolge: Die Datei ist zu gross **und** hätte eine
     * unzulässige Signatur. Gemeldet wird die Grösse — also wurde gar nicht
     * erst gelesen. Zusätzlich schlägt `arrayBuffer` hier absichtlich fehl;
     * käme es zum Aufruf, wäre das Ergebnis `invalid_file`.
     */
    const file = fileFrom([0x00, 0x00], 'image/png', {
      totalBytes: MAX_BRANDING_LOGO_SIZE_BYTES + 1024,
    });
    Object.defineProperty(file, 'slice', {
      value: () => {
        throw new Error('darf nicht gelesen werden');
      },
    });

    await expect(validateBrandingLogoFile(file)).resolves.toEqual({
      valid: false,
      error: 'file_too_large',
    });
  });

  it('I — PNG angemeldet, JPEG-Bytes: abgewiesen', async () => {
    await expect(validateBrandingLogoFile(fileFrom(JPEG_SIGNATURE, 'image/png'))).resolves.toEqual({
      valid: false,
      error: 'signature_mismatch',
    });
  });

  it('J — JPEG angemeldet, PNG-Bytes: abgewiesen', async () => {
    await expect(validateBrandingLogoFile(fileFrom(PNG_SIGNATURE, 'image/jpeg'))).resolves.toEqual({
      valid: false,
      error: 'signature_mismatch',
    });
  });

  it('J2 — als PNG getarnte SVG-Datei: abgewiesen', async () => {
    /* Der eigentliche Zweck der Signaturprüfung. */
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    const file = new File([svg], 'logo.png', { type: 'image/png' });

    await expect(validateBrandingLogoFile(file)).resolves.toEqual({
      valid: false,
      error: 'signature_mismatch',
    });
  });

  it('K — RIFF ohne WEBP-Marker: abgewiesen', async () => {
    const riffOnly = [
      0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45, // WAVE
    ];
    await expect(validateBrandingLogoFile(fileFrom(riffOnly, 'image/webp'))).resolves.toEqual({
      valid: false,
      error: 'signature_mismatch',
    });
  });

  it('L — leere Datei: abgewiesen', async () => {
    await expect(
      validateBrandingLogoFile(new File([], 'logo.png', { type: 'image/png' })),
    ).resolves.toEqual({ valid: false, error: 'invalid_file' });
  });

  it('M — zu kurze Datei: abgewiesen', async () => {
    // Vier Bytes können keine vollständige PNG- oder WebP-Signatur tragen.
    await expect(
      validateBrandingLogoFile(fileFrom([0x89, 0x50, 0x4e, 0x47], 'image/png', { totalBytes: 4 })),
    ).resolves.toEqual({ valid: false, error: 'signature_mismatch' });

    await expect(
      validateBrandingLogoFile(fileFrom([0x52, 0x49, 0x46, 0x46], 'image/webp', { totalBytes: 4 })),
    ).resolves.toEqual({ valid: false, error: 'signature_mismatch' });
  });

  it('M2 — fehlende Datei: abgewiesen', async () => {
    await expect(validateBrandingLogoFile(null)).resolves.toEqual({
      valid: false,
      error: 'invalid_file',
    });
    await expect(validateBrandingLogoFile(undefined)).resolves.toEqual({
      valid: false,
      error: 'invalid_file',
    });
  });

  it('M3 — unlesbarer Dateianfang: abgewiesen, kein Rückfall auf file.type', async () => {
    const file = fileFrom(PNG_SIGNATURE, 'image/png');
    Object.defineProperty(file, 'slice', {
      value: () => ({
        arrayBuffer: () => Promise.reject(new Error('read failed')),
      }),
    });

    await expect(validateBrandingLogoFile(file)).resolves.toEqual({
      valid: false,
      error: 'invalid_file',
    });
  });

  it('N — die geprüfte Datei wird nicht verändert', async () => {
    const file = fileFrom(PNG_SIGNATURE, 'image/png');
    const before = { size: file.size, type: file.type, name: file.name };

    await validateBrandingLogoFile(file);

    expect({ size: file.size, type: file.type, name: file.name }).toEqual(before);
    // Der Inhalt ist unverändert lesbar.
    const bytes = new Uint8Array(await file.arrayBuffer());
    expect([...bytes.slice(0, 8)]).toEqual(PNG_SIGNATURE);
  });
});
