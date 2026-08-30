/**
 * BRANDING-01D — Vertragstests der Asset-Infrastruktur.
 *
 * Schwerpunkte: Pfadsicherheit, echte UUIDs, Prüfung **vor** dem Schreiben,
 * Unveränderlichkeit, Cache-Trennung nach Workspace — und die Regel, dass bei
 * jedem Fehlschlag *kein* Ersatz-Asset zurückkommt.
 *
 * Neutrale synthetische Daten, kein Netz.
 */
import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { LogoAssetReference } from '../../types/branding';
import {
  buildBrandingAssetPath,
  generateBrandingAssetId,
  isPathSafeBrandingAssetId,
  isValidBrandingWorkspaceId,
} from './brandingAssetPath';
import {
  BRANDING_ASSET_BUCKET,
  downloadBrandingAsset,
  uploadBrandingAsset,
} from './brandingAssetCloudService';
import {
  BRANDING_ASSET_DB_NAME,
  BRANDING_ASSET_DB_VERSION,
  BRANDING_ASSET_STORE_NAME,
  buildBrandingAssetCacheKey,
  getCachedBrandingAsset,
  putCachedBrandingAsset,
} from './brandingAssetCacheService';
import { resolveBrandingAsset } from './brandingAssetResolver';
import { MAX_BRANDING_LOGO_SIZE_BYTES } from './brandingLogoValidation';

const WORKSPACE = '123e4567-e89b-12d3-a456-426614174000';
const OTHER_WORKSPACE = '99999999-e89b-12d3-a456-426614174000';
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_SIGNATURE = [0xff, 0xd8, 0xff, 0xe0];

function pngBlob(totalBytes = 64): Blob {
  const bytes = new Uint8Array(totalBytes);
  bytes.set(PNG_SIGNATURE, 0);
  return new Blob([bytes], { type: 'image/png' });
}

function blobOf(signature: readonly number[], type: string): Blob {
  const bytes = new Uint8Array(signature.length + 16);
  bytes.set(signature, 0);
  return new Blob([bytes], { type });
}

/** Schmale Attrappe der Storage-Schnittstelle — kein globales Mock-System. */
function fakeStorage(behaviour: {
  upload?: (path: string, body: unknown, options: unknown) => unknown;
  download?: (path: string) => unknown;
}) {
  const calls = { upload: [] as unknown[][], download: [] as unknown[][], buckets: [] as string[] };
  const client = {
    storage: {
      from(bucket: string) {
        calls.buckets.push(bucket);
        return {
          upload: async (path: string, body: unknown, options: unknown) => {
            calls.upload.push([path, body, options]);
            return behaviour.upload?.(path, body, options) ?? { data: { path }, error: null };
          },
          download: async (path: string) => {
            calls.download.push([path]);
            return behaviour.download?.(path) ?? { data: pngBlob(), error: null };
          },
        };
      },
    },
  } as unknown as SupabaseClient;
  return { client, calls };
}

/** Führt `run` ohne die genannten Crypto-Fähigkeiten aus und stellt sie wieder her. */
async function withoutCrypto(
  removed: Array<'randomUUID' | 'getRandomValues'>,
  run: () => Promise<void> | void,
): Promise<void> {
  const originals = removed.map(
    (name) => [name, (crypto as unknown as Record<string, unknown>)[name]] as const,
  );
  try {
    for (const [name] of originals) {
      Object.defineProperty(crypto, name, { value: undefined, configurable: true });
    }
    await run();
  } finally {
    for (const [name, value] of originals) {
      Object.defineProperty(crypto, name, { value, configurable: true });
    }
  }
}

describe('BRANDING-01D Pfad und Kennung', () => {
  it('baut den Pfad aus Workspace und Kennung', () => {
    expect(buildBrandingAssetPath(WORKSPACE, 'asset-1')).toEqual({
      ok: true,
      path: `${WORKSPACE}/asset-1`,
    });
    // Deterministisch.
    expect(buildBrandingAssetPath(WORKSPACE, 'asset-1')).toEqual(
      buildBrandingAssetPath(WORKSPACE, 'asset-1'),
    );
  });

  it('weist ungültige Workspace-Kennungen ab', () => {
    for (const workspaceId of ['', 'nicht-uuid', '123', `${WORKSPACE}/x`, ' ' + WORKSPACE]) {
      expect(buildBrandingAssetPath(workspaceId, 'asset-1')).toEqual({
        ok: false,
        error: 'invalid_workspace',
      });
      expect(isValidBrandingWorkspaceId(workspaceId)).toBe(false);
    }
  });

  it('weist pfadgefährliche Asset-Kennungen ab', () => {
    for (const assetId of [
      '',
      '..',
      '../andere',
      'a/b',
      'a\\b',
      '%2e%2e',
      '%2f',
      'a b',
      '.versteckt',
      // Steuerzeichen: NUL und Zeilenumbruch, bewusst als Escape geschrieben.
      'a\0b',
      'a\nb',
      'ä',
      'x'.repeat(200),
    ]) {
      expect(buildBrandingAssetPath(WORKSPACE, assetId)).toEqual({
        ok: false,
        error: 'invalid_asset',
      });
      expect(isPathSafeBrandingAssetId(assetId)).toBe(false);
    }
  });

  it('erzeugt echte UUIDs der Version 4', () => {
    const first = generateBrandingAssetId();
    const second = generateBrandingAssetId();

    expect(first).toMatch(UUID_V4);
    expect(second).toMatch(UUID_V4);
    expect(first).not.toBe(second);
    expect(isPathSafeBrandingAssetId(first)).toBe(true);
  });

  it('erzeugt auch ohne randomUUID eine gültige UUID v4 — und nie aus Math.random', async () => {
    /*
     * `crypto.randomUUID` fehlt auf einer HTTP-Adresse im lokalen Netz, also
     * genau dort, wo die Realtests laufen. `getRandomValues` bleibt verfügbar.
     */
    await withoutCrypto(['randomUUID'], () => {
      const randomSpy = vi.spyOn(Math, 'random');
      const dateSpy = vi.spyOn(Date, 'now');

      const generated = generateBrandingAssetId();

      expect(generated).toMatch(UUID_V4);
      expect(randomSpy).not.toHaveBeenCalled();
      expect(dateSpy).not.toHaveBeenCalled();
      randomSpy.mockRestore();
      dateSpy.mockRestore();
    });
  });

  it('wirft ohne jede sichere Zufallsquelle, statt schwach zu raten', async () => {
    await withoutCrypto(['randomUUID', 'getRandomValues'], () => {
      const randomSpy = vi.spyOn(Math, 'random');

      expect(() => generateBrandingAssetId()).toThrow(/keine sichere Zufallsquelle/);
      expect(randomSpy).not.toHaveBeenCalled();
      randomSpy.mockRestore();
    });
  });
});

describe('BRANDING-01D Upload', () => {
  it('schreibt in den richtigen Bucket, mit contentType und ohne upsert', async () => {
    const { client, calls } = fakeStorage({});

    const result = await uploadBrandingAsset(
      { workspaceId: WORKSPACE, blob: pngBlob(), mimeType: 'image/png' },
      client,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unerwartet');
    expect(calls.buckets).toEqual([BRANDING_ASSET_BUCKET]);

    const [path, , options] = calls.upload[0];
    expect(path).toBe(`${WORKSPACE}/${result.reference.assetId}`);
    expect(options).toEqual({ contentType: 'image/png', upsert: false });
    expect(result.reference.mimeType).toBe('image/png');
    expect(result.reference.assetId).toMatch(UUID_V4);
  });

  it('prüft vor dem Netzaufruf: zu groß, falscher Typ, falsche Bytes', async () => {
    const cases: Array<[Blob, 'image/png' | 'image/jpeg', string]> = [
      [pngBlob(MAX_BRANDING_LOGO_SIZE_BYTES + 1), 'image/png', 'file_too_large'],
      [blobOf(JPEG_SIGNATURE, 'image/png'), 'image/png', 'signature_mismatch'],
      [blobOf(PNG_SIGNATURE, 'image/gif'), 'image/png', 'mime_mismatch'],
      [pngBlob(), 'image/jpeg', 'mime_mismatch'],
    ];

    for (const [blob, mimeType, expected] of cases) {
      const { client, calls } = fakeStorage({});
      const result = await uploadBrandingAsset({ workspaceId: WORKSPACE, blob, mimeType }, client);

      expect(result).toEqual({ ok: false, error: expected });
      // Entscheidend: Es wurde nichts hochgeladen.
      expect(calls.upload).toEqual([]);
    }
  });

  it('lehnt einen ungültigen Workspace ab, bevor eine Kennung entsteht', async () => {
    const { client, calls } = fakeStorage({});
    /*
     * Der Nachweis der Reihenfolge: Ohne jede Zufallsquelle müsste eine
     * Kennungserzeugung `secure_random_unavailable` melden. Gemeldet wird
     * stattdessen der Workspace — also wurde gar nicht erst erzeugt.
     */
    await withoutCrypto(['randomUUID', 'getRandomValues'], async () => {
      const result = await uploadBrandingAsset(
        { workspaceId: 'nicht-uuid', blob: pngBlob(), mimeType: 'image/png' },
        client,
      );

      expect(result).toEqual({ ok: false, error: 'invalid_workspace' });
      expect(calls.upload).toEqual([]);
    });
  });

  it('meldet eine fehlende Zufallsquelle strukturiert, ohne Storage-Aufruf', async () => {
    const { client, calls } = fakeStorage({});

    await withoutCrypto(['randomUUID', 'getRandomValues'], async () => {
      const randomSpy = vi.spyOn(Math, 'random');

      const result = await uploadBrandingAsset(
        { workspaceId: WORKSPACE, blob: pngBlob(), mimeType: 'image/png' },
        client,
      );

      // Kein abgelehntes Promise, sondern der reguläre Ergebnisvertrag.
      expect(result).toEqual({ ok: false, error: 'secure_random_unavailable' });
      expect(calls.upload).toEqual([]);
      expect(randomSpy).not.toHaveBeenCalled();
      randomSpy.mockRestore();
    });
  });

  it('meldet einen belegten Pfad als Konflikt — kein Überschreiben', async () => {
    const { client } = fakeStorage({
      upload: () => ({
        data: null,
        error: { message: 'The resource already exists', statusCode: '409' },
      }),
    });

    const result = await uploadBrandingAsset(
      { workspaceId: WORKSPACE, blob: pngBlob(), mimeType: 'image/png' },
      client,
    );

    expect(result).toEqual({ ok: false, error: 'conflict' });
  });
});

describe('BRANDING-01D Download', () => {
  const reference: LogoAssetReference = { assetId: 'logo-1', mimeType: 'image/png' };

  it('lädt aus dem richtigen Bucket und Pfad', async () => {
    const { client, calls } = fakeStorage({});

    const result = await downloadBrandingAsset(WORKSPACE, reference, client);

    expect(result.ok).toBe(true);
    expect(calls.buckets).toEqual([BRANDING_ASSET_BUCKET]);
    expect(calls.download[0][0]).toBe(`${WORKSPACE}/logo-1`);
  });

  it('weist abweichenden Typ und falsche Bytes ab — ohne Ersatz', async () => {
    const mismatch = await downloadBrandingAsset(
      WORKSPACE,
      reference,
      fakeStorage({ download: () => ({ data: blobOf(JPEG_SIGNATURE, 'image/jpeg'), error: null }) })
        .client,
    );
    expect(mismatch).toEqual({ ok: false, error: 'mime_mismatch' });

    const badBytes = await downloadBrandingAsset(
      WORKSPACE,
      reference,
      fakeStorage({ download: () => ({ data: blobOf(JPEG_SIGNATURE, 'image/png'), error: null }) })
        .client,
    );
    expect(badBytes).toEqual({ ok: false, error: 'signature_mismatch' });
  });

  it('bildet Storage-Fehler auf klare Codes ab', async () => {
    const cases: Array<[{ message?: string; statusCode?: string }, string]> = [
      [{ statusCode: '404', message: 'Object not found' }, 'not_found'],
      [{ statusCode: '403', message: 'row-level security' }, 'forbidden'],
      [{ message: 'Failed to fetch' }, 'network'],
      [{ message: 'irgendetwas anderes' }, 'unknown'],
    ];

    for (const [error, expected] of cases) {
      const { client } = fakeStorage({ download: () => ({ data: null, error }) });
      await expect(downloadBrandingAsset(WORKSPACE, reference, client)).resolves.toEqual({
        ok: false,
        error: expected,
      });
    }
  });

  it('weist einen pfadgefährlichen Verweis vor dem Netzaufruf ab', async () => {
    const { client, calls } = fakeStorage({});

    const result = await downloadBrandingAsset(
      WORKSPACE,
      { assetId: '../anderer-workspace/logo', mimeType: 'image/png' },
      client,
    );

    expect(result).toEqual({ ok: false, error: 'invalid_asset' });
    expect(calls.download).toEqual([]);
  });
});

/** Liest den Rohdatensatz an der Cache-Schnittstelle vorbei. */
async function readRawCacheEntry(key: string): Promise<{ bytes: unknown; mimeType: unknown }> {
  const db: IDBDatabase = await new Promise((resolve, reject) => {
    const request = indexedDB.open(BRANDING_ASSET_DB_NAME, BRANDING_ASSET_DB_VERSION);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction(BRANDING_ASSET_STORE_NAME, 'readonly');
      const request = transaction.objectStore(BRANDING_ASSET_STORE_NAME).get(key);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

/** Schreibt unter einem rohen Schlüssel — am Cache-Dienst vorbei. */
async function writeRawCacheEntry(key: string, blob: Blob): Promise<void> {
  const bytes = await blob.arrayBuffer();
  const db: IDBDatabase = await new Promise((resolve, reject) => {
    const request = indexedDB.open(BRANDING_ASSET_DB_NAME, BRANDING_ASSET_DB_VERSION);
    request.onupgradeneeded = () => {
      const upgraded = request.result;
      if (!upgraded.objectStoreNames.contains(BRANDING_ASSET_STORE_NAME)) {
        upgraded.createObjectStore(BRANDING_ASSET_STORE_NAME, { keyPath: 'key' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(BRANDING_ASSET_STORE_NAME, 'readwrite');
      transaction
        .objectStore(BRANDING_ASSET_STORE_NAME)
        .put({ key, bytes, mimeType: blob.type });
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
  } finally {
    db.close();
  }
}

describe('BRANDING-01D Cache', () => {
  it('liefert nach dem Speichern wieder einen Blob — Bytes und MIME identisch', async () => {
    /*
     * Intern liegen Bytes plus MIME-Typ, nach aussen bleibt es ein Blob. Der
     * Test prüft die Rundreise byteweise, damit eine Umkodierung auffiele.
     */
    const source = new Uint8Array(64);
    source.set(PNG_SIGNATURE, 0);
    source[40] = 0xab;
    source[63] = 0x7f;
    const blob = new Blob([source], { type: 'image/png' });

    expect(await putCachedBrandingAsset(WORKSPACE, 'logo-cache-1', blob)).toBe(true);

    const cached = await getCachedBrandingAsset(WORKSPACE, 'logo-cache-1');
    expect(cached).toBeInstanceOf(Blob);
    expect(cached?.type).toBe('image/png');
    expect(cached?.size).toBe(blob.size);

    const roundTripped = new Uint8Array(await cached!.arrayBuffer());
    expect([...roundTripped]).toEqual([...source]);
  });

  it('speichert keine Zeichenkette und kein Base64', async () => {
    await putCachedBrandingAsset(WORKSPACE, 'logo-cache-raw', pngBlob());

    const stored = await readRawCacheEntry(buildBrandingAssetCacheKey(WORKSPACE, 'logo-cache-raw'));
    expect(stored).not.toBeNull();
    expect(stored.bytes).toBeInstanceOf(ArrayBuffer);
    expect(typeof stored.bytes).not.toBe('string');
    expect(stored.mimeType).toBe('image/png');
    // Eine Base64-Fassung wäre rund ein Drittel grösser.
    expect((stored.bytes as ArrayBuffer).byteLength).toBe(64);
  });

  it('unbekannte Kennung liefert null', async () => {
    expect(await getCachedBrandingAsset(WORKSPACE, 'gibt-es-nicht')).toBeNull();
  });

  it('trennt nach Workspace', async () => {
    await putCachedBrandingAsset(WORKSPACE, 'logo-shared', pngBlob());

    expect(await getCachedBrandingAsset(WORKSPACE, 'logo-shared')).not.toBeNull();
    expect(await getCachedBrandingAsset(OTHER_WORKSPACE, 'logo-shared')).toBeNull();
    expect(buildBrandingAssetCacheKey(WORKSPACE, 'a')).not.toBe(
      buildBrandingAssetCacheKey(OTHER_WORKSPACE, 'a'),
    );
  });
});

describe('BRANDING-01D Resolver', () => {
  const reference: LogoAssetReference = { assetId: 'logo-resolve', mimeType: 'image/png' };

  it('Cache-Treffer vermeidet den Netzaufruf', async () => {
    await putCachedBrandingAsset(WORKSPACE, reference.assetId, pngBlob());
    const { client, calls } = fakeStorage({});

    const result = await resolveBrandingAsset(WORKSPACE, reference, client);

    expect(result.ok).toBe(true);
    expect(calls.download).toEqual([]);
  });

  it('Cache-Fehltreffer lädt einmal und speichert das Ergebnis', async () => {
    const missing: LogoAssetReference = { assetId: 'logo-miss', mimeType: 'image/png' };
    const { client, calls } = fakeStorage({});

    const first = await resolveBrandingAsset(WORKSPACE, missing, client);
    expect(first.ok).toBe(true);
    expect(calls.download).toHaveLength(1);

    // Zweiter Aufruf kommt aus dem Cache.
    const second = await resolveBrandingAsset(WORKSPACE, missing, client);
    expect(second.ok).toBe(true);
    expect(calls.download).toHaveLength(1);
  });

  it('ohne Netz und ohne Cache gibt es kein Ersatz-Asset', async () => {
    const offline: LogoAssetReference = { assetId: 'logo-offline', mimeType: 'image/png' };
    const { client } = fakeStorage({
      download: () => ({ data: null, error: { message: 'Failed to fetch' } }),
    });

    const result = await resolveBrandingAsset(WORKSPACE, offline, client);

    expect(result).toEqual({ ok: false, error: 'network' });
  });

  it('ein ungültiger Cacheeintrag gilt nicht als Erfolg, der Download wird versucht', async () => {
    const broken: LogoAssetReference = { assetId: 'logo-broken', mimeType: 'image/png' };
    // Als PNG abgelegt, tatsächlich JPEG-Bytes.
    await putCachedBrandingAsset(WORKSPACE, broken.assetId, blobOf(JPEG_SIGNATURE, 'image/png'));
    const { client, calls } = fakeStorage({});

    const result = await resolveBrandingAsset(WORKSPACE, broken, client);

    expect(result.ok).toBe(true);
    expect(calls.download).toHaveLength(1);
  });

  it('ein ungültiger MIME-Typ wird abgewiesen, auch mit gültigem Cacheeintrag', async () => {
    /*
     * Die Referenz kann zur Laufzeit beschädigt ankommen — aus einem alten
     * Datenbestand oder einem fremden Payload. Der Download lehnt das mit
     * `invalid_mime` ab; der Resolver muss denselben Fehler liefern, sonst
     * hinge das Ergebnis davon ab, ob gerade etwas im Cache liegt.
     */
    const assetId = 'logo-mime-guard';
    await putCachedBrandingAsset(WORKSPACE, assetId, pngBlob());
    const { client, calls } = fakeStorage({});

    const broken = { assetId, mimeType: 'image/svg+xml' } as unknown as LogoAssetReference;
    const result = await resolveBrandingAsset(WORKSPACE, broken, client);

    expect(result).toEqual({ ok: false, error: 'invalid_mime' });
    expect(calls.download).toEqual([]);
    // Und der gültige Eintrag wird auch nicht ersatzweise geliefert.
    expect(await getCachedBrandingAsset(WORKSPACE, assetId)).not.toBeNull();
  });

  it('ein ungültiger Workspace wird abgewiesen, auch mit passendem Cacheeintrag', async () => {
    /*
     * Der Cache darf keine Hintertür an der Pfadprüfung vorbei sein: Unter dem
     * rohen Schlüssel liegt ein einwandfreies Asset, der Workspace ist aber
     * keine gültige Kennung. Der Download würde das ablehnen — der Resolver
     * muss es ebenso tun, und zwar vor jedem Zugriff.
     */
    const invalidWorkspace = 'nicht-uuid';
    await writeRawCacheEntry(
      buildBrandingAssetCacheKey(invalidWorkspace, 'logo-guard'),
      pngBlob(),
    );
    const { client, calls } = fakeStorage({});

    const result = await resolveBrandingAsset(
      invalidWorkspace,
      { assetId: 'logo-guard', mimeType: 'image/png' },
      client,
    );

    expect(result).toEqual({ ok: false, error: 'invalid_workspace' });
    expect(calls.download).toEqual([]);
  });

  it('eine pfadgefährliche Asset-Kennung wird abgewiesen, auch mit passendem Cacheeintrag', async () => {
    const dangerous = '../anderer-workspace/logo';
    await writeRawCacheEntry(buildBrandingAssetCacheKey(WORKSPACE, dangerous), pngBlob());
    const { client, calls } = fakeStorage({});

    const result = await resolveBrandingAsset(
      WORKSPACE,
      { assetId: dangerous, mimeType: 'image/png' },
      client,
    );

    expect(result).toEqual({ ok: false, error: 'invalid_asset' });
    expect(calls.download).toEqual([]);
  });
});
