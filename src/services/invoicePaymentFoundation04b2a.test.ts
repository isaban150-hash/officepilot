/**
 * OFFICEPILOT-PAYMENT-FOUNDATION-04B2A — tragfähige Grundlage vor der Cloud.
 *
 * Zwei Befunde aus der 04B2-Analyse werden hier behoben, bevor Zahlungen
 * überhaupt in die Cloud dürfen:
 *
 * 1. Die Payment-ID war ein Millisekunden-Zeitstempel. Als Idempotenzschlüssel
 *    zwischen zwei Geräten wäre das zu schwach — zwei echte Geldbewegungen
 *    könnten zu einer verschmelzen.
 *
 * 2. Der Schreibweg verwarf das Ergebnis von `persistAll()`. Eine Zahlung
 *    konnte als gespeichert gelten, ohne es zu sein — derselbe Vertragsbruch,
 *    den `94f338e` für den Versandstatus behoben hat.
 *
 * Bestehende `pay-…`-Kennungen bleiben dabei unangetastet. Eine historische
 * Zahlung ist ein Beleg, kein Formatproblem.
 *
 * Neutrale Beispieldaten, kein Netzwerk.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetTestStores } from '../test/resetStores';
import { createOrderPosition, createTestVorgang } from '../test/fixtures';
import { getVorgangInvoice, hydrateVorgangStore } from './vorgangService';
import { recordPayment, removePayment } from './invoicePaymentService';
import { resetLastPersistFailureForTests } from './persistenceService';
import * as persistenceService from './persistenceService';
import type { InvoicePayment, Vorgang, VorgangInvoice } from '../types/models';

const VORGANG_ID = 'v-pay-foundation';
const INVOICE_ID = 'inv-pay-foundation';

/** Genau das historische Format, das erhalten bleiben muss. */
const LEGACY_PAYMENT_ID = 'pay-123456789';

function buildInvoice(overrides: Partial<VorgangInvoice> = {}): VorgangInvoice {
  return {
    id: INVOICE_ID,
    number: '2026-0001',
    invoiceSequenceNumber: 1,
    type: 'rechnung',
    positions: [
      {
        id: 'line-1',
        orderPositionId: 'op-1',
        description: 'Dachsanierung',
        quantity: 100,
        unit: 'm²',
        unitPrice: 100,
        lineTotal: 10000,
      },
    ],
    subtotal: 10000,
    taxStatus: 'null_13b',
    amount: 10000,
    status: 'versendet',
    sentAt: '2026-08-25',
    sentVia: 'email',
    date: '2026-08-24',
    issueDate: '2026-08-24',
    createdAt: '2026-08-24T10:00:00.000Z',
    paymentDueDate: '2099-12-31',
    paymentStatus: 'offen',
    payments: [],
    legalNotices: [],
    previousAbschlagDeductions: [],
    ...overrides,
  } as VorgangInvoice;
}

function seed(invoice: VorgangInvoice = buildInvoice()): void {
  hydrateVorgangStore([
    {
      ...createTestVorgang({
        id: VORGANG_ID,
        status: 'beauftragt',
        customer: 'Beispiel Projektbau GmbH',
        orderPositions: [
          createOrderPosition({ id: 'op-1', unit: 'm²', plannedQuantity: 100, unitPrice: 100 }),
        ],
      }),
      invoices: [invoice],
    } as Vorgang,
  ]);
}

function legacyPayment(): InvoicePayment {
  return {
    id: LEGACY_PAYMENT_ID,
    date: '2026-08-25',
    amount: 4000,
    createdAt: '2026-08-25T10:00:00.000Z',
  };
}

function stored(): VorgangInvoice {
  return getVorgangInvoice(VORGANG_ID, INVOICE_ID)!;
}

/** Eine UUID — nicht das alte Zeitstempelformat. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe('OFFICEPILOT-PAYMENT-FOUNDATION-04B2A', () => {
  beforeEach(() => {
    resetTestStores();
    resetLastPersistFailureForTests();
    seed();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetTestStores();
    resetLastPersistFailureForTests();
  });

  it('A: eine neue Zahlung erhält eine stabile UUID', () => {
    const result = recordPayment(VORGANG_ID, INVOICE_ID, { date: '2026-08-25', amount: 2500 });
    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.payment.id).toMatch(UUID_PATTERN);
    expect(result.payment.id.startsWith('pay-')).toBe(false);

    // Die Kennung im Speicher ist dieselbe wie die zurückgegebene.
    expect(stored().payments?.[0]?.id).toBe(result.payment.id);
  });

  it('B: eine historische pay-Kennung bleibt unverändert', () => {
    seed(buildInvoice({ payments: [legacyPayment()], paymentStatus: 'teilbezahlt' }));

    // Eine zweite Zahlung darf die erste nicht anfassen.
    const result = recordPayment(VORGANG_ID, INVOICE_ID, { date: '2026-08-26', amount: 1000 });
    expect(result.success).toBe(true);

    const payments = stored().payments ?? [];
    expect(payments).toHaveLength(2);
    const legacy = payments.find((payment) => payment.id === LEGACY_PAYMENT_ID);
    expect(legacy).toBeDefined();
    expect(legacy?.amount).toBe(4000);
    expect(legacy?.date).toBe('2026-08-25');
    expect(legacy?.createdAt).toBe('2026-08-25T10:00:00.000Z');
  });

  it('C: die erste Teilzahlung wird gespeichert und richtig bewertet', () => {
    const result = recordPayment(VORGANG_ID, INVOICE_ID, { date: '2026-08-25', amount: 4000 });
    expect(result.success).toBe(true);

    const invoice = stored();
    expect(invoice.payments).toHaveLength(1);
    expect(invoice.paymentStatus).toBe('teilbezahlt');
  });

  it('D: die zweite Teilzahlung tritt neben die erste', () => {
    const first = recordPayment(VORGANG_ID, INVOICE_ID, { date: '2026-08-25', amount: 4000 });
    const second = recordPayment(VORGANG_ID, INVOICE_ID, { date: '2026-08-26', amount: 1000 });
    expect(first.success && second.success).toBe(true);
    if (!first.success || !second.success) return;

    // Zwei Ereignisse, zwei Kennungen — keines ersetzt das andere.
    expect(second.payment.id).not.toBe(first.payment.id);
    expect(second.payment.id).toMatch(UUID_PATTERN);

    const payments = stored().payments ?? [];
    expect(payments.map((payment) => payment.id)).toEqual([first.payment.id, second.payment.id]);
    expect(payments.reduce((sum, payment) => sum + payment.amount, 0)).toBe(5000);
  });

  it('E: die Rechnung gilt als bezahlt, sobald die Summe erreicht ist', () => {
    recordPayment(VORGANG_ID, INVOICE_ID, { date: '2026-08-25', amount: 6000 });
    const result = recordPayment(VORGANG_ID, INVOICE_ID, { date: '2026-08-26', amount: 4000 });
    expect(result.success).toBe(true);

    expect(stored().paymentStatus).toBe('bezahlt');
  });

  it('F: eine Zahlung lässt sich weiterhin entfernen', () => {
    const first = recordPayment(VORGANG_ID, INVOICE_ID, { date: '2026-08-25', amount: 4000 });
    const second = recordPayment(VORGANG_ID, INVOICE_ID, { date: '2026-08-26', amount: 1000 });
    expect(first.success && second.success).toBe(true);
    if (!first.success || !second.success) return;

    const removed = removePayment(VORGANG_ID, INVOICE_ID, first.payment.id);
    expect(removed.success).toBe(true);

    const payments = stored().payments ?? [];
    expect(payments.map((payment) => payment.id)).toEqual([second.payment.id]);
    expect(stored().paymentStatus).toBe('teilbezahlt');
  });

  it('G: ein Persistenzfehler beim Erfassen ist kein Erfolg', () => {
    vi.spyOn(persistenceService, 'persistAll').mockReturnValue({ success: false });

    const result = recordPayment(VORGANG_ID, INVOICE_ID, { date: '2026-08-25', amount: 4000 });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.errorKey).toBe('payment.persistFailed');

    // Nichts bleibt zurück: die Zahlung hat nicht stattgefunden.
    const invoice = stored();
    expect(invoice.payments ?? []).toHaveLength(0);
    expect(invoice.paymentStatus).toBe('offen');
  });

  it('H: ein Persistenzfehler beim Entfernen ist kein Erfolg', () => {
    const first = recordPayment(VORGANG_ID, INVOICE_ID, { date: '2026-08-25', amount: 4000 });
    expect(first.success).toBe(true);
    if (!first.success) return;

    vi.spyOn(persistenceService, 'persistAll').mockReturnValue({ success: false });
    const removed = removePayment(VORGANG_ID, INVOICE_ID, first.payment.id);

    expect(removed.success).toBe(false);
    if (removed.success) return;
    expect(removed.errorKey).toBe('payment.persistFailed');

    // Die Zahlung steht unverändert im Speicher.
    const payments = stored().payments ?? [];
    expect(payments.map((payment) => payment.id)).toEqual([first.payment.id]);
    expect(stored().paymentStatus).toBe('teilbezahlt');
  });

  it('I: die bestehende Fachlogik bleibt unverändert', () => {
    // Kein Zahlungseingang auf eine nicht finalisierte Rechnung.
    seed(buildInvoice({ status: 'entwurf' }));
    const draft = recordPayment(VORGANG_ID, INVOICE_ID, { date: '2026-08-25', amount: 100 });
    expect(draft.success).toBe(false);
    if (!draft.success) expect(draft.errorKey).toBe('payment.invoiceNotFinalized');

    // Keine Zahlung auf eine stornierte Rechnung.
    seed(buildInvoice({ paymentStatus: 'storniert' }));
    const cancelled = recordPayment(VORGANG_ID, INVOICE_ID, { date: '2026-08-25', amount: 100 });
    expect(cancelled.success).toBe(false);
    if (!cancelled.success) expect(cancelled.errorKey).toBe('payment.invoiceCancelled');

    // Überzahlung bleibt bestätigungspflichtig.
    seed();
    const overpay = recordPayment(VORGANG_ID, INVOICE_ID, { date: '2026-08-25', amount: 20000 });
    expect(overpay.success).toBe(false);
    if (!overpay.success) {
      expect(overpay.errorKey).toBe('payment.overpaymentConfirmationRequired');
    }
    const confirmed = recordPayment(
      VORGANG_ID,
      INVOICE_ID,
      { date: '2026-08-25', amount: 20000 },
      { confirmOverpayment: true },
    );
    expect(confirmed.success).toBe(true);
  });
});
