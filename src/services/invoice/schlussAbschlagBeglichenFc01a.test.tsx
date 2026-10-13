/**
 * FINANZ-CORE-01A (WEISS-Nacharbeit N02/D1) — eine Schlussrechnung zieht nur beglichene
 * Abschläge ab.
 *
 * WEISS: Unbezahlter Abschlag 476 €, Schlussrechnung 1.190 € mit Abzug 476 € — die
 * E-Rechnung trug BT-113 = 476 € und Zahlbetrag 714 €, obwohl nichts gezahlt war.
 * Abgerechnet und bezahlt sind verschieden (§ 14 Abs. 5 Satz 2 UStG: vereinnahmte
 * Teilentgelte; BT-113 = bereits gezahlt).
 *
 *  B1–B7  Begleichungsstand je Abschlag: unbezahlt, teilbezahlt, bezahlt, überbezahlt,
 *         Skonto fristgerecht / verspätet, storniert, unbekannt
 *  V1–V3  Freigabeprüfung: unbezahlt/teilbezahlt sperrt, bezahlt nicht; der Nachdruck
 *         einer älteren Schlussrechnung bleibt möglich
 *  F1–F2  produktive Finalisierung (lokal) sperrt bzw. lässt durch — PDF-Restbetrag und
 *         Forderung stimmen
 *  S1     Serverabweisung `invoice_abschlag_unpaid` mit eigenem Text, nicht „unbekannt"
 *  U1     der Hinweis nennt Abschlag, Nummer und offenen Betrag
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

import { hydrateVorgangStore, getVorgangById } from '../vorgangService';
import { buildSchlussrechnungDraft, finalizeInvoiceDraft } from '../invoiceService';
import { validateFinalizedInvoiceForPdf, validateInvoiceDraftForApproval } from '../invoiceValidationService';
import { getOpenAmount } from '../invoicePaymentService';
import { findUnsettledAbschlagDeductions, resolveAbschlagSettlement } from './abschlagSettlement';
import { serverRejectionMessageKey } from './invoiceApprovalUx';
import { classifyInvoiceCloudErrorForTests } from './workspaceInvoiceCloudService';
import { InvoiceAbschlagSettlementNotice } from '../../components/invoice/InvoiceAbschlagSettlementNotice';
import { createOrderPosition, createTestVorgang, testSetup } from '../../test/fixtures';
import { t } from '../../i18n';
import type { AbschlagDeduction, InvoiceDraft, InvoicePayment, VorgangInvoice } from '../../types/models';

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
    payments: [],
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
};

function prepare(ab: VorgangInvoice): InvoiceDraft {
  hydrateVorgangStore([
    createTestVorgang({
      orderPositions: [createOrderPosition({ id: 'op-test-1', executedQuantity: 10 })],
      invoices: [ab],
    }),
  ]);
  const draft = buildSchlussrechnungDraft(VORGANG_ID, testSetup);
  expect(draft, 'Schlussrechnungsentwurf konnte nicht gebaut werden').not.toBeNull();
  return {
    ...draft!,
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

describe('N02 B — Begleichungsstand je abgezogenem Abschlag', () => {
  it('B1: unbezahlt — nicht beglichen, voll offen', () => {
    expect(resolveAbschlagSettlement(ABZUG, abschlag())).toEqual({
      invoiceId: 'inv-ab-1', invoiceNumber: '2026-0017', abschlagNumber: 1,
      billed: 476, paid: 0, skonto: 0, open: 476, settled: false,
    });
  });

  it('B2: teilbezahlt — nicht beglichen, Rest offen', () => {
    const s = resolveAbschlagSettlement(ABZUG, abschlag({ payments: [zahlung('p1', 200, '2026-09-05')] }));
    expect(s).toMatchObject({ paid: 200, skonto: 0, open: 276, settled: false });
  });

  it('B3: bezahlt und überbezahlt — beglichen; gezahlt höchstens der Abschlagsbetrag', () => {
    expect(resolveAbschlagSettlement(ABZUG, abschlag({ payments: [zahlung('p1', 476, '2026-09-05')] }))).toMatchObject({
      paid: 476, skonto: 0, open: 0, settled: true,
    });
    expect(
      resolveAbschlagSettlement(ABZUG, abschlag({ payments: [zahlung('p1', 300, '2026-09-05'), zahlung('p2', 200, '2026-09-06')] })),
    ).toMatchObject({ paid: 476, skonto: 0, open: 0, settled: true });
  });

  it('B4: Skonto fristgerecht — beglichen, Zahlung und Skonto getrennt; dieselbe Regel wie der offene Betrag', () => {
    const ab = abschlag({
      skontoText: '2 % Skonto bei Zahlung innerhalb von 10 Tagen',
      payments: [zahlung('p1', 466.48, '2026-09-05')],
    });
    expect(getOpenAmount(ab)).toBe(0);
    expect(resolveAbschlagSettlement(ABZUG, ab)).toMatchObject({ paid: 466.48, skonto: 9.52, open: 0, settled: true });
  });

  it('B5: Skonto verspätet — nicht beglichen', () => {
    const ab = abschlag({
      skontoText: '2 % Skonto bei Zahlung innerhalb von 10 Tagen',
      payments: [zahlung('p1', 466.48, '2026-09-25')],
    });
    expect(resolveAbschlagSettlement(ABZUG, ab)).toMatchObject({ paid: 466.48, skonto: 0, open: 9.52, settled: false });
  });

  it('B6: storniert — nichts belegt eine Zahlung', () => {
    const ab = abschlag({ cancelledAt: '2026-09-10T10:00:00.000Z', payments: [zahlung('p1', 476, '2026-09-05')] });
    expect(resolveAbschlagSettlement(ABZUG, ab)).toMatchObject({ paid: 0, open: 476, settled: false });
  });

  it('B7: unbekannter Abschlag — nicht beglichen (kein Nachweis)', () => {
    expect(resolveAbschlagSettlement(ABZUG, undefined)).toMatchObject({ paid: 0, open: 476, settled: false });
    expect(findUnsettledAbschlagDeductions([ABZUG], () => undefined)).toHaveLength(1);
    expect(findUnsettledAbschlagDeductions(undefined, () => undefined)).toEqual([]);
  });
});

describe('N02 V — Freigabeprüfung der Schlussrechnung', () => {
  beforeEach(() => hydrateVorgangStore([]));

  it('V1: unbezahlter und teilbezahlter Abschlag sperren die Freigabe', () => {
    expect(blockingCodes(prepare(abschlag()))).toContain('abschlag_unpaid');
    expect(blockingCodes(prepare(abschlag({ payments: [zahlung('p1', 200, '2026-09-05')] })))).toContain('abschlag_unpaid');
  });

  it('V2: ein bezahlter oder mit Skonto beglichener Abschlag sperrt nicht', () => {
    expect(blockingCodes(prepare(abschlag({ payments: [zahlung('p1', 476, '2026-09-05')] })))).not.toContain('abschlag_unpaid');
    expect(
      blockingCodes(
        prepare(
          abschlag({ skontoText: '2 % Skonto bei Zahlung innerhalb von 10 Tagen', payments: [zahlung('p1', 466.48, '2026-09-05')] }),
        ),
      ),
    ).not.toContain('abschlag_unpaid');
  });

  it('V3: der Nachdruck einer älteren Schlussrechnung mit unbezahltem Abzug bleibt möglich', () => {
    const draft = prepare(abschlag());
    const alt = {
      ...draft,
      id: 'inv-schluss-alt',
      number: '2026-0018',
      status: 'versendet',
      amount: 773.5 - 476,
      date: '2026-09-30',
      createdAt: '2026-09-30T10:00:00.000Z',
      customerSnapshot: draft.customerBilling,
    } as unknown as VorgangInvoice;
    const codes = validateFinalizedInvoiceForPdf(alt).blockingErrors.map((issue) => issue.code);
    expect(codes).not.toContain('abschlag_unpaid');
  });
});

describe('N02 F — produktive Finalisierung', () => {
  beforeEach(() => hydrateVorgangStore([]));

  it('F1: unbezahlter Abschlag — keine Schlussrechnung, nichts gespeichert', () => {
    const draft = prepare(abschlag());
    const result = finalizeInvoiceDraft(VORGANG_ID, draft, testSetup);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('validation_failed');
    expect(result.validation?.blockingErrors.map((issue) => issue.code)).toContain('abschlag_unpaid');
    expect(getVorgangById(VORGANG_ID)!.invoices.filter((invoice) => invoice.type === 'schluss')).toHaveLength(0);
  });

  it('F2: bezahlter Abschlag — Restbetrag = brutto minus Abzug; Abschlag ohne Forderung', () => {
    const draft = prepare(abschlag({ payments: [zahlung('p1', 476, '2026-09-05')] }));
    const result = finalizeInvoiceDraft(VORGANG_ID, draft, testSetup);
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    // 10 h × 65 € = 650 netto, 773,50 brutto, abzüglich 476 bezahlt → 297,50.
    expect(result.invoice.amount).toBeCloseTo(297.5, 2);
    const ab = getVorgangById(VORGANG_ID)!.invoices.find((invoice) => invoice.id === 'inv-ab-1')!;
    expect(getOpenAmount(ab)).toBe(0);
  });
});

describe('N02 S — Serverabweisung', () => {
  it('S1: invoice_abschlag_unpaid hat einen eigenen Text und ist eine inhaltliche Abweisung', () => {
    const message = 'invoice_abschlag_unpaid';
    expect(serverRejectionMessageKey(`ERROR: ${message}`)).toBe('invoice.approve.abschlagUnpaid');
    expect(classifyInvoiceCloudErrorForTests({ message, code: 'P0001' }).code).toBe('totals_mismatch');
    expect(t('invoice.approve.abschlagUnpaid')).toContain('nicht vollständig bezahlt');
    expect(t('invoice.validation.abschlagUnpaid')).toContain('§ 14 Abs. 5 UStG');
  });
});

describe('N02 U — Hinweis vor der Freigabe', () => {
  it('U1: nennt Abschlag, Nummer und offenen Betrag — und verschwindet, wenn alles beglichen ist', () => {
    const translate = (key: Parameters<typeof t>[0]) => t(key);
    const offen = findUnsettledAbschlagDeductions([ABZUG], () => abschlag({ payments: [zahlung('p1', 200, '2026-09-05')] }));
    const html = renderToStaticMarkup(<InvoiceAbschlagSettlementNotice unsettled={offen} translate={translate} />);
    expect(html).toContain('data-testid="invoice-abschlag-unsettled"');
    const zeile = /data-testid="invoice-abschlag-unsettled-inv-ab-1">([^<]*)</.exec(html)?.[1] ?? '';
    expect(zeile).toContain('Abschlag 1');
    expect(zeile).toContain('2026-0017');
    expect(zeile).toMatch(/offen 276,00\s€/);
    expect(renderToStaticMarkup(<InvoiceAbschlagSettlementNotice unsettled={[]} translate={translate} />)).toBe('');
  });
});
