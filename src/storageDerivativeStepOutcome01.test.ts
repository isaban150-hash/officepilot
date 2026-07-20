import { afterEach, describe, expect, it, vi } from 'vitest';
import * as persistenceService from './services/persistenceService';
import {
  applyStateToStores,
  buildPersistedStateSnapshot,
  createSeedState,
} from './services/persistenceService';
import {
  orchestratePostImportDerivativesAfterImport,
  POST_IMPORT_DERIVATIVE_STEP_IDS,
  setPostImportDerivativeStepRunnersForTests,
} from './services/documentFilePostImportDerivativeOrchestrationService';
import {
  findDocumentFileDerivativeStepOutcome,
  getDocumentFileDerivativeStepOutcomeStoreSnapshot,
  resetDocumentFileDerivativeStepOutcomeStoreForTests,
} from './services/documentFileDerivativeStepOutcomeStoreService';
import * as outcomeService from './services/documentFileDerivativeStepOutcomeService';
import { deleteDocument, hydrateDocumentStore } from './services/documentService';
import {
  resetDocumentFileStoreForTests,
  storeDocumentFileFromCachedPayload,
} from './services/documentFileStoreService';
import { withNewEntitySync } from './services/sync/syncMetaService';
import { resetTestStores } from './test/resetStores';
import type { CompanyDocument } from './types/models';
import type { PostImportDerivativeStepId } from './types/documentFileDerivativeStepOutcome';

const DOC_A = 'doc-derivative-step-outcome-a';
const DOC_B = 'doc-derivative-step-outcome-b';
const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4f]);

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

function noopRunners(
  overrides: Partial<Record<PostImportDerivativeStepId, () => Promise<unknown>>> = {},
): Partial<Record<PostImportDerivativeStepId, () => Promise<unknown>>> {
  const base = Object.fromEntries(
    POST_IMPORT_DERIVATIVE_STEP_IDS.map((stepId) => [
      stepId,
      async () => ({ kind: 'noop', reason: 'missing_transform_plan' }),
    ]),
  ) as Record<PostImportDerivativeStepId, () => Promise<unknown>>;
  return { ...base, ...overrides };
}

afterEach(() => {
  vi.restoreAllMocks();
  setPostImportDerivativeStepRunnersForTests(null);
  resetTestStores();
  resetDocumentFileStoreForTests();
  resetDocumentFileDerivativeStepOutcomeStoreForTests();
});

describe('STORAGE-DERIVATIVE-STEP-OUTCOME-01', () => {
  it('speichert persisted/noop/conflict/error Outcomes', async () => {
    const source = await storeDocumentFileFromCachedPayload(
      {
        fileName: 'source.jpg',
        mimeType: 'image/jpeg',
        fileSize: JPEG_BYTES.byteLength,
        bytes: JPEG_BYTES,
      },
      { lifecycleIntent: 'committed' },
    );
    hydrateDocumentStore([sampleDocument(DOC_A, source.fileRef.id)]);

    setPostImportDerivativeStepRunnersForTests(
      noopRunners({
        raster_archive: async () => ({
          kind: 'persisted',
          registration: 'created',
          archiveFileRefId: 'file-archive-result',
          createdArchiveFileRef: true,
        }),
        image_to_pdf_archive: async () => ({ kind: 'noop', reason: 'no_archive_intent' }),
        pdf_metadata_strip: async () => ({ kind: 'conflict' }),
        raster_thumbnail: async () => ({
          kind: 'error',
          error: new Error('secret path C:\\Users\\secret\\doc.bin with bytes'),
        }),
      }),
    );

    await orchestratePostImportDerivativesAfterImport({
      documentId: DOC_A,
      transformPlan: null,
    });

    const persisted = findDocumentFileDerivativeStepOutcome(DOC_A, 'raster_archive');
    expect(persisted).toMatchObject({
      documentId: DOC_A,
      stepId: 'raster_archive',
      representationKind: 'archive',
      outcome: 'persisted',
      registrationStatus: 'created',
      sourceFileRefId: source.fileRef.id,
      sourceMimeType: 'image/jpeg',
      resultFileRefId: 'file-archive-result',
      createdFileRef: true,
      attempt: 1,
    });
    expect(persisted?.noopReason).toBeUndefined();
    expect(persisted?.errorCode).toBeUndefined();

    expect(findDocumentFileDerivativeStepOutcome(DOC_A, 'image_to_pdf_archive')).toMatchObject({
      outcome: 'noop',
      noopReason: 'no_archive_intent',
      representationKind: 'archive',
      createdFileRef: false,
      attempt: 1,
    });

    expect(findDocumentFileDerivativeStepOutcome(DOC_A, 'pdf_metadata_strip')).toMatchObject({
      outcome: 'conflict',
      createdFileRef: false,
      attempt: 1,
    });

    const errored = findDocumentFileDerivativeStepOutcome(DOC_A, 'raster_thumbnail');
    expect(errored).toMatchObject({
      outcome: 'error',
      errorCode: 'orchestrator_error',
      representationKind: 'thumbnail',
      attempt: 1,
    });
    expect(JSON.stringify(errored)).not.toMatch(/secret|doc\.bin|bytes/i);

    expect(getDocumentFileDerivativeStepOutcomeStoreSnapshot()).toHaveLength(
      POST_IMPORT_DERIVATIVE_STEP_IDS.length,
    );
  });

  it('erhöht attempt bei Natural-Key-Update ohne Duplikat', async () => {
    hydrateDocumentStore([sampleDocument(DOC_A, 'file-src')]);
    setPostImportDerivativeStepRunnersForTests(noopRunners());

    await orchestratePostImportDerivativesAfterImport({
      documentId: DOC_A,
      transformPlan: null,
    });
    await orchestratePostImportDerivativesAfterImport({
      documentId: DOC_A,
      transformPlan: null,
    });

    const snapshots = getDocumentFileDerivativeStepOutcomeStoreSnapshot().filter(
      (entry) => entry.documentId === DOC_A,
    );
    expect(snapshots).toHaveLength(POST_IMPORT_DERIVATIVE_STEP_IDS.length);
    expect(snapshots.every((entry) => entry.attempt === 2)).toBe(true);
    expect(findDocumentFileDerivativeStepOutcome(DOC_A, 'raster_preview')?.outcome).toBe('noop');
  });

  it('lädt alte Persistenzstände ohne Outcome-Feld als leeren Store', () => {
    const seed = createSeedState();
    const { documentFileDerivativeStepOutcomes: _omit, ...legacy } = seed;
    applyStateToStores(legacy as typeof seed);
    expect(getDocumentFileDerivativeStepOutcomeStoreSnapshot()).toEqual([]);
    expect(buildPersistedStateSnapshot().documentFileDerivativeStepOutcomes).toEqual([]);
  });

  it('entfernt Outcomes bei Dokumentlöschung', async () => {
    const source = await storeDocumentFileFromCachedPayload(
      {
        fileName: 'delete-me.jpg',
        mimeType: 'image/jpeg',
        fileSize: JPEG_BYTES.byteLength,
        bytes: JPEG_BYTES,
      },
      { lifecycleIntent: 'committed' },
    );
    hydrateDocumentStore([
      sampleDocument(DOC_A, source.fileRef.id),
      sampleDocument(DOC_B, source.fileRef.id),
    ]);
    setPostImportDerivativeStepRunnersForTests(noopRunners());

    await orchestratePostImportDerivativesAfterImport({
      documentId: DOC_A,
      transformPlan: null,
    });
    await orchestratePostImportDerivativesAfterImport({
      documentId: DOC_B,
      transformPlan: null,
    });

    expect(
      getDocumentFileDerivativeStepOutcomeStoreSnapshot().some((e) => e.documentId === DOC_A),
    ).toBe(true);

    const deleted = deleteDocument(DOC_A);
    expect(deleted.success).toBe(true);
    expect(
      getDocumentFileDerivativeStepOutcomeStoreSnapshot().some((e) => e.documentId === DOC_A),
    ).toBe(false);
    expect(
      getDocumentFileDerivativeStepOutcomeStoreSnapshot().some((e) => e.documentId === DOC_B),
    ).toBe(true);
  });

  it('persistiert keine sensitiven Fehlerdaten und loggt nur Step-ID plus Codes', async () => {
    hydrateDocumentStore([sampleDocument(DOC_A, 'file-src')]);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    setPostImportDerivativeStepRunnersForTests(
      noopRunners({
        raster_archive: async () => {
          throw new Error('SENSITIVE_STACK /home/user/secret.pdf payload=deadbeef');
        },
      }),
    );

    await orchestratePostImportDerivativesAfterImport({
      documentId: DOC_A,
      transformPlan: null,
    });

    const stored = findDocumentFileDerivativeStepOutcome(DOC_A, 'raster_archive');
    expect(stored).toMatchObject({
      outcome: 'error',
      errorCode: 'runner_threw',
    });
    expect(JSON.stringify(getDocumentFileDerivativeStepOutcomeStoreSnapshot())).not.toMatch(
      /SENSITIVE_STACK|secret\.pdf|deadbeef/,
    );

    const logged = errorSpy.mock.calls.flat().map(String).join(' ');
    expect(logged).toContain('raster_archive');
    expect(logged).toContain('runner_threw');
    expect(logged).not.toMatch(/SENSITIVE_STACK|secret\.pdf|deadbeef/);
  });

  it('Outcome-Persistenzfehler stoppt Coordinator und Folgeschritte nicht', async () => {
    hydrateDocumentStore([sampleDocument(DOC_A, 'file-src')]);
    const order: PostImportDerivativeStepId[] = [];
    setPostImportDerivativeStepRunnersForTests(
      Object.fromEntries(
        POST_IMPORT_DERIVATIVE_STEP_IDS.map((stepId) => [
          stepId,
          async () => {
            order.push(stepId);
            return { kind: 'noop', reason: 'missing_transform_plan' };
          },
        ]),
      ) as Record<PostImportDerivativeStepId, () => Promise<unknown>>,
    );

    vi.spyOn(outcomeService, 'recordPostImportDerivativeStepOutcome').mockImplementation(() => {
      throw new Error('outcome persist boom');
    });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const result = await orchestratePostImportDerivativesAfterImport({
      documentId: DOC_A,
      transformPlan: null,
    });

    expect(order).toEqual([...POST_IMPORT_DERIVATIVE_STEP_IDS]);
    expect(result.steps).toHaveLength(POST_IMPORT_DERIVATIVE_STEP_IDS.length);
    expect(result.steps.every((step) => step.outcome === 'completed')).toBe(true);
  });

  it('schreibt Outcomes in AppPersistedState Snapshot', async () => {
    hydrateDocumentStore([sampleDocument(DOC_A, 'file-src')]);
    setPostImportDerivativeStepRunnersForTests(noopRunners());
    vi.spyOn(persistenceService, 'persistAll').mockReturnValue({ success: true });

    await orchestratePostImportDerivativesAfterImport({
      documentId: DOC_A,
      transformPlan: null,
    });

    expect(buildPersistedStateSnapshot().documentFileDerivativeStepOutcomes).toHaveLength(
      POST_IMPORT_DERIVATIVE_STEP_IDS.length,
    );
  });
});
