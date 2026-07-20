import { afterEach, describe, expect, it } from 'vitest';
import { createDocumentFileRepresentationBinding } from './services/documentFileRepresentationBindingService';
import {
  getDocumentFileRepresentationBindingStoreSnapshot,
  hydrateDocumentFileRepresentationBindingStore,
  resetDocumentFileRepresentationBindingStoreForTests,
} from './services/documentFileRepresentationBindingStoreService';
import { resolveDocumentFileRepresentation } from './services/documentFileRepresentationReadService';
import {
  getDocumentFileBlobStoreSnapshot,
  getDocumentFileRefStoreSnapshot,
  hydrateDocumentFileStore,
  resetDocumentFileStoreForTests,
  storeDocumentFileFromCachedPayload,
} from './services/documentFileStoreService';
import { resetTestStores } from './test/resetStores';
import type { DocumentFileRepresentationBindingKind } from './types/documentFileRepresentationBinding';
import type { DocumentFileLifecycleStatus, DocumentFileRef } from './types/documentFileRef';

const DOC_A = 'doc-representation-read-a';
const DOC_B = 'doc-representation-read-b';

const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a]);
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x0a]);

function sampleFileRef(
  id: string,
  lifecycleStatus: DocumentFileLifecycleStatus = 'committed',
  mimeType = 'image/jpeg',
): DocumentFileRef {
  return {
    id,
    originalFileName: `${id}.bin`,
    mimeType,
    fileSize: 8,
    contentHash: `hash-${id}`,
    storageType: 'indexeddb',
    localDataKey: id,
    createdAt: '2026-07-20T00:00:00.000Z',
    lifecycleStatus,
    ...(lifecycleStatus === 'committed'
      ? { committedAt: '2026-07-20T00:00:01.000Z' }
      : lifecycleStatus === 'temp'
        ? { expiresAt: '2026-07-21T00:00:00.000Z' }
        : {}),
  };
}

async function storeCommitted(
  bytes: Uint8Array,
  mimeType: string,
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

function bind(
  documentId: string,
  kind: DocumentFileRepresentationBindingKind,
  fileRefId: string,
) {
  return createDocumentFileRepresentationBinding({ documentId, kind, fileRefId });
}

afterEach(() => {
  resetTestStores();
  resetDocumentFileStoreForTests();
  resetDocumentFileRepresentationBindingStoreForTests();
});

describe('STORAGE-REPRESENTATION-READ-LOOKUP-01', () => {
  describe('Fall A: erfolgreiche Auflösung', () => {
    it('löst archive, preview und thumbnail zu ready auf', async () => {
      const archive = await storeCommitted(PDF_BYTES, 'application/pdf', 'archive.pdf');
      const preview = await storeCommitted(JPEG_BYTES, 'image/jpeg', 'preview.jpg');
      const thumbnail = await storeCommitted(PNG_BYTES, 'image/png', 'thumb.png');

      hydrateDocumentFileRepresentationBindingStore([
        bind(DOC_A, 'archive', archive.fileRef.id),
        bind(DOC_A, 'preview', preview.fileRef.id),
        bind(DOC_A, 'thumbnail', thumbnail.fileRef.id),
      ]);

      const archiveResult = await resolveDocumentFileRepresentation({
        documentId: DOC_A,
        kind: 'archive',
      });
      expect(archiveResult.kind).toBe('ready');
      if (archiveResult.kind !== 'ready') return;
      expect(archiveResult.binding).toEqual(bind(DOC_A, 'archive', archive.fileRef.id));
      expect(archiveResult.fileRef.id).toBe(archive.fileRef.id);
      expect(archiveResult.fileRef.lifecycleStatus).toBe('committed');
      expect(archiveResult.blob).toBeInstanceOf(Blob);
      expect(archiveResult.blob.type).toBe('application/pdf');
      expect(archiveResult.blob.size).toBe(PDF_BYTES.byteLength);

      const previewResult = await resolveDocumentFileRepresentation({
        documentId: DOC_A,
        kind: 'preview',
      });
      expect(previewResult.kind).toBe('ready');
      if (previewResult.kind !== 'ready') return;
      expect(previewResult.binding.fileRefId).toBe(preview.fileRef.id);
      expect(previewResult.blob.size).toBe(JPEG_BYTES.byteLength);

      const thumbResult = await resolveDocumentFileRepresentation({
        documentId: DOC_A,
        kind: 'thumbnail',
      });
      expect(thumbResult.kind).toBe('ready');
      if (thumbResult.kind !== 'ready') return;
      expect(thumbResult.binding.fileRefId).toBe(thumbnail.fileRef.id);
      expect(thumbResult.blob.size).toBe(PNG_BYTES.byteLength);
    });
  });

  describe('Fall B: Missing-Fälle', () => {
    it('fehlendes Binding → missing_binding', async () => {
      const result = await resolveDocumentFileRepresentation({
        documentId: DOC_A,
        kind: 'preview',
      });
      expect(result).toEqual({ kind: 'missing_binding' });
    });

    it('Binding für anderes Dokument zählt nicht', async () => {
      const stored = await storeCommitted(JPEG_BYTES, 'image/jpeg', 'other.jpg');
      hydrateDocumentFileRepresentationBindingStore([
        bind(DOC_B, 'preview', stored.fileRef.id),
      ]);

      expect(
        await resolveDocumentFileRepresentation({ documentId: DOC_A, kind: 'preview' }),
      ).toEqual({ kind: 'missing_binding' });
    });

    it('fehlende FileRef → missing_file_ref', async () => {
      hydrateDocumentFileRepresentationBindingStore([
        bind(DOC_A, 'thumbnail', 'missing-file-ref-id'),
      ]);

      expect(
        await resolveDocumentFileRepresentation({ documentId: DOC_A, kind: 'thumbnail' }),
      ).toEqual({ kind: 'missing_file_ref' });
    });

    it.each(['temp', 'staged', 'trashed'] as const)(
      '%s FileRef → not_committed',
      async (lifecycleStatus) => {
        const fileRefId = `file-${lifecycleStatus}`;
        hydrateDocumentFileStore([sampleFileRef(fileRefId, lifecycleStatus)], {});
        hydrateDocumentFileRepresentationBindingStore([
          bind(DOC_A, 'archive', fileRefId),
        ]);

        expect(
          await resolveDocumentFileRepresentation({ documentId: DOC_A, kind: 'archive' }),
        ).toEqual({ kind: 'not_committed' });
      },
    );

    it('fehlender Blob → missing_blob', async () => {
      const fileRefId = 'file-no-blob';
      hydrateDocumentFileStore([sampleFileRef(fileRefId, 'committed', 'image/jpeg')], {});
      hydrateDocumentFileRepresentationBindingStore([
        bind(DOC_A, 'preview', fileRefId),
      ]);

      expect(
        await resolveDocumentFileRepresentation({ documentId: DOC_A, kind: 'preview' }),
      ).toEqual({ kind: 'missing_blob' });
    });
  });

  describe('Fall C: Eingabe-Guards', () => {
    it('original und ungültige kind → TypeError', async () => {
      await expect(
        resolveDocumentFileRepresentation({
          documentId: DOC_A,
          kind: 'original' as DocumentFileRepresentationBindingKind,
        }),
      ).rejects.toThrow(TypeError);

      await expect(
        resolveDocumentFileRepresentation({
          documentId: DOC_A,
          kind: 'unknown' as DocumentFileRepresentationBindingKind,
        }),
      ).rejects.toThrow(TypeError);
    });

    it('leere/ungültige documentId und Input → TypeError', async () => {
      await expect(
        resolveDocumentFileRepresentation({
          documentId: '',
          kind: 'archive',
        }),
      ).rejects.toThrow(TypeError);

      await expect(
        resolveDocumentFileRepresentation({
          documentId: '   ',
          kind: 'archive',
        }),
      ).rejects.toThrow(TypeError);

      await expect(
        resolveDocumentFileRepresentation(null as unknown as { documentId: string; kind: 'archive' }),
      ).rejects.toThrow(TypeError);
    });

    it('gibt Original nicht als stillen Fallback zurück', async () => {
      const original = await storeCommitted(PDF_BYTES, 'application/pdf', 'original.pdf');
      // Binding fehlt bewusst — auch wenn ein Original-Blob existiert.
      void original;

      const result = await resolveDocumentFileRepresentation({
        documentId: DOC_A,
        kind: 'archive',
      });
      expect(result).toEqual({ kind: 'missing_binding' });
      expect(result).not.toHaveProperty('blob');
      expect(result).not.toHaveProperty('fileRef');
    });
  });

  describe('Fall D: keine Mutation', () => {
    it('ändert Binding-, FileRef- und Blob-Stores nicht', async () => {
      const stored = await storeCommitted(JPEG_BYTES, 'image/jpeg', 'stable.jpg');
      hydrateDocumentFileRepresentationBindingStore([
        bind(DOC_A, 'thumbnail', stored.fileRef.id),
        bind(DOC_B, 'preview', stored.fileRef.id),
      ]);

      const bindingsBefore = getDocumentFileRepresentationBindingStoreSnapshot();
      const refsBefore = getDocumentFileRefStoreSnapshot();
      const blobsBefore = getDocumentFileBlobStoreSnapshot();

      const result = await resolveDocumentFileRepresentation({
        documentId: DOC_A,
        kind: 'thumbnail',
      });
      expect(result.kind).toBe('ready');

      expect(getDocumentFileRepresentationBindingStoreSnapshot()).toEqual(bindingsBefore);
      expect(getDocumentFileRefStoreSnapshot()).toEqual(refsBefore);
      expect(getDocumentFileBlobStoreSnapshot()).toEqual(blobsBefore);

      // Missing-Pfad mutiert ebenfalls nicht.
      await resolveDocumentFileRepresentation({ documentId: DOC_A, kind: 'archive' });
      expect(getDocumentFileRepresentationBindingStoreSnapshot()).toEqual(bindingsBefore);
      expect(getDocumentFileRefStoreSnapshot()).toEqual(refsBefore);
      expect(getDocumentFileBlobStoreSnapshot()).toEqual(blobsBefore);
    });
  });
});
