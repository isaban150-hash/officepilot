import { afterEach, describe, expect, it, vi } from 'vitest';
import * as persistenceService from './services/persistenceService';
import { buildDocumentFileRepresentationPlan } from './services/documentFileRepresentationPlanService';
import { buildDocumentFileTransformPlan } from './services/documentFileTransformPlanService';
import { createDocumentFileRepresentationBinding } from './services/documentFileRepresentationBindingService';
import {
  getDocumentFileRepresentationBindingStoreSnapshot,
  hydrateDocumentFileRepresentationBindingStore,
  resetDocumentFileRepresentationBindingStoreForTests,
} from './services/documentFileRepresentationBindingStoreService';
import {
  removeDocumentFileRepresentationBindingIfExactMatch,
  rollbackOwnedDerivedRepresentationCreation,
} from './services/documentFileRepresentationDerivedBindingRollbackService';
import { orchestrateRasterArchiveEncodeAfterImport } from './services/documentFileRasterArchiveEncodeOrchestrationService';
import { setDocumentFileRasterEncodeAdaptersForTests } from './services/documentFileRasterEncodeService';
import { hydrateDocumentStore } from './services/documentService';
import {
  getDocumentFileRefStoreSnapshot,
  resetDocumentFileStoreForTests,
  storeDocumentFileFromCachedPayload,
} from './services/documentFileStoreService';
import { countActiveReferencesToFileRef } from './services/documentFileReferenceService';
import { withNewEntitySync } from './services/sync/syncMetaService';
import { resetTestStores } from './test/resetStores';
import type { DocumentFileTransformPlan } from './types/documentFileTransformPlan';
import type { CompanyDocument } from './types/models';

const DOC_A = 'doc-rollback-isolation-a';
const DOC_B = 'doc-rollback-isolation-b';
const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a]);
const ENCODED_JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4b]);
const CONFLICT_JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4c]);
const OTHER_ARCHIVE_JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4d]);

function businessTransformPlan(): DocumentFileTransformPlan {
  const representationPlan = buildDocumentFileRepresentationPlan({
    policyId: 'business_document',
    decision: 'save_permanently',
  });
  expect(representationPlan).not.toBeNull();
  const plan = buildDocumentFileTransformPlan({
    representationPlan: representationPlan!,
    mediaProfile: 'raster_image',
  });
  expect(plan).not.toBeNull();
  return plan!;
}

function sampleDocument(id: string, fileRefId: string): CompanyDocument {
  return withNewEntitySync(
    {
      id,
      title: `Document ${id}`,
      category: 'beleg',
      issuer: 'Test',
      recognizedText: '',
      issueDate: null,
      validUntil: null,
      digitalFolder: { id: 'belege', name: 'Belege', path: '/belege' },
      paperFolder: { folderId: 'belege', register: 'A', label: 'Belege' },
      tags: [],
      linkedCompany: 'Test GmbH',
      linkedVorgang: null,
      archived: false,
      createdAt: '2026-07-20T00:00:00.000Z',
      fileRefId,
    },
    'document',
  );
}

function installEncodeFake(outputBytes: Uint8Array): void {
  setDocumentFileRasterEncodeAdaptersForTests({
    async decodeRaster() {
      return { width: 32, height: 24 };
    },
    async encodeJpeg() {
      return outputBytes.slice();
    },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  setDocumentFileRasterEncodeAdaptersForTests(null);
  resetTestStores();
  resetDocumentFileStoreForTests();
  resetDocumentFileRepresentationBindingStoreForTests();
});

describe('STORAGE-DERIVATIVE-ROLLBACK-ISOLATION-01', () => {
  describe('Compare-and-remove', () => {
    it('entfernt nur exaktes Binding; Sibling-Kinds und andere Dokumente bleiben', () => {
      const own = createDocumentFileRepresentationBinding({
        documentId: DOC_A,
        kind: 'archive',
        fileRefId: 'file-a-archive',
      });
      const sibling = createDocumentFileRepresentationBinding({
        documentId: DOC_A,
        kind: 'thumbnail',
        fileRefId: 'file-a-thumb',
      });
      const otherDoc = createDocumentFileRepresentationBinding({
        documentId: DOC_B,
        kind: 'archive',
        fileRefId: 'file-b-archive',
      });
      hydrateDocumentFileRepresentationBindingStore([own, sibling, otherDoc]);

      expect(
        removeDocumentFileRepresentationBindingIfExactMatch({
          documentId: DOC_A,
          kind: 'archive',
          fileRefId: 'file-a-archive',
        }),
      ).toBe(true);

      expect(getDocumentFileRepresentationBindingStoreSnapshot()).toEqual([sibling, otherDoc]);
    });

    it('entfernt abweichendes Binding nicht (andere fileRefId)', () => {
      const current = createDocumentFileRepresentationBinding({
        documentId: DOC_A,
        kind: 'preview',
        fileRefId: 'file-current',
      });
      hydrateDocumentFileRepresentationBindingStore([current]);

      expect(
        removeDocumentFileRepresentationBindingIfExactMatch({
          documentId: DOC_A,
          kind: 'preview',
          fileRefId: 'file-stale',
        }),
      ).toBe(false);
      expect(getDocumentFileRepresentationBindingStoreSnapshot()).toEqual([current]);
    });
  });

  describe('Orchestrator-Fehlerpfad', () => {
    it('persistAll-Fehler entfernt nur eigenes Binding; anderes Dokument und Sibling bleiben; FileRef freigegeben; Undo persistiert', async () => {
      installEncodeFake(ENCODED_JPEG);

      const source = await storeDocumentFileFromCachedPayload(
        {
          fileName: 'a.jpg',
          mimeType: 'image/jpeg',
          fileSize: JPEG_BYTES.byteLength,
          bytes: JPEG_BYTES,
        },
        { lifecycleIntent: 'committed' },
      );
      hydrateDocumentStore([sampleDocument(DOC_A, source.fileRef.id)]);

      const otherDocBinding = createDocumentFileRepresentationBinding({
        documentId: DOC_B,
        kind: 'archive',
        fileRefId: 'file-other-doc',
      });
      const siblingThumb = createDocumentFileRepresentationBinding({
        documentId: DOC_A,
        kind: 'thumbnail',
        fileRefId: 'file-sibling-thumb',
      });
      hydrateDocumentFileRepresentationBindingStore([otherDocBinding, siblingThumb]);

      const refsBefore = new Set(getDocumentFileRefStoreSnapshot().map((ref) => ref.id));
      let persistCalls = 0;
      vi.spyOn(persistenceService, 'persistAll').mockImplementation(() => {
        persistCalls += 1;
        if (persistCalls === 1) {
          throw new Error('persist_failed');
        }
        return { success: true };
      });
      vi.spyOn(console, 'error').mockImplementation(() => undefined);

      const orch = await orchestrateRasterArchiveEncodeAfterImport({
        documentId: DOC_A,
        transformPlan: businessTransformPlan(),
      });

      expect(orch.kind).toBe('error');
      expect(getDocumentFileRepresentationBindingStoreSnapshot()).toEqual([
        otherDocBinding,
        siblingThumb,
      ]);
      // create attempt + scoped undo persist
      expect(persistCalls).toBeGreaterThanOrEqual(2);

      await vi.waitFor(() => {
        const current = getDocumentFileRefStoreSnapshot().map((ref) => ref.id);
        expect(current.every((id) => refsBefore.has(id))).toBe(true);
      });
    });

    it('deduplizierte FileRef wird bei Conflict freigegeben nur wenn neu erzeugt; unchanged behält Binding', async () => {
      installEncodeFake(ENCODED_JPEG);

      const source = await storeDocumentFileFromCachedPayload(
        {
          fileName: 'dedupe-src.jpg',
          mimeType: 'image/jpeg',
          fileSize: JPEG_BYTES.byteLength,
          bytes: JPEG_BYTES,
        },
        { lifecycleIntent: 'committed' },
      );
      const existingArchive = await storeDocumentFileFromCachedPayload(
        {
          fileName: 'existing-archive.jpg',
          mimeType: 'image/jpeg',
          fileSize: ENCODED_JPEG.byteLength,
          bytes: ENCODED_JPEG,
        },
        { lifecycleIntent: 'committed' },
      );
      hydrateDocumentStore([sampleDocument(DOC_A, source.fileRef.id)]);
      hydrateDocumentFileRepresentationBindingStore([
        createDocumentFileRepresentationBinding({
          documentId: DOC_A,
          kind: 'archive',
          fileRefId: existingArchive.fileRef.id,
        }),
      ]);

      const orch = await orchestrateRasterArchiveEncodeAfterImport({
        documentId: DOC_A,
        transformPlan: businessTransformPlan(),
      });

      // Same encoded bytes → dedupe to existing archive FileRef → unchanged
      expect(orch).toMatchObject({
        kind: 'persisted',
        registration: 'unchanged',
        archiveFileRefId: existingArchive.fileRef.id,
        createdArchiveFileRef: false,
      });
      expect(getDocumentFileRepresentationBindingStoreSnapshot()).toEqual([
        {
          documentId: DOC_A,
          kind: 'archive',
          fileRefId: existingArchive.fileRef.id,
        },
      ]);
      expect(countActiveReferencesToFileRef(existingArchive.fileRef.id)).toBe(1);
    });

    it('conflict gibt nur neu erzeugte FileRef frei und ändert Store nicht', async () => {
      installEncodeFake(CONFLICT_JPEG);

      const source = await storeDocumentFileFromCachedPayload(
        {
          fileName: 'conflict.jpg',
          mimeType: 'image/jpeg',
          fileSize: JPEG_BYTES.byteLength,
          bytes: JPEG_BYTES,
        },
        { lifecycleIntent: 'committed' },
      );
      const existingDifferent = await storeDocumentFileFromCachedPayload(
        {
          fileName: 'other-archive.jpg',
          mimeType: 'image/jpeg',
          fileSize: OTHER_ARCHIVE_JPEG.byteLength,
          bytes: OTHER_ARCHIVE_JPEG,
        },
        { lifecycleIntent: 'committed' },
      );
      hydrateDocumentStore([sampleDocument(DOC_A, source.fileRef.id)]);
      const existingBinding = createDocumentFileRepresentationBinding({
        documentId: DOC_A,
        kind: 'archive',
        fileRefId: existingDifferent.fileRef.id,
      });
      hydrateDocumentFileRepresentationBindingStore([existingBinding]);

      const refsBefore = new Set(getDocumentFileRefStoreSnapshot().map((ref) => ref.id));
      const orch = await orchestrateRasterArchiveEncodeAfterImport({
        documentId: DOC_A,
        transformPlan: businessTransformPlan(),
      });

      expect(orch).toEqual({ kind: 'conflict' });
      expect(getDocumentFileRepresentationBindingStoreSnapshot()).toEqual([existingBinding]);

      await vi.waitFor(() => {
        const current = getDocumentFileRefStoreSnapshot().map((ref) => ref.id);
        expect(current.sort()).toEqual([...refsBefore].sort());
      });
    });
  });

  describe('Rollback-Helfer', () => {
    it('rollbackOwnedDerivedRepresentationCreation persistiert gezieltes Undo', async () => {
      const binding = createDocumentFileRepresentationBinding({
        documentId: DOC_A,
        kind: 'preview',
        fileRefId: 'file-preview',
      });
      hydrateDocumentFileRepresentationBindingStore([binding]);
      const persistSpy = vi
        .spyOn(persistenceService, 'persistAll')
        .mockReturnValue({ success: true });

      await rollbackOwnedDerivedRepresentationCreation({
        createdBinding: {
          documentId: DOC_A,
          kind: 'preview',
          fileRefId: 'file-preview',
        },
        createdFileRefId: null,
        reportError: () => undefined,
      });

      expect(getDocumentFileRepresentationBindingStoreSnapshot()).toEqual([]);
      expect(persistSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('Kein globales Rollback in Derived-Orchs', () => {
    it('keine Derived-Orchestration verwendet bindingsBefore-Store-Restore', async () => {
      const { readFileSync } = await import('node:fs');
      const { resolve } = await import('node:path');
      const files = [
        'documentFileRasterArchiveEncodeOrchestrationService.ts',
        'documentFileImageToPdfArchiveEncodeOrchestrationService.ts',
        'documentFilePdfMetadataStripOrchestrationService.ts',
        'documentFileRasterThumbnailEncodeOrchestrationService.ts',
        'documentFileRasterPreviewEncodeOrchestrationService.ts',
        'documentFilePdfThumbnailEncodeOrchestrationService.ts',
        'documentFilePdfPreviewEncodeOrchestrationService.ts',
      ];
      for (const file of files) {
        const source = readFileSync(resolve(__dirname, 'services', file), 'utf8');
        expect(source).not.toMatch(/bindingsBefore/);
        expect(source).toMatch(/rollbackOwnedDerivedRepresentationCreation/);
      }
    });
  });
});
