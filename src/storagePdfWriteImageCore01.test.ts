import { deflateSync } from 'node:zlib';
import { PDFDocument } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import {
  computeImageToPdfDrawDimensions,
  encodeDocumentFileImageToPdf,
} from './services/documentFileImageToPdfWriteService';
import { PROJECT_STATIC_DOCUMENT_FILE_TRANSFORM_CAPABILITY_SNAPSHOT } from './services/documentFileTransformCapabilityProvider';
import {
  IMAGE_TO_PDF_PAGE_HEIGHT_PT,
  IMAGE_TO_PDF_PAGE_WIDTH_PT,
  IMAGE_TO_PDF_SOURCE_MIME_TYPES,
  type DocumentFileImageToPdfWriteError,
} from './types/documentFileImageToPdfWrite';

/** Minimal valid 1×1 JPEG (JFIF). */
const MINIMAL_JPEG_1X1 = Uint8Array.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01,
  0x00, 0x01, 0x00, 0x00, 0xff, 0xdb, 0x00, 0x43, 0x00, 0x08, 0x06, 0x06, 0x07, 0x06, 0x05, 0x08,
  0x07, 0x07, 0x07, 0x09, 0x09, 0x08, 0x0a, 0x0c, 0x14, 0x0d, 0x0c, 0x0b, 0x0b, 0x0c, 0x19, 0x12,
  0x13, 0x0f, 0x14, 0x1d, 0x1a, 0x1f, 0x1e, 0x1d, 0x1a, 0x1c, 0x1c, 0x20, 0x24, 0x2e, 0x27, 0x20,
  0x22, 0x2c, 0x23, 0x1c, 0x1c, 0x28, 0x37, 0x29, 0x2c, 0x30, 0x31, 0x34, 0x34, 0x34, 0x1f, 0x27,
  0x39, 0x3d, 0x38, 0x32, 0x3c, 0x2e, 0x33, 0x34, 0x32, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x01,
  0x00, 0x01, 0x01, 0x01, 0x11, 0x00, 0xff, 0xc4, 0x00, 0x1f, 0x00, 0x00, 0x01, 0x05, 0x01, 0x01,
  0x01, 0x01, 0x01, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x02, 0x03, 0x04,
  0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0xff, 0xc4, 0x00, 0xb5, 0x10, 0x00, 0x02, 0x01, 0x03,
  0x03, 0x02, 0x04, 0x03, 0x05, 0x05, 0x04, 0x04, 0x00, 0x00, 0x01, 0x7d, 0x01, 0x02, 0x03, 0x00,
  0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07, 0x22, 0x71, 0x14, 0x32,
  0x81, 0x91, 0xa1, 0x08, 0x23, 0x42, 0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0, 0x24, 0x33, 0x62, 0x72,
  0x82, 0x09, 0x0a, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x25, 0x26, 0x27, 0x28, 0x29, 0x2a, 0x34, 0x35,
  0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a, 0x53, 0x54, 0x55,
  0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x73, 0x74, 0x75,
  0x76, 0x77, 0x78, 0x79, 0x7a, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89, 0x8a, 0x92, 0x93, 0x94,
  0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2,
  0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9,
  0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe1, 0xe2, 0xe3, 0xe4, 0xe5, 0xe6,
  0xe7, 0xe8, 0xe9, 0xea, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa, 0xff, 0xda,
  0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00, 0x7f, 0x3f, 0xff, 0xd9,
]);

function isWriteError(value: unknown): value is DocumentFileImageToPdfWriteError {
  return (
    value !== null &&
    typeof value === 'object' &&
    'code' in value &&
    ((value as { code: unknown }).code === 'invalid_input' ||
      (value as { code: unknown }).code === 'encode_failed')
  );
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.byteLength; i += 1) {
    crc = CRC_TABLE[(crc ^ bytes[i]!) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new TextEncoder().encode(type);
  const chunk = new Uint8Array(4 + 4 + data.byteLength + 4);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, data.byteLength);
  chunk.set(typeBytes, 4);
  chunk.set(data, 8);
  const crcInput = chunk.subarray(4, 8 + data.byteLength);
  view.setUint32(8 + data.byteLength, crc32(crcInput));
  return chunk;
}

/** Uncompressed RGB PNG of solid color — no canvas dependency. */
function createSolidPngBytes(width: number, height: number): Uint8Array {
  const stride = width * 3 + 1;
  const raw = new Uint8Array(stride * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * stride;
    raw[row] = 0;
    for (let x = 0; x < width; x += 1) {
      const i = row + 1 + x * 3;
      raw[i] = 0x22;
      raw[i + 1] = 0x66;
      raw[i + 2] = 0xaa;
    }
  }

  const ihdr = new Uint8Array(13);
  const ihdrView = new DataView(ihdr.buffer);
  ihdrView.setUint32(0, width);
  ihdrView.setUint32(4, height);
  ihdr[8] = 8;
  ihdr[9] = 2;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const signature = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdrChunk = pngChunk('IHDR', ihdr);
  const idatChunk = pngChunk('IDAT', deflateSync(raw));
  const iendChunk = pngChunk('IEND', new Uint8Array());

  const out = new Uint8Array(
    signature.byteLength + ihdrChunk.byteLength + idatChunk.byteLength + iendChunk.byteLength,
  );
  let offset = 0;
  out.set(signature, offset);
  offset += signature.byteLength;
  out.set(ihdrChunk, offset);
  offset += ihdrChunk.byteLength;
  out.set(idatChunk, offset);
  offset += idatChunk.byteLength;
  out.set(iendChunk, offset);
  return out;
}

describe('STORAGE-PDF-WRITE-IMAGE-CORE-01', () => {
  describe('Fall A: Defaults', () => {
    it('dokumentiert A4-Seite und akzeptierte MIME-Typen', () => {
      expect(IMAGE_TO_PDF_PAGE_WIDTH_PT).toBe(595.28);
      expect(IMAGE_TO_PDF_PAGE_HEIGHT_PT).toBe(841.89);
      expect([...IMAGE_TO_PDF_SOURCE_MIME_TYPES]).toEqual(['image/jpeg', 'image/png']);
      expect(PROJECT_STATIC_DOCUMENT_FILE_TRANSFORM_CAPABILITY_SNAPSHOT.write_pdf).toBe(
        'supported',
      );
    });
  });

  describe('Fall B: Fit-Geometrie ohne Verzerrung/Upscale', () => {
    it('hält Seitenverhältnis und skaliert große Bilder passend herunter', () => {
      const large = computeImageToPdfDrawDimensions(3000, 1500);
      expect(large.width / large.height).toBeCloseTo(2, 5);
      expect(large.width).toBeLessThanOrEqual(IMAGE_TO_PDF_PAGE_WIDTH_PT);
      expect(large.height).toBeLessThanOrEqual(IMAGE_TO_PDF_PAGE_HEIGHT_PT);
      expect(large.width).toBeCloseTo(IMAGE_TO_PDF_PAGE_WIDTH_PT, 5);
      expect(large.height).toBeCloseTo(IMAGE_TO_PDF_PAGE_WIDTH_PT / 2, 5);
    });

    it('vergrößert kleine Bilder nicht', () => {
      const small = computeImageToPdfDrawDimensions(200, 100);
      expect(small.width).toBe(200);
      expect(small.height).toBe(100);
      expect(small.x).toBeCloseTo((IMAGE_TO_PDF_PAGE_WIDTH_PT - 200) / 2, 5);
      expect(small.y).toBeCloseTo((IMAGE_TO_PDF_PAGE_HEIGHT_PT - 100) / 2, 5);
    });
  });

  describe('Fall C: JPEG und PNG → einseitiges PDF', () => {
    it('JPEG → gültiges einseitiges PDF', async () => {
      const jpegBytes = MINIMAL_JPEG_1X1.slice();
      const original = jpegBytes.slice();

      const result = await encodeDocumentFileImageToPdf({
        bytes: jpegBytes,
        sourceMimeType: 'image/jpeg',
      });

      expect(result.mimeType).toBe('application/pdf');
      expect(result.pageCount).toBe(1);
      expect(result.pageWidth).toBe(IMAGE_TO_PDF_PAGE_WIDTH_PT);
      expect(result.pageHeight).toBe(IMAGE_TO_PDF_PAGE_HEIGHT_PT);
      expect(String.fromCharCode(...result.bytes.slice(0, 4))).toBe('%PDF');

      const loaded = await PDFDocument.load(result.bytes);
      expect(loaded.getPageCount()).toBe(1);
      expect(loaded.getTitle()).toBeUndefined();
      expect(loaded.getAuthor()).toBeUndefined();

      expect(Array.from(jpegBytes)).toEqual(Array.from(original));
      expect(result.imageWidth).toBe(1);
      expect(result.imageHeight).toBe(1);
    });

    it('PNG → gültiges einseitiges PDF', async () => {
      const pngBytes = createSolidPngBytes(320, 240);
      const original = pngBytes.slice();

      const result = await encodeDocumentFileImageToPdf({
        bytes: pngBytes,
        sourceMimeType: 'image/png',
      });

      expect(result.mimeType).toBe('application/pdf');
      expect(result.pageCount).toBe(1);
      const loaded = await PDFDocument.load(result.bytes);
      expect(loaded.getPageCount()).toBe(1);
      expect(Array.from(pngBytes)).toEqual(Array.from(original));
      expect(result.imageWidth / result.imageHeight).toBeCloseTo(320 / 240, 5);
    });

    it('große Bilder werden auf die Seite eingepasst; kleine nicht vergrößert', async () => {
      const largeBytes = createSolidPngBytes(2400, 1200);
      const large = await encodeDocumentFileImageToPdf({
        bytes: largeBytes,
        sourceMimeType: 'image/png',
      });
      expect(large.imageWidth).toBeLessThanOrEqual(IMAGE_TO_PDF_PAGE_WIDTH_PT + 0.01);
      expect(large.imageHeight).toBeLessThanOrEqual(IMAGE_TO_PDF_PAGE_HEIGHT_PT + 0.01);
      expect(large.imageWidth / large.imageHeight).toBeCloseTo(2, 5);

      const smallBytes = createSolidPngBytes(180, 90);
      const small = await encodeDocumentFileImageToPdf({
        bytes: smallBytes,
        sourceMimeType: 'image/png',
      });
      expect(small.imageWidth).toBe(180);
      expect(small.imageHeight).toBe(90);
    });
  });

  describe('Fall D: ungültige Inputs', () => {
    it('lehnt ungültige MIME, leere Bytes und WebP ab', async () => {
      const pngBytes = createSolidPngBytes(16, 16);

      await expect(
        encodeDocumentFileImageToPdf({
          bytes: pngBytes,
          sourceMimeType: 'image/webp',
        }),
      ).rejects.toSatisfy(
        (error: unknown) => isWriteError(error) && error.code === 'invalid_input',
      );

      await expect(
        encodeDocumentFileImageToPdf({
          bytes: pngBytes,
          sourceMimeType: 'application/pdf',
        }),
      ).rejects.toSatisfy(
        (error: unknown) => isWriteError(error) && error.code === 'invalid_input',
      );

      await expect(
        encodeDocumentFileImageToPdf({
          bytes: new Uint8Array(),
          sourceMimeType: 'image/jpeg',
        }),
      ).rejects.toSatisfy(
        (error: unknown) => isWriteError(error) && error.code === 'invalid_input',
      );

      await expect(
        encodeDocumentFileImageToPdf({
          bytes: new Uint8Array([1, 2, 3]),
          sourceMimeType: 'image/jpeg',
        }),
      ).rejects.toSatisfy(
        (error: unknown) => isWriteError(error) && error.code === 'encode_failed',
      );
    });
  });

  describe('Fall E: Reinheit', () => {
    it('Result ist eingefroren und ohne Persistenzfelder', async () => {
      const bytes = createSolidPngBytes(40, 30);
      const result = await encodeDocumentFileImageToPdf({
        bytes,
        sourceMimeType: 'image/png',
      });
      expect(Object.isFrozen(result)).toBe(true);
      expect(result).not.toHaveProperty('fileRefId');
      expect(result).not.toHaveProperty('binding');
      expect(result).not.toHaveProperty('executor');
      expect(JSON.stringify(result)).not.toMatch(/write_pdf|FileRef|IndexedDB/);
    });
  });
});
