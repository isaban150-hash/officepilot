/**
 * FINANZ-SYNC-BLOCKER-01B — Einstellungen über Pull, Reload und Push hinweg.
 *
 * Geprüft wird der Weg, nicht nur die Rechenregel: Was der Abgleich entscheidet,
 * muss den Neustart überstehen und danach übertragbar sein.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETUP } from '../../data/mockData';
import type { AppPersistedState } from '../../types/models';
import type { WorkspaceSettings } from '../../types/workspace';
import { mergeRemoteWorkspacePullIntoState } from './workspaceProvisioningService';
import { getPendingWorkspaceSettingsConflict } from './workspaceSettingsConflictService';
import {
  createDefaultWorkspaceSettings,
  getWorkspaceSettingsSnapshot,
  hydrateWorkspaceStore,
  resetWorkspaceStore,
  updateWorkspaceSettingsLocally,
} from './workspaceStore';
import { createSyncClient, resetSyncClientForTests } from '../sync/syncClientService';
import { resetSyncOutboxForTests } from '../sync/syncOutboxService';
import { STORAGE_VERSION } from '../sync/syncMigrationService';

const WORKSPACE = '00000000-0000-0000-0000-00000000f01c';
const AT = '2026-07-10T09:00:00.000Z';

function settings(values: Record<string, unknown>, version: number, pendingKeys?: string[]): WorkspaceSettings {
  return { workspaceId: WORKSPACE, settings: values, version, updatedAt: AT, pendingKeys };
}

function state(
  local: WorkspaceSettings | null,
  /*
   * FINANZ-SYNC-BLOCKER-01F — ob ein Sendeauftrag offen ist, entscheidet, ob
   * lokal überhaupt etwas aussteht. Ohne dieses Zeichen ist ein abweichender
   * lokaler Wert nur ein veralteter, und der Cloud-Stand darf gelten.
   */
  offenerAuftrag = false,
): AppPersistedState {
  const client = createSyncClient();
  return {
    version: STORAGE_VERSION,
    syncClient: { ...client, serverWorkspaceId: WORKSPACE, workspaceId: WORKSPACE },
    syncOutbox: offenerAuftrag
      ? [
          {
            id: 'ob-settings',
            entityType: 'workspace_settings',
            entityId: WORKSPACE,
            operation: 'update',
            version: 2,
            queuedAt: AT,
            retryCount: 1,
            status: 'blocked',
          },
        ]
      : [],
    setup: DEFAULT_SETUP,
    vorgaenge: [],
    customers: [],
    inboxItems: [],
    tasks: [],
    documents: [],
    workspaceSettings: local ?? undefined,
    savedAt: AT,
  } as AppPersistedState;
}

function pull(cloud: WorkspaceSettings | null) {
  return {
    workspace: null,
    members: [],
    settings: cloud,
    setupPayload: null,
    setupRowVersion: 0,
    setupUpdatedAt: null,
    companyProfilePayload: null,
    companyProfileRowVersion: 0,
    companyProfileUpdatedAt: null,
    vorgaenge: [],
    customers: [],
  } as Parameters<typeof mergeRemoteWorkspacePullIntoState>[1];
}

beforeEach(() => {
  localStorage.clear();
  resetWorkspaceStore();
  resetSyncOutboxForTests([]);
  resetSyncClientForTests(createSyncClient());
});

describe('K — der Abgleich übernimmt den neueren Cloud-Stand', () => {
  /*
   * FINANZ-SYNC-BLOCKER-01G — hier stand bis 01F, dass eine bekannte Absicht
   * einen Wertwiderspruch **stillschweigend** zugunsten des lokalen Werts
   * auflöst. Das war dasselbe Raten in die andere Richtung: Ein Wert, den
   * jemand auf einem zweiten Gerät bewusst gesetzt hat, wäre ohne Frage
   * verschwunden. Zusammengeführt wird ohne Rückfrage nur noch, was die Cloud
   * gar nicht führt.
   */
  it('K5: bei bekannter Absicht wird ein Feld ergänzt, das die Cloud nicht kennt', () => {
    const merge = mergeRemoteWorkspacePullIntoState(
      state(settings({ chartOfAccounts: 'SKR03' }, 2, ['chartOfAccounts'])),
      pull(settings({ dunningEnabled: true }, 5)),
    );

    expect(merge.conflicts, 'eine auflösbare Abweichung ist kein Streitfall').not.toContain(
      'workspace_settings',
    );
    expect(merge.state.workspaceSettings?.settings).toEqual({
      chartOfAccounts: 'SKR03',
      dunningEnabled: true,
    });
    /*
     * FINANZ-SYNC-BLOCKER-01F — der Konflikt liegt seit 01F **am
     * Einstellungsobjekt** statt in einer Modulvariable; nur so übersteht er
     * einen Reload. Geprüft wird deshalb dort.
     */
    expect(merge.state.workspaceSettings?.conflict).toBeUndefined();
  });

  it('K5b: bekannte Absicht und echter Wertwiderspruch — es wird gefragt', () => {
    const merge = mergeRemoteWorkspacePullIntoState(
      state(settings({ chartOfAccounts: 'SKR03' }, 2, ['chartOfAccounts'])),
      pull(settings({ chartOfAccounts: 'SKR04', dunningEnabled: true }, 5)),
    );

    expect(merge.conflicts).toContain('workspace_settings');
    expect(merge.state.workspaceSettings?.conflict?.fields).toEqual([
      { key: 'chartOfAccounts', localValue: 'SKR03', cloudValue: 'SKR04' },
    ]);
  });

  it('K6a: Cloud neuer und lokal nichts ausstehend — die Cloud gilt ohne Rückfrage', () => {
    /*
     * Ein Gerät, das schlicht hinterher ist. Es gibt keinen Vermerk, keinen
     * offenen Auftrag und keinen festgehaltenen Konflikt — also auch keinen
     * Grund, den Nutzer zu fragen.
     */
    const merge = mergeRemoteWorkspacePullIntoState(
      state(settings({ chartOfAccounts: 'SKR03' }, 2)),
      pull(settings({ chartOfAccounts: 'SKR04', dunningEnabled: true }, 5)),
    );

    expect(merge.conflicts).not.toContain('workspace_settings');
    expect(merge.state.workspaceSettings?.settings.chartOfAccounts).toBe('SKR04');
    expect(merge.state.workspaceSettings?.conflict).toBeUndefined();
  });

  it('K6: bei unbekannter Absicht und echtem Widerspruch entsteht eine offene Entscheidung', () => {
    /*
     * Die Lage aus der Abnahme 01E: ein blockierter Sendeauftrag belegt, dass
     * lokal etwas aussteht — welches Feld, sagt er nicht.
     */
    const merge = mergeRemoteWorkspacePullIntoState(
      state(settings({ chartOfAccounts: 'SKR03' }, 2), true),
      pull(settings({ chartOfAccounts: 'SKR04', dunningEnabled: true }, 5)),
    );

    expect(merge.conflicts).toContain('workspace_settings');
    const offen = merge.state.workspaceSettings?.conflict;
    expect(offen?.fields.map((item) => item.key)).toEqual(['chartOfAccounts']);
    expect(
      merge.state.workspaceSettings?.settings.dunningEnabled,
      'der neuere Cloud-Stand kommt trotzdem an — vorher kam er nie',
    ).toBe(true);
  });

  it('K7: derselbe Stand auf beiden Seiten löst gar nichts aus', () => {
    const merge = mergeRemoteWorkspacePullIntoState(
      state(settings({ chartOfAccounts: 'SKR03' }, 2)),
      pull(settings({ chartOfAccounts: 'SKR03' }, 5)),
    );

    expect(merge.conflicts).not.toContain('workspace_settings');
    expect(merge.state.workspaceSettings?.conflict).toBeUndefined();
    expect(getPendingWorkspaceSettingsConflict(), 'nichts im Speicher offen').toBeNull();
  });
});

describe('K — Reload verliert keine Einstellung', () => {
  it('K8: der Schreibweg merkt sich, welches Feld bewusst gesetzt wurde', () => {
    createDefaultWorkspaceSettings(WORKSPACE);
    updateWorkspaceSettingsLocally({ chartOfAccounts: 'SKR03' });

    expect(getWorkspaceSettingsSnapshot()?.pendingKeys).toEqual(['chartOfAccounts']);
  });

  it('K9: nach einem Neuladen stehen Wert und Vermerk unverändert da', () => {
    createDefaultWorkspaceSettings(WORKSPACE);
    updateWorkspaceSettingsLocally({ chartOfAccounts: 'SKR03' });
    const gespeichert = getWorkspaceSettingsSnapshot()!;

    // Neustart: Der Speicher wird geleert und aus dem Persistenzstand gefüllt.
    resetWorkspaceStore();
    hydrateWorkspaceStore({ workspaceSettings: gespeichert });

    const danach = getWorkspaceSettingsSnapshot();
    expect(danach?.settings.chartOfAccounts).toBe('SKR03');
    expect(danach?.pendingKeys, 'ohne Vermerk müsste der Abgleich wieder raten').toEqual([
      'chartOfAccounts',
    ]);
  });

  it('K10: zwei Änderungen hintereinander sammeln beide Felder', () => {
    createDefaultWorkspaceSettings(WORKSPACE);
    updateWorkspaceSettingsLocally({ chartOfAccounts: 'SKR03' });
    updateWorkspaceSettingsLocally({ dunningEnabled: false });

    expect(getWorkspaceSettingsSnapshot()?.pendingKeys).toEqual(['chartOfAccounts', 'dunningEnabled']);
  });
});
