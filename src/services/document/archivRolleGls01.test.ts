/**
 * GO-LIVE-SECURITY-01 — Client-Nacharbeit: Löschen von Archivdokumenten.
 *
 * Löschen ist Verwaltung: nur Inhaber und Admin. Der Server weist Grabsteine
 * von Mitgliedern ab — für Archivdokumente im Eingangsweg, für
 * Rechnungsdokumente in `tombstone_workspace_document`. Geprüft wird hier:
 *
 *  - der Löschdienst prüft die Rolle vor jeder lokalen Änderung,
 *  - eine Rollenabweisung des Grabsteins löscht nichts lokal,
 *  - eine bereits lokal vollzogene, vom Server abgewiesene Löschung kommt mit
 *    dem nächsten Pull zurück (Dokument und sein Eingangseintrag); andere
 *    Fehler und echte Cloud-Löschungen bleiben unberührt.
 *
 * Neutrale Beispieldaten, kein Netzwerk.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { alsInhaber, alsMitglied } from '../../test/workspaceRoleTestUtils';
import { resetTestStores } from '../../test/resetStores';
import { createOrderPosition, createTestVorgang } from '../../test/fixtures';
import { getDocumentById, hydrateDocumentStore } from '../documentService';
import { hydrateVorgangStore } from '../vorgangService';
import { hydrateWorkspaceStore } from '../workspace/workspaceStore';
import { deleteGeneratedInvoiceDocumentWithCloud } from './generatedInvoiceDocumentDeleteService';
import {
  applyIntakePullToState,
  planRoleDeniedArchiveRestore,
  type CloudArchivedDocumentRow,
  type CloudInboxRow,
  type IntakeCloudPull,
} from './intakeCloudSyncService';
import * as supabaseLib from '../../lib/supabase';
import type { AppPersistedState, CompanyDocument, InboxItem, Vorgang, VorgangInvoice } from '../../types/models';
import type { SyncOutboxEntry } from '../../types/sync';

const WORKSPACE = '00000000-0000-4000-8000-000000000a02';
const MITGLIED = { userId: 'user-mitglied', cloudConfigured: true };
const INHABER = { userId: 'user-inhaber', cloudConfigured: true };
const DOC = 'doc-gls01-archiv';
const INBOX = 'inbox-upload-1700000000000';
const INVOICE_ID = 'inv-gls01-doc';

function archivDokument(overrides: Partial<CompanyDocument> = {}): CompanyDocument {
  return {
    id: DOC,
    title: 'Tankbeleg August',
    category: 'sonstiges',
    classifiedKind: 'beleg',
    issuer: 'Tankstelle Beispiel',
    recognizedText: 'Diesel 62,40 €',
    issueDate: '2026-08-10',
    validUntil: null,
    digitalFolder: { id: 'dig-belege', name: 'Belege', path: '/Belege/' },
    paperFolder: { folderId: 'folder-5', register: 'B', label: 'Belege' },
    tags: ['Beleg'],
    linkedCompany: '',
    linkedVorgang: null,
    archived: true,
    createdAt: '2026-08-10T10:00:00.000Z',
    sourceInboxItemId: INBOX,
    ...overrides,
  } as CompanyDocument;
}

function aufrufeProtokollieren(): string[] {
  const aufrufe: string[] = [];
  vi.spyOn(supabaseLib, 'getSupabaseClient').mockReturnValue({
    rpc: vi.fn(async (name: string) => {
      aufrufe.push(name);
      return { data: null, error: null };
    }),
  } as never);
  return aufrufe;
}

beforeEach(() => resetTestStores());
afterEach(() => vi.restoreAllMocks());

describe('GLS01 Archivdokument löschen — Rolle vor jeder lokalen Änderung', () => {
  it('D1: ein Mitglied löscht nicht; das Dokument bleibt, kein einziger Cloud-Aufruf', async () => {
    alsMitglied();
    hydrateDocumentStore([archivDokument()]);
    const aufrufe = aufrufeProtokollieren();

    await expect(deleteGeneratedInvoiceDocumentWithCloud(DOC, MITGLIED)).resolves.toEqual({
      ok: false,
      errorKey: 'document.delete.forbidden',
    });
    expect(getDocumentById(DOC)?.sync?.deleted ?? false).toBe(false);
    expect(aufrufe).toEqual([]);
  });

  it('D2: ohne Rollenangabe gilt die strengste Annahme', async () => {
    hydrateDocumentStore([archivDokument()]);
    await expect(deleteGeneratedInvoiceDocumentWithCloud(DOC)).resolves.toEqual({
      ok: false,
      errorKey: 'document.delete.forbidden',
    });
    expect(getDocumentById(DOC)).toBeDefined();
  });

  it('D3: Inhaber löschen ein Archivdokument wie bisher', async () => {
    alsInhaber();
    hydrateDocumentStore([archivDokument()]);
    aufrufeProtokollieren();

    const result = await deleteGeneratedInvoiceDocumentWithCloud(DOC, INHABER);
    expect(result.ok).toBe(true);
    expect(getDocumentById(DOC)).toBeUndefined();
  });

  it.each([
    ['Keine Schreibberechtigung', '42501'],
    // KONTOSPERRE — ein gesperrtes Konto ist kein aktives Mitglied mehr.
    ['Kein Zugriff auf Workspace', 'P0001'],
    ['account_blocked: Konto ist gesperrt', '42501'],
  ])('D4: weist der Server den Grabstein eines Rechnungsdokuments ab (%s), bleibt es lokal', async (meldung, code) => {
    alsInhaber();
    const rechnung = {
      id: INVOICE_ID,
      number: '2026-0040',
      type: 'rechnung',
      positions: [],
      subtotal: 0,
      taxStatus: 'standard_19',
      amount: 0,
      status: 'entwurf',
      date: '2026-08-24',
      createdAt: '2026-08-24T10:00:00.000Z',
      paymentStatus: 'offen',
      payments: [],
      legalNotices: [],
      previousAbschlagDeductions: [],
    } as unknown as VorgangInvoice;
    hydrateVorgangStore([
      {
        ...createTestVorgang({
          id: 'v-gls01-doc',
          orderPositions: [createOrderPosition({ id: 'op-1' })],
        }),
        invoices: [rechnung],
      } as Vorgang,
    ]);
    hydrateWorkspaceStore({
      workspace: {
        id: WORKSPACE,
        name: 'Beispielbetrieb',
        ownerUserId: 'user-inhaber',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        version: 1,
      },
    });
    hydrateDocumentStore([
      archivDokument({
        id: 'doc-gls01-rechnung',
        category: 'ausgangsrechnung',
        classifiedKind: 'ausgangsrechnung',
        linkedInvoiceId: INVOICE_ID,
        sourceInboxItemId: undefined,
      }),
    ]);
    vi.spyOn(supabaseLib, 'isSupabaseConfigured').mockReturnValue(true);
    vi.spyOn(supabaseLib, 'getSupabaseClient').mockReturnValue({
      rpc: vi.fn(async (name: string) =>
        name === 'tombstone_workspace_document'
          ? { data: null, error: { message: meldung, code } }
          : { data: false, error: null },
      ),
    } as never);

    await expect(deleteGeneratedInvoiceDocumentWithCloud('doc-gls01-rechnung', INHABER)).resolves.toEqual({
      ok: false,
      errorKey: 'document.delete.forbidden',
    });
    expect(getDocumentById('doc-gls01-rechnung')).toBeDefined();
  });
});

/* -------------------------------------------------------------------------- */
/* Abgewiesene Löschung kommt mit dem Pull zurück                              */
/* -------------------------------------------------------------------------- */

const META = { updatedAt: '2026-08-10T10:00:00.000Z', deviceId: 'device-1', workspaceId: WORKSPACE };

function auftrag(entityType: SyncOutboxEntry['entityType'], entityId: string, nachricht: string): SyncOutboxEntry {
  return {
    id: `out-${entityType}-${entityId}`,
    entityType,
    entityId,
    operation: 'delete',
    version: 3,
    queuedAt: '2026-10-09T18:00:00.000Z',
    retryCount: 1,
    status: 'error',
    lastErrorMessage: nachricht,
    lastErrorAt: '2026-10-09T18:00:05.000Z',
    lastErrorRetryable: false,
  };
}

function zustand(outbox: SyncOutboxEntry[]): AppPersistedState {
  const grabstein = archivDokument({
    linkedVorgang: null,
    sync: { ...META, version: 3, deleted: true, deletedAt: '2026-10-09T18:00:00.000Z' },
  } as Partial<CompanyDocument>);
  const eingang = {
    id: INBOX,
    status: 'archived',
    recognizedData: { _volltext: 'nur lokal' },
    sync: { ...META, version: 2, deleted: true },
  } as unknown as InboxItem;
  return {
    documents: [grabstein],
    inboxItems: [eingang],
    documentFileRefs: [],
    documentFileRepresentationBindings: [],
    documentWorkResults: [],
    syncOutbox: outbox,
  } as unknown as AppPersistedState;
}

function pull(overrides: { dokumentGeloescht?: boolean; ohneDokument?: boolean } = {}): IntakeCloudPull {
  const dokument: CloudArchivedDocumentRow = {
    client_document_id: DOC,
    document_kind: 'archived_document',
    linked_invoice_id: null,
    linked_vorgang_id: null,
    payload: { title: 'Tankbeleg August', category: 'sonstiges', sourceInboxItemId: INBOX },
    updated_at: '2026-08-10T10:00:00.000Z',
    deleted: overrides.dokumentGeloescht ?? false,
    row_version: 3,
  };
  const eingang: CloudInboxRow = {
    client_inbox_id: INBOX,
    status: 'archived' as CloudInboxRow['status'],
    vorgang_link_status: 'none',
    client_file_ref_id: null,
    archive_document_id: DOC,
    vorgang_id: null,
    expense_id: null,
    payload: { recognizedData: { betrag: '62,40' } },
    updated_at: '2026-08-10T10:00:00.000Z',
    deleted: false,
    row_version: 2,
  };
  return {
    files: [],
    bindings: [],
    inboxItems: [eingang],
    workResults: [],
    archivedDocuments: overrides.ohneDokument ? [] : [dokument],
  };
}

const KONTEXT = { deviceId: 'device-1', workspaceId: WORKSPACE };

describe('GLS01 abgewiesene Archivlöschung — Pull holt den Cloud-Stand zurück', () => {
  it('R1: Dokument und Eingangseintrag leben wieder; die Aufträge gelten als erledigt', () => {
    const outbox = [
      auftrag('document', DOC, 'Keine Schreibberechtigung'),
      auftrag('inbox_item', INBOX, 'Keine Schreibberechtigung'),
      auftrag('document_file_binding', `${DOC}|archive|`, 'Keine Schreibberechtigung'),
      auftrag('document', 'doc-anderes', 'Keine Schreibberechtigung'),
    ];
    const state = zustand(outbox);
    const dirty = new Set(['document:' + DOC, 'inbox_item:' + INBOX, 'document:doc-anderes']);

    const applied = applyIntakePullToState(state, pull(), { ...KONTEXT, dirty });

    const dokument = applied.state.documents!.find((item) => item.id === DOC)!;
    expect(dokument.sync?.deleted).toBe(false);
    expect(dokument.sync?.version).toBe(3);
    expect(dokument.title).toBe('Tankbeleg August');
    const eingang = applied.state.inboxItems.find((item) => item.id === INBOX)!;
    expect(eingang.sync?.deleted).toBe(false);
    expect(eingang.archiveDocumentId).toBe(DOC);
    // Lokale Volltextfelder bleiben erhalten.
    expect(eingang.recognizedData?._volltext).toBe('nur lokal');

    const status = Object.fromEntries(applied.state.syncOutbox!.map((entry) => [entry.id, entry.status]));
    expect(status[`out-document-${DOC}`]).toBe('completed');
    expect(status[`out-inbox_item-${INBOX}`]).toBe('completed');
    expect(status[`out-document_file_binding-${DOC}|archive|`]).toBe('completed');
    // Ein fremder Auftrag ohne lebende Cloud-Zeile bleibt, wie er ist.
    expect(status['out-document-doc-anderes']).toBe('error');
  });

  it('R2: andere Fehler sind kein Beweis — nichts wird zurückgeholt', () => {
    const state = zustand([auftrag('document', DOC, 'Failed to fetch')]);
    const applied = applyIntakePullToState(state, pull(), { ...KONTEXT, dirty: new Set(['document:' + DOC]) });

    expect(applied.state.documents!.find((item) => item.id === DOC)?.sync?.deleted).toBe(true);
    expect(applied.state.syncOutbox![0]!.status).toBe('error');
  });

  it('R3: ist das Dokument auch in der Cloud gelöscht oder unbekannt, bleibt der Grabstein', () => {
    const outbox = [auftrag('document', DOC, 'Keine Schreibberechtigung')];
    expect(planRoleDeniedArchiveRestore(zustand(outbox), pull({ dokumentGeloescht: true })).documentIds.size).toBe(0);
    expect(planRoleDeniedArchiveRestore(zustand(outbox), pull({ ohneDokument: true })).documentIds.size).toBe(0);
  });

  it('R5 KONTOSPERRE: ein endgültig abgewiesener Grabstein (failed) weicht nach dem Entsperren dem Cloud-Stand', () => {
    // Seit der Kontosperre-Nacharbeit ist so ein Auftrag `failed` (kein offener Auftrag, nicht im dirty-Satz).
    const outbox: SyncOutboxEntry[] = [
      { ...auftrag('document', DOC, 'Kein Zugriff auf Workspace'), status: 'failed' },
      { ...auftrag('inbox_item', INBOX, 'account_blocked: Konto ist gesperrt'), status: 'failed' },
    ];
    const applied = applyIntakePullToState(zustand(outbox), pull(), { ...KONTEXT, dirty: new Set() });

    const dokument = applied.state.documents!.find((item) => item.id === DOC)!;
    expect(dokument.sync?.deleted).toBe(false);
    expect(dokument.sync?.version).toBe(3);
    expect(applied.state.inboxItems.find((item) => item.id === INBOX)!.sync?.deleted).toBe(false);
    const status = Object.fromEntries(applied.state.syncOutbox!.map((entry) => [entry.id, entry.status]));
    expect(status[`out-document-${DOC}`]).toBe('completed');
    expect(status[`out-inbox_item-${INBOX}`]).toBe('completed');
  });

  it('R4: ohne abgewiesene Aufträge bleibt der Abgleich genau wie bisher', () => {
    const state = zustand([]);
    const applied = applyIntakePullToState(state, pull(), { ...KONTEXT, dirty: new Set() });
    expect(applied.state.documents!.find((item) => item.id === DOC)?.sync?.deleted).toBe(true);
    expect(applied.state.syncOutbox).toEqual([]);
  });
});
