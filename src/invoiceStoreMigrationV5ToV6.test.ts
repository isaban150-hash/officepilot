/**
 * FIRST-CLASS-LOCAL-INVOICE-STORE-01B — der Umzug der Rechnungen.
 *
 * Bis V5 lag jede Rechnung im Vorgang, in dem sie entstanden ist. V6 legt sie
 * zentral ab und lässt den Vorgang nur noch auf sie zeigen. Der Umzug darf
 * nichts verlieren, nichts verändern und nichts doppelt ablegen.
 *
 * Die schärfste Prüfung ist deshalb nicht, ob die Rechnungen ankommen, sondern
 * ob sie **nur einmal** ankommen: Zwei Kopien im selben gespeicherten Zustand
 * wären eine zweite Wahrheit, die früher oder später auseinanderläuft.
 *
 * Synthetische Daten, kein Netz.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import {
  applyStateToStores,
  buildPersistedStateSnapshot,
  createSeedState,
  loadPersistedStateResultFromKey,
  persistAll,
  resetBusinessStateWriteLocksForTests,
  isBusinessStateWriteLocked,
} from './services/persistenceService';
import { bootstrapBusinessState } from './services/storage/storageBootstrapService';
import { buildStorageKey, setActiveStorageScope } from './services/storage/storageScopeService';
import { STORAGE_VERSION, STORAGE_VERSION_V5 } from './services/sync/syncMigrationService';
import { getAllVorgaenge, getVorgangById, immutableInvoiceFingerprint } from './services/vorgangService';
import { buildVorgangCloudContentKey } from './services/vorgang/vorgangCloudService';
import { listInvoices } from './services/invoice/invoiceRegistryService';
import { getNextInvoiceNumberPreview } from './services/invoiceNumberService';
import { updateInvoiceSentFields } from './services/vorgangService';
import { createAbschlagInvoice, createTestVorgang } from './test/fixtures';
import { resetTestStores } from './test/resetStores';
import type { AppPersistedState, VorgangInvoice } from './types/models';

const KEY = buildStorageKey({ type: 'guest' });

/** Eine Rechnung mit allen Lebenszyklusfeldern — der Umzug muss jedes tragen. */
function richInvoice(id: string, number: string): VorgangInvoice {
  return createAbschlagInvoice('op-test-1', 3, {
    id,
    number,
    status: 'versendet',
    issueDate: '2026-05-01',
    servicePeriodFrom: '2026-04-01',
    servicePeriodTo: '2026-04-30',
    customerSnapshot: {
      name: 'Kunde AG',
      contactPerson: 'Frau Meier',
      street: 'Weg 1',
      zip: '80331',
      city: 'München',
      email: 'k@b.invalid',
      phone: '089',
    },
    baustelle: 'Baustelle Nord',
    vorgangTitle: 'Dach Müller',
    payments: [
      { id: 'pay-1', date: '2026-05-10', amount: 100, createdAt: '2026-05-10T09:00:00.000Z' },
    ],
    paymentStatus: 'teilbezahlt',
    sentAt: '2026-05-02',
    sentVia: 'email',
    sentNote: 'per Mail',
    cancelledAt: undefined,
    archiveDocumentId: 'doc-archiv-1',
    legalNotices: ['Hinweis'],
  });
}

/** Ein gespeicherter V5-Zustand mit Rechnungen in den Vorgängen. */
function buildV5State(invoicesByVorgang: Record<string, VorgangInvoice[]>): AppPersistedState {
  const seed = createSeedState();
  return {
    ...seed,
    version: STORAGE_VERSION_V5,
    vorgaenge: Object.entries(invoicesByVorgang).map(([id, invoices]) =>
      createTestVorgang({ id, invoices }),
    ),
  } as AppPersistedState;
}

function writeRaw(state: unknown): string {
  const raw = JSON.stringify(state);
  localStorage.setItem(KEY, raw);
  return raw;
}

beforeEach(() => {
  resetTestStores();
  localStorage.clear();
  resetBusinessStateWriteLocksForTests();
  setActiveStorageScope({ type: 'guest' });
});

describe('FIRST-CLASS-LOCAL-INVOICE-STORE-01B — V5 zu V6', () => {
  it('R1/R2/R3: alle Rechnungen ziehen um, vollzählig und mit ihren Kennungen', () => {
    writeRaw(
      buildV5State({
        'v-a': [richInvoice('inv-a1', 'AR-1'), richInvoice('inv-a2', 'AR-2')],
        'v-b': [richInvoice('inv-b1', 'AR-3')],
      }),
    );

    const result = loadPersistedStateResultFromKey(KEY);
    expect(result.status).toBe('loaded');
    if (result.status !== 'loaded') return;

    expect(result.state.version).toBe(STORAGE_VERSION);
    expect(result.state.invoiceEntries?.map((entry) => entry.invoice.id)).toEqual([
      'inv-a1',
      'inv-a2',
      'inv-b1',
    ]);
  });

  it('R4: jedes Feld einer Rechnung bleibt unverändert', () => {
    const original = richInvoice('inv-a1', 'AR-1');
    writeRaw(buildV5State({ 'v-a': [original] }));

    const result = loadPersistedStateResultFromKey(KEY);
    expect(result.status).toBe('loaded');
    if (result.status !== 'loaded') return;

    expect(result.state.invoiceEntries?.[0]?.invoice).toEqual(original);
  });

  it('R5: die Zuordnung zum Vorgang bleibt erhalten', () => {
    writeRaw(
      buildV5State({ 'v-a': [richInvoice('inv-a1', 'AR-1')], 'v-b': [richInvoice('inv-b1', 'AR-2')] }),
    );

    const result = loadPersistedStateResultFromKey(KEY);
    if (result.status !== 'loaded') throw new Error('nicht geladen');

    expect(result.state.invoiceEntries?.map((entry) => [entry.invoice.id, entry.vorgangId])).toEqual([
      ['inv-a1', 'v-a'],
      ['inv-b1', 'v-b'],
    ]);
  });

  /*
   * R6/R7 — der Kern. Nach dem Umzug darf der gespeicherte Zustand die
   * Rechnungen genau einmal enthalten.
   */
  it('R6/R7: der gespeicherte Zustand trägt jede Rechnung genau einmal', () => {
    writeRaw(buildV5State({ 'v-a': [richInvoice('inv-a1', 'AR-1')] }));

    const result = loadPersistedStateResultFromKey(KEY);
    if (result.status !== 'loaded') throw new Error('nicht geladen');
    applyStateToStores(result.state);
    expect(persistAll().success).toBe(true);

    const stored = JSON.parse(localStorage.getItem(KEY)!) as AppPersistedState;
    expect(stored.invoiceEntries?.length, 'Rechnungen fehlen zentral').toBe(1);
    expect(
      stored.vorgaenge.flatMap((v) => v.invoices ?? []),
      'Zweite Rechnungskopie im Vorgang',
    ).toEqual([]);
    // Und der Rohtext nennt die Rechnungskennung genau einmal.
    expect(localStorage.getItem(KEY)!.split('inv-a1').length - 1).toBe(1);
  });

  it('R8/R9: nach dem Umzug zeigt die Laufzeitsicht die Rechnungen', () => {
    writeRaw(
      buildV5State({ 'v-a': [richInvoice('inv-a1', 'AR-1')], 'v-b': [richInvoice('inv-b1', 'AR-2')] }),
    );

    const result = loadPersistedStateResultFromKey(KEY);
    if (result.status !== 'loaded') throw new Error('nicht geladen');
    applyStateToStores(result.state);

    expect(getVorgangById('v-a')?.invoices.map((i) => i.id)).toEqual(['inv-a1']);
    expect(getAllVorgaenge().flatMap((v) => v.invoices.map((i) => i.id))).toEqual([
      'inv-a1',
      'inv-b1',
    ]);
    expect(listInvoices().map((i) => i.id)).toEqual(['inv-a1', 'inv-b1']);
  });

  it('R24: ein Neuladen von V6 dupliziert nichts und migriert nicht erneut', () => {
    writeRaw(buildV5State({ 'v-a': [richInvoice('inv-a1', 'AR-1')] }));
    const first = loadPersistedStateResultFromKey(KEY);
    if (first.status !== 'loaded') throw new Error('nicht geladen');
    applyStateToStores(first.state);
    persistAll();

    resetTestStores();

    const second = loadPersistedStateResultFromKey(KEY);
    if (second.status !== 'loaded') throw new Error('nicht geladen');
    expect(second.state.version).toBe(STORAGE_VERSION);
    applyStateToStores(second.state);

    expect(listInvoices().map((i) => i.id)).toEqual(['inv-a1']);
    expect(getVorgangById('v-a')?.invoices.map((i) => i.id)).toEqual(['inv-a1']);
  });

  it('R42: Rechnungen gelöschter Vorgänge gehen nicht verloren', () => {
    const state = buildV5State({ 'v-a': [richInvoice('inv-a1', 'AR-1')] });
    state.vorgaenge[0]!.sync = { ...state.vorgaenge[0]!.sync!, deleted: true };
    writeRaw(state);

    const result = loadPersistedStateResultFromKey(KEY);
    if (result.status !== 'loaded') throw new Error('nicht geladen');

    expect(result.state.invoiceEntries?.map((e) => e.invoice.id)).toEqual(['inv-a1']);
  });
});

describe('FIRST-CLASS-LOCAL-INVOICE-STORE-01B — doppelte Kennung sperrt', () => {
  /*
   * R12/R13 — zwei Vorgänge mit derselben Rechnungskennung sind ein
   * Datenschaden. Beim Umzug wäre jede Auswahl geraten; „erste gewinnt" würde
   * eine Rechnung stillschweigend verschwinden lassen. Also gar nicht umziehen.
   */
  it('R12/R13: der Umzug scheitert kontrolliert und lässt den Bestand unberührt', () => {
    const rawBefore = writeRaw(
      buildV5State({
        'v-a': [richInvoice('inv-doppelt', 'AR-1')],
        'v-b': [richInvoice('inv-doppelt', 'AR-2')],
      }),
    );

    const result = loadPersistedStateResultFromKey(KEY);

    expect(result.status, 'Der Umzug lief trotz Duplikat durch').toBe('failed');
    expect(localStorage.getItem(KEY), 'Der V5-Bestand wurde verändert').toBe(rawBefore);
  });

  it('R38: danach greifen die bestehenden Schutzmechanismen', () => {
    const rawBefore = writeRaw(
      buildV5State({
        'v-a': [richInvoice('inv-doppelt', 'AR-1')],
        'v-b': [richInvoice('inv-doppelt', 'AR-2')],
      }),
    );

    /*
     * Der reale Weg: Der Bootstrap lädt, meldet den Fehler und sperrt den
     * Bereich. Danach darf keine Nutzeraktion mehr schreiben — sonst
     * überschriebe die leere App den geretteten V5-Bestand.
     */
    const bootstrap = bootstrapBusinessState();

    expect(bootstrap.loadFailed, 'Der Fehler wurde als Erststart behandelt').toBe(true);
    expect(isBusinessStateWriteLocked(KEY)).toBe(true);
    expect(persistAll().success).toBe(false);
    expect(localStorage.getItem(KEY), 'Der V5-Bestand wurde überschrieben').toBe(rawBefore);
  });
});

describe('FIRST-CLASS-LOCAL-INVOICE-STORE-01B — was unverändert bleiben muss', () => {
  function seedLoadedV6(): void {
    writeRaw(
      buildV5State({ 'v-a': [richInvoice('inv-a1', '2026-0007')], 'v-b': [richInvoice('inv-b1', '2026-0003')] }),
    );
    const result = loadPersistedStateResultFromKey(KEY);
    if (result.status !== 'loaded') throw new Error('nicht geladen');
    applyStateToStores(result.state);
  }

  it('R20: der Fingerprint einer bestehenden Rechnung bleibt gleich', () => {
    const original = richInvoice('inv-a1', '2026-0007');
    const before = immutableInvoiceFingerprint(original, 'v-a');

    seedLoadedV6();
    const after = immutableInvoiceFingerprint(getVorgangById('v-a')!.invoices[0]!, 'v-a');

    expect(after).toBe(before);
  });

  it('R21/R22: der Vorgang-Cloud-Schlüssel bleibt rechnungsfrei', () => {
    seedLoadedV6();
    const before = buildVorgangCloudContentKey(getVorgangById('v-a')!);

    expect(before, 'Rechnungen im Vorgang-Cloud-Schlüssel').not.toContain('inv-a1');

    updateInvoiceSentFields('v-a', 'inv-a1', {
      status: 'versendet',
      sentAt: '2026-09-09',
      sentVia: 'post',
    });

    expect(
      buildVorgangCloudContentKey(getVorgangById('v-a')!),
      'Eine Rechnungsänderung veränderte den Vorgang-Cloud-Schlüssel',
    ).toBe(before);
  });

  it('R30: der Nummernkreis berücksichtigt weiterhin alle Rechnungen', () => {
    seedLoadedV6();

    // Höchste vorhandene Nummer ist 2026-0007.
    expect(getNextInvoiceNumberPreview()).toBe('2026-0008');
  });
});

describe('FIRST-CLASS-LOCAL-INVOICE-STORE-01B — Sicherung', () => {
  it('R25: der Sicherungsschnappschuss trägt die Rechnungen genau einmal', () => {
    writeRaw(buildV5State({ 'v-a': [richInvoice('inv-a1', 'AR-1')] }));
    const result = loadPersistedStateResultFromKey(KEY);
    if (result.status !== 'loaded') throw new Error('nicht geladen');
    applyStateToStores(result.state);

    const snapshot = buildPersistedStateSnapshot();

    expect(snapshot.invoiceEntries?.map((e) => e.invoice.id)).toEqual(['inv-a1']);
    expect(snapshot.vorgaenge.flatMap((v) => v.invoices ?? [])).toEqual([]);
  });

  it('R25b: eine Wiederherstellung stellt die Rechnungen vollständig her', () => {
    writeRaw(buildV5State({ 'v-a': [richInvoice('inv-a1', 'AR-1')] }));
    const result = loadPersistedStateResultFromKey(KEY);
    if (result.status !== 'loaded') throw new Error('nicht geladen');
    applyStateToStores(result.state);
    const snapshot = buildPersistedStateSnapshot();

    resetTestStores();
    expect(listInvoices()).toEqual([]);

    applyStateToStores(snapshot);

    expect(listInvoices().map((i) => i.id)).toEqual(['inv-a1']);
    expect(getVorgangById('v-a')?.invoices.map((i) => i.id)).toEqual(['inv-a1']);
  });
});
