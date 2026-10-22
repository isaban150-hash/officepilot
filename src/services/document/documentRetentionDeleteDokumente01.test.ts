/**
 * DOKUMENTE-01 / D-017 — Aufbewahrung im Client: Löschschutz, Prüfbestätigung,
 * keine Abschwächung während der Frist, keine Entsorgungsempfehlung ohne Prüfung.
 *
 * Neutrale Beispieldaten, kein Netzwerk (Supabase-Aufrufe sind Stubs).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { alsInhaber } from '../../test/workspaceRoleTestUtils';
import { resetTestStores } from '../../test/resetStores';
import {
  addDocument,
  deleteDocument,
  getDocumentById,
  getDocumentRetention,
  hydrateDocumentStore,
  updateDocument,
} from '../documentService';
import { hydrateVorgangStore } from '../vorgangService';
import { hydrateWorkspaceStore } from '../workspace/workspaceStore';
import {
  DOCUMENT_DELETE_RETENTION_CONFIRM_KEY,
  deleteGeneratedInvoiceDocumentWithCloud,
} from './generatedInvoiceDocumentDeleteService';
import { mapSyncErrorReason } from '../sync/syncOutboxDescriptionService';
import { buildDocumentGuidance } from '../documentGuidanceService';
import { buildInboxDocumentAssistant } from '../documentAssistantService';
import { answerInboxDocumentQuestionById } from '../documentAssistantQuestionService';
import { createMockInboxItemFromUpload } from '../inboxUploadFactory';
import { applyIntakePullToState, type IntakeCloudPull } from './intakeCloudSyncService';
import * as supabaseLib from '../../lib/supabase';
import type { AppPersistedState, CompanyDocument, InboxItem } from '../../types/models';
import type { SyncOutboxEntry } from '../../types/sync';

const INHABER = { userId: 'user-inhaber', cloudConfigured: true };
const GEPRUEFT = { aufbewahrungGeprueft: true } as const;
const WORKSPACE = '00000000-0000-4000-8000-0000000d0c01';

function dokument(id: string, overrides: Partial<CompanyDocument>): CompanyDocument {
  return {
    id,
    title: id,
    category: 'sonstiges',
    issuer: 'Beispiel GmbH',
    recognizedText: 'Beispieltext',
    issueDate: null,
    validUntil: null,
    digitalFolder: { id: 'dig-belege', name: 'Belege', path: '/Belege/' },
    paperFolder: { folderId: 'folder-5', register: 'B', label: 'Belege' },
    tags: [],
    linkedCompany: '',
    linkedVorgang: null,
    archived: true,
    createdAt: '2026-03-16T08:00:00.000Z',
    ...overrides,
  } as CompanyDocument;
}

/** Zeichnet jeden Supabase-Aufruf auf; der Server kennt das Dokument nicht als Nachweis. */
function rpcProtokoll(): string[] {
  const aufrufe: string[] = [];
  vi.spyOn(supabaseLib, 'getSupabaseClient').mockReturnValue({
    rpc: vi.fn(async (name: string) => {
      aufrufe.push(name);
      return { data: name === 'is_workspace_document_payment_proof' ? false : [], error: null };
    }),
  } as never);
  return aufrufe;
}

beforeEach(() => {
  resetTestStores();
  alsInhaber();
});
afterEach(() => {
  vi.restoreAllMocks();
  resetTestStores();
});

describe('DOKUMENTE-01 — Löschschutz während der Aufbewahrungsfrist', () => {
  it('R1: eine Eingangsrechnung ist ein Buchungsbeleg; weder Dienst noch direkter Weg löschen sie', async () => {
    hydrateDocumentStore([dokument('doc-r1', { classifiedKind: 'eingangsrechnung', issueDate: '2026-03-15' })]);
    const aufrufe = rpcProtokoll();

    const aufbewahrung = getDocumentRetention(getDocumentById('doc-r1')!, new Date('2026-10-20T10:00:00Z'));
    expect(aufbewahrung).toMatchObject({ klasse: 'buchungsbeleg', jahre: 8, fristEnde: '2034-12-31', status: 'laeuft' });

    await expect(deleteGeneratedInvoiceDocumentWithCloud('doc-r1', INHABER, GEPRUEFT)).resolves.toEqual({
      ok: false,
      errorKey: 'document.delete.blocked.retention',
    });
    expect(deleteDocument('doc-r1')).toEqual({ success: false, errorKey: 'document.delete.blocked.retention' });
    expect(getDocumentById('doc-r1')).toBeDefined();
    // Kein Cloud-Aufruf, auch kein lesender.
    expect(aufrufe).toEqual([]);
  });

  it('R2: ohne feste Frist löscht der Dienst nur mit ausdrücklicher Prüfbestätigung', async () => {
    hydrateDocumentStore([dokument('doc-r2', { classifiedKind: 'brief', category: 'sonstiges' })]);
    const aufrufe = rpcProtokoll();

    expect(getDocumentRetention(getDocumentById('doc-r2')!).status).toBe('pruefen');
    await expect(deleteGeneratedInvoiceDocumentWithCloud('doc-r2', INHABER)).resolves.toEqual({
      ok: false,
      errorKey: DOCUMENT_DELETE_RETENTION_CONFIRM_KEY,
    });
    expect(getDocumentById('doc-r2')).toBeDefined();
    expect(aufrufe).toEqual([]);

    const result = await deleteGeneratedInvoiceDocumentWithCloud('doc-r2', INHABER, GEPRUEFT);
    expect(result.ok).toBe(true);
    expect(getDocumentById('doc-r2')).toBeUndefined();
  });

  it('R3: rechnerisch abgelaufen heißt nicht „löschbar": nur nach Prüfbestätigung', async () => {
    hydrateDocumentStore([
      dokument('doc-r3', {
        classifiedKind: 'quittung',
        documentDate: '2016-05-01',
        uploadedAt: '2016-05-02T09:00:00.000Z',
        createdAt: '2016-05-02T09:00:00.000Z',
      }),
    ]);
    rpcProtokoll();

    expect(getDocumentRetention(getDocumentById('doc-r3')!, new Date('2026-10-20T10:00:00Z'))).toMatchObject({
      klasse: 'buchungsbeleg',
      fristEnde: '2024-12-31',
      status: 'abgelaufen',
    });
    await expect(deleteGeneratedInvoiceDocumentWithCloud('doc-r3', INHABER)).resolves.toEqual({
      ok: false,
      errorKey: DOCUMENT_DELETE_RETENTION_CONFIRM_KEY,
    });
    expect((await deleteGeneratedInvoiceDocumentWithCloud('doc-r3', INHABER, GEPRUEFT)).ok).toBe(true);
  });

  it('R4: kennt der Server eine Frist, die das Gerät nicht kennt, bleibt das Dokument mit diesem Grund', async () => {
    // Ein Rechnungsbeleg, dessen Rechnung lokal fehlt: für das Gerät „prüfen", für den Server nicht.
    hydrateVorgangStore([]);
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
      dokument('doc-r4', {
        category: 'ausgangsrechnung',
        classifiedKind: 'ausgangsrechnung',
        linkedInvoiceId: 'inv-r4',
      }),
    ]);
    vi.spyOn(supabaseLib, 'isSupabaseConfigured').mockReturnValue(true);
    vi.spyOn(supabaseLib, 'getSupabaseClient').mockReturnValue({
      rpc: vi.fn(async (name: string) =>
        name === 'tombstone_workspace_document'
          ? {
              data: null,
              error: {
                message: 'Keine Schreibberechtigung: Aufbewahrungsfrist laeuft bis 31.12.2034 (buchungsbeleg, 8 Jahre)',
                code: '42501',
              },
            }
          : { data: false, error: null },
      ),
    } as never);

    expect(getDocumentRetention(getDocumentById('doc-r4')!).grund).toBe('rechnung_nicht_festgeschrieben');
    await expect(deleteGeneratedInvoiceDocumentWithCloud('doc-r4', INHABER, GEPRUEFT)).resolves.toEqual({
      ok: false,
      errorKey: 'document.delete.blocked.retention',
    });
    expect(getDocumentById('doc-r4')).toBeDefined();
  });

  it('R5: die Abweisung im Sync heißt „Aufbewahrung", nicht „keine Berechtigung"', () => {
    expect(
      mapSyncErrorReason('Keine Schreibberechtigung: Aufbewahrungsfrist laeuft bis 31.12.2034 (buchungsbeleg, 8 Jahre)', 'failed'),
    ).toBe('sync.failure.reason.retention');
    expect(
      mapSyncErrorReason(
        'Keine Schreibberechtigung: Aufbewahrungspflichtige Einstufung (buchungsbeleg, Frist bis 31.12.2034) kann nicht abgeschwaecht werden',
        'failed',
      ),
    ).toBe('sync.failure.reason.retention');
    expect(mapSyncErrorReason('Keine Schreibberechtigung', 'failed')).toBe('sync.failure.reason.permission');
  });
});

describe('DOKUMENTE-01 — keine Abschwächung während der Frist', () => {
  it('A1: die Kategorie „Ausgangsrechnung" lässt sich während der Frist nicht aufheben; Titel und Datum schon', () => {
    const angelegt = addDocument({
      title: 'Rechnung 17 (Papier)',
      category: 'ausgangsrechnung',
      issuer: 'Eigener Betrieb',
      recognizedText: 'Rechnung 17',
      issueDate: '2026-04-01',
      archived: true,
    });
    if (!angelegt.success) throw new Error('nicht angelegt');
    const id = angelegt.document.id;
    expect(getDocumentRetention(getDocumentById(id)!).klasse).toBe('buchungsbeleg');

    expect(updateDocument(id, { category: 'sonstiges' })).toEqual({
      success: false,
      errorKey: 'document.retention.downgradeBlocked',
    });
    expect(getDocumentById(id)?.category).toBe('ausgangsrechnung');

    expect(updateDocument(id, { title: 'Rechnung 17, Kopie' }).success).toBe(true);
    // Ein früheres Datum verkürzt die Frist nicht unter das Jahr der Erfassung.
    expect(updateDocument(id, { issueDate: '2010-01-01' }).success).toBe(true);
    expect(getDocumentRetention(getDocumentById(id)!).status).toBe('laeuft');
  });

  it('A2: eine Aufwertung zum Buchungsbeleg ist jederzeit möglich', () => {
    const angelegt = addDocument({
      title: 'Schreiben',
      category: 'sonstiges',
      issuer: 'Beispiel GmbH',
      recognizedText: 'Schreiben',
      issueDate: '2026-04-01',
      archived: true,
    });
    if (!angelegt.success) throw new Error('nicht angelegt');
    expect(updateDocument(angelegt.document.id, { category: 'ausgangsrechnung' }).success).toBe(true);
    expect(getDocumentRetention(getDocumentById(angelegt.document.id)!).klasse).toBe('buchungsbeleg');
  });
});

describe('DOKUMENTE-01 / F10 — keine Entsorgungsempfehlung ohne Aufbewahrungsprüfung', () => {
  function abgelegt(kind: InboxItem['classifiedKind'], extra: Partial<InboxItem> = {}): InboxItem {
    const item = createMockInboxItemFromUpload({ sourceFileName: 'beleg.pdf', recognizedText: 'Beispiel' });
    return { ...item, classifiedKind: kind, status: 'abgelegt', importedToArchive: true, deadline: null, ...extra };
  }

  it('F10-1: eine abgelegte Rechnung „kann nicht entsorgt werden" — sie ist aufzubewahren', () => {
    const item = abgelegt('eingangsrechnung');
    expect(buildDocumentGuidance(item).retain.params?.originalKey).toBe('docAssistant.original.keepUntilTax');
    const assistent = buildInboxDocumentAssistant(item);
    expect(assistent.originalGuidance).toBe('keep_until_tax');
    expect(answerInboxDocumentQuestionById(item, assistent, 'dispose').answerKey).toBe(
      'docAssistant.answer.disposeKeepTax',
    );
  });

  it('F10-2: ein abgelegtes Dokument ohne feste Regel bleibt „unsicher", nie „entsorgen"', () => {
    const item = abgelegt('sonstiges');
    expect(buildDocumentGuidance(item).retain.params?.originalKey).toBe('docAssistant.original.uncertain');
    const assistent = buildInboxDocumentAssistant(item);
    expect(assistent.originalGuidance).toBe('uncertain');
    expect(answerInboxDocumentQuestionById(item, assistent, 'dispose').answerKey).toBe(
      'docAssistant.answer.disposeUncertain',
    );
  });

  it('F10-3: nur erkannte Werbung darf nach der digitalen Ablage entsorgt werden', () => {
    const item = abgelegt('sonstiges', { isAdvertisement: true });
    expect(buildDocumentGuidance(item).retain.params?.originalKey).toBe('docAssistant.original.disposeAfterDigital');
    expect(buildInboxDocumentAssistant(item).originalGuidance).toBe('dispose_after_digital');
  });
});

describe('DOKUMENTE-01 — ein alter App-Stand löscht einen geschützten Beleg nur scheinbar', () => {
  it('weist der Server den Grabstein wegen der Frist ab, holt der nächste Abzug das Dokument zurück', () => {
    const meldung = 'Keine Schreibberechtigung: Aufbewahrungsfrist laeuft bis 31.12.2034 (buchungsbeleg, 8 Jahre)';
    const meta = { updatedAt: '2026-10-20T08:00:00.000Z', deviceId: 'alt-geraet', workspaceId: WORKSPACE };
    const grabstein = dokument('doc-alt', {
      classifiedKind: 'eingangsrechnung',
      sync: { ...meta, version: 1, deleted: true, deletedAt: '2026-10-20T08:00:00.000Z' },
    } as Partial<CompanyDocument>);
    const auftrag: SyncOutboxEntry = {
      id: 'out-document-doc-alt',
      entityType: 'document',
      entityId: 'doc-alt',
      operation: 'delete',
      version: 1,
      queuedAt: '2026-10-20T08:00:00.000Z',
      retryCount: 1,
      status: 'failed',
      lastErrorMessage: meldung,
      lastErrorAt: '2026-10-20T08:00:02.000Z',
      lastErrorRetryable: false,
    } as SyncOutboxEntry;
    const state = {
      documents: [grabstein],
      inboxItems: [],
      documentFileRefs: [],
      documentFileRepresentationBindings: [],
      documentWorkResults: [],
      syncOutbox: [auftrag],
    } as unknown as AppPersistedState;
    const pull: IntakeCloudPull = {
      files: [],
      bindings: [],
      inboxItems: [],
      workResults: [],
      archivedDocuments: [
        {
          client_document_id: 'doc-alt',
          document_kind: 'archived_document',
          linked_invoice_id: null,
          linked_vorgang_id: null,
          payload: { title: 'Eingangsrechnung', category: 'sonstiges', classifiedKind: 'eingangsrechnung' },
          updated_at: '2026-10-20T07:00:00.000Z',
          deleted: false,
          row_version: 1,
        },
      ],
    };

    const applied = applyIntakePullToState(state, pull, {
      deviceId: 'alt-geraet',
      workspaceId: WORKSPACE,
      dirty: new Set(['document:doc-alt']),
    });

    expect(applied.state.documents!.find((d) => d.id === 'doc-alt')?.sync?.deleted).toBe(false);
    expect(applied.state.syncOutbox![0]!.status).toBe('completed');
  });
});
