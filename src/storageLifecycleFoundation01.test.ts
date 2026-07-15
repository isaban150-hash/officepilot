import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  confirmPendingDocumentIntake,
  discardPendingDocumentIntake,
  processDocumentFileForPreview,
} from './services/pendingDocumentIntakeService';
import {
  getDocumentFileRefStoreSnapshot,
  resetDocumentFileStoreForTests,
} from './services/documentFileStoreService';
import { getInboxStoreSnapshot } from './services/inboxService';
import { setImageOcrExtractorForTests } from './services/ocrDocumentService';
import { setPdfTextExtractorForTests } from './services/uploadTextExtractionService';
import { resetTestStores } from './test/resetStores';
import * as persistenceService from './services/persistenceService';
import {
  hasDocumentBlob,
  resetDocumentBlobDatabaseForTests,
} from './services/storage/documentBlobIndexedDbService';
import type { CachedDocumentFilePayload } from './services/cachedDocumentFileService';
import type { DocumentFileRef } from './types/documentFileRef';
import {
  migratePersistedStateV4ToV5,
  STORAGE_VERSION,
  STORAGE_VERSION_V4,
} from './services/sync/syncMigrationService';
import { createSyncClient } from './services/sync/syncClientService';
import { DEFAULT_SETUP } from './data/mockData';
import type { AppPersistedState } from './types/models';

const SAMPLE_TEXT = 'Rechnung Muster GmbH 1.250,00 EUR';

function createPayload(content: string | Uint8Array, name: string, mimeType = 'application/pdf'): CachedDocumentFilePayload {
  const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content;
  return {
    fileName: name,
    mimeType,
    fileSize: bytes.length,
    bytes,
  };
}

function createFile(payload: CachedDocumentFilePayload): File {
  return new File([payload.bytes], payload.fileName, { type: payload.mimeType });
}

function minimalV4State(fileRefs: DocumentFileRef[]): AppPersistedState {
  const client = createSyncClient('2026-07-15T10:00:00.000Z');
  return {
    version: STORAGE_VERSION_V4,
    setup: DEFAULT_SETUP,
    syncClient: client,
    syncOutbox: [],
    inboxItems: [],
    vorgaenge: [],
    tasks: [],
    documents: [],
    documentFileRefs: fileRefs,
    documentFileBlobs: {},
    savedAt: '2026-07-15T10:00:00.000Z',
  };
}

describe('STORAGE-LIFECYCLE-FOUNDATION-01', () => {
  afterEach(async () => {
    setImageOcrExtractorForTests(null);
    setPdfTextExtractorForTests(null);
    vi.restoreAllMocks();
    resetTestStores();
    resetDocumentFileStoreForTests();
    await resetDocumentBlobDatabaseForTests();
  });

  it('speichert Upload vor Bestätigung nicht in IndexedDB', async () => {
    setPdfTextExtractorForTests(() => SAMPLE_TEXT);
    const payload = createPayload('%PDF-1.4\npending-upload\n%%EOF', 'pending.pdf');
    const file = createFile(payload);

    const preview = await processDocumentFileForPreview(file);
    expect(preview.success).toBe(true);
    if (!preview.success) return;

    expect(getDocumentFileRefStoreSnapshot()).toHaveLength(0);
    expect(getInboxStoreSnapshot()).toHaveLength(0);
    expect(await hasDocumentBlob('any-id')).toBe(false);

    discardPendingDocumentIntake(preview.pending);
  });

  it('nimmt Upload vor Bestätigung nicht in Inbox oder Dokumentliste auf', async () => {
    setPdfTextExtractorForTests(() => SAMPLE_TEXT);
    const payload = createPayload('%PDF-1.4\ninbox-pending\n%%EOF', 'inbox-pending.pdf');

    const preview = await processDocumentFileForPreview(createFile(payload));
    expect(preview.success).toBe(true);
    if (!preview.success) return;

    expect(getInboxStoreSnapshot()).toHaveLength(0);
    expect(getDocumentFileRefStoreSnapshot()).toHaveLength(0);

    discardPendingDocumentIntake(preview.pending);
  });

  it('speichert nach Bestätigung Datei und Metadaten genau einmal', async () => {
    setPdfTextExtractorForTests(() => SAMPLE_TEXT);
    const payload = createPayload('%PDF-1.4\nconfirm-once\n%%EOF', 'confirm-once.pdf');
    const preview = await processDocumentFileForPreview(createFile(payload));
    expect(preview.success).toBe(true);
    if (!preview.success) return;

    const result = await confirmPendingDocumentIntake(preview.pending, { importSource: 'upload' });
    expect(result.success).toBe(true);
    if (!result.success || result.duplicate) return;

    expect(getDocumentFileRefStoreSnapshot()).toHaveLength(1);
    expect(getInboxStoreSnapshot()).toHaveLength(1);
    expect(result.fileRef.lifecycleStatus).toBe('committed');
    expect(result.fileRef.committedAt).toBeDefined();
    expect(await hasDocumentBlob(result.fileRef.id)).toBe(true);
  });

  it('verwirft Upload bei Abbruch vollständig', async () => {
    setPdfTextExtractorForTests(() => SAMPLE_TEXT);
    const payload = createPayload('%PDF-1.4\ndiscard-upload\n%%EOF', 'discard.pdf');
    const preview = await processDocumentFileForPreview(createFile(payload));
    expect(preview.success).toBe(true);
    if (!preview.success) return;

    discardPendingDocumentIntake(preview.pending);

    expect(getDocumentFileRefStoreSnapshot()).toHaveLength(0);
    expect(getInboxStoreSnapshot()).toHaveLength(0);
    expect(await hasDocumentBlob('discard')).toBe(false);
  });

  it('erzeugt keine Dublette bei doppelter Bestätigung', async () => {
    setPdfTextExtractorForTests(() => SAMPLE_TEXT);
    const payload = createPayload('%PDF-1.4\ndouble-confirm\n%%EOF', 'double-confirm.pdf');
    const preview = await processDocumentFileForPreview(createFile(payload));
    expect(preview.success).toBe(true);
    if (!preview.success) return;

    const first = await confirmPendingDocumentIntake(preview.pending, { importSource: 'upload' });
    expect(first.success).toBe(true);
    if (!first.success || first.duplicate) return;

    const second = await confirmPendingDocumentIntake(preview.pending, { importSource: 'upload' });
    expect(second.success).toBe(true);
    if (!second.success) return;
    expect(second.duplicate).toBe(true);

    expect(getDocumentFileRefStoreSnapshot()).toHaveLength(1);
    expect(getInboxStoreSnapshot()).toHaveLength(1);
  });

  it('führt bei Persistenzfehler zu sauberem Rollback', async () => {
    setPdfTextExtractorForTests(() => SAMPLE_TEXT);
    const persistSpy = vi.spyOn(persistenceService, 'persistAll').mockReturnValue({
      success: false,
      failure: { reason: 'quota_exceeded' },
    });

    const payload = createPayload('%PDF-1.4\nrollback-upload\n%%EOF', 'rollback.pdf');
    const preview = await processDocumentFileForPreview(createFile(payload));
    expect(preview.success).toBe(true);
    if (!preview.success) return;

    const result = await confirmPendingDocumentIntake(preview.pending, { importSource: 'upload' });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toBe('persist_failed');
    expect(getDocumentFileRefStoreSnapshot()).toHaveLength(0);
    expect(getInboxStoreSnapshot()).toHaveLength(0);

    persistSpy.mockRestore();
  });

  it('nutzt für Scan und Upload denselben Lifecycle', async () => {
    setPdfTextExtractorForTests(() => SAMPLE_TEXT);
    const scanPayload = createPayload('%PDF-1.4\nscan-flow\n%%EOF', 'scan-flow.pdf');
    const uploadPayload = createPayload('%PDF-1.4\nupload-flow\n%%EOF', 'upload-flow.pdf');

    const scanPreview = await processDocumentFileForPreview(createFile(scanPayload));
    const uploadPreview = await processDocumentFileForPreview(createFile(uploadPayload));
    expect(scanPreview.success).toBe(true);
    expect(uploadPreview.success).toBe(true);
    if (!scanPreview.success || !uploadPreview.success) return;

    expect(getDocumentFileRefStoreSnapshot()).toHaveLength(0);

    const scanResult = await confirmPendingDocumentIntake(scanPreview.pending, { importSource: 'scan' });
    const uploadResult = await confirmPendingDocumentIntake(uploadPreview.pending, { importSource: 'upload' });

    expect(scanResult.success).toBe(true);
    expect(uploadResult.success).toBe(true);
    if (!scanResult.success || scanResult.duplicate) return;
    if (!uploadResult.success || uploadResult.duplicate) return;

    expect(scanResult.fileRef.lifecycleStatus).toBe('committed');
    expect(uploadResult.fileRef.lifecycleStatus).toBe('committed');
    expect(getDocumentFileRefStoreSnapshot()).toHaveLength(2);
  });

  it('setzt Migration v4→v5 bestehende Dateien auf committed', () => {
    const legacyRef = {
      id: 'legacy-ref-1',
      originalFileName: 'legacy.pdf',
      mimeType: 'application/pdf',
      fileSize: 1024,
      contentHash: 'hash-legacy-1',
      storageType: 'indexeddb' as const,
      localDataKey: 'legacy-ref-1',
      createdAt: '2026-03-01T08:00:00.000Z',
    } satisfies Omit<DocumentFileRef, 'lifecycleStatus' | 'committedAt' | 'expiresAt'>;

    const migrated = migratePersistedStateV4ToV5(minimalV4State([legacyRef as DocumentFileRef]));
    expect(migrated.version).toBe(STORAGE_VERSION);
    expect(migrated.documentFileRefs).toHaveLength(1);
    expect(migrated.documentFileRefs![0].lifecycleStatus).toBe('committed');
    expect(migrated.documentFileRefs![0].committedAt).toBe('2026-03-01T08:00:00.000Z');
  });
});
