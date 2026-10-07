/**
 * CLOUD-SYNC S2 — der Kommunikationsverlauf wird Workspace-Wahrheit.
 *
 * Geprüft wird der Weg auf der Client-Seite: Entstehen des Ereignisses,
 * Sendeauftrag, Payload, Versand über den bestehenden Dispatcher, Abzug,
 * Vereinigung ohne Duplikat, Konfliktvertrag, Altbestand, Reihenfolge,
 * Kontext, Reload und die Anzeige. Die Serverseite (Replay, Struktur,
 * Isolation, Rollen, RLS) prüft `supabase/tests/communication_events_s2.sql`
 * gegen eine echte Datenbank.
 *
 * Der Typ ist freigegeben, seit die Migration 20261031120000 remote angewendet
 * ist. Wo ein Test das Verhalten bei zurückgenommener Freigabe prüft, wird sie
 * hier ausdrücklich ausgeschaltet — der Schalter bleibt der Notausschalter.
 *
 * Neutrale Beispieldaten.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommunicationEvent } from '../../types/communicationHistory';
import type { CommunicationContextRef } from '../../types/communication';
import type { SyncMeta, SyncOutboxEntry } from '../../types/sync';
import {
  buildCommunicationEventCloudContentKey,
  buildCommunicationEventCloudPushPayload,
  mergeCommunicationEventsFromPull,
  planCommunicationEventBackfill,
  stripCommunicationEventForCloud,
  type WorkspaceCommunicationEventRow,
} from './communicationEventCloudService';
import {
  getCommunicationEvents,
  getCommunicationHistorySnapshot,
  getCommunicationReplyStatus,
  getEventsForContext,
  hydrateCommunicationHistory,
  recordMarkedAnswered,
  recordMarkedNoReplyNeeded,
} from '../communicationHistoryService';
import { deleteDocument, hydrateDocumentStore } from '../documentService';
import {
  applyStateToStores,
  buildPersistedStateSnapshot,
  loadPersistedState,
  persistAll,
} from '../persistenceService';
import { enqueueSyncOutbox, getSyncOutboxSnapshot, resetSyncOutboxForTests } from '../sync/syncOutboxService';
import { resetSyncChangeTrackerForTests } from '../sync/syncChangeTrackerService';
import { createSyncClient, resetSyncClientForTests } from '../sync/syncClientService';
import * as allowlist from '../sync/cloudSyncAllowlist';
import { SupabaseSyncAdapter } from '../sync/supabaseSyncAdapter';
import * as workspaceCloudService from '../workspace/workspaceCloudService';
import { mergeRemoteWorkspacePullIntoState } from '../workspace/workspaceProvisioningService';
import { extractCloudSyncEntity } from '../workspace/workspaceSyncPayloadService';
import * as supabaseLib from '../../lib/supabase';
import { resetMemory } from '../officePilotMemoryService';
import { AppProvider } from '../../context/AppContext';
import { DEFAULT_SETUP } from '../../data/mockData';
import { CommunicationHistoryPanel } from '../../components/communication/CommunicationHistoryPanel';
import { t } from '../../i18n';

const WORKSPACE = 'ws-comm-s2';
const DEVICE = 'device-comm-s2';
const UPDATED_AT = '2026-10-05T09:30:00.000Z';
const DOKUMENT: CommunicationContextRef = { type: 'document', id: 'doc-1' };

function syncMeta(version: number, overrides: Partial<SyncMeta> = {}): SyncMeta {
  return { updatedAt: UPDATED_AT, version, deleted: false, deviceId: DEVICE, workspaceId: WORKSPACE, ...overrides };
}

function ereignis(overrides: Partial<CommunicationEvent> = {}): CommunicationEvent {
  return {
    id: 'comm-evt-1',
    timestamp: '2026-10-05T09:00:00.000Z',
    type: 'marked_answered',
    contextRef: DOKUMENT,
    status: 'complete',
    resultExcerpt: 'Als erledigt markiert',
    disclaimerShown: false,
    ...overrides,
  };
}

function zeile(base: CommunicationEvent, rowVersion = 1): WorkspaceCommunicationEventRow {
  return {
    workspace_id: WORKSPACE,
    client_event_id: base.id,
    context_type: base.contextRef.type,
    context_id: base.contextRef.id ?? null,
    context_vorgang_id: base.contextRef.vorgangId ?? null,
    event_type: base.type,
    event_at: base.timestamp,
    payload: stripCommunicationEventForCloud(base) as unknown as Record<string, unknown>,
    row_version: rowVersion,
    updated_at: UPDATED_AT,
  };
}

function pullMit(rows: WorkspaceCommunicationEventRow[]) {
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
    communicationEvents: rows,
  } as unknown as Parameters<typeof mergeRemoteWorkspacePullIntoState>[1];
}

/** Die Freigabe zurücknehmen — der Schalter als Notausschalter. */
function freigabeZuruecknehmen(): void {
  vi.spyOn(allowlist, 'isSupabaseSyncAllowed').mockImplementation(
    (type) => type !== 'communication_event' && allowlist.SUPABASE_SYNC_ALLOWLIST.has(type),
  );
}

function ereignisAuftraege(): SyncOutboxEntry[] {
  return getSyncOutboxSnapshot().filter(
    (entry) => entry.entityType === 'communication_event' && entry.status !== 'completed',
  );
}

function render(contextRef: CommunicationContextRef): string {
  return renderToStaticMarkup(
    createElement(
      MemoryRouter,
      null,
      createElement(AppProvider, { initialSetup: DEFAULT_SETUP }, createElement(CommunicationHistoryPanel, { contextRef })),
    ),
  );
}

beforeEach(() => {
  localStorage.clear();
  hydrateCommunicationHistory([]);
  hydrateDocumentStore([]);
  resetMemory();
  resetSyncOutboxForTests([]);
  resetSyncChangeTrackerForTests();
  resetSyncClientForTests({ ...createSyncClient(), deviceId: DEVICE, workspaceId: WORKSPACE, serverWorkspaceId: WORKSPACE });
});

afterEach(() => {
  vi.restoreAllMocks();
});

/* ------------------------------------------------------------------ */
/* A–D — Ereignis, Kennung, Sendeauftrag, Payload                       */
/* ------------------------------------------------------------------ */

describe('S2-A–D — das Ereignis entsteht und geht in die Warteschlange', () => {
  it('A/B — ein Ereignis entsteht mit stabiler Kennung, Zeit und Kontext', () => {
    const event = recordMarkedAnswered(DOKUMENT, 'Rückfrage vom Kunden');

    expect(event?.id).toMatch(/^comm-evt-[0-9a-f-]{36}$/);
    expect(Number.isNaN(Date.parse(event!.timestamp))).toBe(false);
    expect(event?.contextRef).toEqual(DOKUMENT);
    expect(getEventsForContext(DOKUMENT).map((e) => e.id)).toEqual([event!.id]);
  });

  it('C — genau ein Sendeauftrag communication_event für genau dieses Ereignis', () => {
    persistAll(); // Grundlinie des Änderungsverfolgers
    resetSyncOutboxForTests([]);

    const event = recordMarkedAnswered(DOKUMENT);

    expect(ereignisAuftraege()).toEqual([
      expect.objectContaining({ entityType: 'communication_event', entityId: event!.id, operation: 'create' }),
    ]);
  });

  it('C2 — eine zurückgeschriebene Serverversion löst keinen neuen Auftrag aus', () => {
    hydrateCommunicationHistory([{ ...ereignis(), sync: syncMeta(1) }]);
    persistAll();
    resetSyncOutboxForTests([]);

    hydrateCommunicationHistory([{ ...ereignis(), sync: syncMeta(1, { updatedAt: '2026-10-05T11:00:00.000Z' }) }]);
    persistAll();

    expect(ereignisAuftraege()).toEqual([]);
  });

  it('D — der Payload trägt Kennung, Kontext, Art, Zeit und nur die fachlichen Felder', () => {
    const event: CommunicationEvent = {
      ...ereignis({ channel: 'email', intent: 'document_reply', contextRef: { type: 'invoice', id: 'inv-9', vorgangId: 'v-3' } }),
      sync: syncMeta(4),
    };

    const push = buildCommunicationEventCloudPushPayload(event);

    expect(push).toEqual({
      event_id: 'comm-evt-1',
      context_type: 'invoice',
      context_id: 'inv-9',
      context_vorgang_id: 'v-3',
      event_type: 'marked_answered',
      event_at: '2026-10-05T09:00:00.000Z',
      payload: {
        id: 'comm-evt-1',
        timestamp: '2026-10-05T09:00:00.000Z',
        type: 'marked_answered',
        contextRef: { type: 'invoice', id: 'inv-9', vorgangId: 'v-3' },
        status: 'complete',
        disclaimerShown: false,
        intent: 'document_reply',
        channel: 'email',
        resultExcerpt: 'Als erledigt markiert',
      },
    });
    // Kein Grabstein-Flag, keine Cloud-Metadaten.
    expect(push).not.toHaveProperty('deleted');
    expect(JSON.stringify(push)).not.toContain('"sync"');
  });
});

/* ------------------------------------------------------------------ */
/* E/F/O — Freigabe, Versand, nur der eigene Betrieb                    */
/* ------------------------------------------------------------------ */

describe('S2-E/F/O — Versand über den bestehenden Dispatcher', () => {
  it('E — nach der Remote-Migration ist der Typ freigegeben und nicht mehr nur-lokal', () => {
    expect(allowlist.isSupabaseSyncAllowed('communication_event')).toBe(true);
    expect(allowlist.LOCAL_ONLY_SYNC_ENTITY_TYPES.has('communication_event')).toBe(false);
  });

  it('F/O — mit Freigabe geht das Ereignis über upsert_workspace_sync_entity, nur in den eigenen Betrieb', async () => {
    vi.spyOn(supabaseLib, 'isSupabaseConfigured').mockReturnValue(true);
    const upsert = vi
      .spyOn(workspaceCloudService, 'rpcUpsertWorkspaceSyncEntity')
      .mockResolvedValue({ rowVersion: 1, payload: {}, entityId: null, deduped: false });
    const adapter = new SupabaseSyncAdapter(null);
    vi.spyOn(adapter as unknown as { assertClient: () => unknown }, 'assertClient').mockReturnValue({});

    const event = ereignis();
    hydrateCommunicationHistory([event]);
    const auftrag = enqueueSyncOutbox({ entityType: 'communication_event', entityId: event.id, operation: 'create', version: 0 });
    persistAll();

    const result = await adapter.pushChanges({
      deviceId: DEVICE,
      workspaceId: WORKSPACE,
      state: buildPersistedStateSnapshot(),
      outbox: [auftrag],
    });

    expect(result.failedOutbox).toEqual([]);
    expect(result.completedOutboxIds).toEqual([auftrag.id]);
    const [workspaceId, entityType, payload] = upsert.mock.calls[0]!;
    expect(workspaceId).toBe(WORKSPACE);
    expect(entityType).toBe('communication_event');
    expect(payload).toEqual(buildCommunicationEventCloudPushPayload(event));
    const gespeichert = result.state.communicationHistory?.find((e) => e.id === event.id);
    expect(gespeichert?.sync?.version).toBe(1);
    expect(gespeichert?.resultExcerpt).toBe('Als erledigt markiert');
  });

  it('T — ein Ereignis kennt keinen Grabstein: die Extraktion meldet nie „gelöscht"', () => {
    hydrateCommunicationHistory([{ ...ereignis(), sync: syncMeta(2, { deleted: true }) }]);
    const extracted = extractCloudSyncEntity(buildPersistedStateSnapshot(), 'communication_event', 'comm-evt-1');
    expect(extracted?.entityType).toBe('communication_event');
    expect(extracted && 'deleted' in extracted ? extracted.deleted : null).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* G–N — Abzug, Vereinigung, Konflikt, Altbestand, Reihenfolge, Kontext */
/* ------------------------------------------------------------------ */

describe('S2-G/H/I — Abzug und Vereinigung ohne Duplikat', () => {
  it('H — ein Ereignis aus der Cloud kommt vollständig mit Serverversion an', () => {
    const remote = ereignis({ channel: 'whatsapp', type: 'draft_copied', userInputExcerpt: 'Termin verschieben' });

    const merged = mergeCommunicationEventsFromPull([], [zeile(remote, 1)], DEVICE, WORKSPACE);

    expect(merged.conflicts).toEqual([]);
    expect(merged.events).toEqual([
      expect.objectContaining({
        id: 'comm-evt-1',
        type: 'draft_copied',
        channel: 'whatsapp',
        userInputExcerpt: 'Termin verschieben',
        contextRef: DOKUMENT,
        sync: expect.objectContaining({ version: 1, workspaceId: WORKSPACE }),
      }),
    ]);
  });

  it('G — dasselbe Ereignis lokal und in der Cloud ist eines: kein Duplikat, nur die Serverversion', () => {
    const lokal = { ...ereignis(), sync: syncMeta(0) };

    const merged = mergeCommunicationEventsFromPull([lokal], [zeile(ereignis(), 1)], DEVICE, WORKSPACE);

    expect(merged.conflicts).toEqual([]);
    expect(merged.events).toHaveLength(1);
    expect(merged.events[0]?.sync?.version).toBe(1);
  });

  it('I — Vereinigung: lokale Ereignisse bleiben, Cloud-Ereignisse kommen dazu', () => {
    const lokal = ereignis({ id: 'comm-evt-lokal', timestamp: '2026-10-05T10:00:00.000Z' });
    const remote = ereignis({ id: 'comm-evt-cloud', timestamp: '2026-10-05T08:00:00.000Z' });

    const merged = mergeCommunicationEventsFromPull([lokal], [zeile(remote)], DEVICE, WORKSPACE);

    expect(merged.events.map((e) => e.id)).toEqual(['comm-evt-lokal', 'comm-evt-cloud']);
  });

  it('J — dieselbe Kennung mit anderem Inhalt ist ein Konflikt: das lokale Ereignis bleibt', () => {
    const lokal = { ...ereignis(), sync: syncMeta(1) };

    const merged = mergeCommunicationEventsFromPull(
      [lokal],
      [zeile(ereignis({ resultExcerpt: 'anders' }), 1)],
      DEVICE,
      WORKSPACE,
    );

    expect(merged.conflicts).toEqual(['communication_event:comm-evt-1']);
    expect(merged.events).toEqual([lokal]);
  });

  it('G2 — Abgleich im Provisioning: das gepullte Ereignis erzeugt keinen Rücksendeauftrag', () => {
    const merged = mergeRemoteWorkspacePullIntoState(buildPersistedStateSnapshot(), pullMit([zeile(ereignis())]));

    expect(merged.conflicts).toEqual([]);
    expect(merged.state.communicationHistory?.map((e) => e.id)).toEqual(['comm-evt-1']);
    expect(ereignisAuftraege()).toEqual([]);
  });
});

describe('S2-K/L — Altbestand', () => {
  it('K — lokale Ereignisse ohne Cloudzeile werden einmal als Anlage eingereiht', () => {
    hydrateCommunicationHistory([
      ereignis({ id: 'comm-evt-alt-1', timestamp: '2026-09-01T08:00:00.000Z' }),
      ereignis({ id: 'comm-evt-alt-2', timestamp: '2026-09-02T08:00:00.000Z' }),
    ]);

    mergeRemoteWorkspacePullIntoState(buildPersistedStateSnapshot(), pullMit([]));

    expect(ereignisAuftraege().map((e) => [e.entityId, e.operation]).sort()).toEqual([
      ['comm-evt-alt-1', 'create'],
      ['comm-evt-alt-2', 'create'],
    ]);
  });

  it('L — idempotent: was oben ist, wird nicht erneut eingereiht; zwei Abgleiche, ein Auftrag', () => {
    const lokal = { ...ereignis(), sync: syncMeta(1) };
    expect(planCommunicationEventBackfill([lokal], [zeile(lokal)])).toEqual([]);
    expect(planCommunicationEventBackfill([lokal], [])).toEqual(['comm-evt-1']);

    hydrateCommunicationHistory([ereignis()]);
    mergeRemoteWorkspacePullIntoState(buildPersistedStateSnapshot(), pullMit([]));
    mergeRemoteWorkspacePullIntoState(buildPersistedStateSnapshot(), pullMit([]));
    expect(ereignisAuftraege()).toHaveLength(1);
  });

  it('K2 — mit zurückgenommener Freigabe kein Nachtrag: die Warteschlange läuft nicht bei jedem Abzug voll', () => {
    freigabeZuruecknehmen();
    hydrateCommunicationHistory([ereignis()]);

    const merged = mergeRemoteWorkspacePullIntoState(buildPersistedStateSnapshot(), pullMit([zeile(ereignis({ id: 'comm-evt-x' }))]));

    expect(ereignisAuftraege()).toEqual([]);
    // Ohne Freigabe wird auch nichts aus der Cloud eingemischt.
    expect(merged.state.communicationHistory?.map((e) => e.id)).toEqual(['comm-evt-1']);
  });
});

describe('S2-M/N — Reihenfolge und Kontext', () => {
  it('M — nach dem Abgleich steht das jüngste Ereignis vorn, die Anzeige bleibt zeitlich', () => {
    hydrateCommunicationHistory([ereignis({ id: 'comm-evt-mitte', timestamp: '2026-10-05T10:00:00.000Z' })]);
    const merged = mergeRemoteWorkspacePullIntoState(
      buildPersistedStateSnapshot(),
      pullMit([
        zeile(ereignis({ id: 'comm-evt-frueh', timestamp: '2026-10-05T08:00:00.000Z' })),
        zeile(ereignis({ id: 'comm-evt-spaet', timestamp: '2026-10-05T12:00:00.000Z' })),
      ]),
    );
    hydrateCommunicationHistory(merged.state.communicationHistory ?? []);

    expect(getCommunicationHistorySnapshot().map((e) => e.id)).toEqual(['comm-evt-spaet', 'comm-evt-mitte', 'comm-evt-frueh']);
    expect(getCommunicationEvents().map((e) => e.id)).toEqual(['comm-evt-spaet', 'comm-evt-mitte', 'comm-evt-frueh']);
  });

  it('M2 — das jüngste Ereignis aus der Cloud zählt: der Antwortstatus folgt ihm', () => {
    hydrateCommunicationHistory([ereignis({ id: 'comm-evt-alt', type: 'draft_created', timestamp: '2026-10-05T08:00:00.000Z' })]);
    const merged = mergeCommunicationEventsFromPull(
      getCommunicationHistorySnapshot(),
      [
        zeile(
          ereignis({
            id: 'comm-evt-neu',
            type: 'marked_no_reply_needed',
            resultExcerpt: 'Kein Antwortbedarf',
            timestamp: '2026-10-05T12:00:00.000Z',
          }),
        ),
      ],
      DEVICE,
      WORKSPACE,
    );
    hydrateCommunicationHistory(merged.events);

    expect(getCommunicationReplyStatus(DOKUMENT)).toBe('no_reply_needed');
    // Dieselbe Markierung direkt danach ist keine neue Information.
    expect(recordMarkedNoReplyNeeded(DOKUMENT)).toBeNull();
  });

  it('N — der Kontext reist vollständig mit, auch die Rechnung mit Auftragsbezug', () => {
    const rechnung: CommunicationContextRef = { type: 'invoice', id: 'inv-4', vorgangId: 'v-2' };
    const merged = mergeCommunicationEventsFromPull(
      [],
      [zeile(ereignis({ contextRef: rechnung })), zeile(ereignis({ id: 'comm-evt-2', contextRef: { type: 'vorgang', id: 'v-2' } }))],
      DEVICE,
      WORKSPACE,
    );
    hydrateCommunicationHistory(merged.events);

    expect(getEventsForContext(rechnung).map((e) => e.id)).toEqual(['comm-evt-1']);
    expect(getEventsForContext({ type: 'invoice', id: 'inv-4', vorgangId: 'anders' })).toEqual([]);
    expect(getEventsForContext({ type: 'vorgang', id: 'v-2' }).map((e) => e.id)).toEqual(['comm-evt-2']);
  });
});

/* ------------------------------------------------------------------ */
/* Q/R/S/T — Reload, Anzeige, keine Doppelwahrheit, kein Löschen        */
/* ------------------------------------------------------------------ */

describe('S2-Q/R/S/T — Reload, Anzeige und Abgrenzung', () => {
  it('Q — nach Speichern und erneutem Laden: dieselben Kennungen, dieselbe Reihenfolge', () => {
    hydrateCommunicationHistory([
      { ...ereignis({ id: 'comm-evt-b', timestamp: '2026-10-05T11:00:00.000Z' }), sync: syncMeta(1) },
      { ...ereignis({ id: 'comm-evt-a', timestamp: '2026-10-05T09:00:00.000Z' }), sync: syncMeta(1) },
    ]);
    persistAll();

    hydrateCommunicationHistory([]);
    const geladen = loadPersistedState();
    expect(geladen).not.toBeNull();
    applyStateToStores(geladen!);

    expect(getCommunicationEvents().map((e) => [e.id, e.sync?.version])).toEqual([
      ['comm-evt-b', 1],
      ['comm-evt-a', 1],
    ]);
  });

  it('R — die Anzeige zeigt ein Ereignis aus der Cloud mit Zeit, Art und Kontext', () => {
    const merged = mergeCommunicationEventsFromPull(
      [],
      [zeile(ereignis({ type: 'marked_answered', resultExcerpt: 'Als erledigt markiert' }))],
      DEVICE,
      WORKSPACE,
    );
    hydrateCommunicationHistory(merged.events);

    const html = render(DOKUMENT);

    expect(html.match(/data-testid="communication-history-item"/g) ?? []).toHaveLength(1);
    expect(html).toContain(t('communication.history.type.marked_answered', 'de'));
    expect(html).toContain('Als erledigt markiert');
    expect(html).toContain(t('communication.context.document', 'de'));
  });

  it('S — Versand und E-Mail erzeugen keine Kommunikationsereignisse: keine zweite Wahrheit', () => {
    const wurzel = resolve(__dirname, '..');
    for (const datei of [
      'delivery/deliveryCommunicationHistory.ts',
      'delivery/sendDocumentOrchestrator.ts',
      'delivery/documentDeliveryCloudService.ts',
    ]) {
      const quelle = readFileSync(resolve(wurzel, datei), 'utf8');
      expect(quelle, datei).not.toContain('communicationHistoryService');
      expect(quelle, datei).not.toContain('addCommunicationEvent');
    }
    const transport = readFileSync(resolve(__dirname, 'communicationEventCloudService.ts'), 'utf8');
    expect(transport).not.toMatch(/import[^;]+delivery/);
  });

  it('T2 — das Löschen eines Dokuments vernichtet seinen Kommunikationsverlauf nicht', () => {
    hydrateDocumentStore([
      {
        id: 'doc-1',
        title: 'Anfrage',
        category: 'sonstiges',
        issuer: 'Muster GmbH',
        recognizedText: '',
        issueDate: null,
        validUntil: null,
        digitalFolder: { id: 'd', name: 'Dokumente', path: '/Dokumente/' },
        paperFolder: { folderId: 'paper-sonstiges', register: 'A', label: 'Sonstiges' },
        tags: [],
        linkedCompany: '',
        linkedVorgang: null,
        archived: true,
        createdAt: '2026-10-05T08:00:00.000Z',
      },
    ]);
    hydrateCommunicationHistory([ereignis()]);

    expect(deleteDocument('doc-1').success).toBe(true);

    expect(getCommunicationHistorySnapshot().map((e) => e.id)).toEqual(['comm-evt-1']);
  });

  it('D2 — der Inhaltsschlüssel kennt keine Serverversion, aber jede fachliche Angabe', () => {
    const a = { ...ereignis(), sync: syncMeta(1) };
    const b = { ...ereignis(), sync: syncMeta(5, { deviceId: 'anderes-geraet' }) };
    expect(buildCommunicationEventCloudContentKey(a)).toBe(buildCommunicationEventCloudContentKey(b));
    expect(buildCommunicationEventCloudContentKey(a)).not.toBe(
      buildCommunicationEventCloudContentKey({ ...a, contextRef: { type: 'document', id: 'doc-2' } }),
    );
  });
});
