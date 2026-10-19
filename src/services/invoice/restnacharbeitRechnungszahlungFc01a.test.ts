/**
 * FINANZ-CORE-01A — Restnacharbeit nach WEISS-Bericht 18, END18-R3 auf der Rechnungsseite: eine fachlich
 * abgewiesene Rechnungszahlung (unbestätigte Überzahlung, stornierte Rechnung, abgerechneter Abschlag) zählt
 * nirgends mehr — bezahlt/offen/Status, Monatsmappe, Abschluss —, bleibt aber als abgewiesen sichtbar, bis der
 * Nutzer entscheidet. Konflikt, Rollenabweisung und Netzfehler ändern daran nichts (bisheriger N01-Vertrag).
 *
 *  Q1  Dienst: abweisen → aus `payments`, nach `rejectedPayments`; Summen und Status folgen
 *  Q2  bewusst als Überzahlung bestätigen → zurück mit Merkmal; bei abgerechnetem Abschlag nicht möglich
 *  Q3  bewusst verwerfen
 *  Q4  Hintergrundlauf: fachliche Abweisung nimmt die Zahlung heraus; Altbestand mit älterem Vermerk ebenso
 *  Q5  Konflikt und Rollenabweisung: bleibt beim Vermerk (N01), keine Herausnahme
 *  Q6  Nachweisfeld verlässt das Gerät nicht (Freigabe-Payload) und überlebt Laden
 *  Q7  Monatsmappe zählt nur Angenommenes
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { resetTestStores } from '../../test/resetStores';
import { createTestVorgang } from '../../test/fixtures';
import { getVorgangInvoice, hydrateVorgangStore } from '../vorgangService';
import { hydrateInvoiceStore } from './invoiceStore';
import {
  calculatePaymentSummary,
  discardRejectedInvoicePayment,
  getPaidAmount,
  isRejectedInvoicePaymentOutcome,
  quarantineRejectedInvoicePayment,
  restoreRejectedInvoicePaymentAsOverpayment,
} from '../invoicePaymentService';
import {
  getInvoicePaymentResyncBlocks,
  recordInvoicePaymentResyncBlock,
  resetInvoicePaymentResyncForTests,
  resyncLocalOnlyInvoicePayments,
} from './invoicePaymentCloudResyncService';
import { buildWorkspaceInvoiceFinalizePayload } from './workspaceInvoiceCloudService';
import { buildMonatsmappeModel } from '../steuerberater/monatsmappeModelService';
import type { InvoicePayment, VorgangInvoice } from '../../types/models';

const VORGANG_ID = 'v-test-1';

function zahlung(id: string, amount: number, date: string): InvoicePayment {
  return { id, amount, date, createdAt: `${date}T10:00:00.000Z` };
}

function rechnung(payments: InvoicePayment[], overrides: Partial<VorgangInvoice> = {}): VorgangInvoice {
  return {
    id: 'inv-r3', number: '2026-0201', type: 'rechnung', positions: [], subtotal: 100, taxStatus: 'standard_19', amount: 119,
    status: 'versendet', date: '2026-06-01', issueDate: '2026-06-01', createdAt: '2026-06-01T10:00:00.000Z', payments,
    ...overrides,
  };
}

beforeEach(() => {
  resetTestStores();
  hydrateInvoiceStore([]);
  resetInvoicePaymentResyncForTests();
});

describe('Q — fachlich abgewiesene Rechnungszahlung zählt nicht', () => {
  it('Q1 abweisen: aus payments heraus, Summen ohne sie, Nachweis mit Grund', () => {
    hydrateVorgangStore([createTestVorgang({ invoices: [rechnung([zahlung('a', 119, '2026-06-02'), zahlung('b', 119, '2026-06-03')])] })]);
    expect(getPaidAmount(getVorgangInvoice(VORGANG_ID, 'inv-r3')!)).toBe(238);
    const result = quarantineRejectedInvoicePayment(VORGANG_ID, 'inv-r3', 'b', 'overpayment_unconfirmed', '2026-06-04T08:00:00.000Z');
    expect(result.success).toBe(true);
    const x = getVorgangInvoice(VORGANG_ID, 'inv-r3')!;
    expect(x.payments!.map((p) => p.id)).toEqual(['a']);
    expect(calculatePaymentSummary(x)).toMatchObject({ paidAmount: 119, overpaidAmount: 0, openAmount: 0, status: 'bezahlt' });
    expect(x.rejectedPayments).toEqual([expect.objectContaining({ id: 'b', amount: 119, reason: 'overpayment_unconfirmed', rejectedAt: '2026-06-04T08:00:00.000Z' })]);
  });

  it('Q2 bewusst als Überzahlung bestätigen: zurück mit Merkmal; bei abgerechnetem Abschlag nicht', () => {
    hydrateVorgangStore([createTestVorgang({ invoices: [rechnung([zahlung('a', 119, '2026-06-02'), zahlung('b', 119, '2026-06-03')])] })]);
    quarantineRejectedInvoicePayment(VORGANG_ID, 'inv-r3', 'b', 'overpayment_unconfirmed');
    const zurueck = restoreRejectedInvoicePaymentAsOverpayment(VORGANG_ID, 'inv-r3', 'b');
    expect(zurueck.success && zurueck.payment).toMatchObject({ id: 'b', overpaymentAcknowledged: true });
    const x = getVorgangInvoice(VORGANG_ID, 'inv-r3')!;
    expect(x.payments!.map((p) => p.id)).toEqual(['a', 'b']);
    expect(x.rejectedPayments ?? []).toEqual([]);

    quarantineRejectedInvoicePayment(VORGANG_ID, 'inv-r3', 'b', 'final_invoice_exists');
    expect(restoreRejectedInvoicePaymentAsOverpayment(VORGANG_ID, 'inv-r3', 'b')).toEqual({ success: false, errorKey: 'payment.rejectedNotRestorable' });
  });

  it('Q3 bewusst verwerfen: der Nachweis fällt, die angenommene Zahlung bleibt', () => {
    hydrateVorgangStore([createTestVorgang({ invoices: [rechnung([zahlung('a', 119, '2026-06-02'), zahlung('b', 50, '2026-06-03')])] })]);
    quarantineRejectedInvoicePayment(VORGANG_ID, 'inv-r3', 'b', 'invoice_cancelled');
    expect(discardRejectedInvoicePayment(VORGANG_ID, 'inv-r3', 'b').success).toBe(true);
    const x = getVorgangInvoice(VORGANG_ID, 'inv-r3')!;
    expect(x.payments!.map((p) => p.id)).toEqual(['a']);
    expect(x.rejectedPayments).toEqual([]);
  });

  it('Q4 Hintergrundlauf: Abweisung beim Senden und Altbestand mit älterem Vermerk werden herausgenommen', async () => {
    hydrateVorgangStore([
      createTestVorgang({ invoices: [rechnung([zahlung('a', 119, '2026-06-02'), zahlung('neu', 119, '2026-06-03'), zahlung('alt', 10, '2026-06-04')])] }),
    ]);
    recordInvoicePaymentResyncBlock('inv-r3', 'alt', 'overpayment_unconfirmed');
    const report = await resyncLocalOnlyInvoicePayments({
      // Vollständiger Abzug: nur „a“ ist der Cloud bekannt.
      pull: async () => ({ outcome: 'synced' as const, rows: [{ clientInvoiceId: 'inv-r3', clientPaymentId: 'a' } as never] }),
      push: async () => 'overpayment_unconfirmed' as const,
      now: () => 1_000_000,
    });
    expect(report.quarantined).toBe(2);
    const x = getVorgangInvoice(VORGANG_ID, 'inv-r3')!;
    expect(x.payments!.map((p) => p.id)).toEqual(['a']);
    expect(x.rejectedPayments!.map((p) => p.id).sort()).toEqual(['alt', 'neu']);
    // Der Vermerk bleibt: kein stilles Nachsenden.
    expect(getInvoicePaymentResyncBlocks('inv-r3')).toMatchObject({ neu: 'overpayment_unconfirmed', alt: 'overpayment_unconfirmed' });
  });

  it('Q5 Konflikt, Rollenabweisung und Netzfehler: keine Herausnahme', async () => {
    expect(isRejectedInvoicePaymentOutcome('conflict')).toBe(false);
    expect(isRejectedInvoicePaymentOutcome('denied')).toBe(false);
    expect(isRejectedInvoicePaymentOutcome('failed')).toBe(false);
    hydrateVorgangStore([createTestVorgang({ invoices: [rechnung([zahlung('k', 119, '2026-06-02')])] })]);
    await resyncLocalOnlyInvoicePayments({
      pull: async () => ({ outcome: 'synced' as const, rows: [] }),
      push: async () => 'conflict' as const,
      now: () => 2_000_000,
    });
    expect(getVorgangInvoice(VORGANG_ID, 'inv-r3')!.payments!.map((p) => p.id)).toEqual(['k']);
  });

  it('Q6 der Nachweis verlässt das Gerät nicht und überlebt das Laden', () => {
    hydrateVorgangStore([createTestVorgang({ invoices: [rechnung([zahlung('a', 119, '2026-06-02'), zahlung('b', 119, '2026-06-03')])] })]);
    quarantineRejectedInvoicePayment(VORGANG_ID, 'inv-r3', 'b', 'overpayment_unconfirmed');
    const x = getVorgangInvoice(VORGANG_ID, 'inv-r3')!;
    expect(buildWorkspaceInvoiceFinalizePayload(x)).not.toHaveProperty('rejectedPayments');
    hydrateVorgangStore([createTestVorgang({ invoices: [JSON.parse(JSON.stringify(x)) as VorgangInvoice] })]);
    expect(getVorgangInvoice(VORGANG_ID, 'inv-r3')!.rejectedPayments!.map((p) => p.id)).toEqual(['b']);
  });

  it('Q7 Monatsmappe: nur die angenommene Zahlung', () => {
    hydrateVorgangStore([createTestVorgang({ invoices: [rechnung([zahlung('a', 119, '2026-06-02'), zahlung('b', 119, '2026-06-03')])] })]);
    quarantineRejectedInvoicePayment(VORGANG_ID, 'inv-r3', 'b', 'overpayment_unconfirmed');
    const model = buildMonatsmappeModel({
      monthKey: '2026-06', invoices: [{ invoice: getVorgangInvoice(VORGANG_ID, 'inv-r3')!, vorgangId: VORGANG_ID }], expenses: [], documents: [], inboxItems: [], fileRefs: [],
    } as never);
    const eingaenge = model.zahlungenAusgang ?? [];
    expect(eingaenge.map((z) => z.betrag)).toEqual([119]);
  });
});
