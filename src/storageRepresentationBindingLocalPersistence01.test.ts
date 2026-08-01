import { afterEach, describe, expect, it, vi } from 'vitest';
import * as persistenceService from './services/persistenceService';
import {
  applyStateToStores,
  buildPersistedStateSnapshot,
  createSeedState,
} from './services/persistenceService';
import type { DocumentFileLifecycleStatus } from './types/documentFileRef';
import {
  getDocumentFileRepresentationBindingStoreSnapshot,
  hydrateDocumentFileRepresentationBindingStore,
  resetDocumentFileRepresentationBindingStoreForTests,
} from './services/documentFileRepresentationBindingStoreService';
import { persistSourceReuseArchiveRepresentationBinding } from './services/documentFileRepresentationSourceReuseArchiveBindingPersistenceService';
import { planDocumentFileRepresentationSourceReuseBinding } from './services/documentFileRepresentationSourceReuseBindingPlanService';
import { createDocumentFileRepresentationBinding } from './services/documentFileRepresentationBindingService';
import { deleteDocument, hydrateDocumentStore } from './services/documentService';
import {
  getDocumentFileRefStoreSnapshot,
  hydrateDocumentFileStore,
  resetDocumentFileStoreForTests,
} from './services/documentFileStoreService';
import { countActiveReferencesToFileRef } from './services/documentFileReferenceService';
import type { CompanyDocument } from './types/models';
import type { DocumentFileRef } from './types/documentFileRef';
import { withNewEntitySync } from './services/sync/syncMetaService';

const DOC_A = 'doc-binding-local-persist-a';
const DOC_B = 'doc-binding-local-persist-b';
const FILE_X = 'file-ref-binding-local-persist-x';
const FILE_Y = 'file-ref-binding-local-persist-y';

function sampleFileRef(
  id: string,
  lifecycleStatus: DocumentFileLifecycleStatus = 'committed',
): DocumentFileRef {
  return {
    id,
    originalFileName: `${id}.pdf`,
    mimeType: 'application/pdf',
    fileSize: 128,
    contentHash: `hash-${id}`,
    storageType: 'indexeddb',
    localDataKey: id,
    createdAt: '2026-07-18T10:00:00.000Z',
    lifecycleStatus,
    ...(lifecycleStatus === 'committed'
      ? { committedAt: '2026-07-18T10:00:01.000Z' }
      : lifecycleStatus === 'temp'
        ? { expiresAt: '2026-07-19T10:00:00.000Z' }
        : {}),
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
      createdAt: '2026-07-18T10:00:00.000Z',
      fileRefId,
    },
    'document',
  );
}

function sourceReusePlan(sourceFileRefId: string) {
  return planDocumentFileRepresentationSourceReuseBinding({
    materialization: { kind: 'source_reuse' },
    sourceFileRefId,
  });
}

describe('STORAGE-REPRESENTATION-BINDING-LOCAL-PERSISTENCE-01', () => {
  afterEach(() => {    resetDocumentFileStoreForTests();
    resetDocumentFileRepresentationBindingStoreForTests();
  });

  describe('Fall A: Source-Reuse Archive persistieren', () => {
    it('legt archive → Original-FileRef dauerhaft an (created)', () => {
      hydrateDocumentFileStore([sampleFileRef(FILE_X)], {});
      hydrateDocumentStore([sampleDocument(DOC_A, FILE_X)]);

      const result = persistSourceReuseArchiveRepresentationBinding({
        documentId: DOC_A,
        plan: sourceReusePlan(FILE_X),
      });

      expect(result.kind).toBe('created');
      if (result.kind !== 'created') return;
      expect(result.binding).toEqual({
        documentId: DOC_A,
        kind: 'archive',
        fileRefId: FILE_X,
      });
      expect(getDocumentFileRepresentationBindingStoreSnapshot()).toEqual([result.binding]);
      expect(buildPersistedStateSnapshot().documentFileRepresentationBindings).toEqual([
        result.binding,
      ]);
    });

    it('zweite identische Persistierung → unchanged ohne doppelte Rolle', () => {
      hydrateDocumentFileStore([sampleFileRef(FILE_X)], {});
      hydrateDocumentStore([sampleDocument(DOC_A, FILE_X)]);

      const first = persistSourceReuseArchiveRepresentationBinding({
        documentId: DOC_A,
        plan: sourceReusePlan(FILE_X),
      });
      const second = persistSourceReuseArchiveRepresentationBinding({
        documentId: DOC_A,
        plan: sourceReusePlan(FILE_X),
      });

      expect(first.kind).toBe('created');
      expect(second.kind).toBe('unchanged');
      expect(getDocumentFileRepresentationBindingStoreSnapshot()).toHaveLength(1);
    });
  });

  describe('Fall B: conflict ohne Replace', () => {
    it('andere fileRefId für denselben Natural Key → conflict, Store unverändert', () => {
      hydrateDocumentFileStore([sampleFileRef(FILE_X), sampleFileRef(FILE_Y)], {});
      hydrateDocumentStore([sampleDocument(DOC_A, FILE_X)]);
      hydrateDocumentFileRepresentationBindingStore([
        createDocumentFileRepresentationBinding({
          documentId: DOC_A,
          kind: 'archive',
          fileRefId: FILE_Y,
        }),
      ]);

      // Document original is X, but existing binding points to Y → conflict path via register
      // Writer requires plan.sourceFileRefId === document.fileRefId, so use a direct register scenario:
      // Seed conflict by calling persist when store already has archive→Y and we request archive→X
      // First align document to Y so we can create Y binding... simpler: seed store with archive→Y
      // then change approach - call register path through persist with matching doc fileRef X
      // but store has archive→Y for DOC_A → conflict

      const result = persistSourceReuseArchiveRepresentationBinding({
        documentId: DOC_A,
        plan: sourceReusePlan(FILE_X),
      });

      expect(result.kind).toBe('conflict');
      if (result.kind !== 'conflict') return;
      expect(result.existingBinding.fileRefId).toBe(FILE_Y);
      expect(result.requestedBinding.fileRefId).toBe(FILE_X);
      expect(getDocumentFileRepresentationBindingStoreSnapshot()).toEqual([
        {
          documentId: DOC_A,
          kind: 'archive',
          fileRefId: FILE_Y,
        },
      ]);
    });
  });

  describe('Fall C: Duplicate-Reuse dokumentbezogen', () => {
    it('zwei Dokumente mit derselben FileRef erhalten getrennte Archive-Bindings', () => {
      hydrateDocumentFileStore([sampleFileRef(FILE_X)], {});
      hydrateDocumentStore([
        sampleDocument(DOC_A, FILE_X),
        sampleDocument(DOC_B, FILE_X),
      ]);

      const a = persistSourceReuseArchiveRepresentationBinding({
        documentId: DOC_A,
        plan: sourceReusePlan(FILE_X),
      });
      const b = persistSourceReuseArchiveRepresentationBinding({
        documentId: DOC_B,
        plan: sourceReusePlan(FILE_X),
      });

      expect(a.kind).toBe('created');
      expect(b.kind).toBe('created');
      expect(getDocumentFileRepresentationBindingStoreSnapshot()).toEqual([
        { documentId: DOC_A, kind: 'archive', fileRefId: FILE_X },
        { documentId: DOC_B, kind: 'archive', fileRefId: FILE_X },
      ]);
    });
  });

  describe('Fall D: Hydrate / Snapshot / Seed', () => {
    it('Seed enthält leeres Binding-Array; Hydrate stellt Bindings wieder her', () => {
      const seed = createSeedState();
      expect(seed.documentFileRepresentationBindings).toEqual([]);

      const binding = createDocumentFileRepresentationBinding({
        documentId: DOC_A,
        kind: 'archive',
        fileRefId: FILE_X,
      });
      hydrateDocumentFileRepresentationBindingStore([binding]);
      expect(buildPersistedStateSnapshot().documentFileRepresentationBindings).toEqual([binding]);

      applyStateToStores({
        ...createSeedState(),
        documentFileRepresentationBindings: [binding],
      });
      expect(getDocumentFileRepresentationBindingStoreSnapshot()).toEqual([binding]);
    });
  });

  describe('Fall E: Delete-Cleanup', () => {
    it('deleteDocument entfernt nur Bindings des Dokuments; FileRef-Refcount unverändert für shared reuse', () => {
      hydrateDocumentFileStore([sampleFileRef(FILE_X)], {});
      hydrateDocumentStore([
        sampleDocument(DOC_A, FILE_X),
        sampleDocument(DOC_B, FILE_X),
      ]);
      persistSourceReuseArchiveRepresentationBinding({
        documentId: DOC_A,
        plan: sourceReusePlan(FILE_X),
      });
      persistSourceReuseArchiveRepresentationBinding({
        documentId: DOC_B,
        plan: sourceReusePlan(FILE_X),
      });

      const refsBefore = countActiveReferencesToFileRef(FILE_X);
      expect(refsBefore).toBe(2);

      const deleted = deleteDocument(DOC_A);
      expect(deleted.success).toBe(true);

      expect(getDocumentFileRepresentationBindingStoreSnapshot()).toEqual([
        { documentId: DOC_B, kind: 'archive', fileRefId: FILE_X },
      ]);
      expect(countActiveReferencesToFileRef(FILE_X)).toBe(1);
      expect(getDocumentFileRefStoreSnapshot().some((ref) => ref.id === FILE_X)).toBe(true);
    });
  });

  describe('Fall F: Vertragsverletzungen', () => {
    it('fehlendes Dokument / mismatch / ungültiger Plan → TypeError, Store leer', () => {
      hydrateDocumentFileStore([sampleFileRef(FILE_X)], {});
      hydrateDocumentStore([sampleDocument(DOC_A, FILE_X)]);

      expect(() =>
        persistSourceReuseArchiveRepresentationBinding({
          documentId: 'missing-doc',
          plan: sourceReusePlan(FILE_X),
        }),
      ).toThrow(TypeError);

      expect(() =>
        persistSourceReuseArchiveRepresentationBinding({
          documentId: DOC_A,
          plan: sourceReusePlan(FILE_Y),
        }),
      ).toThrow(TypeError);

      expect(() =>
        persistSourceReuseArchiveRepresentationBinding({
          documentId: DOC_A,
          plan: {
            mode: 'reuse_source_file',
            targetKind: 'preview',
            sourceFileRefId: FILE_X,
          } as unknown as ReturnType<typeof sourceReusePlan>,
        }),
      ).toThrow(TypeError);

      expect(getDocumentFileRepresentationBindingStoreSnapshot()).toEqual([]);
    });
  });

  describe('Fall G: keine Preview/Thumbnail/neue FileRef', () => {
    it('Writer erzeugt nur archive und keine neue FileRef', () => {
      hydrateDocumentFileStore([sampleFileRef(FILE_X)], {});
      hydrateDocumentStore([sampleDocument(DOC_A, FILE_X)]);
      const refsBefore = getDocumentFileRefStoreSnapshot();

      const result = persistSourceReuseArchiveRepresentationBinding({
        documentId: DOC_A,
        plan: sourceReusePlan(FILE_X),
      });

      expect(result.kind).toBe('created');
      if (result.kind !== 'created') return;
      expect(result.binding.kind).toBe('archive');
      expect(getDocumentFileRefStoreSnapshot()).toEqual(refsBefore);
      expect(
        getDocumentFileRepresentationBindingStoreSnapshot().every(
          (entry) => entry.kind === 'archive',
        ),
      ).toBe(true);
    });
  });

  describe('Fall H: FileRef-Lifecycle', () => {
    it('committed → erlaubt', () => {
      hydrateDocumentFileStore([sampleFileRef(FILE_X, 'committed')], {});
      hydrateDocumentStore([sampleDocument(DOC_A, FILE_X)]);

      const result = persistSourceReuseArchiveRepresentationBinding({
        documentId: DOC_A,
        plan: sourceReusePlan(FILE_X),
      });

      expect(result.kind).toBe('created');
      expect(getDocumentFileRepresentationBindingStoreSnapshot()).toHaveLength(1);
    });

    it.each(['temp', 'staged', 'trashed'] as const)(
      '%s → abgelehnt; Registry unverändert und kein persistAll',
      (lifecycleStatus) => {
        hydrateDocumentFileStore([sampleFileRef(FILE_X, lifecycleStatus)], {});
        hydrateDocumentStore([sampleDocument(DOC_A, FILE_X)]);
        hydrateDocumentFileRepresentationBindingStore([
          createDocumentFileRepresentationBinding({
            documentId: DOC_B,
            kind: 'archive',
            fileRefId: FILE_Y,
          }),
        ]);
        const before = getDocumentFileRepresentationBindingStoreSnapshot();
        const persistSpy = vi.spyOn(persistenceService, 'persistAll');

        expect(() =>
          persistSourceReuseArchiveRepresentationBinding({
            documentId: DOC_A,
            plan: sourceReusePlan(FILE_X),
          }),
        ).toThrow(TypeError);

        expect(getDocumentFileRepresentationBindingStoreSnapshot()).toEqual(before);
        expect(persistSpy).not.toHaveBeenCalled();
        persistSpy.mockRestore();
      },
    );
  });
});
