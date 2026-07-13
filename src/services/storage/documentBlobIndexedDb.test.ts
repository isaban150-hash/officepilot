import { describe, expect, it } from 'vitest';
import {
  deleteDocumentBlob,
  hasDocumentBlob,
  readDocumentBlob,
  saveDocumentBlob,
} from './documentBlobIndexedDbService';
import { buildDocumentBlobRecordId, buildDocumentBlobScopeKey } from './documentBlobScopeService';
import { setActiveStorageScope } from './storageScopeService';

async function readBlobBytes(blob: Blob): Promise<Uint8Array> {
  if (typeof blob.arrayBuffer === 'function') {
    return new Uint8Array(await blob.arrayBuffer());
  }
  return new Uint8Array(await new Response(blob).arrayBuffer());
}

describe('PHOTO-STORAGE-IDB-01 IndexedDB blob store', () => {  it('speichert und liest Blob mit identischem Inhalt und MIME-Type', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    const blob = new Blob([bytes], { type: 'image/jpeg' });

    await saveDocumentBlob({
      fileRefId: 'file-ref-1',
      blob,
      mimeType: 'image/jpeg',
      fileSize: blob.size,
      contentHash: 'abc123',
      createdAt: '2026-07-13T10:00:00.000Z',
    });

    const record = await readDocumentBlob('file-ref-1');
    expect(record).not.toBeNull();
    expect(record?.mimeType).toBe('image/jpeg');
    expect(record?.fileSize).toBe(blob.size);
    expect(record?.contentHash).toBe('abc123');

    const loadedBytes = await readBlobBytes(record!.blob);    expect(loadedBytes).toEqual(bytes);
  });

  it('meldet fehlenden Blob als null', async () => {
    expect(await readDocumentBlob('missing-ref')).toBeNull();
    expect(await hasDocumentBlob('missing-ref')).toBe(false);
  });

  it('löscht gespeicherten Blob', async () => {
    await saveDocumentBlob({
      fileRefId: 'file-ref-delete',
      blob: new Blob(['delete-me'], { type: 'text/plain' }),
      mimeType: 'text/plain',
      fileSize: 8,
      contentHash: 'delete-hash',
      createdAt: '2026-07-13T10:00:00.000Z',
    });

    expect(await hasDocumentBlob('file-ref-delete')).toBe(true);
    await deleteDocumentBlob('file-ref-delete');
    expect(await hasDocumentBlob('file-ref-delete')).toBe(false);
  });
});

describe('PHOTO-STORAGE-IDB-01 scope isolation', () => {
  it('trennt Blobs nach Nutzer', async () => {
    setActiveStorageScope({ type: 'user', userId: 'user-a' });
    await saveDocumentBlob({
      fileRefId: 'shared-ref-id',
      blob: new Blob(['user-a'], { type: 'image/png' }),
      mimeType: 'image/png',
      fileSize: 6,
      contentHash: 'hash-a',
      createdAt: '2026-07-13T10:00:00.000Z',
    });

    setActiveStorageScope({ type: 'user', userId: 'user-b' });
    expect(await readDocumentBlob('shared-ref-id')).toBeNull();

    await saveDocumentBlob({
      fileRefId: 'shared-ref-id',
      blob: new Blob(['user-b'], { type: 'image/png' }),
      mimeType: 'image/png',
      fileSize: 6,
      contentHash: 'hash-b',
      createdAt: '2026-07-13T10:00:00.000Z',
    });

    setActiveStorageScope({ type: 'user', userId: 'user-a' });
    const userA = await readDocumentBlob('shared-ref-id');
    expect(userA?.contentHash).toBe('hash-a');

    setActiveStorageScope({ type: 'user', userId: 'user-b' });
    const userB = await readDocumentBlob('shared-ref-id');
    expect(userB?.contentHash).toBe('hash-b');
  });

  it('trennt Blobs nach Workspace', async () => {
    setActiveStorageScope({ type: 'workspace', workspaceId: 'ws-a' });
    await saveDocumentBlob({
      fileRefId: 'ws-ref',
      blob: new Blob(['ws-a'], { type: 'application/pdf' }),
      mimeType: 'application/pdf',
      fileSize: 4,
      contentHash: 'ws-a-hash',
      createdAt: '2026-07-13T10:00:00.000Z',
    });

    setActiveStorageScope({ type: 'workspace', workspaceId: 'ws-b' });
    expect(await readDocumentBlob('ws-ref')).toBeNull();
    expect(buildDocumentBlobRecordId(buildDocumentBlobScopeKey({ type: 'workspace', workspaceId: 'ws-a' }), 'ws-ref'))
      .not.toBe(buildDocumentBlobRecordId(buildDocumentBlobScopeKey({ type: 'workspace', workspaceId: 'ws-b' }), 'ws-ref'));
  });

  it('trennt Gast von angemeldetem Nutzer', async () => {
    setActiveStorageScope({ type: 'guest' });
    await saveDocumentBlob({
      fileRefId: 'guest-ref',
      blob: new Blob(['guest'], { type: 'image/png' }),
      mimeType: 'image/png',
      fileSize: 5,
      contentHash: 'guest-hash',
      createdAt: '2026-07-13T10:00:00.000Z',
    });

    setActiveStorageScope({ type: 'user', userId: 'logged-in' });
    expect(await readDocumentBlob('guest-ref')).toBeNull();
  });
});
