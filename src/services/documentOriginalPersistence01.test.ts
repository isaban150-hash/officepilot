import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getClassificationForItem,
} from './documentClassificationService';
import {
  deleteDocument,
  importInboxDocument,
} from './documentService';
import {
  ensureDocumentBlobsForActiveScope,
  getDocumentFileRefById,
  getDocumentFileRefStoreSnapshot,
  getOriginalDocumentFileBytes,
  resetDocumentFileStoreForTests,
  storeDocumentFileFromUpload,
  verifyDocumentFileIntegrity,
} from './documentFileStoreService';
import { countActiveReferencesToFileRef, releaseDocumentFileIfUnreferenced } from './documentFileReferenceService';
import { intakeCachedDocumentFile } from './documentIntakeService';
import { getInboxStoreSnapshot, hydrateInboxStore } from './inboxService';
import { setImageOcrExtractorForTests } from './ocrDocumentService';
import { setPdfTextExtractorForTests } from './uploadTextExtractionService';
import * as blobDbService from './storage/documentBlobIndexedDbService';
import {
  hasDocumentBlob,
  readDocumentBlob,
  resetDocumentBlobDatabaseForTests,
} from './storage/documentBlobIndexedDbService';
import {
  resetStorageScopeForTests,
  setActiveStorageScope,
} from './storage/storageScopeService';
import type { CachedDocumentFilePayload } from './cachedDocumentFileService';
import { resetTestStores } from '../test/resetStores';
import { computeBufferContentHash } from './documentFileHashService';

const WORKSPACE_A = 'ws-original-a';
const WORKSPACE_B = 'ws-original-b';

function createPayload(bytes: Uint8Array, fileName: string, mimeType = 'application/pdf'): CachedDocumentFilePayload {
  return {
    fileName,
    mimeType,
    fileSize: bytes.length,
    bytes,
  };
}

function sampleBytes(marker: string): Uint8Array {
  return new TextEncoder().encode(`%PDF-1.4\n${marker}\n%%EOF`);
}

describe('P1-DOCUMENT-ORIGINAL-PERSISTENCE-01', () => {
  afterEach(async () => {
    setImageOcrExtractorForTests(null);
    setPdfTextExtractorForTests(null);
    vi.restoreAllMocks();
    resetTestStores();
    resetDocumentFileStoreForTests();
    resetStorageScopeForTests();
    await resetDocumentBlobDatabaseForTests();
  });

  it('speichert Original-Bytes bytegenau in IndexedDB', async () => {
    const original = sampleBytes('ORIGINAL-BYTES-01');
    const payload = createPayload(original, 'rechnung.pdf');

    const result = await intakeCachedDocumentFile(payload, { importSource: 'upload' });
    expect(result.success).toBe(true);
    if (!result.success || result.duplicate) return;

    const stored = await getOriginalDocumentFileBytes(result.fileRef);
    expect(stored).not.toBeNull();
    expect(Array.from(stored!)).toEqual(Array.from(original));
    expect(await verifyDocumentFileIntegrity(result.fileRef)).toBe(true);
  });

  it('hält contentHash nach OCR und Klassifikation stabil', async () => {
    const original = sampleBytes('HASH-STABLE-01');
    const payload = createPayload(original, 'auftrag.pdf');
    const expectedHash = await computeBufferContentHash(original);

    setPdfTextExtractorForTests(() => [
      'Kundenauftrag',
      'Auftragsnummer: AU-2026-023',
      'Auftragswert: 18.750,00 EUR',
    ].join('\n'));

    const result = await intakeCachedDocumentFile(payload, { importSource: 'upload' });
    expect(result.success).toBe(true);
    if (!result.success || result.duplicate) return;

    expect(result.fileRef.contentHash).toBe(expectedHash);
    expect(result.inboxItem.sourceFileHash).toBe(expectedHash);
    expect(await verifyDocumentFileIntegrity(result.fileRef)).toBe(true);
  });

  it('lädt Original nach erneutem Öffnen unverändert', async () => {
    const original = sampleBytes('REOPEN-ORIGINAL-01');
    const intake = await intakeCachedDocumentFile(createPayload(original, 'scan.pdf'), {
      importSource: 'upload',
    });
    expect(intake.success).toBe(true);
    if (!intake.success || intake.duplicate) return;

    const reopenedRef = getDocumentFileRefById(intake.fileRef.id);
    expect(reopenedRef).toBeTruthy();
    const reopenedBytes = await getOriginalDocumentFileBytes(reopenedRef!);
    expect(Array.from(reopenedBytes!)).toEqual(Array.from(original));
  });

  it('speichert gleichen Dateinamen mit unterschiedlichem Inhalt getrennt', async () => {
    const first = await intakeCachedDocumentFile(createPayload(sampleBytes('CONTENT-A'), 'gleich.pdf'));
    const second = await intakeCachedDocumentFile(createPayload(sampleBytes('CONTENT-B'), 'gleich.pdf'));
    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    if (!first.success || first.duplicate || !second.success || second.duplicate) return;

    expect(first.fileRef.id).not.toBe(second.fileRef.id);
    expect(first.fileRef.contentHash).not.toBe(second.fileRef.contentHash);
    expect(getDocumentFileRefStoreSnapshot()).toHaveLength(2);
  });

  it('erkennt identische Dateien und teilt nur die Dateireferenz, nicht den Dokumentdatensatz', async () => {
    const bytes = sampleBytes('DUP-CONTENT');
    const first = await intakeCachedDocumentFile(createPayload(bytes, 'a.pdf'));
    const second = await intakeCachedDocumentFile(createPayload(bytes, 'b.pdf'));
    expect(first.success).toBe(true);
    if (!first.success || first.duplicate) return;
    expect(second.success).toBe(true);
    if (!second.success) return;
    expect(second.duplicate).toBe(true);
    expect(getDocumentFileRefStoreSnapshot()).toHaveLength(1);
    expect(getInboxStoreSnapshot()).toHaveLength(1);
  });

  it('ändert Re-Klassifikation keine Datei-Metadaten', async () => {
    const original = sampleBytes('RECLASSIFY-FILE');
    const intake = await intakeCachedDocumentFile(createPayload(original, 'doc.pdf'), {
      importSource: 'upload',
    });
    expect(intake.success).toBe(true);
    if (!intake.success || intake.duplicate) return;

    const before = { ...getDocumentFileRefById(intake.fileRef.id)! };
    const item = {
      ...intake.inboxItem,
      recognizedData: {
        ...intake.inboxItem.recognizedData,
        Betrag: '3.712,80 EUR',
      },
    };
    getClassificationForItem(item);
    const after = getDocumentFileRefById(before.id)!;

    expect(after.originalFileName).toBe(before.originalFileName);
    expect(after.mimeType).toBe(before.mimeType);
    expect(after.fileSize).toBe(before.fileSize);
    expect(after.contentHash).toBe(before.contentHash);
    expect(after.id).toBe(before.id);
    expect(await verifyDocumentFileIntegrity(after)).toBe(true);
  });

  it('isolates workspace blobs from each other', async () => {
    setActiveStorageScope({ type: 'workspace', workspaceId: WORKSPACE_A });
    const bytesA = sampleBytes('WORKSPACE-A');
    const storedA = await storeDocumentFileFromUpload(new File([bytesA], 'a.pdf', { type: 'application/pdf' }));
    expect(await hasDocumentBlob(storedA.fileRef.id)).toBe(true);

    setActiveStorageScope({ type: 'workspace', workspaceId: WORKSPACE_B });
    expect(await hasDocumentBlob(storedA.fileRef.id)).toBe(false);
    const recordB = await readDocumentBlob(storedA.fileRef.id);
    expect(recordB).toBeNull();
  });

  it('migriert Blobs beim Scope-Wechsel in den aktiven Workspace', async () => {
    setActiveStorageScope({ type: 'user', userId: 'user-1' });
    const bytes = sampleBytes('MIGRATE-ME');
    const stored = await storeDocumentFileFromUpload(new File([bytes], 'migrate.pdf', { type: 'application/pdf' }));

    setActiveStorageScope({ type: 'workspace', workspaceId: WORKSPACE_A });
    const migrated = await ensureDocumentBlobsForActiveScope(
      [stored.fileRef.id],
      [{ type: 'user', userId: 'user-1' }],
    );
    expect(migrated.migrated).toBe(1);
    expect(await hasDocumentBlob(stored.fileRef.id)).toBe(true);
    const reopened = await getOriginalDocumentFileBytes(stored.fileRef);
    expect(Array.from(reopened!)).toEqual(Array.from(bytes));
  });

  it('löscht Original nur wenn keine Referenz mehr existiert', async () => {
    const bytes = sampleBytes('DELETE-ME');
    const intake = await intakeCachedDocumentFile(createPayload(bytes, 'delete.pdf'));
    expect(intake.success).toBe(true);
    if (!intake.success || intake.duplicate) return;

    const imported = importInboxDocument(intake.inboxItem, 'Test GmbH');
    expect(imported.success).toBe(true);
    if (!imported.success) return;

    const doc = imported.document;
    expect(countActiveReferencesToFileRef(intake.fileRef.id)).toBe(2);

    const deleted = deleteDocument(doc.id);
    expect(deleted.success).toBe(true);
    expect(countActiveReferencesToFileRef(intake.fileRef.id)).toBe(1);
    expect(await hasDocumentBlob(intake.fileRef.id)).toBe(true);

    hydrateInboxStore([]);
    expect(countActiveReferencesToFileRef(intake.fileRef.id)).toBe(0);
    const released = await releaseDocumentFileIfUnreferenced(intake.fileRef.id);
    expect(released).toBe(true);
    expect(await hasDocumentBlob(intake.fileRef.id)).toBe(false);
  });

  it('bewahrt mehrseitige PDF vollständig, auch wenn OCR nur Teilinhalte liefert', async () => {
    const multiPagePdf = new TextEncoder().encode(
      '%PDF-1.4\n% PAGE1\n% PAGE2\n% PAGE3\n%%EOF',
    );
    setPdfTextExtractorForTests(() => 'Seite 1 Text nur für OCR');

    const intake = await intakeCachedDocumentFile(createPayload(multiPagePdf, 'multipage.pdf'));
    expect(intake.success).toBe(true);
    if (!intake.success || intake.duplicate) return;

    const stored = await getOriginalDocumentFileBytes(intake.fileRef);
    expect(stored?.length).toBe(multiPagePdf.length);
    expect(Array.from(stored!)).toEqual(Array.from(multiPagePdf));
    expect(Array.from(stored!)).toEqual(Array.from(multiPagePdf));
    expect(new TextDecoder().decode(stored!)).toContain('% PAGE3');
  });

  it('lädt Blob in fremdem Workspace nicht ohne Migration', async () => {
    setActiveStorageScope({ type: 'workspace', workspaceId: WORKSPACE_A });
    const bytes = sampleBytes('NO-CROSS-READ');
    const stored = await storeDocumentFileFromUpload(new File([bytes], 'private.pdf', { type: 'application/pdf' }));

    setActiveStorageScope({ type: 'workspace', workspaceId: WORKSPACE_B });
    const foreignBytes = await getOriginalDocumentFileBytes(stored.fileRef);
    expect(foreignBytes).toBeNull();
  });

  it('bricht Intake ab wenn Originalspeicherung fehlschlägt', async () => {
    vi.spyOn(blobDbService, 'saveDocumentBlob').mockRejectedValueOnce(
      new blobDbService.DocumentBlobStorageError('blob_write_failed'),
    );

    const result = await intakeCachedDocumentFile(createPayload(sampleBytes('FAIL'), 'fail.pdf'));
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toBe('blob_write_failed');
    expect(getInboxStoreSnapshot()).toHaveLength(0);
  });
});
