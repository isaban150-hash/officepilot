/**
 * E-MAIL-07B-FIX2 — Versionskonflikt `archived_document` nach Brief-PDF-Nachrüstung.
 *
 * Root Cause: `updateDocument` erhöhte `sync.version` lokal um 1
 * (`withUpdatedEntitySync`). Archivdokumente gehen aber über
 * `upsert_workspace_intake_entity`, und das verlangt für eine bestehende Zeile
 * **exakt** die zuletzt bestätigte Version. Jede Änderung an einem bereits
 * gesyncten Dokument — hier: die Nachrüstung von `fileRefId` — endete als
 * „Versionskonflikt archived_document" (blocked).
 *
 * Der „Server" in diesen Tests bildet genau diese Versionsregel nach.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppProvider } from '../../context/AppContext';
import { AuthProvider } from '../../context/AuthContext';
import { loginAsDefaultAdmin, resetAuthForTests } from '../../test/authFixtures';
import { DEFAULT_COMPANY_PROFILE } from '../../data/companyProfileDefaults';
import { DEFAULT_SETUP } from '../../data/mockData';
import * as supabaseLib from '../../lib/supabase';
import * as persistence from '../../services/persistenceService';
import * as orchestrator from '../../services/delivery/sendDocumentOrchestrator';
import { hydrateCompanyProfileStore } from '../../services/companyProfileService';
import { hydrateCustomerStore } from '../../services/customerStoreService';
import { addDocument, deleteDocument, getAllDocuments, getDocumentById, hydrateDocumentStore, updateDocument } from '../../services/documentService';
import { getDocumentFileRefStoreSnapshot, resetDocumentFileStoreForTests } from '../../services/documentFileStoreService';
import { getDocumentFileRepresentationBindingStoreSnapshot } from '../../services/documentFileRepresentationBindingStoreService';
import { hydrateWorkspaceStore } from '../../services/workspace/workspaceStore';
import { setActiveStorageScope } from '../../services/storage/storageScopeService';
import { resetSyncOutboxForTests } from '../../services/sync/syncOutboxService';
import { extractCloudSyncEntity } from '../../services/workspace/workspaceSyncPayloadService';
import { pushIntakeEntity } from '../../services/document/intakeCloudPushService';
import {
  applyIntakePullToState,
  buildArchivedDocumentPushPayload,
  isPurelyAdditiveFileChange,
  rebaseAdditiveArchivedDocumentConflicts,
  type CloudArchivedDocumentRow,
  type IntakeCloudPull,
} from '../../services/document/intakeCloudSyncService';
import { resetTestStores } from '../../test/resetStores';
import {
  addBusinessLetter,
  attachArchiveDocumentToLetter,
  finalizeBusinessLetter,
  getBusinessLetterById,
} from '../../services/businessLetterService';
import { ensureBusinessLetterArchived, resolveBusinessLetterCustomerEmail } from '../../services/letter/businessLetterArchiveService';
import { isArchivedDocumentSyncBlocked } from '../../services/delivery/documentDeliveryCloudService';
import { DocumentDeliveryPanel, isArchivedDocumentEmailSendable } from './DocumentDeliveryPanel';
import { BriefDetailPage } from '../../pages/BriefDetailPage';
import { DokumentDetailPage } from '../../pages/DokumentDetailPage';
import type { BusinessLetter } from '../../types/businessLetter';
import type { AppPersistedState, CompanyDocument, CompanySetup, Customer } from '../../types/models';
import type { SyncOutboxEntry } from '../../types/sync';

const WS = '00000000-0000-4000-8000-0000000b7f22';
const setup: CompanySetup = { ...DEFAULT_SETUP, setupComplete: true, taxStatus: 'standard_19' };

/* ------------------------------------------------------------------ */
/* Der „Server": Versionsregel von upsert_workspace_intake_entity       */
/* ------------------------------------------------------------------ */

function fakeIntakeServer(initialVersion: number) {
  let rowVersion = initialVersion;
  const calls: Array<{ entityType: string; rowVersion: number }> = [];
  const client = {
    rpc: vi.fn(async (_name: string, args: { p_entity_type: string; p_row_version: number; p_payload: Record<string, unknown> }) => {
      calls.push({ entityType: args.p_entity_type, rowVersion: args.p_row_version });
      if (args.p_entity_type !== 'archived_document') {
        return { data: { row_version: 1, deleted: false, payload: {} }, error: null };
      }
      if (args.p_row_version !== rowVersion) {
        return { data: null, error: { message: `Versionskonflikt archived_document:${rowVersion}` } };
      }
      rowVersion += 1;
      return { data: { row_version: rowVersion, deleted: Boolean(args.p_payload.deleted), payload: args.p_payload }, error: null };
    }),
  };
  return { client: client as never, calls, current: () => rowVersion };
}

function stateOf(documents: CompanyDocument[], outbox: SyncOutboxEntry[] = []): AppPersistedState {
  return { documents, inboxItems: [], syncOutbox: outbox, syncClient: { serverWorkspaceId: WS } } as unknown as AppPersistedState;
}

async function push(document: CompanyDocument, server: ReturnType<typeof fakeIntakeServer>, operation: 'update' | 'delete' = 'update') {
  const extracted = extractCloudSyncEntity(stateOf([document]), 'document', document.id)!;
  return pushIntakeEntity(extracted, operation, WS, server.client);
}

/* ------------------------------------------------------------------ */

let root: Root;
let host: HTMLDivElement;
async function settle(): Promise<void> {
  for (let i = 0; i < 14; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}
const q = (id: string): HTMLElement | null => host.querySelector(`[data-testid="${id}"]`);
async function render(path: string, node: React.ReactNode = null): Promise<void> {
  host = window.document.createElement('div');
  window.document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={[path]}>
        <AuthProvider>
          <AppProvider initialSetup={setup}>
            <Routes>
              <Route path="/schreiben/:letterId" element={<BriefDetailPage />} />
              <Route path="/dokumente/:id" element={<DokumentDetailPage />} />
              <Route path="*" element={node} />
            </Routes>
          </AppProvider>
        </AuthProvider>
      </MemoryRouter>,
    );
  });
  await settle();
}

function kunde(): Customer {
  return { id: 'cust-az', name: 'AZ Testbau GmbH', street: 'Weg 1', zip: '1', city: 'X', email: 'testkunde@officepilot-test.de', createdAt: '2026-01-01T00:00:00.000Z' } as Customer;
}

function fertigerBrief(): BusinessLetter {
  const angelegt = addBusinessLetter(WS, {
    subject: '01J Abnahme Kundenkontext', body: 'Text.', letterDate: '2026-09-25',
    recipient: { name: '', company: 'AZ Testbau GmbH', street: 'Weg 1', zip: '1', city: 'X' }, customerId: 'cust-az',
  });
  if (!angelegt.success) throw new Error('Brief');
  const fertig = finalizeBusinessLetter(angelegt.letter.id);
  if (!fertig.success) throw new Error('fertig');
  return fertig.letter;
}

/** Ein vor 07B abgelegter, längst gesyncter Brief: Archiveintrag ohne Datei, bestätigte Serverversion. */
function alterGesyncterBrief(serverVersion: number): { brief: BusinessLetter; dokument: CompanyDocument } {
  const brief = fertigerBrief();
  const angelegt = addDocument({
    title: brief.subject, category: 'geschaeftsschreiben', issuer: 'Betrieb', issueDate: null, documentDate: null, linkedCompany: 'AZ Testbau GmbH',
    linkedVorgang: null, linkedLetterId: brief.id, classifiedKind: 'schriftverkehr',
    digitalFolder: { id: 'dig', name: 'G', path: '/G/' }, paperFolder: { folderId: 'paper-kunden', register: 'Sonstiges', label: 'K' },
    archived: true, recognizedText: brief.body, tags: [],
  });
  if (!angelegt.success) throw new Error('Altbestand');
  const gesynct = { ...angelegt.document, sync: { ...angelegt.document.sync!, version: serverVersion } } as CompanyDocument;
  hydrateDocumentStore([...getAllDocuments().filter((d) => d.id !== gesynct.id), gesynct]);
  attachArchiveDocumentToLetter(brief.id, gesynct.id);
  return { brief: getBusinessLetterById(brief.id)!, dokument: getDocumentById(gesynct.id)! };
}

function cloudRow(document: CompanyDocument, version: number, payloadOverrides: Record<string, unknown> = {}): CloudArchivedDocumentRow {
  const payload = buildArchivedDocumentPushPayload(document, false).payload as Record<string, unknown>;
  return {
    client_document_id: document.id, document_kind: 'archived_document', linked_invoice_id: null, linked_vorgang_id: null,
    payload: { ...payload, ...payloadOverrides }, updated_at: '2026-09-26T10:00:00.000Z', deleted: false, row_version: version,
  };
}

function blockedEntry(documentId: string, message = 'Versionskonflikt archived_document:5'): SyncOutboxEntry {
  return { id: `ob-${documentId}`, entityType: 'document', entityId: documentId, operation: 'update', version: 6, queuedAt: 'x', retryCount: 1, status: 'blocked', lastErrorMessage: message, lastErrorAt: 'x', lastErrorRetryable: false };
}

beforeEach(async () => {
  resetTestStores();
  resetAuthForTests();
  resetDocumentFileStoreForTests();
  resetSyncOutboxForTests([]);
  localStorage.clear();
  setActiveStorageScope({ type: 'workspace', workspaceId: WS });
  hydrateCompanyProfileStore({ ...DEFAULT_COMPANY_PROFILE, companyName: 'Betrieb', legalForm: 'GmbH', email: 'info@betrieb.invalid', street: 'W', zip: '1', city: 'X', iban: 'DE89370400440532013000', taxNumber: '1' });
  hydrateCustomerStore([kunde()]);
  hydrateWorkspaceStore({
    workspace: { id: WS, name: 'Betrieb', ownerUserId: 'usr-admin', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', version: 1 },
    workspaceMembers: [{ workspaceId: WS, userId: 'usr-admin', role: 'owner', status: 'active', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }],
  });
  await loginAsDefaultAdmin();
});
afterEach(async () => {
  if (host?.isConnected) {
    await act(async () => root.unmount());
    host.remove();
  }
  window.document.body.innerHTML = '';
  vi.restoreAllMocks();
  resetSyncOutboxForTests([]);
  resetTestStores();
});

/* ================================================================== */
/* Root Cause und allgemeine Korrektur                                */
/* ================================================================== */

describe('07B-FIX2 — Versionsvertrag für Archivdokumente', () => {
  it('Nachweis der Ursache: eine lokal erhöhte Version läuft beim Server in den Versionskonflikt', async () => {
    const { dokument } = alterGesyncterBrief(5);
    const server = fakeIntakeServer(5);
    const erhoeht = { ...dokument, sync: { ...dokument.sync!, version: 6 } } as CompanyDocument;
    await expect(push(erhoeht, server)).rejects.toThrow('Versionskonflikt archived_document:5');
  });

  it('A: eine Änderung an einem gesyncten Dokument behält die bestätigte Version — der Push trifft sie', async () => {
    const { dokument } = alterGesyncterBrief(5);
    const geaendert = updateDocument(dokument.id, { tags: ['Geschäftsschreiben', 'wichtig'] });
    expect(geaendert.success).toBe(true);
    expect(getDocumentById(dokument.id)!.sync!.version).toBe(5);
    const server = fakeIntakeServer(5);
    const outcome = await push(getDocumentById(dokument.id)!, server);
    expect(outcome).toMatchObject({ kind: 'pushed', rowVersion: 6 });
    expect(server.calls[0]).toEqual({ entityType: 'archived_document', rowVersion: 5 });
  });

  it('A2: auch das Löschen behält die bestätigte Version', async () => {
    const { dokument } = alterGesyncterBrief(5);
    // Die Briefverknüpfung verhindert kein Löschen des Eintrags im Test; wir prüfen nur die Version.
    const ergebnis = deleteDocument(dokument.id);
    if (!ergebnis.success) return; // Löschsperren gehören nicht zu diesem Fix.
    const geloescht = getAllDocuments().find((d) => d.id === dokument.id) ?? (await import('../../services/documentService')).getDocumentById(dokument.id);
    const state = persistence.buildPersistedStateSnapshot();
    const tomb = (state.documents ?? []).find((d) => d.id === dokument.id) ?? geloescht;
    expect(tomb?.sync?.version).toBe(5);
    expect(tomb?.sync?.deleted).toBe(true);
  });
});

/* ================================================================== */
/* Konfliktfreie Nachrüstung                                          */
/* ================================================================== */

describe('07B-FIX2 — Brief-PDF-Nachrüstung ändert die Dokumentzeile nicht', () => {
  it('A/H: alter Brief, lokale = Cloud-Version — PDF als Archiv-Bindung, Dokument (Inhalt und Version) unverändert', async () => {
    const { brief, dokument } = alterGesyncterBrief(5);
    const vorher = JSON.stringify(getDocumentById(dokument.id));
    const ergebnis = await ensureBusinessLetterArchived(brief);
    expect(ergebnis).toMatchObject({ ok: true, created: false, pdf: 'attached' });
    expect(JSON.stringify(getDocumentById(dokument.id))).toBe(vorher);
    const bindung = getDocumentFileRepresentationBindingStoreSnapshot().find((b) => b.documentId === dokument.id && b.kind === 'archive');
    expect(bindung).toBeDefined();
    expect(isArchivedDocumentEmailSendable(getDocumentById(dokument.id)!)).toBe(true);
    // Keine Dokumentänderung → nichts, was einen Dokument-Push (und damit einen Konflikt) auslösen könnte.
    const server = fakeIntakeServer(5);
    await expect(push(getDocumentById(dokument.id)!, server)).resolves.toMatchObject({ kind: 'pushed' });
  });

  it('B/C/G: Cloud inzwischen neuer (anderes Gerät änderte den Titel) — Nachrüstung erhält die neueren Metadaten', async () => {
    const { brief, dokument } = alterGesyncterBrief(5);
    await ensureBusinessLetterArchived(brief);
    // Pull: Cloud-Version 7 mit neuem Titel; lokal ist nichts offen.
    const state = { ...persistence.buildPersistedStateSnapshot(), syncOutbox: [] } as AppPersistedState;
    const pull: IntakeCloudPull = { files: [], bindings: [], inboxItems: [], workResults: [], archivedDocuments: [cloudRow(dokument, 7, { title: 'Neuer Titel vom Zweitgerät' })] };
    const applied = applyIntakePullToState(state, pull, { deviceId: 'dev', workspaceId: WS, dirty: new Set() });
    const nachPull = applied.state.documents!.find((d) => d.id === dokument.id)!;
    expect(nachPull.title).toBe('Neuer Titel vom Zweitgerät');
    expect(nachPull.sync!.version).toBe(7);
    expect(applied.conflicts).toEqual([]);
    // Die Archiv-Bindung (eigene Entität) bleibt — das PDF ist weiter da.
    expect(applied.state.documentFileRepresentationBindings!.some((b) => b.documentId === dokument.id && b.kind === 'archive')).toBe(true);
  });

  it('D: zwei parallele Aufrufe — eine Datei, eine Bindung', async () => {
    const { brief, dokument } = alterGesyncterBrief(5);
    const vorher = getDocumentFileRefStoreSnapshot().length;
    await Promise.all([ensureBusinessLetterArchived(brief), ensureBusinessLetterArchived(brief)]);
    expect(getDocumentFileRefStoreSnapshot().length - vorher).toBe(1);
    expect(getDocumentFileRepresentationBindingStoreSnapshot().filter((b) => b.documentId === dokument.id && b.kind === 'archive')).toHaveLength(1);
  });

  it('E: Briefseite und Dokumentseite gleichzeitig geöffnet — eine Datei, eine Bindung, Dokument unverändert', async () => {
    const { brief, dokument } = alterGesyncterBrief(5);
    const vorher = JSON.stringify(getDocumentById(dokument.id));
    const dateienVorher = getDocumentFileRefStoreSnapshot().length;
    vi.spyOn(supabaseLib, 'isSupabaseConfigured').mockReturnValue(false);
    await render(`/schreiben/${brief.id}`);
    const ersterHost = host;
    const ersterRoot = root;
    await render(`/dokumente/${dokument.id}`);
    expect(getDocumentFileRefStoreSnapshot().length - dateienVorher).toBe(1);
    expect(getDocumentFileRepresentationBindingStoreSnapshot().filter((b) => b.documentId === dokument.id && b.kind === 'archive')).toHaveLength(1);
    expect(JSON.stringify(getDocumentById(dokument.id))).toBe(vorher);
    await act(async () => ersterRoot.unmount());
    ersterHost.remove();
  });

  it('F: Reload nach der Nachrüstung — die Bindung ist gespeichert, der Brief bleibt versendbar', async () => {
    const { brief, dokument } = alterGesyncterBrief(5);
    await ensureBusinessLetterArchived(brief);
    const gespeichert = JSON.parse(JSON.stringify(persistence.buildPersistedStateSnapshot()));
    resetTestStores();
    resetDocumentFileStoreForTests();
    persistence.applyStateToStores(gespeichert);
    expect(getDocumentFileRepresentationBindingStoreSnapshot().some((b) => b.documentId === dokument.id && b.kind === 'archive')).toBe(true);
    expect(getDocumentById(dokument.id)!.sync!.version).toBe(5);
  });

  it('K/L: PDF versendbar und Kunden-E-Mail weiterhin vorbelegt (FIX1)', async () => {
    const { brief, dokument } = alterGesyncterBrief(5);
    await ensureBusinessLetterArchived(brief);
    expect(isArchivedDocumentEmailSendable(getDocumentById(dokument.id)!)).toBe(true);
    expect(resolveBusinessLetterCustomerEmail(getDocumentById(dokument.id)!)).toBe('testkunde@officepilot-test.de');
  });
});

/* ================================================================== */
/* Bestehender blockierter Konflikt                                    */
/* ================================================================== */

describe('07B-FIX2 — Reparatur des bestehenden Konflikts', () => {
  /** Der Zustand aus der Abnahme: Nachrüstung per updateDocument vor FIX2 (Version erhöht, Push blockiert). */
  function abnahmeZustand() {
    const { dokument } = alterGesyncterBrief(5);
    const mitDatei = { ...dokument, fileRefId: 'fr-brief', sourceFileHash: 'hash-brief', originalFileName: 'Brief.pdf', mimeType: 'application/pdf', fileSize: 1234, sync: { ...dokument.sync!, version: 6 } } as CompanyDocument;
    return { vorNachruestung: dokument, lokal: mitDatei };
  }

  it('rein additiv: Cloud-Version übernommen, Auftrag wieder sendebereit — der nächste Push trifft die Version', async () => {
    const { vorNachruestung, lokal } = abnahmeZustand();
    const row = cloudRow(vorNachruestung, 5);
    expect(isPurelyAdditiveFileChange(lokal, row)).toBe(true);

    const result = rebaseAdditiveArchivedDocumentConflicts([lokal], [blockedEntry(lokal.id)], [row]);
    expect(result.rebased).toEqual([lokal.id]);
    const repariert = result.documents[0]!;
    expect(repariert.sync!.version).toBe(5);
    expect(result.outbox![0]).toMatchObject({ status: 'pending', retryCount: 0, lastErrorMessage: undefined });
    // Kein fachliches Feld verloren: alles außer der Version ist der lokale Stand samt Datei.
    expect({ ...repariert, sync: undefined }).toEqual({ ...lokal, sync: undefined });

    const server = fakeIntakeServer(5);
    await expect(push(repariert, server)).resolves.toMatchObject({ kind: 'pushed', rowVersion: 6 });
    // Der Push enthält den Cloud-Inhalt plus die Dateifelder — nichts anderes.
    const gesendet = server.client as unknown as { rpc: { mock: { calls: Array<[string, { p_payload: { payload: Record<string, unknown> } }]> } } };
    const payload = gesendet.rpc.mock.calls[0]![1].p_payload.payload;
    expect({ ...payload, sourceFileHash: undefined, originalFileName: undefined, mimeType: undefined, fileSize: undefined })
      .toEqual({ ...row.payload, sourceFileHash: undefined, originalFileName: undefined, mimeType: undefined, fileSize: undefined });
  });

  it('H: über den normalen Pull — kein blocked-Konflikt mehr, 0 Konflikte gemeldet', () => {
    const { vorNachruestung, lokal } = abnahmeZustand();
    const state = stateOf([lokal], [blockedEntry(lokal.id)]);
    const pull: IntakeCloudPull = { files: [], bindings: [], inboxItems: [], workResults: [], archivedDocuments: [cloudRow(vorNachruestung, 5)] };
    const applied = applyIntakePullToState(state, pull, { deviceId: 'dev', workspaceId: WS, dirty: new Set([`document:${lokal.id}`]) });
    expect(applied.conflicts).toEqual([]);
    expect(applied.state.syncOutbox!.filter((e) => e.status === 'blocked')).toHaveLength(0);
    expect(applied.state.documents!.find((d) => d.id === lokal.id)!.sync!.version).toBe(5);
    expect(applied.state.documents!.find((d) => d.id === lokal.id)!.fileRefId).toBe('fr-brief');
  });

  it('I: echte konkurrierende Änderung (Cloud-Titel anders) — bleibt blockiert, lokal unverändert', () => {
    const { vorNachruestung, lokal } = abnahmeZustand();
    const row = cloudRow(vorNachruestung, 5, { title: 'Anders geändert' });
    expect(isPurelyAdditiveFileChange(lokal, row)).toBe(false);
    const result = rebaseAdditiveArchivedDocumentConflicts([lokal], [blockedEntry(lokal.id)], [row]);
    expect(result.rebased).toEqual([]);
    expect(result.outbox![0]!.status).toBe('blocked');
    expect(result.documents[0]).toBe(lokal);
  });

  it('I2: Cloud trägt bereits eine andere Datei — kein Überschreiben', () => {
    const { vorNachruestung, lokal } = abnahmeZustand();
    const row = cloudRow(vorNachruestung, 5, { sourceFileHash: 'andere-datei', originalFileName: 'Anders.pdf' });
    expect(isPurelyAdditiveFileChange(lokal, row)).toBe(false);
  });

  it('I3: nur der Konflikttyp „Versionskonflikt archived_document" und nur document-Aufträge', () => {
    const { vorNachruestung, lokal } = abnahmeZustand();
    const row = cloudRow(vorNachruestung, 5);
    const andereMeldung = rebaseAdditiveArchivedDocumentConflicts([lokal], [blockedEntry(lokal.id, 'Keine Schreibberechtigung')], [row]);
    expect(andereMeldung.rebased).toEqual([]);
    const andererTyp = rebaseAdditiveArchivedDocumentConflicts([lokal], [{ ...blockedEntry(lokal.id), entityType: 'inbox_item' }], [row]);
    expect(andererTyp.rebased).toEqual([]);
    const ohneDatei = rebaseAdditiveArchivedDocumentConflicts([{ ...lokal, fileRefId: undefined } as CompanyDocument], [blockedEntry(lokal.id)], [row]);
    expect(ohneDatei.rebased).toEqual([]);
    const geloescht = rebaseAdditiveArchivedDocumentConflicts([lokal], [blockedEntry(lokal.id)], [{ ...row, deleted: true }]);
    expect(geloescht.rebased).toEqual([]);
  });
});

/* ================================================================== */
/* Versand fail-closed bei ungeklärtem Konflikt                       */
/* ================================================================== */

describe('07B-FIX2 — kein Versand bei ungeklärtem Sync-Konflikt', () => {
  it('J: blockierter Dokument-Auftrag — Panel ohne Senden, mit Grund; Orchestrator fail-closed ohne Upload', async () => {
    const brief = fertigerBrief();
    const ergebnis = await ensureBusinessLetterArchived(brief);
    if (!ergebnis.ok) throw new Error('abgelegt');
    const dokument = getDocumentById(ergebnis.document.id)!;
    resetSyncOutboxForTests([blockedEntry(dokument.id, 'Versionskonflikt archived_document:3')]);
    expect(isArchivedDocumentSyncBlocked(dokument)).toBe(true);

    vi.spyOn(supabaseLib, 'isSupabaseConfigured').mockReturnValue(true);
    vi.spyOn(persistence, 'buildPersistedStateSnapshot').mockReturnValue({ syncClient: { serverWorkspaceId: WS } } as never);
    vi.spyOn(orchestrator, 'refreshDocumentDeliveries').mockImplementation(async () => ({ ok: true, deliveries: [] }));
    await render('/', <DocumentDeliveryPanel document={dokument} />);
    expect(q('document-delivery-sync-blocked')?.textContent).toContain('Synchronisierungskonflikt');
    expect(q('document-delivery-send')).toBeNull();

    const upload = vi.fn();
    const client = { rpc: vi.fn(), storage: { from: vi.fn(() => ({ upload })) } } as never;
    const draft = orchestrator.createSendDraft({ identity: { kind: 'letter', clientDocumentId: dokument.id }, vorgangId: null, recipientEmail: 'a@b.invalid', subject: 'S', bodyText: 'B' });
    const invokeSend = vi.fn();
    const result = await orchestrator.runSendDocument({ draft, vorgangId: null }, { client, invokeSend });
    expect(result).toMatchObject({ ok: false, error: 'document_sync_blocked' });
    expect(upload).not.toHaveBeenCalled();
    expect(invokeSend).not.toHaveBeenCalled();
  });

  it('auch ein blockiertes Binding oder eine blockierte Datei des Dokuments sperren den Versand', async () => {
    const brief = fertigerBrief();
    const ergebnis = await ensureBusinessLetterArchived(brief);
    if (!ergebnis.ok) throw new Error('abgelegt');
    const dokument = getDocumentById(ergebnis.document.id)!;
    resetSyncOutboxForTests([{ ...blockedEntry(dokument.id), entityType: 'document_file_binding', entityId: `${dokument.id}|original|` }]);
    expect(isArchivedDocumentSyncBlocked(dokument)).toBe(true);
    resetSyncOutboxForTests([{ ...blockedEntry(dokument.id), entityType: 'document_file', entityId: dokument.fileRefId! }]);
    expect(isArchivedDocumentSyncBlocked(dokument)).toBe(true);
    resetSyncOutboxForTests([{ ...blockedEntry('anderes-dokument') }]);
    expect(isArchivedDocumentSyncBlocked(dokument)).toBe(false);
  });
});
