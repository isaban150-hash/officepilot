/**
 * OFFICEPILOT-SINGLE-FINAL-INVOICE-INVARIANT-01D — eine Schlussrechnung je Vorgang.
 *
 * Bewiesene P1-Lücke: Im lebenden Finalisierungspfad gab es **keinen** Guard
 * gegen eine zweite, inhaltlich andere Schlussrechnung — weder im Validator,
 * im Preflight, im Coordinator, im Prepared-Finalize noch im RPC oder in einem
 * SQL-Constraint. Zwei Geräte am selben Auftrag konnten zwei Schlussrechnungen
 * mit eigenen Nummern erzeugen.
 *
 * Der Guard muss zugleich den Wiederholungsfall verschonen: Dieselbe
 * `clientInvoiceId` erneut ist ein Replay, keine zweite Rechnung.
 *
 * Neutrale Beispieldaten.
 */
import { describe, expect, it } from 'vitest';
import { findConflictingFinalInvoice } from './invoice/invoiceFinalizationCoordinator';
import type { VorgangInvoice } from '../types/models';

const OWN_ID = 'inv-own-1';
const OTHER_ID = 'inv-other-1';

function invoice(overrides: Partial<VorgangInvoice> = {}): VorgangInvoice {
  return {
    id: OTHER_ID,
    number: '2026-0003',
    invoiceSequenceNumber: 3,
    type: 'schluss',
    positions: [],
    subtotal: 10000,
    taxStatus: 'null_13b',
    amount: 10000,
    status: 'vorbereitet',
    date: '2026-08-27',
    createdAt: '2026-08-27T10:00:00.000Z',
    issueDate: '2026-08-27',
    legalNotices: [],
    previousAbschlagDeductions: [],
    ...overrides,
  } as VorgangInvoice;
}

describe('OFFICEPILOT-SINGLE-FINAL-INVOICE-INVARIANT-01D', () => {
  it('A: eine fremde vorbereitete Schlussrechnung ist ein Konflikt', () => {
    const conflict = findConflictingFinalInvoice([invoice()], 'schluss', OWN_ID);
    expect(conflict?.id).toBe(OTHER_ID);
  });

  it('B: dasselbe gilt für eine versendete Schlussrechnung', () => {
    const conflict = findConflictingFinalInvoice(
      [invoice({ status: 'versendet' })],
      'schluss',
      OWN_ID,
    );
    expect(conflict?.id).toBe(OTHER_ID);
  });

  it('C: die eigene Kennung ist kein Konflikt — Replay und Resume bleiben frei', () => {
    expect(findConflictingFinalInvoice([invoice({ id: OWN_ID })], 'schluss', OWN_ID)).toBeNull();
  });

  it('D: ein Entwurf zählt nicht als vorhandene Schlussrechnung', () => {
    expect(
      findConflictingFinalInvoice([invoice({ status: 'entwurf' })], 'schluss', OWN_ID),
    ).toBeNull();
  });

  it('E: eine stornierte Schlussrechnung zählt weiterhin als vorhanden', () => {
    /*
     * `cancelledAt` verändert den Status nicht — Client und Server bleiben in
     * diesem Sprint bewusst konsistent zur heutigen Semantik. Eine
     * Wiederabrechenbarkeit nach Storno ist ein eigener Fachpunkt.
     */
    const conflict = findConflictingFinalInvoice(
      [invoice({ cancelledAt: '2026-08-28T08:00:00.000Z' })],
      'schluss',
      OWN_ID,
    );
    expect(conflict?.id).toBe(OTHER_ID);
  });

  it('F: andere Rechnungsarten lösen den Guard nicht aus', () => {
    for (const type of ['rechnung', 'abschlag', 'teilrechnung'] as VorgangInvoice['type'][]) {
      // Weder als vorhandene Rechnung …
      expect(findConflictingFinalInvoice([invoice({ type })], 'schluss', OWN_ID), type).toBeNull();
      // … noch als zu finalisierende Art.
      expect(findConflictingFinalInvoice([invoice()], type, OWN_ID), type).toBeNull();
    }
  });

  it('G: mehrere Rechnungen — nur die fremde Schlussrechnung zählt', () => {
    const conflict = findConflictingFinalInvoice(
      [
        invoice({ id: 'inv-abschlag-1', type: 'abschlag', number: '2026-0001' }),
        invoice({ id: OWN_ID, number: '2026-0002' }),
        invoice({ id: OTHER_ID, number: '2026-0003' }),
      ],
      'schluss',
      OWN_ID,
    );
    expect(conflict?.id).toBe(OTHER_ID);
  });

  it('H: ohne Rechnungen gibt es keinen Konflikt', () => {
    expect(findConflictingFinalInvoice([], 'schluss', OWN_ID)).toBeNull();
  });
});
