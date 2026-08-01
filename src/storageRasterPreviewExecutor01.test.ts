import { importInboxDocumentForTests } from './test/confirmFilingDecisionForTests';
import { useDocumentBlobDatabaseReset } from './test/documentBlobTestReset';
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
import { orchestrateRasterPreviewEncodeAfterImport } from './services/documentFileRasterPreviewEncodeOrchestrationService';
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
import {
  RASTER_PREVIEW_ENCODE_JPEG_QUALITY,
  RASTER_PREVIEW_ENCODE_MAX_EDGE_PX,
} from './types/documentFileRasterEncode';
import type { DocumentFileTransformPlan } from './types/documentFileTransformPlan';
import type { CompanyDocument } from './types/models';

const JPEG_BYTES_A = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x41]);
const JPEG_BYTES_B = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x42]);
const JPEG_BYTES_PREVIEW = new Uint8Array([0xff, 0xd8, 0xff, 0xd9, 0xcc, 0xdd]);

const DOC_A = 'doc-raster-preview-exec-a';

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
  expect(plan!.intents.some((entry) => entry.intent === 'create_preview')).toBe(true);
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
      createdAt: '2026-07-19T23:00:00.000Z',
      fileRefId,
    },
    'document',
  );
}

function installEncodeFake(
  outputBytes: Uint8Array = JPEG_BYTES_PREVIEW,
  onEncode?: (call: { quality: number; targetWidth: number; targetHeight: number }) => void,
): void {
  setDocumentFileRasterEncodeAdaptersForTests({
    async decodeRaster() {
      return { width: 2560, height: 1440 };
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

useDocumentBlobDatabaseReset();

afterEach(() => {
  vi.restoreAllMocks();
  setDocumentFileRasterEncodeAdaptersForTests(null);
  resetDocumentFileStoreForTests();
  resetDocumentFileRepresentationBindingStoreForTests();
});

describe('STORAGE-RASTER-PREVIEW-EXECUTOR-01', () => {
  describe('Fall A: erfolgreicher Preview-Pfad', () => {
    it('erzeugt Preview-FileRef/Binding mit Preview-Defaults; Original bleibt X', async () => {
      let encodeCall: { quality: number; targetWidth: number; targetHeight: number } | undefined;
      installEncodeFake(JPEG_BYTES_PREVIEW, (call) => {
        encodeCall = call;
      });
      const source = await prepareDocumentWithSource(JPEG_BYTES_A, 'photo-source.jpg');

      const orch = await orchestrateRasterPreviewEncodeAfterImport({
        documentId: DOC_A,
        transformPlan: businessTransformPlan(),
      });

      expect(orch.kind).toBe('persisted');
      if (orch.kind !== 'persisted') return;
      expect(orch.createdPreviewFileRef).toBe(true);
      expect(orch.previewFileRefId).not.toBe(source.fileRef.id);

      expect(encodeCall?.quality).toBe(RASTER_PREVIEW_ENCODE_JPEG_QUALITY);
      expect(encodeCall?.quality).toBe(0.8);
      expect(Math.max(encodeCall?.targetWidth ?? 0, encodeCall?.targetHeight ?? 0)).toBe(
        RASTER_PREVIEW_ENCODE_MAX_EDGE_PX,
      );
      expect(encodeCall?.targetWidth).toBe(1280);
      expect(encodeCall?.targetHeight).toBe(720);

      expect(getDocumentById(DOC_A)?.fileRefId).toBe(source.fileRef.id);

      const previewRef = getDocumentFileRefById(orch.previewFileRefId);
      expect(previewRef?.lifecycleStatus).toBe('committed');
      expect(previewRef?.mimeType).toBe('image/jpeg');

      const previewBytes = await getOriginalDocumentFileBytes(previewRef!);
      expect(Array.from(previewBytes ?? [])).toEqual(Array.from(JPEG_BYTES_PREVIEW));

      expect(getDocumentFileRepresentationBindingStoreSnapshot()).toEqual([
        {
          documentId: DOC_A,
          kind: 'preview',
          fileRefId: orch.previewFileRefId,
        },
      ]);

      expect(countActiveReferencesToFileRef(source.fileRef.id)).toBe(1);
      expect(countActiveReferencesToFileRef(orch.previewFileRefId)).toBe(1);
    });
  });

  describe('Fall B: Dedupe', () => {
    it('Dedupe auf bestehende FileRef nutzt vorhandene FileRef', async () => {
      installEncodeFake(JPEG_BYTES_B);
      const source = await prepareDocumentWithSource(JPEG_BYTES_A, 'source.jpg');
      const existing = await storeCommittedJpeg(JPEG_BYTES_B, 'existing-preview.jpg');

      const orch = await orchestrateRasterPreviewEncodeAfterImport({
        documentId: DOC_A,
        transformPlan: businessTransformPlan(),
      });

      expect(orch).toMatchObject({
        kind: 'persisted',
        previewFileRefId: existing.fileRef.id,
        createdPreviewFileRef: false,
      });
      expect(getDocumentById(DOC_A)?.fileRefId).toBe(source.fileRef.id);
      expect(getDocumentFileRepresentationBindingStoreSnapshot()).toEqual([
        {
          documentId: DOC_A,
          kind: 'preview',
          fileRefId: existing.fileRef.id,
        },
      ]);
    });
  });

  describe('Fall C: Conflict ohne Replace', () => {
    it('bestehendes preview→Y blockiert neues Binding; neue FileRef wird freigegeben', async () => {
      installEncodeFake(JPEG_BYTES_PREVIEW);
      const source = await prepareDocumentWithSource(JPEG_BYTES_A, 'conflict-source.jpg');
      const existingPreview = await storeCommittedJpeg(JPEG_BYTES_B, 'existing-preview.jpg');
      hydrateDocumentFileRepresentationBindingStore([
        createDocumentFileRepresentationBinding({
          documentId: DOC_A,
          kind: 'preview',
          fileRefId: existingPreview.fileRef.id,
        }),
      ]);

      const refsBefore = new Set(getDocumentFileRefStoreSnapshot().map((ref) => ref.id));
      const orch = await orchestrateRasterPreviewEncodeAfterImport({
        documentId: DOC_A,
        transformPlan: businessTransformPlan(),
      });

      expect(orch).toEqual({ kind: 'conflict' });
      expect(getDocumentFileRepresentationBindingStoreSnapshot()).toEqual([
        {
          documentId: DOC_A,
          kind: 'preview',
          fileRefId: existingPreview.fileRef.id,
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
          return JPEG_BYTES_PREVIEW.slice();
        },
      });
      vi.spyOn(console, 'error').mockImplementation(() => undefined);

      const orch = await orchestrateRasterPreviewEncodeAfterImport({
        documentId: DOC_A,
        transformPlan: businessTransformPlan(),
      });

      expect(orch.kind).toBe('error');
      expect(getDocumentFileRepresentationBindingStoreSnapshot()).toEqual([]);
      expect(getDocumentById(DOC_A)?.fileRefId).toBe(source.fileRef.id);
    });

    it('persistAll-Fehler rollt Binding zurück und entfernt neue FileRef', async () => {
      installEncodeFake(JPEG_BYTES_PREVIEW);
      const source = await prepareDocumentWithSource(JPEG_BYTES_A, 'persist-fail.jpg');
      const refsBefore = new Set(getDocumentFileRefStoreSnapshot().map((ref) => ref.id));

      vi.spyOn(persistenceService, 'persistAll').mockImplementation(() => {
        throw new Error('persist_failed');
      });
      vi.spyOn(console, 'error').mockImplementation(() => undefined);

      const orch = await orchestrateRasterPreviewEncodeAfterImport({
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

    it('Import bleibt bei Preview-Encode-Fehler erfolgreich', async () => {
      setDocumentFileRasterEncodeAdaptersForTests({
        async decodeRaster() {
          throw Object.freeze({ code: 'decode_failed', message: 'decode boom' });
        },
        async encodeJpeg() {
          return JPEG_BYTES_PREVIEW.slice();
        },
      });
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

      const source = await storeCommittedJpeg(JPEG_BYTES_A, 'import-preview-fail.jpg');
      const item = createAuftragInboxItem({
        id: 'inbox-raster-preview-fail',
        fileRefId: source.fileRef.id,
        sourceFileHash: source.fileRef.contentHash,
      });
      hydrateInboxStore([item]);

      const imported = importInboxDocumentForTests(item, 'Test GmbH', {
        transformPlan: businessTransformPlan(),
      });
      expect(imported.success).toBe(true);
      if (!imported.success) return;

      const drained = await orchestrateRasterPreviewEncodeAfterImport({
        documentId: imported.document.id,
        transformPlan: businessTransformPlan(),
      });
      expect(drained.kind).toBe('error');
      expect(
        getDocumentFileRepresentationBindingStoreSnapshot().every(
          (binding) => binding.kind !== 'preview',
        ),
      ).toBe(true);
      expect(getDocumentById(imported.document.id)?.fileRefId).toBe(source.fileRef.id);
      expect(errorSpy).toHaveBeenCalled();
    });
  });

  describe('Fall E: PDF noop / Refcount / keine Thumbnail-Störung', () => {
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
      installEncodeFake(JPEG_BYTES_PREVIEW);

      const orch = await orchestrateRasterPreviewEncodeAfterImport({
        documentId: DOC_A,
        transformPlan: businessTransformPlan(),
      });
      expect(orch).toEqual({ kind: 'noop', reason: 'encode_plan_unresolved' });
      expect(getDocumentFileRepresentationBindingStoreSnapshot()).toEqual([]);
    });

    it('Refcount schützt Preview-FileRef; Thumbnail-Binding bleibt unberührt', async () => {
      installEncodeFake(JPEG_BYTES_PREVIEW);
      const source = await prepareDocumentWithSource(JPEG_BYTES_A, 'refcount.jpg');
      const existingThumb = await storeCommittedJpeg(JPEG_BYTES_B, 'existing-thumb.jpg');
      hydrateDocumentFileRepresentationBindingStore([
        createDocumentFileRepresentationBinding({
          documentId: DOC_A,
          kind: 'thumbnail',
          fileRefId: existingThumb.fileRef.id,
        }),
      ]);

      const orch = await orchestrateRasterPreviewEncodeAfterImport({
        documentId: DOC_A,
        transformPlan: businessTransformPlan(),
      });
      expect(orch.kind).toBe('persisted');
      if (orch.kind !== 'persisted') return;

      expect(countActiveReferencesToFileRef(orch.previewFileRefId)).toBe(1);
      expect(getDocumentById(DOC_A)?.fileRefId).toBe(source.fileRef.id);
      expect(getDocumentFileRepresentationBindingStoreSnapshot()).toEqual(
        expect.arrayContaining([
          {
            documentId: DOC_A,
            kind: 'thumbnail',
            fileRefId: existingThumb.fileRef.id,
          },
          {
            documentId: DOC_A,
            kind: 'preview',
            fileRefId: orch.previewFileRefId,
          },
        ]),
      );
    });
  });
});
