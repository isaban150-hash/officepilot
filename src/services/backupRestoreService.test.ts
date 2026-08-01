import { useDocumentBlobDatabaseReset } from '../test/documentBlobTestReset';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  BACKUP_RESTORE_STAGING_PREFIX,
  buildSanitizedRestoreAppState,
  restoreLocalBackupBundle,
} from './backupRestoreService';
import { buildLocalBackupBundle } from './backupExportService';
import { validateLocalBackupZip } from './backupValidateService';
import {
  getDocumentFileBlob,
  getDocumentFileRefStoreSnapshot,
  storeDocumentFileFromUpload,
} from './documentFileStoreService';
import { readDocumentBlob } from './storage/documentBlobIndexedDbService';
import {
  buildStorageKey,
  getActiveStorageScope,
  setActiveStorageScope,
} from './storage/storageScopeService';
import { getSyncClientSnapshot, resetSyncClientForTests } from './sync/syncClientService';
import { hydrateSyncOutbox, getSyncOutboxSnapshot } from './sync/syncOutboxService';
import { resetTestStores } from '../test/resetStores';
import type { ValidatedBackupBundle } from '../types/backupValidate';

function liveClient() {
  resetSyncClientForTests({
    deviceId: 'live-device-1',
    workspaceId: 'live-ws-1',
    createdAt: '2026-01-01T00:00:00.000Z',
    syncPolicy: 'local_only',
  });
}

async function validatedFromCurrentStore(): Promise<ValidatedBackupBundle> {
  const built = await buildLocalBackupBundle(new Date(2026, 2, 1, 10, 0));
  expect(built.ok).toBe(true);
  if (!built.ok) throw new Error('build_failed');
  const validated = await validateLocalBackupZip(built.artifacts.zipBlob);
  expect(validated.ok).toBe(true);
  if (!validated.ok) throw new Error('validate_failed');
  return validated;
}

useDocumentBlobDatabaseReset();

describe('backupRestoreService', () => {
  beforeEach(() => {    setActiveStorageScope({ type: 'guest' });
    liveClient();
    hydrateSyncOutbox([]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    setActiveStorageScope({ type: 'guest' });
  });

  it('rejects restore without validation payload or confirmation', async () => {
    const r1 = await restoreLocalBackupBundle({
      validated: { ok: false, reason: 'invalid_zip', errorKey: 'backup.validate.error.invalid' },
      confirmed: true,
      reload: false,
    });
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.reason).toBe('not_validated');

    await storeDocumentFileFromUpload(
      new File([new Uint8Array([1])], 'a.pdf', { type: 'application/pdf' }),
    );
    const validated = await validatedFromCurrentStore();
    const r2 = await restoreLocalBackupBundle({
      validated,
      confirmed: false,
      reload: false,
    });
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.reason).toBe('not_confirmed');
  });

  it('replaces state and blobs in the active scope; leaves other scopes and auth alone', async () => {
    const otherKey = buildStorageKey({ type: 'user', userId: 'other-user' });
    localStorage.setItem(otherKey, JSON.stringify({ keep: true }));
    localStorage.setItem('sb-test-auth-token', '{"access_token":"secret"}');
    sessionStorage.setItem('officepilot-company-session', '{"company":"x"}');

    const { fileRef } = await storeDocumentFileFromUpload(
      new File([new Uint8Array([1, 2, 3, 4])], 'backup.pdf', { type: 'application/pdf' }),
    );
    const validated = await validatedFromCurrentStore();

    // Mutate live away from backup content
    resetTestStores();
    setActiveStorageScope({ type: 'guest' });
    liveClient();
    await storeDocumentFileFromUpload(
      new File([new Uint8Array([9])], 'live-only.pdf', { type: 'application/pdf' }),
    );

    const reload = vi.fn();
    const result = await restoreLocalBackupBundle(
      { validated, confirmed: true, reload: true },
      { reload },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(reload).toHaveBeenCalledTimes(1);

    expect(getDocumentFileRefStoreSnapshot().some((r) => r.id === fileRef.id)).toBe(true);
    expect((await getDocumentFileBlob(fileRef.id))?.size).toBe(4);
    expect(localStorage.getItem(otherKey)).toBe(JSON.stringify({ keep: true }));
    expect(localStorage.getItem('sb-test-auth-token')).toContain('secret');
    expect(sessionStorage.getItem('officepilot-company-session')).toContain('company');
    expect(getActiveStorageScope()).toEqual({ type: 'guest' });
    expect(getSyncClientSnapshot().deviceId).toBe('live-device-1');
    expect(getSyncOutboxSnapshot()).toEqual([]);
    expect(await readDocumentBlob(`${BACKUP_RESTORE_STAGING_PREFIX}${fileRef.id}`)).toBeNull();
  });

  it('discards backup syncOutbox and keeps live sync client', async () => {
    await storeDocumentFileFromUpload(
      new File([new Uint8Array([1])], 'a.pdf', { type: 'application/pdf' }),
    );
    const validated = await validatedFromCurrentStore();
    const tampered: ValidatedBackupBundle = {
      ...validated,
      appState: {
        ...validated.appState,
        syncOutbox: [
          {
            id: 'should-drop',
            entityType: 'document',
            entityId: 'd1',
            operation: 'create',
            version: 1,
            queuedAt: '2026-01-01T00:00:00.000Z',
            retryCount: 0,
            status: 'pending',
          },
        ],
        syncClient: {
          deviceId: 'backup-device',
          workspaceId: 'backup-ws',
          createdAt: '2020-01-01T00:00:00.000Z',
          syncPolicy: 'cloud_ready',
        },
      },
    };

    const result = await restoreLocalBackupBundle({
      validated: tampered,
      confirmed: true,
      reload: false,
    });
    expect(result.ok).toBe(true);
    expect(getSyncClientSnapshot().deviceId).toBe('live-device-1');
    expect(getSyncOutboxSnapshot()).toEqual([]);

    const sanitized = buildSanitizedRestoreAppState(tampered.appState, getSyncClientSnapshot());
    expect(sanitized.syncOutbox).toEqual([]);
    expect(sanitized.syncClient?.deviceId).toBe('live-device-1');
  });

  it('safety backup failure prevents any mutation', async () => {
    await storeDocumentFileFromUpload(
      new File([new Uint8Array([1, 2])], 'a.pdf', { type: 'application/pdf' }),
    );
    const validated = await validatedFromCurrentStore();
    const refsBefore = getDocumentFileRefStoreSnapshot().map((r) => r.id);

    const result = await restoreLocalBackupBundle(
      { validated, confirmed: true, reload: false },
      { failAfterPhase: 'safety_backup' },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('safety_failed');
    expect(getDocumentFileRefStoreSnapshot().map((r) => r.id)).toEqual(refsBefore);
  });

  it('staging failure leaves live data unchanged', async () => {
    await storeDocumentFileFromUpload(
      new File([new Uint8Array([3, 3, 3])], 'live.pdf', { type: 'application/pdf' }),
    );
    const validated = await validatedFromCurrentStore();
    const refsBefore = getDocumentFileRefStoreSnapshot().map((r) => r.id).sort();

    const result = await restoreLocalBackupBundle(
      { validated, confirmed: true, reload: false },
      { failAfterPhase: 'stage_blobs' },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('stage_failed');
    expect(getDocumentFileRefStoreSnapshot().map((r) => r.id).sort()).toEqual(refsBefore);
  });

  it('verify failure rolls back to safety backup', async () => {
    await storeDocumentFileFromUpload(
      new File([new Uint8Array([7, 7])], 'before.pdf', { type: 'application/pdf' }),
    );
    // Capture safety content identity via separate backup bundle
    resetTestStores();
    liveClient();
    await storeDocumentFileFromUpload(
      new File([new Uint8Array([1, 1, 1, 1, 1])], 'incoming.pdf', { type: 'application/pdf' }),
    );
    const validated = await validatedFromCurrentStore();

    resetTestStores();
    liveClient();
    await storeDocumentFileFromUpload(
      new File([new Uint8Array([7, 7])], 'before.pdf', { type: 'application/pdf' }),
    );

    const result = await restoreLocalBackupBundle(
      { validated, confirmed: true, reload: false },
      { failAfterPhase: 'verify_restored' },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.rolledBack).toBe(true);
      expect(JSON.stringify(result)).not.toMatch(/before\.pdf|incoming|file-ref/i);
    }

    const refs = getDocumentFileRefStoreSnapshot();
    expect(refs).toHaveLength(1);
    expect((await getDocumentFileBlob(refs[0]!))?.size).toBe(2);
    expect(getSyncClientSnapshot().deviceId).toBe('live-device-1');
  });

  it('cleanup failure after success does not roll back restored data', async () => {
    await storeDocumentFileFromUpload(
      new File([new Uint8Array([4, 4, 4, 4])], 'keep.pdf', { type: 'application/pdf' }),
    );
    const validated = await validatedFromCurrentStore();
    const backupId = validated.manifest.files[0]!.fileRefId;

    resetTestStores();
    liveClient();
    await storeDocumentFileFromUpload(
      new File([new Uint8Array([8])], 'orphan-later.pdf', { type: 'application/pdf' }),
    );

    const result = await restoreLocalBackupBundle(
      { validated, confirmed: true, reload: false },
      { failAfterPhase: 'cleanup_old' },
    );
    expect(result.ok).toBe(true);
    expect((await readDocumentBlob(backupId))?.fileSize).toBe(4);
  });

  it('error payloads never include sensitive raw details', async () => {
    const result = await restoreLocalBackupBundle({
      validated: { ok: false, reason: 'x', errorKey: 'y' },
      confirmed: true,
      reload: false,
    });
    expect(JSON.stringify(result)).not.toMatch(/password|accessToken|indexeddb|stack/i);
  });
});
