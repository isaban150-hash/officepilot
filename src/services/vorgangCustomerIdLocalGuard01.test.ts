/**
 * CUSTOMER-FACHOBJEKT-03B1 → PRODUCT-FOUNDATION-03B.
 *
 * Ursprünglich sicherte diese Datei zu, dass `customerId` **niemals** in die
 * Cloud gelangt. Seit der Kundenstamm selbst synchronisiert (03A-C1) wäre das
 * eine Lücke: Der Kunde erreicht das zweite Gerät, die Beziehung nicht.
 *
 * Die Fälle C und E kehren sich deshalb bewusst um — sie sichern jetzt das
 * Gegenteil. **Unverändert erhalten** bleiben die vier Aussagen, die von 03B
 * nicht berührt werden und weiterhin gelten müssen: Persistenz/Bootstrap (A),
 * Legacy-Vorgänge ohne Relation (B), der Schutz einer lokalen Relation gegen
 * einen alten Remote-Payload (D) und dass ein Pull niemals implizit einen
 * Customer erzeugt (F).
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

  it('Fall C — 03B: der Cloud-Payload trägt die Relation jetzt mit', () => {
    // Umgekehrte Aussage gegenüber 03B1 — siehe Kopfkommentar.
    bootstrapScope('ws-03b1');
    const seeded = seedVorgang(CUSTOMER_ID);

    const stripped = stripVorgangForCloud(seeded);
    expect(stripped.customerId).toBe(CUSTOMER_ID);
    // Bestehende Felder bleiben unverändert vorhanden.
    expect(stripped.id).toBe('v-03b1');
    expect(stripped.title).toBe('Sanierung Nordwest');
    expect(stripped.customer).toBe(seeded.customer);
    expect(stripped.baustelle).toBe(seeded.baustelle);
    expect(stripped.customerBilling).toEqual(seeded.customerBilling);
    expect(stripped.orderPositions).toHaveLength(seeded.orderPositions.length);

    const pushPayload = buildVorgangCloudPushPayload(seeded);
    expect(JSON.stringify(pushPayload)).toContain(CUSTOMER_ID);
  });

  it('Fall C2 — ein Legacy-Vorgang erzeugt kein leeres Relationsfeld', () => {
    bootstrapScope('ws-03b1-legacy');
    const seeded = seedVorgang();
    const stripped = stripVorgangForCloud(seeded);
    expect(Object.keys(stripped)).not.toContain('customerId');
  });

  it('Fall D — lokales customerId überlebt einen alten Cloud-Payload', () => {
    /*
     * Unverändert gültige Aussage aus 03B1 — nach 03B sogar wichtiger: Der
     * Payload bildet hier eine Zeile ab, die vor 03B geschrieben wurde oder
     * von einem alten Client zurückgeschrieben wurde.
     */
    bootstrapScope('ws-03b1');
    const local = seedVorgang(CUSTOMER_ID);
    const rowVersion = local.sync?.version ?? 1;
    const { customerId: _legacy, ...legacyPayload } = stripVorgangForCloud(local);
    const cloudPayload = legacyPayload as typeof legacyPayload & { customerId?: string };
    expect(cloudPayload.customerId).toBeUndefined();

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

  it('Fall E — 03B: ein frisches Gerät übernimmt die Relation aus der Cloud', () => {
    // Umgekehrte Aussage gegenüber 03B1 — genau das war die fachliche Lücke.
    bootstrapScope('ws-03b1');
    const source = seedVorgang(CUSTOMER_ID);
    const row = buildRow(source, source.sync?.version ?? 1);

    // Zweites Gerät: lokal existiert dieser Vorgang noch nicht.
    const created = mergeVorgaengeFromPull([], [row], 'fresh-device', 'ws-03b1');
    expect(created.conflicts).toEqual([]);
    expect(created.vorgaenge).toHaveLength(1);
    expect(created.vorgaenge[0]?.id).toBe('v-03b1');
    expect(created.vorgaenge[0]?.customerId).toBe(CUSTOMER_ID);
    expect(created.vorgaenge[0]?.customer).toBe(source.customer);
  });

  it('Fall E2 — ein Legacy-Remote-Payload erzeugt keine Relation aus dem Namen', () => {
    /*
     * Eine aus der Cloud entfernte Relation darf niemals über einen
     * Namensvergleich rekonstruiert werden — ein frisches Gerät bleibt ohne.
     */
    bootstrapScope('ws-03b1-legacy');
    const source = seedVorgang();
    const created = mergeVorgaengeFromPull(
      [],
      [buildRow(source, source.sync?.version ?? 1)],
      'fresh-device',
      'ws-03b1-legacy',
    );
    expect(created.vorgaenge[0]?.customerId).toBeUndefined();
    expect(getCustomerStoreSnapshot()).toHaveLength(0);
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
