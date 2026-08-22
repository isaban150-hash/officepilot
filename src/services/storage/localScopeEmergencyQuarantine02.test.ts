/**
 * OFFICEPILOT-COMPANY-IDENTITY-RECOVERY-02P2 — Zielsicherung, erneute
 * Dateiprüfung und lokale Quarantäne.
 *
 * Alle Fixtures sind neutral, synthetisch und vollständig typisiert. Keine
 * reale Firma, keine reale Workspace-ID, keine reale Adresse, keine echte
 * Sicherungsdatei.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildQuarantineBlobScopeKey,
  cleanupStagingQuarantine,
  createTargetQuarantine,
  listQuarantineMarkers,
  prepareTargetBackupSession,
  readQuarantineMarker,
  resetQuarantineSessionsForTests,
  verifyReselectedTargetBackup,
} from './localScopeEmergencyQuarantineService';
import {
  listQuarantineBlobRecords,
  readQuarantineBlob,
  resetDocumentBlobDatabaseForTests,
  saveDocumentBlob,
  writeQuarantineBlob,
} from './documentBlobIndexedDbService';
import { readScopeBlobRecord } from './localScopeBlobInventoryService';
import { computeBufferContentHash } from '../documentFileHashService';
import { STORAGE_VERSION } from '../sync/syncMigrationService';
import { getActiveStorageScope, resetStorageScopeForTests } from './storageScopeService';
import { DEFAULT_SETUP } from '../../data/mockData';
import { DEFAULT_COMPANY_PROFILE } from '../../data/companyProfileDefaults';
import {
  QUARANTINE_MARKER_PREFIX,
  QUARANTINE_STATE_PREFIX,
  buildQuarantineMarkerKey,
  buildQuarantineStateKey,
  type PreparedTargetBackupSession,
  type QuarantineStateEnvelope,
  type VerifiedTargetBackupSession,
} from '../../types/emergencyBackupQuarantine';
import type { DocumentFileRef } from '../../types/documentFileRef';
import type { CompanyProfile, CompanySetup } from '../../types/models';
import type { QuarantineMarker } from '../../types/emergencyBackupQuarantine';

const WORKSPACE_ID = 'ws-p2-target';
const TARGET_KEY = `officepilot-state:workspace:${WORKSPACE_ID}`;
const TARGET_SCOPE_KEY = `workspace:${WORKSPACE_ID}`;
const COMPANY = 'Beispiel Zielbetrieb GmbH';
const NOW = '2026-08-18T10:00:00.000Z';

/** Formatgültige, neutrale Fremdtoken: q-<16 Hex>-<16 Hex>. */
const FOREIGN_STAGING_TOKEN = 'q-0123456789abcdef-fedcba9876543210';
const FOREIGN_COMPLETE_TOKEN = 'q-1122334455667788-99aabbccddeeff00';
const UNKNOWN_TOKEN = 'q-abcdefabcdefabcd-0011223344556677';

const BYTES_A = new Uint8Array([0x41, 0x42, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48]);
const BYTES_B = new Uint8Array([0x10, 0x20, 0x30, 0x40, 0x50, 0x60]);

interface SeedFile {
  id: string;
  localDataKey: string;
  mimeType: string;
  bytes: Uint8Array;
  hash: string;
  /** Bewusst abweichend setzbar, um Widersprüche zu erzeugen. */
  refFileSize?: number;
  refContentHash?: string;
  skipBlob?: boolean;
}

async function buildSeedFiles(): Promise<SeedFile[]> {
  return [
    {
      id: 'ref-a',
      localDataKey: 'key-a',
      mimeType: 'application/pdf',
      bytes: BYTES_A,
      hash: await computeBufferContentHash(BYTES_A),
    },
    {
      id: 'ref-b',
      localDataKey: 'key-b',
      mimeType: 'image/png',
      bytes: BYTES_B,
      hash: await computeBufferContentHash(BYTES_B),
    },
  ];
}

function toFileRef(file: SeedFile): DocumentFileRef {
  return {
    id: file.id,
    originalFileName: `${file.id}.bin`,
    mimeType: file.mimeType,
    fileSize: file.refFileSize ?? file.bytes.byteLength,
    contentHash: file.refContentHash ?? file.hash,
    storageType: 'indexeddb',
    localDataKey: file.localDataKey,
    createdAt: '2026-08-17T08:00:00.000Z',
    lifecycleStatus: 'committed',
    committedAt: '2026-08-17T08:05:00.000Z',
  };
}

function buildTargetRawState(
  files: SeedFile[],
  overrides: Record<string, unknown> = {},
): string {
  const setup: CompanySetup = {
    ...DEFAULT_SETUP,
    companyName: COMPANY,
    setupComplete: true,
    setupVersion: 1,
  };
  const companyProfile: CompanyProfile = { ...DEFAULT_COMPANY_PROFILE, companyName: COMPANY };
  const workspaceId = (overrides.workspaceId as string) ?? WORKSPACE_ID;
  return JSON.stringify({
    version: STORAGE_VERSION,
    setup,
    companyProfile,
    workspace: { id: workspaceId, name: COMPANY, ownerUserId: 'user-p2' },
    syncClient: {
      deviceId: 'device-p2',
      workspaceId,
      serverWorkspaceId: workspaceId,
      syncPolicy: 'cloud',
    },
    setupSync: { version: 1, updatedAt: NOW, deleted: false, deviceId: 'device-p2', workspaceId },
    companyProfileSync: {
      version: 1,
      updatedAt: NOW,
      deleted: false,
      deviceId: 'device-p2',
      workspaceId,
    },
    inboxItems: [],
    vorgaenge: [],
    tasks: [],
    documents: [],
    expenses: [],
    documentWorkResults: [],
    documentFileRefs: files.map(toFileRef),
    syncOutbox: [],
    savedAt: '2026-08-17T09:00:00.000Z',
    ...overrides,
  });
}

async function seedTarget(
  files: SeedFile[],
  options: { storageKey?: string; workspaceId?: string } = {},
): Promise<string> {
  const storageKey = options.storageKey ?? TARGET_KEY;
  const workspaceId = options.workspaceId ?? WORKSPACE_ID;
  const raw = buildTargetRawState(files, options.workspaceId ? { workspaceId } : {});
  localStorage.setItem(storageKey, raw);
  for (const file of files) {
    if (file.skipBlob) continue;
    await saveDocumentBlob({
      fileRefId: file.id,
      blob: new Blob([file.bytes], { type: file.mimeType }),
      mimeType: file.mimeType,
      fileSize: file.bytes.byteLength,
      contentHash: file.hash,
      createdAt: '2026-08-17T08:00:00.000Z',
      scope: { type: 'workspace', workspaceId },
    });
  }
  return raw;
}

/** Vollständige Momentaufnahme des Zielbereichs für den Byte-Vergleich. */
async function captureTarget(
  storageKey = TARGET_KEY,
  scopeKey = TARGET_SCOPE_KEY,
): Promise<{ raw: string | null; blobs: Record<string, string> }> {
  const raw = localStorage.getItem(storageKey);
  const blobs: Record<string, string> = {};
  const refs: DocumentFileRef[] = raw
    ? ((JSON.parse(raw) as { documentFileRefs?: DocumentFileRef[] }).documentFileRefs ?? [])
    : [];
  for (const ref of refs) {
    const read = await readScopeBlobRecord(scopeKey, ref.id);
    blobs[ref.id] = read.bytes ? Array.from(read.bytes).join(',') : `status:${read.status}`;
  }
  return { raw, blobs };
}

function localStorageKeys(): string[] {
  const keys: string[] = [];
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index);
    if (key) keys.push(key);
  }
  return keys.sort();
}

async function prepareAndVerify(): Promise<VerifiedTargetBackupSession> {
  const prepared = await prepareTargetBackupSession(TARGET_KEY);
  expect(prepared.ok, `prepare fehlgeschlagen: ${JSON.stringify(prepared)}`).toBe(true);
  if (!prepared.ok) throw new Error('prepare failed');
  const verified = await verifyReselectedTargetBackup(prepared.session, prepared.session.zipBlob);
  expect(verified.ok, `verify fehlgeschlagen: ${JSON.stringify(verified)}`).toBe(true);
  if (!verified.ok) throw new Error('verify failed');
  return verified.session;
}

beforeEach(async () => {
  localStorage.clear();
  resetStorageScopeForTests();
  resetQuarantineSessionsForTests();
  await resetDocumentBlobDatabaseForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('02P2/A — Zielbackup vorbereiten', () => {
  it('A1: verwendet den ausdrücklich übergebenen Workspace-Schlüssel, nicht den aktiven Guest-Scope', async () => {
    await seedTarget(await buildSeedFiles());
    expect(getActiveStorageScope()).toEqual({ type: 'guest' });

    const result = await prepareTargetBackupSession(TARGET_KEY);
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;

    expect(result.session.sourceStorageKey).toBe(TARGET_KEY);
    expect(result.session.sourceScopeKey).toBe(TARGET_SCOPE_KEY);
    expect(result.session.workspaceId).toBe(WORKSPACE_ID);
    // Der aktive Scope bleibt unverändert guest.
    expect(getActiveStorageScope()).toEqual({ type: 'guest' });
  });

  it('A2: Guest-, User-, Legacy- und Quarantäneschlüssel werden als Ziel abgelehnt', async () => {
    await seedTarget(await buildSeedFiles());
    for (const key of [
      'officepilot-state:guest',
      'officepilot-state:user:user-p2',
      'officepilot-state',
      'officepilot-setup',
      'officepilot-legacy-state:1700000000000',
      `${QUARANTINE_STATE_PREFIX}q-token`,
    ]) {
      const result = await prepareTargetBackupSession(key);
      expect(result.ok, `unerwartet akzeptiert: ${key}`).toBe(false);
      if (!result.ok) expect(result.reason).toBe('unsupported_target_key');
    }
  });

  it('A3: der Ziel-Rohtext wird unverändert übernommen', async () => {
    const raw = await seedTarget(await buildSeedFiles());
    const result = await prepareTargetBackupSession(TARGET_KEY);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.session.bundle.sourceRawText).toBe(raw);
    expect(result.session.sourceRawTextSha256).toBe(
      await computeBufferContentHash(new TextEncoder().encode(raw)),
    );
  });

  it('A4: alle Zielblobs liegen bytegenau in der erzeugten Sicherung', async () => {
    const files = await buildSeedFiles();
    await seedTarget(files);
    const result = await prepareTargetBackupSession(TARGET_KEY);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const byId = new Map(result.session.files.map((entry) => [entry.fileRefId, entry]));
    for (const file of files) {
      expect(byId.get(file.id)?.sha256).toBe(file.hash);
      expect(byId.get(file.id)?.fileSize).toBe(file.bytes.byteLength);
      expect(byId.get(file.id)?.localDataKey).toBe(file.localDataKey);
      expect(byId.get(file.id)?.mimeType).toBe(file.mimeType);
    }
  });

  it('A5: der Archivhash gilt für exakt die erzeugten ZIP-Bytes', async () => {
    await seedTarget(await buildSeedFiles());
    const result = await prepareTargetBackupSession(TARGET_KEY);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const bytes = new Uint8Array(await result.session.zipBlob.arrayBuffer());
    expect(result.session.archiveSha256).toBe(await computeBufferContentHash(bytes));
  });

  it('A6: fehlender Zielblob blockiert', async () => {
    const files = await buildSeedFiles();
    files[1]!.skipBlob = true;
    await seedTarget(files);
    const result = await prepareTargetBackupSession(TARGET_KEY);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('backup_invalid');
  });

  it('A7: falsche Blobgröße blockiert', async () => {
    const files = await buildSeedFiles();
    files[1]!.refFileSize = 999;
    await seedTarget(files);
    const result = await prepareTargetBackupSession(TARGET_KEY);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('backup_invalid');
  });

  it('A8: falscher Blobhash blockiert', async () => {
    const files = await buildSeedFiles();
    files[1]!.refContentHash = 'f'.repeat(64);
    await seedTarget(files);
    const result = await prepareTargetBackupSession(TARGET_KEY);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('backup_invalid');
  });

  it('A9: bis hierhin null localStorage- und null IndexedDB-Schreibzugriffe', async () => {
    await seedTarget(await buildSeedFiles());
    const before = localStorageKeys();

    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const removeItem = vi.spyOn(Storage.prototype, 'removeItem');
    const clear = vi.spyOn(Storage.prototype, 'clear');
    const put = vi.spyOn(IDBObjectStore.prototype, 'put');
    const del = vi.spyOn(IDBObjectStore.prototype, 'delete');

    const prepared = await prepareTargetBackupSession(TARGET_KEY);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    await verifyReselectedTargetBackup(prepared.session, prepared.session.zipBlob);

    expect(setItem).not.toHaveBeenCalled();
    expect(removeItem).not.toHaveBeenCalled();
    expect(clear).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
    expect(del).not.toHaveBeenCalled();
    expect(localStorageKeys()).toEqual(before);
  });
});

describe('02P2/B — erneut ausgewählte Datei prüfen', () => {
  it('B1: eine frei nachgebaute Sitzung wird abgelehnt', async () => {
    await seedTarget(await buildSeedFiles());
    const prepared = await prepareTargetBackupSession(TARGET_KEY);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;

    const forged: PreparedTargetBackupSession = { ...prepared.session };
    const result = await verifyReselectedTargetBackup(forged, prepared.session.zipBlob);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('unknown_session');
  });

  it('B2: exakt derselbe Blob wird angenommen', async () => {
    await seedTarget(await buildSeedFiles());
    const session = await prepareAndVerify();
    expect(session.workspaceId).toBe(WORKSPACE_ID);
    expect(session.reselectedBundle.sourceRawTextSha256).toBe(session.sourceRawTextSha256);
  });

  it('B3: gleicher Name, andere Bytes wird abgelehnt', async () => {
    await seedTarget(await buildSeedFiles());
    const prepared = await prepareTargetBackupSession(TARGET_KEY);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;

    const bytes = new Uint8Array(await prepared.session.zipBlob.arrayBuffer());
    bytes[bytes.byteLength - 8] = (bytes[bytes.byteLength - 8]! ^ 0xff) & 0xff;
    const tampered = new File([bytes], 'gleicher-name.zip', { type: 'application/zip' });

    const result = await verifyReselectedTargetBackup(prepared.session, tampered);
    expect(result.ok).toBe(false);
  });

  it('B4: eine andere Sicherung desselben Ziels (anderer Archivhash) wird abgelehnt', async () => {
    await seedTarget(await buildSeedFiles());
    const first = await prepareTargetBackupSession(TARGET_KEY);
    const second = await prepareTargetBackupSession(TARGET_KEY);
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;

    expect(second.session.archiveSha256).not.toBe(first.session.archiveSha256);
    const result = await verifyReselectedTargetBackup(first.session, second.session.zipBlob);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('archive_hash_mismatch');
  });

  it('B5: eine Sicherung eines fremden Workspace wird abgelehnt', async () => {
    await seedTarget(await buildSeedFiles());
    const own = await prepareTargetBackupSession(TARGET_KEY);

    const otherWorkspace = 'ws-p2-fremd';
    const otherKey = `officepilot-state:workspace:${otherWorkspace}`;
    const otherFiles = await buildSeedFiles();
    await seedTarget(otherFiles, { storageKey: otherKey, workspaceId: otherWorkspace });
    const other = await prepareTargetBackupSession(otherKey);

    expect(own.ok && other.ok).toBe(true);
    if (!own.ok || !other.ok) return;

    const result = await verifyReselectedTargetBackup(own.session, other.session.zipBlob);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(['identity_mismatch', 'archive_hash_mismatch']).toContain(result.reason);
    }
  });

  it('B6: eine abweichende Dateimenge wird abgelehnt', async () => {
    const files = await buildSeedFiles();
    await seedTarget(files);
    const own = await prepareTargetBackupSession(TARGET_KEY);
    expect(own.ok).toBe(true);
    if (!own.ok) return;

    // Zweites Ziel mit nur einer Datei — gleiche Workspace-ID, andere Menge.
    localStorage.clear();
    await seedTarget([files[0]!]);
    const smaller = await prepareTargetBackupSession(TARGET_KEY);
    expect(smaller.ok).toBe(true);
    if (!smaller.ok) return;

    const result = await verifyReselectedTargetBackup(own.session, smaller.session.zipBlob);
    expect(result.ok).toBe(false);
  });

  it('B7: ohne verifizierte Sitzung ist keine Quarantäne möglich', async () => {
    await seedTarget(await buildSeedFiles());
    const prepared = await prepareTargetBackupSession(TARGET_KEY);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;

    const forged = { ...prepared.session, reselectedBundle: prepared.session.bundle };
    const result = await createTargetQuarantine(forged as VerifiedTargetBackupSession);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('unknown_session');
    expect(localStorageKeys().some((key) => key.startsWith(QUARANTINE_MARKER_PREFIX))).toBe(false);
  });

  it('B8: nach Modulneustart muss vollständig neu begonnen werden', async () => {
    await seedTarget(await buildSeedFiles());
    const session = await prepareAndVerify();

    resetQuarantineSessionsForTests();

    const result = await createTargetQuarantine(session);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('unknown_session');
  });
});

describe('02P2/C — Quarantäne erzeugen', () => {
  it('C1: vollständiger Ablauf mit Marker, Blobs, Hülle und complete', async () => {
    const files = await buildSeedFiles();
    await seedTarget(files);
    const before = await captureTarget();
    const session = await prepareAndVerify();

    const result = await createTargetQuarantine(session, { now: NOW });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;

    const marker = readQuarantineMarker(result.token);
    expect(marker?.status).toBe('complete');
    expect(marker?.kind).toBe('officepilot-emergency-quarantine');
    expect(marker?.formatVersion).toBe(1);
    expect(marker?.sourceStorageKey).toBe(TARGET_KEY);
    expect(marker?.sourceScopeKey).toBe(TARGET_SCOPE_KEY);
    expect(marker?.workspaceId).toBe(WORKSPACE_ID);
    expect(marker?.archiveSha256).toBe(session.archiveSha256);
    expect(marker?.sourceRawTextSha256).toBe(session.sourceRawTextSha256);
    expect(marker?.createdAt).toBe(NOW);
    expect(marker?.files.map((f) => f.fileRefId).sort()).toEqual(['ref-a', 'ref-b']);
    for (const file of files) {
      const entry = marker?.files.find((f) => f.fileRefId === file.id);
      expect(entry?.localDataKey).toBe(file.localDataKey);
      expect(entry?.mimeType).toBe(file.mimeType);
      expect(entry?.fileSize).toBe(file.bytes.byteLength);
      expect(entry?.sha256).toBe(file.hash);
    }
    // Vergleichswerte für 02Q liegen im complete-Marker.
    expect(marker?.targetSnapshot?.rawTextSha256).toBe(session.sourceRawTextSha256);

    // Hülle mit unverändertem Rohtext.
    const envelope = JSON.parse(
      localStorage.getItem(buildQuarantineStateKey(result.token)) ?? '{}',
    ) as QuarantineStateEnvelope;
    expect(envelope.rawText).toBe(before.raw);
    expect(envelope.token).toBe(result.token);
    expect(envelope.archiveSha256).toBe(session.archiveSha256);
    expect(envelope.files.length).toBe(2);

    // Quarantäneblobs byteidentisch.
    const scopeKey = buildQuarantineBlobScopeKey(result.token);
    for (const file of files) {
      const stored = await readQuarantineBlob(scopeKey, file.id);
      expect(Array.from(stored!.bytes)).toEqual(Array.from(file.bytes));
      expect(stored!.contentHash).toBe(file.hash);
      expect(stored!.mimeType).toBe(file.mimeType);
    }

    // Zielbereich unverändert.
    expect(await captureTarget()).toEqual(before);
  });

  it('C2: der Token trägt Archivhashanteil und Zufall und ist kein Scope', async () => {
    await seedTarget(await buildSeedFiles());
    const session = await prepareAndVerify();
    const result = await createTargetQuarantine(session, { now: NOW });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.token.startsWith(`q-${session.archiveSha256.slice(0, 16)}-`)).toBe(true);
    expect(result.token).toMatch(/^q-[0-9a-f]{16}-[0-9a-f]{16,}$/);
    expect(result.quarantineScopeKey).toBe(`quarantine:${result.token}`);
    expect(result.quarantineScopeKey.startsWith('guest')).toBe(false);
    expect(result.quarantineScopeKey.startsWith('user:')).toBe(false);
    expect(result.quarantineScopeKey.startsWith('workspace:')).toBe(false);
  });

  it('C3: fehlendes crypto.getRandomValues blockiert vor jedem Schreibzugriff', async () => {
    await seedTarget(await buildSeedFiles());
    const session = await prepareAndVerify();
    const before = await captureTarget();

    vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation(() => {
      throw new Error('unavailable');
    });
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const put = vi.spyOn(IDBObjectStore.prototype, 'put');

    const result = await createTargetQuarantine(session, { now: NOW });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('insecure_random');
    expect(setItem).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
    expect(await captureTarget()).toEqual(before);
  });

  it('C4: der staging-Marker steht vor dem ersten Blob', async () => {
    await seedTarget(await buildSeedFiles());
    const session = await prepareAndVerify();

    const seen: string[] = [];
    const result = await createTargetQuarantine(session, {
      now: NOW,
      onPhase: (phase) => {
        if (phase === 'staging_marker' || phase === 'write_blob') {
          const markers = localStorageKeys().filter((key) =>
            key.startsWith(QUARANTINE_MARKER_PREFIX),
          );
          seen.push(`${phase}:${markers.length}`);
        }
      },
    });
    expect(result.ok).toBe(true);
    // Beim ersten Blob existiert der Marker bereits.
    expect(seen.filter((entry) => entry.startsWith('write_blob:'))).toEqual([
      'write_blob:1',
      'write_blob:1',
    ]);
  });

  it('C5: nichts wird unter guest, user oder workspace geschrieben', async () => {
    await seedTarget(await buildSeedFiles());
    const session = await prepareAndVerify();
    const result = await createTargetQuarantine(session, { now: NOW });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const keys = localStorageKeys();
    expect(keys.filter((key) => key === 'officepilot-state:guest')).toEqual([]);
    expect(keys.filter((key) => key.startsWith('officepilot-state:user:'))).toEqual([]);
    expect(keys.filter((key) => key.startsWith('officepilot-state:workspace:'))).toEqual([
      TARGET_KEY,
    ]);
    // Blobs liegen nur unter dem Quarantäne-Token, nicht im Gastbereich.
    expect(await readScopeBlobRecord('guest', 'ref-a')).toMatchObject({ status: 'missing' });
    const stored = await listQuarantineBlobRecords(buildQuarantineBlobScopeKey(result.token));
    expect(stored.map((entry) => entry.fileRefId)).toEqual(['ref-a', 'ref-b']);
  });

  it('C6: ein zweiter staging-Vorgang für dasselbe Ziel blockiert', async () => {
    await seedTarget(await buildSeedFiles());
    const session = await prepareAndVerify();

    // Harter Abbruch hinterlässt einen staging-Marker.
    const aborted = await createTargetQuarantine(session, {
      now: NOW,
      failAtPhase: 'write_blob',
      failAtIndex: 0,
      simulateHardAbort: true,
    });
    expect(aborted.ok).toBe(false);

    const second = await prepareAndVerify();
    const blocked = await createTargetQuarantine(second, { now: NOW });
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) {
      expect(blocked.reason).toBe('staging_exists');
      expect(blocked.existingToken).toBeTruthy();
    }
  });
});

describe('02P2/D — Fehler- und Abbruchfälle', () => {
  const phases: { label: string; phase: Parameters<typeof createTargetQuarantine>[1] }[] = [
    { label: 'staging-Marker', phase: { failAtPhase: 'staging_marker' } },
    { label: 'erster Blob', phase: { failAtPhase: 'write_blob', failAtIndex: 0 } },
    { label: 'zweiter Blob', phase: { failAtPhase: 'write_blob', failAtIndex: 1 } },
    { label: 'Rücklesen eines Blobs', phase: { failAtPhase: 'read_back_blob', failAtIndex: 1 } },
    { label: 'Hülle schreiben', phase: { failAtPhase: 'write_envelope' } },
    { label: 'Hülle zurücklesen', phase: { failAtPhase: 'read_back_envelope' } },
    { label: 'Abschlussprüfung', phase: { failAtPhase: 'final_verify' } },
    { label: 'complete-Marker', phase: { failAtPhase: 'complete_marker' } },
  ];

  for (const { label, phase } of phases) {
    it(`D-${label}: Zielbereich bleibt unverändert und nichts gilt als vollständig`, async () => {
      await seedTarget(await buildSeedFiles());
      const before = await captureTarget();
      const session = await prepareAndVerify();

      const result = await createTargetQuarantine(session, { now: NOW, ...phase });
      expect(result.ok, `unerwartet erfolgreich: ${label}`).toBe(false);
      if (!result.ok) expect(result.cleanedUp).toBe(true);

      expect(await captureTarget()).toEqual(before);
      expect(listQuarantineMarkers()).toEqual([]);
      expect(localStorageKeys().filter((key) => key.startsWith(QUARANTINE_STATE_PREFIX))).toEqual(
        [],
      );
      if (!result.ok && result.token) {
        const rest = await listQuarantineBlobRecords(buildQuarantineBlobScopeKey(result.token));
        expect(rest).toEqual([]);
      }
    });
  }

  it('D-vorher: ein vor Beginn veränderter Ziel-Rohtext blockiert', async () => {
    const files = await buildSeedFiles();
    await seedTarget(files);
    const session = await prepareAndVerify();

    localStorage.setItem(TARGET_KEY, buildTargetRawState(files, { savedAt: '2026-08-18T00:00:00.000Z' }));
    const result = await createTargetQuarantine(session, { now: NOW });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('target_changed');
    expect(listQuarantineMarkers()).toEqual([]);
  });

  it('D-vorher-menge: eine vor Beginn veränderte FileRef-Menge blockiert', async () => {
    const files = await buildSeedFiles();
    await seedTarget(files);
    const session = await prepareAndVerify();

    localStorage.setItem(TARGET_KEY, buildTargetRawState([files[0]!]));
    const result = await createTargetQuarantine(session, { now: NOW });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('target_changed');
  });

  it('D-vorher-blob: ein vor Beginn veränderter Zielblob blockiert', async () => {
    const files = await buildSeedFiles();
    await seedTarget(files);
    const session = await prepareAndVerify();

    await saveDocumentBlob({
      fileRefId: files[1]!.id,
      blob: new Blob([new Uint8Array([9, 9, 9, 9, 9, 9])], { type: files[1]!.mimeType }),
      mimeType: files[1]!.mimeType,
      fileSize: 6,
      contentHash: files[1]!.hash,
      createdAt: '2026-08-17T08:00:00.000Z',
      scope: { type: 'workspace', workspaceId: WORKSPACE_ID },
    });

    const result = await createTargetQuarantine(session, { now: NOW });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('target_changed');
  });

  it('D-während: eine Zieländerung während der Kopie verhindert complete', async () => {
    const files = await buildSeedFiles();
    await seedTarget(files);
    const before = await captureTarget();
    const session = await prepareAndVerify();

    const result = await createTargetQuarantine(session, {
      now: NOW,
      onPhase: (phase, index) => {
        if (phase === 'write_blob' && index === 1) {
          localStorage.setItem(
            TARGET_KEY,
            buildTargetRawState(files, { savedAt: '2026-08-18T01:00:00.000Z' }),
          );
        }
      },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('target_changed');
      expect(result.cleanedUp).toBe(true);
    }
    expect(listQuarantineMarkers()).toEqual([]);
    /**
     * Wichtig für die Berichtsaussage: der Zielbereich ist hier NICHT
     * byteidentisch zum Ausgangszustand — der Test simuliert ausdrücklich eine
     * fremde Änderung. Sie bleibt erhalten und wird nicht rückgängig gemacht.
     * Der Quarantänedienst selbst schreibt und löscht im Zielscope nichts.
     */
    const after = await captureTarget();
    expect(after.raw).not.toBe(before.raw);
    expect(after.blobs).toEqual(before.blobs);
  });

  it('D-harter-Abbruch: staging-Marker und Daten bleiben erkennbar erhalten', async () => {
    await seedTarget(await buildSeedFiles());
    const session = await prepareAndVerify();

    const result = await createTargetQuarantine(session, {
      now: NOW,
      failAtPhase: 'write_envelope',
      simulateHardAbort: true,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.cleanedUp).toBeFalsy();

    const markers = listQuarantineMarkers();
    expect(markers.length).toBe(1);
    expect(markers[0]?.status).toBe('staging');
    expect(markers[0]?.token).toBe(result.token);

    // Erneutes Auflisten löscht nichts und startet nichts neu.
    expect(listQuarantineMarkers().length).toBe(1);
    const stored = await listQuarantineBlobRecords(buildQuarantineBlobScopeKey(result.token!));
    expect(stored.length).toBe(2);
  });
});

describe('02P2/E — ausdrückliche Bereinigung', () => {
  async function seedForeignToken(token: string, status: 'staging' | 'complete') {
    localStorage.setItem(
      buildQuarantineMarkerKey(token),
      JSON.stringify({
        kind: 'officepilot-emergency-quarantine',
        formatVersion: 1,
        token,
        status,
        sourceStorageKey: 'officepilot-state:workspace:ws-fremd',
        sourceScopeKey: 'workspace:ws-fremd',
        workspaceId: 'ws-fremd',
        archiveSha256: 'a'.repeat(64),
        sourceRawTextSha256: 'b'.repeat(64),
        files: [],
        createdAt: NOW,
      }),
    );
    await writeQuarantineBlob({
      scopeKey: buildQuarantineBlobScopeKey(token),
      fileRefId: 'fremd-ref',
      bytes: new Uint8Array([7, 7, 7]),
      mimeType: 'application/octet-stream',
      fileSize: 3,
      contentHash: 'c'.repeat(64),
      createdAt: NOW,
    });
  }

  it('E1: ein complete-Marker wird nicht bereinigt', async () => {
    await seedTarget(await buildSeedFiles());
    const session = await prepareAndVerify();
    const result = await createTargetQuarantine(session, { now: NOW });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const cleanup = await cleanupStagingQuarantine(result.token);
    expect(cleanup.ok).toBe(false);
    if (!cleanup.ok) expect(cleanup.reason).toBe('not_staging');
    expect(readQuarantineMarker(result.token)?.status).toBe('complete');
  });

  it('E2: ein staging-Vorgang wird nur auf ausdrückliche Anforderung bereinigt', async () => {
    await seedTarget(await buildSeedFiles());
    const before = await captureTarget();
    const session = await prepareAndVerify();

    const aborted = await createTargetQuarantine(session, {
      now: NOW,
      failAtPhase: 'write_envelope',
      simulateHardAbort: true,
    });
    expect(aborted.ok).toBe(false);
    if (aborted.ok) return;
    const token = aborted.token!;

    await seedForeignToken(FOREIGN_STAGING_TOKEN, 'staging');
    await seedForeignToken(FOREIGN_COMPLETE_TOKEN, 'complete');

    const cleanup = await cleanupStagingQuarantine(token);
    expect(cleanup.ok, JSON.stringify(cleanup)).toBe(true);
    if (cleanup.ok) expect(cleanup.deletedBlobs).toBe(2);

    expect(readQuarantineMarker(token)).toBeNull();
    expect(localStorage.getItem(buildQuarantineStateKey(token))).toBeNull();
    expect(await listQuarantineBlobRecords(buildQuarantineBlobScopeKey(token))).toEqual([]);

    // Fremde Vorgänge bleiben vollständig unberührt.
    expect(readQuarantineMarker(FOREIGN_STAGING_TOKEN)?.status).toBe('staging');
    expect(readQuarantineMarker(FOREIGN_COMPLETE_TOKEN)?.status).toBe('complete');
    expect(
      (await listQuarantineBlobRecords(buildQuarantineBlobScopeKey(FOREIGN_STAGING_TOKEN))).length,
    ).toBe(1);
    expect(
      (await listQuarantineBlobRecords(buildQuarantineBlobScopeKey(FOREIGN_COMPLETE_TOKEN))).length,
    ).toBe(1);

    // Zielbereich unverändert.
    expect(await captureTarget()).toEqual(before);
  });

  it('E3: ein unbekannter Token wird abgelehnt', async () => {
    const cleanup = await cleanupStagingQuarantine(UNKNOWN_TOKEN);
    expect(cleanup.ok).toBe(false);
    if (!cleanup.ok) expect(cleanup.reason).toBe('not_found');
  });
});


/* ========================================================================== *
 * OFFICEPILOT-COMPANY-IDENTITY-RECOVERY-02P2A — Beweislücken schliessen
 * ========================================================================== */

/** Deterministische Folge von Zufallsblöcken für die Tokenbildung. */
function stubRandomSequence(hexBlocks: string[]): void {
  let call = 0;
  vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation((array) => {
    const view = array as Uint8Array;
    const hex = hexBlocks[Math.min(call, hexBlocks.length - 1)] ?? '0'.repeat(16);
    call += 1;
    for (let index = 0; index < view.length; index += 1) {
      view[index] = parseInt(hex.slice(index * 2, index * 2 + 2) || '00', 16);
    }
    return array;
  });
}

describe('02P2A/A — ZIP und Ziel-Snapshot fest verbinden', () => {
  it('AA1: eine Zieländerung zwischen ZIP-Bau und Abschluss-Snapshot verhindert die Sitzung', async () => {
    const files = await buildSeedFiles();
    await seedTarget(files);

    const put = vi.spyOn(IDBObjectStore.prototype, 'put');
    const result = await prepareTargetBackupSession(TARGET_KEY, {
      onStage: (stage) => {
        if (stage === 'validated') {
          localStorage.setItem(
            TARGET_KEY,
            buildTargetRawState(files, { savedAt: '2026-08-19T00:00:00.000Z' }),
          );
        }
      },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('target_changed');
    expect(put).not.toHaveBeenCalled();
  });

  it('AA2: der gespeicherte Ziel-Snapshot stammt aus dem validierten Bündel', async () => {
    await seedTarget(await buildSeedFiles());
    const prepared = await prepareTargetBackupSession(TARGET_KEY);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;

    expect(prepared.session.targetSnapshot.rawTextSha256).toBe(
      prepared.session.bundle.sourceRawTextSha256,
    );
    expect(prepared.session.targetSnapshot.files).toEqual(
      [...prepared.session.bundle.files]
        .map((file) => ({
          fileRefId: file.fileRefId,
          fileSize: file.fileSize,
          sha256: file.sha256,
        }))
        .sort((a, b) => a.fileRefId.localeCompare(b.fileRefId)),
    );
  });
});

describe('02P2A/B — Hülle stammt aus der erneut ausgewählten Sicherung', () => {
  it('BB1: ein zwischenzeitlich veränderter Zielrohtext gelangt nie in die Hülle', async () => {
    const files = await buildSeedFiles();
    const original = await seedTarget(files);
    const session = await prepareAndVerify();

    const result = await createTargetQuarantine(session, {
      now: NOW,
      onPhase: (phase) => {
        if (phase === 'write_envelope') {
          localStorage.setItem(
            TARGET_KEY,
            buildTargetRawState(files, { savedAt: '2026-08-19T12:00:00.000Z' }),
          );
        }
        if (phase === 'final_verify') {
          localStorage.setItem(TARGET_KEY, original);
        }
      },
    });

    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;

    const envelope = JSON.parse(
      localStorage.getItem(buildQuarantineStateKey(result.token)) ?? '{}',
    ) as QuarantineStateEnvelope;
    expect(envelope.rawText).toBe(original);
    expect(envelope.rawText).toBe(session.reselectedBundle.sourceRawText);
    expect(await computeBufferContentHash(new TextEncoder().encode(envelope.rawText))).toBe(
      session.sourceRawTextSha256,
    );
  });
});

describe('02P2A/C — Sitzung ist versiegelt', () => {
  it('CC1: die vorbereitete Sitzung lässt sich nicht verändern', async () => {
    await seedTarget(await buildSeedFiles());
    const prepared = await prepareTargetBackupSession(TARGET_KEY);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    const session = prepared.session;

    expect(() => {
      (session.files[0] as { sha256: string }).sha256 = 'x';
    }).toThrow();
    expect(() => {
      (session.targetSnapshot.files[0] as { sha256: string }).sha256 = 'x';
    }).toThrow();
    expect(() => {
      (session.files as unknown as unknown[]).push({});
    }).toThrow();
    expect(() => {
      (session.targetSnapshot.files as unknown as unknown[]).push({});
    }).toThrow();
    expect(() => {
      (session as unknown as { archiveSha256: string }).archiveSha256 = 'x';
    }).toThrow();
  });

  it('CC2: die verifizierte Sitzung lässt sich ebenfalls nicht verändern', async () => {
    await seedTarget(await buildSeedFiles());
    const session = await prepareAndVerify();

    expect(() => {
      (session.files[0] as { sha256: string }).sha256 = 'x';
    }).toThrow();
    expect(() => {
      (session as unknown as { sourceStorageKey: string }).sourceStorageKey = 'y';
    }).toThrow();
  });

  it('CC3: eine manipulierte Kopie beeinflusst weder Wiederauswahl noch Quarantäne', async () => {
    await seedTarget(await buildSeedFiles());
    const prepared = await prepareTargetBackupSession(TARGET_KEY);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;

    const copy = { ...prepared.session, archiveSha256: 'f'.repeat(64) };
    const verify = await verifyReselectedTargetBackup(copy, prepared.session.zipBlob);
    expect(verify.ok).toBe(false);
    if (!verify.ok) expect(verify.reason).toBe('unknown_session');

    const verified = await prepareAndVerify();
    const forgedVerified = { ...verified, sourceStorageKey: 'officepilot-state:guest' };
    const quarantine = await createTargetQuarantine(
      forgedVerified as VerifiedTargetBackupSession,
      { now: NOW },
    );
    expect(quarantine.ok).toBe(false);
    if (!quarantine.ok) expect(quarantine.reason).toBe('unknown_session');
  });

  it('CC4: die Quarantäne stützt sich auf die private Bindung', async () => {
    await seedTarget(await buildSeedFiles());
    const session = await prepareAndVerify();
    const result = await createTargetQuarantine(session, { now: NOW });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.marker.archiveSha256).toBe(session.archiveSha256);
    expect(result.marker.sourceStorageKey).toBe(TARGET_KEY);
  });
});

describe('02P2A/D — Hülle vollständig prüfen', () => {
  const envelopeCases: { label: string; mutate: (envelope: QuarantineStateEnvelope) => void }[] = [
    {
      label: 'archiveSha256',
      mutate: (envelope) => {
        envelope.archiveSha256 = 'e'.repeat(64);
      },
    },
    {
      label: 'Dateihash',
      mutate: (envelope) => {
        envelope.files[0]!.sha256 = 'd'.repeat(64);
      },
    },
    {
      label: 'sourceStorageKey',
      mutate: (envelope) => {
        envelope.sourceStorageKey = 'officepilot-state:guest';
      },
    },
    {
      label: 'token',
      mutate: (envelope) => {
        envelope.token = FOREIGN_STAGING_TOKEN;
      },
    },
    {
      label: 'rawText',
      mutate: (envelope) => {
        envelope.rawText = '{}';
      },
    },
  ];

  for (const { label, mutate } of envelopeCases) {
    it(`DD-${label}: eine nach der Rückleseprüfung veränderte Hülle verhindert complete`, async () => {
      await seedTarget(await buildSeedFiles());
      const before = await captureTarget();
      const session = await prepareAndVerify();

      const result = await createTargetQuarantine(session, {
        now: NOW,
        onPhase: (phase) => {
          if (phase !== 'final_verify') return;
          const marker = listQuarantineMarkers()[0];
          if (!marker) return;
          const stateKey = buildQuarantineStateKey(marker.token);
          const envelope = JSON.parse(
            localStorage.getItem(stateKey) ?? '{}',
          ) as QuarantineStateEnvelope;
          mutate(envelope);
          localStorage.setItem(stateKey, JSON.stringify(envelope));
        },
      });

      expect(result.ok, `unerwartet complete: ${label}`).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('envelope_failed');
        expect(result.cleanedUp).toBe(true);
      }
      expect(listQuarantineMarkers()).toEqual([]);
      expect(await captureTarget()).toEqual(before);
    });
  }
});

describe('02P2A/E — complete-Marker vollständig prüfen', () => {
  const markerCases: { label: string; mutate: (marker: QuarantineMarker) => void }[] = [
    {
      label: 'anderer Token',
      mutate: (marker) => {
        marker.token = FOREIGN_STAGING_TOKEN;
      },
    },
    {
      label: 'anderer Archivhash',
      mutate: (marker) => {
        marker.archiveSha256 = 'a'.repeat(64);
      },
    },
    {
      label: 'veraenderte Dateiliste',
      mutate: (marker) => {
        marker.files = [];
      },
    },
    {
      label: 'veraenderter Snapshot',
      mutate: (marker) => {
        marker.targetSnapshot = { rawTextSha256: 'b'.repeat(64), files: [] };
      },
    },
  ];

  for (const { label, mutate } of markerCases) {
    it(`EE-${label}: ein widersprüchlicher complete-Marker wird nicht akzeptiert`, async () => {
      await seedTarget(await buildSeedFiles());
      const session = await prepareAndVerify();

      const result = await createTargetQuarantine(session, {
        now: NOW,
        onPhase: (phase) => {
          if (phase !== 'verify_complete_marker') return;
          const key = localStorageKeys().find((entry) =>
            entry.startsWith(QUARANTINE_MARKER_PREFIX),
          );
          if (!key) return;
          const marker = JSON.parse(localStorage.getItem(key) ?? '{}') as QuarantineMarker;
          mutate(marker);
          localStorage.setItem(key, JSON.stringify(marker));
        },
      });

      expect(result.ok, `unerwartet akzeptiert: ${label}`).toBe(false);
      if (!result.ok) expect(result.reason).toBe('marker_failed');
      expect(listQuarantineMarkers()).toEqual([]);
    });
  }

  it('EE-Schluessel: ein Marker, dessen Token nicht zum Schlüssel passt, wird verworfen', async () => {
    const marker: QuarantineMarker = {
      kind: 'officepilot-emergency-quarantine',
      formatVersion: 1,
      token: FOREIGN_COMPLETE_TOKEN,
      status: 'complete',
      sourceStorageKey: TARGET_KEY,
      sourceScopeKey: TARGET_SCOPE_KEY,
      workspaceId: WORKSPACE_ID,
      archiveSha256: 'a'.repeat(64),
      sourceRawTextSha256: 'b'.repeat(64),
      files: [],
      createdAt: NOW,
    };
    // Unter einem FREMDEN Schlüssel abgelegt.
    localStorage.setItem(buildQuarantineMarkerKey(FOREIGN_STAGING_TOKEN), JSON.stringify(marker));

    expect(readQuarantineMarker(FOREIGN_STAGING_TOKEN)).toBeNull();
    expect(listQuarantineMarkers()).toEqual([]);
  });
});

describe('02P2A/F — Token-Kollision', () => {
  async function seedTokenArtifacts(
    token: string,
    kind: 'marker_staging' | 'marker_complete' | 'envelope' | 'blob',
  ): Promise<void> {
    if (kind === 'marker_staging' || kind === 'marker_complete') {
      localStorage.setItem(
        buildQuarantineMarkerKey(token),
        JSON.stringify({
          kind: 'officepilot-emergency-quarantine',
          formatVersion: 1,
          token,
          status: kind === 'marker_staging' ? 'staging' : 'complete',
          sourceStorageKey: 'officepilot-state:workspace:ws-anderes-ziel',
          sourceScopeKey: 'workspace:ws-anderes-ziel',
          workspaceId: 'ws-anderes-ziel',
          archiveSha256: 'a'.repeat(64),
          sourceRawTextSha256: 'b'.repeat(64),
          files: [],
          createdAt: NOW,
        }),
      );
      return;
    }
    if (kind === 'envelope') {
      localStorage.setItem(buildQuarantineStateKey(token), JSON.stringify({ token }));
      return;
    }
    await writeQuarantineBlob({
      scopeKey: buildQuarantineBlobScopeKey(token),
      fileRefId: 'belegt-ref',
      bytes: new Uint8Array([1, 2, 3]),
      mimeType: 'application/octet-stream',
      fileSize: 3,
      contentHash: 'c'.repeat(64),
      createdAt: NOW,
    });
  }

  const collisionKinds = ['marker_staging', 'marker_complete', 'envelope', 'blob'] as const;

  for (const kind of collisionKinds) {
    it(`FF-${kind}: ein belegter Token wird nie überschrieben`, async () => {
      await seedTarget(await buildSeedFiles());
      const prepared = await prepareTargetBackupSession(TARGET_KEY);
      expect(prepared.ok).toBe(true);
      if (!prepared.ok) return;
      const archivePart = prepared.session.archiveSha256.slice(0, 16);
      const taken = `q-${archivePart}-1111111111111111`;
      const free = `q-${archivePart}-2222222222222222`;
      await seedTokenArtifacts(taken, kind);
      const takenBefore = JSON.stringify({
        marker: localStorage.getItem(buildQuarantineMarkerKey(taken)),
        state: localStorage.getItem(buildQuarantineStateKey(taken)),
        blobs: await listQuarantineBlobRecords(buildQuarantineBlobScopeKey(taken)),
      });

      const verified = await verifyReselectedTargetBackup(
        prepared.session,
        prepared.session.zipBlob,
      );
      expect(verified.ok).toBe(true);
      if (!verified.ok) return;

      stubRandomSequence(['1111111111111111', '2222222222222222']);
      const result = await createTargetQuarantine(verified.session, { now: NOW });

      expect(result.ok, JSON.stringify(result)).toBe(true);
      if (!result.ok) return;
      expect(result.token).toBe(free);

      const takenAfter = JSON.stringify({
        marker: localStorage.getItem(buildQuarantineMarkerKey(taken)),
        state: localStorage.getItem(buildQuarantineStateKey(taken)),
        blobs: await listQuarantineBlobRecords(buildQuarantineBlobScopeKey(taken)),
      });
      expect(takenAfter).toBe(takenBefore);
    });
  }

  it('FF-alle: bleiben alle Versuche belegt, wird mit token_collision abgebrochen', async () => {
    await seedTarget(await buildSeedFiles());
    const prepared = await prepareTargetBackupSession(TARGET_KEY);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    const archivePart = prepared.session.archiveSha256.slice(0, 16);
    const taken = `q-${archivePart}-3333333333333333`;
    await seedTokenArtifacts(taken, 'marker_complete');
    const before = localStorage.getItem(buildQuarantineMarkerKey(taken));

    const verified = await verifyReselectedTargetBackup(prepared.session, prepared.session.zipBlob);
    expect(verified.ok).toBe(true);
    if (!verified.ok) return;

    stubRandomSequence(['3333333333333333']);
    const result = await createTargetQuarantine(verified.session, { now: NOW });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('token_collision');
    expect(localStorage.getItem(buildQuarantineMarkerKey(taken))).toBe(before);
  });
});

describe('02P2A/G — strenge Quarantäne-Schlüsselprüfung', () => {
  const invalidKeys = [
    'quarantine:',
    'quarantine:foo',
    'quarantine:q-test',
    'quarantine:Q-0123456789ABCDEF-0123456789abcdef',
    'quarantine:q-0123456789abcdef-0123',
    'workspace:ws-p2-target',
    'guest',
    'user:user-p2',
  ];

  for (const key of invalidKeys) {
    it(`GG: "${key}" wird von der Quarantäne-Blob-API abgelehnt`, async () => {
      const scopeKey = key as `quarantine:${string}`;
      await expect(
        writeQuarantineBlob({
          scopeKey,
          fileRefId: 'ref-x',
          bytes: new Uint8Array([1]),
          mimeType: 'application/octet-stream',
          fileSize: 1,
          contentHash: 'c'.repeat(64),
          createdAt: NOW,
        }),
      ).rejects.toThrow();
      await expect(readQuarantineBlob(scopeKey, 'ref-x')).rejects.toThrow();
      await expect(listQuarantineBlobRecords(scopeKey)).rejects.toThrow();
    });
  }

  it('GG-gueltig: ein formatgültiger Token wird angenommen', async () => {
    const scopeKey = buildQuarantineBlobScopeKey(FOREIGN_STAGING_TOKEN);
    await writeQuarantineBlob({
      scopeKey,
      fileRefId: 'ref-x',
      bytes: new Uint8Array([1, 2]),
      mimeType: 'application/octet-stream',
      fileSize: 2,
      contentHash: 'c'.repeat(64),
      createdAt: NOW,
    });
    expect((await listQuarantineBlobRecords(scopeKey)).length).toBe(1);
  });
});
