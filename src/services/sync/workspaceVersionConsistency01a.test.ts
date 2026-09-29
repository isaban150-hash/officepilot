/**
 * SYNC-AUTOMATIK-01A — Erkenntnis 2: die wiederkehrende Meldung
 * „1 automatisch zusammengeführt".
 *
 * Ursache: Nach einem bestätigten Workspace-Push stieg nur `workspace.version`,
 * `workspace.sync.version` blieb stehen (beobachtet: 2 / 1). Der nächste Pull
 * verglich die alte Sync-Version mit der Serverversion und zählte bei jedem
 * vollständigen Lauf erneut einen Konflikt.
 *
 * Neutrale Beispieldaten.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_SETUP } from '../../data/mockData';
import type { AppPersistedState } from '../../types/models';
import type { Workspace } from '../../types/workspace';
import { createSyncClient } from './syncClientService';
import { STORAGE_VERSION } from './syncMigrationService';
import { applyPushResultToState } from './supabaseSyncAdapter';
import { mergeRemoteWorkspacePullIntoState } from '../workspace/workspaceProvisioningService';
import { extractCloudSyncEntity } from '../workspace/workspaceSyncPayloadService';

const WORKSPACE = 'ws-version-01a';
const UPDATED_AT = '2026-09-26T09:00:00.000Z';

function workspace(version: number, syncVersion: number): Workspace {
  return {
    id: WORKSPACE,
    name: 'Beispiel Betrieb',
    ownerUserId: 'user-01a',
    createdAt: UPDATED_AT,
    updatedAt: UPDATED_AT,
    version,
    sync: { version: syncVersion, updatedAt: UPDATED_AT, deleted: false, deviceId: 'dev-a', workspaceId: WORKSPACE },
  };
}

function state(ws: Workspace): AppPersistedState {
  const client = createSyncClient();
  return {
    version: STORAGE_VERSION,
    syncClient: { ...client, serverWorkspaceId: WORKSPACE, workspaceId: WORKSPACE },
    syncOutbox: [],
    workspace: ws,
    setup: DEFAULT_SETUP,
    vorgaenge: [],
    customers: [],
    inboxItems: [],
    tasks: [],
    documents: [],
    savedAt: UPDATED_AT,
  } as AppPersistedState;
}

/** Ein unveränderter Cloud-Stand: nur der Workspace, sonst nichts Neues. */
function unchangedPull(remoteVersion: number) {
  return {
    workspace: {
      id: WORKSPACE,
      name: 'Beispiel Betrieb',
      ownerUserId: 'user-01a',
      createdAt: UPDATED_AT,
      updatedAt: '2026-09-26T09:05:00.000Z',
      version: remoteVersion,
    },
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
  } as unknown as Parameters<typeof mergeRemoteWorkspacePullIntoState>[1];
}

describe('SYNC-AUTOMATIK-01A — Workspace-Versionen nach dem Push', () => {
  it('Test 3: erfolgreicher Workspace-Push setzt version und sync.version gemeinsam', () => {
    const next = applyPushResultToState(state(workspace(1, 1)), 'workspace', WORKSPACE, 2, '2026-09-26T09:05:00.000Z');
    expect(next.workspace?.version).toBe(2);
    expect(next.workspace?.sync?.version).toBe(2);
    expect(next.workspace?.sync?.updatedAt).toBe('2026-09-26T09:05:00.000Z');
    // Der nächste Push erwartet die bestätigte Version, nicht die alte.
    const extracted = extractCloudSyncEntity(next, 'workspace', WORKSPACE);
    expect(extracted?.rowVersion).toBe(2);
  });

  it('Test 4: der nächste unveränderte Full Pull erzeugt keine Zusammenführung (conflictCount 0)', () => {
    const afterPush = applyPushResultToState(state(workspace(1, 1)), 'workspace', WORKSPACE, 2, UPDATED_AT);
    const first = mergeRemoteWorkspacePullIntoState(afterPush, unchangedPull(2));
    expect(first.conflicts).toEqual([]);
    // Auch der Lauf danach — die Meldung darf nicht wiederkehren.
    const second = mergeRemoteWorkspacePullIntoState(first.state, unchangedPull(2));
    expect(second.conflicts).toEqual([]);
    expect(second.state.workspace?.version).toBe(2);
  });

  it('Bestand mit der alten Abweichung (version 2 / sync.version 1) heilt ohne Merge-Ereignis', () => {
    const legacy = state(workspace(2, 1));
    expect(mergeRemoteWorkspacePullIntoState(legacy, unchangedPull(2)).conflicts).toEqual([]);
    expect(extractCloudSyncEntity(legacy, 'workspace', WORKSPACE)?.rowVersion).toBe(2);
  });

  it('eine echte Abweichung bleibt ein Konflikt — kein stilles Übernehmen', () => {
    const local = state(workspace(2, 2));
    expect(mergeRemoteWorkspacePullIntoState(local, unchangedPull(3)).conflicts).toEqual(['workspace']);
  });
});
