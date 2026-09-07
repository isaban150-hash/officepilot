/**
 * FIRST-CLASS-LOCAL-INVOICE-STORE-01B — die Rechnung bekommt einen eigenen Ort.
 *
 * Lokal war eine Rechnung bisher ein Element von `vorgang.invoices[]`. Wer eine
 * Rechnung suchte, ohne ihren Vorgang zu kennen, musste alle Vorgänge
 * durchlaufen — und wer sie änderte, änderte in Wahrheit einen Vorgang.
 *
 * Ab hier ist der Rechnungsspeicher die einzige lokale Wahrheit, und
 * `vorgang.invoices` ist ausschliesslich eine Sicht darauf. Diese Suite hält
 * beides fest: dass die Sicht stimmt, und dass sie **nur** eine Sicht ist.
 *
 * Synthetische Daten, kein Netz.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  getInvoiceStoreSnapshot,
  hydrateInvoiceStore,
  listInvoicesForVorgang,
} from './invoiceStore';
import {
  addInvoiceToVorgang,
  addPaymentToInvoice,
  getAllVorgaenge,
  getVorgangById,
  getVorgangInvoice,
  getVorgangStoreSnapshot,
  hydrateVorgangStore,
  updateInvoiceArchiveDocumentId,
  updateInvoiceSentFields,
  upsertFinalizedInvoiceOnVorgang,
} from '../vorgangService';
import { listInvoiceEntries, listInvoices } from './invoiceRegistryService';
import * as persistenceService from '../persistenceService';
import { createAbschlagInvoice, createTestVorgang } from '../../test/fixtures';
import { resetTestStores } from '../../test/resetStores';
import type { VorgangInvoice } from '../../types/models';

function invoice(id: string, overrides: Partial<VorgangInvoice> = {}): VorgangInvoice {
  return createAbschlagInvoice('op-test-1', 1, { id, number: `AR-${id}`, ...overrides });
}

/** Vorgang A trägt A1 und A2, Vorgang B trägt B1. */
function seed(): void {
  hydrateVorgangStore([
    createTestVorgang({ id: 'v-a', invoices: [invoice('inv-a1'), invoice('inv-a2')] }),
    createTestVorgang({ id: 'v-b', invoices: [invoice('inv-b1')] }),
  ]);
}

beforeEach(() => {
  resetTestStores();
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('FIRST-CLASS-LOCAL-INVOICE-STORE-01B — der Speicher trägt die Rechnungen', () => {
  it('R10: die Registry liest aus dem zentralen Speicher', () => {
    seed();

    expect(getInvoiceStoreSnapshot().map((entry) => entry.invoice.id)).toEqual([
      'inv-a1',
      'inv-a2',
      'inv-b1',
    ]);
    expect(listInvoices().map((item) => item.id)).toEqual(['inv-a1', 'inv-a2', 'inv-b1']);
  });

  it('R5: jeder Eintrag kennt seinen Vorgang', () => {
    seed();

    expect(getInvoiceStoreSnapshot().map((entry) => [entry.invoice.id, entry.vorgangId])).toEqual([
      ['inv-a1', 'v-a'],
      ['inv-a2', 'v-a'],
      ['inv-b1', 'v-b'],
    ]);
  });

  it('R11: die Reihenfolge bleibt die bisherige', () => {
    seed();

    expect(listInvoiceEntries().map((entry) => entry.invoice.id)).toEqual([
      'inv-a1',
      'inv-a2',
      'inv-b1',
    ]);
    expect(listInvoicesForVorgang('v-a').map((item) => item.id)).toEqual(['inv-a1', 'inv-a2']);
  });

  it('R8/R9: die Laufzeitsicht des Vorgangs zeigt seine Rechnungen', () => {
    seed();

    expect(getVorgangById('v-a')?.invoices.map((item) => item.id)).toEqual(['inv-a1', 'inv-a2']);
    expect(getVorgangById('v-b')?.invoices.map((item) => item.id)).toEqual(['inv-b1']);
    expect(
      getAllVorgaenge().flatMap((v) => v.invoices.map((item) => item.id)),
    ).toEqual(['inv-a1', 'inv-a2', 'inv-b1']);
    expect(
      getVorgangStoreSnapshot().flatMap((v) => v.invoices.map((item) => item.id)),
    ).toEqual(['inv-a1', 'inv-a2', 'inv-b1']);
  });

  it('R6: ein leerer Speicher ergibt eine leere Sicht', () => {
    hydrateInvoiceStore([]);
    hydrateVorgangStore([createTestVorgang({ id: 'v-a' })]);

    expect(getVorgangById('v-a')?.invoices).toEqual([]);
    expect(listInvoices()).toEqual([]);
  });
});

/*
 * Der eigentliche Vertrag: Nach einer Mutation zeigt die Sicht den neuen Stand,
 * **ohne** dass jemand `vorgang.invoices` geschrieben hätte. Genau das schliesst
 * einen Doppelschreibvorgang und damit eine zweite Wahrheit aus.
 */
describe('FIRST-CLASS-LOCAL-INVOICE-STORE-01B — Mutationen wirken über die Projektion', () => {
  it('R14: eine neue Rechnung landet zentral und erscheint am Vorgang', () => {
    seed();

    const saved = addInvoiceToVorgang('v-a', invoice('inv-neu'));

    expect(saved?.id).toBe('inv-neu');
    // Vorangestellt wie bisher.
    expect(listInvoicesForVorgang('v-a').map((item) => item.id)).toEqual([
      'inv-neu',
      'inv-a1',
      'inv-a2',
    ]);
    expect(getVorgangById('v-a')?.invoices.map((item) => item.id)).toEqual([
      'inv-neu',
      'inv-a1',
      'inv-a2',
    ]);
  });

  it('R15: ein Versandstatus ändert den zentralen Eintrag', () => {
    seed();

    const result = updateInvoiceSentFields('v-a', 'inv-a1', {
      status: 'versendet',
      sentAt: '2026-09-01',
      sentVia: 'email',
    });

    expect(result.ok).toBe(true);
    expect(listInvoicesForVorgang('v-a')[0]?.sentAt).toBe('2026-09-01');
    expect(getVorgangById('v-a')?.invoices[0]?.status).toBe('versendet');
  });

  it('R16: eine Zahlung ändert den zentralen Eintrag', () => {
    seed();

    const result = addPaymentToInvoice(
      'v-a',
      'inv-a1',
      { id: 'pay-1', date: '2026-09-01', amount: 10, createdAt: '2026-09-01T10:00:00.000Z' },
      'teilbezahlt',
    );

    expect(result.ok).toBe(true);
    expect(getVorgangById('v-a')?.invoices[0]?.payments?.map((p) => p.id)).toEqual(['pay-1']);
    expect(listInvoicesForVorgang('v-a')[0]?.paymentStatus).toBe('teilbezahlt');
  });

  it('R17: eine Archivverknüpfung ändert den zentralen Eintrag', () => {
    seed();

    const result = updateInvoiceArchiveDocumentId('v-a', 'inv-a1', 'doc-1');

    expect(result.ok).toBe(true);
    expect(getVorgangById('v-a')?.invoices[0]?.archiveDocumentId).toBe('doc-1');
  });

  it('R23: eine aus der Cloud übernommene Rechnung landet zentral', () => {
    seed();

    const result = upsertFinalizedInvoiceOnVorgang('v-b', invoice('inv-cloud'));

    expect(result.ok && result.action).toBe('inserted');
    expect(listInvoicesForVorgang('v-b').map((item) => item.id)).toEqual(['inv-cloud', 'inv-b1']);
    expect(getVorgangById('v-b')?.invoices.map((item) => item.id)).toEqual([
      'inv-cloud',
      'inv-b1',
    ]);
  });
});

describe('FIRST-CLASS-LOCAL-INVOICE-STORE-01B — Rücknahme bei Speicherfehler', () => {
  /*
   * R18 — der Speicher darf nicht vorauseilen. Schlägt das Persistieren fehl,
   * muss auch die Rechnung wieder auf ihrem alten Stand stehen; sonst zeigte
   * die Oberfläche eine Änderung, die den nächsten Neustart nicht überlebt.
   */
  function failPersistOnce(): void {
    vi.spyOn(persistenceService, 'persistAll').mockReturnValue({
      success: false,
      failure: { reason: 'unknown_persist_error' },
    });
  }

  it('R18a: eine neue Rechnung wird bei Speicherfehler zurückgenommen', () => {
    seed();
    failPersistOnce();

    addInvoiceToVorgang('v-a', invoice('inv-neu'));

    expect(listInvoicesForVorgang('v-a').map((item) => item.id)).toEqual(['inv-a1', 'inv-a2']);
    expect(getVorgangById('v-a')?.invoices.map((item) => item.id)).toEqual(['inv-a1', 'inv-a2']);
  });

  it('R18b: ein Versandstatus wird bei Speicherfehler zurückgenommen', () => {
    seed();
    failPersistOnce();

    updateInvoiceSentFields('v-a', 'inv-a1', {
      status: 'versendet',
      sentAt: '2026-09-01',
      sentVia: 'email',
    });

    expect(listInvoicesForVorgang('v-a')[0]?.sentAt).toBeUndefined();
    expect(getVorgangById('v-a')?.invoices[0]?.status).toBe('vorbereitet');
  });

  it('R18c: eine Zahlung wird bei Speicherfehler zurückgenommen', () => {
    seed();
    failPersistOnce();

    addPaymentToInvoice(
      'v-a',
      'inv-a1',
      { id: 'pay-1', date: '2026-09-01', amount: 10, createdAt: '2026-09-01T10:00:00.000Z' },
      'teilbezahlt',
    );

    expect(getVorgangById('v-a')?.invoices[0]?.payments ?? []).toEqual([]);
  });
});

describe('FIRST-CLASS-LOCAL-INVOICE-STORE-01B — Zuordnung bleibt fail-closed', () => {
  /*
   * R19 — die Route trägt beide Kennungen, und das ist kein Zufall: Eine
   * Rechnung darf nicht über einen fremden Vorgang erreichbar sein. Der
   * zentrale Speicher macht sie global auffindbar; die Prüfung muss deshalb
   * ausdrücklich bleiben.
   */
  it('R19: ein fremder Vorgang findet die Rechnung nicht', () => {
    seed();

    expect(getVorgangInvoice('v-a', 'inv-a1')?.id).toBe('inv-a1');
    expect(getVorgangInvoice('v-b', 'inv-a1'), 'Cross-Vorgang-Zugriff möglich').toBeUndefined();
    expect(getVorgangInvoice('v-a', 'gibt-es-nicht')).toBeUndefined();
  });
});
