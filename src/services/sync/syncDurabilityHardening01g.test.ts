/**
 * SYNC-DURABILITY-HARDENING-01G — die Regeln, die verhindern, dass ein Pull
 * Arbeit vernichtet.
 *
 * Das Audit 01F hat vier Wege gefunden, auf denen eine Änderung des Nutzers
 * still verschwindet. Alle vier haben dieselbe Wurzel: `sync.version` wurde an
 * mehreren Stellen so behandelt, als sei sie eine lokale Änderungsnummer. Sie
 * ist aber nur eines — **die zuletzt vom Server bestätigte Version**.
 *
 * Daraus folgen die vier Zusagen, die hier geprüft werden:
 *
 *  A  Eine lokale Änderung, die noch nicht gesendet ist, wird von einer
 *     neueren Serverfassung nicht stillschweigend ersetzt.
 *  B  Version 0 heisst „ich habe keine bestätigte Serverversion" — sie ist
 *     kein Freibrief, eine vorhandene Zeile zu überschreiben.
 *  C  Fehlt die Sync-Meta (Altbestand, Neustart), wird keine Bestätigung
 *     erfunden.
 *  D  Was der Pull am Sendeauftrag korrigiert, überlebt den Lauf.
 *
 * Neutrale Beispieldaten.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETUP } from '../../data/mockData';
import {
  mergeVorgangNotesFromPull,
  stripVorgangNoteForCloud,
  type WorkspaceVorgangNoteRow,
} from '../vorgang/vorgangNoteCloudService';
import {
  mergeTasksFromPull,
  stripTaskForCloud,
  type WorkspaceTaskRow,
} from '../task/taskCloudService';
import {
  mergeDunningDocumentationsFromPull,
  stripDunningDocumentationForCloud,
  type WorkspaceDunningDocumentationRow,
} from '../invoice/dunningDocumentationCloudService';
import type { InvoiceDunningDocumentation } from '../../types/dunningDocumentation';
import { applySyncMetadataToState, STORAGE_VERSION } from './syncMigrationService';
import { createSyncClient, resetSyncClientForTests } from './syncClientService';
import { resetSyncOutboxForTests, getSyncOutboxSnapshot } from './syncOutboxService';
import { normalizeTask } from '../taskNormalize';
import type { AppPersistedState, Task } from '../../types/models';
import type { VorgangNote } from '../../types/communication';
import type { SyncMeta } from '../../types/sync';

const DEVICE = 'device-01g';
const WORKSPACE = 'ws-01g';

function syncMeta(version: number, overrides: Partial<SyncMeta> = {}): SyncMeta {
  return {
    updatedAt: '2026-07-01T10:00:00.000Z',
    version,
    deleted: false,
    deviceId: DEVICE,
    workspaceId: WORKSPACE,
    ...overrides,
  };
}

function note(overrides: Partial<VorgangNote> = {}): VorgangNote {
  return {
    id: 'note-01g',
    vorgangId: 'v-01g',
    vorgangTitle: 'Beispielauftrag',
    body: 'Ursprünglicher Text',
    occurredAt: '2026-07-01T08:00:00.000Z',
    createdAt: '2026-07-01T08:00:00.000Z',
    source: 'user',
    ...overrides,
  };
}

function noteRow(base: VorgangNote, rowVersion: number, deleted = false): WorkspaceVorgangNoteRow {
  return {
    workspace_id: WORKSPACE,
    client_note_id: base.id,
    client_vorgang_id: base.vorgangId,
    payload: deleted ? {} : (stripVorgangNoteForCloud(base) as unknown as Record<string, unknown>),
    row_version: rowVersion,
    deleted,
    deleted_at: deleted ? '2026-07-02T09:00:00.000Z' : null,
    updated_at: '2026-07-02T09:00:00.000Z',
    updated_by: 'user-remote',
  };
}

function task(overrides: Partial<Task> = {}): Task {
  return normalizeTask({
    id: 't-01g',
    title: 'Zahlung prüfen',
    description: 'Offener Betrag',
    status: 'open',
    priority: 'hoch',
    category: 'zahlungen',
    sourceType: 'invoice',
    sourceId: 'inv-01g',
    taskKind: 'payment_overdue',
    dedupeKey: 'invoice:inv-01g:payment_overdue',
    autoCreated: true,
    createdAt: '2026-07-01T09:00:00.000Z',
    ...overrides,
  });
}

function taskRow(base: Task, rowVersion: number): WorkspaceTaskRow {
  return {
    workspace_id: WORKSPACE,
    client_task_id: base.id,
    status: base.status,
    dedupe_key: base.dedupeKey,
    auto_created: base.autoCreated,
    payload: stripTaskForCloud(base) as unknown as Record<string, unknown>,
    row_version: rowVersion,
    deleted: false,
    deleted_at: null,
    updated_at: '2026-07-02T09:00:00.000Z',
    updated_by: 'user-remote',
  };
}

/* ------------------------------------------------------------------------ */
/* A — Notiz: ungesendete Änderung überlebt den Pull                         */
/* ------------------------------------------------------------------------ */

describe('01G-A — Dirty Pull, Vorgangsnotiz', () => {
  it('1: eine ungesendete lokale Änderung wird von der neueren Serverfassung nicht ersetzt', () => {
    // Bestätigte Basis ist Version 1; lokal wurde danach geändert, noch nicht gesendet.
    const local = { ...note({ body: 'Lokal ergänzt: Kunde ruft zurück' }), sync: syncMeta(1) };
    // Ein anderes Gerät hat dieselbe Notiz inzwischen auf Version 2 geändert.
    const remote = noteRow(note({ body: 'Auf dem anderen Gerät geändert' }), 2);

    const merged = mergeVorgangNotesFromPull(
      [local],
      [remote],
      DEVICE,
      WORKSPACE,
      new Set([local.id]),
    );

    // Der lokale Text darf nicht stillschweigend verschwinden.
    expect(merged.conflicts).toEqual(['vorgang_note:note-01g']);
    expect(merged.notes[0].body).toBe('Lokal ergänzt: Kunde ruft zurück');
  });

  it('2: ohne offene lokale Änderung gilt weiterhin die normale Versionsregel', () => {
    const local = { ...note(), sync: syncMeta(1) };
    const remote = noteRow(note({ body: 'Auf dem anderen Gerät geändert' }), 2);

    const merged = mergeVorgangNotesFromPull([local], [remote], DEVICE, WORKSPACE, new Set());

    expect(merged.conflicts).toEqual([]);
    expect(merged.notes[0].body).toBe('Auf dem anderen Gerät geändert');
    expect(merged.notes[0].sync?.version).toBe(2);
  });

  it('3: ein Grabstein löscht keine ungesendete lokale Änderung stillschweigend', () => {
    const local = { ...note({ body: 'Lokal ergänzt' }), sync: syncMeta(1) };
    const remote = noteRow(note(), 2, true);

    const merged = mergeVorgangNotesFromPull(
      [local],
      [remote],
      DEVICE,
      WORKSPACE,
      new Set([local.id]),
    );

    expect(merged.conflicts).toEqual(['vorgang_note:note-01g']);
    expect(merged.notes.map((entry) => entry.id)).toEqual(['note-01g']);
  });

  it('4: ein Grabstein ohne offene lokale Änderung entfernt die Notiz weiterhin', () => {
    const local = { ...note(), sync: syncMeta(1) };
    const merged = mergeVorgangNotesFromPull(
      [local],
      [noteRow(note(), 2, true)],
      DEVICE,
      WORKSPACE,
      new Set(),
    );
    expect(merged.conflicts).toEqual([]);
    expect(merged.notes).toEqual([]);
  });
});

/* ------------------------------------------------------------------------ */
/* B — Aufgabe: ungesendete Statusänderung überlebt den Pull                 */
/* ------------------------------------------------------------------------ */

describe('01G-B — Dirty Pull, Aufgabe', () => {
  it('5: lokal erledigt, remote inzwischen geändert — der Status geht nicht verloren', () => {
    const local = {
      ...task({ status: 'done', completedAt: '2026-07-02T08:00:00.000Z' }),
      sync: syncMeta(1),
    };
    const remote = taskRow(task({ status: 'open', title: 'Zahlung prüfen (erinnert)' }), 2);

    const merged = mergeTasksFromPull([local], [remote], DEVICE, WORKSPACE, new Set([local.id]));

    expect(merged.conflicts).toEqual(['task:t-01g']);
    expect(merged.tasks[0].status).toBe('done');
  });

  it('6: ohne offene lokale Änderung gewinnt weiterhin die höhere Serverversion', () => {
    const local = { ...task({ status: 'done' }), sync: syncMeta(1) };
    const remote = taskRow(task({ status: 'open' }), 2);

    const merged = mergeTasksFromPull([local], [remote], DEVICE, WORKSPACE, new Set());

    expect(merged.conflicts).toEqual([]);
    expect(merged.tasks[0].status).toBe('open');
    expect(merged.tasks[0].sync?.version).toBe(2);
  });
});

/* ------------------------------------------------------------------------ */
/* C — Reload erfindet keine bestätigte Serverversion                        */
/* ------------------------------------------------------------------------ */

describe('01G-C — Sync-Meta beim Neustart', () => {
  beforeEach(() => {
    resetSyncClientForTests(createSyncClient());
    resetSyncOutboxForTests([]);
  });

  it('7: eine Entität ohne Sync-Meta bekommt keine erfundene Bestätigung', () => {
    const client = { ...createSyncClient(), deviceId: DEVICE, workspaceId: WORKSPACE };
    const state = applySyncMetadataToState(
      {
        version: STORAGE_VERSION,
        syncClient: client,
        syncOutbox: [],
        setup: { ...DEFAULT_SETUP },
        inboxItems: [],
        vorgaenge: [],
        tasks: [task()],
        documents: [],
        expenses: [],
        savedAt: new Date().toISOString(),
      } as unknown as AppPersistedState,
      client,
    );

    const migrated = state.tasks[0];
    // Gerät und Arbeitsbereich werden ergänzt — die Serverversion nicht erfunden.
    expect(migrated.sync?.deviceId).toBe(DEVICE);
    expect(migrated.sync?.workspaceId).toBe(WORKSPACE);
    expect(migrated.sync?.version ?? 0).toBe(0);
  });

  it('8: eine bereits bestätigte Version bleibt unangetastet', () => {
    const client = { ...createSyncClient(), deviceId: DEVICE, workspaceId: WORKSPACE };
    const confirmed = { ...task(), sync: syncMeta(4, { deviceId: undefined as unknown as string }) };
    const state = applySyncMetadataToState(
      {
        version: STORAGE_VERSION,
        syncClient: client,
        syncOutbox: [],
        setup: { ...DEFAULT_SETUP },
        inboxItems: [],
        vorgaenge: [],
        tasks: [confirmed],
        documents: [],
        expenses: [],
        savedAt: new Date().toISOString(),
      } as unknown as AppPersistedState,
      client,
    );

    expect(state.tasks[0].sync?.version).toBe(4);
    expect(state.tasks[0].sync?.deviceId).toBe(DEVICE);
  });

  it('9: der Outbox-Bestand bleibt vom Neustart unberührt', () => {
    expect(getSyncOutboxSnapshot()).toEqual([]);
  });
});

/* ------------------------------------------------------------------------ */
/* D — Was der Pull am Sendeauftrag korrigiert, überlebt                      */
/* ------------------------------------------------------------------------ */

describe('01G-D — Outbox-Zusammenführung nach dem Pull', () => {
  const entry = (
    id: string,
    overrides: Partial<{
      status: 'pending' | 'blocked' | 'completed' | 'error';
      version: number;
      entityId: string;
    }> = {},
  ) => ({
    id,
    entityType: 'vorgang' as const,
    entityId: overrides.entityId ?? `v-${id}`,
    operation: 'update' as const,
    version: overrides.version ?? 1,
    queuedAt: '2026-07-01T10:00:00.000Z',
    retryCount: 0,
    status: overrides.status ?? ('pending' as const),
  });

  it('10: ein Push-Ergebnis bleibt erhalten, wenn der Pull den Eintrag nicht anfasst', async () => {
    const { mergeOutboxAfterPull } = await import('./syncOutboxMergeService');
    const prePull = [entry('a')];
    const afterPush = [entry('a', { status: 'completed' })];
    const afterPull = [entry('a')];

    const merged = mergeOutboxAfterPull({ prePull, afterPush, afterPull });
    expect(merged.find((item) => item.id === 'a')?.status).toBe('completed');
  });

  it('11: eine Korrektur aus dem Pull überlebt den Lauf', async () => {
    const { mergeOutboxAfterPull } = await import('./syncOutboxMergeService');
    const prePull = [entry('a', { status: 'blocked' })];
    const afterPush = [entry('a', { status: 'blocked' })];
    // Der Pull hat den verlorenen CREATE erkannt und den Auftrag neu angesetzt.
    const afterPull = [entry('a', { status: 'pending', version: 1 })];

    const merged = mergeOutboxAfterPull({ prePull, afterPush, afterPull });
    expect(merged.find((item) => item.id === 'a')?.status).toBe('pending');
  });

  it('12: während des Pull neu entstandene Aufträge kommen mit', async () => {
    const { mergeOutboxAfterPull } = await import('./syncOutboxMergeService');
    const merged = mergeOutboxAfterPull({
      prePull: [entry('a')],
      afterPush: [entry('a', { status: 'completed' })],
      afterPull: [entry('a'), entry('b')],
    });
    expect(merged.map((item) => item.id).sort()).toEqual(['a', 'b']);
    expect(merged.find((item) => item.id === 'a')?.status).toBe('completed');
  });
});

/* ------------------------------------------------------------------------ */
/* E — Der Koordinator verwirft die Pull-Korrektur nicht                      */
/* ------------------------------------------------------------------------ */

describe('01G-E — Koordinator', () => {
  it('13: der persistierte Endzustand trägt Push-Ergebnis und Pull-Korrektur', async () => {
    const { SyncCoordinator } = await import('./syncCoordinator');
    const client = { ...createSyncClient(), deviceId: DEVICE, workspaceId: WORKSPACE };

    const pending = {
      id: 'outbox-1',
      entityType: 'vorgang' as const,
      entityId: 'v-1',
      operation: 'update' as const,
      version: 0,
      queuedAt: '2026-07-01T10:00:00.000Z',
      retryCount: 0,
      status: 'blocked' as const,
    };

    const baseState = {
      version: STORAGE_VERSION,
      syncClient: client,
      syncOutbox: [pending],
      setup: { ...DEFAULT_SETUP },
      inboxItems: [],
      vorgaenge: [],
      tasks: [],
      documents: [],
      expenses: [],
      savedAt: new Date().toISOString(),
    } as unknown as AppPersistedState;

    const report = {
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      durationMs: 0,
      pushCount: 0,
      pullCount: 0,
      mergedEntityCount: 0,
      conflictCount: 0,
      errorCount: 0,
      completedOutboxCount: 0,
      syncedEntities: [],
      conflicts: [],
      errors: [],
    };

    const adapter = {
      providerKind: 'local' as const,
      pushChanges: vi.fn(async (input: { state: AppPersistedState }) => ({
        success: true,
        // Der Push hat nichts erledigt: Der Eintrag bleibt blockiert.
        state: input.state,
        completedOutboxIds: [],
        failedOutbox: [],
        report,
      })),
      pullChanges: vi.fn(async (input: { state: AppPersistedState }) => ({
        success: true,
        // Der Pull erkennt die verlorene Bestätigung und setzt den Auftrag neu an.
        state: {
          ...input.state,
          syncOutbox: [{ ...pending, status: 'pending' as const, version: 1 }],
        },
        report,
      })),
      acknowledgeChanges: vi.fn(async () => undefined),
      reserveInvoiceNumber: vi.fn(),
      uploadBlob: vi.fn(),
      downloadBlob: vi.fn(),
      getSyncStatus: vi.fn(() => ({ syncState: 'idle' as const, pendingChanges: 0 })),
    };

    const coordinator = new SyncCoordinator(adapter as never);
    const result = await coordinator.runSync(baseState);

    const persisted = result.state.syncOutbox?.find((item) => item.id === 'outbox-1');
    expect(persisted?.status).toBe('pending');
    expect(persisted?.version).toBe(1);
  });
});

/* ------------------------------------------------------------------------ */
/* 01G2 — was die Produktreproduktion ergänzt hat                            */
/* ------------------------------------------------------------------------ */

/**
 * Im Browser reproduziert (Aufruf geht durch, Antwort geht verloren):
 *
 *  * Nach einem verlorenen ACK trägt der Server **unsere eigene** Fassung mit
 *    höherer Version. 01G meldete dort einen Konflikt und blockierte damit den
 *    gesamten Merge — obwohl niemand widerspricht.
 *  * Ein erstmaliger Grabstein, dessen Bestätigung verloren ging, blieb dauerhaft
 *    als blockierter Sendeauftrag stehen: Der Wiederanlauf schickt den vollen
 *    Fachinhalt, die Serverzeile trägt `payload = {}`.
 *
 * Die zweite Beobachtung ist serverseitig behoben (Migration 20260926120000,
 * dort mit eigenen Vertragstests); hier stehen die Regeln des Clients.
 */
function dunningDoc(
  overrides: Partial<InvoiceDunningDocumentation> = {},
): InvoiceDunningDocumentation {
  return {
    id: 'dun-01g2',
    vorgangId: null,
    invoiceId: 'inv-01g2',
    invoiceNumber: '2026-0042',
    kind: 'payment_reminder',
    documentedAt: '2026-07-01',
    deliveryMethod: 'email',
    createdAt: '2026-07-01T09:00:00.000Z',
    ...overrides,
  };
}

function dunningRow(
  base: InvoiceDunningDocumentation,
  rowVersion: number,
): WorkspaceDunningDocumentationRow {
  return {
    workspace_id: WORKSPACE,
    client_documentation_id: base.id,
    client_invoice_id: base.invoiceId,
    client_vorgang_id: base.vorgangId,
    kind: base.kind,
    documented_at: base.documentedAt,
    delivery_method: base.deliveryMethod,
    payload: stripDunningDocumentationForCloud(base) as unknown as Record<string, unknown>,
    row_version: rowVersion,
    updated_at: '2026-07-02T09:00:00.000Z',
    updated_by: 'user-remote',
  };
}

describe('01G2 — kein Schein-Konflikt nach verlorener Bestätigung', () => {
  it('14: Notiz — Server trägt dieselbe Fassung mit höherer Version', () => {
    const local = { ...note(), sync: syncMeta(0, { version: 0 }) };
    const remote = noteRow(note(), 1);

    const merged = mergeVorgangNotesFromPull(
      [local],
      [remote],
      DEVICE,
      WORKSPACE,
      new Set([local.id]),
    );

    expect(merged.conflicts).toEqual([]);
    expect(merged.notes[0].body).toBe('Ursprünglicher Text');
    // Die fehlende Bestätigung wird nachgeholt.
    expect(merged.notes[0].sync?.version).toBe(1);
  });

  it('15: Notiz — abweichende Serverfassung bleibt ein Konflikt', () => {
    const local = { ...note({ body: 'Lokal ergänzt' }), sync: syncMeta(0, { version: 0 }) };
    const merged = mergeVorgangNotesFromPull(
      [local],
      [noteRow(note({ body: 'Fremd geändert' }), 1)],
      DEVICE,
      WORKSPACE,
      new Set([local.id]),
    );
    expect(merged.conflicts).toEqual(['vorgang_note:note-01g']);
    expect(merged.notes[0].body).toBe('Lokal ergänzt');
  });

  it('16: Aufgabe — Server trägt dieselbe Fassung mit höherer Version', () => {
    const local = { ...task(), sync: syncMeta(0, { version: 0 }) };
    const merged = mergeTasksFromPull(
      [local],
      [taskRow(task(), 1)],
      DEVICE,
      WORKSPACE,
      new Set([local.id]),
    );
    expect(merged.conflicts).toEqual([]);
    expect(merged.tasks[0].status).toBe('open');
    expect(merged.tasks[0].sync?.version).toBe(1);
  });

  it('17: Aufgabe — abweichender Serverstatus bleibt ein Konflikt', () => {
    const local = { ...task({ status: 'done' }), sync: syncMeta(0, { version: 0 }) };
    const merged = mergeTasksFromPull(
      [local],
      [taskRow(task({ status: 'open' }), 1)],
      DEVICE,
      WORKSPACE,
      new Set([local.id]),
    );
    expect(merged.conflicts).toEqual(['task:t-01g']);
    expect(merged.tasks[0].status).toBe('done');
  });

  it('18: Mahnnachweis — identischer Nachweis blockiert den Merge nicht', () => {
    const local = { ...dunningDoc(), sync: syncMeta(0, { version: 0 }) };
    const merged = mergeDunningDocumentationsFromPull(
      [local],
      [dunningRow(dunningDoc(), 1)],
      DEVICE,
      WORKSPACE,
      new Set([local.id]),
    );
    expect(merged.conflicts).toEqual([]);
    expect(merged.documentations[0].sync?.version).toBe(1);
  });

  it('19: Mahnnachweis — inhaltlich anderer Serverstand bleibt ein Konflikt', () => {
    const local = { ...dunningDoc({ deliveryMethod: 'post' }), sync: syncMeta(0, { version: 0 }) };
    const merged = mergeDunningDocumentationsFromPull(
      [local],
      [dunningRow(dunningDoc(), 1)],
      DEVICE,
      WORKSPACE,
      new Set([local.id]),
    );
    expect(merged.conflicts).toEqual(['dunning_documentation:dun-01g2']);
    expect(merged.documentations[0].deliveryMethod).toBe('post');
  });
});

describe('01G2 — Abschluss bleibt Abschluss', () => {
  const entry = (
    id: string,
    status: 'pending' | 'blocked' | 'completed' | 'error',
    version = 1,
  ) => ({
    id,
    entityType: 'vorgang_note' as const,
    entityId: 'note-01g',
    operation: 'update' as const,
    version,
    queuedAt: '2026-07-01T10:00:00.000Z',
    retryCount: 0,
    status,
  });

  it('20: ein gesendeter Auftrag fällt nicht auf pending zurück', async () => {
    const { mergeOutboxAfterPull } = await import('./syncOutboxMergeService');
    const merged = mergeOutboxAfterPull({
      prePull: [entry('a', 'pending')],
      afterPush: [entry('a', 'completed')],
      // Der Pull kennt die Push-Antwort nicht und hat den Eintrag angefasst.
      afterPull: [entry('a', 'pending', 2)],
    });
    expect(merged.find((item) => item.id === 'a')?.status).toBe('completed');
  });

  it('21: ein blockierter Auftrag darf vom Pull wieder angesetzt werden', async () => {
    const { mergeOutboxAfterPull } = await import('./syncOutboxMergeService');
    const merged = mergeOutboxAfterPull({
      prePull: [entry('a', 'blocked')],
      afterPush: [entry('a', 'blocked')],
      afterPull: [entry('a', 'pending')],
    });
    expect(merged.find((item) => item.id === 'a')?.status).toBe('pending');
  });

  it('22: ein Konflikt verschwindet nicht versehentlich als erledigt', async () => {
    const { mergeOutboxAfterPull } = await import('./syncOutboxMergeService');
    const merged = mergeOutboxAfterPull({
      prePull: [entry('a', 'pending')],
      afterPush: [entry('a', 'blocked')],
      afterPull: [entry('a', 'pending')],
    });
    expect(merged.find((item) => item.id === 'a')?.status).toBe('blocked');
  });
});
