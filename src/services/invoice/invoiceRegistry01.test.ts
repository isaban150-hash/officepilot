/**
 * INVOICE-REGISTRY-01B — die Registry ist eine Projektion, keine zweite Wahrheit.
 *
 * Geprüft wird genau das: Sie liefert exakt die Rechnungen, die in den
 * Vorgängen stehen — nicht mehr, nicht weniger, in derselben Reihenfolge — und
 * sie erlaubt den Zugriff über die `invoiceId`, ohne dass der Aufrufer Vorgänge
 * durchläuft.
 *
 * Synthetische Daten, kein Netz.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { createAbschlagInvoice, createTestVorgang } from '../../test/fixtures';
import { hydrateVorgangStore } from '../vorgangService';
import {
  findDuplicateInvoiceIds,
  findInvoiceById,
  findInvoiceLocatorById,
  listInvoiceEntries,
  listInvoices,
} from './invoiceRegistryService';
import type { VorgangInvoice } from '../../types/models';

function invoice(id: string, overrides: Partial<VorgangInvoice> = {}): VorgangInvoice {
  return createAbschlagInvoice('op-test-1', 1, { id, number: `AR-${id}`, ...overrides });
}

/** Vorgang A trägt A1 und A2, Vorgang B trägt B1. */
function seedTwoVorgaenge(): void {
  hydrateVorgangStore([
    createTestVorgang({ id: 'v-a', invoices: [invoice('inv-a1'), invoice('inv-a2')] }),
    createTestVorgang({ id: 'v-b', invoices: [invoice('inv-b1')] }),
  ]);
}

beforeEach(() => {
  hydrateVorgangStore([]);
});

describe('INVOICE-REGISTRY-01B — Auflisten', () => {
  it('R1: alle Rechnungen aller Vorgänge, keine verloren, keine erfunden', () => {
    seedTwoVorgaenge();

    expect(listInvoices().map((item) => item.id)).toEqual(['inv-a1', 'inv-a2', 'inv-b1']);
  });

  it('R1b: die Einträge tragen den Ablageort', () => {
    seedTwoVorgaenge();

    expect(listInvoiceEntries().map((entry) => [entry.invoice.id, entry.vorgangId])).toEqual([
      ['inv-a1', 'v-a'],
      ['inv-a2', 'v-a'],
      ['inv-b1', 'v-b'],
    ]);
  });

  /*
   * Die Reihenfolge ist kein Zufall: Der Nummernkreis leitet daraus Jahr und
   * Höchstnummer ab. Sie muss die bisherige `flatMap`-Reihenfolge sein —
   * Vorgänge in Speicherreihenfolge, darin die Rechnungen in ihrer.
   */
  it('R2: die Reihenfolge entspricht der bisherigen Projektion', () => {
    seedTwoVorgaenge();
    const expected = [
      createTestVorgang({ id: 'v-a', invoices: [invoice('inv-a1'), invoice('inv-a2')] }),
      createTestVorgang({ id: 'v-b', invoices: [invoice('inv-b1')] }),
    ].flatMap((v) => (v.invoices ?? []).map((item) => item.id));

    expect(listInvoices().map((item) => item.id)).toEqual(expected);
  });

  it('R3: ohne Rechnungen ist die Liste leer, ohne Fehler', () => {
    hydrateVorgangStore([createTestVorgang({ id: 'v-a' }), createTestVorgang({ id: 'v-b' })]);

    expect(listInvoices()).toEqual([]);
    expect(listInvoiceEntries()).toEqual([]);
  });

  it('R3b: ohne Vorgänge ist die Liste leer', () => {
    expect(listInvoices()).toEqual([]);
  });
});

describe('INVOICE-REGISTRY-01B — Suchen über die Kennung', () => {
  it('R4: findInvoiceById findet die Rechnung eines fremden Vorgangs', () => {
    seedTwoVorgaenge();

    expect(findInvoiceById('inv-b1')?.id).toBe('inv-b1');
  });

  it('R5: der Locator nennt den Vorgang', () => {
    seedTwoVorgaenge();

    expect(findInvoiceLocatorById('inv-b1')).toMatchObject({ vorgangId: 'v-b' });
    expect(findInvoiceLocatorById('inv-a2')).toMatchObject({ vorgangId: 'v-a' });
  });

  it('R6: eine unbekannte Kennung liefert nichts — kein Ersatz', () => {
    seedTwoVorgaenge();

    expect(findInvoiceById('inv-gibt-es-nicht')).toBeUndefined();
    expect(findInvoiceLocatorById('inv-gibt-es-nicht')).toBeUndefined();
    expect(findInvoiceById('')).toBeUndefined();
  });

  /*
   * R7 — die Cloud verhindert das über `unique (workspace_id,
   * client_invoice_id)`; lokal gibt es keine solche Sperre. Bei zwei Treffern
   * wäre jede Auswahl geraten, und „erste gewinnt" würde beschädigte Daten
   * unsichtbar machen. Deshalb: nichts zurückgeben und den Fall untersuchbar
   * halten.
   */
  it('R7: eine mehrdeutige Kennung liefert nichts und ist auffindbar', () => {
    hydrateVorgangStore([
      createTestVorgang({ id: 'v-a', invoices: [invoice('inv-doppelt')] }),
      createTestVorgang({ id: 'v-b', invoices: [invoice('inv-doppelt')] }),
    ]);

    expect(findInvoiceById('inv-doppelt'), 'Eine von zwei wurde stillschweigend gewählt')
      .toBeUndefined();
    expect(findInvoiceLocatorById('inv-doppelt')).toBeUndefined();
    expect(findDuplicateInvoiceIds()).toEqual(['inv-doppelt']);
    // Die Liste verschweigt nichts — beide bleiben sichtbar.
    expect(listInvoices()).toHaveLength(2);
  });

  it('R7b: ohne Duplikate meldet die Diagnose nichts', () => {
    seedTwoVorgaenge();

    expect(findDuplicateInvoiceIds()).toEqual([]);
  });
});

describe('INVOICE-REGISTRY-01B — keine zweite Wahrheit', () => {
  /*
   * Die Registry hält keinen Zustand: Was der Vorgangsbestand nach einer
   * Änderung zeigt, zeigt sie unmittelbar mit. Es gibt nichts, was veralten
   * könnte.
   */
  it('R8: eine Änderung am Vorgangsbestand wirkt sofort', () => {
    seedTwoVorgaenge();
    expect(listInvoices()).toHaveLength(3);

    hydrateVorgangStore([createTestVorgang({ id: 'v-a', invoices: [invoice('inv-a1')] })]);

    expect(listInvoices().map((item) => item.id)).toEqual(['inv-a1']);
    expect(findInvoiceById('inv-b1')).toBeUndefined();
  });
});
