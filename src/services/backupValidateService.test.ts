import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import JSZip from 'jszip';
import {
  BACKUP_VALIDATE_LIMITS,
  detectNonImportableBackupAppStateFields,
  isSafeBackupZipPath,
  normalizeBackupAppStateVersionReadOnly,
  validateLocalBackupZip,
} from './backupValidateService';
import { buildLocalBackupBundle } from './backupExportService';
import {
  getDocumentFileRefStoreSnapshot,
  storeDocumentFileFromUpload,
} from './documentFileStoreService';
import {
  replaceDocumentFileRepresentationBindingStore,
} from './documentFileRepresentationBindingStoreService';
import { createDocumentFileRepresentationBinding } from './documentFileRepresentationBindingService';
import { resetTestStores } from '../test/resetStores';
import { BACKUP_SCHEMA_VERSION } from '../types/backupExport';
import type { AppPersistedState } from '../types/models';

async function zipFromParts(parts: Record<string, string | Uint8Array>): Promise<Uint8Array> {
  const zip = new JSZip();
  for (const [path, content] of Object.entries(parts)) {
    zip.file(path, content);
  }
  const blob = await zip.generateAsync({ type: 'uint8array' });
  return blob;
}

describe('backupValidateService', () => {
  let refsBefore: string[];

  beforeEach(() => {
    resetTestStores();
    refsBefore = [];
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('accepts a valid export bundle and preview matches manifest', async () => {
    const { fileRef: original } = await storeDocumentFileFromUpload(
      new File([new Uint8Array([1, 2, 3, 4])], 'a.pdf', { type: 'application/pdf' }),
    );
    const { fileRef: archive } = await storeDocumentFileFromUpload(
      new File([new Uint8Array([5, 6])], 'a-arch.pdf', { type: 'application/pdf' }),
    );
    replaceDocumentFileRepresentationBindingStore([
      createDocumentFileRepresentationBinding({
        documentId: 'doc-1',
        kind: 'archive',
        fileRefId: archive.id,
      }),
    ]);

    refsBefore = getDocumentFileRefStoreSnapshot().map((r) => r.id).sort();
    const lsKeysBefore = Object.keys(localStorage).sort();

    const built = await buildLocalBackupBundle(new Date(2026, 0, 15, 9, 30));
    expect(built.ok).toBe(true);
    if (!built.ok) return;

    const result = await validateLocalBackupZip(built.artifacts.zipBlob);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.preview.schemaVersion).toBe(BACKUP_SCHEMA_VERSION);
    expect(result.preview.exportedAt).toBe(built.artifacts.manifest.exportedAt);
    expect(result.preview.fileCount).toBe(built.artifacts.manifest.fileCount);
    expect(result.preview.totalFileBytes).toBe(built.artifacts.manifest.totalFileBytes);
    expect(result.preview.recordCounts).toEqual(built.artifacts.manifest.recordCounts);
    expect(result.preview.fileCount).toBe(2);
    expect(result.manifest.files.map((f) => f.fileRefId).sort()).toEqual(
      [original.id, archive.id].sort(),
    );

    expect(getDocumentFileRefStoreSnapshot().map((r) => r.id).sort()).toEqual(refsBefore);
    expect(Object.keys(localStorage).sort()).toEqual(lsKeysBefore);
  });

  it('rejects missing manifest or app-state', async () => {
    const onlyManifest = await zipFromParts({
      'manifest.json': JSON.stringify({
        schemaVersion: 1,
        exportedAt: '2026-01-01T00:00:00.000Z',
        recordCounts: {
          inboxItems: 0,
          vorgaenge: 0,
          tasks: 0,
          documents: 0,
          expenses: 0,
          uploadedDocuments: 0,
          documentFileRefs: 0,
          documentFileRepresentationBindings: 0,
          communicationHistory: 0,
          knowledgeFacts: 0,
          vorgangNotes: 0,
          dunningDocumentations: 0,
          mailImports: 0,
        },
        fileCount: 0,
        totalFileBytes: 0,
        files: [],
      }),
    });
    const r1 = await validateLocalBackupZip(onlyManifest);
    expect(r1.ok).toBe(false);
    if (!r1.ok) {
      expect(r1.reason).toBe('invalid_structure');
      expect(r1.errorKey).toBe('backup.validate.error.structure');
      expect(r1.errorKey).not.toMatch(/manifest\.json|password|file-ref/i);
    }

    const onlyState = await zipFromParts({
      'app-state.json': JSON.stringify({ version: 5 }),
    });
    const r2 = await validateLocalBackupZip(onlyState);
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.reason).toBe('invalid_structure');
  });

  it('rejects unknown or newer schemaVersion', async () => {
    const built = await buildLocalBackupBundle();
    expect(built.ok).toBe(true);
    if (!built.ok) return;

    const zip = await JSZip.loadAsync(built.artifacts.zipBlob);
    const manifest = JSON.parse(await zip.file('manifest.json')!.async('string'));
    manifest.schemaVersion = 99;
    zip.file('manifest.json', JSON.stringify(manifest));
    const bytes = await zip.generateAsync({ type: 'uint8array' });

    const result = await validateLocalBackupZip(bytes);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('unsupported_schema');
      expect(result.errorKey).toBe('backup.validate.error.schema');
    }
  });

  it('rejects missing or extra blob entries', async () => {
    const { fileRef } = await storeDocumentFileFromUpload(
      new File([new Uint8Array([9])], 'x.pdf', { type: 'application/pdf' }),
    );
    const built = await buildLocalBackupBundle();
    expect(built.ok).toBe(true);
    if (!built.ok) return;

    // Missing blob
    {
      const zip = await JSZip.loadAsync(built.artifacts.zipBlob);
      zip.remove(`files/${fileRef.id}`);
      const bytes = await zip.generateAsync({ type: 'uint8array' });
      const result = await validateLocalBackupZip(bytes);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('blob_mismatch');
    }

    // Extra blob
    {
      const zip = await JSZip.loadAsync(built.artifacts.zipBlob);
      zip.file('files/extra-file-ref-001', new Uint8Array([1]));
      const bytes = await zip.generateAsync({ type: 'uint8array' });
      const result = await validateLocalBackupZip(bytes);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(['blob_mismatch', 'invalid_structure', 'invalid_manifest']).toContain(result.reason);
      }
    }
  });

  it('rejects wrong size or MIME mapping', async () => {
    await storeDocumentFileFromUpload(
      new File([new Uint8Array([1, 2, 3])], 'm.pdf', { type: 'application/pdf' }),
    );
    const built = await buildLocalBackupBundle();
    expect(built.ok).toBe(true);
    if (!built.ok) return;

    const zip = await JSZip.loadAsync(built.artifacts.zipBlob);
    const manifest = JSON.parse(await zip.file('manifest.json')!.async('string'));
    manifest.files[0].mimeType = 'image/png';
    zip.file('manifest.json', JSON.stringify(manifest));
    const bytes = await zip.generateAsync({ type: 'uint8array' });

    const result = await validateLocalBackupZip(bytes);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('blob_mismatch');
  });

  it('rejects invalid binding fileRef reference', async () => {
    const { fileRef } = await storeDocumentFileFromUpload(
      new File([new Uint8Array([1])], 'b.pdf', { type: 'application/pdf' }),
    );
    replaceDocumentFileRepresentationBindingStore([
      createDocumentFileRepresentationBinding({
        documentId: 'doc-x',
        kind: 'preview',
        fileRefId: fileRef.id,
      }),
    ]);
    const built = await buildLocalBackupBundle();
    expect(built.ok).toBe(true);
    if (!built.ok) return;

    const zip = await JSZip.loadAsync(built.artifacts.zipBlob);
    const state = JSON.parse(await zip.file('app-state.json')!.async('string')) as AppPersistedState;
    state.documentFileRepresentationBindings = [
      {
        documentId: 'doc-x',
        kind: 'preview',
        fileRefId: 'missing-ref-does-not-exist',
      },
    ];
    zip.file('app-state.json', JSON.stringify(state));
    const bytes = await zip.generateAsync({ type: 'uint8array' });

    const result = await validateLocalBackupZip(bytes);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(['ref_mismatch', 'invalid_app_state', 'invalid_manifest']).toContain(result.reason);
    }
  });

  it('rejects extra paths and path traversal', async () => {
    expect(isSafeBackupZipPath('../etc/passwd')).toBe(false);
    expect(isSafeBackupZipPath('files/../../x')).toBe(false);
    expect(isSafeBackupZipPath('files\\abc')).toBe(false);
    expect(isSafeBackupZipPath('/manifest.json')).toBe(false);

    const withExtra = await zipFromParts({
      'manifest.json': '{}',
      'app-state.json': '{}',
      'notes.txt': 'nope',
    });
    const r1 = await validateLocalBackupZip(withExtra);
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.reason).toBe('invalid_structure');

    const traversal = await zipFromParts({
      'manifest.json': '{}',
      'app-state.json': '{}',
      'files/../secret': new Uint8Array([1]),
    });
    const r2 = await validateLocalBackupZip(traversal);
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.reason).toBe('invalid_structure');
  });

  it('enforces size and file-count limits', async () => {
    const huge = new Uint8Array(BACKUP_VALIDATE_LIMITS.maxZipBytes + 1);
    const result = await validateLocalBackupZip(huge);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('too_large');
      expect(result.errorKey).toBe('backup.validate.error.tooLarge');
    }
  });

  it('treats auth/session/sync fields as non-importable', () => {
    expect(
      detectNonImportableBackupAppStateFields({
        version: 5,
        syncOutbox: [{ id: '1' }],
      }),
    ).toContain('syncOutbox');

    expect(
      detectNonImportableBackupAppStateFields({
        version: 5,
        documentFileBlobs: { a: 'data:...' },
      }),
    ).toContain('documentFileBlobs');

    expect(
      detectNonImportableBackupAppStateFields({
        version: 5,
        accessToken: 'secret',
      }),
    ).toContain('secrets');

    const normalized = normalizeBackupAppStateVersionReadOnly({
      notAState: true,
    });
    expect(normalized).toBeNull();
  });

  it('rejects app-state that embeds syncOutbox', async () => {
    const built = await buildLocalBackupBundle();
    expect(built.ok).toBe(true);
    if (!built.ok) return;

    const zip = await JSZip.loadAsync(built.artifacts.zipBlob);
    const state = JSON.parse(await zip.file('app-state.json')!.async('string'));
    state.syncOutbox = [
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
    ];
    zip.file('app-state.json', JSON.stringify(state));
    const bytes = await zip.generateAsync({ type: 'uint8array' });

    const result = await validateLocalBackupZip(bytes);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('non_importable_fields');
      expect(result.errorKey).toBe('backup.validate.error.nonImportable');
      expect(JSON.stringify(result)).not.toContain('o1');
    }
  });

  it('error keys never embed sensitive raw details', async () => {
    const result = await validateLocalBackupZip(new Uint8Array([0, 1, 2]));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const payload = JSON.stringify(result);
      expect(payload).not.toMatch(/indexeddb|localStorage|password|accessToken/i);
    }
  });
});
