/**
 * SETTINGS-01B3 — Logo-Vorbereitung: Signatur, Dekodierung, Downscale, Grenzen.
 * Dekoder/Encoder sind Fakes; die Regeln sind das Prüfobjekt.
 */
import { describe, expect, it } from 'vitest';
import {
  MAX_LOGO_EDGE_PX,
  computeLogoTargetSize,
  prepareBrandingLogo,
  type BrandingLogoImageDeps,
  type DecodedLogoImage,
} from './brandingLogoImageProcessing';
import { MAX_BRANDING_LOGO_SIZE_BYTES } from './brandingLogoValidation';

const SIGNATURES: Record<string, readonly number[]> = {
  'image/png': [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  'image/jpeg': [0xff, 0xd8, 0xff, 0xe0],
  'image/webp': [0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50],
};

function file(type: string, size = 64, signatureOf: string = type): File {
  const signature = SIGNATURES[signatureOf] ?? [];
  const bytes = new Uint8Array(Math.max(size, signature.length));
  bytes.set(signature, 0);
  return new File([bytes], 'logo', { type });
}

interface FakeOptions {
  width: number;
  height: number;
  encodedSize?: number;
  webpSupported?: boolean;
  decodeFails?: boolean;
}

function fakeDeps(options: FakeOptions): BrandingLogoImageDeps {
  return {
    decode: async (): Promise<DecodedLogoImage | null> =>
      options.decodeFails
        ? null
        : { width: options.width, height: options.height, source: {} },
    encode: async (_image, _target, mimeType) => {
      if (mimeType === 'image/webp' && options.webpSupported === false) return null;
      return new Blob([new Uint8Array(options.encodedSize ?? 1000)], { type: mimeType });
    },
  };
}

describe('SETTINGS-01B3 — computeLogoTargetSize', () => {
  it('lässt kleine Bilder unverändert und skaliert nie hoch', () => {
    expect(computeLogoTargetSize(300, 120)).toEqual({ width: 300, height: 120, resized: false });
    expect(computeLogoTargetSize(1600, 900)).toEqual({ width: 1600, height: 900, resized: false });
    expect(computeLogoTargetSize(10, 10)).toEqual({ width: 10, height: 10, resized: false });
  });

  it('verkleinert proportional auf die lange Kante', () => {
    expect(computeLogoTargetSize(4000, 3000)).toEqual({ width: 1600, height: 1200, resized: true });
    expect(computeLogoTargetSize(1000, 5000)).toEqual({ width: 320, height: 1600, resized: true });
    expect(computeLogoTargetSize(3200, 3200)).toEqual({ width: MAX_LOGO_EDGE_PX, height: MAX_LOGO_EDGE_PX, resized: true });
    expect(computeLogoTargetSize(20000, 1)).toEqual({ width: 1600, height: 1, resized: true });
  });
});

describe('SETTINGS-01B3 — prepareBrandingLogo', () => {
  it('PNG/JPEG/WebP mit echter Signatur werden angenommen; kleine Bilder bleiben byteidentisch', async () => {
    for (const type of ['image/png', 'image/jpeg', 'image/webp']) {
      const input = file(type, 500);
      const result = await prepareBrandingLogo(input, fakeDeps({ width: 400, height: 200 }));
      expect(result.ok, type).toBe(true);
      if (!result.ok) continue;
      expect(result.logo.blob).toBe(input);
      expect(result.logo.mimeType).toBe(type);
      expect(result.logo.resized).toBe(false);
      expect(result.logo.width).toBe(400);
    }
  });

  it('falsche Signatur, SVG, HTML-Tarnung und defekte Bilder werden abgewiesen', async () => {
    expect(await prepareBrandingLogo(file('image/png', 64, 'image/jpeg'), fakeDeps({ width: 1, height: 1 }))).toEqual({ ok: false, error: 'signature_mismatch' });
    expect(await prepareBrandingLogo(new File(['<svg/>'], 'x.svg', { type: 'image/svg+xml' }), fakeDeps({ width: 1, height: 1 }))).toEqual({ ok: false, error: 'unsupported_mime' });
    expect(await prepareBrandingLogo(new File(['<html><img></html>'], 'x.png', { type: 'image/png' }), fakeDeps({ width: 1, height: 1 }))).toEqual({ ok: false, error: 'signature_mismatch' });
    expect(await prepareBrandingLogo(file('image/png'), fakeDeps({ width: 1, height: 1, decodeFails: true }))).toEqual({ ok: false, error: 'decode_failed' });
    expect(await prepareBrandingLogo(file('image/png'), fakeDeps({ width: 0, height: 0 }))).toEqual({ ok: false, error: 'decode_failed' });
    expect(await prepareBrandingLogo(null)).toEqual({ ok: false, error: 'invalid_file' });
    expect(await prepareBrandingLogo(new File([], 'leer.png', { type: 'image/png' }))).toEqual({ ok: false, error: 'invalid_file' });
  });

  it('grosse Bilder werden proportional auf 1600 px verkleinert — PNG bleibt PNG (Transparenz), JPEG bleibt JPEG', async () => {
    const deps = fakeDeps({ width: 4000, height: 3000 });
    const png = await prepareBrandingLogo(file('image/png', 5 * 1024 * 1024), deps);
    expect(png.ok).toBe(true);
    if (!png.ok) return;
    expect(png.logo).toMatchObject({ width: 1600, height: 1200, resized: true, mimeType: 'image/png', originalWidth: 4000, originalHeight: 3000 });
    expect(png.logo.blob.type).toBe('image/png');
    const jpeg = await prepareBrandingLogo(file('image/jpeg', 3 * 1024 * 1024), deps);
    expect(jpeg.ok && jpeg.logo.mimeType).toBe('image/jpeg');
  });

  it('WebP ohne Browser-Encoder wird verlustfrei als PNG verkleinert', async () => {
    const result = await prepareBrandingLogo(file('image/webp', 100), fakeDeps({ width: 3200, height: 800, webpSupported: false }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.logo.mimeType).toBe('image/png');
    expect(result.logo).toMatchObject({ width: 1600, height: 400 });
  });

  it('Grenzen: Auswahl >20 MB, kleines Bild >2 MB, verkleinertes Bild >2 MB', async () => {
    expect(await prepareBrandingLogo(file('image/png', 21 * 1024 * 1024), fakeDeps({ width: 10, height: 10 }))).toEqual({ ok: false, error: 'file_too_large' });
    expect(await prepareBrandingLogo(file('image/png', MAX_BRANDING_LOGO_SIZE_BYTES + 1), fakeDeps({ width: 800, height: 800 }))).toEqual({ ok: false, error: 'too_large_after_processing' });
    expect(await prepareBrandingLogo(file('image/png', 100), fakeDeps({ width: 5000, height: 5000, encodedSize: MAX_BRANDING_LOGO_SIZE_BYTES + 1 }))).toEqual({ ok: false, error: 'too_large_after_processing' });
    // Genau an der Grenze ist erlaubt.
    expect((await prepareBrandingLogo(file('image/png', MAX_BRANDING_LOGO_SIZE_BYTES), fakeDeps({ width: 800, height: 800 }))).ok).toBe(true);
  });
});
