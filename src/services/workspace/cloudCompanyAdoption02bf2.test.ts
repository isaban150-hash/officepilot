/**
 * OFFICETAKT-02B-F2 — Cloud-Firmendaten sicher übernehmen.
 *
 * Geprüft wird der Dienst hinter der neuen Aktion, nicht die Oberfläche:
 * Die Quarantäne muss vollständig sein, bevor irgendetwas verändert wird;
 * verändert wird genau ein Schlüssel; die Cloud wird nie beschrieben; und
 * ein veralteter Outbox-Eintrag wandert in die Quarantäne, nicht in die Cloud.
 *
 * Firmennamen sind Prüfwerte. Der Cloud-Name entspricht dem echten Fall,
 * damit die Zusage „die Cloud-Firma bleibt" am selben Wort hängt.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyConfirmedCloudCompany } from './workspaceCompanyRecoveryService';
import { detectCompanyConflict, readLocalCompanyCandidate } from './workspaceCompanyConflictService';
import {
  createQuarantineFromLiveScope,
  listQuarantineMarkers,
  resetQuarantineSessionsForTests,
} from '../storage/localScopeEmergencyQuarantineService';
import {
  readQuarantineBlob,
  resetDocumentBlobDatabaseForTests,
  saveDocumentBlob,
} from '../storage/documentBlobIndexedDbService';
import { buildQuarantineBlobScopeKey } from '../storage/localScopeEmergencyQuarantineService';
import { resetStorageScopeForTests } from '../storage/storageScopeService';
import { computeBufferContentHash } from '../documentFileHashService';
import { clearMockRpcHandlers, registerMockRpcHandler } from '../../test/mockProfileStore';
import { STORAGE_VERSION } from '../sync/syncMigrationService';
import { DEFAULT_SETUP } from '../../data/mockData';
import { DEFAULT_COMPANY_PROFILE } from '../../data/companyProfileDefaults';

const WORKSPACE_ID = 'ws-f2-cloud-adoption';
const KEY = `officepilot-state:workspace:${WORKSPACE_ID}`;
const LOKAL = 'OfficePilot Cloud Test';
const CLOUD = 'Çırmak Haustechnik GmbH';
const BYTES = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);

let upserts = 0;
let pulls = 0;

function cloudPull(setupVersion = 10, profileVersion = 90, name = CLOUD) {
  return {
    workspace: { id: WORKSPACE_ID, name, owner_user_id: 'user-f2', version: 1, updated_at: '2026-09-01T00:00:00.000Z', deleted: false },
    members: [],
    settings: null,
    vorgaenge: [],
    setup: {
      workspace_id: WORKSPACE_ID,
      payload: { ...DEFAULT_SETUP, companyName: name, setupComplete: true, setupVersion: 1 },
      row_version: setupVersion,
      updated_at: '2026-09-01T00:00:00.000Z',
    },
    company_profile: {
      workspace_id: WORKSPACE_ID,
      payload: { ...DEFAULT_COMPANY_PROFILE, companyName: name },
      row_version: profileVersion,
      updated_at: '2026-09-01T00:00:00.000Z',
    },
  };
}

async function seedStaleLocal(): Promise<string> {
  const hash = await computeBufferContentHash(BYTES);
  const raw = JSON.stringify({
    version: STORAGE_VERSION,
    setup: { ...DEFAULT_SETUP, companyName: LOKAL, setupComplete: true, setupVersion: 1 },
    companyProfile: { ...DEFAULT_COMPANY_PROFILE, companyName: LOKAL },
    workspace: { id: WORKSPACE_ID, name: LOKAL, ownerUserId: 'user-f2' },
    syncClient: { deviceId: 'device-f2', workspaceId: WORKSPACE_ID, serverWorkspaceId: WORKSPACE_ID, syncPolicy: 'cloud' },
    inboxItems: [{ id: 'inbox-f2-alt', title: 'Alter Testeingang' }],
    vorgaenge: [],
    invoiceEntries: [],
    tasks: [],
    documents: [],
    expenses: [],
    documentWorkResults: [],
    documentFileRefs: [
      {
        id: 'ref-f2',
        originalFileName: 'alt.pdf',
        mimeType: 'application/pdf',
        fileSize: BYTES.byteLength,
        contentHash: hash,
        storageType: 'indexeddb',
        localDataKey: 'key-f2',
        createdAt: '2026-08-01T08:00:00.000Z',
        lifecycleStatus: 'committed',
        committedAt: '2026-08-01T08:05:00.000Z',
      },
    ],
    /* Der Kern des Risikos: ein alter, nie gesendeter Eintrag. */
    syncOutbox: [
      { id: 'ob-alt', entityType: 'inbox_item', entityId: 'inbox-f2-alt', operation: 'create', version: 1, status: 'pending', createdAt: '2026-08-01T08:10:00.000Z' },
    ],
    savedAt: '2026-08-01T09:00:00.000Z',
  });
  localStorage.setItem(KEY, raw);
  await saveDocumentBlob({
    fileRefId: 'ref-f2',
    blob: new Blob([BYTES], { type: 'application/pdf' }),
    mimeType: 'application/pdf',
    fileSize: BYTES.byteLength,
    contentHash: hash,
    createdAt: '2026-08-01T08:00:00.000Z',
    scope: { type: 'workspace', workspaceId: WORKSPACE_ID },
  });
  return raw;
}

beforeEach(async () => {
  localStorage.clear();
  resetStorageScopeForTests();
  resetQuarantineSessionsForTests();
  await resetDocumentBlobDatabaseForTests();
  clearMockRpcHandlers();
  upserts = 0;
  pulls = 0;
  registerMockRpcHandler('pull_workspace_sync_state', () => {
    pulls += 1;
    return cloudPull();
  });
  registerMockRpcHandler('upsert_workspace_sync_entity', () => {
    upserts += 1;
    return { row_version: 999 };
  });
});

afterEach(() => {
  clearMockRpcHandlers();
});

describe('A — der Konflikt, wie er beim Nutzer aussieht', () => {
  it('lokal veraltet, Cloud aktuell → Konflikt mit beiden Namen', async () => {
    await seedStaleLocal();
    const candidate = readLocalCompanyCandidate(WORKSPACE_ID);
    const conflict = detectCompanyConflict(
      candidate,
      { setupCompanyName: CLOUD, profileCompanyName: CLOUD, setupRowVersion: 10, companyProfileRowVersion: 90 },
      WORKSPACE_ID,
    );
    expect(conflict?.localCompanyName).toBe(LOKAL);
    expect(conflict?.cloudCompanyName).toBe(CLOUD);
  });
});

describe('B — Quarantäne aus dem lebenden Bestand', () => {
  it('sichert Rohtext und Dateien vollständig, ohne den Zielbereich zu verändern', async () => {
    const raw = await seedStaleLocal();
    const result = await createQuarantineFromLiveScope({ storageKey: KEY, workspaceId: WORKSPACE_ID });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;

    expect(result.marker.status).toBe('complete');
    expect(result.marker.files.map((f) => f.fileRefId)).toEqual(['ref-f2']);
    expect(result.skippedFileRefIds).toEqual([]);
    const envelope = JSON.parse(localStorage.getItem(result.stateKey) ?? '{}') as { rawText?: string };
    expect(envelope.rawText).toBe(raw);
    const blob = await readQuarantineBlob(buildQuarantineBlobScopeKey(result.token), 'ref-f2');
    expect(blob && (await computeBufferContentHash(blob.bytes))).toBe(await computeBufferContentHash(BYTES));
    /* Der Zielbereich ist unverändert. */
    expect(localStorage.getItem(KEY)).toBe(raw);
    expect(listQuarantineMarkers().map((m) => m.status)).toEqual(['complete']);
  });
});

describe('C — die Übernahme der Cloud-Firma', () => {
  it('sichert zuerst, gibt dann genau den einen Schlüssel frei und schreibt nie in die Cloud', async () => {
    const raw = await seedStaleLocal();
    localStorage.setItem('officepilot-state:guest', '{"version":1}');

    const outcome = await applyConfirmedCloudCompany({
      workspaceId: WORKSPACE_ID,
      confirmedLocalCompanyName: LOKAL,
      confirmedCloudCompanyName: CLOUD,
      confirmedCloudSetupRowVersion: 10,
      confirmedCloudProfileRowVersion: 90,
      confirmedRawText: raw,
    });
    expect(outcome.status, JSON.stringify(outcome)).toBe('applied');
    if (outcome.status !== 'applied') return;

    /* Der Workspace-Schlüssel ist frei — und nur er. */
    expect(localStorage.getItem(KEY)).toBeNull();
    expect(localStorage.getItem('officepilot-state:guest')).toBe('{"version":1}');

    /* Die Quarantäne trägt den alten Bestand samt dem nie gesendeten Outbox-Eintrag. */
    const marker = listQuarantineMarkers().find((m) => m.token === outcome.quarantineToken);
    expect(marker?.status).toBe('complete');
    const envelope = JSON.parse(
      localStorage.getItem(`officepilot-emergency-quarantine-state:${outcome.quarantineToken}`) ?? '{}',
    ) as { rawText?: string };
    expect(envelope.rawText).toBe(raw);
    const gesichert = JSON.parse(envelope.rawText ?? '{}') as { syncOutbox: Array<{ id: string }> };
    expect(gesichert.syncOutbox.map((e) => e.id)).toEqual(['ob-alt']);

    /* Kein einziger Schreibaufruf in die Cloud; nur der Kontroll-Pull. */
    expect(upserts).toBe(0);
    expect(pulls).toBe(1);

    /* Danach gibt es keinen lokalen Kandidaten mehr — der Bootstrap läuft den Neugeräte-Weg. */
    expect(readLocalCompanyCandidate(WORKSPACE_ID)).toBeNull();
  });

  it('bricht ab, wenn sich die Cloud seit der Anzeige verändert hat — nichts wird gesichert, nichts entfernt', async () => {
    const raw = await seedStaleLocal();
    clearMockRpcHandlers();
    registerMockRpcHandler('pull_workspace_sync_state', () => cloudPull(11, 90));
    registerMockRpcHandler('upsert_workspace_sync_entity', () => { upserts += 1; return {}; });

    const outcome = await applyConfirmedCloudCompany({
      workspaceId: WORKSPACE_ID,
      confirmedLocalCompanyName: LOKAL,
      confirmedCloudCompanyName: CLOUD,
      confirmedCloudSetupRowVersion: 10,
      confirmedCloudProfileRowVersion: 90,
      confirmedRawText: raw,
    });
    expect(outcome.status).toBe('changed');
    expect(localStorage.getItem(KEY)).toBe(raw);
    expect(listQuarantineMarkers()).toEqual([]);
    expect(upserts).toBe(0);
  });

  it('bricht ab, wenn sich der lokale Bestand seit der Anzeige verändert hat', async () => {
    const raw = await seedStaleLocal();
    const outcome = await applyConfirmedCloudCompany({
      workspaceId: WORKSPACE_ID,
      confirmedLocalCompanyName: LOKAL,
      confirmedCloudCompanyName: CLOUD,
      confirmedCloudSetupRowVersion: 10,
      confirmedCloudProfileRowVersion: 90,
      confirmedRawText: raw.replace(LOKAL, 'Etwas anderes'),
    });
    expect(outcome.status).toBe('changed');
    expect(localStorage.getItem(KEY)).toBe(raw);
    expect(listQuarantineMarkers()).toEqual([]);
  });

  it('gibt den Schlüssel nicht frei, wenn die Cloud keine Firmenidentität trägt', async () => {
    const raw = await seedStaleLocal();
    clearMockRpcHandlers();
    registerMockRpcHandler('pull_workspace_sync_state', () => cloudPull(10, 90, ''));
    const outcome = await applyConfirmedCloudCompany({
      workspaceId: WORKSPACE_ID,
      confirmedLocalCompanyName: LOKAL,
      confirmedCloudCompanyName: '',
      confirmedCloudSetupRowVersion: 10,
      confirmedCloudProfileRowVersion: 90,
      confirmedRawText: raw,
    });
    expect(outcome.status).toBe('failed');
    expect(localStorage.getItem(KEY)).toBe(raw);
  });
});
