/**
 * FINANZ-SYNC-BLOCKER-01F — der sichtbare Befund aus der Abnahme 01E, exakt
 * nachgestellt.
 *
 * Beobachtet wurde: Die Sync-Seite sagte „Der Cloud-Stand ist neuer. Bitte
 * entscheiden, welcher Stand gelten soll.", bot aber **keine** Entscheidung an;
 * `chartOfAccounts = SKR03` war während der Hydration verschwunden, die Anwendung
 * zeigte „Noch nicht festgelegt", und daneben stand „Verloren geht nichts."
 *
 * Zwei Ursachen lagen dahinter, und beide werden hier geprüft:
 *
 *   1. Der Feldmerge hing am Versionsvergleich. Griff er nicht, ersetzte der
 *      Pull das ganze lokale Einstellungsobjekt durch das der Cloud.
 *   2. Der Konflikt lag in einer Modulvariable, der blockierte Sendeauftrag in
 *      der Persistenz. Nach einem Reload behauptete der eine, was der andere
 *      nicht mehr belegen konnte.
 *
 * Neutrale Beispieldaten.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETUP } from '../../data/mockData';
import type { AppPersistedState } from '../../types/models';
import type { SyncOutboxEntry } from '../../types/sync';
import type { WorkspaceSettings } from '../../types/workspace';
import { mergeRemoteWorkspacePullIntoState } from './workspaceProvisioningService';
import {
  getPendingWorkspaceSettingsConflict,
  hasUnsyncedSettingsIntent,
  mergeWorkspaceSettings,
  resolveWorkspaceSettingsConflict,
} from './workspaceSettingsConflictService';
import {
  getWorkspaceSettingsSnapshot,
  hydrateWorkspaceStore,
  resetWorkspaceStore,
  setWorkspaceSettings,
} from './workspaceStore';
import { createSyncClient, resetSyncClientForTests } from '../sync/syncClientService';
import { getSyncOutboxSnapshot, resetSyncOutboxForTests } from '../sync/syncOutboxService';
import { STORAGE_VERSION } from '../sync/syncMigrationService';

const WORKSPACE = '00000000-0000-0000-0000-00000000f01f';
const AT = '2026-07-10T09:00:00.000Z';

function settings(
  values: Record<string, unknown>,
  version: number,
  extra: Partial<WorkspaceSettings> = {},
): WorkspaceSettings {
  return { workspaceId: WORKSPACE, settings: values, version, updatedAt: AT, ...extra };
}

function blockedEntry(): SyncOutboxEntry {
  return {
    id: 'ob-settings-01f',
    entityType: 'workspace_settings',
    entityId: WORKSPACE,
    operation: 'update',
    version: 2,
    queuedAt: AT,
    retryCount: 1,
    status: 'blocked',
    lastErrorMessage: 'Versionskonflikt',
  } as SyncOutboxEntry;
}

function state(local: WorkspaceSettings | null, outbox: SyncOutboxEntry[] = []): AppPersistedState {
  const client = createSyncClient();
  return {
    version: STORAGE_VERSION,
    syncClient: { ...client, serverWorkspaceId: WORKSPACE, workspaceId: WORKSPACE },
    syncOutbox: outbox,
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

/* ================================================================== */
/* A/B — der stille Verlust                                            */
/* ================================================================== */

describe('A/B — SKR03 verschwindet nicht mehr still', () => {
  it('A1: bei gleicher Versionsnummer wird nicht mehr pauschal ersetzt', () => {
    /*
     * Der Kern des Befunds. Vorher entschied allein der Versionsvergleich:
     * gleiche Nummer -> kein Merge -> das ganze lokale Objekt wurde durch das
     * der Cloud ersetzt, und SKR03 war weg.
     */
    const merge = mergeRemoteWorkspacePullIntoState(
      state(settings({ chartOfAccounts: 'SKR03' }, 2, { pendingKeys: ['chartOfAccounts'] }), [
        blockedEntry(),
      ]),
      pull(settings({ dunningEnabled: true }, 2)),
    );

    expect(merge.state.workspaceSettings?.settings.chartOfAccounts, 'die bewusste Wahl bleibt').toBe(
      'SKR03',
    );
    expect(merge.state.workspaceSettings?.settings.dunningEnabled, 'und der Cloud-Stand kommt an').toBe(
      true,
    );
  });

  it('A2: der genaue Ausgangszustand aus 01E — Cloud kennt das Feld nicht', () => {
    /*
     * Fall A des Auftrags: Die Cloud führt `chartOfAccounts` gar nicht. Dann
     * kann dort nichts überschrieben werden, es gibt keinen echten Widerspruch
     * und deshalb auch keine Rückfrage.
     */
    const merge = mergeRemoteWorkspacePullIntoState(
      state(settings({ chartOfAccounts: 'SKR03' }, 2), [blockedEntry()]),
      pull(settings({ companySettingA: 1, companySettingB: 'x' }, 5)),
    );

    const danach = merge.state.workspaceSettings!;
    expect(danach.settings).toEqual({
      companySettingA: 1,
      companySettingB: 'x',
      chartOfAccounts: 'SKR03',
    });
    expect(danach.conflict, 'kein unnötiger Benutzerkonflikt').toBeUndefined();
    expect(merge.conflicts).not.toContain('workspace_settings');
    expect(danach.pendingKeys, 'und es bleibt übertragbar').toEqual(['chartOfAccounts']);
  });

  it('A3: Fall B — beide Seiten tragen denselben Wert, nichts zu entscheiden', () => {
    const merge = mergeRemoteWorkspacePullIntoState(
      state(settings({ chartOfAccounts: 'SKR03' }, 2), [blockedEntry()]),
      pull(settings({ chartOfAccounts: 'SKR03', companySettingA: 1 }, 5)),
    );

    expect(merge.state.workspaceSettings?.conflict).toBeUndefined();
    expect(merge.conflicts).not.toContain('workspace_settings');
    expect(merge.state.workspaceSettings?.settings).toEqual({
      chartOfAccounts: 'SKR03',
      companySettingA: 1,
    });
  });

  it('A4: Fall C — echter Wertkonflikt, beide Stände bleiben erhalten', () => {
    const merge = mergeRemoteWorkspacePullIntoState(
      state(settings({ chartOfAccounts: 'SKR03' }, 2), [blockedEntry()]),
      pull(settings({ chartOfAccounts: 'SKR04', companySettingA: 1 }, 5)),
    );

    const felder = merge.state.workspaceSettings?.conflict?.fields ?? [];
    expect(felder).toEqual([
      { key: 'chartOfAccounts', localValue: 'SKR03', cloudValue: 'SKR04' },
    ]);
    expect(merge.conflicts).toContain('workspace_settings');
    expect(
      merge.state.workspaceSettings?.settings.companySettingA,
      'das Eindeutige ist schon übernommen',
    ).toBe(1);
  });

  it('A5: das Zeichen für „lokal steht etwas aus" ist nicht die Versionsnummer', () => {
    expect(hasUnsyncedSettingsIntent(settings({}, 2), true), 'offener Auftrag').toBe(true);
    expect(
      hasUnsyncedSettingsIntent(settings({}, 2, { pendingKeys: ['x'] }), false),
      'vermerkter Schreibvorgang',
    ).toBe(true);
    expect(
      hasUnsyncedSettingsIntent(
        settings({}, 2, { conflict: { fields: [{ key: 'x', localValue: 1, cloudValue: 2 }], detectedAt: AT } }),
        false,
      ),
      'festgehaltener Konflikt',
    ).toBe(true);
    expect(hasUnsyncedSettingsIntent(settings({}, 2), false), 'nichts davon').toBe(false);
  });
});

/* ================================================================== */
/* C/I — Reload                                                        */
/* ================================================================== */

describe('C/I — der Konflikt überlebt ein Neuladen', () => {
  it('I1: nach dem Reload stehen beide Werte und die Entscheidung weiterhin bereit', () => {
    const merge = mergeRemoteWorkspacePullIntoState(
      state(settings({ chartOfAccounts: 'SKR03' }, 2), [blockedEntry()]),
      pull(settings({ chartOfAccounts: 'SKR04', companySettingA: 1 }, 5)),
    );

    // Neustart: Speicher leeren, aus dem Persistenzstand füllen.
    resetWorkspaceStore();
    hydrateWorkspaceStore({ workspaceSettings: merge.state.workspaceSettings });

    const offen = getPendingWorkspaceSettingsConflict();
    expect(offen, 'genau das fehlte nach dem Reload').not.toBeNull();
    expect(offen?.undecided).toEqual([
      { key: 'chartOfAccounts', localValue: 'SKR03', cloudValue: 'SKR04' },
    ]);
    expect(getWorkspaceSettingsSnapshot()?.settings.companySettingA).toBe(1);
  });

  it('I2: ein zweiter Abgleich vergisst den offenen Wunsch nicht', () => {
    const erster = mergeWorkspaceSettings(
      settings({ chartOfAccounts: 'SKR03' }, 2),
      settings({ chartOfAccounts: 'SKR04' }, 5),
    );
    const zweiter = mergeWorkspaceSettings(erster.settings, settings({ chartOfAccounts: 'SKR04' }, 6));

    expect(zweiter.outcome).toBe('needs_decision');
    expect(zweiter.undecided.map((f) => f.localValue)).toEqual(['SKR03']);
  });
});

/* ================================================================== */
/* F/G — die beiden Entscheidungen                                     */
/* ================================================================== */

describe('F/G — local wins und cloud wins', () => {
  function konfliktLage(): void {
    const merge = mergeRemoteWorkspacePullIntoState(
      state(settings({ chartOfAccounts: 'SKR03' }, 2), [blockedEntry()]),
      pull(settings({ chartOfAccounts: 'SKR04', companySettingA: 1, companySettingB: 'x' }, 5)),
    );
    resetSyncOutboxForTests([blockedEntry()]);
    setWorkspaceSettings(merge.state.workspaceSettings!);
  }

  it('F1: „Wert dieses Geräts behalten" — nur das strittige Feld gewinnt', () => {
    konfliktLage();
    expect(resolveWorkspaceSettingsConflict('keep_local')).toBe(true);

    const danach = getWorkspaceSettingsSnapshot()!;
    expect(danach.settings).toEqual({
      chartOfAccounts: 'SKR03',
      companySettingA: 1,
      companySettingB: 'x',
    });
    expect(danach.conflict, 'der Konflikt ist beendet').toBeUndefined();
    expect(danach.version, 'die Cloud-Version ist die Basis für den Push').toBe(5);
    expect(danach.pendingKeys).toContain('chartOfAccounts');
  });

  it('F2: danach ist der Auftrag wieder sendbar', () => {
    konfliktLage();
    resolveWorkspaceSettingsConflict('keep_local');

    const auftrag = getSyncOutboxSnapshot()[0];
    expect(auftrag.status).toBe('pending');
    expect(auftrag.version, 'mit der Cloud-Version').toBe(5);
    expect(auftrag.lastErrorMessage).toBeUndefined();
  });

  it('G1: „Cloud-Wert übernehmen" — der Cloud-Wert gilt, nichts anderes geht verloren', () => {
    konfliktLage();
    expect(resolveWorkspaceSettingsConflict('take_cloud')).toBe(true);

    const danach = getWorkspaceSettingsSnapshot()!;
    expect(danach.settings.chartOfAccounts).toBe('SKR04');
    expect(danach.settings.companySettingA).toBe(1);
    expect(danach.settings.companySettingB).toBe('x');
    expect(danach.conflict).toBeUndefined();
  });

  it('G2: nach „Cloud-Wert übernehmen" bleibt kein Auftrag hängen', () => {
    konfliktLage();
    resolveWorkspaceSettingsConflict('take_cloud');

    const auftrag = getSyncOutboxSnapshot()[0];
    expect(auftrag.status, 'es gibt nichts mehr zu senden').toBe('completed');
    expect(
      getSyncOutboxSnapshot().some((e) => e.status === 'pending' || e.status === 'blocked'),
      'kein Restauftrag',
    ).toBe(false);
  });

  it('G3: ohne offenen Konflikt tut die Auflösung nichts', () => {
    expect(resolveWorkspaceSettingsConflict('keep_local')).toBe(false);
  });

  it('H1: der Legacy-Zustand ohne Vermerk führt zur Entscheidung statt zum Verlust', () => {
    /*
     * Kein `pendingKeys` — der Eintrag stammt aus der Zeit vor 01B. Die
     * Änderungsabsicht ist nicht sicher rekonstruierbar, also wird weder ein
     * Wert erfunden noch einer still verworfen.
     */
    const merge = mergeRemoteWorkspacePullIntoState(
      state(settings({ chartOfAccounts: 'SKR03' }, 2), [blockedEntry()]),
      pull(settings({ chartOfAccounts: 'SKR04' }, 5)),
    );

    expect(merge.state.workspaceSettings?.conflict?.fields).toHaveLength(1);
    expect(merge.state.workspaceSettings?.conflict?.fields[0]).toMatchObject({
      localValue: 'SKR03',
      cloudValue: 'SKR04',
    });
  });
});

/* ================================================================== */
/* 8 — bestehende Cloud-Einstellungen                                  */
/* ================================================================== */

describe('8 — bestehende Cloud-Einstellungen überleben jede Auflösung', () => {
  const cloudVoll = { companySettingA: 1, companySettingB: 'x', chartOfAccounts: 'SKR04' };

  it('8a: nach „lokal behalten" bleiben A und B erhalten', () => {
    const merge = mergeWorkspaceSettings(
      settings({ chartOfAccounts: 'SKR03' }, 2),
      settings({ ...cloudVoll }, 5),
    );
    resetSyncOutboxForTests([blockedEntry()]);
    setWorkspaceSettings(merge.settings);
    resolveWorkspaceSettingsConflict('keep_local');

    expect(getWorkspaceSettingsSnapshot()?.settings).toEqual({
      companySettingA: 1,
      companySettingB: 'x',
      chartOfAccounts: 'SKR03',
    });
  });

  it('8b: nach „Cloud übernehmen" bleiben A und B erhalten', () => {
    const merge = mergeWorkspaceSettings(
      settings({ chartOfAccounts: 'SKR03' }, 2),
      settings({ ...cloudVoll }, 5),
    );
    resetSyncOutboxForTests([blockedEntry()]);
    setWorkspaceSettings(merge.settings);
    resolveWorkspaceSettingsConflict('take_cloud');

    expect(getWorkspaceSettingsSnapshot()?.settings).toEqual(cloudVoll);
  });
});
