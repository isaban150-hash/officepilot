import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import JSZip from 'jszip';
import {
  assertBackupAppStateHasNoSecrets,
  buildBackupFilename,
  buildLocalBackupBundle,
  buildSanitizedBackupAppState,
  downloadBackupBlob,
  exportLocalBackupBundle,
} from './backupExportService';
import { buildPersistedStateSnapshot } from './persistenceService';
import {
  getDocumentFileBlob,
  getDocumentFileRefStoreSnapshot,
  storeDocumentFileFromUpload,
} from './documentFileStoreService';
import {
  getDocumentFileRepresentationBindingStoreSnapshot,
  replaceDocumentFileRepresentationBindingStore,
} from './documentFileRepresentationBindingStoreService';
import { createDocumentFileRepresentationBinding } from './documentFileRepresentationBindingService';
import { deleteDocumentBlob } from './storage/documentBlobIndexedDbService';
import { resetTestStores } from '../test/resetStores';
import { BACKUP_SCHEMA_VERSION } from '../types/backupExport';

describe('backupExportService', () => {
  beforeEach(() => {
    resetTestStores();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('buildBackupFilename is safe and deterministic for a fixed timestamp', () => {
    const when = new Date(2026, 6, 17, 14, 5, 30);
    expect(buildBackupFilename(when)).toBe('OfficePilot_Backup_2026-07-17_14-05.zip');
  });

  it('sanitized app state excludes syncOutbox, inline blobs, and secret-like fields', () => {
    const snap = buildPersistedStateSnapshot();
    const sanitized = buildSanitizedBackupAppState({
      ...snap,
      syncOutbox: [
        {
          id: 'o1',
          entityType: 'document',
          entityId: 'd1',
          operation: 'create',
          version: 1,
          queuedAt: '2026-01-01T00:00:00.000Z',
          retryCount: 0,
          status: 'pending',
        },
      ],
      documentFileBlobs: { 'file-1': 'data:application/pdf;base64,AAAA' },
    });

    expect(sanitized.syncOutbox).toBeUndefined();
    expect(sanitized.documentFileBlobs).toBeUndefined();
    assertBackupAppStateHasNoSecrets(sanitized);
  });

  it('bundle contains manifest, app-state, and all required blobs including derived reps', async () => {
    const { fileRef: original } = await storeDocumentFileFromUpload(
      new File([new Uint8Array([1, 2, 3])], 'invoice.pdf', { type: 'application/pdf' }),
    );
    const { fileRef: archive } = await storeDocumentFileFromUpload(
      new File([new Uint8Array([4, 5])], 'invoice-archive.pdf', { type: 'application/pdf' }),
    );
    const { fileRef: preview } = await storeDocumentFileFromUpload(
      new File([new Uint8Array([6])], 'invoice-preview.png', { type: 'image/png' }),
    );
    const { fileRef: thumb } = await storeDocumentFileFromUpload(
      new File([new Uint8Array([7])], 'invoice-thumb.png', { type: 'image/png' }),
    );

    replaceDocumentFileRepresentationBindingStore([
      createDocumentFileRepresentationBinding({
        documentId: 'doc-1',
        kind: 'archive',
        fileRefId: archive.id,
      }),
      createDocumentFileRepresentationBinding({
        documentId: 'doc-1',
        kind: 'preview',
        fileRefId: preview.id,
      }),
      createDocumentFileRepresentationBinding({
        documentId: 'doc-1',
        kind: 'thumbnail',
        fileRefId: thumb.id,
      }),
    ]);

    const refsBefore = getDocumentFileRefStoreSnapshot()
      .map((r) => r.id)
      .sort();
    const bindingsBefore = getDocumentFileRepresentationBindingStoreSnapshot().length;

    const when = new Date(2026, 0, 15, 9, 30);
    const built = await buildLocalBackupBundle(when);
    expect(built.ok).toBe(true);
    if (!built.ok) return;

    expect(built.artifacts.filename).toBe('OfficePilot_Backup_2026-01-15_09-30.zip');
    expect(built.artifacts.manifest.schemaVersion).toBe(BACKUP_SCHEMA_VERSION);
    expect(built.artifacts.manifest.fileCount).toBe(4);
    expect(built.artifacts.manifest.files).toHaveLength(4);
    expect(built.artifacts.manifest.exportedAt).toBe(when.toISOString());
    expect(built.artifacts.manifest.recordCounts.documentFileRefs).toBe(4);
    expect(built.artifacts.manifest.recordCounts.documentFileRepresentationBindings).toBe(3);

    for (const id of [original.id, archive.id, preview.id, thumb.id]) {
      const entry = built.artifacts.manifest.files.find((f) => f.fileRefId === id);
      expect(entry).toBeDefined();
      expect(entry!.path).toBe(`files/${id}`);
      expect(entry!.fileSize).toBeGreaterThan(0);
      expect(entry!.mimeType).toBeTruthy();
    }

    const zip = await JSZip.loadAsync(built.artifacts.zipBlob);
    expect(zip.file('manifest.json')).toBeTruthy();
    expect(zip.file('app-state.json')).toBeTruthy();
    for (const id of [original.id, archive.id, preview.id, thumb.id]) {
      const entry = zip.file(`files/${id}`);
      expect(entry).toBeTruthy();
      const bytes = await entry!.async('uint8array');
      expect(bytes.byteLength).toBeGreaterThan(0);
    }

    const appStateJson = await zip.file('app-state.json')!.async('string');
    const appState = JSON.parse(appStateJson);
    expect(appState.syncOutbox).toBeUndefined();
    expect(appState.documentFileBlobs).toBeUndefined();
    assertBackupAppStateHasNoSecrets(appState);

    expect(
      getDocumentFileRefStoreSnapshot()
        .map((r) => r.id)
        .sort(),
    ).toEqual(refsBefore);
    expect(getDocumentFileRepresentationBindingStoreSnapshot().length).toBe(bindingsBefore);
  });

  it('missing required blob prevents a complete export', async () => {
    const { fileRef: ref } = await storeDocumentFileFromUpload(
      new File([new Uint8Array([9, 9])], 'missing-later.pdf', { type: 'application/pdf' }),
    );

    await deleteDocumentBlob(ref.id);

    const built = await buildLocalBackupBundle();
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.reason).toBe('missing_blob');
    expect(built.errorKey).toBe('backup.error.missingFile');
    expect(built.errorKey).not.toContain(ref.id);
    expect(built.errorKey).not.toContain('missing-later');
  });

  it('exportLocalBackupBundle downloads only when invoked (user action) and revokes object URL', async () => {
    await storeDocumentFileFromUpload(
      new File([new Uint8Array([1])], 'a.pdf', { type: 'application/pdf' }),
    );

    const createObjectURL = vi.fn(() => 'blob:mock-url');
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', {
      createObjectURL,
      revokeObjectURL,
    });

    const click = vi.fn();
    const realCreateElement = document.createElement.bind(document);
    const createElement = vi.spyOn(document, 'createElement').mockImplementation((tagName) => {
      if (tagName === 'a') {
        return {
          href: '',
          download: '',
          rel: '',
          click,
        } as unknown as HTMLAnchorElement;
      }
      return realCreateElement(tagName);
    });

    expect(createObjectURL).not.toHaveBeenCalled();

    const result = await exportLocalBackupBundle(new Date(2026, 2, 1, 12, 0));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(click).toHaveBeenCalledTimes(1);
    expect(result.filename).toBe('OfficePilot_Backup_2026-03-01_12-00.zip');

    await new Promise((r) => setTimeout(r, 10));
    expect(revokeObjectURL).toHaveBeenCalled();

    createElement.mockRestore();
  });

  it('downloadBackupBlob revokes object URL', async () => {
    const revokeObjectURL = vi.fn();
    const createObjectURL = vi.fn(() => 'blob:test');
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL });

    const click = vi.fn();
    vi.spyOn(document, 'createElement').mockReturnValue({
      href: '',
      download: '',
      rel: '',
      click,
    } as unknown as HTMLAnchorElement);

    downloadBackupBlob(new Blob(['x']), 'OfficePilot_Backup_2026-01-01_00-00.zip');
    await new Promise((r) => setTimeout(r, 10));
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:test');
  });

  it('stored blobs remain readable for backup inclusion', async () => {
    const { fileRef: ref } = await storeDocumentFileFromUpload(
      new File([new Uint8Array([10, 11, 12])], 'ok.pdf', { type: 'application/pdf' }),
    );
    const blob = await getDocumentFileBlob(ref);
    expect(blob).toBeTruthy();
    expect(blob!.size).toBe(3);
  });
});
