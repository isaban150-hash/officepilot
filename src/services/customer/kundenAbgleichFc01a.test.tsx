/**
 * FINANZ-CORE-01A (WEISS-Nacharbeit N04/N05) — der Kundenabgleich.
 *
 * WEISS N04: lokale Version 1 mit neuer, ungesicherter Straße, Cloud-Version 2 mit anderer
 * Straße — das Ergebnis enthielt die Cloud-Straße, ohne Konflikt. WEISS N05: ein einziger
 * Kundenkonflikt verhinderte die Übernahme jedes anderen, unabhängigen Cloud-Kunden; ein
 * Mitglied bekam ein speicherbares Kundenformular.
 *
 *  M1–M6  Merge mit Dirty-Zustand: ungesicherte Änderung bleibt (Konflikt), gleicher Inhalt
 *         wird übernommen, ohne Auftrag gewinnt die neuere Cloud; eigene wartende Änderung
 *         bei gleicher Version ist kein Konflikt; Grabstein löscht keine ungesicherte
 *         Änderung; endgültig abgewiesene Änderung nimmt den Cloud-Stand an
 *  P1–P2  Bereitstellung: ein Konflikt isoliert nur seine Zeile; Abweisungsrücknahme
 *  A1–A3  Auflösung auf der Sync-Seite: Online-Version / Gerät behalten / Lesefehler
 *  F1–F3  Formulare: Mitglied ohne Anlegen/Bearbeiten, Inhaber mit; „neuer Kunde" entfällt
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mergeCustomersFromPull, type WorkspaceCustomerRow } from './customerCloudService';
import { listCustomerConflicts, resolveCustomerConflict } from './customerConflictService';
import { mergeRemoteWorkspacePullIntoState } from '../workspace/workspaceProvisioningService';
import { buildPersistedStateSnapshot } from '../persistenceService';
import { getCustomerById, hydrateCustomerStore } from '../customerStoreService';
import { getSyncOutboxSnapshot, resetSyncOutboxForTests } from '../sync/syncOutboxService';
import { resetSyncChangeTrackerForTests } from '../sync/syncChangeTrackerService';
import { createSyncClient, resetSyncClientForTests } from '../sync/syncClientService';
import { summarizeSyncStatus } from '../sync/syncUiService';
import { AppProvider } from '../../context/AppContext';
import { CustomerDecisionChoice } from '../../components/customer/CustomerDecisionChoice';
import { KundenPage } from '../../pages/KundenPage';
import { KundenDetailPage } from '../../pages/KundenDetailPage';
import { DEFAULT_SETUP } from '../../data/mockData';
import { alsInhaber, alsMitglied } from '../../test/workspaceRoleTestUtils';
import { resetTestStores } from '../../test/resetStores';
import type { AppPersistedState, Customer } from '../../types/models';
import type { SyncMeta, SyncOutboxEntry } from '../../types/sync';

const DEVICE = 'device-n04';
const WORKSPACE = 'ws-n04';

function syncMeta(version: number): SyncMeta {
  return { updatedAt: '2026-10-01T10:00:00.000Z', version, deleted: false, deviceId: DEVICE, workspaceId: WORKSPACE };
}

function kunde(overrides: Partial<Customer> = {}): Customer {
  return {
    id: 'cust-n04',
    name: 'Muster Bau GmbH',
    contactPerson: 'Frau Muster',
    street: 'Alte Straße 1',
    zip: '33602',
    city: 'Bielefeld',
    email: 'buero@muster-bau.invalid',
    phone: '0521 1',
    createdAt: '2026-09-01T09:00:00.000Z',
    updatedAt: '2026-09-01T09:00:00.000Z',
    ...overrides,
  };
}

function zeile(c: Customer, rowVersion: number, overrides: Partial<WorkspaceCustomerRow> = {}): WorkspaceCustomerRow {
  const { sync: _sync, ...payload } = c;
  return {
    workspace_id: WORKSPACE,
    customer_id: c.id,
    payload: payload as unknown as Record<string, unknown>,
    row_version: rowVersion,
    deleted: false,
    deleted_at: null,
    updated_at: '2026-10-02T10:00:00.000Z',
    updated_by: 'user-anderes-geraet',
    ...overrides,
  };
}

function auftrag(entityId: string, status: SyncOutboxEntry['status'], message?: string): SyncOutboxEntry {
  return {
    id: `out-${entityId}-${status}`,
    entityType: 'customer',
    entityId,
    operation: 'update',
    version: 1,
    queuedAt: '2026-10-02T09:00:00.000Z',
    retryCount: status === 'pending' ? 0 : 1,
    status,
    ...(message ? { lastErrorMessage: message } : {}),
  } as SyncOutboxEntry;
}

const LOKAL_UNGESICHERT = kunde({ street: 'Neue Straße 9 (ungesichert)', sync: syncMeta(1) });
const CLOUD_V2 = kunde({ street: 'Cloud-Straße 2', sync: syncMeta(2) });

describe('N04 M — Merge mit Dirty-Zustand', () => {
  it('M1: ungesicherte Änderung + neuere Cloud mit anderem Inhalt → Konflikt, lokale Straße bleibt', () => {
    const result = mergeCustomersFromPull([LOKAL_UNGESICHERT], [zeile(CLOUD_V2, 2)], DEVICE, WORKSPACE, new Set(['cust-n04']));
    expect(result.conflicts).toEqual(['customer:cust-n04']);
    expect(result.customers.find((c) => c.id === 'cust-n04')?.street).toBe('Neue Straße 9 (ungesichert)');
  });

  it('M2: ungesicherte Änderung, Cloud mit demselben Inhalt → übernommen, ohne Konflikt', () => {
    const gleich = kunde({ street: 'Neue Straße 9 (ungesichert)' });
    const result = mergeCustomersFromPull([LOKAL_UNGESICHERT], [zeile(gleich, 2)], DEVICE, WORKSPACE, new Set(['cust-n04']));
    expect(result.conflicts).toEqual([]);
    expect(result.customers[0]?.sync?.version).toBe(2);
  });

  it('M3: ohne offenen Auftrag gewinnt die neuere Cloud (unverändert)', () => {
    const sauber = kunde({ sync: syncMeta(1) });
    const result = mergeCustomersFromPull([sauber], [zeile(CLOUD_V2, 2)], DEVICE, WORKSPACE, new Set());
    expect(result.conflicts).toEqual([]);
    expect(result.customers[0]?.street).toBe('Cloud-Straße 2');
  });

  it('M4: gleiche Version, eigene wartende Änderung → kein Konflikt, lokal bleibt bis zum Senden', () => {
    const basis = kunde({ sync: syncMeta(1) });
    const ohneDirty = mergeCustomersFromPull([LOKAL_UNGESICHERT], [zeile(basis, 1)], DEVICE, WORKSPACE);
    expect(ohneDirty.conflicts).toEqual(['customer:cust-n04']);
    const mitDirty = mergeCustomersFromPull([LOKAL_UNGESICHERT], [zeile(basis, 1)], DEVICE, WORKSPACE, new Set(['cust-n04']));
    expect(mitDirty.conflicts).toEqual([]);
    expect(mitDirty.customers[0]?.street).toBe('Neue Straße 9 (ungesichert)');
  });

  it('M5: ein Grabstein löscht keine ungesicherte Änderung still', () => {
    const result = mergeCustomersFromPull(
      [LOKAL_UNGESICHERT],
      [zeile(CLOUD_V2, 2, { deleted: true })],
      DEVICE,
      WORKSPACE,
      new Set(['cust-n04']),
    );
    expect(result.conflicts).toEqual(['customer:cust-n04']);
    expect(result.customers).toHaveLength(1);
  });

  it('M6: endgültig abgewiesene Änderung (ohne neue) → der Cloud-Stand gilt', () => {
    const basis = kunde({ sync: syncMeta(1) });
    const result = mergeCustomersFromPull([LOKAL_UNGESICHERT], [zeile(basis, 1)], DEVICE, WORKSPACE, new Set(), new Set(['cust-n04']));
    expect(result.conflicts).toEqual([]);
    expect(result.customers[0]?.street).toBe('Alte Straße 1');
  });
});

describe('N05 P — Bereitstellung', () => {
  beforeEach(() => {
    localStorage.clear();
    resetSyncOutboxForTests([]);
    resetSyncChangeTrackerForTests();
    resetSyncClientForTests({ ...createSyncClient(), deviceId: DEVICE, workspaceId: WORKSPACE, serverWorkspaceId: WORKSPACE });
  });

  function zustand(customers: Customer[], outbox: SyncOutboxEntry[]): AppPersistedState {
    return { ...buildPersistedStateSnapshot(), customers, syncOutbox: outbox };
  }

  function pullMit(customers: WorkspaceCustomerRow[]) {
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
      customers,
    } as unknown as Parameters<typeof mergeRemoteWorkspacePullIntoState>[1];
  }

  it('P1: ein Konflikt hält nur seine Zeile an — ein unabhängiger neuer Cloud-Kunde kommt an', () => {
    const neu = kunde({ id: 'cust-unabhaengig', name: 'Unabhängig KG', street: 'Weg 3' });
    const merged = mergeRemoteWorkspacePullIntoState(
      zustand([LOKAL_UNGESICHERT], [auftrag('cust-n04', 'blocked', 'Versionskonflikt customer:2')]),
      pullMit([zeile(CLOUD_V2, 2), zeile(neu, 1)]),
    );
    expect(merged.conflicts).toContain('customer:cust-n04');
    const kunden = merged.state.customers ?? [];
    expect(kunden.find((c) => c.id === 'cust-unabhaengig')?.name).toBe('Unabhängig KG');
    expect(kunden.find((c) => c.id === 'cust-n04')?.street).toBe('Neue Straße 9 (ungesichert)');
  });

  it('P2: Abweisungsrücknahme — eine endgültig abgewiesene Änderung weicht dem Cloud-Stand', () => {
    const merged = mergeRemoteWorkspacePullIntoState(
      zustand([LOKAL_UNGESICHERT], [auftrag('cust-n04', 'failed', 'Keine Schreibberechtigung')]),
      pullMit([zeile(kunde(), 1)]),
    );
    expect(merged.conflicts).not.toContain('customer:cust-n04');
    expect((merged.state.customers ?? []).find((c) => c.id === 'cust-n04')?.street).toBe('Alte Straße 1');
  });
});

describe('N04 A — Auflösung auf der Sync-Seite', () => {
  beforeEach(() => {
    localStorage.clear();
    resetSyncChangeTrackerForTests();
    resetSyncClientForTests({ ...createSyncClient(), deviceId: DEVICE, workspaceId: WORKSPACE, serverWorkspaceId: WORKSPACE });
    hydrateCustomerStore([LOKAL_UNGESICHERT]);
    resetSyncOutboxForTests([auftrag('cust-n04', 'blocked', 'Versionskonflikt customer:2')]);
  });

  afterEach(() => {
    hydrateCustomerStore([]);
    resetSyncOutboxForTests([]);
  });

  it('A1: der Konflikt steht als Entscheidung da (und zählt als Konflikt, nicht als „wartet")', () => {
    const outbox = getSyncOutboxSnapshot();
    expect(listCustomerConflicts(outbox)).toEqual([
      { outboxId: 'out-cust-n04-blocked', customerId: 'cust-n04', name: 'Muster Bau GmbH' },
    ]);
    const summary = summarizeSyncStatus({
      status: { syncState: 'synced' } as never,
      outbox,
      lastReport: null,
      isOffline: false,
      customerConflicts: listCustomerConflicts(outbox),
    });
    expect(summary.conflictCount).toBe(1);
    expect(summary.waitingCount).toBe(0);
  });

  it('A2: „Online-Version verwenden" übernimmt den Cloud-Stand und schließt den Auftrag', async () => {
    const result = await resolveCustomerConflict('cust-n04', 'take_cloud', {
      pullCustomers: async () => [zeile(CLOUD_V2, 2)],
    });
    expect(result).toEqual({ ok: true, decision: 'take_cloud', cloudVersion: 2 });
    expect(getCustomerById('cust-n04')?.street).toBe('Cloud-Straße 2');
    expect(getCustomerById('cust-n04')?.sync?.version).toBe(2);
    expect(listCustomerConflicts()).toEqual([]);
  });

  it('A3: „Änderungen dieses Geräts behalten" setzt die Cloud-Version als Basis und gibt den Auftrag frei', async () => {
    const result = await resolveCustomerConflict('cust-n04', 'keep_local', {
      pullCustomers: async () => [zeile(CLOUD_V2, 2)],
    });
    expect(result).toEqual({ ok: true, decision: 'keep_local', cloudVersion: 2 });
    expect(getCustomerById('cust-n04')?.street).toBe('Neue Straße 9 (ungesichert)');
    expect(getCustomerById('cust-n04')?.sync?.version).toBe(2);
    const offen = getSyncOutboxSnapshot().find((entry) => entry.entityId === 'cust-n04');
    expect(offen?.status).toBe('pending');
    expect(offen?.version).toBe(2);
  });

  it('A4: scheitert das Lesen, bleibt alles, wie es war', async () => {
    const result = await resolveCustomerConflict('cust-n04', 'take_cloud', {
      pullCustomers: async () => {
        throw new Error('offline');
      },
    });
    expect(result).toEqual({ ok: false, reason: 'cloud_unavailable' });
    expect(getCustomerById('cust-n04')?.street).toBe('Neue Straße 9 (ungesichert)');
    expect(listCustomerConflicts()).toHaveLength(1);
  });
});

describe('N05 F — Kundenformulare nach Schreibrecht', () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  beforeEach(() => {
    resetTestStores();
    hydrateCustomerStore([kunde({ sync: syncMeta(1) })]);
  });

  afterEach(() => {
    if (root) act(() => root!.unmount());
    container?.remove();
    root = null;
    container = null;
    vi.restoreAllMocks();
    resetTestStores();
  });

  function zeige(path: string, element: JSX.Element): HTMLDivElement {
    container = document.createElement('div');
    document.body.appendChild(container);
    act(() => {
      root = createRoot(container!);
      root.render(
        <MemoryRouter initialEntries={[path]}>
          <AppProvider initialSetup={{ ...DEFAULT_SETUP, setupComplete: true }}>
            <Routes>
              <Route path="/kunden" element={element} />
              <Route path="/kunden/customer/:customerId" element={element} />
            </Routes>
          </AppProvider>
        </MemoryRouter>,
      );
    });
    return container;
  }

  it('F1: Mitglied — keine Anlage und keine Bearbeitung', () => {
    alsMitglied();
    expect(zeige('/kunden', <KundenPage />).querySelector('[data-testid="kunden-create-action"]')).toBeNull();
    act(() => root!.unmount());
    container!.remove();
    root = null;
    expect(
      zeige('/kunden/customer/cust-n04', <KundenDetailPage kind="customer" />).querySelector('[data-testid="kunden-edit-action"]'),
    ).toBeNull();
  });

  it('F2: Inhaber — Anlage und Bearbeitung wie bisher', () => {
    alsInhaber();
    expect(zeige('/kunden', <KundenPage />).querySelector('[data-testid="kunden-create-action"]')).not.toBeNull();
    act(() => root!.unmount());
    container!.remove();
    root = null;
    expect(
      zeige('/kunden/customer/cust-n04', <KundenDetailPage kind="customer" />).querySelector('[data-testid="kunden-edit-action"]'),
    ).not.toBeNull();
  });

  it('F3: ohne Schreibrecht entfällt „neuer Kunde" in der Kundenauswahl', () => {
    const markup = (allowNew: boolean) =>
      renderToStaticMarkup(
        <MemoryRouter>
          <AppProvider initialSetup={DEFAULT_SETUP}>
            <CustomerDecisionChoice
              mode={null}
              onModeChange={() => undefined}
              customers={[kunde()]}
              selectedCustomerId={null}
              onSelectCustomer={() => undefined}
              allowNone={false}
              allowNew={allowNew}
            />
          </AppProvider>
        </MemoryRouter>,
      );
    expect(markup(true)).toContain('value="new"');
    expect(markup(false)).not.toContain('value="new"');
  });
});
