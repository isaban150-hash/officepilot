/**
 * E-MAIL-07B-FIX3B — Entscheidung bei einem Konflikt um ein archiviertes Dokument.
 *
 * Bis hierher: „Der Cloud-Stand ist neuer. Bitte entscheiden …" ohne
 * Entscheidungsmöglichkeit, der Auftrag blieb für immer blockiert, und die
 * Sync-Seite zeigte ihn dreifach (Kopf „wartet", Liste „Wartet", „Nicht
 * übertragen · Konflikt"). Jetzt: ein Abschnitt, zwei Entscheidungen, jede mit
 * Bestätigung; der Cloud-Stand wird frisch gelesen, nie still überschrieben.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppProvider } from '../context/AppContext';
import { DEFAULT_SETUP } from '../data/mockData';
import * as supabaseLib from '../lib/supabase';
import * as persistence from '../services/persistenceService';
import * as intake from '../services/document/intakeCloudSyncService';
import { addDocument, getDocumentById, hydrateDocumentStore, getAllDocuments } from '../services/documentService';
import { getSyncOutboxSnapshot, resetSyncOutboxForTests } from '../services/sync/syncOutboxService';
import { resetDocumentFileStoreForTests, hydrateDocumentFileStore } from '../services/documentFileStoreService';
import {
  getDocumentFileRepresentationBindingStoreSnapshot,
  hydrateDocumentFileRepresentationBindingStore,
} from '../services/documentFileRepresentationBindingStoreService';
import { extractCloudSyncEntity } from '../services/workspace/workspaceSyncPayloadService';
import { pushIntakeEntity } from '../services/document/intakeCloudPushService';
import {
  listArchivedDocumentConflicts,
  resolveArchivedDocumentConflict,
} from '../services/document/archivedDocumentConflictService';
import { getSyncUiSnapshot, summarizeSyncStatus } from '../services/sync/syncUiService';
import { isArchivedDocumentSyncBlocked } from '../services/delivery/documentDeliveryCloudService';
import { isArchivedDocumentEmailSendable } from '../components/documents/DocumentDeliveryPanel';
import { rebaseAdditiveArchivedDocumentConflicts } from '../services/document/intakeCloudSyncService';
import { resetTestStores } from '../test/resetStores';
import { SyncPage } from './SyncPage';
import type { CloudArchivedDocumentRow, IntakeCloudPull } from '../services/document/intakeCloudSyncService';
import type { AppPersistedState, CompanyDocument, CompanySetup } from '../types/models';
import type { SyncOutboxEntry } from '../types/sync';
import type { DocumentFileRef } from '../types/documentFileRef';

const WS = '00000000-0000-4000-8000-0000000b7f33';
const setup: CompanySetup = { ...DEFAULT_SETUP, setupComplete: true };
const PDF_DATA_URL = 'data:application/pdf;base64,' + btoa('%PDF-1.4 brief');

function pdfRef(id: string): DocumentFileRef {
  return { id, originalFileName: 'Brief.pdf', mimeType: 'application/pdf', fileSize: 20, contentHash: `hash-${id}`, storageType: 'local_data_url', localDataKey: `blob-${id}`, createdAt: 'x', lifecycleStatus: 'committed' };
}

/** Ein gesynctes Archivdokument mit bestätigter Serverversion. */
function gesynctesDokument(version: number, overrides: Partial<CompanyDocument> = {}): CompanyDocument {
  const angelegt = addDocument({
    title: 'Mietvertrag Halle 3', category: 'sonstiges', issuer: 'Vermieter', issueDate: null, documentDate: null, linkedCompany: '',
    linkedVorgang: null, digitalFolder: { id: 'd', name: 'D', path: '/D/' }, paperFolder: { folderId: 'paper-kunden', register: 'Sonstiges', label: 'K' },
    archived: true, recognizedText: '', tags: [],
  });
  if (!angelegt.success) throw new Error('Dokument');
  const dokument = { ...angelegt.document, ...overrides, sync: { ...angelegt.document.sync!, version } } as CompanyDocument;
  hydrateDocumentStore([...getAllDocuments().filter((d) => d.id !== dokument.id), dokument]);
  return getDocumentById(dokument.id)!;
}

function cloudRow(document: CompanyDocument, version: number, payloadOverrides: Record<string, unknown> = {}, deleted = false): CloudArchivedDocumentRow {
  const payload = intake.buildArchivedDocumentPushPayload(document, false).payload as Record<string, unknown>;
  return {
    client_document_id: document.id, document_kind: 'archived_document', linked_invoice_id: null, linked_vorgang_id: null,
    payload: { ...payload, ...payloadOverrides }, updated_at: '2026-09-26T12:00:00.000Z', deleted, row_version: version,
  };
}

function pullWith(rows: CloudArchivedDocumentRow[], bindings: IntakeCloudPull['bindings'] = []): () => Promise<IntakeCloudPull> {
  return async () => ({ files: [], bindings, inboxItems: [], workResults: [], archivedDocuments: rows });
}

function konflikt(documentId: string): SyncOutboxEntry {
  return { id: `ob-${documentId}`, entityType: 'document', entityId: documentId, operation: 'update', version: 5, queuedAt: 'x', retryCount: 2, status: 'blocked', lastErrorMessage: 'Versionskonflikt archived_document:7', lastErrorAt: 'x', lastErrorRetryable: false };
}

function fakeIntakeServer(initialVersion: number) {
  let rowVersion = initialVersion;
  const client = {
    rpc: vi.fn(async (_n: string, args: { p_entity_type: string; p_row_version: number; p_payload: Record<string, unknown> }) => {
      if (args.p_entity_type !== 'archived_document') return { data: { row_version: 1, deleted: false, payload: {} }, error: null };
      if (args.p_row_version !== rowVersion) return { data: null, error: { message: `Versionskonflikt archived_document:${rowVersion}` } };
      rowVersion += 1;
      return { data: { row_version: rowVersion, deleted: false, payload: args.p_payload }, error: null };
    }),
  };
  return { client: client as never, bump: () => { rowVersion += 1; } };
}

async function push(document: CompanyDocument, server: ReturnType<typeof fakeIntakeServer>) {
  const state = { documents: [document], syncClient: { serverWorkspaceId: WS } } as unknown as AppPersistedState;
  return pushIntakeEntity(extractCloudSyncEntity(state, 'document', document.id)!, 'update', WS, server.client);
}

beforeEach(() => {
  resetTestStores();
  resetDocumentFileStoreForTests();
  resetSyncOutboxForTests([]);
  vi.spyOn(persistence, 'buildPersistedStateSnapshot').mockImplementation(() => ({ syncClient: { serverWorkspaceId: WS } }) as never);
});
afterEach(() => {
  vi.restoreAllMocks();
  resetSyncOutboxForTests([]);
  resetTestStores();
});

/* ================================================================== */

describe('07B-FIX3B — Konflikt erkennen und einmal darstellen', () => {
  it('A: lokal = Cloud, kein blockierter Auftrag — kein Konflikt', () => {
    gesynctesDokument(7);
    expect(listArchivedDocumentConflicts()).toEqual([]);
  });

  it('K: ein blockierter Dokumentauftrag erscheint genau einmal — als Entscheidung, nicht zusätzlich als „wartet"', () => {
    const dokument = gesynctesDokument(5);
    resetSyncOutboxForTests([konflikt(dokument.id)]);
    const snap = getSyncUiSnapshot();
    expect(snap.documentConflicts).toEqual([{ outboxId: `ob-${dokument.id}`, documentId: dokument.id, title: 'Mietvertrag Halle 3' }]);
    expect(snap.pendingOutboxEntries).toEqual([]);
    expect(snap.failedOutboxEntries).toEqual([]);
    const summary = summarizeSyncStatus({ ...snap, status: { ...snap.status, syncState: 'synced' } });
    expect(summary).toMatchObject({ kind: 'conflict', conflictCount: 1, waitingCount: 0 });
  });

  it('ein am Versionskonflikt gescheiterter Push heißt nicht „automatisch zusammengeführt"', () => {
    const snap = getSyncUiSnapshot();
    const summary = summarizeSyncStatus({
      ...snap,
      lastReport: { conflictCount: 1, conflicts: [{ entityType: 'document', entityId: 'd', resolution: 'conflict' }] } as never,
    });
    expect(summary.mergedCount).toBe(0);
  });

  it('andere blockierte Aufträge bleiben, wie sie waren', () => {
    const dokument = gesynctesDokument(5);
    resetSyncOutboxForTests([{ ...konflikt(dokument.id), lastErrorMessage: 'Keine Schreibberechtigung' }]);
    expect(listArchivedDocumentConflicts()).toEqual([]);
    expect(getSyncUiSnapshot().failedOutboxEntries).toHaveLength(1);
  });
});

describe('07B-FIX3B — Online-Version verwenden', () => {
  it('B/C/G: Cloud-Stand übernommen, Auftrag erledigt, kein neuer Push der alten Änderung', async () => {
    const dokument = gesynctesDokument(5, { title: 'Lokal geändert' });
    resetSyncOutboxForTests([konflikt(dokument.id)]);
    const row = cloudRow(dokument, 7, { title: 'Online geändert' });

    const ergebnis = await resolveArchivedDocumentConflict(dokument.id, 'take_cloud', { pullIntake: pullWith([row]) });
    expect(ergebnis).toEqual({ ok: true, decision: 'take_cloud', cloudVersion: 7 });
    const nachher = getDocumentById(dokument.id)!;
    expect(nachher.title).toBe('Online geändert');
    expect(nachher.sync!.version).toBe(7);
    const offen = getSyncOutboxSnapshot().filter((e) => e.entityType === 'document' && e.entityId === dokument.id && e.status !== 'completed');
    expect(offen).toEqual([]);
    expect(listArchivedDocumentConflicts()).toEqual([]);
    // Nächster Push (falls je): trifft die Cloud-Version.
    await expect(push(nachher, fakeIntakeServer(7))).resolves.toMatchObject({ kind: 'pushed' });
  });

  it('M/N: Geschäftsbrief — Datei der Cloud gilt; lokales PDF bleibt als Archiv-Bindung, Brief bleibt versendbar', async () => {
    hydrateDocumentFileStore([pdfRef('fr-brief')], { 'blob-fr-brief': PDF_DATA_URL });
    const dokument = gesynctesDokument(5, { category: 'geschaeftsschreiben', linkedLetterId: 'letter-1', fileRefId: 'fr-brief', mimeType: 'application/pdf' });
    resetSyncOutboxForTests([konflikt(dokument.id)]);
    const ohneDatei = { ...dokument, fileRefId: undefined, mimeType: undefined } as CompanyDocument;

    await resolveArchivedDocumentConflict(dokument.id, 'take_cloud', { pullIntake: pullWith([cloudRow(ohneDatei, 7)]) });
    const nachher = getDocumentById(dokument.id)!;
    // Keine Rückmutation aus dem lokalen Stand: die Cloud kennt keine Original-Datei.
    expect(nachher.fileRefId).toBeUndefined();
    expect(getDocumentFileRepresentationBindingStoreSnapshot().find((b) => b.documentId === dokument.id && b.kind === 'archive')?.fileRefId).toBe('fr-brief');
    expect(isArchivedDocumentEmailSendable(nachher)).toBe(true);
    expect(isArchivedDocumentSyncBlocked(nachher)).toBe(false);
  });

  it('M2: eine vorhandene Archiv-Bindung bleibt unangetastet', async () => {
    hydrateDocumentFileStore([pdfRef('fr-archiv')], { 'blob-fr-archiv': PDF_DATA_URL });
    const dokument = gesynctesDokument(5, { category: 'geschaeftsschreiben', linkedLetterId: 'letter-2' });
    hydrateDocumentFileRepresentationBindingStore([{ documentId: dokument.id, kind: 'archive', fileRefId: 'fr-archiv' }] as never);
    resetSyncOutboxForTests([konflikt(dokument.id)]);
    await resolveArchivedDocumentConflict(dokument.id, 'take_cloud', { pullIntake: pullWith([cloudRow(dokument, 7)]) });
    expect(getDocumentFileRepresentationBindingStoreSnapshot().filter((b) => b.documentId === dokument.id)).toEqual([
      expect.objectContaining({ kind: 'archive', fileRefId: 'fr-archiv' }),
    ]);
  });
});

describe('07B-FIX3B — Änderungen dieses Geräts behalten', () => {
  it('D/H: lokaler Inhalt bleibt, Basis ist die frisch gelesene Cloud-Version — der Push geht durch', async () => {
    const dokument = gesynctesDokument(5, { title: 'Lokal geändert' });
    resetSyncOutboxForTests([konflikt(dokument.id)]);
    const ergebnis = await resolveArchivedDocumentConflict(dokument.id, 'keep_local', { pullIntake: pullWith([cloudRow(dokument, 7, { title: 'Online' })]) });
    expect(ergebnis).toEqual({ ok: true, decision: 'keep_local', cloudVersion: 7 });
    const nachher = getDocumentById(dokument.id)!;
    expect(nachher.title).toBe('Lokal geändert');
    expect(nachher.sync!.version).toBe(7);
    const eintraege = getSyncOutboxSnapshot().filter((e) => e.entityType === 'document' && e.entityId === dokument.id && e.status !== 'completed');
    expect(eintraege).toHaveLength(1);
    expect(eintraege[0]).toMatchObject({ status: 'pending', version: 7, lastErrorMessage: undefined });
    await expect(push(nachher, fakeIntakeServer(7))).resolves.toMatchObject({ kind: 'pushed', rowVersion: 8 });
  });

  it('E/F: ändert sich die Cloud erneut vor dem Push — wieder Konflikt, kein stilles Überschreiben', async () => {
    const dokument = gesynctesDokument(5, { title: 'Lokal geändert' });
    resetSyncOutboxForTests([konflikt(dokument.id)]);
    await resolveArchivedDocumentConflict(dokument.id, 'keep_local', { pullIntake: pullWith([cloudRow(dokument, 7)]) });
    const server = fakeIntakeServer(7);
    server.bump(); // ein anderes Gerät war schneller
    await expect(push(getDocumentById(dokument.id)!, server)).rejects.toThrow('Versionskonflikt archived_document:8');
  });

  it('F2: eine online gelöschte Zeile wird nicht per „behalten" wiederbelebt', async () => {
    const dokument = gesynctesDokument(5);
    resetSyncOutboxForTests([konflikt(dokument.id)]);
    const ergebnis = await resolveArchivedDocumentConflict(dokument.id, 'keep_local', { pullIntake: pullWith([cloudRow(dokument, 7, {}, true)]) });
    expect(ergebnis).toEqual({ ok: false, reason: 'cloud_deleted' });
    expect(getSyncOutboxSnapshot()[0]!.status).toBe('blocked');
  });

  it('M3: die Archiv-Bindung eines Briefes bleibt beim Behalten erhalten', async () => {
    hydrateDocumentFileStore([pdfRef('fr-archiv')], { 'blob-fr-archiv': PDF_DATA_URL });
    const dokument = gesynctesDokument(5, { category: 'geschaeftsschreiben', linkedLetterId: 'letter-3' });
    hydrateDocumentFileRepresentationBindingStore([{ documentId: dokument.id, kind: 'archive', fileRefId: 'fr-archiv' }] as never);
    resetSyncOutboxForTests([konflikt(dokument.id)]);
    await resolveArchivedDocumentConflict(dokument.id, 'keep_local', { pullIntake: pullWith([cloudRow(dokument, 7)]) });
    expect(getDocumentFileRepresentationBindingStoreSnapshot().some((b) => b.documentId === dokument.id && b.kind === 'archive')).toBe(true);
  });
});

describe('07B-FIX3B — Robustheit', () => {
  it('J: Cloud nicht erreichbar — nichts geändert, Konflikt bleibt', async () => {
    const dokument = gesynctesDokument(5, { title: 'Lokal' });
    resetSyncOutboxForTests([konflikt(dokument.id)]);
    const ergebnis = await resolveArchivedDocumentConflict(dokument.id, 'take_cloud', { pullIntake: async () => { throw new Error('offline'); } });
    expect(ergebnis).toEqual({ ok: false, reason: 'cloud_unavailable' });
    expect(getDocumentById(dokument.id)!.title).toBe('Lokal');
    expect(listArchivedDocumentConflicts()).toHaveLength(1);
  });

  it('I: Reload nach der Entscheidung — Stand und Warteschlange bleiben', async () => {
    const dokument = gesynctesDokument(5, { title: 'Lokal' });
    resetSyncOutboxForTests([konflikt(dokument.id)]);
    const ergebnis = await resolveArchivedDocumentConflict(dokument.id, 'take_cloud', {
      pullIntake: pullWith([cloudRow(dokument, 7, { title: 'Online' })]),
    });
    expect(ergebnis.ok).toBe(true);

    // Echter Snapshot, serialisiert, Stores geleert, neu geladen — wie ein Neustart.
    vi.restoreAllMocks();
    const gespeichert = JSON.parse(JSON.stringify({ ...persistence.buildPersistedStateSnapshot(), syncOutbox: getSyncOutboxSnapshot() }));
    resetTestStores();
    resetSyncOutboxForTests([]);
    persistence.applyStateToStores(gespeichert);

    const geladen = getDocumentById(dokument.id)!;
    expect(geladen.title).toBe('Online');
    expect(geladen.sync!.version).toBe(7);
    expect(listArchivedDocumentConflicts()).toEqual([]);
  });

  it('P: die additive Auto-Reparatur aus FIX2 greift weiterhin vor jeder Entscheidung', () => {
    const dokument = gesynctesDokument(5);
    const mitDatei = { ...dokument, fileRefId: 'fr-x', sourceFileHash: 'h', originalFileName: 'x.pdf', mimeType: 'application/pdf', fileSize: 10 } as CompanyDocument;
    const result = rebaseAdditiveArchivedDocumentConflicts([mitDatei], [konflikt(dokument.id)], [cloudRow(dokument, 7)]);
    expect(result.rebased).toEqual([dokument.id]);
  });
});

describe('07B-FIX3B — Sync-Seite', () => {
  let root: Root;
  let host: HTMLDivElement;
  const q = (id: string) => host.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
  async function settle() { for (let i = 0; i < 10; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); }
  async function mount() {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => { root.render(<MemoryRouter><AppProvider initialSetup={setup}><SyncPage /></AppProvider></MemoryRouter>); });
    await settle();
  }
  afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

  it('L: Dokumenttitel, zwei Entscheidungen, Bestätigung — danach kein Konflikt mehr', async () => {
    const dokument = gesynctesDokument(5, { title: 'Lokal geändert' });
    resetSyncOutboxForTests([konflikt(dokument.id)]);
    vi.spyOn(supabaseLib, 'getSupabaseClient').mockReturnValue({} as never);
    vi.spyOn(intake, 'rpcPullWorkspaceIntakeState').mockResolvedValue(await pullWith([cloudRow(dokument, 7, { title: 'Mietvertrag Halle 3 (online)' })])());
    await mount();

    const bereich = q('sync-document-conflicts')!;
    expect(bereich.textContent).toContain('Dokument · Lokal geändert');
    expect(bereich.textContent).toContain('Online und auf diesem Gerät liegen unterschiedliche Stände');
    expect(bereich.textContent).not.toMatch(/row_version|payload|archived_document/);
    // Nicht zusätzlich als „Wartet" oder „Nicht übertragen".
    expect(q('sync-outbox-pending-list')).toBeNull();
    expect(q('sync-failures')).toBeNull();
    expect(q('sync-status-badge')?.textContent).toContain('Entscheidung nötig');

    await act(async () => { q(`sync-document-take-cloud-${dokument.id}`)!.click(); });
    await settle();
    expect(q('sync-document-decision-dialog')?.textContent).toContain('Noch nicht übertragene Änderungen dieses Geräts');
    await act(async () => { q('sync-document-decision-confirm')!.click(); });
    await settle();

    expect(q('sync-document-conflicts')).toBeNull();
    expect(getDocumentById(dokument.id)!.title).toBe('Mietvertrag Halle 3 (online)');
  });

  it('„Änderungen behalten" verlangt eine eigene Bestätigung mit Hinweis auf die neuere Online-Version', async () => {
    const dokument = gesynctesDokument(5);
    resetSyncOutboxForTests([konflikt(dokument.id)]);
    await mount();
    await act(async () => { q(`sync-document-keep-local-${dokument.id}`)!.click(); });
    await settle();
    expect(q('sync-document-decision-dialog')?.textContent).toContain('Die Online-Version ist neuer.');
    await act(async () => { q('sync-document-decision-cancel')!.click(); });
    await settle();
    expect(q('sync-document-decision-dialog')).toBeNull();
    expect(listArchivedDocumentConflicts()).toHaveLength(1);
  });
});
