import { describe, expect, it } from 'vitest';
import {
  DOCUMENT_FILE_TRANSFORM_CAPABILITY_IDS,
  DOCUMENT_FILE_TRANSFORM_CAPABILITY_STATUSES,
  type DocumentFileTransformCapabilitySnapshot,
} from './types/documentFileTransformCapability';
import {
  PROJECT_STATIC_DOCUMENT_FILE_TRANSFORM_CAPABILITY_SNAPSHOT,
  createProjectStaticDocumentFileTransformCapabilityProvider,
  createStaticDocumentFileTransformCapabilityProvider,
} from './services/documentFileTransformCapabilityProvider';

describe('STORAGE-TRANSFORM-CAPABILITY-PROVIDER-01', () => {
  describe('Fall A–B: projektstatischer Baseline-Snapshot', () => {
    it('beschreibt den aktuellen OfficePilot-Build ohne Browser-Feature-Erkennung', async () => {
      expect(PROJECT_STATIC_DOCUMENT_FILE_TRANSFORM_CAPABILITY_SNAPSHOT).toEqual({
        load_pdf: 'supported',
        render_pdf_page: 'supported',
        decode_raster_image: 'supported',
        encode_raster_image: 'supported',
        write_pdf: 'supported',
      });

      expect(PROJECT_STATIC_DOCUMENT_FILE_TRANSFORM_CAPABILITY_SNAPSHOT.write_pdf).toBe(
        'supported',
      );

      const provider = createProjectStaticDocumentFileTransformCapabilityProvider();
      const snapshot = await provider.getSnapshot();
      expect(snapshot).toEqual(PROJECT_STATIC_DOCUMENT_FILE_TRANSFORM_CAPABILITY_SNAPSHOT);
      expect(Object.keys(snapshot).sort()).toEqual(
        [...DOCUMENT_FILE_TRANSFORM_CAPABILITY_IDS].sort(),
      );
      for (const id of DOCUMENT_FILE_TRANSFORM_CAPABILITY_IDS) {
        expect(DOCUMENT_FILE_TRANSFORM_CAPABILITY_STATUSES).toContain(snapshot[id]);
      }
    });
  });

  describe('Fall C: eigene Snapshot-Injection', () => {
    it('übernimmt einen vollständigen injizierten Snapshot unverändert', async () => {
      const injected: DocumentFileTransformCapabilitySnapshot = {
        load_pdf: 'supported',
        render_pdf_page: 'supported',
        decode_raster_image: 'supported',
        encode_raster_image: 'unknown',
        write_pdf: 'unsupported',
      };
      const provider = createStaticDocumentFileTransformCapabilityProvider(injected);
      await expect(provider.getSnapshot()).resolves.toEqual(injected);
    });
  });

  describe('Fall D–F: Validierung', () => {
    it('lehnt unvollständige Snapshots ab und ergänzt keine Defaults', () => {
      const incomplete = {
        load_pdf: 'unknown',
        render_pdf_page: 'unknown',
        decode_raster_image: 'unknown',
        encode_raster_image: 'unsupported',
      };
      expect(() =>
        createStaticDocumentFileTransformCapabilityProvider(
          incomplete as unknown as DocumentFileTransformCapabilitySnapshot,
        ),
      ).toThrow(TypeError);
    });

    it('lehnt ungültige Statuswerte ab', () => {
      const invalidStatus = {
        load_pdf: 'available',
        render_pdf_page: 'unknown',
        decode_raster_image: 'unknown',
        encode_raster_image: 'unsupported',
        write_pdf: 'unsupported',
      };
      expect(() =>
        createStaticDocumentFileTransformCapabilityProvider(
          invalidStatus as unknown as DocumentFileTransformCapabilitySnapshot,
        ),
      ).toThrow(TypeError);
    });

    it('lehnt unbekannte Capability-IDs ab', () => {
      const withExtra = {
        load_pdf: 'unknown',
        render_pdf_page: 'unknown',
        decode_raster_image: 'unknown',
        encode_raster_image: 'unsupported',
        write_pdf: 'unsupported',
        encode_webp: 'supported',
      };
      expect(() =>
        createStaticDocumentFileTransformCapabilityProvider(
          withExtra as unknown as DocumentFileTransformCapabilitySnapshot,
        ),
      ).toThrow(TypeError);
    });
  });

  describe('Fall G–I: Immutability und Determinismus', () => {
    it('kopiert die Eingabe defensiv', async () => {
      const input: DocumentFileTransformCapabilitySnapshot = {
        load_pdf: 'unknown',
        render_pdf_page: 'unknown',
        decode_raster_image: 'unknown',
        encode_raster_image: 'unsupported',
        write_pdf: 'unsupported',
      };
      const provider = createStaticDocumentFileTransformCapabilityProvider(input);
      (input as { load_pdf: string }).load_pdf = 'supported';
      await expect(provider.getSnapshot()).resolves.toMatchObject({ load_pdf: 'unknown' });
    });

    it('schützt den zurückgegebenen Snapshot vor Mutation', async () => {
      const provider = createProjectStaticDocumentFileTransformCapabilityProvider();
      const first = await provider.getSnapshot();
      expect(Object.isFrozen(first)).toBe(true);
      try {
        (first as { load_pdf: string }).load_pdf = 'supported';
      } catch {
        /* freeze may throw in strict mode */
      }
      const second = await provider.getSnapshot();
      expect(second.load_pdf).toBe('supported');
      expect(first).toEqual(second);
    });

    it('liefert deterministische Snapshots', async () => {
      const provider = createProjectStaticDocumentFileTransformCapabilityProvider();
      const a = await provider.getSnapshot();
      const b = await provider.getSnapshot();
      expect(a).toEqual(b);
    });
  });

  describe('Fall J: asynchrone Schnittstelle', () => {
    it('getSnapshot liefert ein Promise', async () => {
      const provider = createProjectStaticDocumentFileTransformCapabilityProvider();
      const pending = provider.getSnapshot();
      expect(pending).toBeInstanceOf(Promise);
      await expect(pending).resolves.toBeDefined();
    });
  });
});
