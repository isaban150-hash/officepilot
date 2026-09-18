/**
 * CLOUD-DURABILITY-CORE-01D — der Mahnnachweis überlebt das Gerät.
 *
 * Die Dokumentation einer übergebenen Zahlungserinnerung oder Mahnung war rein
 * lokal — sie war nicht einmal ein `SyncEntityType`. Auf einem zweiten Gerät
 * fehlte damit nicht nur die Historie, sondern auch die dokumentierte
 * Mahnstufe, aus der `resolveDunningAction` die nächste fällige Aktion ableitet.
 *
 * **Drei Punkte tragen diesen Block und werden deshalb hart geprüft:**
 *
 * Erstens: Der Nachweis ist append-only. Er wird nie bearbeitet und nie
 * gelöscht — auch nicht, wenn die Rechnung später storniert wird oder der
 * Auftrag verschwindet. Die historische Rechnungsnummer bleibt stehen.
 *
 * Zweitens: Seine fachliche Identität stammt aus dem Produkt, nicht aus diesem
 * Block. `documentDunningDelivery` lehnt eine zweite Bestätigung derselben
 * Übergabe ab (Rechnung, Auftragsbezug, Art, Datum, Weg); genau dieser
 * Fünfklang ist der Eindeutigkeitsschlüssel in der Cloud.
 *
 * Drittens: Die freie Rechnung ohne Auftrag (`vorgangId === null`) ist ein
 * gleichwertiger Fall — `null` und leere Kennung dürfen im Schlüssel nicht
 * auseinanderfallen.
 *
 * Neutrale Beispieldaten.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  applyDunningDocumentationDedupeResolution,
  applyDunningDocumentationPushResult,
  buildDunningDocumentationCloudContentKey,
  buildDunningDocumentationCloudPushPayload,
  buildDunningDocumentationIdentityKey,
  dunningDocumentationFromCloud,
  mapWorkspaceDunningDocumentationRow,
  mergeDunningDocumentationsFromPull,
  planDunningDocumentationBackfill,
  resolveLocalDunningDocumentationDuplicates,
  stripDunningDocumentationForCloud,
  type WorkspaceDunningDocumentationRow,
} from './dunningDocumentationCloudService';
import {
  LOCAL_ONLY_SYNC_ENTITY_TYPES,
  SUPABASE_SYNC_ALLOWLIST,
} from '../sync/cloudSyncAllowlist';
import { APPEND_ONLY_ENTITY_TYPES, listEntitiesByType } from '../sync/syncEntityRegistry';
import { extractCloudSyncEntity } from '../workspace/workspaceSyncPayloadService';
import {
  documentDunningDelivery,
  getDocumentedDunningLevel,
  getDunningDocumentationsForInvoice,
  getLatestDunningDocumentation,
  setDunningDocumentationStoreForTests,
} from '../dunningDocumentationService';
import type { AppPersistedState } from '../../types/models';
import type { InvoiceDunningDocumentation } from '../../types/dunningDocumentation';
import type { SyncMeta } from '../../types/sync';
import type { VorgangInvoice } from '../../types/models';
import { DEFAULT_COMPANY_PROFILE } from '../../data/companyProfileDefaults';
import { createTestVorgang } from '../../test/fixtures';
import { hydrateVorgangStore } from '../vorgangService';

const DEVICE = 'device-01d';
const WORKSPACE = 'ws-01d';

function documentation(
  overrides: Partial<InvoiceDunningDocumentation> = {},
): InvoiceDunningDocumentation {
  return {
    id: 'dunning-doc-a',
    vorgangId: 'v-1000',
    invoiceId: 'inv-0001',
    invoiceNumber: '2026-0007',
    kind: 'payment_reminder',
    documentedAt: '2026-06-10',
    deliveryMethod: 'email',
    createdAt: '2026-06-10T09:00:00.000Z',
    ...overrides,
  };
}

/** Die freie Rechnung ohne Auftrag — gleichwertiger Fall, nicht Sonderfall. */
function freeInvoiceDocumentation(
  overrides: Partial<InvoiceDunningDocumentation> = {},
): InvoiceDunningDocumentation {
  return documentation({ id: 'dunning-doc-free', vorgangId: null, invoiceId: 'inv-free-1', ...overrides });
}

function syncMeta(version: number, overrides: Partial<SyncMeta> = {}): SyncMeta {
  return {
    updatedAt: '2026-06-11T10:00:00.000Z',
    version,
    deleted: false,
    deviceId: DEVICE,
    workspaceId: WORKSPACE,
    ...overrides,
  };
}

function row(
  base: InvoiceDunningDocumentation = documentation(),
  overrides: Partial<WorkspaceDunningDocumentationRow> = {},
): WorkspaceDunningDocumentationRow {
  return {
    workspace_id: WORKSPACE,
    client_documentation_id: base.id,
    client_invoice_id: base.invoiceId,
    client_vorgang_id: base.vorgangId,
    kind: base.kind,
    documented_at: base.documentedAt,
    delivery_method: base.deliveryMethod,
    payload: stripDunningDocumentationForCloud(base) as unknown as Record<string, unknown>,
    row_version: 1,
    updated_at: '2026-06-11T10:00:00.000Z',
    updated_by: 'user-1',
    ...overrides,
  };
}

/* ------------------------------------------------------------------------ */
/* Payload, Content-Key, Identität                                           */
/* ------------------------------------------------------------------------ */

describe('DUNNING-CLOUD-01D — Payload und Identität', () => {
  it('1: der Cloud-Payload trägt keine Sync-Metadaten', () => {
    const payload = stripDunningDocumentationForCloud({
      ...documentation(),
      sync: syncMeta(3),
    }) as Record<string, unknown>;
    expect('sync' in payload).toBe(false);
    expect(payload.invoiceNumber).toBe('2026-0007');
  });

  it('2: eine neue Serverversion ändert den Content-Key nicht (kein Echo-Push)', () => {
    const before = buildDunningDocumentationCloudContentKey({ ...documentation(), sync: syncMeta(1) });
    const after = buildDunningDocumentationCloudContentKey({ ...documentation(), sync: syncMeta(9) });
    expect(after).toBe(before);
  });

  it('3: jede fachliche Abweichung ändert den Content-Key', () => {
    const key = buildDunningDocumentationCloudContentKey(documentation());
    const variants = [
      documentation({ kind: 'dunning_notice' }),
      documentation({ documentedAt: '2026-06-11' }),
      documentation({ deliveryMethod: 'post' }),
      documentation({ invoiceNumber: '2026-0008' }),
      documentation({ note: 'Telefonisch angekündigt' }),
      documentation({ vorgangId: null }),
    ];
    for (const variant of variants) {
      expect(buildDunningDocumentationCloudContentKey(variant)).not.toBe(key);
    }
  });

  it('4: die Identität folgt der Produktregel — Notiz gehört nicht dazu', () => {
    const base = documentation();
    expect(buildDunningDocumentationIdentityKey(documentation({ note: 'anders' }))).toBe(
      buildDunningDocumentationIdentityKey(base),
    );
    expect(buildDunningDocumentationIdentityKey(documentation({ kind: 'dunning_notice' }))).not.toBe(
      buildDunningDocumentationIdentityKey(base),
    );
    expect(buildDunningDocumentationIdentityKey(documentation({ documentedAt: '2026-06-11' }))).not.toBe(
      buildDunningDocumentationIdentityKey(base),
    );
    expect(buildDunningDocumentationIdentityKey(documentation({ deliveryMethod: 'post' }))).not.toBe(
      buildDunningDocumentationIdentityKey(base),
    );
  });

  it('5: freie Rechnung ohne Auftrag hat eine eigene, stabile Identität', () => {
    const free = freeInvoiceDocumentation();
    expect(buildDunningDocumentationIdentityKey(free)).toBe(
      buildDunningDocumentationIdentityKey({ ...free, vorgangId: null }),
    );
    expect(buildDunningDocumentationIdentityKey(free)).not.toBe(
      buildDunningDocumentationIdentityKey({ ...free, vorgangId: 'v-1000' }),
    );
  });

  it('6: die Push-Form trägt Kennung, Bezüge und Identitätsfelder', () => {
    const payload = buildDunningDocumentationCloudPushPayload(documentation());
    expect(payload.documentation_id).toBe('dunning-doc-a');
    expect(payload.invoice_id).toBe('inv-0001');
    expect(payload.vorgang_id).toBe('v-1000');
    expect(payload.kind).toBe('payment_reminder');
    expect(payload.documented_at).toBe('2026-06-10');
    expect(payload.delivery_method).toBe('email');
    // Append-only: kein Grabstein-Flag im Payload.
    expect('deleted' in payload).toBe(false);

    const free = buildDunningDocumentationCloudPushPayload(freeInvoiceDocumentation());
    expect(free.vorgang_id).toBeNull();
  });
});

/* ------------------------------------------------------------------------ */
/* Serverzeile, Pull, Merge                                                  */
/* ------------------------------------------------------------------------ */

describe('DUNNING-CLOUD-01D — Pull und Merge', () => {
  it('7: eine Cloud-Zeile wird vollständig gelesen', () => {
    const mapped = mapWorkspaceDunningDocumentationRow(row(documentation(), { row_version: 4 }));
    expect(mapped?.documentationId).toBe('dunning-doc-a');
    expect(mapped?.rowVersion).toBe(4);
    expect(mapped?.payload.invoiceNumber).toBe('2026-0007');
  });

  it('8: Serverspalten wandern nicht in den Fachdatensatz', () => {
    const mapped = mapWorkspaceDunningDocumentationRow(
      row(documentation(), {
        payload: { ...(row().payload as object), workspace_id: WORKSPACE, row_version: 9 },
      }),
    );
    expect(mapped?.payload && 'workspace_id' in mapped.payload).toBe(false);
    expect(mapped?.payload && 'row_version' in mapped.payload).toBe(false);
  });

  it('9: eine unbekannte Cloud-Zeile kommt lokal an', () => {
    const merged = mergeDunningDocumentationsFromPull([], [row()], DEVICE, WORKSPACE);
    expect(merged.conflicts).toEqual([]);
    expect(merged.documentations.map((doc) => doc.id)).toEqual(['dunning-doc-a']);
    expect(merged.documentations[0].sync?.version).toBe(1);
  });

  it('10: die freie Rechnung ohne Auftrag kommt mit vorgangId null an', () => {
    const merged = mergeDunningDocumentationsFromPull(
      [],
      [row(freeInvoiceDocumentation())],
      DEVICE,
      WORKSPACE,
    );
    expect(merged.documentations[0].vorgangId).toBeNull();
  });

  it('11: gleiche Version mit gleichem Inhalt erzeugt keinen Konflikt', () => {
    const local = { ...documentation(), sync: syncMeta(1) };
    const merged = mergeDunningDocumentationsFromPull([local], [row()], DEVICE, WORKSPACE);
    expect(merged.conflicts).toEqual([]);
    expect(merged.documentations).toHaveLength(1);
  });

  it('12: gleiche Version mit abweichendem Nachweis ist ein Konflikt', () => {
    const local = { ...documentation({ deliveryMethod: 'post' }), sync: syncMeta(1) };
    const merged = mergeDunningDocumentationsFromPull([local], [row()], DEVICE, WORKSPACE);
    expect(merged.conflicts).toEqual(['dunning_documentation:dunning-doc-a']);
  });

  it('13: die höhere Serverversion gewinnt', () => {
    const local = { ...documentation(), sync: syncMeta(1) };
    const remote = row(documentation({ note: 'Nachtrag' }), { row_version: 2 });
    const merged = mergeDunningDocumentationsFromPull([local], [remote], DEVICE, WORKSPACE);
    expect(merged.conflicts).toEqual([]);
    expect(merged.documentations[0].note).toBe('Nachtrag');
    expect(merged.documentations[0].sync?.version).toBe(2);
  });

  it('14: der Pull ergänzt, er verwirft keinen lokalen Nachweis', () => {
    const localOnly = documentation({ id: 'dunning-doc-local', documentedAt: '2026-06-12' });
    const merged = mergeDunningDocumentationsFromPull([localOnly], [row()], DEVICE, WORKSPACE);
    expect(merged.documentations.map((doc) => doc.id).sort()).toEqual([
      'dunning-doc-a',
      'dunning-doc-local',
    ]);
  });
});

/* ------------------------------------------------------------------------ */
/* Entdopplung und Altbestand                                                */
/* ------------------------------------------------------------------------ */

describe('DUNNING-CLOUD-01D — Entdopplung und Altbestand', () => {
  it('15: zwei Geräte, dieselbe Übergabe — einer bleibt', () => {
    const canonical = { ...documentation({ id: 'dunning-doc-a' }), sync: syncMeta(1) };
    const own = documentation({ id: 'dunning-doc-b', createdAt: '2026-06-10T09:00:05.000Z' });
    const resolved = resolveLocalDunningDocumentationDuplicates([canonical, own]);
    expect(resolved.removedIds).toEqual(['dunning-doc-b']);
    expect(resolved.documentations.map((doc) => doc.id)).toEqual(['dunning-doc-a']);
  });

  it('16: eine bewusst andere Angabe bleibt eine eigene Zeile', () => {
    const first = { ...documentation({ id: 'dunning-doc-a' }), sync: syncMeta(1) };
    const second = documentation({ id: 'dunning-doc-b', kind: 'dunning_notice' });
    const third = documentation({ id: 'dunning-doc-c', documentedAt: '2026-06-20' });
    const resolved = resolveLocalDunningDocumentationDuplicates([first, second, third]);
    expect(resolved.removedIds).toEqual([]);
    expect(resolved.documentations).toHaveLength(3);
  });

  it('17: ein Eintrag mit offenem Sendeauftrag wird nicht still entfernt', () => {
    const canonical = { ...documentation({ id: 'dunning-doc-a' }), sync: syncMeta(1) };
    const own = documentation({ id: 'dunning-doc-b', createdAt: '2026-06-10T09:00:05.000Z' });
    const resolved = resolveLocalDunningDocumentationDuplicates(
      [canonical, own],
      new Set(['dunning-doc-b']),
    );
    expect(resolved.removedIds).toEqual([]);
  });

  it('18: die Wiederholungsantwort ersetzt den eigenen Eintrag durch den kanonischen', () => {
    const own = documentation({ id: 'dunning-doc-b' });
    const canonical = { ...documentation({ id: 'dunning-doc-a' }), sync: syncMeta(1) };
    const result = applyDunningDocumentationDedupeResolution([own], 'dunning-doc-b', canonical);
    expect(result.map((doc) => doc.id)).toEqual(['dunning-doc-a']);
  });

  it('19: Altbestand wird nachgemeldet, Bekanntes nicht erneut', () => {
    expect(planDunningDocumentationBackfill([documentation()], [])).toEqual(['dunning-doc-a']);
    expect(planDunningDocumentationBackfill([documentation()], [row()])).toEqual([]);
    expect(planDunningDocumentationBackfill([freeInvoiceDocumentation()], [])).toEqual([
      'dunning-doc-free',
    ]);
  });

  it('20: das Push-Ergebnis setzt nur die Serverversion', () => {
    const docs = applyDunningDocumentationPushResult(
      [documentation()],
      'dunning-doc-a',
      3,
      '2026-06-12T11:00:00.000Z',
      DEVICE,
      WORKSPACE,
    );
    expect(docs[0].invoiceNumber).toBe('2026-0007');
    expect(docs[0].kind).toBe('payment_reminder');
    expect(docs[0].sync?.version).toBe(3);
    expect(docs[0].sync?.deleted).toBe(false);
  });
});

/* ------------------------------------------------------------------------ */
/* Historie, Lebensdauer, Registrierung                                      */
/* ------------------------------------------------------------------------ */

describe('DUNNING-CLOUD-01D — Historie und Registrierung', () => {
  it('21: ein gepullter Nachweis trägt die Mahnstufe und die Historie', () => {
    const pulled = dunningDocumentationFromCloud(
      'dunning-doc-a',
      stripDunningDocumentationForCloud(documentation({ kind: 'dunning_notice' })),
      2,
      '2026-06-11T10:00:00.000Z',
      DEVICE,
      WORKSPACE,
    );
    setDunningDocumentationStoreForTests([pulled]);
    expect(getDocumentedDunningLevel('v-1000', 'inv-0001')).toBe(2);
    expect(getLatestDunningDocumentation('v-1000', 'inv-0001')?.invoiceNumber).toBe('2026-0007');
    expect(getDunningDocumentationsForInvoice('v-1000', 'inv-0001')).toHaveLength(1);
  });

  it('22: die Historie der freien Rechnung wird nicht mit der eines Auftrags vermischt', () => {
    setDunningDocumentationStoreForTests([
      { ...freeInvoiceDocumentation(), sync: syncMeta(1) },
      { ...documentation(), sync: syncMeta(1) },
    ]);
    expect(getDunningDocumentationsForInvoice(null, 'inv-free-1')).toHaveLength(1);
    expect(getDocumentedDunningLevel(null, 'inv-free-1')).toBe(1);
    expect(getDunningDocumentationsForInvoice('v-1000', 'inv-free-1')).toHaveLength(0);
  });

  it('23: der Nachweis überlebt Storno und verschwundenen Auftrag', () => {
    /*
     * Der Nachweis hängt an keiner Rechnung und an keinem Auftrag — er trägt
     * deren Kennungen und die historische Rechnungsnummer als Kopie. Ein
     * storniertes oder gelöschtes Gegenüber ändert daran nichts; genau das
     * bildet die Cloud-Zeile ohne Fremdschlüssel ab.
     */
    const doc = { ...documentation(), sync: syncMeta(1) };
    setDunningDocumentationStoreForTests([doc]);
    const state = {
      dunningDocumentations: [doc],
      vorgaenge: [],
      invoiceEntries: [],
    } as unknown as AppPersistedState;

    expect(listEntitiesByType(state, 'dunning_documentation')).toHaveLength(1);
    expect(getDunningDocumentationsForInvoice('v-1000', 'inv-0001')[0].invoiceNumber).toBe('2026-0007');
    expect(getDocumentedDunningLevel('v-1000', 'inv-0001')).toBe(1);
  });

  it('24: der Push-Extraktor liefert die bestätigte Version und nie einen Grabstein', () => {
    const state = {
      dunningDocumentations: [{ ...documentation(), sync: syncMeta(5) }],
    } as AppPersistedState;
    const extracted = extractCloudSyncEntity(state, 'dunning_documentation', 'dunning-doc-a');
    expect(extracted?.entityType).toBe('dunning_documentation');
    expect(extracted?.rowVersion).toBe(5);
    expect(extracted && 'deleted' in extracted && extracted.deleted).toBe(false);
  });

  it('25: dunning_documentation ist freigegeben, append-only und nicht nur-lokal', () => {
    expect(SUPABASE_SYNC_ALLOWLIST.has('dunning_documentation')).toBe(true);
    expect(LOCAL_ONLY_SYNC_ENTITY_TYPES.has('dunning_documentation')).toBe(false);
    expect(APPEND_ONLY_ENTITY_TYPES).toContain('dunning_documentation');
  });
});

/* ------------------------------------------------------------------------ */
/* Der Weg in die Outbox: Erzeugung im Fachdienst                            */
/* ------------------------------------------------------------------------ */

/**
 * Hier wird geprüft, was 01D am bestehenden Dienst überhaupt verändert hat:
 * die Kennung und das Fehlen einer erfundenen Serverversion. Die fachlichen
 * Regeln — wann dokumentiert werden darf und wann eine zweite Bestätigung
 * derselben Übergabe abgewiesen wird — sind unverändert und stehen im
 * bestehenden Dienstest.
 */
function sentInvoice(overrides: Partial<VorgangInvoice> = {}): VorgangInvoice {
  return {
    id: 'inv-01d-1',
    number: '2026-0099',
    type: 'schluss',
    positions: [],
    subtotal: 1000,
    taxStatus: 'standard_19',
    amount: 1190,
    status: 'versendet',
    sentAt: '2026-06-01',
    sentVia: 'email',
    date: '2026-06-01',
    createdAt: '2026-06-01T00:00:00.000Z',
    issueDate: '2026-06-01',
    paymentDueDate: '2026-06-08',
    customerSnapshot: {
      name: 'Beispiel Kunde GmbH',
      contactPerson: '',
      street: '',
      zip: '',
      city: '',
      email: '',
      phone: '',
    },
    companySnapshot: { ...DEFAULT_COMPANY_PROFILE, companyName: 'Muster GmbH' },
    legalNotices: [],
    previousAbschlagDeductions: [],
    paymentStatus: 'offen',
    payments: [],
    ...overrides,
  } as VorgangInvoice;
}

describe('DUNNING-CLOUD-01D — Erzeugung im Fachdienst', () => {
  beforeEach(() => {
    setDunningDocumentationStoreForTests([]);
    hydrateVorgangStore([
      createTestVorgang({ id: 'v-01d', invoices: [sentInvoice()] }),
    ]);
  });

  it('26: eine Zahlungserinnerung entsteht ohne behauptete Serverversion', () => {
    const result = documentDunningDelivery('v-01d', 'inv-01d-1', {
      kind: 'payment_reminder',
      documentedAt: '2026-06-15',
      deliveryMethod: 'email',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.documentation.sync).toBeUndefined();
    expect(getDocumentedDunningLevel('v-01d', 'inv-01d-1')).toBe(1);
  });

  it('27: die Kennung ist nicht mehr zeitstempelbasiert und damit kollisionsfrei', () => {
    const first = documentDunningDelivery('v-01d', 'inv-01d-1', {
      kind: 'payment_reminder',
      documentedAt: '2026-06-15',
      deliveryMethod: 'email',
    });
    const second = documentDunningDelivery('v-01d', 'inv-01d-1', {
      kind: 'dunning_notice',
      documentedAt: '2026-06-15',
      deliveryMethod: 'post',
    });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    // Zwei Nachweise in derselben Millisekunde trugen vorher dieselbe Kennung.
    expect(second.documentation.id).not.toBe(first.documentation.id);
    expect(first.documentation.id).not.toMatch(/^dunning-doc-\d+$/);
    expect(getDocumentedDunningLevel('v-01d', 'inv-01d-1')).toBe(2);
  });

  it('28: dieselbe Übergabe zweimal bestätigt bleibt ein Eintrag', () => {
    const first = documentDunningDelivery('v-01d', 'inv-01d-1', {
      kind: 'payment_reminder',
      documentedAt: '2026-06-15',
      deliveryMethod: 'email',
    });
    const again = documentDunningDelivery('v-01d', 'inv-01d-1', {
      kind: 'payment_reminder',
      documentedAt: '2026-06-15',
      deliveryMethod: 'email',
      note: 'zweiter Klick',
    });
    expect(first.ok && again.ok).toBe(true);
    if (!first.ok || !again.ok) return;
    expect(again.alreadyDocumented).toBe(true);
    expect(again.documentation.id).toBe(first.documentation.id);
    expect(getDunningDocumentationsForInvoice('v-01d', 'inv-01d-1')).toHaveLength(1);
  });

  it('29: der erzeugte Nachweis ist sofort push-fähig und trägt seine Identität', () => {
    const result = documentDunningDelivery('v-01d', 'inv-01d-1', {
      kind: 'payment_reminder',
      documentedAt: '2026-06-15',
      deliveryMethod: 'email',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const payload = buildDunningDocumentationCloudPushPayload(result.documentation);
    expect(payload.invoice_id).toBe('inv-01d-1');
    expect(payload.vorgang_id).toBe('v-01d');
    expect(payload.documented_at).toBe('2026-06-15');
    expect((payload.payload as Record<string, unknown>).invoiceNumber).toBe('2026-0099');
  });
});
