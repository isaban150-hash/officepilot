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
import { orchestrateRasterThumbnailEncodeAfterImport } from './services/documentFileRasterThumbnailEncodeOrchestrationService';
import { setDocumentFileRasterEncodeAdaptersForTests } from './services/documentFileRasterEncodeService';
import { countActiveReferencesToFileRef } from './services/documentFileReferenceService';
import { getDocumentById, hydrateDocumentStore, importInboxDocument } from './services/documentService';
import {
  getDocumentFileRefById,
  getDocumentFileRefStoreSnapshot,
  getOriginalDocumentFileBytes,
  resetDocumentFileStoreForTests,
  storeDocumentFileFromCachedPayload,
} from './services/documentFileStoreService';
import { hydrateInboxStore } from './services/inboxService';
import { withNewEntitySync } from './services/sync/syncMetaService';
import { createAuftragInboxItem } from './test/fixtures';
import { resetTestStores } from './test/resetStores';
import {
  RASTER_THUMBNAIL_ENCODE_JPEG_QUALITY,
  RASTER_THUMBNAIL_ENCODE_MAX_EDGE_PX,
} from './types/documentFileRasterEncode';
import type { DocumentFileTransformPlan } from './types/documentFileTransformPlan';
import type { CompanyDocument } from './types/models';

const JPEG_BYTES_A = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x41]);
const JPEG_BYTES_B = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x42]);
const JPEG_BYTES_THUMB = new Uint8Array([0xff, 0xd8, 0xff, 0xd9, 0xaa, 0xbb]);

const DOC_A = 'doc-raster-thumbnail-exec-a';

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
  expect(plan!.intents.some((entry) => entry.intent === 'create_thumbnail')).toBe(true);
  return plan!;
}

function sampleDocument(id: string, fileRefId: string): CompanyDocument {
  return withNewEntitySync(
    {
      id,
      title: `Document ${id}`,
      category: 'vertrag',
      issuer: 'Test',
      recognizedText: '',
      issueDate: null,
      validUntil: null,
      digitalFolder: { id: 'vertraege', name: 'Verträge', path: '/vertraege' },
      paperFolder: { folderId: 'vertraege', register: 'A', label: 'Verträge' },
      tags: [],
      linkedCompany: 'Test GmbH',
      linkedVorgang: null,
      archived: false,
      createdAt: '2026-07-19T22:00:00.000Z',
      fileRefId,
    },
    'document',
  );
}

function installEncodeFake(
  outputBytes: Uint8Array = JPEG_BYTES_THUMB,
  onEncode?: (call: { quality: number; targetWidth: number; targetHeight: number }) => void,
): void {
  setDocumentFileRasterEncodeAdaptersForTests({
    async decodeRaster() {
      return { width: 1920, height: 1080 };
    },
    async encodeJpeg(_source, targetWidth, targetHeight, quality) {
      onEncode?.({ quality, targetWidth, targetHeight });
      return outputBytes.slice();
    },
  });
}

async function storeCommittedJpeg(bytes: Uint8Array, fileName: string) {
  return storeDocumentFileFromCachedPayload(
    {
      fileName,
      mimeType: 'image/jpeg',
      fileSize: bytes.byteLength,
      bytes,
    },
    { lifecycleIntent: 'committed' },
  );
}

async function prepareDocumentWithSource(bytes: Uint8Array, fileName: string) {
  const source = await storeCommittedJpeg(bytes, fileName);
  hydrateDocumentStore([sampleDocument(DOC_A, source.fileRef.id)]);
  return source;
}

afterEach(() => {
  vi.restoreAllMocks();
  setDocumentFileRasterEncodeAdaptersForTests(null);
  resetTestStores();
  resetDocumentFileStoreForTests();
  resetDocumentFileRepresentationBindingStoreForTests();
});

describe('STORAGE-RASTER-THUMBNAIL-EXECUTOR-01', () => {
  describe('Fall A: erfolgreicher Thumbnail-Pfad', () => {
    it('erzeugt Thumbnail-FileRef/Binding mit Thumbnail-Defaults; Original bleibt X', async () => {
      let encodeCall: { quality: number; targetWidth: number; targetHeight: number } | undefined;
      installEncodeFake(JPEG_BYTES_THUMB, (call) => {
        encodeCall = call;
      });
      const source = await prepareDocumentWithSource(JPEG_BYTES_A, 'photo-source.jpg');

      const orch = await orchestrateRasterThumbnailEncodeAfterImport({
        documentId: DOC_A,
        transformPlan: businessTransformPlan(),
      });

      expect(orch.kind).toBe('persisted');
      if (orch.kind !== 'persisted') return;
      expect(orch.createdThumbnailFileRef).toBe(true);
      expect(orch.thumbnailFileRefId).not.toBe(source.fileRef.id);

      expect(encodeCall?.quality).toBe(RASTER_THUMBNAIL_ENCODE_JPEG_QUALITY);
      expect(encodeCall?.quality).toBe(0.72);
      expect(Math.max(encodeCall?.targetWidth ?? 0, encodeCall?.targetHeight ?? 0)).toBe(
        RASTER_THUMBNAIL_ENCODE_MAX_EDGE_PX,
      );
      expect(encodeCall?.targetWidth).toBe(384);
      expect(encodeCall?.targetHeight).toBe(216);

      expect(getDocumentById(DOC_A)?.fileRefId).toBe(source.fileRef.id);

      const thumbRef = getDocumentFileRefById(orch.thumbnailFileRefId);
      expect(thumbRef?.lifecycleStatus).toBe('committed');
      expect(thumbRef?.mimeType).toBe('image/jpeg');

      const thumbBytes = await getOriginalDocumentFileBytes(thumbRef!);
      expect(Array.from(thumbBytes ?? [])).toEqual(Array.from(JPEG_BYTES_THUMB));

      expect(getDocumentFileRepresentationBindingStoreSnapshot()).toEqual([
        {
          documentId: DOC_A,
          kind: 'thumbnail',
          fileRefId: orch.thumbnailFileRefId,
        },
      ]);
      expect(
        getDocumentFileRepresentationBindingStoreSnapshot().some(
          (binding) => binding.kind === 'preview',
        ),
      ).toBe(false);

      expect(countActiveReferencesToFileRef(source.fileRef.id)).toBe(1);
      expect(countActiveReferencesToFileRef(orch.thumbnailFileRefId)).toBe(1);
    });
  });

  describe('Fall B: Dedupe', () => {
    it('Dedupe auf bestehende FileRef nutzt vorhandene FileRef', async () => {
      installEncodeFake(JPEG_BYTES_B);
      const source = await prepareDocumentWithSource(JPEG_BYTES_A, 'source.jpg');
      const existing = await storeCommittedJpeg(JPEG_BYTES_B, 'existing-thumb.jpg');

      const orch = await orchestrateRasterThumbnailEncodeAfterImport({
        documentId: DOC_A,
        transformPlan: businessTransformPlan(),
      });

      expect(orch).toMatchObject({
        kind: 'persisted',
        thumbnailFileRefId: existing.fileRef.id,
        createdThumbnailFileRef: false,
      });
      expect(getDocumentById(DOC_A)?.fileRefId).toBe(source.fileRef.id);
      expect(getDocumentFileRepresentationBindingStoreSnapshot()).toEqual([
        {
          documentId: DOC_A,
          kind: 'thumbnail',
          fileRefId: existing.fileRef.id,
        },
      ]);
    });
  });

  describe('Fall C: Conflict ohne Replace', () => {
    it('bestehendes thumbnail→Y blockiert neues Binding; neue FileRef wird freigegeben', async () => {
      installEncodeFake(JPEG_BYTES_THUMB);
      const source = await prepareDocumentWithSource(JPEG_BYTES_A, 'conflict-source.jpg');
      const existingThumb = await storeCommittedJpeg(JPEG_BYTES_B, 'existing-thumb.jpg');
      hydrateDocumentFileRepresentationBindingStore([
        createDocumentFileRepresentationBinding({
          documentId: DOC_A,
          kind: 'thumbnail',
          fileRefId: existingThumb.fileRef.id,
        }),
      ]);

      const refsBefore = new Set(getDocumentFileRefStoreSnapshot().map((ref) => ref.id));
      const orch = await orchestrateRasterThumbnailEncodeAfterImport({
        documentId: DOC_A,
        transformPlan: businessTransformPlan(),
      });

      expect(orch).toEqual({ kind: 'conflict' });
      expect(getDocumentFileRepresentationBindingStoreSnapshot()).toEqual([
        {
          documentId: DOC_A,
          kind: 'thumbnail',
          fileRefId: existingThumb.fileRef.id,
        },
      ]);
      expect(getDocumentById(DOC_A)?.fileRefId).toBe(source.fileRef.id);

      await vi.waitFor(() => {
        const current = getDocumentFileRefStoreSnapshot().map((ref) => ref.id);
        expect(current.sort()).toEqual([...refsBefore].sort());
      });
    });
  });

  describe('Fall D: Rollback', () => {
    it('Encode-Fehler → kein Binding, Original unverändert', async () => {
      const source = await prepareDocumentWithSource(JPEG_BYTES_A, 'encode-fail.jpg');
      setDocumentFileRasterEncodeAdaptersForTests({
        async decodeRaster() {
          throw Object.freeze({ code: 'decode_failed', message: 'decode boom' });
        },
        async encodeJpeg() {
          return JPEG_BYTES_THUMB.slice();
        },
      });
      vi.spyOn(console, 'error').mockImplementation(() => undefined);

      const orch = await orchestrateRasterThumbnailEncodeAfterImport({
        documentId: DOC_A,
        transformPlan: businessTransformPlan(),
      });

      expect(orch.kind).toBe('error');
      expect(getDocumentFileRepresentationBindingStoreSnapshot()).toEqual([]);
      expect(getDocumentById(DOC_A)?.fileRefId).toBe(source.fileRef.id);
    });

    it('persistAll-Fehler rollt Binding zurück und entfernt neue FileRef', async () => {
      installEncodeFake(JPEG_BYTES_THUMB);
      const source = await prepareDocumentWithSource(JPEG_BYTES_A, 'persist-fail.jpg');
      const refsBefore = new Set(getDocumentFileRefStoreSnapshot().map((ref) => ref.id));

      vi.spyOn(persistenceService, 'persistAll').mockImplementation(() => {
        throw new Error('persist_failed');
      });
      vi.spyOn(console, 'error').mockImplementation(() => undefined);

      const orch = await orchestrateRasterThumbnailEncodeAfterImport({
        documentId: DOC_A,
        transformPlan: businessTransformPlan(),
      });

      expect(orch.kind).toBe('error');
      expect(getDocumentFileRepresentationBindingStoreSnapshot()).toEqual([]);
      expect(getDocumentById(DOC_A)?.fileRefId).toBe(source.fileRef.id);

      await vi.waitFor(() => {
        const current = getDocumentFileRefStoreSnapshot().map((ref) => ref.id);
        expect(current.every((id) => refsBefore.has(id))).toBe(true);
      });
    });

    it('Store-Fehler → kein Binding; Import bleibt erfolgreich', async () => {
      setDocumentFileRasterEncodeAdaptersForTests({
        async decodeRaster() {
          throw Object.freeze({ code: 'decode_failed', message: 'decode boom' });
        },
        async encodeJpeg() {
          return JPEG_BYTES_THUMB.slice();
        },
      });
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

      const source = await storeCommittedJpeg(JPEG_BYTES_A, 'import-thumb-fail.jpg');
      const item = createAuftragInboxItem({
        id: 'inbox-raster-thumb-fail',
        fileRefId: source.fileRef.id,
        sourceFileHash: source.fileRef.contentHash,
      });
      hydrateInboxStore([item]);

      const imported = importInboxDocument(item, 'Test GmbH', {
        transformPlan: businessTransformPlan(),
      });
      expect(imported.success).toBe(true);
      if (!imported.success) return;

      const drained = await orchestrateRasterThumbnailEncodeAfterImport({
        documentId: imported.document.id,
        transformPlan: businessTransformPlan(),
      });
      expect(drained.kind).toBe('error');
      expect(
        getDocumentFileRepresentationBindingStoreSnapshot().every(
          (binding) => binding.kind !== 'thumbnail',
        ),
      ).toBe(true);
      expect(getDocumentById(imported.document.id)?.fileRefId).toBe(source.fileRef.id);
      expect(errorSpy).toHaveBeenCalled();
    });
  });

  describe('Fall E: PDF noop / Refcount', () => {
    it('PDF-Source → encode_plan_unresolved', async () => {
      const pdf = await storeDocumentFileFromCachedPayload(
        {
          fileName: 'doc.pdf',
          mimeType: 'application/pdf',
          fileSize: 8,
          bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]),
        },
        { lifecycleIntent: 'committed' },
      );
      hydrateDocumentStore([sampleDocument(DOC_A, pdf.fileRef.id)]);
      installEncodeFake(JPEG_BYTES_THUMB);

      const orch = await orchestrateRasterThumbnailEncodeAfterImport({
        documentId: DOC_A,
        transformPlan: businessTransformPlan(),
      });
      expect(orch).toEqual({ kind: 'noop', reason: 'encode_plan_unresolved' });
      expect(getDocumentFileRepresentationBindingStoreSnapshot()).toEqual([]);
    });

    it('Refcount schützt Thumbnail-FileRef', async () => {
      installEncodeFake(JPEG_BYTES_THUMB);
      const source = await prepareDocumentWithSource(JPEG_BYTES_A, 'refcount.jpg');

      const orch = await orchestrateRasterThumbnailEncodeAfterImport({
        documentId: DOC_A,
        transformPlan: businessTransformPlan(),
      });
      expect(orch.kind).toBe('persisted');
      if (orch.kind !== 'persisted') return;

      expect(countActiveReferencesToFileRef(orch.thumbnailFileRefId)).toBe(1);
      expect(getDocumentById(DOC_A)?.fileRefId).toBe(source.fileRef.id);
    });
  });
});
