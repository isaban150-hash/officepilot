/**
 * CUSTOMER-FACHOBJEKT-03B1 — local customerId survives persistence and cloud merge,
 * is never pushed, and never appears on a cloud-created Vorgang.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getCustomerStoreSnapshot } from './customerStoreService';
import { bootstrapBusinessState } from './storage/storageBootstrapService';
import {
  buildVorgangCloudPushPayload,
  mergeCloudVorgangIntoLocal,
  mergeVorgaengeFromPull,
  stripVorgangForCloud,
  type WorkspaceVorgangRow,
} from './vorgang/vorgangCloudService';
import {
  commitVorgangMutation,
  getVorgangById,
  hydrateVorgangStore,
} from './vorgangService';
import { createTestVorgang } from '../test/fixtures';
import { resetTestStores } from '../test/resetStores';
import type { Vorgang } from '../types/models';

const CUSTOMER_ID = 'cust-03b1-nordwest';

function bootstrapScope(workspaceId: string) {
  return bootstrapBusinessState({ userId: 'user-03b1', workspaceId });
}

/** Seeds one Vorgang and writes it through the production mutation path. */
function seedVorgang(customerId?: string): Vorgang {
  hydrateVorgangStore([createTestVorgang({ id: 'v-03b1' })]);
  const committed = commitVorgangMutation('v-03b1', (current) => ({
    ...current,
    ...(customerId ? { customerId } : {}),
    title: 'Sanierung Nordwest',
  }));
  expect(committed.ok).toBe(true);
  if (!committed.ok) throw new Error('seed failed');
  return committed.vorgang;
}

function buildRow(vorgang: Vorgang, rowVersion: number): WorkspaceVorgangRow {
  return {
    workspace_id: 'ws-03b1',
    vorgang_id: vorgang.id,
    payload: stripVorgangForCloud(vorgang) as unknown as Record<string, unknown>,
    row_version: rowVersion,
    deleted: false,
    deleted_at: null,
    updated_at: '2026-08-13T10:00:00.000Z',
    updated_by: 'other-device',
  };
}

describe('CUSTOMER-FACHOBJEKT-03B1', () => {
  beforeEach(() => {
    localStorage.clear();
    resetTestStores();
  });

  afterEach(() => {
    resetTestStores();
    localStorage.clear();
  });

  it('Fall A — customerId überlebt Persistenz und Bootstrap', () => {
    bootstrapScope('ws-03b1');
    const seeded = seedVorgang(CUSTOMER_ID);
    expect(seeded.customerId).toBe(CUSTOMER_ID);

    bootstrapScope('ws-03b1');

    const reloaded = getVorgangById('v-03b1');
    expect(reloaded).toBeDefined();
    expect(reloaded?.customerId).toBe(CUSTOMER_ID);
    expect(reloaded?.title).toBe('Sanierung Nordwest');
  });

  it('Fall B — Legacy-Vorgang bleibt ohne customerId', () => {
    bootstrapScope('ws-03b1-legacy');
    const seeded = seedVorgang();
    expect(seeded.customerId).toBeUndefined();

    bootstrapScope('ws-03b1-legacy');

    const reloaded = getVorgangById('v-03b1');
    expect(reloaded).toBeDefined();
    expect(reloaded?.customerId).toBeUndefined();
    expect(getCustomerStoreSnapshot()).toHaveLength(0);
  });

  it('Fall C — Cloud-Payload enthält customerId nicht', () => {
    bootstrapScope('ws-03b1');
    const seeded = seedVorgang(CUSTOMER_ID);

    const stripped = stripVorgangForCloud(seeded);
    expect(Object.keys(stripped)).not.toContain('customerId');
    expect((stripped as Record<string, unknown>).customerId).toBeUndefined();
    // Bestehende Felder bleiben unverändert vorhanden.
    expect(stripped.id).toBe('v-03b1');
    expect(stripped.title).toBe('Sanierung Nordwest');
    expect(stripped.customer).toBe(seeded.customer);
    expect(stripped.baustelle).toBe(seeded.baustelle);
    expect(stripped.customerBilling).toEqual(seeded.customerBilling);
    expect(stripped.orderPositions).toHaveLength(seeded.orderPositions.length);

    const pushPayload = buildVorgangCloudPushPayload(seeded);
    expect(JSON.stringify(pushPayload)).not.toContain('customerId');
    expect(JSON.stringify(pushPayload)).not.toContain(CUSTOMER_ID);
  });

  it('Fall D — lokales customerId überlebt Cloud-Merge und Reconcile', () => {
    bootstrapScope('ws-03b1');
    const local = seedVorgang(CUSTOMER_ID);
    const rowVersion = local.sync?.version ?? 1;
    const cloudPayload = stripVorgangForCloud(local);
    expect((cloudPayload as Record<string, unknown>).customerId).toBeUndefined();

    const merged = mergeCloudVorgangIntoLocal(
      local,
      cloudPayload,
      rowVersion,
      '2026-08-13T10:00:00.000Z',
      false,
      'other-device',
      'ws-03b1',
    );
    expect(merged.conflict).toBe(false);
    expect(merged.vorgang?.customerId).toBe(CUSTOMER_ID);

    const reconciled = mergeVorgaengeFromPull(
      [local],
      [buildRow(local, rowVersion)],
      'other-device',
      'ws-03b1',
    );
    expect(reconciled.conflicts).toEqual([]);
    expect(reconciled.vorgaenge).toHaveLength(1);
    expect(reconciled.vorgaenge[0]?.customerId).toBe(CUSTOMER_ID);
  });

  it('Fall E — aus der Cloud neu erzeugter Vorgang besitzt kein customerId', () => {
    bootstrapScope('ws-03b1');
    const source = seedVorgang(CUSTOMER_ID);
    const row = buildRow(source, source.sync?.version ?? 1);

    // Zweites Gerät: lokal existiert dieser Vorgang noch nicht.
    const created = mergeVorgaengeFromPull([], [row], 'fresh-device', 'ws-03b1');
    expect(created.conflicts).toEqual([]);
    expect(created.vorgaenge).toHaveLength(1);
    expect(created.vorgaenge[0]?.id).toBe('v-03b1');
    expect(created.vorgaenge[0]?.customerId).toBeUndefined();
    expect(created.vorgaenge[0]?.customer).toBe(source.customer);
  });

  it('Fall F — weder Bootstrap noch Cloud-Merge erzeugen einen Customer', () => {
    bootstrapScope('ws-03b1');
    const local = seedVorgang(CUSTOMER_ID);
    expect(getCustomerStoreSnapshot()).toHaveLength(0);

    mergeVorgaengeFromPull(
      [local],
      [buildRow(local, local.sync?.version ?? 1)],
      'other-device',
      'ws-03b1',
    );
    expect(getCustomerStoreSnapshot()).toHaveLength(0);

    bootstrapScope('ws-03b1');
    expect(getCustomerStoreSnapshot()).toHaveLength(0);
    expect(getVorgangById('v-03b1')?.customerId).toBe(CUSTOMER_ID);
  });
});
