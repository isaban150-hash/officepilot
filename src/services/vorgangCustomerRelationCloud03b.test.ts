/**
 * PRODUCT-FOUNDATION-03B — die Beziehung Vorgang → Customer erreicht das
 * zweite Gerät.
 *
 * Seit 03A-C1 synchronisiert der Kundenstamm selbst. `Vorgang.customerId` war
 * weiterhin lokal-only — der Kunde kam an, die Zuordnung nicht.
 *
 * **Zwei Dinge tragen diesen Sprint:**
 *
 * Die Merge-Regel ist bewusst asymmetrisch: Eine lokale Relation gewinnt immer,
 * Remote füllt nur eine Lücke. Eine echte konkurrierende Umverknüpfung ist ein
 * Versionskonflikt und bleibt dem bestehenden `row_version`-Mechanismus
 * überlassen — kein Feld-Merge.
 *
 * Und der Backfill: Bestandszeilen wurden ohne Relation geschrieben, und der
 * Change-Tracker meldet sie nicht nach, weil er den vorhandenen Zustand beim
 * Start zur Basislinie macht. Nur der remote-bewusste Vergleich bringt sie in
 * die Cloud — bei **jedem** Provisioning, ohne Migrationsmarker, denn ein alter
 * Client kann die Relation jederzeit wieder aus der Zeile entfernen.
 *
 * Neutrale Beispieldaten.
 */
import { describe, expect, it } from 'vitest';
import {
  buildVorgangCloudContentKey,
  mergeCloudVorgangIntoLocal,
  mergeVorgaengeFromPull,
  planVorgangCustomerRelationBackfill,
  stripVorgangForCloud,
  type WorkspaceVorgangRow,
} from './vorgang/vorgangCloudService';
import { createTestVorgang } from '../test/fixtures';
import type { SyncMeta } from '../types/sync';
import type { Vorgang } from '../types/models';

const CUST_A = 'cust-a-beispielbau';
const CUST_B = 'cust-b-musterbau';
const DEVICE = 'device-03b';
const WORKSPACE = 'ws-03b';

function syncMeta(version: number): SyncMeta {
  return {
    updatedAt: '2026-08-29T09:00:00.000Z',
    version,
    deleted: false,
    deviceId: DEVICE,
    workspaceId: WORKSPACE,
  };
}

function vorgang(customerId: string | undefined, version = 3): Vorgang {
  return {
    ...createTestVorgang({ id: 'v-03b', title: 'Beispielauftrag' }),
    ...(customerId ? { customerId } : {}),
    sync: syncMeta(version),
  };
}

/** Serverzeile — `payloadOverride` bildet einen Legacy-Payload ohne Relation ab. */
function row(
  source: Vorgang,
  overrides: Partial<WorkspaceVorgangRow> = {},
  payloadOverride?: Record<string, unknown>,
): WorkspaceVorgangRow {
  return {
    workspace_id: WORKSPACE,
    vorgang_id: source.id,
    payload:
      payloadOverride ?? (stripVorgangForCloud(source) as unknown as Record<string, unknown>),
    row_version: source.sync?.version ?? 1,
    deleted: false,
    deleted_at: null,
    updated_at: '2026-08-29T09:00:00.000Z',
    updated_by: 'other-device',
    ...overrides,
  };
}

/** Payload wie ihn ein alter Client schreibt: fachlich gleich, ohne Relation. */
function legacyPayload(source: Vorgang): Record<string, unknown> {
  const { customerId: _dropped, ...rest } = stripVorgangForCloud({
    ...source,
    customerId: CUST_A,
  }) as unknown as Record<string, unknown>;
  return rest;
}

describe('PRODUCT-FOUNDATION-03B — Content-Key', () => {
  it('C: zwei verschiedene Relationen ergeben verschiedene Content-Keys', () => {
    /*
     * Ohne das bliebe eine reine Umverknüpfung für den Change-Tracker
     * unsichtbar — kein Fingerprint-Wechsel, kein Push, keine Übertragung.
     */
    expect(buildVorgangCloudContentKey(vorgang(CUST_A))).not.toBe(
      buildVorgangCloudContentKey(vorgang(CUST_B)),
    );
  });

  it('C2: ein Legacy-Vorgang behält seinen bisherigen Content-Key-Aufbau', () => {
    const key = buildVorgangCloudContentKey(vorgang(undefined));
    expect(key).not.toContain('customerId');
  });
});

describe('PRODUCT-FOUNDATION-03B — Merge-Regel', () => {
  function merge(local: Vorgang | null, remoteSource: Vorgang, legacy = false) {
    const payload = legacy
      ? legacyPayload(remoteSource)
      : (stripVorgangForCloud(remoteSource) as unknown as Record<string, unknown>);
    return mergeCloudVorgangIntoLocal(
      local,
      payload as never,
      remoteSource.sync?.version ?? 1,
      '2026-08-29T09:00:00.000Z',
      false,
      DEVICE,
      WORKSPACE,
    );
  }

  it('M1: lokale Relation bleibt gegen einen Remote-Payload ohne Feld', () => {
    const merged = merge(vorgang(CUST_A), vorgang(undefined), true);
    expect(merged.conflict).toBe(false);
    expect(merged.vorgang?.customerId).toBe(CUST_A);
  });

  it('M2: gleiche Relation auf beiden Seiten bleibt gleich', () => {
    const merged = merge(vorgang(CUST_A), vorgang(CUST_A));
    expect(merged.vorgang?.customerId).toBe(CUST_A);
  });

  it('M3: ohne lokale Relation wird die entfernte übernommen', () => {
    const merged = merge(vorgang(undefined), vorgang(CUST_A));
    expect(merged.vorgang?.customerId).toBe(CUST_A);
  });

  it('M4: ohne beide Relationen bleibt es bei undefined', () => {
    const merged = merge(vorgang(undefined), vorgang(undefined), true);
    expect(merged.vorgang?.customerId).toBeUndefined();
  });

  it('M5: eine abweichende Remote-Relation überschreibt die lokale nicht', () => {
    /*
     * Kein Feld-Merge und keine Sonderlogik: Bei gleicher Version gewinnt die
     * lokale Fassung. Eine echte konkurrierende Änderung erzeugt einen
     * Versionsunterschied und damit den bestehenden Konflikt (M6).
     */
    const merged = merge(vorgang(CUST_A), vorgang(CUST_B));
    expect(merged.vorgang?.customerId).toBe(CUST_A);
  });

  it('M6: konkurrierende Umverknüpfung bleibt ein Versionskonflikt', () => {
    const merged = merge(vorgang(CUST_A, 3), vorgang(CUST_B, 4));
    expect(merged.conflict).toBe(true);
    expect(merged.vorgang?.customerId).toBe(CUST_A);
  });
});

describe('PRODUCT-FOUNDATION-03B — Relation-Backfill', () => {
  it('D: eine Remote-Zeile ohne Relation wird genau einmal nachgemeldet', () => {
    const local = vorgang(CUST_A);
    const plan = planVorgangCustomerRelationBackfill(
      [local],
      [row(local, {}, legacyPayload(local))],
    );
    expect(plan).toEqual(['v-03b']);
  });

  it('E: der Plan ist idempotent — wiederholtes Prüfen ändert nichts', () => {
    const local = vorgang(CUST_A);
    const rows = [row(local, {}, legacyPayload(local))];
    expect(planVorgangCustomerRelationBackfill([local], rows)).toEqual(['v-03b']);
    expect(planVorgangCustomerRelationBackfill([local], rows)).toEqual(['v-03b']);
  });

  it('F: ein Remote-Grabstein wird niemals nachgemeldet', () => {
    /*
     * Sonst würde ein Backfill einen anderswo gelöschten Vorgang wiederbeleben.
     */
    const local = vorgang(CUST_A);
    const plan = planVorgangCustomerRelationBackfill(
      [local],
      [row(local, { deleted: true, deleted_at: '2026-08-28T00:00:00.000Z' }, legacyPayload(local))],
    );
    expect(plan).toEqual([]);
  });

  it('G: eine bereits vorhandene gleiche Relation löst nichts aus', () => {
    const local = vorgang(CUST_A);
    expect(planVorgangCustomerRelationBackfill([local], [row(local)])).toEqual([]);
  });

  it('H: eine abweichende Remote-Relation ist kein Missing-Relation-Fall', () => {
    /*
     * Remote trägt cust-B, lokal steht cust-A. Das ist kein fehlender Zeiger,
     * sondern ein fachlicher Unterschied — der Backfill darf ihn nicht durch
     * eine „local wins"-Nachmeldung stillschweigend überschreiben.
     */
    const local = vorgang(CUST_A);
    const remote = row(vorgang(CUST_B));
    expect(planVorgangCustomerRelationBackfill([local], [remote])).toEqual([]);
  });

  it('I: ein lokal legacy gebliebener Vorgang wird nicht nachgemeldet', () => {
    const local = vorgang(undefined);
    expect(
      planVorgangCustomerRelationBackfill([local], [row(local, {}, legacyPayload(local))]),
    ).toEqual([]);
  });

  it('J: ohne passende Remote-Zeile wird nichts geplant', () => {
    // Das Nachmelden eines gänzlich fehlenden Vorgangs ist nicht Sache von 03B.
    expect(planVorgangCustomerRelationBackfill([vorgang(CUST_A)], [])).toEqual([]);
  });

  it('K: bei Versionsdivergenz wird kein Backfill geplant', () => {
    /*
     * Der Mixed-Version-Fall wird in 03B ausdrücklich **nicht** geheilt.
     *
     * Ein alter Client schreibt den vollständigen Payload ohne Relation zurück
     * und hebt dabei zwangsläufig die `row_version` — die RPC erhöht sie bei
     * jedem Update. Lokal steht dann 3, entfernt 4. Der Pull erzeugt einen
     * Versionskonflikt und behält die lokale Fassung.
     *
     * Ein Backfill wäre hier aussichtslos: Der Push sendet die lokale Version 3
     * als Erwartung, die RPC vergleicht sie mit 4 und lehnt ab. Da ein erneut
     * eingereihter Eintrag den `blocked`-Status wieder auf `pending` hebt,
     * entstünde eine Endlosschleife aus Nachmeldung und Zurückweisung.
     *
     * Die Relation bleibt lokal erhalten; der bestehende Konfliktmechanismus
     * bleibt zuständig. Eine aus der Cloud verschwundene Relation kann ein
     * frisches Gerät nicht rekonstruieren — schon gar nicht über den Namen.
     */
    const local = vorgang(CUST_A, 3);
    const afterOldClientWrite = row(local, { row_version: 4 }, legacyPayload(local));
    expect(planVorgangCustomerRelationBackfill([local], [afterOldClientWrite])).toEqual([]);
  });

  it('K2: die lokale Relation überlebt die Versionsdivergenz unverändert', () => {
    const local = vorgang(CUST_A, 3);
    const result = mergeVorgaengeFromPull(
      [local],
      [row(local, { row_version: 4 }, legacyPayload(local))],
      DEVICE,
      WORKSPACE,
    );
    // Konflikt gemeldet, lokale Fassung unangetastet — keine Version angehoben.
    expect(result.conflicts).toEqual(['vorgang:v-03b']);
    expect(result.vorgaenge[0]?.customerId).toBe(CUST_A);
    expect(result.vorgaenge[0]?.sync?.version).toBe(3);
  });

  it('K3: eine niedrigere Remote-Version löst ebenfalls keinen Backfill aus', () => {
    const local = vorgang(CUST_A, 5);
    expect(
      planVorgangCustomerRelationBackfill(
        [local],
        [row(local, { row_version: 2 }, legacyPayload(local))],
      ),
    ).toEqual([]);
  });

  it('L: nach erfolgreicher Nachmeldung entsteht kein weiterer Backfill', () => {
    /*
     * Der Server hat die Relation übernommen und die Version auf 4 erhöht;
     * `applyVorgangPushResultToState` zieht die lokale Version nach. Beide
     * stehen auf 4, die Zeile trägt die Relation — nichts mehr zu tun.
     */
    const local = vorgang(CUST_A, 4);
    const afterPush = row(local, { row_version: 4 });
    expect(planVorgangCustomerRelationBackfill([local], [afterPush])).toEqual([]);
  });
});

describe('PRODUCT-FOUNDATION-03B — Snapshot-Sicherheit', () => {
  it('N: der Relations-Pull lässt customerBilling und Rechnungen unberührt', () => {
    const local: Vorgang = {
      ...vorgang(undefined),
      customerBilling: {
        name: 'Beispiel Projektbau GmbH',
        contactPerson: 'Frau Beispiel',
        street: 'Beispielstraße 2',
        zip: '20000',
        city: 'Beispielstadt',
        email: '',
        phone: '',
      },
      invoices: [
        {
          id: 'inv-03b',
          number: '2026-0001',
          type: 'rechnung',
          positions: [],
          subtotal: 1000,
          taxStatus: 'standard_19',
          amount: 1190,
          status: 'versendet',
          date: '2026-05-01',
          createdAt: '2026-05-01T09:00:00.000Z',
          customerSnapshot: {
            name: 'Firmenname zum Rechnungszeitpunkt GmbH',
            contactPerson: '',
            street: 'Altstraße 1',
            zip: '10000',
            city: 'Altstadt',
            email: '',
            phone: '',
          },
        },
      ],
    } as Vorgang;

    const result = mergeVorgaengeFromPull([local], [row(vorgang(CUST_A))], DEVICE, WORKSPACE);
    const merged = result.vorgaenge[0]!;

    // Die Relation kommt an …
    expect(merged.customerId).toBe(CUST_A);
    // … die historischen Daten bleiben exakt, wie sie waren.
    expect(merged.customerBilling).toEqual(local.customerBilling);
    expect(merged.invoices[0]?.customerSnapshot).toEqual(local.invoices[0]?.customerSnapshot);
    expect(merged.customer).toBe(local.customer);
  });
});
