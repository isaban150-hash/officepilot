import { afterEach, describe, expect, it, vi } from 'vitest';
import { intakeCachedDocumentFile } from './documentIntakeService';
import {
  getDocumentFileBlobStoreSnapshot,
  getDocumentFileRefStoreSnapshot,
  hydrateDocumentFileStore,
} from './documentFileStoreService';
import { getInboxStoreSnapshot, hydrateInboxStore } from './inboxService';
import { setImageOcrExtractorForTests } from './ocrDocumentService';
import { resetTestStores } from '../test/resetStores';
import * as persistenceService from './persistenceService';
import { buildPersistedStateSnapshot } from './persistenceService';
import { hasDocumentBlob, readDocumentBlob } from './storage/documentBlobIndexedDbService';
import type { CachedDocumentFilePayload } from './cachedDocumentFileService';
import type { DocumentFileRef } from '../types/documentFileRef';
import type { InboxItem } from '../types/models';

const AOK_TEXT = 'AOK Beitragsbescheid 250,00 EUR Frist 15.08.2026';

function createPayload(content: string | Uint8Array, name: string, mimeType = 'image/png'): CachedDocumentFilePayload {
  const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content;
  return {
    fileName: name,
    mimeType,
    fileSize: bytes.length,
    bytes,
  };
}

function seedExistingInboxItem(): InboxItem {
  return {
    id: 'inbox-existing',
    title: 'Bestehend',
    status: 'neu',
    priority: 'mittel',
    kind: 'auftrag',
    digitalFolder: { id: 'dig-existing', name: 'Eingang', path: '/Eingang/' },
    paperFiling: { folderId: 'folder-existing', register: 'A', label: 'Alt' },
    recognizedData: { text: 'Alt' },
    createdAt: '2026-03-01T10:00:00.000Z',
    updatedAt: '2026-03-01T10:00:00.000Z',
  };
}

function seedExistingFileRef(): { ref: DocumentFileRef; blob: string } {
  const ref: DocumentFileRef = {
    id: 'file-ref-existing',
    originalFileName: 'existing.png',
    mimeType: 'image/png',
    fileSize: 4,
    contentHash: 'existing-hash',
    storageType: 'local_data_url',
    localDataKey: 'blob-existing',
    createdAt: '2026-03-01T10:00:00.000Z',
  };
  return { ref, blob: 'data:image/png;base64,ZXhpdA==' };
}

describe('MOBILE-PERSIST-DIAG-01 intake rollback', () => {
  afterEach(() => {
    setImageOcrExtractorForTests(null);
    vi.restoreAllMocks();
    resetTestStores();
  });

  it('rolls back new file refs, blobs and inbox items on persist_failed', async () => {
    setImageOcrExtractorForTests(async () => ({ text: AOK_TEXT, confidence: 85 }));
    const existing = seedExistingFileRef();
    hydrateDocumentFileStore([existing.ref], { [existing.ref.localDataKey]: existing.blob });
    hydrateInboxStore([seedExistingInboxItem()]);

    const persistSpy = vi.spyOn(persistenceService, 'persistAll').mockReturnValue({
      success: false,
      failure: { reason: 'quota_exceeded' },
    });

    const payload = createPayload('new-upload-bytes', 'rollback-test.png');
    const result = await intakeCachedDocumentFile(payload, {
      importSource: 'scan',
      recognizedText: AOK_TEXT,
    });

    expect(result.success).toBe(false);
    if (result.success) throw new Error('expected failure');
    expect(result.error).toBe('persist_failed');

    const refs = getDocumentFileRefStoreSnapshot();
    const legacyBlobs = getDocumentFileBlobStoreSnapshot();
    const inbox = getInboxStoreSnapshot();

    expect(refs).toHaveLength(1);
    expect(refs[0].id).toBe('file-ref-existing');
    expect(Object.keys(legacyBlobs)).toEqual(['blob-existing']);
    expect(inbox).toHaveLength(1);
    expect(inbox[0].id).toBe('inbox-existing');
    expect(await hasDocumentBlob(refs.find((ref) => ref.id !== 'file-ref-existing')?.id ?? 'missing')).toBe(false);

    persistSpy.mockRestore();
  });

  it('retry after persist_failed is not treated as duplicate', async () => {
    setImageOcrExtractorForTests(async () => ({ text: AOK_TEXT, confidence: 85 }));
    const payload = createPayload('retry-upload-bytes', 'retry-test.png');

    const persistSpy = vi
      .spyOn(persistenceService, 'persistAll')
      .mockReturnValueOnce({
        success: false,
        failure: { reason: 'quota_exceeded' },
      })
      .mockReturnValueOnce({ success: true });

    const first = await intakeCachedDocumentFile(payload, {
      importSource: 'scan',
      recognizedText: AOK_TEXT,
    });
    expect(first.success).toBe(false);

    const second = await intakeCachedDocumentFile(payload, {
      importSource: 'scan',
      recognizedText: AOK_TEXT,
    });

    expect(second.success).toBe(true);
    if (!second.success || second.duplicate) throw new Error('expected success on retry');
    expect(second.duplicate).toBe(false);
    expect(getInboxStoreSnapshot()).toHaveLength(1);

    persistSpy.mockRestore();
  });

  it('successful persist path stores blob in IndexedDB without legacy data URL', async () => {
    setImageOcrExtractorForTests(async () => ({ text: AOK_TEXT, confidence: 85 }));
    const payload = createPayload('success-path', 'success.png');

    const result = await intakeCachedDocumentFile(payload, {
      importSource: 'scan',
      recognizedText: AOK_TEXT,
    });

    expect(result.success).toBe(true);
    if (!result.success || result.duplicate) throw new Error('expected new inbox item');
    expect(getInboxStoreSnapshot()).toHaveLength(1);
    const refs = getDocumentFileRefStoreSnapshot();
    expect(refs).toHaveLength(1);
    expect(refs[0].storageType).toBe('indexeddb');
    expect(Object.keys(getDocumentFileBlobStoreSnapshot())).toHaveLength(0);
    expect(await hasDocumentBlob(refs[0].id)).toBe(true);
  });
});

describe('PHOTO-STORAGE-IDB-01 localStorage payload size', () => {
  afterEach(() => {
    setImageOcrExtractorForTests(null);
    vi.restoreAllMocks();
    resetTestStores();
  });

  it('große Datei vergrößert serialisierten App-State nur um Metadaten', async () => {
    setImageOcrExtractorForTests(async () => ({ text: AOK_TEXT, confidence: 85 }));

    const smallPayload = createPayload('small', 'small.png');
    const smallResult = await intakeCachedDocumentFile(smallPayload, {
      importSource: 'scan',
      recognizedText: AOK_TEXT,
    });
    expect(smallResult.success).toBe(true);
    const smallJson = JSON.stringify(buildPersistedStateSnapshot()).length;

    const largeBytes = new Uint8Array(512 * 1024);
    largeBytes.fill(97);
    const largePayload = createPayload(largeBytes, 'large.png');
    const largeResult = await intakeCachedDocumentFile(largePayload, {
      importSource: 'scan',
      recognizedText: AOK_TEXT,
    });
    expect(largeResult.success).toBe(true);
    const largeJson = JSON.stringify(buildPersistedStateSnapshot()).length;

    expect(largeJson - smallJson).toBeLessThan(4096);
    expect(JSON.stringify(buildPersistedStateSnapshot())).not.toContain('data:image/png;base64');
  });
});

describe('PHOTO-STORAGE-IDB-01 legacy compatibility', () => {
  afterEach(() => {
    resetTestStores();
  });

  it('liest Legacy-Data-URL weiterhin', async () => {
    const existing = seedExistingFileRef();
    hydrateDocumentFileStore([existing.ref], { [existing.ref.localDataKey]: existing.blob });

    const { getDocumentFileBlob } = await import('./documentFileStoreService');
    const blob = await getDocumentFileBlob(existing.ref);
    expect(blob).not.toBeNull();
    expect(blob?.type).toBe('image/png');
  });
});

describe('PHOTO-STORAGE-IDB-01 blob write failure', () => {
  afterEach(() => {
    setImageOcrExtractorForTests(null);
    vi.restoreAllMocks();
    resetTestStores();
  });

  it('lässt bei IndexedDB-Schreibfehler kein FileRef/InboxItem zurück', async () => {
    setImageOcrExtractorForTests(async () => ({ text: AOK_TEXT, confidence: 85 }));
    const saveSpy = vi.spyOn(await import('./storage/documentBlobIndexedDbService'), 'saveDocumentBlob')
      .mockRejectedValue(new (await import('./storage/documentBlobIndexedDbService')).DocumentBlobStorageError('blob_write_failed'));

    const payload = createPayload('fail-write', 'fail.png');
    const result = await intakeCachedDocumentFile(payload, {
      importSource: 'scan',
      recognizedText: AOK_TEXT,
    });

    expect(result.success).toBe(false);
    if (result.success) throw new Error('expected failure');
    expect(result.error).toBe('blob_write_failed');
    expect(getDocumentFileRefStoreSnapshot()).toHaveLength(0);
    expect(getInboxStoreSnapshot()).toHaveLength(0);

    saveSpy.mockRestore();
  });
});

describe('PHOTO-STORAGE-IDB-01 delete GC', () => {
  afterEach(() => {
    setImageOcrExtractorForTests(null);
    vi.restoreAllMocks();
    resetTestStores();
  });

  it('behält Blob solange noch eine Referenz existiert', async () => {
    setImageOcrExtractorForTests(async () => ({ text: AOK_TEXT, confidence: 85 }));
    const payload = createPayload('shared-content-for-gc', 'shared.png');
    const first = await intakeCachedDocumentFile(payload, {
      importSource: 'scan',
      recognizedText: AOK_TEXT,
    });
    expect(first.success).toBe(true);
    if (!first.success || first.duplicate) throw new Error('expected inbox item');

    const inboxItem = getInboxStoreSnapshot()[0];
    hydrateInboxStore([
      inboxItem,
      {
        ...inboxItem,
        id: 'inbox-second-ref',
        title: 'Zweite Referenz',
      },
    ]);

    const { countActiveReferencesToFileRef, releaseDocumentFileIfUnreferenced } = await import('./documentFileReferenceService');
    expect(countActiveReferencesToFileRef(first.fileRef.id)).toBe(2);

    const released = await releaseDocumentFileIfUnreferenced(first.fileRef.id);
    expect(released).toBe(false);
    expect(await hasDocumentBlob(first.fileRef.id)).toBe(true);
  });

  it('entfernt Blob wenn keine Referenz mehr existiert', async () => {
    setImageOcrExtractorForTests(async () => ({ text: AOK_TEXT, confidence: 85 }));
    const payload = createPayload('delete-when-unreferenced', 'delete.png');
    const result = await intakeCachedDocumentFile(payload, {
      importSource: 'scan',
      recognizedText: AOK_TEXT,
    });
    expect(result.success).toBe(true);
    if (!result.success || result.duplicate) throw new Error('expected inbox item');

    const { releaseDocumentFileIfUnreferenced } = await import('./documentFileReferenceService');
    hydrateInboxStore([]);
    const released = await releaseDocumentFileIfUnreferenced(result.fileRef.id);
    expect(released).toBe(true);
    expect(await hasDocumentBlob(result.fileRef.id)).toBe(false);
  });
});
