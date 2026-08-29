/**
 * OFFICEPILOT-CUSTOMER-CLOUD-CLIENT-03A-C1 — der Kundenstamm erreicht das
 * zweite Gerät.
 *
 * Der Server kennt `customer` seit 03A-S1. Der Client kannte den Entity-Typ
 * bisher gar nicht: `customer` fehlte in `SyncEntityType`, in der Allowlist
 * und in der Registry, und der Kundenstamm blieb damit rein lokal.
 *
 * **Zwei Punkte tragen diesen Sprint und werden deshalb hart geprüft:**
 *
 * Erstens der Backfill. Bestandskunden werden beim Start als Tracker-Basislinie
 * behandelt und gelten damit als unverändert — der Change-Tracker meldet sie
 * niemals nach. Nur der ID-Mengenvergleich beim Provisioning bringt sie in die
 * Cloud. Ein Remote-Tombstone zählt dabei als vorhandene ID, sonst lädt ein
 * zweites Gerät einen gelöschten Kunden wieder hoch.
 *
 * Zweitens die Trennung von fachlichem `Customer.updatedAt` und
 * `Customer.sync.updatedAt`. Landet Letzteres im Content-Key, erzeugt jede
 * zurückgeschriebene Serverversion einen neuen Push — dieselbe Schleife, die
 * bei den Firmendaten schon einmal auftrat.
 *
 * Neutrale Beispieldaten.
 */
import { describe, expect, it } from 'vitest';
import {
  buildCustomerCloudContentKey,
  buildCustomerCloudPushPayload,
  mapWorkspaceCustomerRow,
  mergeCustomersFromPull,
  planCustomerBackfill,
  stripCustomerForCloud,
  type WorkspaceCustomerRow,
} from './customer/customerCloudService';
import { SUPABASE_SYNC_ALLOWLIST } from './sync/cloudSyncAllowlist';
import { listEntitiesByType } from './sync/syncEntityRegistry';
import type { AppPersistedState, Customer } from '../types/models';
import type { SyncMeta } from '../types/sync';

const DEVICE = 'device-03a-c1';
const WORKSPACE = 'ws-03a-c1';

function customer(overrides: Partial<Customer> = {}): Customer {
  return {
    id: 'cust-0001',
    name: 'Beispiel Projektbau GmbH',
    contactPerson: 'Frau Beispiel',
    street: 'Beispielstraße 2',
    zip: '20000',
    city: 'Beispielstadt',
    email: 'kontakt@beispiel-projektbau.de',
    phone: '040 1234',
    createdAt: '2026-05-01T09:00:00.000Z',
    updatedAt: '2026-05-01T09:00:00.000Z',
    ...overrides,
  };
}

function syncMeta(version: number, overrides: Partial<SyncMeta> = {}): SyncMeta {
  return {
    updatedAt: '2026-05-02T10:00:00.000Z',
    version,
    deleted: false,
    deviceId: DEVICE,
    workspaceId: WORKSPACE,
    ...overrides,
  };
}

function row(overrides: Partial<WorkspaceCustomerRow> = {}): WorkspaceCustomerRow {
  const base = customer();
  return {
    workspace_id: WORKSPACE,
    customer_id: base.id,
    payload: { ...base } as unknown as Record<string, unknown>,
    row_version: 1,
    deleted: false,
    deleted_at: null,
    updated_at: '2026-05-02T10:00:00.000Z',
    updated_by: 'user-1',
    ...overrides,
  };
}

/* ------------------------------------------------------------------------ */
/* Payload und Content-Key                                                   */
/* ------------------------------------------------------------------------ */

describe('CUSTOMER-CLOUD-03A-C1 — Payload und Content-Key', () => {
  it('1: der Cloud-Payload trägt keine Sync-Metadaten', () => {
    const payload = stripCustomerForCloud({ ...customer(), sync: syncMeta(3) });
    expect(payload).not.toHaveProperty('sync');
    expect(Object.keys(payload).sort()).toEqual(
      [
        'id',
        'name',
        'contactPerson',
        'street',
        'zip',
        'city',
        'email',
        'phone',
        'createdAt',
        'updatedAt',
      ].sort(),
    );
  });

  it('2: createdFromInboxId reist mit, wenn es gesetzt ist', () => {
    const payload = stripCustomerForCloud(customer({ createdFromInboxId: 'inbox-7' }));
    expect(payload.createdFromInboxId).toBe('inbox-7');
  });

  it('3: der Content-Key enthält keine Server- oder Sync-Metadaten', () => {
    const key = buildCustomerCloudContentKey({ ...customer(), sync: syncMeta(9) });
    expect(key).not.toContain('sync');
    expect(key).not.toContain('row_version');
    expect(key).not.toContain('updated_by');
    expect(key).not.toContain('deleted_at');
  });

  it('4: der Content-Key reagiert auf eine fachliche Änderung', () => {
    const before = buildCustomerCloudContentKey(customer());
    const after = buildCustomerCloudContentKey(
      customer({ email: 'neu@beispiel-projektbau.de', updatedAt: '2026-06-01T09:00:00.000Z' }),
    );
    expect(after).not.toBe(before);
  });

  it('5: der Content-Key reagiert NICHT auf eine reine SyncMeta-Änderung', () => {
    /*
     * Der Kern des Schleifenschutzes: Nach jedem Push schreibt der Server eine
     * neue `row_version` zurück. Fliesst sie in den Key, löst sie den nächsten
     * Push aus — und der wieder den nächsten.
     */
    const base = buildCustomerCloudContentKey({ ...customer(), sync: syncMeta(1) });
    const afterServerEcho = buildCustomerCloudContentKey({
      ...customer(),
      sync: syncMeta(2, { updatedAt: '2026-07-01T00:00:00.000Z' }),
    });
    expect(afterServerEcho).toBe(base);
  });

  it('6: der Push-Payload entspricht dem Serverformat der Migration', () => {
    const payload = buildCustomerCloudPushPayload({ ...customer(), sync: syncMeta(2) });
    expect(payload.customer_id).toBe('cust-0001');
    expect(payload.deleted).toBe(false);
    expect(payload.payload).not.toHaveProperty('sync');
  });
});

/* ------------------------------------------------------------------------ */
/* Registry und Allowlist                                                    */
/* ------------------------------------------------------------------------ */

describe('CUSTOMER-CLOUD-03A-C1 — Registrierung', () => {
  it('7: customer ist Supabase-sync-allowlisted', () => {
    expect(SUPABASE_SYNC_ALLOWLIST.has('customer')).toBe(true);
  });

  it('8: die Registry findet Kunden über state.customers', () => {
    const state = { customers: [customer(), customer({ id: 'cust-0002' })] } as AppPersistedState;
    const found = listEntitiesByType(state, 'customer');
    expect(found.map((entity) => entity.id)).toEqual(['cust-0001', 'cust-0002']);
  });
});

/* ------------------------------------------------------------------------ */
/* Backfill B                                                                */
/* ------------------------------------------------------------------------ */

describe('CUSTOMER-CLOUD-03A-C1 — Backfill B', () => {
  it('9: eine remote fehlende ID wird nachgemeldet', () => {
    const plan = planCustomerBackfill([customer({ id: 'cust-A1' })], []);
    expect(plan).toEqual(['cust-A1']);
  });

  it('10: eine remote vorhandene ID wird nicht erneut nachgemeldet', () => {
    const plan = planCustomerBackfill([customer({ id: 'cust-A1' })], [row({ customer_id: 'cust-A1' })]);
    expect(plan).toEqual([]);
  });

  it('11: ein Remote-Tombstone verhindert die Wiederauferstehung', () => {
    /*
     * Ohne diese Regel würde ein zweites Gerät einen anderswo gelöschten
     * Kunden als neu wieder hochladen.
     */
    const plan = planCustomerBackfill(
      [customer({ id: 'cust-A1' })],
      [row({ customer_id: 'cust-A1', deleted: true, deleted_at: '2026-06-01T00:00:00.000Z' })],
    );
    expect(plan).toEqual([]);
  });

  it('12: der Zwei-Geräte-Altbestand landet vollständig in der Cloud', () => {
    /*
     * Gerät A hat A1/A2 und synchronisiert zuerst. Gerät B hat B1/B2 mit
     * denselben Firmennamen. Der bisher erwogene „Remote muss leer sein"-Guard
     * hätte B1/B2 dauerhaft ausgesperrt.
     */
    const remoteAfterA = [row({ customer_id: 'cust-A1' }), row({ customer_id: 'cust-A2' })];
    const localOnB = [
      customer({ id: 'cust-B1', name: 'Mueller GmbH' }),
      customer({ id: 'cust-B2', name: 'Mueller GmbH' }),
    ];
    expect(planCustomerBackfill(localOnB, remoteAfterA)).toEqual(['cust-B1', 'cust-B2']);
  });

  it('13: gleiche Firmennamen mit verschiedenen IDs bleiben getrennt', () => {
    const plan = planCustomerBackfill(
      [customer({ id: 'cust-B1', name: 'Mueller GmbH' })],
      [row({ customer_id: 'cust-A1', payload: { ...customer({ name: 'Mueller GmbH' }) } as never })],
    );
    // Kein Namensvergleich — die fremde ID deckt die eigene nicht ab.
    expect(plan).toEqual(['cust-B1']);
  });
});

/* ------------------------------------------------------------------------ */
/* Pull und Merge                                                            */
/* ------------------------------------------------------------------------ */

describe('CUSTOMER-CLOUD-03A-C1 — Pull und Merge', () => {
  it('14: eine Serverzeile wird auf Customer inklusive SyncMeta abgebildet', () => {
    const mapped = mapWorkspaceCustomerRow(row({ row_version: 4 }));
    expect(mapped?.customerId).toBe('cust-0001');
    expect(mapped?.rowVersion).toBe(4);
    expect(mapped?.deleted).toBe(false);
    // Servermetadaten dürfen nicht zu Fachdaten werden.
    expect(mapped?.payload).not.toHaveProperty('workspace_id');
    expect(mapped?.payload).not.toHaveProperty('updated_by');
    expect(mapped?.payload).not.toHaveProperty('deleted_at');
  });

  it('15: ein remote neuer Kunde wird lokal aufgenommen, mit sync.version', () => {
    const result = mergeCustomersFromPull([], [row({ row_version: 3 })], DEVICE, WORKSPACE);
    expect(result.conflicts).toEqual([]);
    expect(result.customers).toHaveLength(1);
    expect(result.customers[0]!.sync?.version).toBe(3);
  });

  it('16: ein Remote-Tombstone erscheint nicht im aktiven Store', () => {
    const local = [{ ...customer(), sync: syncMeta(1) }];
    const result = mergeCustomersFromPull(
      local,
      [row({ row_version: 2, deleted: true, deleted_at: '2026-06-01T00:00:00.000Z' })],
      DEVICE,
      WORKSPACE,
    );
    expect(result.customers).toEqual([]);
  });

  it('17: eine höhere Serverversion gewinnt', () => {
    const local = [{ ...customer({ email: 'alt@beispiel.de' }), sync: syncMeta(1) }];
    const result = mergeCustomersFromPull(local, [row({ row_version: 5 })], DEVICE, WORKSPACE);
    expect(result.conflicts).toEqual([]);
    expect(result.customers[0]!.email).toBe('kontakt@beispiel-projektbau.de');
    expect(result.customers[0]!.sync?.version).toBe(5);
  });

  it('18: gleiche Version mit gleichem Inhalt ist kein Konflikt', () => {
    const local = [{ ...customer(), sync: syncMeta(2) }];
    const result = mergeCustomersFromPull(local, [row({ row_version: 2 })], DEVICE, WORKSPACE);
    expect(result.conflicts).toEqual([]);
    expect(result.customers).toHaveLength(1);
  });

  it('19: gleiche Version mit abweichendem Inhalt ergibt einen Konflikt', () => {
    /*
     * Zwei Geräte haben denselben Kunden unterschiedlich geändert. Kein
     * stilles Überschreiben — die lokale Fassung bleibt bis zur Klärung.
     */
    const local = [{ ...customer({ email: 'lokal@beispiel.de' }), sync: syncMeta(2) }];
    const result = mergeCustomersFromPull(local, [row({ row_version: 2 })], DEVICE, WORKSPACE);
    expect(result.conflicts).toEqual(['customer:cust-0001']);
    expect(result.customers[0]!.email).toBe('lokal@beispiel.de');
  });

  it('20: ein lokal unbekannter Kunde bleibt beim Pull erhalten', () => {
    const local = [{ ...customer({ id: 'cust-local-only' }), sync: undefined }];
    const result = mergeCustomersFromPull(local, [row()], DEVICE, WORKSPACE);
    expect(result.customers.map((c) => c.id).sort()).toEqual(['cust-0001', 'cust-local-only']);
  });
});
