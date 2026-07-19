import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDocumentFileRepresentationBinding } from './services/documentFileRepresentationBindingService';
import {
  getDocumentFileRepresentationBindingStoreSnapshot,
  hydrateDocumentFileRepresentationBindingStore,
  resetDocumentFileRepresentationBindingStoreForTests,
} from './services/documentFileRepresentationBindingStoreService';
import { deleteDocument, hydrateDocumentStore } from './services/documentService';
import {
  collectFileRefIdsHeldByDocument,
  countActiveReferencesToFileRef,
} from './services/documentFileReferenceService';
import {
  getDocumentFileRefStoreSnapshot,
  hydrateDocumentFileStore,
  resetDocumentFileStoreForTests,
} from './services/documentFileStoreService';
import { hydrateInboxStore } from './services/inboxService';
import { withNewEntitySync } from './services/sync/syncMetaService';
import { createAuftragInboxItem } from './test/fixtures';
import { resetTestStores } from './test/resetStores';
import type { DocumentFileRef } from './types/documentFileRef';
import type { CompanyDocument } from './types/models';

const DOC_A = 'doc-binding-refcount-a';
const DOC_B = 'doc-binding-refcount-b';
const FILE_X = 'file-ref-binding-refcount-x';
const FILE_Y = 'file-ref-binding-refcount-y';

function sampleFileRef(id: string): DocumentFileRef {
  return {
    id,
    originalFileName: `${id}.bin`,
    mimeType: 'image/jpeg',
    fileSize: 64,
    contentHash: `hash-${id}`,
    storageType: 'indexeddb',
    localDataKey: id,
    createdAt: '2026-07-19T10:00:00.000Z',
    lifecycleStatus: 'committed',
    committedAt: '2026-07-19T10:00:01.000Z',
  };
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
      linkedCompany: '',
      linkedVorgang: null,
      archived: false,
      createdAt: '2026-07-19T10:00:00.000Z',
      fileRefId,
    },
    'document',
  );
}

afterEach(() => {
  resetTestStores();
  resetDocumentFileStoreForTests();
  resetDocumentFileRepresentationBindingStoreForTests();
});

describe('STORAGE-RASTER-ARCHIVE-BINDING-REFCOUNT-01', () => {
  describe('Fall A: Dedup pro Dokument', () => {
    it('original X + archive X zählt X nicht doppelt', () => {
      hydrateDocumentFileStore([sampleFileRef(FILE_X)], {});
      hydrateDocumentStore([sampleDocument(DOC_A, FILE_X)]);
      hydrateDocumentFileRepresentationBindingStore([
        createDocumentFileRepresentationBinding({
          documentId: DOC_A,
          kind: 'archive',
          fileRefId: FILE_X,
        }),
      ]);

      expect(collectFileRefIdsHeldByDocument(DOC_A, FILE_X)).toEqual([FILE_X]);
      expect(countActiveReferencesToFileRef(FILE_X)).toBe(1);
    });

    it('original X + archive Y zählt beide FileRefs je einmal', () => {
      hydrateDocumentFileStore([sampleFileRef(FILE_X), sampleFileRef(FILE_Y)], {});
      hydrateDocumentStore([sampleDocument(DOC_A, FILE_X)]);
      hydrateDocumentFileRepresentationBindingStore([
        createDocumentFileRepresentationBinding({
          documentId: DOC_A,
          kind: 'archive',
          fileRefId: FILE_Y,
        }),
      ]);

      expect(collectFileRefIdsHeldByDocument(DOC_A, FILE_X).sort()).toEqual(
        [FILE_X, FILE_Y].sort(),
      );
      expect(countActiveReferencesToFileRef(FILE_X)).toBe(1);
      expect(countActiveReferencesToFileRef(FILE_Y)).toBe(1);
    });

    it('mehrere Rollen auf Y zählen Y pro Dokument nur einmal', () => {
      hydrateDocumentFileStore([sampleFileRef(FILE_X), sampleFileRef(FILE_Y)], {});
      hydrateDocumentStore([sampleDocument(DOC_A, FILE_X)]);
      hydrateDocumentFileRepresentationBindingStore([
        createDocumentFileRepresentationBinding({
          documentId: DOC_A,
          kind: 'archive',
          fileRefId: FILE_Y,
        }),
        createDocumentFileRepresentationBinding({
          documentId: DOC_A,
          kind: 'preview',
          fileRefId: FILE_Y,
        }),
        createDocumentFileRepresentationBinding({
          documentId: DOC_A,
          kind: 'thumbnail',
          fileRefId: FILE_Y,
        }),
      ]);

      expect(countActiveReferencesToFileRef(FILE_Y)).toBe(1);
      expect(countActiveReferencesToFileRef(FILE_X)).toBe(1);
    });
  });

  describe('Fall B: Mehrere Dokumente und Inbox', () => {
    it('zwei Dokumente mit Y zählen 2', () => {
      hydrateDocumentFileStore([sampleFileRef(FILE_X), sampleFileRef(FILE_Y)], {});
      hydrateDocumentStore([
        sampleDocument(DOC_A, FILE_X),
        sampleDocument(DOC_B, FILE_X),
      ]);
      hydrateDocumentFileRepresentationBindingStore([
        createDocumentFileRepresentationBinding({
          documentId: DOC_A,
          kind: 'archive',
          fileRefId: FILE_Y,
        }),
        createDocumentFileRepresentationBinding({
          documentId: DOC_B,
          kind: 'archive',
          fileRefId: FILE_Y,
        }),
      ]);

      expect(countActiveReferencesToFileRef(FILE_Y)).toBe(2);
      expect(countActiveReferencesToFileRef(FILE_X)).toBe(2);
    });

    it('Inbox-Referenz bleibt zusätzlich und unverändert', () => {
      hydrateDocumentFileStore([sampleFileRef(FILE_X), sampleFileRef(FILE_Y)], {});
      hydrateInboxStore([
        createAuftragInboxItem({
          id: 'inbox-refcount-1',
          fileRefId: FILE_Y,
          sourceFileHash: `hash-${FILE_Y}`,
        }),
      ]);
      hydrateDocumentStore([sampleDocument(DOC_A, FILE_X)]);
      hydrateDocumentFileRepresentationBindingStore([
        createDocumentFileRepresentationBinding({
          documentId: DOC_A,
          kind: 'archive',
          fileRefId: FILE_Y,
        }),
      ]);

      // Inbox Y + document binding Y
      expect(countActiveReferencesToFileRef(FILE_Y)).toBe(2);
      expect(countActiveReferencesToFileRef(FILE_X)).toBe(1);
    });
  });

  describe('Fall C: Dokumentlöschung', () => {
    it('löscht binding-only Y und behält X/Y anderer Dokumente sowie Inbox', async () => {
      hydrateDocumentFileStore([sampleFileRef(FILE_X), sampleFileRef(FILE_Y)], {});
      hydrateInboxStore([
        createAuftragInboxItem({
          id: 'inbox-refcount-keep',
          fileRefId: FILE_X,
          sourceFileHash: `hash-${FILE_X}`,
        }),
      ]);
      hydrateDocumentStore([
        sampleDocument(DOC_A, FILE_X),
        sampleDocument(DOC_B, FILE_X),
      ]);
      hydrateDocumentFileRepresentationBindingStore([
        createDocumentFileRepresentationBinding({
          documentId: DOC_A,
          kind: 'archive',
          fileRefId: FILE_Y,
        }),
        createDocumentFileRepresentationBinding({
          documentId: DOC_B,
          kind: 'preview',
          fileRefId: FILE_Y,
        }),
      ]);

      expect(countActiveReferencesToFileRef(FILE_Y)).toBe(2);
      expect(countActiveReferencesToFileRef(FILE_X)).toBe(3); // inbox + DOC_A + DOC_B

      const deleted = deleteDocument(DOC_A);
      expect(deleted.success).toBe(true);
      expect(getDocumentFileRepresentationBindingStoreSnapshot()).toEqual([
        { documentId: DOC_B, kind: 'preview', fileRefId: FILE_Y },
      ]);
      expect(countActiveReferencesToFileRef(FILE_X)).toBe(2); // inbox + DOC_B
      expect(countActiveReferencesToFileRef(FILE_Y)).toBe(1); // DOC_B only

      await vi.waitFor(() => {
        expect(getDocumentFileRefStoreSnapshot().some((ref) => ref.id === FILE_Y)).toBe(true);
        expect(getDocumentFileRefStoreSnapshot().some((ref) => ref.id === FILE_X)).toBe(true);
      });

      const deletedB = deleteDocument(DOC_B);
      expect(deletedB.success).toBe(true);
      expect(getDocumentFileRepresentationBindingStoreSnapshot()).toEqual([]);
      expect(countActiveReferencesToFileRef(FILE_Y)).toBe(0);
      expect(countActiveReferencesToFileRef(FILE_X)).toBe(1); // inbox only

      await vi.waitFor(() => {
        expect(getDocumentFileRefStoreSnapshot().some((ref) => ref.id === FILE_Y)).toBe(false);
        expect(getDocumentFileRefStoreSnapshot().some((ref) => ref.id === FILE_X)).toBe(true);
      });
    });

    it('source-reuse archive X wird bei Löschung nicht zusätzlich freigegeben solange anderes Dokument hält', async () => {
      hydrateDocumentFileStore([sampleFileRef(FILE_X)], {});
      hydrateDocumentStore([
        sampleDocument(DOC_A, FILE_X),
        sampleDocument(DOC_B, FILE_X),
      ]);
      hydrateDocumentFileRepresentationBindingStore([
        createDocumentFileRepresentationBinding({
          documentId: DOC_A,
          kind: 'archive',
          fileRefId: FILE_X,
        }),
        createDocumentFileRepresentationBinding({
          documentId: DOC_B,
          kind: 'archive',
          fileRefId: FILE_X,
        }),
      ]);

      expect(countActiveReferencesToFileRef(FILE_X)).toBe(2);

      deleteDocument(DOC_A);
      expect(countActiveReferencesToFileRef(FILE_X)).toBe(1);
      await vi.waitFor(() => {
        expect(getDocumentFileRefStoreSnapshot().some((ref) => ref.id === FILE_X)).toBe(true);
      });
    });
  });
});
