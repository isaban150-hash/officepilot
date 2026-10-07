/**
 * CLOUD-SYNC S3 — bestätigtes Wissen wird Workspace-Wahrheit.
 *
 * Geprüft wird der ganze Weg auf der Client-Seite: Anlegen, Ändern,
 * Deaktivieren und Löschen eines Eintrags, Sendeauftrag, Payload, Versand über
 * den bestehenden Dispatcher, Abzug, Abgleich mit Konfliktvertrag, Altbestand,
 * Wiederanlauf, Grabstein, Reload, die Wissen-Seite und die beiden Lesepfade
 * der KI (Kommunikationskontext und Brain-Snapshot). Die Serverseite (Version,
 * Rechte, Isolation, RLS) prüft `supabase/tests/knowledge_facts_s3.sql` gegen
 * eine echte Datenbank.
 *
 * Der Typ ist freigegeben, seit die Migration 20261101120000 remote angewendet
 * ist. Wo ein Test das Verhalten bei zurückgenommener Freigabe prüft, wird sie
 * hier ausdrücklich ausgeschaltet — der Schalter bleibt der Notausschalter.
 *
 * Neutrale Beispieldaten.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import type { SupabaseClient } from '@supabase/supabase-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { KnowledgeFact } from '../../types/knowledge';
import type { SyncMeta, SyncOutboxEntry } from '../../types/sync';
import {
  buildKnowledgeFactCloudContentKey,
  buildKnowledgeFactCloudPushPayload,
  mergeKnowledgeFactsFromPull,
  planKnowledgeFactBackfill,
  planKnowledgeFactLostAckAdoption,
  stripKnowledgeFactForCloud,
  type WorkspaceKnowledgeFactRow,
} from './knowledgeFactCloudService';
import {
  addKnowledgeFact,
  deleteKnowledgeFact,
  getKnowledgeFacts,
  getKnowledgeSnapshot,
  hydrateKnowledgeFacts,
  resetKnowledgeFacts,
  updateKnowledgeFact,
} from '../knowledgeService';
import { buildCommunicationContext } from '../communicationContextService';
import { buildBrainSnapshot } from '../brain/brainSnapshotService';
import { hydrateCommunicationHistory } from '../communicationHistoryService';
import { hydrateDocumentStore } from '../documentService';
import { resetMemory } from '../officePilotMemoryService';
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
import { AppProvider } from '../../context/AppContext';
import { DEFAULT_SETUP } from '../../data/mockData';
import { WissenPage } from '../../pages/WissenPage';

const WORKSPACE = 'ws-knowledge-s3';
const DEVICE = 'device-knowledge-s3';
const UPDATED_AT = '2026-10-06T09:00:00.000Z';

function syncMeta(version: number, overrides: Partial<SyncMeta> = {}): SyncMeta {
  return { updatedAt: UPDATED_AT, version, deleted: false, deviceId: DEVICE, workspaceId: WORKSPACE, ...overrides };
}

function fakt(overrides: Partial<KnowledgeFact> = {}): KnowledgeFact {
  return {
    id: 'knowledge-1',
    scope: 'company',
    category: 'communication_preference',
    key: 'angebote_per_e_mail',
    value: 'Angebote per E-Mail',
    displayText: 'Angebote gehen per E-Mail hinaus',
    sourceType: 'user',
    confirmedAt: '2026-10-06T08:00:00.000Z',
    createdAt: '2026-10-06T08:00:00.000Z',
    active: true,
    ...overrides,
  };
}

function zeile(base: KnowledgeFact, rowVersion: number, deleted = false): WorkspaceKnowledgeFactRow {
  return {
    workspace_id: WORKSPACE,
    client_fact_id: base.id,
    scope: base.scope,
    scope_id: base.scopeId ?? null,
    category: base.category,
    active: deleted ? false : base.active,
    payload: stripKnowledgeFactForCloud(base) as unknown as Record<string, unknown>,
    row_version: rowVersion,
    deleted,
    deleted_at: deleted ? UPDATED_AT : null,
    updated_at: UPDATED_AT,
  };
}

function pullMit(rows: WorkspaceKnowledgeFactRow[]) {
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
    knowledgeFacts: rows,
  } as unknown as Parameters<typeof mergeRemoteWorkspacePullIntoState>[1];
}

/** Die Freigabe zurücknehmen — der Schalter als Notausschalter. */
function freigabeZuruecknehmen(): void {
  vi.spyOn(allowlist, 'isSupabaseSyncAllowed').mockImplementation(
    (type) => type !== 'knowledge_fact' && allowlist.SUPABASE_SYNC_ALLOWLIST.has(type),
  );
}

function wissensAuftraege(): SyncOutboxEntry[] {
  return getSyncOutboxSnapshot().filter(
    (entry) => entry.entityType === 'knowledge_fact' && entry.status !== 'completed',
  );
}

function abgleich(rows: WorkspaceKnowledgeFactRow[]) {
  return mergeRemoteWorkspacePullIntoState(buildPersistedStateSnapshot(), pullMit(rows));
}

function renderWissen(): string {
  return renderToStaticMarkup(
    createElement(
      MemoryRouter,
      null,
      createElement(AppProvider, { initialSetup: DEFAULT_SETUP }, createElement(WissenPage)),
    ),
  );
}

beforeEach(() => {
  localStorage.clear();
  resetKnowledgeFacts();
  resetMemory();
  hydrateCommunicationHistory([]);
  hydrateDocumentStore([]);
  resetSyncOutboxForTests([]);
  resetSyncChangeTrackerForTests();
  resetSyncClientForTests({ ...createSyncClient(), deviceId: DEVICE, workspaceId: WORKSPACE, serverWorkspaceId: WORKSPACE });
});

afterEach(() => {
  vi.restoreAllMocks();
});

/* ------------------------------------------------------------------ */
/* A — der Eintrag entsteht, ändert sich und wird gelöscht              */
/* ------------------------------------------------------------------ */

describe('S3-A — Anlegen, Ändern, Deaktivieren, Löschen', () => {
  it('A1 — Anlegen: stabile Kennung, vom Nutzer bestätigt, ohne erfundene Serverversion', () => {
    const result = addKnowledgeFact({
      scope: 'company',
      category: 'communication_preference',
      key: 'angebote_per_e_mail',
      value: 'Angebote per E-Mail',
      displayText: 'Angebote gehen per E-Mail hinaus',
    });
    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.fact.id).toMatch(/^knowledge-/);
    expect(result.fact).toMatchObject({ scope: 'company', sourceType: 'user', active: true });
    expect(result.fact.confirmedAt).toBeTruthy();
    // Keine Serverbestätigung, die es nicht gibt (SYNC-VERSION-CONTRACT-02).
    expect(result.fact.sync?.version ?? 0).toBe(0);
  });

  it('A2 — Ändern lässt die bestätigte Serverversion unberührt', () => {
    hydrateKnowledgeFacts([{ ...fakt(), sync: syncMeta(3) }]);

    const result = updateKnowledgeFact('knowledge-1', {
      value: 'Angebote per Post',
      displayText: 'Angebote gehen per Post hinaus',
    });

    expect(result.success).toBe(true);
    const fact = getKnowledgeFacts()[0];
    expect(fact?.displayText).toBe('Angebote gehen per Post hinaus');
    expect(fact?.updatedAt).toBeTruthy();
    expect(fact?.sync?.version, 'Die Version zählt nur der Server').toBe(3);
  });

  it('A3 — Deaktivieren ist eine Änderung, kein Löschen', () => {
    hydrateKnowledgeFacts([{ ...fakt(), sync: syncMeta(2) }]);

    expect(updateKnowledgeFact('knowledge-1', { active: false }).success).toBe(true);

    const fact = getKnowledgeFacts()[0];
    expect(fact?.active).toBe(false);
    expect(fact?.sync?.deleted).toBe(false);
    expect(fact?.sync?.version).toBe(2);
  });

  it('A4 — Löschen hinterlässt einen Grabstein mit erhaltener Serverversion', () => {
    hydrateKnowledgeFacts([{ ...fakt(), sync: syncMeta(3) }]);

    expect(deleteKnowledgeFact('knowledge-1').success).toBe(true);

    const grabstein = getKnowledgeSnapshot().find((fact) => fact.id === 'knowledge-1');
    expect(grabstein?.sync?.deleted).toBe(true);
    expect(grabstein?.sync?.version, 'nicht hochgezählt').toBe(3);
    expect(grabstein?.active).toBe(false);
    expect(getKnowledgeFacts()).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* B/C — Sendeauftrag und Payload                                      */
/* ------------------------------------------------------------------ */

describe('S3-B/C — Sendeauftrag und Payload', () => {
  it('B1 — Anlegen reiht genau einen Auftrag als Anlage ein', () => {
    persistAll(); // Grundlinie des Änderungsverfolgers
    resetSyncOutboxForTests([]);

    const result = addKnowledgeFact({
      scope: 'company',
      category: 'scheduling',
      key: 'termine_vormittags',
      value: 'vormittags',
      displayText: 'Termine bevorzugt vormittags',
    });
    if (!result.success) throw new Error('Anlegen fehlgeschlagen');

    expect(wissensAuftraege()).toEqual([
      expect.objectContaining({ entityType: 'knowledge_fact', entityId: result.fact.id, operation: 'create' }),
    ]);
  });

  it('B2 — Ändern, Deaktivieren und Löschen reihen je genau einen Auftrag für diesen Eintrag ein', () => {
    hydrateKnowledgeFacts([{ ...fakt(), sync: syncMeta(1) }]);
    persistAll();
    resetSyncOutboxForTests([]);

    updateKnowledgeFact('knowledge-1', { value: 'Angebote per Post', displayText: 'Angebote gehen per Post hinaus' });
    expect(wissensAuftraege()).toEqual([expect.objectContaining({ entityId: 'knowledge-1', operation: 'update' })]);

    resetSyncOutboxForTests([]);
    updateKnowledgeFact('knowledge-1', { active: false });
    expect(wissensAuftraege()).toEqual([expect.objectContaining({ entityId: 'knowledge-1', operation: 'update' })]);

    resetSyncOutboxForTests([]);
    deleteKnowledgeFact('knowledge-1');
    expect(wissensAuftraege()).toEqual([expect.objectContaining({ entityId: 'knowledge-1', operation: 'delete' })]);
  });

  it('B3 — die zurückgeschriebene Serverversion löst keinen neuen Auftrag aus', () => {
    hydrateKnowledgeFacts([{ ...fakt(), sync: syncMeta(1) }]);
    persistAll();
    resetSyncOutboxForTests([]);

    // Nur Sync-Metadaten ändern sich — wie nach einem bestätigten Versand.
    hydrateKnowledgeFacts([{ ...fakt(), sync: syncMeta(2, { updatedAt: '2026-10-06T10:00:00.000Z' }) }]);
    persistAll();

    expect(wissensAuftraege()).toEqual([]);
  });

  it('C1 — der Payload trägt Kennung, Scope und nur die fachlichen Felder', () => {
    const fact: KnowledgeFact = {
      ...fakt({ scope: 'customer', scopeId: 'kunde-7', scopeLabel: 'Muster GmbH', updatedAt: UPDATED_AT }),
      sync: syncMeta(4),
    };

    const push = buildKnowledgeFactCloudPushPayload(fact);

    expect(push).toEqual({
      fact_id: 'knowledge-1',
      scope: 'customer',
      deleted: false,
      payload: {
        id: 'knowledge-1',
        scope: 'customer',
        category: 'communication_preference',
        key: 'angebote_per_e_mail',
        value: 'Angebote per E-Mail',
        displayText: 'Angebote gehen per E-Mail hinaus',
        sourceType: 'user',
        confirmedAt: '2026-10-06T08:00:00.000Z',
        createdAt: '2026-10-06T08:00:00.000Z',
        active: true,
        scopeId: 'kunde-7',
        scopeLabel: 'Muster GmbH',
        updatedAt: UPDATED_AT,
      },
    });
    expect(JSON.stringify(push)).not.toContain('"sync"');
    expect(buildKnowledgeFactCloudPushPayload(fact, true).deleted).toBe(true);
  });

  it('C2 — der Inhaltsschlüssel kennt Text und Aktiv-Kennzeichen, aber keine Serverversion', () => {
    const a = { ...fakt(), sync: syncMeta(1) };
    const b = { ...fakt(), sync: syncMeta(7, { deviceId: 'anderes-geraet' }) };
    expect(buildKnowledgeFactCloudContentKey(a)).toBe(buildKnowledgeFactCloudContentKey(b));
    expect(buildKnowledgeFactCloudContentKey(a)).not.toBe(buildKnowledgeFactCloudContentKey({ ...a, active: false }));
    expect(buildKnowledgeFactCloudContentKey(a)).not.toBe(
      buildKnowledgeFactCloudContentKey({ ...a, displayText: 'Angebote gehen per Post hinaus' }),
    );
    // Fehlend und leer ergeben denselben Schlüssel — kein Schein-Versand.
    expect(buildKnowledgeFactCloudContentKey(a)).toBe(
      buildKnowledgeFactCloudContentKey({ ...a, scopeId: '', scopeLabel: undefined, sourceId: undefined }),
    );
  });

  it('C3 — die Extraktion meldet Grabstein und bestätigte Version', () => {
    hydrateKnowledgeFacts([{ ...fakt(), sync: syncMeta(3, { deleted: true, deletedAt: UPDATED_AT }) }]);

    const extracted = extractCloudSyncEntity(buildPersistedStateSnapshot(), 'knowledge_fact', 'knowledge-1');

    expect(extracted).toMatchObject({
      entityType: 'knowledge_fact',
      entityId: 'knowledge-1',
      rowVersion: 3,
      deleted: true,
    });
  });
});

/* ------------------------------------------------------------------ */
/* D — Versand über den bestehenden Dispatcher                          */
/* ------------------------------------------------------------------ */

describe('S3-D — Versand über den bestehenden Dispatcher', () => {
  function adapterMitFreigabe(rowVersion: number) {
    vi.spyOn(supabaseLib, 'isSupabaseConfigured').mockReturnValue(true);
    const upsert = vi
      .spyOn(workspaceCloudService, 'rpcUpsertWorkspaceSyncEntity')
      .mockResolvedValue({ rowVersion, payload: {}, entityId: null, deduped: false });
    const adapter = new SupabaseSyncAdapter(null);
    vi.spyOn(adapter as unknown as { assertClient: () => unknown }, 'assertClient').mockReturnValue({});
    return { adapter, upsert };
  }

  function auftrag(fact: KnowledgeFact, operation: SyncOutboxEntry['operation']): SyncOutboxEntry {
    hydrateKnowledgeFacts([fact]);
    const entry = enqueueSyncOutbox({ entityType: 'knowledge_fact', entityId: fact.id, operation, version: 0 });
    // 01G6 — der Sendenachweis braucht einen gespeicherten Bestand, sonst wird nicht gesendet.
    persistAll();
    return entry;
  }

  async function senden(adapter: SupabaseSyncAdapter, entry: SyncOutboxEntry) {
    return adapter.pushChanges({
      deviceId: DEVICE,
      workspaceId: WORKSPACE,
      state: buildPersistedStateSnapshot(),
      outbox: [entry],
    });
  }

  it('D0 — nach der Remote-Migration ist der Typ freigegeben und nicht mehr nur-lokal', () => {
    expect(allowlist.isSupabaseSyncAllowed('knowledge_fact')).toBe(true);
    expect(allowlist.LOCAL_ONLY_SYNC_ENTITY_TYPES.has('knowledge_fact')).toBe(false);
  });

  it('D1 — ohne Freigabe wird nichts gesendet, und der Auftrag bleibt nicht liegen (Notausschalter)', async () => {
    freigabeZuruecknehmen();
    vi.spyOn(supabaseLib, 'isSupabaseConfigured').mockReturnValue(true);
    const upsert = vi.spyOn(workspaceCloudService, 'rpcUpsertWorkspaceSyncEntity');
    const entry = auftrag(fakt(), 'create');

    const result = await senden(new SupabaseSyncAdapter(null), entry);

    expect(upsert).not.toHaveBeenCalled();
    expect(result.completedOutboxIds).toEqual([entry.id]);
  });

  it('D2 — mit Freigabe geht die Anlage über upsert_workspace_sync_entity, nur in den eigenen Betrieb', async () => {
    const { adapter, upsert } = adapterMitFreigabe(1);
    const fact = fakt();
    const entry = auftrag(fact, 'create');

    const result = await senden(adapter, entry);

    expect(result.failedOutbox).toEqual([]);
    expect(result.completedOutboxIds).toEqual([entry.id]);
    expect(upsert).toHaveBeenCalledTimes(1);
    const [workspaceId, entityType, payload, rowVersion] = upsert.mock.calls[0]!;
    expect(workspaceId, 'nur der eigene Betrieb').toBe(WORKSPACE);
    expect(entityType).toBe('knowledge_fact');
    expect(rowVersion, 'Neuanlage: diese Zeile darf noch nicht existieren').toBe(0);
    expect(payload).toEqual(buildKnowledgeFactCloudPushPayload(fact));
    // Die bestätigte Version kommt zurück, der Eintrag selbst bleibt, wie er ist.
    const gespeichert = result.state.knowledgeFacts?.find((item) => item.id === fact.id);
    expect(gespeichert?.sync?.version).toBe(1);
    expect(gespeichert?.sync?.workspaceId).toBe(WORKSPACE);
    expect(gespeichert?.displayText).toBe(fact.displayText);
  });

  it('D3 — eine Änderung erwartet die zuletzt bestätigte Version', async () => {
    const { adapter, upsert } = adapterMitFreigabe(3);
    const entry = auftrag({ ...fakt({ active: false }), sync: syncMeta(2) }, 'update');

    const result = await senden(adapter, entry);

    const [, , payload, rowVersion] = upsert.mock.calls[0]!;
    expect(rowVersion).toBe(2);
    expect(payload).toMatchObject({ fact_id: 'knowledge-1', deleted: false, payload: { active: false } });
    const gespeichert = result.state.knowledgeFacts?.find((item) => item.id === 'knowledge-1');
    expect(gespeichert?.sync?.version).toBe(3);
    expect(gespeichert?.active).toBe(false);
  });

  it('D4 — der Grabstein reist mit Scope und bleibt lokal ein Grabstein', async () => {
    const { adapter, upsert } = adapterMitFreigabe(5);
    const entry = auftrag({ ...fakt(), sync: syncMeta(4, { deleted: true, deletedAt: UPDATED_AT }) }, 'delete');

    const result = await senden(adapter, entry);

    const [, , payload, rowVersion] = upsert.mock.calls[0]!;
    expect(payload).toMatchObject({ fact_id: 'knowledge-1', scope: 'company', deleted: true });
    expect(rowVersion, 'die bestätigte Version als Erwartung').toBe(4);
    const gespeichert = result.state.knowledgeFacts?.find((item) => item.id === 'knowledge-1');
    expect(gespeichert?.sync?.deleted).toBe(true);
    expect(gespeichert?.sync?.version).toBe(5);
  });
});

/* ------------------------------------------------------------------ */
/* E/F — Abzug und Abgleich                                            */
/* ------------------------------------------------------------------ */

describe('S3-E/F — das Wissen kommt aus der Cloud', () => {
  it('E1 — ein Eintrag aus der Cloud kommt vollständig und mit Serverversion an', () => {
    const remote = fakt({ scope: 'customer', scopeId: 'kunde-7', scopeLabel: 'Muster GmbH' });

    const merged = mergeKnowledgeFactsFromPull([], [zeile(remote, 2)], DEVICE, WORKSPACE);

    expect(merged.conflicts).toEqual([]);
    expect(merged.facts).toEqual([
      expect.objectContaining({
        id: 'knowledge-1',
        scope: 'customer',
        scopeId: 'kunde-7',
        scopeLabel: 'Muster GmbH',
        displayText: 'Angebote gehen per E-Mail hinaus',
        active: true,
        sync: expect.objectContaining({ version: 2, deleted: false, workspaceId: WORKSPACE }),
      }),
    ]);
  });

  it('E2 — der Abzug liest den Schlüssel knowledge_facts der Sammelfunktion, kein Sonder-Pull', async () => {
    const row = zeile(fakt(), 1);
    const rpc = vi.fn().mockResolvedValue({ data: { knowledge_facts: [row] }, error: null });

    const pull = await workspaceCloudService.rpcPullWorkspaceSyncState(
      WORKSPACE,
      { rpc } as unknown as SupabaseClient,
    );

    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('pull_workspace_sync_state', { p_workspace_id: WORKSPACE });
    expect(pull.knowledgeFacts).toEqual([row]);
  });

  it('F1 — der Abgleich legt den Eintrag in den Speicher; nichts wird zurückgesendet', () => {
    const merged = abgleich([zeile(fakt(), 1)]);
    expect(merged.conflicts).toEqual([]);
    hydrateKnowledgeFacts(merged.state.knowledgeFacts ?? []);

    expect(getKnowledgeFacts()).toEqual([
      expect.objectContaining({ id: 'knowledge-1', sync: expect.objectContaining({ version: 1 }) }),
    ]);
    expect(wissensAuftraege()).toEqual([]);
  });

  it('F2 — mit zurückgenommener Freigabe bleibt der Abzug ohne Wirkung', () => {
    freigabeZuruecknehmen();
    hydrateKnowledgeFacts([fakt({ id: 'knowledge-lokal' })]);

    const merged = abgleich([zeile(fakt(), 1)]);

    expect(merged.state.knowledgeFacts?.map((fact) => fact.id)).toEqual(['knowledge-lokal']);
    expect(wissensAuftraege()).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* G — Altbestand                                                      */
/* ------------------------------------------------------------------ */

describe('S3-G — vorhandenes Wissen geht nicht verloren (Altbestand)', () => {
  it('G1 — ein lokaler Eintrag ohne Cloudzeile bleibt und wird einmal als Anlage nachgetragen', () => {
    hydrateKnowledgeFacts([fakt()]);

    const merged = abgleich([]);

    expect(merged.state.knowledgeFacts?.map((fact) => fact.id)).toEqual(['knowledge-1']);
    expect(wissensAuftraege()).toEqual([
      expect.objectContaining({ entityId: 'knowledge-1', operation: 'create', version: 0 }),
    ]);
  });

  it('G2 — auch ein deaktivierter Eintrag reist mit: Er ist eine Nutzerentscheidung', () => {
    hydrateKnowledgeFacts([fakt({ active: false })]);

    abgleich([]);

    expect(wissensAuftraege()).toEqual([expect.objectContaining({ entityId: 'knowledge-1', operation: 'create' })]);
  });

  it('G3 — kein Nachtrag für einen lokalen Grabstein oder eine anderswo gelöschte Kennung', () => {
    const anderswoGeloescht = fakt({ id: 'knowledge-2', key: 'termine_vormittags' });
    hydrateKnowledgeFacts([
      { ...fakt(), sync: syncMeta(0, { deleted: true, deletedAt: UPDATED_AT }) },
      { ...anderswoGeloescht, sync: syncMeta(2) },
    ]);

    const merged = abgleich([zeile(anderswoGeloescht, 3, true)]);

    expect(wissensAuftraege()).toEqual([]);
    expect(merged.state.knowledgeFacts?.some((fact) => fact.id === 'knowledge-2')).toBe(false);
  });

  it('G4 — idempotent: was oben ist, wird nicht erneut eingereiht; zwei Abgleiche, ein Auftrag', () => {
    const local = { ...fakt(), sync: syncMeta(1) };
    expect(planKnowledgeFactBackfill([local], [zeile(local, 1)])).toEqual([]);
    expect(planKnowledgeFactBackfill([local], [])).toEqual(['knowledge-1']);

    hydrateKnowledgeFacts([fakt()]);
    abgleich([]);
    abgleich([]);

    expect(wissensAuftraege()).toHaveLength(1);
  });

  it('G5 — mit zurückgenommener Freigabe kein Nachtrag: die Warteschlange läuft nicht bei jedem Abzug voll', () => {
    freigabeZuruecknehmen();
    hydrateKnowledgeFacts([fakt()]);

    const merged = abgleich([]);

    expect(wissensAuftraege()).toEqual([]);
    expect(merged.state.knowledgeFacts).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ */
/* H — Konfliktvertrag                                                 */
/* ------------------------------------------------------------------ */

describe('S3-H — Konfliktvertrag statt Last-Write-Wins', () => {
  it('H1 — gleiche Version, anderer Inhalt: Konflikt, die lokale Fassung bleibt', () => {
    const local = { ...fakt(), sync: syncMeta(2) };

    const merged = mergeKnowledgeFactsFromPull(
      [local],
      [zeile(fakt({ value: 'Angebote per Post', displayText: 'Angebote gehen per Post hinaus' }), 2)],
      DEVICE,
      WORKSPACE,
    );

    expect(merged.conflicts).toEqual(['knowledge_fact:knowledge-1']);
    expect(merged.facts[0]).toBe(local);
  });

  it('H2 — offene lokale Änderung gegen abweichende neuere Serverfassung: Konflikt, nichts wird überschrieben', () => {
    const local = { ...fakt({ displayText: 'Angebote nur per E-Mail' }), sync: syncMeta(1) };

    const merged = mergeKnowledgeFactsFromPull(
      [local],
      [zeile(fakt({ active: false }), 3)],
      DEVICE,
      WORKSPACE,
      new Set(['knowledge-1']),
    );

    expect(merged.conflicts).toEqual(['knowledge_fact:knowledge-1']);
    expect(merged.facts[0]?.displayText).toBe('Angebote nur per E-Mail');
    expect(merged.facts[0]?.sync?.version).toBe(1);
  });

  it('H3 — offene Änderung, der Server trägt dieselbe Fassung höher: nur die Version wird übernommen', () => {
    const local = { ...fakt({ active: false }), sync: syncMeta(1) };

    const merged = mergeKnowledgeFactsFromPull(
      [local],
      [zeile(fakt({ active: false }), 2)],
      DEVICE,
      WORKSPACE,
      new Set(['knowledge-1']),
    );

    expect(merged.conflicts).toEqual([]);
    expect(merged.facts[0]?.active).toBe(false);
    expect(merged.facts[0]?.sync?.version).toBe(2);
  });

  it('H4 — ohne offene Änderung gewinnt die neuere Serverfassung (auf einem anderen Gerät deaktiviert)', () => {
    const local = { ...fakt(), sync: syncMeta(1) };

    const merged = mergeKnowledgeFactsFromPull([local], [zeile(fakt({ active: false }), 2)], DEVICE, WORKSPACE);

    expect(merged.conflicts).toEqual([]);
    expect(merged.facts[0]?.active).toBe(false);
    expect(merged.facts[0]?.sync?.version).toBe(2);
  });

  it('H5 — ein wartender lokaler Grabstein wird von der älteren aktiven Serverfassung nicht wiederbelebt', () => {
    const grabstein = { ...fakt(), sync: syncMeta(2, { deleted: true, deletedAt: UPDATED_AT }) };

    const merged = mergeKnowledgeFactsFromPull(
      [grabstein],
      [zeile(fakt(), 2)],
      DEVICE,
      WORKSPACE,
      new Set(['knowledge-1']),
    );

    expect(merged.conflicts).toEqual([]);
    expect(merged.facts).toEqual([grabstein]);
  });

  it('H6 — der Konflikt erreicht den Abgleich im Provisioning und wird nicht still aufgelöst', () => {
    hydrateKnowledgeFacts([{ ...fakt(), sync: syncMeta(2) }]);

    const merged = abgleich([zeile(fakt({ displayText: 'Angebote gehen per Post hinaus' }), 2)]);

    expect(merged.conflicts).toContain('knowledge_fact:knowledge-1');
    expect(merged.state.knowledgeFacts?.[0]?.displayText).toBe('Angebote gehen per E-Mail hinaus');
  });
});

/* ------------------------------------------------------------------ */
/* I — Wiederanlauf                                                    */
/* ------------------------------------------------------------------ */

describe('S3-I — Wiederanlauf nach verlorener Bestätigung', () => {
  it('I1 — die Anlage kam an, die Bestätigung nicht: die Serverzeile wird zur Basis, nicht zum Konflikt', () => {
    const local = fakt();

    const plan = planKnowledgeFactLostAckAdoption([local], [zeile(local, 1)], new Set(['knowledge-1']));

    expect(plan.adopt).toEqual(['knowledge-1']);
    expect(plan.baseVersions.get('knowledge-1')).toBe(1);
  });

  it('I2 — im Abgleich: kein Konflikt, die Serverversion wird zur Basis, der Inhalt bleibt', () => {
    hydrateKnowledgeFacts([fakt()]);
    enqueueSyncOutbox({ entityType: 'knowledge_fact', entityId: 'knowledge-1', operation: 'create', version: 0 });
    persistAll();

    const merged = abgleich([zeile(fakt(), 1)]);

    expect(merged.conflicts).toEqual([]);
    const fact = merged.state.knowledgeFacts?.find((item) => item.id === 'knowledge-1');
    expect(fact?.sync?.version).toBe(1);
    expect(fact?.displayText).toBe('Angebote gehen per E-Mail hinaus');
  });
});

/* ------------------------------------------------------------------ */
/* J — Grabstein                                                       */
/* ------------------------------------------------------------------ */

describe('S3-J — Grabstein', () => {
  it('J1 — Löschen: Grabstein mit erhaltener Version und genau ein Löschauftrag', () => {
    hydrateKnowledgeFacts([{ ...fakt(), sync: syncMeta(3) }]);
    persistAll();
    resetSyncOutboxForTests([]);

    expect(deleteKnowledgeFact('knowledge-1').success).toBe(true);

    expect(wissensAuftraege()).toEqual([expect.objectContaining({ entityId: 'knowledge-1', operation: 'delete' })]);
    const grabstein = buildPersistedStateSnapshot().knowledgeFacts?.find((fact) => fact.id === 'knowledge-1');
    expect(grabstein?.sync).toMatchObject({ deleted: true, version: 3 });
  });

  it('J2 — ein Grabstein aus der Cloud entfernt den Eintrag, und nichts lädt ihn wieder hoch', () => {
    hydrateKnowledgeFacts([{ ...fakt(), sync: syncMeta(2) }]);

    const merged = abgleich([zeile(fakt(), 3, true)]);

    expect(merged.conflicts).toEqual([]);
    expect(merged.state.knowledgeFacts).toEqual([]);
    expect(wissensAuftraege()).toEqual([]);
  });

  it('J3 — auch ein Grabstein ohne Fachinhalt (gelöscht angelegt) kommt an', () => {
    const ohneInhalt = { ...zeile(fakt(), 1, true), payload: {} };

    const merged = mergeKnowledgeFactsFromPull([{ ...fakt(), sync: syncMeta(0) }], [ohneInhalt], DEVICE, WORKSPACE);

    expect(merged.facts).toEqual([]);
  });

  it('J4 — eine ungesendete lokale Änderung wird von einem Grabstein nicht still verworfen', () => {
    const local = { ...fakt({ displayText: 'Angebote nur per E-Mail' }), sync: syncMeta(2) };

    const merged = mergeKnowledgeFactsFromPull(
      [local],
      [zeile(fakt(), 3, true)],
      DEVICE,
      WORKSPACE,
      new Set(['knowledge-1']),
    );

    expect(merged.conflicts).toEqual(['knowledge_fact:knowledge-1']);
    expect(merged.facts).toEqual([local]);
  });
});

/* ------------------------------------------------------------------ */
/* L/M — Reload, Anzeige und die Lesepfade der KI                       */
/* ------------------------------------------------------------------ */

describe('S3-L/M — Reload, Wissen-Seite und die Lesepfade der KI', () => {
  it('L1 — nach Speichern und erneutem Laden ist der Eintrag mit Serverversion da', () => {
    hydrateKnowledgeFacts([{ ...fakt(), sync: syncMeta(2) }]);
    persistAll();

    resetKnowledgeFacts();
    const geladen = loadPersistedState();
    expect(geladen).not.toBeNull();
    applyStateToStores(geladen!);

    const fact = getKnowledgeFacts().find((item) => item.id === 'knowledge-1');
    expect(fact?.displayText).toBe('Angebote gehen per E-Mail hinaus');
    expect(fact?.sync?.version).toBe(2);
  });

  it('L2 — ein noch nie gesendeter Eintrag bleibt nach dem Laden unbestätigt', () => {
    const result = addKnowledgeFact({
      scope: 'company',
      category: 'scheduling',
      key: 'termine_vormittags',
      value: 'vormittags',
      displayText: 'Termine bevorzugt vormittags',
    });
    if (!result.success) throw new Error('Anlegen fehlgeschlagen');

    resetKnowledgeFacts();
    applyStateToStores(loadPersistedState()!);

    const fact = getKnowledgeFacts().find((item) => item.id === result.fact.id);
    expect(fact?.displayText).toBe('Termine bevorzugt vormittags');
    expect(fact?.sync?.version ?? 0, 'keine erfundene Bestätigung').toBe(0);
  });

  it('M1 — die Wissen-Seite zeigt einen Eintrag aus der Cloud', () => {
    hydrateKnowledgeFacts(abgleich([zeile(fakt(), 1)]).state.knowledgeFacts ?? []);

    const html = renderWissen();

    expect(html).toContain('data-testid="knowledge-item"');
    expect(html).toContain('Angebote gehen per E-Mail hinaus');
  });

  it('M2 — ein auf einem anderen Gerät gelöschter Eintrag verschwindet von der Wissen-Seite', () => {
    hydrateKnowledgeFacts([{ ...fakt(), sync: syncMeta(1) }]);
    expect(renderWissen()).toContain('Angebote gehen per E-Mail hinaus');

    hydrateKnowledgeFacts(abgleich([zeile(fakt(), 2, true)]).state.knowledgeFacts ?? []);

    expect(renderWissen()).not.toContain('Angebote gehen per E-Mail hinaus');
  });

  it('M3 — der Kommunikationskontext der KI liest das Wissen aus der Cloud', () => {
    hydrateKnowledgeFacts(abgleich([zeile(fakt(), 1)]).state.knowledgeFacts ?? []);

    const context = buildCommunicationContext({ type: 'vorgang', id: 'vorgang-s3' });

    expect(context.facts).toContainEqual({
      key: 'knowledge:knowledge-1',
      value: 'Angebote gehen per E-Mail hinaus',
      source: 'knowledge',
    });
  });

  it('M4 — der Brain-Snapshot liest aktives Wissen aus der Cloud; deaktiviertes bleibt draussen', () => {
    const deaktiviert = fakt({
      id: 'knowledge-2',
      category: 'scheduling',
      key: 'termine_vormittags',
      value: 'vormittags',
      displayText: 'Termine bevorzugt vormittags',
      active: false,
    });
    hydrateKnowledgeFacts(abgleich([zeile(fakt(), 1), zeile(deaktiviert, 1)]).state.knowledgeFacts ?? []);

    const snapshot = buildBrainSnapshot();

    expect(snapshot.knowledge).toEqual([
      { scope: 'company', category: 'communication_preference', displayText: 'Angebote gehen per E-Mail hinaus' },
    ]);
  });
});

/* ------------------------------------------------------------------ */
/* N — Abgrenzung                                                      */
/* ------------------------------------------------------------------ */

describe('S3-N — Abgrenzung', () => {
  it('N1 — Gedächtnis, Nachweise, Beziehungen und Mailimporte bleiben nur-lokal', () => {
    for (const type of ['document_memory', 'proof_memory', 'memory_relation', 'mail_import'] as const) {
      expect(allowlist.isSupabaseSyncAllowed(type), type).toBe(false);
      expect(allowlist.LOCAL_ONLY_SYNC_ENTITY_TYPES.has(type), type).toBe(true);
    }
  });

  it('N2 — S1 und S2 bleiben freigegeben; der Wissensabgleich berührt weder Papierablage noch Verlauf', () => {
    expect(allowlist.isSupabaseSyncAllowed('paper_register_entry')).toBe(true);
    expect(allowlist.isSupabaseSyncAllowed('communication_event')).toBe(true);

    const vorher = buildPersistedStateSnapshot();
    const merged = mergeRemoteWorkspacePullIntoState(vorher, pullMit([zeile(fakt(), 1)]));

    expect(merged.state.officePilotMemory?.paperRegisterEntries ?? []).toEqual(
      vorher.officePilotMemory?.paperRegisterEntries ?? [],
    );
    expect(merged.state.communicationHistory ?? []).toEqual(vorher.communicationHistory ?? []);
    expect(merged.state.knowledgeFacts?.map((fact) => fact.id)).toEqual(['knowledge-1']);
  });
});
