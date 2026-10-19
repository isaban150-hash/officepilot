/**
 * FC01A-Nacharbeit — Abschlag und Schlussrechnung im Client.
 *
 *  A2  Die Zahlung eines Abschlags, den eine wirksame Schlussrechnung als beglichen abzieht, ist
 *      nicht rücknehmbar (sonst stünde der Abschlag wieder offen und mahnbar, während die
 *      Schlussrechnung ihn als bezahlt ausweist). Wie beim Storno (SQL-01): zuerst die
 *      Schlussrechnung stornieren. Server: `reverse_workspace_invoice_payment`.
 *  A3  Eine Schlussrechnung zieht nur Abschläge desselben Steuerfalls ab (19 % gegen § 13b ergäbe
 *      einen falschen Restbetrag und falsch ausgewiesene Steuer). Server:
 *      `invoice_abschlag_tax_status_mismatch` in `assert_workspace_invoice_integrity`.
 *
 * Neutrale Beispieldaten.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { hydrateVorgangStore, getVorgangById } from '../vorgangService';
import { buildSchlussrechnungDraft, finalizeInvoiceDraft } from '../invoiceService';
import { hasAbschlagTaxStatusMismatch, validateInvoiceDraftForApproval } from '../invoiceValidationService';
import { removePayment } from '../invoicePaymentService';
import { findFinalInvoiceBlockingPaymentReversal } from './invoiceCancelEligibility';
import { serverRejectionMessageKey } from './invoiceApprovalUx';
import { classifyInvoiceCloudErrorForTests } from './workspaceInvoiceCloudService';
import { InvoicePaymentHistory } from '../../components/invoice/InvoicePaymentHistory';
import { createOrderPosition, createTestVorgang, testSetup } from '../../test/fixtures';
import { t } from '../../i18n';
import type { AbschlagDeduction, InvoiceDraft, InvoicePayment, TaxStatus, VorgangInvoice } from '../../types/models';

const VORGANG_ID = 'v-test-1';

function zahlung(id: string, amount: number, date: string): InvoicePayment {
  return { id, amount, date, createdAt: `${date}T10:00:00.000Z` };
}

/** Pauschalabschlag 400 netto / 476 brutto ohne Positionszeilen (zieht Geld ab, keine Menge). */
function abschlag(overrides: Partial<VorgangInvoice> = {}): VorgangInvoice {
  return {
    id: 'inv-ab-1',
    number: '2026-0017',
    type: 'abschlag',
    abschlagNumber: 1,
    calculationMode: 'fixed_amount',
    fixedAmountNet: 400,
    positions: [],
    subtotal: 400,
    taxStatus: 'standard_19',
    amount: 476,
    status: 'versendet',
    date: '2026-09-01',
    issueDate: '2026-09-01',
    createdAt: '2026-09-01T10:00:00.000Z',
    payments: [zahlung('p-ab-1', 476, '2026-09-05')],
    ...overrides,
  };
}

const ABZUG: AbschlagDeduction = {
  invoiceId: 'inv-ab-1',
  invoiceNumber: '2026-0017',
  abschlagNumber: 1,
  date: '2026-09-01',
  subtotal: 400,
  amount: 476,
  paidAmount: 476,
  skontoAmount: 0,
};

function schluss(overrides: Partial<VorgangInvoice> = {}): VorgangInvoice {
  return {
    id: 'inv-schluss-1',
    number: '2026-0030',
    type: 'schluss',
    positions: [],
    subtotal: 1000,
    taxStatus: 'standard_19',
    amount: 714,
    status: 'versendet',
    date: '2026-10-01',
    issueDate: '2026-10-01',
    createdAt: '2026-10-01T10:00:00.000Z',
    payments: [],
    previousAbschlagDeductions: [ABZUG],
    ...overrides,
  };
}

function vorgangMit(invoices: VorgangInvoice[]): void {
  hydrateVorgangStore([
    createTestVorgang({
      orderPositions: [createOrderPosition({ id: 'op-test-1', executedQuantity: 10 })],
      invoices,
    }),
  ]);
}

/** Eine neue Schlussrechnung zum (bezahlten) Abschlag, Steuerstatus wählbar. */
function schlussEntwurf(ab: VorgangInvoice, taxStatus: TaxStatus = 'standard_19'): InvoiceDraft {
  vorgangMit([ab]);
  const draft = buildSchlussrechnungDraft(VORGANG_ID, testSetup);
  expect(draft, 'Schlussrechnungsentwurf konnte nicht gebaut werden').not.toBeNull();
  return {
    ...draft!,
    taxStatus,
    servicePeriodFrom: '2026-09-01',
    servicePeriodTo: '2026-09-30',
    servicePeriodConfirmed: true,
  };
}

function blockingCodes(draft: InvoiceDraft): string[] {
  return validateInvoiceDraftForApproval(draft, draft.companySnapshot, getVorgangById(VORGANG_ID), {
    reverseCharge13bConfirmed: true,
  }).blockingErrors.map((issue) => issue.code);
}

describe('FC01A-Nacharbeit A2 — keine Rücknahme der Abschlagszahlung hinter einer wirksamen Schlussrechnung', () => {
  beforeEach(() => hydrateVorgangStore([]));

  it('R1: die Regel nennt genau die wirksame Schlussrechnung, die diesen Abschlag abzieht', () => {
    vorgangMit([abschlag(), schluss()]);
    expect(findFinalInvoiceBlockingPaymentReversal(VORGANG_ID, abschlag())?.id).toBe('inv-schluss-1');

    // Storniert, als storniert markiert oder nur ein Entwurf: sperrt nicht.
    vorgangMit([abschlag(), schluss({ cancelledAt: '2026-10-02T10:00:00.000Z' })]);
    expect(findFinalInvoiceBlockingPaymentReversal(VORGANG_ID, abschlag())).toBeNull();
    vorgangMit([abschlag(), schluss({ paymentStatus: 'storniert' })]);
    expect(findFinalInvoiceBlockingPaymentReversal(VORGANG_ID, abschlag())).toBeNull();

    // Ein Abschlag, der nicht als Abzug darin steht (mengenbasiert), und andere Belege: frei.
    vorgangMit([abschlag(), schluss({ previousAbschlagDeductions: [] })]);
    expect(findFinalInvoiceBlockingPaymentReversal(VORGANG_ID, abschlag())).toBeNull();
    vorgangMit([abschlag(), schluss()]);
    expect(findFinalInvoiceBlockingPaymentReversal(VORGANG_ID, { id: 'inv-teil-1', type: 'teilrechnung' })).toBeNull();
    expect(findFinalInvoiceBlockingPaymentReversal(VORGANG_ID, schluss())).toBeNull();
    expect(findFinalInvoiceBlockingPaymentReversal(null, abschlag())).toBeNull();
  });

  it('R2: der Zahlungsdienst lehnt ab und lässt die Zahlung stehen', () => {
    vorgangMit([abschlag(), schluss()]);
    expect(removePayment(VORGANG_ID, 'inv-ab-1', 'p-ab-1')).toEqual({
      success: false,
      errorKey: 'payment.reverseBlockedByFinalInvoice',
    });
    const ab = getVorgangById(VORGANG_ID)!.invoices.find((invoice) => invoice.id === 'inv-ab-1')!;
    expect(ab.payments?.map((payment) => payment.id)).toEqual(['p-ab-1']);
    expect(t('payment.reverseBlockedByFinalInvoice')).toContain('zuerst die Schlussrechnung stornieren');
  });

  it('R3: nach Storno der Schlussrechnung ist die Zahlung wieder rücknehmbar (wie bisher)', () => {
    vorgangMit([abschlag(), schluss({ cancelledAt: '2026-10-02T10:00:00.000Z' })]);
    const result = removePayment(VORGANG_ID, 'inv-ab-1', 'p-ab-1');
    expect(result.success).toBe(true);
  });

  it('R4: die Zahlungsliste zeigt statt der Aktion den Grund', () => {
    const translate = (key: string) => t(key as never);
    const gesperrt = renderToStaticMarkup(
      <InvoicePaymentHistory
        invoice={abschlag()}
        translate={translate}
        onRemovePayment={() => undefined}
        allowRemove
        removeBlockedReason={t('payment.reverseBlockedByFinalInvoice')}
      />,
    );
    expect(gesperrt).toContain('data-testid="payment-remove-blocked"');
    expect(gesperrt).not.toContain('data-testid="payment-remove-p-ab-1"');

    const frei = renderToStaticMarkup(
      <InvoicePaymentHistory invoice={abschlag()} translate={translate} onRemovePayment={() => undefined} allowRemove />,
    );
    expect(frei).toContain('data-testid="payment-remove-p-ab-1"');
    expect(frei).not.toContain('payment-remove-blocked');
  });
});

describe('FC01A-Nacharbeit A3 — Abschlag und Schlussrechnung im selben Steuerfall', () => {
  beforeEach(() => hydrateVorgangStore([]));

  it('T1: gleicher Steuerfall — kein Hinweis', () => {
    expect(blockingCodes(schlussEntwurf(abschlag(), 'standard_19'))).not.toContain('abschlag_tax_status_mismatch');
  });

  it('T2: Abschlag 19 %, Schlussrechnung nach § 13b — gesperrt', () => {
    expect(blockingCodes(schlussEntwurf(abschlag(), 'reverse_charge_13b'))).toContain('abschlag_tax_status_mismatch');
    expect(blockingCodes(schlussEntwurf(abschlag(), 'kleinunternehmer_19'))).toContain('abschlag_tax_status_mismatch');
  });

  it('T3: Abschlag nach § 13b, Schlussrechnung mit 19 % — gesperrt', () => {
    const ab = abschlag({ taxStatus: 'reverse_charge_13b', amount: 400, payments: [zahlung('p-ab-1', 400, '2026-09-05')] });
    expect(blockingCodes(schlussEntwurf(ab, 'standard_19'))).toContain('abschlag_tax_status_mismatch');
  });

  it('T4: Altbestand ohne Steuerstatus — Steuer ja/nein muss zum Satz passen (wie der Server)', () => {
    const alt = abschlag({ taxStatus: undefined });
    const finden = (id: string) => (id === 'inv-ab-1' ? alt : undefined);
    expect(hasAbschlagTaxStatusMismatch('reverse_charge_13b', [ABZUG], finden)).toBe(true);
    expect(hasAbschlagTaxStatusMismatch('standard_19', [ABZUG], finden)).toBe(false);
    const altOhneSteuer = abschlag({ taxStatus: undefined, amount: 400 });
    expect(hasAbschlagTaxStatusMismatch('standard_19', [ABZUG], (id) => (id === 'inv-ab-1' ? altOhneSteuer : undefined))).toBe(true);
    // Unbekannter Abschlag: hier keine Entscheidung (der Server prüft).
    expect(hasAbschlagTaxStatusMismatch('reverse_charge_13b', [ABZUG], () => undefined)).toBe(false);
  });

  it('T5: ohne getroffene Steuerentscheidung meldet das die Steuerprüfung, nicht diese Regel', () => {
    expect(blockingCodes(schlussEntwurf(abschlag(), 'unclear'))).not.toContain('abschlag_tax_status_mismatch');
  });

  it('T6: der produktive Freigabeweg sperrt (nichts gespeichert) — und die Serverabweisung hat ihren Text', () => {
    const draft = schlussEntwurf(abschlag(), 'reverse_charge_13b');
    const result = finalizeInvoiceDraft(VORGANG_ID, draft, testSetup);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.validation?.blockingErrors.map((issue) => issue.code)).toContain('abschlag_tax_status_mismatch');
    expect(getVorgangById(VORGANG_ID)!.invoices.filter((invoice) => invoice.type === 'schluss')).toHaveLength(0);

    const message = 'invoice_abschlag_tax_status_mismatch';
    expect(serverRejectionMessageKey(`ERROR: ${message}`)).toBe('invoice.approve.abschlagTaxStatusMismatch');
    expect(classifyInvoiceCloudErrorForTests({ message, code: 'P0001' }).code).toBe('tax_status_mismatch');
    expect(t('invoice.validation.abschlagTaxStatusMismatch')).toContain('Steuerfall');
  });
});
