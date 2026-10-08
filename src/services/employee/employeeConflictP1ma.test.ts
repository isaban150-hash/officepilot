/**
 * P1 MITARBEITERZAHLUNGEN — Mitarbeiterkonflikt entscheidbar (Abschlussphase).
 *
 * Gefunden in der echten A/B-Abnahme: Ein veraltetes Gerät änderte einen
 * Mitarbeiter, der Server wies ab („Versionskonflikt employee:2"), und danach
 * lief jede weitere Änderung mit der alten Basisversion erneut in denselben
 * Konflikt. Die Sync-Seite bat um eine Entscheidung, bot aber keine an.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as persistence from '../persistenceService';
import { getSyncOutboxSnapshot, resetSyncOutboxForTests } from '../sync/syncOutboxService';
import { getSyncUiSnapshot, summarizeSyncStatus } from '../sync/syncUiService';
import { extractCloudSyncEntity } from '../workspace/workspaceSyncPayloadService';
import { resetTestStores } from '../../test/resetStores';
import { getEmployeeFromStore, hydrateEmployeeStore } from './employeeStore';
import { pushEmployeeEntity, type CloudEmployeeRow, type EmployeeCloudPull } from './employeeCloudSyncService';
import { listEmployeeConflicts, resolveEmployeeConflict } from './employeeConflictService';
import type { Employee } from '../../types/employee';
import type { AppPersistedState } from '../../types/models';
import type { SyncOutboxEntry } from '../../types/sync';

const WS = '00000000-0000-4000-8000-0000000e1c01';

function lokal(name: string, version: number): Employee {
  return {
    id: 'emp-2',
    name,
    active: true,
    createdAt: '2026-10-08T10:00:00.000Z',
    updatedAt: '2026-10-08T11:50:00.000Z',
    sync: { updatedAt: '2026-10-08T11:50:00.000Z', version, deleted: false, deviceId: 'dev-b', workspaceId: 'local-ws-b' },
  };
}

function cloudRow(name: string, version: number): CloudEmployeeRow {
  return {
    client_employee_id: 'emp-2',
    name,
    personnel_number: null,
    active: true,
    row_version: version,
    created_at: '2026-10-08T10:00:00.000Z',
    updated_at: '2026-10-08T11:51:00.000Z',
  } as CloudEmployeeRow;
}

function pullWith(rows: CloudEmployeeRow[]): () => Promise<EmployeeCloudPull> {
  return async () => ({ employees: rows, payments: [] });
}

function konflikt(message = 'Versionskonflikt employee:2'): SyncOutboxEntry {
  return {
    id: 'ob-emp-2',
    entityType: 'employee',
    entityId: 'emp-2',
    operation: 'update',
    version: 1,
    queuedAt: 'x',
    retryCount: 1,
    status: 'blocked',
    lastErrorMessage: message,
    lastErrorAt: 'x',
    lastErrorRetryable: false,
  };
}

/** Ein Server mit Versionsvertrag: nur die aktuelle Basisversion wird angenommen. */
function server(startVersion: number) {
  let version = startVersion;
  const aufrufe: Array<Record<string, unknown>> = [];
  const client = {
    rpc: async (_name: string, params: Record<string, unknown>) => {
      aufrufe.push(params);
      if (params.p_row_version !== version) {
        return { data: null, error: { message: `Versionskonflikt employee:${version}`, code: 'P0001' } };
      }
      version += 1;
      return { data: { row_version: version, replayed: false, client_employee_id: 'emp-2' }, error: null };
    },
  } as unknown as SupabaseClient;
  return { client, aufrufe, bump: () => { version += 1; } };
}

beforeEach(() => {
  resetTestStores();
  resetSyncOutboxForTests([]);
  vi.spyOn(persistence, 'buildPersistedStateSnapshot').mockImplementation(() => ({ syncClient: { serverWorkspaceId: WS } }) as never);
});
afterEach(() => {
  vi.restoreAllMocks();
  resetSyncOutboxForTests([]);
  resetTestStores();
});

describe('Mitarbeiterkonflikt erkennen und einmal darstellen', () => {
  it('ein blockierter Mitarbeiterauftrag mit Versionskonflikt ist eine Entscheidung — nicht zusätzlich „wartet" oder „nicht übertragen"', () => {
    hydrateEmployeeStore([lokal('Max Probe-B', 1)]);
    resetSyncOutboxForTests([konflikt()]);

    expect(listEmployeeConflicts()).toEqual([{ outboxId: 'ob-emp-2', employeeId: 'emp-2', name: 'Max Probe-B' }]);
    const snapshot = getSyncUiSnapshot();
    expect(snapshot.employeeConflicts).toHaveLength(1);
    expect(snapshot.pendingOutboxEntries.some((entry) => entry.id === 'ob-emp-2')).toBe(false);
    expect(snapshot.failedOutboxEntries.some((entry) => entry.outboxId === 'ob-emp-2')).toBe(false);
    const summary = summarizeSyncStatus(snapshot);
    expect(summary.conflictCount).toBe(1);
    expect(summary.waitingCount).toBe(0);
  });

  it('ein anders blockierter Auftrag ist keine Mitarbeiterentscheidung', () => {
    hydrateEmployeeStore([lokal('Max Probe-B', 1)]);
    resetSyncOutboxForTests([konflikt('Keine Schreibberechtigung')]);
    expect(listEmployeeConflicts()).toEqual([]);
  });
});

describe('Online-Version verwenden', () => {
  it('übernimmt den frisch gelesenen Cloud-Stand und erledigt den Auftrag — kein erneuter Push der alten Änderung', async () => {
    hydrateEmployeeStore([lokal('Max Probe-B', 1)]);
    resetSyncOutboxForTests([konflikt()]);

    const ergebnis = await resolveEmployeeConflict('emp-2', 'take_cloud', { pullEmployees: pullWith([cloudRow('Max Probe-A', 2)]) });

    expect(ergebnis).toEqual({ ok: true, decision: 'take_cloud', cloudVersion: 2 });
    expect(getEmployeeFromStore('emp-2')?.name).toBe('Max Probe-A');
    expect(getEmployeeFromStore('emp-2')?.sync?.version).toBe(2);
    expect(getSyncOutboxSnapshot().find((entry) => entry.id === 'ob-emp-2')?.status).toBe('completed');
    expect(listEmployeeConflicts()).toEqual([]);
  });
});

describe('Änderungen dieses Geräts behalten', () => {
  it('bleibt beim lokalen Inhalt, nimmt die gelesene Cloud-Version als Basis — der nächste Push gelingt', async () => {
    hydrateEmployeeStore([lokal('Max Probe-B', 1)]);
    resetSyncOutboxForTests([konflikt()]);

    const ergebnis = await resolveEmployeeConflict('emp-2', 'keep_local', { pullEmployees: pullWith([cloudRow('Max Probe-A', 2)]) });
    expect(ergebnis).toEqual({ ok: true, decision: 'keep_local', cloudVersion: 2 });
    expect(getEmployeeFromStore('emp-2')?.name).toBe('Max Probe-B');
    const auftrag = getSyncOutboxSnapshot().find((entry) => entry.id === 'ob-emp-2');
    expect(auftrag?.status).toBe('pending');
    expect(auftrag?.version).toBe(2);

    const s = server(2);
    const state = { employees: [getEmployeeFromStore('emp-2')], syncClient: { serverWorkspaceId: WS } } as unknown as AppPersistedState;
    const extrahiert = extractCloudSyncEntity(state, 'employee', 'emp-2');
    const gesendet = await pushEmployeeEntity(extrahiert as never, 'update', WS, s.client);
    expect(s.aufrufe[0]).toMatchObject({ p_row_version: 2 });
    expect(gesendet).toEqual({ kind: 'pushed', rowVersion: 3 });
  });

  it('hat sich die Cloud inzwischen erneut geändert, entsteht wieder ein Konflikt — nie ein stilles Überschreiben', async () => {
    hydrateEmployeeStore([lokal('Max Probe-B', 1)]);
    resetSyncOutboxForTests([konflikt()]);
    await resolveEmployeeConflict('emp-2', 'keep_local', { pullEmployees: pullWith([cloudRow('Max Probe-A', 2)]) });

    const s = server(2);
    s.bump();
    const state = { employees: [getEmployeeFromStore('emp-2')], syncClient: { serverWorkspaceId: WS } } as unknown as AppPersistedState;
    await expect(
      pushEmployeeEntity(extractCloudSyncEntity(state, 'employee', 'emp-2') as never, 'update', WS, s.client),
    ).rejects.toThrow(/Versionskonflikt employee:3/);
  });
});

describe('ohne frischen Cloud-Stand bleibt alles, wie es war', () => {
  it('Cloud nicht erreichbar', async () => {
    hydrateEmployeeStore([lokal('Max Probe-B', 1)]);
    resetSyncOutboxForTests([konflikt()]);
    const ergebnis = await resolveEmployeeConflict('emp-2', 'take_cloud', {
      pullEmployees: async () => {
        throw new Error('offline');
      },
    });
    expect(ergebnis).toEqual({ ok: false, reason: 'cloud_unavailable' });
    expect(getEmployeeFromStore('emp-2')?.name).toBe('Max Probe-B');
    expect(getSyncOutboxSnapshot().find((entry) => entry.id === 'ob-emp-2')?.status).toBe('blocked');
  });

  it('kein Konfliktauftrag', async () => {
    hydrateEmployeeStore([lokal('Max Probe-B', 1)]);
    resetSyncOutboxForTests([]);
    const ergebnis = await resolveEmployeeConflict('emp-2', 'take_cloud', { pullEmployees: pullWith([cloudRow('Max Probe-A', 2)]) });
    expect(ergebnis).toEqual({ ok: false, reason: 'not_found' });
    expect(getEmployeeFromStore('emp-2')?.name).toBe('Max Probe-B');
  });
});
