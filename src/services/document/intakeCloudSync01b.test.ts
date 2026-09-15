/**
 * FINANZ-CORE-DURABILITY-01B — Zuordnung, Merge und Backfill-Plan.
 *
 * Reine Funktionen: keine Cloud, kein Store. Geprueft werden die Regeln, die
 * spaeter zwischen zwei Geraeten entscheiden:
 *  - File/Binding-Mapping, natuerliche Binding-Kennung, source_reuse, mehrere Originale
 *  - Inbox-Merge (Remote neuer + lokal sauber -> uebernehmen; lokal schmutzig -> Konflikt, kein local-wins)
 *  - WorkResult: Analyse nur bei gleichem Fingerprint, Overlay slotweise, reviewConflict statt Ueberschreiben
 *  - archiveTruthSnapshot bleibt eingefroren
 *  - Backfill-Plan: idempotent, nur echte, committed, referenzierte Daten; Demo-Eintraege nie
 */
import { describe, expect, it } from 'vitest';
import type { AppPersistedState, CompanyDocument, InboxItem } from '../../types/models';
import type { DocumentFileRef } from '../../types/documentFileRef';
import type { DocumentWorkResult } from '../../types/documentWorkResult';
import type { SyncMeta } from '../../types/sync';
import {
  applyIntakePullToState,
  buildBindingEntityId,
  buildInboxItemCloudPayload,
  buildInboxItemPushPayload,
  buildStoragePath,
  collectDirtyIntakeKeys,
  isCloudSyncBlockedMockInboxId,
  mergeBindingsFromPull,
  mergeFileRefsFromPull,
  mergeInboxItemsFromPull,
  mergeOverlaySlots,
  mergeWorkResultsFromPull,
  parseBindingEntityId,
  type CloudBindingRow,
  type CloudFileRow,
  type CloudInboxRow,
  type CloudWorkResultRow,
} from './intakeCloudSyncService';
import { planIntakeBackfill } from './intakeCloudBackfillService';

const WS = '11111111-1111-4111-8111-111111111111';
const SHA = 'a'.repeat(64);
const ctx = (dirty: string[] = []) => ({ deviceId: 'dev-1', workspaceId: WS, dirty: new Set(dirty) });
const meta = (version: number, deleted = false): SyncMeta => ({ updatedAt: '2026-09-14T10:00:00.000Z', version, deleted, deviceId: 'dev-1', workspaceId: WS });

function fileRow(overrides: Partial<CloudFileRow> = {}): CloudFileRow {
  return {
    client_file_ref_id: 'fr-1', content_sha256: SHA, size_bytes: 3, mime_type: 'text/plain', original_file_name: 'beleg.txt',
    storage_path: `${WS}/${SHA}`, derived_from_client_file_ref_id: null, uploaded_at: '2026-09-14T09:00:00.000Z',
    updated_at: '2026-09-14T09:00:00.000Z', deleted: false, row_version: 1, ...overrides,
  };
}

function inboxRow(overrides: Partial<CloudInboxRow> = {}): CloudInboxRow {
  return {
    client_inbox_id: 'inbox-upload-1', status: 'geprueft', vorgang_link_status: 'created', client_file_ref_id: 'fr-1',
    archive_document_id: 'doc-1', vorgang_id: 'v-1', expense_id: null,
    payload: { title: 'Werkvertrag', documentType: 'kundenauftrag', recognizedData: { Kunde: 'Sägewerk' } },
    updated_at: '2026-09-14T10:00:00.000Z', deleted: false, row_version: 2, ...overrides,
  };
}

function localInbox(overrides: Partial<InboxItem> = {}): InboxItem {
  return {
    id: 'inbox-upload-1', title: 'Werkvertrag', documentType: 'kundenauftrag', sender: 'Sägewerk', priority: 'normal',
    deadline: null, recommendedAction: 'zuordnen', digitalFolder: { id: 'd', name: 'x', path: '/x/' },
    paperFiling: { folderId: 'p', register: 'A', label: 'L' }, status: 'neu', receivedAt: '2026-09-14',
    recognizedData: { Kunde: 'Sägewerk', _vertragstext: 'VOLLTEXT' }, officePilotSuggestion: '', nextTaskLabel: '', securityHint: '',
    ...overrides,
  } as InboxItem;
}

describe('Kennungen und Payloads', () => {
  it('Binding-Kennung ist der natuerliche Schluessel und rund-trip-faehig', () => {
    const id = buildBindingEntityId('doc-1', 'original', 'xml');
    expect(id).toBe('doc-1|original|xml');
    expect(parseBindingEntityId(id)).toEqual({ documentId: 'doc-1', kind: 'original', part: 'xml' });
    expect(parseBindingEntityId('doc-1|archive|')).toEqual({ documentId: 'doc-1', kind: 'archive', part: null });
  });

  it('Storage-Pfad ist ws/sha256 ohne Endung', () => {
    expect(buildStoragePath(WS, SHA.toUpperCase())).toBe(`${WS}/${SHA}`);
  });

  it('Demo-Eingaenge (inbox-00N) bleiben lokal, echte Uploads nicht', () => {
    expect(isCloudSyncBlockedMockInboxId('inbox-001')).toBe(true);
    expect(isCloudSyncBlockedMockInboxId('inbox-upload-1789336354198')).toBe(false);
  });

  it('Inbox-Payload traegt keine Volltext-/Vorschaufelder und keine Sync-Metadaten', () => {
    const payload = buildInboxItemCloudPayload({ ...localInbox(), sync: meta(1) } as InboxItem);
    expect(payload.recognizedData).toEqual({ Kunde: 'Sägewerk' });
    expect(payload).not.toHaveProperty('sync');
    const push = buildInboxItemPushPayload(localInbox({ vorgangId: 'v-1', vorgangLinkStatus: 'created', fileRefId: 'fr-1' }), false);
    expect(push).toMatchObject({ client_inbox_id: 'inbox-upload-1', vorgang_id: 'v-1', vorgang_link_status: 'created', client_file_ref_id: 'fr-1', deleted: false });
  });
});

describe('Merge — Dateien und Bindings', () => {
  it('unbekannte Cloud-Datei wird als cloud-Referenz ohne Bytes uebernommen', () => {
    const merged = mergeFileRefsFromPull([], [fileRow()], ctx());
    expect(merged.items).toHaveLength(1);
    expect(merged.items[0]).toMatchObject({ id: 'fr-1', storageType: 'cloud', contentHash: SHA, lifecycleStatus: 'committed', cloud: { storagePath: `${WS}/${SHA}` } });
    expect(merged.items[0]!.sync?.version).toBe(1);
  });

  it('lokale Datei mit Bytes behaelt ihren Speicher, bekommt aber Cloud-Pfad und Version', () => {
    const local: DocumentFileRef = { id: 'fr-1', originalFileName: 'a.txt', mimeType: 'text/plain', fileSize: 3, contentHash: SHA, storageType: 'indexeddb', localDataKey: 'fr-1', createdAt: '2026-09-14', lifecycleStatus: 'committed' };
    const merged = mergeFileRefsFromPull([local], [fileRow()], ctx());
    expect(merged.items[0]).toMatchObject({ storageType: 'indexeddb', cloud: { storagePath: `${WS}/${SHA}` } });
  });

  it('source_reuse und mehrere Originale: original wird zur Dokument-Datei, weitere Rollen in die Binding-Liste', () => {
    const rows: CloudBindingRow[] = [
      { client_document_id: 'doc-1', client_file_ref_id: 'fr-1', binding_kind: 'original', part: null, provenance: 'received', updated_at: 't', deleted: false, row_version: 1 },
      { client_document_id: 'doc-1', client_file_ref_id: 'fr-1', binding_kind: 'archive', part: null, provenance: 'derived', updated_at: 't', deleted: false, row_version: 1 },
      { client_document_id: 'doc-1', client_file_ref_id: 'fr-xml', binding_kind: 'original', part: 'xml', provenance: 'received', updated_at: 't', deleted: false, row_version: 1 },
      { client_document_id: 'doc-1', client_file_ref_id: 'fr-xml', binding_kind: 'structured', part: null, provenance: 'extracted', updated_at: 't', deleted: false, row_version: 1 },
      { client_document_id: 'doc-1', client_file_ref_id: 'fr-thumb', binding_kind: 'thumbnail', part: null, provenance: 'derived', updated_at: 't', deleted: false, row_version: 1 },
    ];
    const merged = mergeBindingsFromPull([], rows, ctx());
    expect(merged.originals.get('doc-1')).toBe('fr-1');
    expect(merged.items.map((b) => `${b.kind}:${b.fileRefId}`).sort()).toEqual(['archive:fr-1', 'structured:fr-xml']);
  });
});

describe('Merge — Eingang (kein local-wins bei echten Konflikten)', () => {
  it('Remote neuer + lokal sauber: uebernehmen; lokale Volltextfelder bleiben', () => {
    const merged = mergeInboxItemsFromPull([{ ...localInbox(), sync: meta(1) }], [inboxRow()], ctx());
    expect(merged.conflicts).toEqual([]);
    const item = merged.items[0]!;
    expect(item.status).toBe('geprueft');
    expect(item.vorgangId).toBe('v-1');
    expect(item.recognizedData._vertragstext).toBe('VOLLTEXT');
    expect(item.sync?.version).toBe(2);
  });

  it('Remote neuer + lokal schmutzig: lokal behalten, Konflikt melden', () => {
    const merged = mergeInboxItemsFromPull([{ ...localInbox({ status: 'spaeter_klaeren' }), sync: meta(1) }], [inboxRow()], ctx(['inbox_item:inbox-upload-1']));
    expect(merged.conflicts).toEqual(['inbox_item:inbox-upload-1']);
    expect(merged.items[0]!.status).toBe('spaeter_klaeren');
  });

  it('Remote nicht neuer: lokal bleibt unveraendert', () => {
    const merged = mergeInboxItemsFromPull([{ ...localInbox({ status: 'abgelegt' }), sync: meta(3) }], [inboxRow({ row_version: 2 })], ctx());
    expect(merged.items[0]!.status).toBe('abgelegt');
  });

  it('collectDirtyIntakeKeys kennt nur offene Intake-Eintraege', () => {
    const dirty = collectDirtyIntakeKeys([
      { id: '1', entityType: 'inbox_item', entityId: 'inbox-upload-1', operation: 'update', version: 1, queuedAt: 't', retryCount: 0, status: 'pending' },
      { id: '2', entityType: 'document', entityId: 'doc-1', operation: 'update', version: 1, queuedAt: 't', retryCount: 0, status: 'completed' },
      { id: '3', entityType: 'vorgang', entityId: 'v-1', operation: 'update', version: 1, queuedAt: 't', retryCount: 0, status: 'pending' },
    ]);
    expect([...dirty]).toEqual(['inbox_item:inbox-upload-1']);
  });
});

describe('Merge — WorkResult / Provenienz', () => {
  const base: DocumentWorkResult = {
    schemaVersion: 1, inboxItemId: 'inbox-upload-1', analyzedAt: '2026-09-14T09:00:00.000Z', analysisVersion: '01a.1', sourceFingerprint: 'fp-a',
    businessInterpretation: null, specialistRefs: { hasContractIntelligence: true, hasContractOrderProposal: false, hasClassification: true, hasDocumentUnderstanding: false, companyRelevant: true },
    overlay: [{ slotId: 'facts.money.0', status: 'user_confirmed', value: 1200, updatedAt: '2026-09-14T09:30:00.000Z' }],
  };
  const row = (overrides: Partial<CloudWorkResultRow> = {}): CloudWorkResultRow => ({
    client_inbox_id: 'inbox-upload-1', source_fingerprint: 'fp-a', analysis_version: '01a.1', analyzed_at: '2026-09-14T09:10:00.000Z',
    analysis: { specialistRefs: { ...base.specialistRefs, hasDocumentUnderstanding: true } }, overlay: [],
    updated_at: '2026-09-14T10:00:00.000Z', deleted: false, row_version: 2, ...overrides,
  });

  it('Analyse wird nur bei gleichem Fingerprint zusammengefuehrt', () => {
    const same = mergeWorkResultsFromPull([{ ...base, sync: meta(1) }], [row()], ctx());
    expect(same.items[0]!.specialistRefs.hasDocumentUnderstanding).toBe(true);
    const other = mergeWorkResultsFromPull([{ ...base, sync: meta(1) }], [row({ source_fingerprint: 'fp-other' })], ctx());
    expect(other.items[0]!.specialistRefs.hasDocumentUnderstanding).toBe(false);
    expect(other.items[0]!.sourceFingerprint).toBe('fp-a');
  });

  it('Overlay slotweise: fremder Slot kommt dazu, gleicher Slot neuer gewinnt, lokal-schmutzig -> reviewConflict', () => {
    const remote = [
      { slotId: 'facts.money.0', status: 'user_corrected', value: 1300, updatedAt: '2026-09-14T09:45:00.000Z' },
      { slotId: 'operational.nextStep', status: 'user_confirmed', value: 'x', updatedAt: '2026-09-14T09:45:00.000Z' },
    ] as DocumentWorkResult['overlay'];
    const clean = mergeOverlaySlots(base.overlay, remote, false);
    expect(clean.conflictSlots).toEqual([]);
    expect(clean.overlay.find((e) => e.slotId === 'facts.money.0')?.value).toBe(1300);
    expect(clean.overlay).toHaveLength(2);
    const dirty = mergeOverlaySlots(base.overlay, remote, true);
    expect(dirty.conflictSlots).toEqual(['facts.money.0']);
    const slot = dirty.overlay.find((e) => e.slotId === 'facts.money.0')!;
    expect(slot.value).toBe(1200);
    expect(slot.reviewConflict).toBe(true);
  });

  it('archiveTruthSnapshot im Archivdokument wird durch einen spaeteren Pull nicht veraendert', () => {
    const snapshot = { schemaVersion: 1, createdAt: 't', sourceInboxItemId: 'inbox-upload-1', analyzedAt: 't', analysisVersion: '01a.1', sourceFingerprint: 'fp-a', businessInterpretation: null, specialistRefs: base.specialistRefs, overlay: base.overlay };
    const localDoc = { id: 'doc-1', title: 'Werkvertrag', category: 'vertraege', archiveTruthSnapshot: snapshot, sync: meta(1) } as unknown as CompanyDocument;
    const state = { inboxItems: [], documents: [localDoc], documentFileRefs: [], documentFileRepresentationBindings: [], documentWorkResults: [] } as unknown as AppPersistedState;
    const applied = applyIntakePullToState(state, {
      files: [], bindings: [], inboxItems: [], workResults: [row({ overlay: [{ slotId: 'facts.money.0', status: 'user_corrected', value: 999, updatedAt: 'z' }] })],
      archivedDocuments: [{ client_document_id: 'doc-1', document_kind: 'archived_document', linked_invoice_id: null, linked_vorgang_id: null, payload: { title: 'Werkvertrag (umbenannt)', category: 'vertraege', archiveTruthSnapshot: snapshot }, updated_at: 't2', deleted: false, row_version: 2 }],
    }, ctx());
    const doc = applied.state.documents!.find((d) => d.id === 'doc-1')!;
    expect(doc.title).toBe('Werkvertrag (umbenannt)');
    expect(doc.archiveTruthSnapshot?.overlay[0]?.value).toBe(1200);
  });
});

describe('Backfill-Plan', () => {
  it('nur echte, committed und referenzierte Daten ohne Cloud-Meta; idempotent; Demo nie', () => {
    const state = {
      inboxItems: [localInbox({ fileRefId: 'fr-1' }), localInbox({ id: 'inbox-005' }), { ...localInbox({ id: 'inbox-upload-9' }), sync: meta(1) }],
      documents: [
        { id: 'doc-1', title: 'V', category: 'vertraege', fileRefId: 'fr-1', sourceInboxItemId: 'inbox-upload-1' },
        { id: 'doc-gen', title: '2026-0001 – Rechnung', category: 'ausgangsrechnung', linkedInvoiceId: 'inv-1' },
      ],
      documentFileRefs: [
        { id: 'fr-1', contentHash: SHA, lifecycleStatus: 'committed', storageType: 'indexeddb' },
        { id: 'fr-temp', contentHash: SHA, lifecycleStatus: 'temp', storageType: 'indexeddb' },
        { id: 'fr-orphan', contentHash: SHA, lifecycleStatus: 'committed', storageType: 'indexeddb' },
      ],
      documentFileRepresentationBindings: [
        { documentId: 'doc-1', kind: 'archive', fileRefId: 'fr-1' },
        { documentId: 'doc-1', kind: 'thumbnail', fileRefId: 'fr-thumb' },
      ],
      documentWorkResults: [{ inboxItemId: 'inbox-upload-1' }, { inboxItemId: 'inbox-005' }],
    } as unknown as AppPersistedState;
    const plan = planIntakeBackfill(state);
    expect(plan.counts).toEqual({ files: 1, documents: 1, bindings: 1, inboxItems: 1, workResults: 1, expenses: 0, expensePayments: 0 });
    expect(plan.entries.map((e) => `${e.entityType}:${e.entityId}`).sort()).toEqual([
      'document:doc-1',
      'document_file:fr-1',
      'document_file_binding:doc-1|archive|',
      'document_work_result:inbox-upload-1',
      'inbox_item:inbox-upload-1',
    ]);
    // idempotent: derselbe Zustand ergibt denselben Plan
    expect(planIntakeBackfill(state).entries).toEqual(plan.entries);
  });
});
