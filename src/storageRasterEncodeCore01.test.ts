import { afterEach, describe, expect, it } from 'vitest';
import {
  computeRasterEncodeTargetDimensions,
  encodeDocumentFileRasterToJpeg,
  setDocumentFileRasterEncodeAdaptersForTests,
  type DocumentFileDecodedRasterSource,
  type DocumentFileRasterEncodeAdapters,
} from './services/documentFileRasterEncodeService';
import {
  RASTER_ENCODE_JPEG_QUALITY,
  RASTER_ENCODE_MAX_EDGE_PX,
  RASTER_ENCODE_SOURCE_MIME_TYPES,
  type DocumentFileRasterEncodeError,
} from './types/documentFileRasterEncode';

interface EncodeCall {
  targetWidth: number;
  targetHeight: number;
  quality: number;
  sourceWidth: number;
  sourceHeight: number;
}

function isEncodeError(value: unknown): value is DocumentFileRasterEncodeError {
  return (
    value !== null &&
    typeof value === 'object' &&
    'code' in value &&
    ((value as { code: unknown }).code === 'decode_failed' ||
      (value as { code: unknown }).code === 'encode_failed')
  );
}

function createFakeAdapters(options: {
  sourceWidth: number;
  sourceHeight: number;
  outputBytes?: Uint8Array;
  decodeError?: DocumentFileRasterEncodeError;
  encodeError?: DocumentFileRasterEncodeError;
  onEncode?: (call: EncodeCall) => void;
}): DocumentFileRasterEncodeAdapters {
  const outputBytes = options.outputBytes ?? new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);

  return {
    async decodeRaster(bytes) {
      if (options.decodeError) {
        throw options.decodeError;
      }
      // Touch bytes so callers can assert copies were passed without mutating originals.
      expect(bytes.byteLength).toBeGreaterThan(0);
      return Object.freeze({
        width: options.sourceWidth,
        height: options.sourceHeight,
      }) satisfies DocumentFileDecodedRasterSource;
    },
    async encodeJpeg(source, targetWidth, targetHeight, quality) {
      options.onEncode?.({
        targetWidth,
        targetHeight,
        quality,
        sourceWidth: source.width,
        sourceHeight: source.height,
      });
      if (options.encodeError) {
        throw options.encodeError;
      }
      return outputBytes.slice();
    },
  };
}

afterEach(() => {
  setDocumentFileRasterEncodeAdaptersForTests(null);
});

describe('STORAGE-RASTER-ENCODE-CORE-01', () => {
  describe('Fall A: Defaults und Quell-MIME', () => {
    it('dokumentiert feste JPEG-Qualität und Max-Kante', () => {
      expect(RASTER_ENCODE_JPEG_QUALITY).toBe(0.85);
      expect(RASTER_ENCODE_MAX_EDGE_PX).toBe(2048);
      expect([...RASTER_ENCODE_SOURCE_MIME_TYPES]).toEqual([
        'image/jpeg',
        'image/png',
        'image/webp',
      ]);
    });

    it('akzeptiert JPEG-, PNG- und WebP-Input und gibt JPEG aus', async () => {
      for (const sourceMimeType of RASTER_ENCODE_SOURCE_MIME_TYPES) {
        const encodeCalls: EncodeCall[] = [];
        setDocumentFileRasterEncodeAdaptersForTests(
          createFakeAdapters({
            sourceWidth: 100,
            sourceHeight: 80,
            onEncode: (call) => encodeCalls.push(call),
          }),
        );

        const result = await encodeDocumentFileRasterToJpeg({
          bytes: new Uint8Array([1, 2, 3, 4]),
          sourceMimeType,
        });

        expect(result.mimeType).toBe('image/jpeg');
        expect(result.bytes).toBeInstanceOf(Uint8Array);
        expect(result.bytes.byteLength).toBeGreaterThan(0);
        expect(result.width).toBe(100);
        expect(result.height).toBe(80);
        expect(encodeCalls).toHaveLength(1);
      }
    });
  });

  describe('Fall B: Dimensionen und Seitenverhältnis', () => {
    it('skaliert lange Kante auf Max und erhält Seitenverhältnis', () => {
      const target = computeRasterEncodeTargetDimensions(4096, 2048, RASTER_ENCODE_MAX_EDGE_PX);
      expect(target.width).toBe(2048);
      expect(target.height).toBe(1024);
      expect(target.width / target.height).toBeCloseTo(4096 / 2048);
    });

    it('skaliert Hochformat ebenso und bleibt unter Max-Kante', async () => {
      let encodeCall: EncodeCall | undefined;
      setDocumentFileRasterEncodeAdaptersForTests(
        createFakeAdapters({
          sourceWidth: 1000,
          sourceHeight: 4000,
          onEncode: (call) => {
            encodeCall = call;
          },
        }),
      );

      const result = await encodeDocumentFileRasterToJpeg({
        bytes: new Uint8Array([9, 8, 7]),
        sourceMimeType: 'image/png',
      });

      expect(result.width).toBe(512);
      expect(result.height).toBe(2048);
      expect(Math.max(result.width, result.height)).toBeLessThanOrEqual(RASTER_ENCODE_MAX_EDGE_PX);
      expect(encodeCall?.targetWidth).toBe(512);
      expect(encodeCall?.targetHeight).toBe(2048);
    });

    it('skaliert kleine Bilder nicht hoch', async () => {
      let encodeCall: EncodeCall | undefined;
      setDocumentFileRasterEncodeAdaptersForTests(
        createFakeAdapters({
          sourceWidth: 320,
          sourceHeight: 240,
          onEncode: (call) => {
            encodeCall = call;
          },
        }),
      );

      const result = await encodeDocumentFileRasterToJpeg({
        bytes: new Uint8Array([5, 5, 5]),
        sourceMimeType: 'image/jpeg',
      });

      expect(result.width).toBe(320);
      expect(result.height).toBe(240);
      expect(encodeCall?.targetWidth).toBe(320);
      expect(encodeCall?.targetHeight).toBe(240);
    });
  });

  describe('Fall C: Qualität und Defaults an Encoder', () => {
    it('übergibt dokumentierte JPEG-Qualität an den Encode-Adapter', async () => {
      let encodeCall: EncodeCall | undefined;
      setDocumentFileRasterEncodeAdaptersForTests(
        createFakeAdapters({
          sourceWidth: 64,
          sourceHeight: 64,
          onEncode: (call) => {
            encodeCall = call;
          },
        }),
      );

      await encodeDocumentFileRasterToJpeg({
        bytes: new Uint8Array([1]),
        sourceMimeType: 'image/webp',
      });

      expect(encodeCall?.quality).toBe(RASTER_ENCODE_JPEG_QUALITY);
      expect(encodeCall?.quality).toBe(0.85);
    });
  });

  describe('Fall D: Decode-/Encode-Fehler', () => {
    it('Decode-Fehler als decode_failed', async () => {
      setDocumentFileRasterEncodeAdaptersForTests(
        createFakeAdapters({
          sourceWidth: 10,
          sourceHeight: 10,
          decodeError: Object.freeze({
            code: 'decode_failed',
            message: 'boom-decode',
          }),
        }),
      );

      await expect(
        encodeDocumentFileRasterToJpeg({
          bytes: new Uint8Array([1, 2]),
          sourceMimeType: 'image/jpeg',
        }),
      ).rejects.toSatisfy(
        (error: unknown) => isEncodeError(error) && error.code === 'decode_failed',
      );
    });

    it('Encode-Fehler als encode_failed', async () => {
      setDocumentFileRasterEncodeAdaptersForTests(
        createFakeAdapters({
          sourceWidth: 10,
          sourceHeight: 10,
          encodeError: Object.freeze({
            code: 'encode_failed',
            message: 'boom-encode',
          }),
        }),
      );

      await expect(
        encodeDocumentFileRasterToJpeg({
          bytes: new Uint8Array([1, 2]),
          sourceMimeType: 'image/png',
        }),
      ).rejects.toSatisfy(
        (error: unknown) => isEncodeError(error) && error.code === 'encode_failed',
      );
    });

    it('unerwartete Decode-Exceptions werden auf decode_failed gemappt', async () => {
      setDocumentFileRasterEncodeAdaptersForTests({
        async decodeRaster() {
          throw new Error('unexpected');
        },
        async encodeJpeg() {
          return new Uint8Array([1]);
        },
      });

      await expect(
        encodeDocumentFileRasterToJpeg({
          bytes: new Uint8Array([1]),
          sourceMimeType: 'image/jpeg',
        }),
      ).rejects.toSatisfy(
        (error: unknown) => isEncodeError(error) && error.code === 'decode_failed',
      );
    });
  });

  describe('Fall E: ungültige Inputs', () => {
    it('lehnt ungültige MIME und leere/ungültige Bytes ab', async () => {
      setDocumentFileRasterEncodeAdaptersForTests(
        createFakeAdapters({ sourceWidth: 1, sourceHeight: 1 }),
      );

      await expect(
        encodeDocumentFileRasterToJpeg({
          bytes: new Uint8Array([1]),
          sourceMimeType: 'application/pdf',
        }),
      ).rejects.toThrow(TypeError);

      await expect(
        encodeDocumentFileRasterToJpeg({
          bytes: new Uint8Array([1]),
          sourceMimeType: 'image/heic',
        }),
      ).rejects.toThrow(TypeError);

      await expect(
        encodeDocumentFileRasterToJpeg({
          bytes: new Uint8Array(0),
          sourceMimeType: 'image/jpeg',
        }),
      ).rejects.toThrow(TypeError);

      await expect(
        encodeDocumentFileRasterToJpeg({
          bytes: null as unknown as Uint8Array,
          sourceMimeType: 'image/jpeg',
        }),
      ).rejects.toThrow(TypeError);

      await expect(
        encodeDocumentFileRasterToJpeg(null as unknown as { bytes: Uint8Array; sourceMimeType: string }),
      ).rejects.toThrow(TypeError);
    });
  });

  describe('Fall F: Immutability und Determinismus', () => {
    it('lässt Eingabe-Bytes unverändert', async () => {
      const bytes = new Uint8Array([10, 20, 30, 40]);
      const before = Array.from(bytes);
      setDocumentFileRasterEncodeAdaptersForTests({
        async decodeRaster(decodeBytes) {
          decodeBytes[0] = 99;
          return { width: 8, height: 8 };
        },
        async encodeJpeg() {
          return new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
        },
      });

      await encodeDocumentFileRasterToJpeg({
        bytes,
        sourceMimeType: 'image/jpeg',
      });

      expect(Array.from(bytes)).toEqual(before);
    });

    it('ist mit Fakes deterministisch; Result ist eingefroren', async () => {
      const output = new Uint8Array([0xff, 0xd8, 0x00, 0xd9]);
      setDocumentFileRasterEncodeAdaptersForTests(
        createFakeAdapters({
          sourceWidth: 16,
          sourceHeight: 12,
          outputBytes: output,
        }),
      );

      const input = {
        bytes: new Uint8Array([7, 7, 7]),
        sourceMimeType: 'image/png',
      };
      const a = await encodeDocumentFileRasterToJpeg(input);
      const b = await encodeDocumentFileRasterToJpeg(input);

      expect(a).toEqual(b);
      expect(Object.isFrozen(a)).toBe(true);
      expect(a.mimeType).toBe('image/jpeg');
      expect(Array.from(a.bytes)).toEqual(Array.from(output));
      expect(JSON.stringify({ ...a, bytes: undefined })).not.toMatch(
        /fileRef|contentHash|indexeddb|write_pdf|capability/,
      );
    });
  });

  describe('Fall G: keine Capability-/Persistenz-Seiteneffekte', () => {
    it('API beansprucht keine supported Capabilities und kein WebP-Output', async () => {
      setDocumentFileRasterEncodeAdaptersForTests(
        createFakeAdapters({ sourceWidth: 4, sourceHeight: 4 }),
      );

      const result = await encodeDocumentFileRasterToJpeg({
        bytes: new Uint8Array([1, 1]),
        sourceMimeType: 'image/webp',
      });

      expect(result.mimeType).toBe('image/jpeg');
      expect(result.mimeType).not.toBe('image/webp');
      expect(result).not.toHaveProperty('requiredCapabilities');
      expect(result).not.toHaveProperty('fileRefId');
      expect(encodeDocumentFileRasterToJpeg).toHaveLength(1);
    });
  });
});
