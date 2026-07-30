import { importInboxDocumentForTests } from './test/confirmFilingDecisionForTests';
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
import { orchestrateRasterArchiveEncodeAfterImport } from './services/documentFileRasterArchiveEncodeOrchestrationService';
import { setDocumentFileRasterEncodeAdaptersForTests } from './services/documentFileRasterEncodeService';
import { countActiveReferencesToFileRef } from './services/documentFileReferenceService';
import {
  getDocumentById,
  hydrateDocumentStore,
  importInboxDocument,
} from './services/documentService';
import * as documentFileStoreService from './services/documentFileStoreService';
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
import type { DocumentFileTransformPlan } from './types/documentFileTransformPlan';
import type { CompanyDocument } from './types/models';

const JPEG_BYTES_A = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x41]);
const JPEG_BYTES_B = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x42]);
const JPEG_BYTES_ENCODED = new Uint8Array([0xff, 0xd8, 0xff, 0xd9, 0x01, 0x02, 0x03]);

const DOC_A = 'doc-raster-archive-exec-a';

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

function legalTransformPlan(): DocumentFileTransformPlan {
  const representationPlan = buildDocumentFileRepresentationPlan({
    policyId: 'legal_document',
    decision: 'save_permanently',
  });
  expect(representationPlan).not.toBeNull();
  const plan = buildDocumentFileTransformPlan({
    representationPlan: representationPlan!,
    mediaProfile: 'native_pdf',
  });
  expect(plan).not.toBeNull();
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
      createdAt: '2026-07-19T16:00:00.000Z',
      fileRefId,
    },
    'document',
  );
}

function installEncodeFake(outputBytes: Uint8Array = JPEG_BYTES_ENCODED): void {
  setDocumentFileRasterEncodeAdaptersForTests({
    async decodeRaster() {
      return { width: 32, height: 24 };
    },
    async encodeJpeg() {
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

describe('STORAGE-RASTER-ARCHIVE-EXECUTOR-01', () => {
  describe('Fall A: erfolgreicher neuer Archive-Pfad', () => {
    it('erzeugt neue Archive-FileRef/Blob und Binding; Original bleibt X', async () => {
      installEncodeFake(JPEG_BYTES_ENCODED);
      const source = await prepareDocumentWithSource(JPEG_BYTES_A, 'photo-source.jpg');

      const orch = await orchestrateRasterArchiveEncodeAfterImport({
        documentId: DOC_A,
        transformPlan: businessTransformPlan(),
      });

      expect(orch.kind).toBe('persisted');
      if (orch.kind !== 'persisted') return;
      expect(orch.createdArchiveFileRef).toBe(true);
      expect(orch.archiveFileRefId).not.toBe(source.fileRef.id);

      expect(getDocumentById(DOC_A)?.fileRefId).toBe(source.fileRef.id);

      const archiveRef = getDocumentFileRefById(orch.archiveFileRefId);
      expect(archiveRef?.lifecycleStatus).toBe('committed');
      expect(archiveRef?.mimeType).toBe('image/jpeg');

      const archiveBytes = await getOriginalDocumentFileBytes(archiveRef!);
      expect(Array.from(archiveBytes ?? [])).toEqual(Array.from(JPEG_BYTES_ENCODED));

      expect(getDocumentFileRepresentationBindingStoreSnapshot()).toEqual([
        {
          documentId: DOC_A,
          kind: 'archive',
          fileRefId: orch.archiveFileRefId,
        },
      ]);

      expect(countActiveReferencesToFileRef(source.fileRef.id)).toBe(1);
      expect(countActiveReferencesToFileRef(orch.archiveFileRefId)).toBe(1);
    });
  });

  describe('Fall B: Dedupe', () => {
    it('Dedupe auf Original X bindet archive → X', async () => {
      installEncodeFake(JPEG_BYTES_A);
      const source = await prepareDocumentWithSource(JPEG_BYTES_A, 'same-bytes.jpg');
      const refsBefore = getDocumentFileRefStoreSnapshot().map((ref) => ref.id);

      const orch = await orchestrateRasterArchiveEncodeAfterImport({
        documentId: DOC_A,
        transformPlan: businessTransformPlan(),
      });

      expect(orch).toMatchObject({
        kind: 'persisted',
        archiveFileRefId: source.fileRef.id,
        createdArchiveFileRef: false,
      });
      expect(getDocumentById(DOC_A)?.fileRefId).toBe(source.fileRef.id);
      expect(getDocumentFileRefStoreSnapshot().map((ref) => ref.id).sort()).toEqual(
        [...refsBefore].sort(),
      );
      expect(getDocumentFileRepresentationBindingStoreSnapshot()).toEqual([
        {
          documentId: DOC_A,
          kind: 'archive',
          fileRefId: source.fileRef.id,
        },
      ]);
    });

    it('Dedupe auf bestehende andere FileRef Z bindet archive → Z', async () => {
      installEncodeFake(JPEG_BYTES_B);
      const source = await prepareDocumentWithSource(JPEG_BYTES_A, 'source.jpg');
      const other = await storeCommittedJpeg(JPEG_BYTES_B, 'other.jpg');

      const orch = await orchestrateRasterArchiveEncodeAfterImport({
        documentId: DOC_A,
        transformPlan: businessTransformPlan(),
      });

      expect(orch).toMatchObject({
        kind: 'persisted',
        archiveFileRefId: other.fileRef.id,
        createdArchiveFileRef: false,
      });
      expect(getDocumentById(DOC_A)?.fileRefId).toBe(source.fileRef.id);
      expect(getDocumentFileRepresentationBindingStoreSnapshot()).toEqual([
        {
          documentId: DOC_A,
          kind: 'archive',
          fileRefId: other.fileRef.id,
        },
      ]);
    });
  });

  describe('Fall C: conflict ohne Replace', () => {
    it('bestehendes archive→Y blockiert neues Binding; neue FileRef wird freigegeben', async () => {
      installEncodeFake(JPEG_BYTES_ENCODED);
      const source = await prepareDocumentWithSource(JPEG_BYTES_A, 'conflict-source.jpg');
      const existingArchive = await storeCommittedJpeg(JPEG_BYTES_B, 'existing-archive.jpg');
      hydrateDocumentFileRepresentationBindingStore([
        createDocumentFileRepresentationBinding({
          documentId: DOC_A,
          kind: 'archive',
          fileRefId: existingArchive.fileRef.id,
        }),
      ]);

      const refsBefore = new Set(getDocumentFileRefStoreSnapshot().map((ref) => ref.id));
      const orch = await orchestrateRasterArchiveEncodeAfterImport({
        documentId: DOC_A,
        transformPlan: businessTransformPlan(),
      });

      expect(orch).toEqual({ kind: 'conflict' });
      expect(getDocumentFileRepresentationBindingStoreSnapshot()).toEqual([
        {
          documentId: DOC_A,
          kind: 'archive',
          fileRefId: existingArchive.fileRef.id,
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
          return JPEG_BYTES_ENCODED.slice();
        },
      });
      vi.spyOn(console, 'error').mockImplementation(() => undefined);

      const orch = await orchestrateRasterArchiveEncodeAfterImport({
        documentId: DOC_A,
        transformPlan: businessTransformPlan(),
      });

      expect(orch.kind).toBe('error');
      expect(getDocumentFileRepresentationBindingStoreSnapshot()).toEqual([]);
      expect(getDocumentById(DOC_A)?.fileRefId).toBe(source.fileRef.id);
    });

    it('Import bleibt bei Raster-Encode-Fehler erfolgreich', async () => {
      setDocumentFileRasterEncodeAdaptersForTests({
        async decodeRaster() {
          throw Object.freeze({ code: 'decode_failed', message: 'decode boom' });
        },
        async encodeJpeg() {
          return JPEG_BYTES_ENCODED.slice();
        },
      });
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

      const source = await storeCommittedJpeg(JPEG_BYTES_A, 'import-encode-fail.jpg');
      const item = createAuftragInboxItem({
        id: 'inbox-raster-encode-fail',
        fileRefId: source.fileRef.id,
        sourceFileHash: source.fileRef.contentHash,
      });
      hydrateInboxStore([item]);

      const imported = importInboxDocumentForTests(item, 'Test GmbH', {
        transformPlan: businessTransformPlan(),
      });
      expect(imported.success).toBe(true);
      if (!imported.success) return;

      // Drain post-import fire-and-forget before afterEach restores console mocks.
      const drained = await orchestrateRasterArchiveEncodeAfterImport({
        documentId: imported.document.id,
        transformPlan: businessTransformPlan(),
      });
      expect(drained.kind).toBe('error');
      expect(getDocumentFileRepresentationBindingStoreSnapshot()).toEqual([]);
      expect(getDocumentById(imported.document.id)?.fileRefId).toBe(source.fileRef.id);
      expect(errorSpy).toHaveBeenCalled();
    });

    it('Blob-Fehler → kein Binding, Original unverändert', async () => {
      const source = await prepareDocumentWithSource(JPEG_BYTES_A, 'blob-fail.jpg');
      installEncodeFake(JPEG_BYTES_ENCODED);
      vi.spyOn(documentFileStoreService, 'storeDocumentFileFromCachedPayload').mockRejectedValueOnce(
        new Error('blob_write_failed'),
      );
      vi.spyOn(console, 'error').mockImplementation(() => undefined);

      const orch = await orchestrateRasterArchiveEncodeAfterImport({
        documentId: DOC_A,
        transformPlan: businessTransformPlan(),
      });

      expect(orch.kind).toBe('error');
      expect(getDocumentFileRepresentationBindingStoreSnapshot()).toEqual([]);
      expect(getDocumentById(DOC_A)?.fileRefId).toBe(source.fileRef.id);
    });

    it('persistAll-Fehler rollt Binding zurück und entfernt neue FileRef', async () => {
      installEncodeFake(JPEG_BYTES_ENCODED);
      const source = await prepareDocumentWithSource(JPEG_BYTES_A, 'persist-fail.jpg');
      const refsBefore = new Set(getDocumentFileRefStoreSnapshot().map((ref) => ref.id));

      vi.spyOn(persistenceService, 'persistAll').mockImplementation(() => {
        throw new Error('persist_failed');
      });
      vi.spyOn(console, 'error').mockImplementation(() => undefined);

      const orch = await orchestrateRasterArchiveEncodeAfterImport({
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
  });

  describe('Fall E: Legal unverändert / Refcount', () => {
    it('Legal/source_reuse → raster encode plan unresolved (noop)', async () => {
      installEncodeFake(JPEG_BYTES_ENCODED);
      await prepareDocumentWithSource(JPEG_BYTES_A, 'legal.jpg');

      const orch = await orchestrateRasterArchiveEncodeAfterImport({
        documentId: DOC_A,
        transformPlan: legalTransformPlan(),
      });
      expect(orch).toEqual({ kind: 'noop', reason: 'encode_plan_unresolved' });
      expect(getDocumentFileRepresentationBindingStoreSnapshot()).toEqual([]);
    });

    it('Refcount schützt Archive Y nach erfolgreichem Persist', async () => {
      installEncodeFake(JPEG_BYTES_ENCODED);
      const source = await prepareDocumentWithSource(JPEG_BYTES_A, 'refcount.jpg');

      const orch = await orchestrateRasterArchiveEncodeAfterImport({
        documentId: DOC_A,
        transformPlan: businessTransformPlan(),
      });
      expect(orch.kind).toBe('persisted');
      if (orch.kind !== 'persisted') return;

      expect(countActiveReferencesToFileRef(orch.archiveFileRefId)).toBe(1);
      expect(getDocumentById(DOC_A)?.fileRefId).toBe(source.fileRef.id);
    });
  });
});
