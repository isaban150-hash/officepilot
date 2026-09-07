/**
 * FIRST-CLASS-LOCAL-INVOICE-STORE-01B2 — der Speicher darf nichts überdauern.
 *
 * Ein zentraler Rechnungsspeicher bringt eine Gefahr mit, die die verschachtelte
 * Ablage nicht hatte: Er lebt im Modul, nicht im Vorgangsbestand. Bliebe beim
 * Wechsel des Arbeitsbereichs auch nur ein Eintrag stehen, tauchte die Rechnung
 * eines fremden Betriebs im nächsten auf — und der nächste Speichervorgang
 * schriebe sie dort fest.
 *
 * Ebenso darf ein beschädigter V6-Zustand nicht als „null Rechnungen"
 * durchgehen: Das sähe wie ein leerer Betrieb aus und wäre in Wahrheit ein
 * Datenverlust.
 *
 * Synthetische Daten, kein Netz.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { getInvoiceStoreSnapshot } from './invoiceStore';
import { listInvoices } from './invoiceRegistryService';
import {
  applyStateToStores,
  buildPersistedStateSnapshot,
  createSeedState,
  persistAll,
  resetBusinessStateWriteLocksForTests,
  savePersistedStateToKey,
} from '../persistenceService';
import { bootstrapBusinessState, isolateBusinessStateOnLogout } from '../storage/storageBootstrapService';
import { buildStorageKey, setActiveStorageScope, type StorageScope } from '../storage/storageScopeService';
import { isValidPersistedStateV6, STORAGE_VERSION } from '../sync/syncMigrationService';
import { getAllVorgaenge, getVorgangById, hydrateVorgangStore } from '../vorgangService';
import { createAbschlagInvoice, createTestVorgang } from '../../test/fixtures';
import { resetTestStores } from '../../test/resetStores';
import type { AppPersistedState, VorgangInvoice } from '../../types/models';

const SCOPE_A: StorageScope = { type: 'workspace', workspaceId: 'ws-a' };
const SCOPE_B: StorageScope = { type: 'workspace', workspaceId: 'ws-b' };

function invoice(id: string): VorgangInvoice {
  return createAbschlagInvoice('op-test-1', 1, { id, number: `AR-${id}` });
}

/** Legt für einen Bereich einen gespeicherten Bestand an. */
function seedScope(scope: StorageScope, invoices: VorgangInvoice[]): void {
  setActiveStorageScope(scope);
  resetTestStores();
  hydrateVorgangStore([createTestVorgang({ id: `v-${(scope as { workspaceId: string }).workspaceId}`, invoices })]);
  savePersistedStateToKey(scope, buildPersistedStateSnapshot());
}

beforeEach(() => {
  resetTestStores();
  localStorage.clear();
  resetBusinessStateWriteLocksForTests();
  setActiveStorageScope({ type: 'guest' });
});

describe('FIRST-CLASS-LOCAL-INVOICE-STORE-01B2 — kein Übersprechen zwischen Bereichen', () => {
  /*
   * L1 — der Pflichtfall. Geprüft wird über den echten Bootstrap-Weg, nicht
   * über die Speicherfunktionen selbst: Nur so ist belegt, dass der Ablauf, den
   * die App wirklich geht, den alten Bestand wegräumt.
   */
  it('L1: ein Bereichswechsel lässt keine fremde Rechnung stehen', () => {
    seedScope(SCOPE_A, [invoice('inv-a1')]);
    seedScope(SCOPE_B, []);

    bootstrapBusinessState({ userId: 'u-1', workspaceId: 'ws-a' });
    expect(listInvoices().map((i) => i.id)).toEqual(['inv-a1']);

    bootstrapBusinessState({ userId: 'u-1', workspaceId: 'ws-b' });

    expect(listInvoices(), 'Eine fremde Rechnung blieb im Speicher').toEqual([]);
    expect(getInvoiceStoreSnapshot()).toEqual([]);
    expect(getAllVorgaenge().flatMap((v) => v.invoices)).toEqual([]);
  });

  it('L2: ein Bereich ohne gespeicherten Zustand startet ohne Rechnungen', () => {
    seedScope(SCOPE_A, [invoice('inv-a1')]);
    bootstrapBusinessState({ userId: 'u-1', workspaceId: 'ws-a' });
    expect(listInvoices()).toHaveLength(1);

    // ws-c existiert nicht — echter Erststart.
    bootstrapBusinessState({ userId: 'u-1', workspaceId: 'ws-c' });

    expect(listInvoices(), 'Der Erststart erbte Rechnungen').toEqual([]);
  });

  it('L3: ein Ladefehler lässt keine alten Rechnungen sichtbar', () => {
    seedScope(SCOPE_A, [invoice('inv-a1')]);
    bootstrapBusinessState({ userId: 'u-1', workspaceId: 'ws-a' });
    expect(listInvoices()).toHaveLength(1);

    localStorage.setItem(buildStorageKey(SCOPE_B), '{beschädigt');
    const result = bootstrapBusinessState({ userId: 'u-1', workspaceId: 'ws-b' });

    expect(result.loadFailed).toBe(true);
    expect(listInvoices(), 'Nach einem Ladefehler blieben Rechnungen stehen').toEqual([]);
  });

  it('L4: das Abmelden räumt die Rechnungen weg', () => {
    seedScope(SCOPE_A, [invoice('inv-a1')]);
    bootstrapBusinessState({ userId: 'u-1', workspaceId: 'ws-a' });
    expect(listInvoices()).toHaveLength(1);

    isolateBusinessStateOnLogout();

    expect(listInvoices(), 'Nach dem Abmelden blieben Rechnungen stehen').toEqual([]);
  });

  it('L5: eine erneute Hydration ersetzt den Bestand, statt ihn zu ergänzen', () => {
    hydrateVorgangStore([createTestVorgang({ id: 'v-a', invoices: [invoice('inv-a1')] })]);
    hydrateVorgangStore([createTestVorgang({ id: 'v-a', invoices: [invoice('inv-a2')] })]);

    expect(listInvoices().map((i) => i.id)).toEqual(['inv-a2']);
  });
});

describe('FIRST-CLASS-LOCAL-INVOICE-STORE-01B2 — ein V6-Zustand muss seine Rechnungen mitbringen', () => {
  function v6State(overrides: Partial<AppPersistedState> = {}): Record<string, unknown> {
    return { ...createSeedState(), version: STORAGE_VERSION, ...overrides } as unknown as Record<
      string,
      unknown
    >;
  }

  it('V1: ein gültiger V6-Zustand wird angenommen', () => {
    expect(isValidPersistedStateV6(v6State({ invoiceEntries: [] }))).toBe(true);
    expect(
      isValidPersistedStateV6(
        v6State({ invoiceEntries: [{ invoice: invoice('inv-a1'), vorgangId: 'v-a' }] }),
      ),
    ).toBe(true);
    // Ein späterer Eintrag ohne Auftragsbezug bleibt strukturell zulässig.
    expect(
      isValidPersistedStateV6(
        v6State({ invoiceEntries: [{ invoice: invoice('inv-a1'), vorgangId: null }] }),
      ),
    ).toBe(true);
  });

  /*
   * V2 — der gefährlichste Fall: Ein V6-Zustand ohne Rechnungsabschnitt sähe
   * wie ein Betrieb ohne Rechnungen aus. Er darf nicht als gültig gelten,
   * sondern muss in den bestehenden Fehlerpfad laufen.
   */
  it('V2: ein V6-Zustand ohne Rechnungsabschnitt ist ungültig', () => {
    const state = v6State();
    delete (state as { invoiceEntries?: unknown }).invoiceEntries;

    expect(isValidPersistedStateV6(state), 'Fehlende Rechnungen galten als „keine"').toBe(false);
  });

  it('V3: beschädigte Rechnungsabschnitte sind ungültig', () => {
    expect(isValidPersistedStateV6(v6State({ invoiceEntries: null as never }))).toBe(false);
    expect(isValidPersistedStateV6(v6State({ invoiceEntries: {} as never }))).toBe(false);
    expect(isValidPersistedStateV6(v6State({ invoiceEntries: [null as never] }))).toBe(false);
    expect(
      isValidPersistedStateV6(v6State({ invoiceEntries: [{ vorgangId: 'v-a' } as never] })),
      'Eintrag ohne Rechnung',
    ).toBe(false);
    expect(
      isValidPersistedStateV6(v6State({ invoiceEntries: [{ invoice: invoice('x') } as never] })),
      'Eintrag ohne Zuordnungsfeld',
    ).toBe(false);
    expect(
      isValidPersistedStateV6(
        v6State({ invoiceEntries: [{ invoice: invoice('x'), vorgangId: 7 } as never] }),
      ),
      'Zuordnung mit falschem Typ',
    ).toBe(false);
    expect(
      isValidPersistedStateV6(
        v6State({ invoiceEntries: [{ invoice: { number: 'X' }, vorgangId: 'v-a' } as never] }),
      ),
      'Rechnung ohne Kennung',
    ).toBe(false);
  });

  it('V4: ein frisch erzeugter Zustand ist gültig', () => {
    expect(isValidPersistedStateV6(createSeedState() as unknown as Record<string, unknown>)).toBe(
      true,
    );
    expect(isValidPersistedStateV6(buildPersistedStateSnapshot())).toBe(true);
  });
});

describe('FIRST-CLASS-LOCAL-INVOICE-STORE-01B2 — Hydration eines V6-Zustands', () => {
  /*
   * H1 — die Reihenfolge ist die Aussage: `hydrateVorgangStore` übernimmt die
   * Rechnungen, die noch an Vorgängen hängen, und `hydrateInvoiceStore` setzt
   * danach den zentralen Bestand. Bei V6 ist der erste Schritt leer — er darf
   * den zweiten nicht überschreiben, und der zweite nicht ausbleiben.
   */
  it('H1: leere Vorgang-Rechnungen löschen die zentralen Einträge nicht', () => {
    const state: AppPersistedState = {
      ...createSeedState(),
      vorgaenge: [createTestVorgang({ id: 'v-a', invoices: [] })],
      invoiceEntries: [{ invoice: invoice('inv-a1'), vorgangId: 'v-a' }],
    };

    applyStateToStores(state);

    expect(listInvoices().map((i) => i.id)).toEqual(['inv-a1']);
    expect(getVorgangById('v-a')?.invoices.map((i) => i.id)).toEqual(['inv-a1']);
  });

  it('H2: die Hydration erzeugt keine zweite persistierte Kopie', () => {
    applyStateToStores({
      ...createSeedState(),
      vorgaenge: [createTestVorgang({ id: 'v-a', invoices: [] })],
      invoiceEntries: [{ invoice: invoice('inv-a1'), vorgangId: 'v-a' }],
    });

    setActiveStorageScope(SCOPE_A);
    expect(persistAll().success).toBe(true);
    const stored = JSON.parse(localStorage.getItem(buildStorageKey(SCOPE_A))!) as AppPersistedState;

    expect(stored.invoiceEntries).toHaveLength(1);
    expect(stored.vorgaenge.flatMap((v) => v.invoices ?? [])).toEqual([]);
  });
});
