/**
 * CLOUD-SYNC S1 — der Papierablage-Haken wird Workspace-Wahrheit.
 *
 * Geprüft wird der ganze Weg auf der Client-Seite: Entstehen des Eintrags,
 * Sendeauftrag, Payload, Versand über den bestehenden Dispatcher, Abzug,
 * Abgleich mit Konfliktvertrag, Altbestand, Wiederanlauf, Grabstein, Reload
 * und die Anzeige danach. Die Serverseite (Version, Rechte, Isolation, RLS)
 * prüft `supabase/tests/paper_register_entries_s1.sql` gegen eine echte
 * Datenbank.
 *
 * Der Typ ist freigegeben, seit die Migration 20261030120000 remote angewendet
 * ist. Wo ein Test das Verhalten bei zurückgenommener Freigabe prüft, wird sie
 * hier ausdrücklich ausgeschaltet — der Schalter bleibt der Notausschalter.
 *
 * Neutrale Beispieldaten.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CompanyDocument } from '../../types/models';
import type { DocumentMemory, PaperRegisterEntry } from '../../types/memory';
import type { SyncMeta, SyncOutboxEntry } from '../../types/sync';
import {
  buildPaperRegisterEntryCloudContentKey,
  buildPaperRegisterEntryCloudPushPayload,
  mergePaperRegisterEntriesFromPull,
  planPaperRegisterEntryBackfill,
  planPaperRegisterEntryLostAckAdoption,
  stripPaperRegisterEntryForCloud,
  type WorkspacePaperRegisterEntryRow,
} from './paperRegisterCloudService';
import {
  getDocumentMemoryByDocumentId,
  getPaperRegisterEntryForDocument,
  getPhysicalFilingForDocument,
  hydrateMemory,
  markDocumentPhysicallyFiled,
  resetMemory,
} from '../officePilotMemoryService';
import { deleteDocument, getDocumentById, hydrateDocumentStore } from '../documentService';
import {
  applyStateToStores,
  buildPersistedStateSnapshot,
  loadPersistedState,
  persistAll,
} from '../persistenceService';
import {
  enqueueSyncOutbox,
  getSyncOutboxSnapshot,
  resetSyncOutboxForTests,
} from '../sync/syncOutboxService';
import { resetSyncChangeTrackerForTests } from '../sync/syncChangeTrackerService';
import { createSyncClient, resetSyncClientForTests } from '../sync/syncClientService';
import * as allowlist from '../sync/cloudSyncAllowlist';
import { SupabaseSyncAdapter } from '../sync/supabaseSyncAdapter';
import * as workspaceCloudService from '../workspace/workspaceCloudService';
import { mergeRemoteWorkspacePullIntoState } from '../workspace/workspaceProvisioningService';
import * as supabaseLib from '../../lib/supabase';
import { importInboxDocumentForTests } from '../../test/confirmFilingDecisionForTests';
import { createAuftragInboxItem } from '../../test/fixtures';
import { AppProvider } from '../../context/AppContext';
import { DEFAULT_SETUP } from '../../data/mockData';
import { DocumentFilingCard } from '../../components/documents/DocumentFilingCard';
import { t } from '../../i18n';

const WORKSPACE = 'ws-paper-s1';
const DEVICE = 'device-paper-s1';
const UPDATED_AT = '2026-10-05T09:00:00.000Z';

function syncMeta(version: number, overrides: Partial<SyncMeta> = {}): SyncMeta {
  return {
    updatedAt: UPDATED_AT,
    version,
    deleted: false,
    deviceId: DEVICE,
    workspaceId: WORKSPACE,
    ...overrides,
  };
}

function eintrag(overrides: Partial<PaperRegisterEntry> = {}): PaperRegisterEntry {
  return {
    id: 'paper-reg-doc-1',
    documentId: 'doc-1',
    documentTitle: 'Steuerbescheid 2025',
    folderId: 'ordner-steuern',
    register: 'Bescheide',
    physicalFiled: false,
    createdAt: '2026-10-05T08:00:00.000Z',
    updatedAt: '2026-10-05T08:00:00.000Z',
    ...overrides,
  };
}

function zeile(base: PaperRegisterEntry, rowVersion: number, deleted = false): WorkspacePaperRegisterEntryRow {
  return {
    workspace_id: WORKSPACE,
    client_entry_id: base.id,
    client_document_id: base.documentId,
    payload: stripPaperRegisterEntryForCloud(base) as unknown as Record<string, unknown>,
    row_version: rowVersion,
    deleted,
    deleted_at: deleted ? UPDATED_AT : null,
    updated_at: UPDATED_AT,
  };
}

function dokument(overrides: Partial<CompanyDocument> = {}): CompanyDocument {
  return {
    id: 'doc-1',
    title: 'Steuerbescheid 2025',
    category: 'steuer',
    issuer: 'Finanzamt Musterstadt',
    recognizedText: '',
    issueDate: '2026-09-30',
    validUntil: null,
    digitalFolder: { id: 'dig-steuern', name: 'Steuern', path: '/Steuern/' },
    paperFolder: { folderId: 'ordner-steuern', register: 'Bescheide', label: 'Ordner Steuern' },
    tags: [],
    linkedCompany: 'Muster GmbH',
    linkedVorgang: null,
    archived: true,
    createdAt: '2026-10-05T08:00:00.000Z',
    ...overrides,
  };
}

function gedaechtnis(overrides: Partial<DocumentMemory> = {}): DocumentMemory {
  return {
    id: 'docmem-1',
    documentId: 'doc-1',
    title: 'Steuerbescheid 2025',
    issuer: 'Finanzamt Musterstadt',
    digitalFolder: { id: 'dig-steuern', name: 'Steuern', path: '/Steuern/' },
    paperFolder: { folderId: 'ordner-steuern', register: 'Bescheide', label: 'Ordner Steuern' },
    validUntil: null,
    physicalFiled: false,
    createdAt: '2026-10-05T08:00:00.000Z',
    updatedAt: '2026-10-05T08:00:00.000Z',
    ...overrides,
  };
}

function speicher(entries: PaperRegisterEntry[], memories: DocumentMemory[] = []): void {
  hydrateMemory({ documentMemories: memories, proofMemories: [], relations: [], paperRegisterEntries: entries });
}

function pullMit(rows: WorkspacePaperRegisterEntryRow[]) {
  return {
    workspace: null,
    members: [],
    settings: null,
    setupPayload: null,
    setupRowVersion: 0,
    setupUpdatedAt: null,
    companyProfilePayload: null,
    companyProfileRowVersion: 0,
    companyProfileUpdatedAt: null,
    vorgaenge: [],
    customers: [],
    paperRegisterEntries: rows,
  } as unknown as Parameters<typeof mergeRemoteWorkspacePullIntoState>[1];
}

/** Die Freigabe zurücknehmen — der Schalter als Notausschalter. */
function freigabeZuruecknehmen(): void {
  vi.spyOn(allowlist, 'isSupabaseSyncAllowed').mockImplementation(
    (type) => type !== 'paper_register_entry' && allowlist.SUPABASE_SYNC_ALLOWLIST.has(type),
  );
}

function papierAuftraege(): SyncOutboxEntry[] {
  return getSyncOutboxSnapshot().filter(
    (entry) => entry.entityType === 'paper_register_entry' && entry.status !== 'completed',
  );
}

function render(documentId: string): string {
  return renderToStaticMarkup(
    createElement(
      MemoryRouter,
      null,
      createElement(
        AppProvider,
        { initialSetup: DEFAULT_SETUP },
        createElement(DocumentFilingCard, { documentId }),
      ),
    ),
  );
}

beforeEach(() => {
  localStorage.clear();
  resetMemory();
  hydrateDocumentStore([]);
  resetSyncOutboxForTests([]);
  resetSyncChangeTrackerForTests();
  resetSyncClientForTests({ ...createSyncClient(), deviceId: DEVICE, workspaceId: WORKSPACE, serverWorkspaceId: WORKSPACE });
});

afterEach(() => {
  vi.restoreAllMocks();
});

/* ------------------------------------------------------------------ */
/* A — der Eintrag entsteht                                            */
/* ------------------------------------------------------------------ */

describe('S1-A — der Eintrag entsteht und bleibt Wahrheit', () => {
  it('A1 — Archivieren legt den Eintrag mit stabiler Kennung an, ohne Serverversion', () => {
    const result = importInboxDocumentForTests(
      createAuftragInboxItem({
        id: 'inbox-s1-a1',
        title: 'Freistellungsbescheinigung §48b',
        documentType: 'behoerde',
        classifiedKind: 'freistellungsbescheinigung',
        sender: 'Finanzamt Musterstadt',
      }),
      'Muster GmbH',
    );
    expect(result.success).toBe(true);
    if (!result.success) return;

    const entry = getPaperRegisterEntryForDocument(result.document.id);
    expect(entry?.id).toBe(`paper-reg-${result.document.id}`);
    expect(entry?.documentId).toBe(result.document.id);
    expect(entry?.physicalFiled).toBe(false);
    expect(entry?.createdAt).toBeTruthy();
    expect(entry?.updatedAt).toBeTruthy();
    // Keine erfundene Serverbestätigung.
    expect(entry?.sync?.version ?? 0).toBe(0);
  });

  it('A2 — Abheften auf einem Gerät ohne Gedächtnis legt den Eintrag an (zweites Gerät)', () => {
    const doc = dokument();
    hydrateDocumentStore([doc]);
    expect(getDocumentMemoryByDocumentId(doc.id)).toBeUndefined();

    const updated = markDocumentPhysicallyFiled(doc.id, 'Erika Muster', doc);

    expect(updated).not.toBeNull();
    const entry = getPaperRegisterEntryForDocument(doc.id);
    expect(entry).toMatchObject({
      id: 'paper-reg-doc-1',
      documentId: 'doc-1',
      documentTitle: 'Steuerbescheid 2025',
      folderId: 'ordner-steuern',
      register: 'Bescheide',
      physicalFiled: true,
      filedByUser: 'Erika Muster',
    });
    expect(entry?.filedAt).toBeTruthy();
    /*
     * Der Eintrag allein trägt die Wahrheit. CLOUD-SYNC S4: Das Gedächtnis ist
     * seitdem eine Projektion des Dokuments — es entsteht beim Speichern und
     * spiegelt den Eintrag, eine eigene Wahrheit trägt es nicht.
     */
    expect(getDocumentMemoryByDocumentId(doc.id)).toMatchObject({ physicalFiled: true, filedByUser: 'Erika Muster' });
  });

  it('A3 — Haken ohne vorhandenen Eintrag landet nicht mehr nur im Gedächtnis', () => {
    // Altbestand: Beim Archivieren gab es keine Papierregel, also keinen Eintrag.
    hydrateDocumentStore([dokument()]);
    speicher([], [gedaechtnis()]);

    markDocumentPhysicallyFiled('doc-1', 'Erika Muster');

    expect(getPaperRegisterEntryForDocument('doc-1')?.physicalFiled).toBe(true);
    // Der Spiegel dieses Geräts läuft mit.
    expect(getDocumentMemoryByDocumentId('doc-1')?.physicalFiled).toBe(true);
  });

  it('A4 — Abheften lässt die bestätigte Serverversion unberührt', () => {
    hydrateDocumentStore([dokument()]);
    speicher([{ ...eintrag(), sync: syncMeta(3) }]);

    markDocumentPhysicallyFiled('doc-1');

    const entry = getPaperRegisterEntryForDocument('doc-1');
    expect(entry?.physicalFiled).toBe(true);
    expect(entry?.sync?.version, 'Die Version zählt nur der Server').toBe(3);
  });

  it('A5 — der Grabstein eines gelöschten Dokuments wird nicht wiederbelebt', () => {
    hydrateDocumentStore([dokument()]);
    speicher([{ ...eintrag(), sync: syncMeta(2, { deleted: true, deletedAt: UPDATED_AT }) }]);

    expect(markDocumentPhysicallyFiled('doc-1', undefined, dokument())).toBeNull();
    expect(getPaperRegisterEntryForDocument('doc-1')).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */
/* B/C — Sendeauftrag und Payload                                      */
/* ------------------------------------------------------------------ */

describe('S1-B/C — Sendeauftrag und Payload', () => {
  it('B1 — Abheften reiht genau einen Auftrag für genau diesen Eintrag ein', () => {
    hydrateDocumentStore([dokument()]);
    speicher([{ ...eintrag(), sync: syncMeta(1) }]);
    persistAll(); // Grundlinie des Änderungsverfolgers
    resetSyncOutboxForTests([]);

    markDocumentPhysicallyFiled('doc-1');

    const auftraege = papierAuftraege();
    expect(auftraege).toHaveLength(1);
    expect(auftraege[0]).toMatchObject({
      entityType: 'paper_register_entry',
      entityId: 'paper-reg-doc-1',
      operation: 'update',
    });
  });

  it('B2 — ein neuer Eintrag auf dem zweiten Gerät wird als Anlage eingereiht', () => {
    hydrateDocumentStore([dokument()]);
    persistAll();
    resetSyncOutboxForTests([]);

    markDocumentPhysicallyFiled('doc-1', undefined, dokument());

    expect(papierAuftraege()).toEqual([
      expect.objectContaining({ entityId: 'paper-reg-doc-1', operation: 'create' }),
    ]);
  });

  it('B3 — die zurückgeschriebene Serverversion löst keinen neuen Auftrag aus', () => {
    hydrateDocumentStore([dokument()]);
    speicher([{ ...eintrag({ physicalFiled: true }), sync: syncMeta(1) }]);
    persistAll();
    resetSyncOutboxForTests([]);

    // Nur Sync-Metadaten ändern sich — wie nach einem bestätigten Versand.
    speicher([{ ...eintrag({ physicalFiled: true }), sync: syncMeta(2, { updatedAt: '2026-10-05T10:00:00.000Z' }) }]);
    persistAll();

    expect(papierAuftraege()).toEqual([]);
  });

  it('C1 — der Payload trägt Kennung, Dokumentbezug und nur die fachlichen Felder', () => {
    const entry: PaperRegisterEntry = {
      ...eintrag({ physicalFiled: true, filedAt: UPDATED_AT, filedByUser: 'Erika Muster' }),
      sync: syncMeta(4),
    };

    const push = buildPaperRegisterEntryCloudPushPayload(entry);

    expect(push).toEqual({
      entry_id: 'paper-reg-doc-1',
      document_id: 'doc-1',
      deleted: false,
      payload: {
        id: 'paper-reg-doc-1',
        documentId: 'doc-1',
        documentTitle: 'Steuerbescheid 2025',
        folderId: 'ordner-steuern',
        register: 'Bescheide',
        physicalFiled: true,
        createdAt: '2026-10-05T08:00:00.000Z',
        updatedAt: '2026-10-05T08:00:00.000Z',
        filedAt: UPDATED_AT,
        filedByUser: 'Erika Muster',
      },
    });
    expect(JSON.stringify(push)).not.toContain('"sync"');
    expect(buildPaperRegisterEntryCloudPushPayload(entry, true).deleted).toBe(true);
  });

  it('C2 — der Inhaltsschlüssel kennt den Haken, aber keine Serverversion', () => {
    const a = { ...eintrag(), sync: syncMeta(1) };
    const b = { ...eintrag(), sync: syncMeta(7, { deviceId: 'anderes-geraet' }) };
    expect(buildPaperRegisterEntryCloudContentKey(a)).toBe(buildPaperRegisterEntryCloudContentKey(b));
    expect(buildPaperRegisterEntryCloudContentKey(a)).not.toBe(
      buildPaperRegisterEntryCloudContentKey({ ...a, physicalFiled: true }),
    );
    // Fehlend und leer ergeben denselben Schlüssel — kein Schein-Versand.
    expect(buildPaperRegisterEntryCloudContentKey(a)).toBe(
      buildPaperRegisterEntryCloudContentKey({ ...a, filedAt: undefined, filedByUser: undefined }),
    );
  });
});

/* ------------------------------------------------------------------ */
/* D/K — Versand über die bestehende Warteschlange                     */
/* ------------------------------------------------------------------ */

describe('S1-D/K — Versand über den bestehenden Dispatcher', () => {
  function adapterMitFreigabe(rowVersion: number) {
    vi.spyOn(supabaseLib, 'isSupabaseConfigured').mockReturnValue(true);
    const upsert = vi
      .spyOn(workspaceCloudService, 'rpcUpsertWorkspaceSyncEntity')
      .mockResolvedValue({ rowVersion, payload: {}, entityId: null, deduped: false });
    const adapter = new SupabaseSyncAdapter(null);
    vi.spyOn(adapter as unknown as { assertClient: () => unknown }, 'assertClient').mockReturnValue({});
    return { adapter, upsert };
  }

  function auftrag(operation: SyncOutboxEntry['operation']): SyncOutboxEntry {
    const entry = enqueueSyncOutbox({ entityType: 'paper_register_entry', entityId: 'paper-reg-doc-1', operation, version: 0 });
    // 01G6 — der Sendenachweis braucht einen gespeicherten Bestand, sonst wird nicht gesendet.
    persistAll();
    return entry;
  }

  function zustand(entry: PaperRegisterEntry) {
    return {
      ...buildPersistedStateSnapshot(),
      officePilotMemory: { documentMemories: [], proofMemories: [], relations: [], paperRegisterEntries: [entry] },
    };
  }

  it('D1/K1 — mit Freigabe geht der Eintrag über upsert_workspace_sync_entity, nur in den eigenen Betrieb', async () => {
    const { adapter, upsert } = adapterMitFreigabe(1);
    const entry = eintrag({ physicalFiled: true, filedAt: UPDATED_AT });
    const state = zustand(entry);
    const outbox = [auftrag('create')];

    const result = await adapter.pushChanges({ deviceId: DEVICE, workspaceId: WORKSPACE, state, outbox });

    expect(result.failedOutbox).toEqual([]);
    expect(result.completedOutboxIds).toEqual([outbox[0]!.id]);
    expect(upsert).toHaveBeenCalledTimes(1);
    const [workspaceId, entityType, payload, rowVersion] = upsert.mock.calls[0]!;
    expect(workspaceId, 'nur der eigene Betrieb').toBe(WORKSPACE);
    expect(entityType).toBe('paper_register_entry');
    expect(rowVersion, 'Neuanlage: diese Zeile darf noch nicht existieren').toBe(0);
    expect(payload).toEqual(buildPaperRegisterEntryCloudPushPayload(entry));
    // Die bestätigte Version kommt zurück, der Haken bleibt.
    const gespeichert = result.state.officePilotMemory?.paperRegisterEntries[0];
    expect(gespeichert?.sync?.version).toBe(1);
    expect(gespeichert?.physicalFiled).toBe(true);
  });

  it('D2 — der Grabstein reist mit Dokumentbezug und bleibt lokal ein Grabstein', async () => {
    const { adapter, upsert } = adapterMitFreigabe(5);
    const entry: PaperRegisterEntry = {
      ...eintrag({ physicalFiled: true }),
      sync: syncMeta(4, { deleted: true, deletedAt: UPDATED_AT }),
    };
    const outbox = [auftrag('delete')];

    const result = await adapter.pushChanges({ deviceId: DEVICE, workspaceId: WORKSPACE, state: zustand(entry), outbox });

    const [, , payload, rowVersion] = upsert.mock.calls[0]!;
    expect(payload).toMatchObject({ entry_id: 'paper-reg-doc-1', document_id: 'doc-1', deleted: true });
    expect(rowVersion, 'die bestätigte Version als Erwartung').toBe(4);
    const gespeichert = result.state.officePilotMemory?.paperRegisterEntries[0];
    expect(gespeichert?.sync?.deleted).toBe(true);
    expect(gespeichert?.sync?.version).toBe(5);
  });

  it('D0 — der Typ ist freigegeben und nicht mehr nur-lokal', () => {
    expect(allowlist.isSupabaseSyncAllowed('paper_register_entry')).toBe(true);
    expect(allowlist.LOCAL_ONLY_SYNC_ENTITY_TYPES.has('paper_register_entry')).toBe(false);
  });

  it('D3 — mit zurückgenommener Freigabe wird nichts gesendet (Notausschalter)', async () => {
    freigabeZuruecknehmen();
    vi.spyOn(supabaseLib, 'isSupabaseConfigured').mockReturnValue(true);
    const upsert = vi.spyOn(workspaceCloudService, 'rpcUpsertWorkspaceSyncEntity');
    const outbox = [auftrag('create')];

    const result = await new SupabaseSyncAdapter(null).pushChanges({
      deviceId: DEVICE,
      workspaceId: WORKSPACE,
      state: zustand(eintrag()),
      outbox,
    });

    expect(upsert).not.toHaveBeenCalled();
    expect(result.completedOutboxIds).toEqual([outbox[0]!.id]);
  });
});

/* ------------------------------------------------------------------ */
/* E–J — Abzug, Abgleich, Altbestand, Wiederanlauf, Grabstein           */
/* ------------------------------------------------------------------ */

describe('S1-E/F — der Eintrag kommt aus der Cloud zurück', () => {
  it('E1 — ein Eintrag aus der Cloud kommt vollständig und mit Serverversion an', () => {
    const remote = eintrag({ physicalFiled: true, filedAt: UPDATED_AT, filedByUser: 'Erika Muster' });
    const merged = mergePaperRegisterEntriesFromPull([], [zeile(remote, 2)], DEVICE, WORKSPACE);

    expect(merged.conflicts).toEqual([]);
    expect(merged.entries).toHaveLength(1);
    expect(merged.entries[0]).toMatchObject({
      id: 'paper-reg-doc-1',
      documentId: 'doc-1',
      physicalFiled: true,
      filedByUser: 'Erika Muster',
      sync: { version: 2, deleted: false, workspaceId: WORKSPACE },
    });
  });

  it('F1 — der Abgleich legt ihn in den Speicher; die Anzeige liest ihn', () => {
    hydrateDocumentStore([dokument()]);
    const remote = eintrag({ physicalFiled: true, filedAt: UPDATED_AT });

    const merged = mergeRemoteWorkspacePullIntoState(buildPersistedStateSnapshot(), pullMit([zeile(remote, 1)]));
    expect(merged.conflicts).toEqual([]);
    hydrateMemory(merged.state.officePilotMemory!);

    expect(getPaperRegisterEntryForDocument('doc-1')?.sync?.version).toBe(1);
    expect(getPhysicalFilingForDocument('doc-1')).toMatchObject({ physicalFiled: true, filedAt: UPDATED_AT });
    // Nichts wird zurückgesendet, was gerade aus der Cloud kam.
    expect(papierAuftraege()).toEqual([]);
  });
});

describe('S1-G — vorhandene lokale Entscheidungen gehen nicht verloren', () => {
  it('G1 — ein lokaler Eintrag ohne Cloudzeile bleibt und wird als Anlage nachgetragen', () => {
    hydrateDocumentStore([dokument()]);
    speicher([eintrag({ physicalFiled: true, filedAt: UPDATED_AT })]);

    const merged = mergeRemoteWorkspacePullIntoState(buildPersistedStateSnapshot(), pullMit([]));

    expect(merged.state.officePilotMemory?.paperRegisterEntries.map((e) => e.id)).toEqual(['paper-reg-doc-1']);
    expect(papierAuftraege()).toEqual([
      expect.objectContaining({ entityId: 'paper-reg-doc-1', operation: 'create', version: 0 }),
    ]);
  });

  it('G2 — ein Haken, der vor S1 nur im Gedächtnis stand, wird zum Eintrag', () => {
    hydrateDocumentStore([dokument()]);
    speicher([], [gedaechtnis({ physicalFiled: true, filedAt: UPDATED_AT, filedByUser: 'Erika Muster', inboxId: 'inbox-1' })]);

    const merged = mergeRemoteWorkspacePullIntoState(buildPersistedStateSnapshot(), pullMit([]));

    expect(merged.state.officePilotMemory?.paperRegisterEntries).toEqual([
      expect.objectContaining({
        id: 'paper-reg-doc-1',
        documentId: 'doc-1',
        folderId: 'ordner-steuern',
        register: 'Bescheide',
        physicalFiled: true,
        filedAt: UPDATED_AT,
        filedByUser: 'Erika Muster',
        sourceInboxId: 'inbox-1',
      }),
    ]);
    expect(papierAuftraege()).toEqual([expect.objectContaining({ entityId: 'paper-reg-doc-1', operation: 'create' })]);
  });

  it('G3 — kein Nachziehen, wenn die Cloud das Dokument schon kennt oder es gelöscht ist', () => {
    hydrateDocumentStore([dokument(), dokument({ id: 'doc-2', sync: syncMeta(2, { deleted: true }) })]);
    speicher(
      [],
      [
        gedaechtnis({ physicalFiled: true }),
        gedaechtnis({ id: 'docmem-2', documentId: 'doc-2', physicalFiled: true }),
      ],
    );
    // Für doc-1 liegt in der Cloud bereits ein Grabstein.
    const grabstein = zeile(eintrag(), 3, true);

    const merged = mergeRemoteWorkspacePullIntoState(buildPersistedStateSnapshot(), pullMit([grabstein]));

    expect(merged.state.officePilotMemory?.paperRegisterEntries).toEqual([]);
    expect(papierAuftraege()).toEqual([]);
  });

  it('G4 — mit zurückgenommener Freigabe kein Nachtrag: die Warteschlange läuft nicht bei jedem Abzug voll', () => {
    freigabeZuruecknehmen();
    hydrateDocumentStore([dokument()]);
    speicher([eintrag({ physicalFiled: true })]);

    const merged = mergeRemoteWorkspacePullIntoState(buildPersistedStateSnapshot(), pullMit([]));

    expect(papierAuftraege()).toEqual([]);
    expect(merged.state.officePilotMemory?.paperRegisterEntries).toHaveLength(1);
  });

  it('G5 — der Haken eines hier nicht (mehr) bestehenden Dokuments wird nicht hochgeladen', () => {
    // Vor S1 blieb der Eintrag stehen, wenn ein anderes Gerät das Dokument löschte.
    hydrateDocumentStore([dokument({ sync: syncMeta(4, { deleted: true, deletedAt: UPDATED_AT }) })]);
    speicher([eintrag({ physicalFiled: true })]);

    const merged = mergeRemoteWorkspacePullIntoState(buildPersistedStateSnapshot(), pullMit([]));

    expect(papierAuftraege()).toEqual([]);
    // Lokal geht dabei nichts verloren.
    expect(merged.state.officePilotMemory?.paperRegisterEntries).toHaveLength(1);
  });
});

describe('S1-H — Konfliktvertrag statt Last-Write-Wins', () => {
  it('H1 — gleiche Version, anderer Inhalt: Konflikt, die lokale Fassung bleibt', () => {
    const local = { ...eintrag({ physicalFiled: true }), sync: syncMeta(2) };
    const remote = eintrag({ folderId: 'anderer-ordner' });

    const merged = mergePaperRegisterEntriesFromPull([local], [zeile(remote, 2)], DEVICE, WORKSPACE);

    expect(merged.conflicts).toEqual(['paper_register_entry:paper-reg-doc-1']);
    expect(merged.entries[0]).toBe(local);
  });

  it('H2 — offene lokale Änderung gegen abweichende neuere Serverfassung: Konflikt', () => {
    const local = { ...eintrag({ physicalFiled: true }), sync: syncMeta(1) };
    const remote = eintrag({ register: 'Anderes Register' });

    const merged = mergePaperRegisterEntriesFromPull(
      [local],
      [zeile(remote, 3)],
      DEVICE,
      WORKSPACE,
      new Set(['paper-reg-doc-1']),
    );

    expect(merged.conflicts).toEqual(['paper_register_entry:paper-reg-doc-1']);
    expect(merged.entries[0]?.physicalFiled).toBe(true);
    expect(merged.entries[0]?.sync?.version).toBe(1);
  });

  it('H3 — offene Änderung, Server trägt dieselbe Fassung höher: nur die Version wird übernommen', () => {
    const local = { ...eintrag({ physicalFiled: true }), sync: syncMeta(1) };

    const merged = mergePaperRegisterEntriesFromPull(
      [local],
      [zeile(eintrag({ physicalFiled: true }), 2)],
      DEVICE,
      WORKSPACE,
      new Set(['paper-reg-doc-1']),
    );

    expect(merged.conflicts).toEqual([]);
    expect(merged.entries[0]?.sync?.version).toBe(2);
  });

  it('H4 — ohne offene Änderung gewinnt die neuere Serverfassung', () => {
    const local = { ...eintrag(), sync: syncMeta(1) };

    const merged = mergePaperRegisterEntriesFromPull(
      [local],
      [zeile(eintrag({ physicalFiled: true }), 2)],
      DEVICE,
      WORKSPACE,
    );

    expect(merged.conflicts).toEqual([]);
    expect(merged.entries[0]?.physicalFiled).toBe(true);
    expect(merged.entries[0]?.sync?.version).toBe(2);
  });
});

describe('S1-I — Wiederanlauf und Idempotenz', () => {
  it('I1 — verlorene Bestätigung beim Anlegen: die Serverzeile wird zur Basis, nicht zum Konflikt', () => {
    const local = eintrag({ physicalFiled: true });

    const plan = planPaperRegisterEntryLostAckAdoption(
      [local],
      [zeile(local, 1)],
      new Set(['paper-reg-doc-1']),
    );

    expect(plan.adopt).toEqual(['paper-reg-doc-1']);
    expect(plan.baseVersions.get('paper-reg-doc-1')).toBe(1);
  });

  it('I2 — der Nachtrag ist idempotent: was oben ist, wird nicht erneut eingereiht', () => {
    const local = { ...eintrag(), sync: syncMeta(1) };
    expect(planPaperRegisterEntryBackfill([local], [zeile(local, 1)])).toEqual([]);
    expect(planPaperRegisterEntryBackfill([local], [])).toEqual(['paper-reg-doc-1']);
  });

  it('I3 — zwei Abgleiche hintereinander erzeugen keinen zweiten Auftrag', () => {
    hydrateDocumentStore([dokument()]);
    speicher([eintrag({ physicalFiled: true })]);

    mergeRemoteWorkspacePullIntoState(buildPersistedStateSnapshot(), pullMit([]));
    mergeRemoteWorkspacePullIntoState(buildPersistedStateSnapshot(), pullMit([]));

    expect(papierAuftraege()).toHaveLength(1);
  });
});

describe('S1-J — Grabstein', () => {
  it('J1 — Dokument löschen: Grabstein mit erhaltener Serverversion und Löschauftrag', () => {
    const result = importInboxDocumentForTests(
      createAuftragInboxItem({
        id: 'inbox-s1-j1',
        title: 'Freistellungsbescheinigung §48b',
        documentType: 'behoerde',
        classifiedKind: 'freistellungsbescheinigung',
        sender: 'Finanzamt Musterstadt',
      }),
      'Muster GmbH',
    );
    if (!result.success) throw new Error('Import fehlgeschlagen');
    const docId = result.document.id;
    // Wie nach einem bestätigten Versand: Version 3.
    const snapshot = buildPersistedStateSnapshot().officePilotMemory!;
    hydrateMemory({
      ...snapshot,
      paperRegisterEntries: snapshot.paperRegisterEntries.map((entry) =>
        entry.documentId === docId ? { ...entry, sync: syncMeta(3) } : entry,
      ),
    });
    persistAll();
    resetSyncOutboxForTests([]);

    expect(deleteDocument(docId).success).toBe(true);

    const grabstein = buildPersistedStateSnapshot().officePilotMemory!.paperRegisterEntries.find(
      (entry) => entry.documentId === docId,
    );
    expect(grabstein?.sync?.deleted).toBe(true);
    expect(grabstein?.sync?.version, 'nicht hochgezählt').toBe(3);
    expect(getPaperRegisterEntryForDocument(docId)).toBeUndefined();
    expect(papierAuftraege()).toEqual([
      expect.objectContaining({ entityId: `paper-reg-${docId}`, operation: 'delete' }),
    ]);
  });

  it('J2 — ein Grabstein aus der Cloud entfernt den Eintrag, und nichts lädt ihn wieder hoch', () => {
    hydrateDocumentStore([dokument()]);
    speicher([{ ...eintrag({ physicalFiled: true }), sync: syncMeta(2) }]);

    const merged = mergeRemoteWorkspacePullIntoState(
      buildPersistedStateSnapshot(),
      pullMit([zeile(eintrag({ physicalFiled: true }), 3, true)]),
    );

    expect(merged.conflicts).toEqual([]);
    expect(merged.state.officePilotMemory?.paperRegisterEntries).toEqual([]);
    expect(papierAuftraege()).toEqual([]);
    hydrateMemory(merged.state.officePilotMemory!);
    expect(getPhysicalFilingForDocument('doc-1').physicalFiled).toBe(false);
  });

  it('J3 — eine ungesendete lokale Änderung wird von einem Grabstein nicht still verworfen', () => {
    const local = { ...eintrag({ physicalFiled: true }), sync: syncMeta(2) };

    const merged = mergePaperRegisterEntriesFromPull(
      [local],
      [zeile(eintrag(), 3, true)],
      DEVICE,
      WORKSPACE,
      new Set(['paper-reg-doc-1']),
    );

    expect(merged.conflicts).toEqual(['paper_register_entry:paper-reg-doc-1']);
    expect(merged.entries).toEqual([local]);
  });
});

/* ------------------------------------------------------------------ */
/* L/M — Reload und Anzeige                                            */
/* ------------------------------------------------------------------ */

describe('S1-L/M — Reload und Anzeige', () => {
  it('L1 — nach Speichern und erneutem Laden ist der Haken mit Serverversion da', () => {
    hydrateDocumentStore([dokument()]);
    speicher([{ ...eintrag({ physicalFiled: true, filedAt: UPDATED_AT }), sync: syncMeta(2) }]);
    persistAll();

    resetMemory();
    hydrateDocumentStore([]);
    const geladen = loadPersistedState();
    expect(geladen).not.toBeNull();
    applyStateToStores(geladen!);

    const entry = getPaperRegisterEntryForDocument('doc-1');
    expect(entry?.physicalFiled).toBe(true);
    expect(entry?.sync?.version).toBe(2);
    expect(getDocumentById('doc-1')).toBeDefined();
  });

  it('M1 — das Gedächtnis sagt „nicht abgeheftet", der Eintrag aus der Cloud „abgeheftet": es gilt der Eintrag', () => {
    hydrateDocumentStore([dokument()]);
    speicher(
      [{ ...eintrag({ physicalFiled: true, filedAt: UPDATED_AT }), sync: syncMeta(2) }],
      [gedaechtnis({ physicalFiled: false })],
    );

    const html = render('doc-1');

    expect(html).toContain(t('document.filing.statusFiled', 'de'));
    expect(html).not.toContain('data-testid="document-filing-mark-filed"');
  });

  it('M2 — frisches Gerät ohne Gedächtnis: der Haken aus der Cloud erscheint', () => {
    hydrateDocumentStore([dokument()]);
    speicher([{ ...eintrag({ physicalFiled: true, filedAt: UPDATED_AT }), sync: syncMeta(1) }]);

    const html = render('doc-1');

    expect(html).toContain(t('document.filing.statusFiled', 'de'));
    expect(html).not.toContain('data-testid="document-filing-mark-filed"');
  });

  it('M3 — ohne Haken bleibt der Knopf, und Abheften wirkt ohne Gedächtnis', () => {
    hydrateDocumentStore([dokument()]);

    expect(render('doc-1')).toContain('data-testid="document-filing-mark-filed"');
    markDocumentPhysicallyFiled('doc-1', undefined, dokument());
    expect(render('doc-1')).not.toContain('data-testid="document-filing-mark-filed"');
  });

  it('M5 — Gerät ohne Gedächtnis: Ordner und Register aus derselben Quelle, der Haken aus der Cloud', () => {
    // Im Produkt beobachtet: Das archivierende Gerät legte den Eintrag nach seiner
    // Papierregel an (Sonstiges/A), das Dokument selbst nennt einen anderen Ordner.
    hydrateDocumentStore([
      dokument({ paperFolder: { folderId: 'folder-5', register: 'Finanzamt', label: 'Behörden & Versicherungen' } }),
    ]);
    speicher([
      { ...eintrag({ folderId: 'paper-sonstiges', register: 'A', physicalFiled: true, filedAt: UPDATED_AT }), sync: syncMeta(2) },
    ]);

    const html = render('doc-1');

    expect(html).toContain(t('document.filing.statusFiled', 'de'));
    expect(html).toContain('detail-experience-section__value">Finanzamt</p>');
    // Kein Register aus einer anderen Quelle neben dem Ordner des Dokuments.
    expect(html).not.toContain('detail-experience-section__value">A</p>');
  });

  it('M4 — Altbestand ohne Eintrag: das Gedächtnis gilt weiter, nichts geht verloren', () => {
    hydrateDocumentStore([dokument()]);
    speicher([], [gedaechtnis({ physicalFiled: true, filedAt: UPDATED_AT })]);

    expect(getPhysicalFilingForDocument('doc-1')).toMatchObject({ physicalFiled: true, filedAt: UPDATED_AT });
    expect(render('doc-1')).toContain(t('document.filing.statusFiled', 'de'));
  });
});
