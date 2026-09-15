/**
 * PRODUCT-BASIS-FIRMENPROFIL-01B — Versionsdrift ohne lokale Aenderung.
 *
 *  D  sauberes Geraet mit aelterem Stand uebernimmt den neueren Cloud-Stand
 *     (inkl. currency/replyToEmail/defaultTaxStatus) — kein Konflikt, kein local-wins
 *  E  lokal ungesendete Aenderung + neuerer Cloud-Stand -> bestehender Konfliktpfad
 *  E' Cloud faellt hinter den lokalen Stand zurueck -> Konflikt
 *  E'' andere Firmenidentitaet in der Cloud -> Konflikt (Identity-Recovery)
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { mergeRemoteWorkspacePullIntoState } from './workspaceProvisioningService';
import { DEFAULT_SETUP } from '../../data/mockData';
import { DEFAULT_COMPANY_PROFILE } from '../../data/companyProfileDefaults';
import { createSyncClient } from '../sync/syncClientService';
import { resetSyncOutboxForTests } from '../sync/syncOutboxService';
import { resetTestStores } from '../../test/resetStores';
import type { AppPersistedState } from '../../types/models';
import type { SyncOutboxEntry } from '../../types/sync';

const WS = 'drift-ws';
const COMPANY = 'Cirmak Haustechnik GmbH';

function state(input: { profileVersion: number; outbox?: SyncOutboxEntry[]; companyName?: string }): AppPersistedState {
  return {
    version: 5,
    setup: { ...DEFAULT_SETUP, companyName: input.companyName ?? COMPANY, setupComplete: true, setupVersion: 1, taxStatus: 'standard_19' },
    companyProfile: { ...DEFAULT_COMPANY_PROFILE, companyName: input.companyName ?? COMPANY, street: 'Werkstraße 12', email: 'info@cirmak.example', city: 'Lemgo' },
    setupSync: { version: 1, updatedAt: '2026-09-01T10:00:00.000Z', deleted: false, deviceId: 'd2', workspaceId: WS },
    companyProfileSync: { version: input.profileVersion, updatedAt: '2026-09-01T10:00:00.000Z', deleted: false, deviceId: 'd2', workspaceId: WS },
    syncClient: { ...createSyncClient(), serverWorkspaceId: WS, workspaceId: WS },
    inboxItems: [], vorgaenge: [], tasks: [], documents: [], expenses: [], customers: [],
    syncOutbox: input.outbox ?? [],
    savedAt: '2026-09-01T10:00:00.000Z',
  } as unknown as AppPersistedState;
}

function pull(input: { profileVersion: number; companyName?: string }) {
  return {
    workspace: null, members: [], settings: null,
    setupPayload: { ...DEFAULT_SETUP, companyName: input.companyName ?? COMPANY, setupComplete: true, setupVersion: 1, taxStatus: 'tax_free' } as unknown as Record<string, unknown>,
    setupRowVersion: 1, setupUpdatedAt: '2026-09-02T10:00:00.000Z',
    companyProfilePayload: {
      ...DEFAULT_COMPANY_PROFILE, companyName: input.companyName ?? COMPANY, street: 'Werkstraße 12', email: 'info@cirmak.example', city: 'Detmold',
      currency: 'EUR', replyToEmail: 'rechnung@cirmak.example', defaultTaxStatus: 'tax_free',
    } as unknown as Record<string, unknown>,
    companyProfileRowVersion: input.profileVersion, companyProfileUpdatedAt: '2026-09-02T10:00:00.000Z',
    vorgaenge: [], customers: [],
  };
}

const dirtyEntry: SyncOutboxEntry = { id: 'o1', entityType: 'company_profile', entityId: WS, operation: 'update', version: 1, queuedAt: 'x', retryCount: 0, status: 'pending' };

describe('01B — Profil-Drift', () => {
  beforeEach(() => { resetTestStores(); resetSyncOutboxForTests([]); });

  it('D: sauber + Cloud neuer -> uebernommen, Version nachgefuehrt, neue Felder da', () => {
    const merged = mergeRemoteWorkspacePullIntoState(state({ profileVersion: 1 }), pull({ profileVersion: 2 }) as never);
    expect(merged.conflicts).not.toContain('company_profile');
    expect(merged.state.companyProfile).toMatchObject({ city: 'Detmold', currency: 'EUR', replyToEmail: 'rechnung@cirmak.example', defaultTaxStatus: 'tax_free' });
    expect(merged.state.companyProfileSync?.version).toBe(2);
  });

  it('E: lokal ungesendet + Cloud neuer -> Konflikt, lokal bleibt', () => {
    resetSyncOutboxForTests([dirtyEntry]);
    const merged = mergeRemoteWorkspacePullIntoState(state({ profileVersion: 1, outbox: [dirtyEntry] }), pull({ profileVersion: 2 }) as never);
    expect(merged.conflicts).toContain('company_profile');
    expect(merged.state.companyProfile?.city).toBe('Lemgo');
  });

  it("E': Cloud hinter lokal -> Konflikt", () => {
    const merged = mergeRemoteWorkspacePullIntoState(state({ profileVersion: 5 }), pull({ profileVersion: 2 }) as never);
    expect(merged.conflicts).toContain('company_profile');
    expect(merged.state.companyProfile?.city).toBe('Lemgo');
  });

  it("E'': andere Firmenidentitaet in der Cloud -> Konflikt trotz sauberem lokalem Stand", () => {
    const merged = mergeRemoteWorkspacePullIntoState(state({ profileVersion: 1 }), pull({ profileVersion: 2, companyName: 'Fremdbetrieb GmbH' }) as never);
    expect(merged.conflicts).toContain('company_profile');
    expect(merged.state.companyProfile?.companyName).toBe(COMPANY);
  });

  it('Schreibweise derselben Firma ist keine andere Identitaet', () => {
    const merged = mergeRemoteWorkspacePullIntoState(state({ profileVersion: 1, companyName: 'Çırmak Haustechnik GmbH' }), pull({ profileVersion: 2 }) as never);
    expect(merged.conflicts).not.toContain('company_profile');
    expect(merged.state.companyProfile?.currency).toBe('EUR');
  });
});
