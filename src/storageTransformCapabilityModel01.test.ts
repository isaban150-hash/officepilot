import { describe, expect, it } from 'vitest';
import {
  DOCUMENT_FILE_TRANSFORM_CAPABILITY_IDS,
  DOCUMENT_FILE_TRANSFORM_CAPABILITY_STATUSES,
  type DocumentFileTransformCapabilitySnapshot,
  type DocumentFileTransformSourceDescriptor,
} from './types/documentFileTransformCapability';

describe('STORAGE-TRANSFORM-CAPABILITY-MODEL-01', () => {
  describe('Fall A: Capability-Katalog', () => {
    it('definiert genau die fünf stabilen Capability-IDs in Reihenfolge', () => {
      expect([...DOCUMENT_FILE_TRANSFORM_CAPABILITY_IDS]).toEqual([
        'load_pdf',
        'render_pdf_page',
        'decode_raster_image',
        'encode_raster_image',
        'write_pdf',
      ]);
    });
  });

  describe('Fall B: Status-Katalog', () => {
    it('definiert exakt supported, unsupported, unknown', () => {
      expect([...DOCUMENT_FILE_TRANSFORM_CAPABILITY_STATUSES]).toEqual([
        'supported',
        'unsupported',
        'unknown',
      ]);
    });
  });

  describe('Fall C–D: vollständiger Snapshot', () => {
    it('bildet jede Capability mit gültigem Status ab; unknown und unsupported sind erlaubt', () => {
      const snapshot: DocumentFileTransformCapabilitySnapshot = {
        load_pdf: 'supported',
        render_pdf_page: 'supported',
        decode_raster_image: 'unknown',
        encode_raster_image: 'unsupported',
        write_pdf: 'unsupported',
      };

      expect(Object.keys(snapshot).sort()).toEqual(
        [...DOCUMENT_FILE_TRANSFORM_CAPABILITY_IDS].sort(),
      );
      for (const id of DOCUMENT_FILE_TRANSFORM_CAPABILITY_IDS) {
        expect(DOCUMENT_FILE_TRANSFORM_CAPABILITY_STATUSES).toContain(snapshot[id]);
      }
      expect(snapshot.decode_raster_image).toBe('unknown');
      expect(snapshot.encode_raster_image).toBe('unsupported');
      expect(snapshot.write_pdf).toBe('unsupported');
    });

    it('modelliert encode_raster_image und write_pdf auch ohne Executor', () => {
      expect(DOCUMENT_FILE_TRANSFORM_CAPABILITY_IDS).toContain('encode_raster_image');
      expect(DOCUMENT_FILE_TRANSFORM_CAPABILITY_IDS).toContain('write_pdf');
    });
  });

  describe('Fall E: ausgeschlossene IDs', () => {
    it('enthält keine Anzeige-, OCR-, Persistenz- oder Format-Encoder-IDs', () => {
      const excluded = [
        'create_object_url',
        'ocr_image_or_canvas',
        'render_pdf_page_to_canvas',
        'decode_raster_via_browser',
        'preserve_pdf_bytes',
        'encode_jpeg',
        'encode_png',
        'encode_webp',
        'generate_preview',
        'generate_thumbnail',
        'generate_archive',
      ];
      for (const id of excluded) {
        expect(DOCUMENT_FILE_TRANSFORM_CAPABILITY_IDS).not.toContain(id);
      }
    });
  });

  describe('Fall F: Source Descriptor', () => {
    it('trägt nur sourceMimeType ohne Blob oder Object-URL', () => {
      const pdf: DocumentFileTransformSourceDescriptor = {
        sourceMimeType: 'application/pdf',
      };
      const jpeg: DocumentFileTransformSourceDescriptor = {
        sourceMimeType: 'image/jpeg',
      };
      expect(pdf.sourceMimeType).toBe('application/pdf');
      expect(jpeg.sourceMimeType).toBe('image/jpeg');
      expect(Object.keys(pdf)).toEqual(['sourceMimeType']);
      expect(Object.keys(jpeg)).toEqual(['sourceMimeType']);
    });
  });

  describe('Fall G–H: Reinheit des Modells', () => {
    it('nutzt nur Katalog- und Snapshot-Daten ohne Browser-APIs', () => {
      const snapshot: DocumentFileTransformCapabilitySnapshot = {
        load_pdf: 'unknown',
        render_pdf_page: 'unknown',
        decode_raster_image: 'unknown',
        encode_raster_image: 'unknown',
        write_pdf: 'unknown',
      };
      expect(snapshot.load_pdf).toBe('unknown');
      expect(DOCUMENT_FILE_TRANSFORM_CAPABILITY_IDS).toHaveLength(5);
    });

    it('verbindet Capability-Modell nicht mit Policy oder Transform Intents', () => {
      const catalog = DOCUMENT_FILE_TRANSFORM_CAPABILITY_IDS.join(',');
      expect(catalog).not.toContain('create_archive');
      expect(catalog).not.toContain('create_preview');
      expect(catalog).not.toContain('create_thumbnail');
      expect(catalog).not.toContain('policy');
      expect(catalog).not.toContain('disposition');
    });
  });
});

