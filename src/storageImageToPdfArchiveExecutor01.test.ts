import { afterEach, describe, expect, it, vi } from 'vitest';
import * as persistenceService from './services/persistenceService';
import { createDocumentFileRepresentationBinding } from './services/documentFileRepresentationBindingService';
import {
  getDocumentFileRepresentationBindingStoreSnapshot,
  hydrateDocumentFileRepresentationBindingStore,
  resetDocumentFileRepresentationBindingStoreForTests,
} from './services/documentFileRepresentationBindingStoreService';
import { orchestrateImageToPdfArchiveEncodeAfterImport } from './services/documentFileImageToPdfArchiveEncodeOrchestrationService';
import {
  encodeDocumentFileImageToPdf,
  setImageToPdfWriteForTests,
} from './services/documentFileImageToPdfWriteService';
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
  IMAGE_TO_PDF_PAGE_HEIGHT_PT,
  IMAGE_TO_PDF_PAGE_WIDTH_PT,
} from './types/documentFileImageToPdfWrite';
import type { DocumentFileTransformPlan } from './types/documentFileTransformPlan';
import type { CompanyDocument } from './types/models';

const PDF_BYTES_A = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x41, 0x0a]);
const PDF_BYTES_B = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x42, 0x0a]);
const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a]);
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01]);

const DOC_A = 'doc-image-to-pdf-archive-exec-a';

/** Hints that resolve to output_conversion_required for raster sources. */
function imageToPdfArchiveTransformPlan(): DocumentFileTransformPlan {
  return {
    policyId: 'receipt',
    mediaProfile: 'raster_image',
    hints: {
      metadataHandling: 'preserve',
      colorHandling: 'preserve',
      preferredOutputKind: 'pdf_preferred',
    },
    intents: [
      {
        targetKind: 'archive',
        intent: 'create_archive',
        executionIntent: 'preferred',
      },
    ],
  };
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

function installImageToPdfFake(
  outputBytes: Uint8Array = PDF_BYTES_A,
  onEncode?: (input: { sourceMimeType: string; byteLength: number }) => void,
): void {
  setImageToPdfWriteForTests(async (input) => {
    onEncode?.({
      sourceMimeType: input.sourceMimeType,
      byteLength: input.bytes.byteLength,
    });
    return Object.freeze({
      bytes: outputBytes.slice(),
      mimeType: 'application/pdf' as const,
      pageCount: 1 as const,
      pageWidth: IMAGE_TO_PDF_PAGE_WIDTH_PT,
      pageHeight: IMAGE_TO_PDF_PAGE_HEIGHT_PT,
      imageWidth: 100,
      imageHeight: 80,
    });
  });
}

async function storeCommittedRaster(
  bytes: Uint8Array,
  mimeType: 'image/jpeg' | 'image/png',
  fileName: string,
) {
  return storeDocumentFileFromCachedPayload(
    {
      fileName,
      mimeType,
      fileSize: bytes.byteLength,
      bytes,
    },
    { lifecycleIntent: 'committed' },
  );
}

async function storeCommittedPdf(bytes: Uint8Array, fileName: string) {
  return storeDocumentFileFromCachedPayload(
    {
      fileName,
      mimeType: 'application/pdf',
      fileSize: bytes.byteLength,
      bytes,
    },
    { lifecycleIntent: 'committed' },
  );
}

async function prepareDocumentWithRaster(
  bytes: Uint8Array,
  mimeType: 'image/jpeg' | 'image/png',
  fileName: string,
) {
  const source = await storeCommittedRaster(bytes, mimeType, fileName);
  hydrateDocumentStore([sampleDocument(DOC_A, source.fileRef.id)]);
  return source;
}

afterEach(() => {
  vi.restoreAllMocks();
  setImageToPdfWriteForTests(null);
  resetTestStores();
  resetDocumentFileStoreForTests();
  resetDocumentFileRepresentationBindingStoreForTests();
});

describe('STORAGE-IMAGE-TO-PDF-ARCHIVE-EXECUTOR-01', () => {
  describe('Fall A: JPEG/PNG → PDF erfolgreich', () => {
    it('JPEG → Archive-PDF-FileRef/Binding; Original bleibt unverändert', async () => {
      let encodeCall: { sourceMimeType: string; byteLength: number } | undefined;
      installImageToPdfFake(PDF_BYTES_A, (call) => {
        encodeCall = call;
      });
      const source = await prepareDocumentWithRaster(JPEG_BYTES, 'image/jpeg', 'receipt.jpg');

      const orch = await orchestrateImageToPdfArchiveEncodeAfterImport({
        documentId: DOC_A,
        transformPlan: imageToPdfArchiveTransformPlan(),
      });

      expect(orch.kind).toBe('persisted');
      if (orch.kind !== 'persisted') return;
      expect(orch.createdArchiveFileRef).toBe(true);
      expect(orch.archiveFileRefId).not.toBe(source.fileRef.id);
      expect(encodeCall).toEqual({
        sourceMimeType: 'image/jpeg',
        byteLength: JPEG_BYTES.byteLength,
      });

      expect(getDocumentById(DOC_A)?.fileRefId).toBe(source.fileRef.id);
      const sourceBytes = await getOriginalDocumentFileBytes(source.fileRef);
      expect(Array.from(sourceBytes ?? [])).toEqual(Array.from(JPEG_BYTES));

      const archiveRef = getDocumentFileRefById(orch.archiveFileRefId);
      expect(archiveRef?.lifecycleStatus).toBe('committed');
      expect(archiveRef?.mimeType).toBe('application/pdf');
      expect(archiveRef?.originalFileName).toBe('receipt.pdf');

      const archiveBytes = await getOriginalDocumentFileBytes(archiveRef!);
      expect(Array.from(archiveBytes ?? [])).toEqual(Array.from(PDF_BYTES_A));

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

    it('PNG → Archive-PDF erfolgreich', async () => {
      installImageToPdfFake(PDF_BYTES_B);
      const source = await prepareDocumentWithRaster(PNG_BYTES, 'image/png', 'scan.png');

      const orch = await orchestrateImageToPdfArchiveEncodeAfterImport({
        documentId: DOC_A,
        transformPlan: imageToPdfArchiveTransformPlan(),
      });

      expect(orch.kind).toBe('persisted');
      if (orch.kind !== 'persisted') return;
      expect(getDocumentById(DOC_A)?.fileRefId).toBe(source.fileRef.id);
      expect(getDocumentFileRefById(orch.archiveFileRefId)?.mimeType).toBe('application/pdf');
      expect(getDocumentFileRepresentationBindingStoreSnapshot()).toEqual([
        {
          documentId: DOC_A,
          kind: 'archive',
          fileRefId: orch.archiveFileRefId,
        },
      ]);
    });
  });

  describe('Fall B: Dedupe', () => {
    it('Dedupe auf bestehende PDF-FileRef nutzt vorhandene FileRef', async () => {
      installImageToPdfFake(PDF_BYTES_A);
      const source = await prepareDocumentWithRaster(JPEG_BYTES, 'image/jpeg', 'dedupe.jpg');
      const existing = await storeCommittedPdf(PDF_BYTES_A, 'existing-archive.pdf');

      const orch = await orchestrateImageToPdfArchiveEncodeAfterImport({
        documentId: DOC_A,
        transformPlan: imageToPdfArchiveTransformPlan(),
      });

      expect(orch).toMatchObject({
        kind: 'persisted',
        archiveFileRefId: existing.fileRef.id,
        createdArchiveFileRef: false,
      });
      expect(getDocumentById(DOC_A)?.fileRefId).toBe(source.fileRef.id);
      expect(getDocumentFileRepresentationBindingStoreSnapshot()).toEqual([
        {
          documentId: DOC_A,
          kind: 'archive',
          fileRefId: existing.fileRef.id,
        },
      ]);
    });
  });

  describe('Fall C: Conflict ohne Replace', () => {
    it('bestehendes archive→Y blockiert neues Binding; neue FileRef wird freigegeben', async () => {
      installImageToPdfFake(PDF_BYTES_A);
      const source = await prepareDocumentWithRaster(JPEG_BYTES, 'image/jpeg', 'conflict.jpg');
      const existingArchive = await storeCommittedPdf(PDF_BYTES_B, 'existing-archive.pdf');
      hydrateDocumentFileRepresentationBindingStore([
        createDocumentFileRepresentationBinding({
          documentId: DOC_A,
          kind: 'archive',
          fileRefId: existingArchive.fileRef.id,
        }),
      ]);

      const refsBefore = new Set(getDocumentFileRefStoreSnapshot().map((ref) => ref.id));
      const orch = await orchestrateImageToPdfArchiveEncodeAfterImport({
        documentId: DOC_A,
        transformPlan: imageToPdfArchiveTransformPlan(),
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
    it('PDF-Encode-Fehler → kein Binding, Original unverändert', async () => {
      setImageToPdfWriteForTests(async () => {
        throw Object.freeze({ code: 'encode_failed', message: 'pdf boom' });
      });
      const source = await prepareDocumentWithRaster(JPEG_BYTES, 'image/jpeg', 'encode-fail.jpg');
      vi.spyOn(console, 'error').mockImplementation(() => undefined);

      const orch = await orchestrateImageToPdfArchiveEncodeAfterImport({
        documentId: DOC_A,
        transformPlan: imageToPdfArchiveTransformPlan(),
      });

      expect(orch.kind).toBe('error');
      expect(getDocumentFileRepresentationBindingStoreSnapshot()).toEqual([]);
      expect(getDocumentById(DOC_A)?.fileRefId).toBe(source.fileRef.id);
    });

    it('persistAll-Fehler rollt Binding zurück und entfernt neue FileRef', async () => {
      installImageToPdfFake(PDF_BYTES_A);
      const source = await prepareDocumentWithRaster(JPEG_BYTES, 'image/jpeg', 'persist-fail.jpg');
      const refsBefore = new Set(getDocumentFileRefStoreSnapshot().map((ref) => ref.id));

      vi.spyOn(persistenceService, 'persistAll').mockImplementation(() => {
        throw new Error('persist_failed');
      });
      vi.spyOn(console, 'error').mockImplementation(() => undefined);

      const orch = await orchestrateImageToPdfArchiveEncodeAfterImport({
        documentId: DOC_A,
        transformPlan: imageToPdfArchiveTransformPlan(),
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

  describe('Fall E: Import / Refcount / WebP noop', () => {
    it('WebP → encode_plan_unresolved', async () => {
      installImageToPdfFake(PDF_BYTES_A);
      const source = await storeDocumentFileFromCachedPayload(
        {
          fileName: 'photo.webp',
          mimeType: 'image/webp',
          fileSize: 6,
          bytes: new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x00, 0x00]),
        },
        { lifecycleIntent: 'committed' },
      );
      hydrateDocumentStore([sampleDocument(DOC_A, source.fileRef.id)]);

      const orch = await orchestrateImageToPdfArchiveEncodeAfterImport({
        documentId: DOC_A,
        transformPlan: imageToPdfArchiveTransformPlan(),
      });
      expect(orch).toEqual({ kind: 'noop', reason: 'encode_plan_unresolved' });
      expect(getDocumentFileRepresentationBindingStoreSnapshot()).toEqual([]);
    });

    it('Import bleibt erfolgreich bei Encode-Fehler; Refcount schützt Archive-PDF', async () => {
      setImageToPdfWriteForTests(async () => {
        throw Object.freeze({ code: 'encode_failed', message: 'pdf boom' });
      });
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

      const source = await storeCommittedRaster(JPEG_BYTES, 'image/jpeg', 'import-fail.jpg');
      const item = createAuftragInboxItem({
        id: 'inbox-image-to-pdf-fail',
        fileRefId: source.fileRef.id,
        sourceFileHash: source.fileRef.contentHash,
      });
      hydrateInboxStore([item]);

      const imported = importInboxDocument(item, 'Test GmbH', {
        transformPlan: imageToPdfArchiveTransformPlan(),
      });
      expect(imported.success).toBe(true);
      if (!imported.success) return;

      const drained = await orchestrateImageToPdfArchiveEncodeAfterImport({
        documentId: imported.document.id,
        transformPlan: imageToPdfArchiveTransformPlan(),
      });
      expect(drained.kind).toBe('error');
      expect(
        getDocumentFileRepresentationBindingStoreSnapshot().every(
          (binding) => binding.kind !== 'archive',
        ),
      ).toBe(true);
      expect(getDocumentById(imported.document.id)?.fileRefId).toBe(source.fileRef.id);
      expect(errorSpy).toHaveBeenCalled();

      installImageToPdfFake(PDF_BYTES_A);
      const okSource = await prepareDocumentWithRaster(JPEG_BYTES, 'image/jpeg', 'refcount.jpg');
      const ok = await orchestrateImageToPdfArchiveEncodeAfterImport({
        documentId: DOC_A,
        transformPlan: imageToPdfArchiveTransformPlan(),
      });
      expect(ok.kind).toBe('persisted');
      if (ok.kind !== 'persisted') return;
      expect(countActiveReferencesToFileRef(ok.archiveFileRefId)).toBe(1);
      expect(getDocumentById(DOC_A)?.fileRefId).toBe(okSource.fileRef.id);
    });

    it('Test-Override zurücksetzen lässt den echten Image-to-PDF-Core zu', async () => {
      setImageToPdfWriteForTests(null);
      // Minimal valid 1×1 JPEG used by the write-core suite.
      const minimalJpeg = Uint8Array.from([
        0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00,
        0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xdb, 0x00, 0x43, 0x00, 0x08, 0x06, 0x06, 0x07, 0x06,
        0x05, 0x08, 0x07, 0x07, 0x07, 0x09, 0x09, 0x08, 0x0a, 0x0c, 0x14, 0x0d, 0x0c, 0x0b, 0x0b,
        0x0c, 0x19, 0x12, 0x13, 0x0f, 0x14, 0x1d, 0x1a, 0x1f, 0x1e, 0x1d, 0x1a, 0x1c, 0x1c, 0x20,
        0x24, 0x2e, 0x27, 0x20, 0x22, 0x2c, 0x23, 0x1c, 0x1c, 0x28, 0x37, 0x29, 0x2c, 0x30, 0x31,
        0x34, 0x34, 0x34, 0x1f, 0x27, 0x39, 0x3d, 0x38, 0x32, 0x3c, 0x2e, 0x33, 0x34, 0x32, 0xff,
        0xc0, 0x00, 0x0b, 0x08, 0x00, 0x01, 0x00, 0x01, 0x01, 0x01, 0x11, 0x00, 0xff, 0xc4, 0x00,
        0x1f, 0x00, 0x00, 0x01, 0x05, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b,
        0xff, 0xc4, 0x00, 0xb5, 0x10, 0x00, 0x02, 0x01, 0x03, 0x03, 0x02, 0x04, 0x03, 0x05, 0x05,
        0x04, 0x04, 0x00, 0x00, 0x01, 0x7d, 0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21,
        0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07, 0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xa1, 0x08,
        0x23, 0x42, 0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0, 0x24, 0x33, 0x62, 0x72, 0x82, 0x09, 0x0a,
        0x16, 0x17, 0x18, 0x19, 0x1a, 0x25, 0x26, 0x27, 0x28, 0x29, 0x2a, 0x34, 0x35, 0x36, 0x37,
        0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a, 0x53, 0x54, 0x55, 0x56,
        0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x73, 0x74, 0x75,
        0x76, 0x77, 0x78, 0x79, 0x7a, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89, 0x8a, 0x92, 0x93,
        0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9,
        0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6,
        0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe1, 0xe2,
        0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7,
        0xf8, 0xf9, 0xfa, 0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00, 0x7f, 0x3f,
        0xff, 0xd9,
      ]);

      const result = await encodeDocumentFileImageToPdf({
        bytes: minimalJpeg,
        sourceMimeType: 'image/jpeg',
      });
      expect(result.mimeType).toBe('application/pdf');
      expect(result.pageCount).toBe(1);
      expect(String.fromCharCode(...result.bytes.slice(0, 4))).toBe('%PDF');
    });
  });
});
