/**
 * FC01A-P1-Nacharbeit — die zwei P1-Befunde der unabhängigen Endabnahme im Client.
 *
 *  #8      Der Server verlangt je Abzugszeile Nummer, Datum, Netto und Abschlagsnummer des
 *          gespeicherten Abschlags (`invoice_deductions_mismatch: angaben`). D1–D4: Der Client
 *          baut genau diese Angaben, auch für Altbestand, und nennt die Abweisung beim Namen.
 *  ZAH-04  Ein mit Zahlung und Skonto ausgeglichener Abschlag nimmt keine weitere Zahlung an
 *          (Server: `workspace_invoice_open_cents`, `invoice_payment_final_invoice_exists`).
 *          Z1–Z6: Erfassung, Cloud-Ausgang, Nachsicherung und Bankabgleich.
 *
 * Neutrale Beispieldaten.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as supabaseLib from '../../lib/supabase';
import * as syncClientService from '../sync/syncClientService';
import { resetTestStores } from '../../test/resetStores';
import { createTestVorgang } from '../../test/fixtures';
import { hydrateVorgangStore, getVorgangInvoice } from '../vorgangService';
import { hydrateInvoiceStore } from './invoiceStore';
import { getPreviousAbschlagDeductions } from '../invoiceService';
import { recordPayment } from '../invoicePaymentService';
import { serverRejectionMessageKey } from './invoiceApprovalUx';
import { classifyInvoiceCloudErrorForTests } from './workspaceInvoiceCloudService';
import { addInvoicePaymentToCloud } from './workspaceInvoicePaymentCloudService';
import {
  isFinalInvoicePaymentResyncOutcome,
  resetInvoicePaymentResyncForTests,
  resyncLocalOnlyInvoicePayments,
} from './invoicePaymentCloudResyncService';
import { resetBankTransactionsForTests } from '../bank/bankTransactionStore';
import { resetBankAccountsForTests } from '../bank/bankAccountStore';
import { findReconciliationForTransaction, resetBankReconciliationsForTests } from '../bank/bankReconciliationStore';
import { confirmBankReconciliation, planBankConfirmation } from '../bank/bankReconciliationService';
import { bg, de, t, tr } from '../../i18n';
import type { BankSuggestionCandidate } from '../../types/bankSuggestion';
import type { BankTransaction } from '../../types/bankTransaction';
import type { AbschlagDeduction, InvoicePayment, VorgangInvoice } from '../../types/models';

const VORGANG_ID = 'v-test-1';
const WS = '00000000-0000-4000-8000-0000000fcb51';
const SKONTO = 'Bei Zahlung innerhalb von 10 Tagen gewähren wir 2 % Skonto.';

function zahlung(id: string, amount: number, date: string): InvoicePayment {
  return { id, amount, date, createdAt: `${date}T10:00:00.000Z` };
}

/** Pauschalabschlag 500 (Kleinunternehmer), 2 % Skonto in 10 Tagen ab 01.09., 490 am 08.09. gezahlt. */
function abschlag(overrides: Partial<VorgangInvoice> = {}): VorgangInvoice {
  return {
    id: 'inv-ab-1',
    number: '2026-0017',
    type: 'abschlag',
    abschlagNumber: 1,
    calculationMode: 'fixed_amount',
    fixedAmountNet: 500,
    positions: [],
    subtotal: 500,
    taxStatus: 'kleinunternehmer_19',
    amount: 500,
    status: 'versendet',
    date: '2026-09-01',
    issueDate: '2026-09-01',
    createdAt: '2026-09-01T10:00:00.000Z',
    skontoText: SKONTO,
    payments: [zahlung('p-ab-1', 490, '2026-09-08')],
    ...overrides,
  };
}

const ABZUG: AbschlagDeduction = {
  invoiceId: 'inv-ab-1',
  invoiceNumber: '2026-0017',
  abschlagNumber: 1,
  date: '2026-09-01',
  subtotal: 500,
  amount: 500,
  paidAmount: 490,
  skontoAmount: 10,
};

function schluss(overrides: Partial<VorgangInvoice> = {}): VorgangInvoice {
  return {
    id: 'inv-schluss-1',
    number: '2026-0030',
    type: 'schluss',
    positions: [],
    subtotal: 10000,
    taxStatus: 'kleinunternehmer_19',
    amount: 9500,
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
  hydrateVorgangStore([createTestVorgang({ invoices })]);
}

beforeEach(() => {
  vi.restoreAllMocks();
  resetTestStores();
  resetInvoicePaymentResyncForTests();
  resetBankTransactionsForTests();
  resetBankAccountsForTests();
  resetBankReconciliationsForTests();
  hydrateInvoiceStore([]);
});

afterEach(() => {
  vi.restoreAllMocks();
  resetInvoicePaymentResyncForTests();
});

describe('FC01A-P1 #8 — die Abzugsangaben, die der Server verlangt', () => {
  it('D1: Nummer, Ausstellungsdatum, Netto und Abschlagsnummer kommen aus dem Abschlag selbst', () => {
    vorgangMit([abschlag({ date: '2026-08-31' })]);
    const [abzug] = getPreviousAbschlagDeductions(createTestVorgang({ invoices: [abschlag({ date: '2026-08-31' })] }));
    expect(abzug).toEqual({
      invoiceId: 'inv-ab-1',
      invoiceNumber: '2026-0017',
      abschlagNumber: 1,
      date: '2026-09-01',
      subtotal: 500,
      amount: 500,
    });
  });

  it('D2: Altbestand — ohne issueDate gilt date; ohne Netto und Abschlagsnummer fehlen beide auch im Abzug', () => {
    const alt = abschlag({ issueDate: undefined, subtotal: undefined as unknown as number, abschlagNumber: undefined });
    const [abzug] = getPreviousAbschlagDeductions(createTestVorgang({ invoices: [alt] }));
    const gesendet = JSON.parse(JSON.stringify(abzug)) as Record<string, unknown>;
    expect(gesendet).toEqual({ invoiceId: 'inv-ab-1', invoiceNumber: '2026-0017', date: '2026-09-01', amount: 500 });
  });

  it('D3: stornierte und mengenbasierte Abschläge stehen nicht im Abzug (unverändert)', () => {
    const storniert = abschlag({ id: 'inv-ab-2', number: '2026-0018', cancelledAt: '2026-09-10T10:00:00.000Z', paymentStatus: 'storniert' });
    const abzuege = getPreviousAbschlagDeductions(createTestVorgang({ invoices: [abschlag(), storniert] }));
    expect(abzuege.map((entry) => entry.invoiceId)).toEqual(['inv-ab-1']);
  });

  it('D4: die Serverabweisung "angaben" ist die bekannte Abzugsabweisung — auch für alte Clients', () => {
    const message = 'invoice_deductions_mismatch: angaben';
    expect(serverRejectionMessageKey(`ERROR: ${message}`)).toBe('invoice.approve.deductionsMismatch');
    expect(classifyInvoiceCloudErrorForTests({ message, code: 'P0001' }).code).toBe('totals_mismatch');
    expect(t('invoice.approve.deductionsMismatch')).toContain('neu aufbauen');
  });
});

describe('FC01A-P1 ZAH-04 — keine Zahlung auf einen ausgeglichenen Abschlag', () => {
  it('Z1: hinter einer wirksamen Schlussrechnung lehnt die Erfassung ab, auch bestätigt; nichts wird gebucht', () => {
    vorgangMit([abschlag(), schluss()]);
    for (const options of [{}, { confirmOverpayment: true }]) {
      expect(recordPayment(VORGANG_ID, 'inv-ab-1', { date: '2026-09-09', amount: 10 }, options)).toEqual({
        success: false,
        errorKey: 'payment.finalInvoiceExists',
      });
    }
    expect(getVorgangInvoice(VORGANG_ID, 'inv-ab-1')!.payments).toHaveLength(1);
    expect(t('payment.finalInvoiceExists')).toContain('auf die Schlussrechnung buchen');
  });

  it('Z2: ohne Schlussrechnung bleibt es die bewusste Überzahlung (mit Bestätigung), wie bisher', () => {
    vorgangMit([abschlag()]);
    expect(recordPayment(VORGANG_ID, 'inv-ab-1', { date: '2026-09-09', amount: 10 })).toEqual({
      success: false,
      errorKey: 'payment.overpaymentConfirmationRequired',
    });
    expect(recordPayment(VORGANG_ID, 'inv-ab-1', { date: '2026-09-09', amount: 10 }, { confirmOverpayment: true }).success).toBe(true);
  });

  it('Z3: Altbestand — ein noch offener Abschlag hinter einer Schlussrechnung nimmt den Rest an, mehr nicht', () => {
    const offen = abschlag({ skontoText: undefined, payments: [zahlung('p-ab-1', 400, '2026-09-05')] });
    // FINANZ-CORE-01A (INV-03): Altbestand heißt Abzug ohne eingefrorene Aufteilung (vor N02). Mit Aufteilung
    // (paidAmount) weist jede neue Zahlung ab — das prüfen Z1 und inventurPaket1Fc01a E1.
    const altabzug = { ...ABZUG, paidAmount: undefined, skontoAmount: undefined };
    vorgangMit([offen, schluss({ previousAbschlagDeductions: [altabzug] })]);
    expect(recordPayment(VORGANG_ID, 'inv-ab-1', { date: '2026-09-09', amount: 101 }, { confirmOverpayment: true })).toEqual({
      success: false,
      errorKey: 'payment.finalInvoiceExists',
    });
    expect(recordPayment(VORGANG_ID, 'inv-ab-1', { date: '2026-09-09', amount: 100 }).success).toBe(true);
  });

  it('Z4: die Serverabweisung ist ein eigener, endgültiger Ausgang — keine automatische Wiederholung', async () => {
    const rpc = vi.fn(async () => ({ data: null, error: { code: 'P0001', message: 'invoice_payment_final_invoice_exists: offen 0.00' } }));
    const result = await addInvoicePaymentToCloud(
      { clientInvoiceId: 'inv-ab-1', clientPaymentId: 'pay-x', amount: 10, paidOn: '2026-09-09', method: 'bank', overpaymentAcknowledged: true },
      { client: { rpc } as never, workspaceId: WS },
    );
    expect(result.outcome).toBe('final_invoice_exists');
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(isFinalInvoicePaymentResyncOutcome('final_invoice_exists')).toBe(true);

    const rechnung = abschlag({ payments: [zahlung('p-ab-1', 490, '2026-09-08'), zahlung('pay-x', 10, '2026-09-09')] });
    const push = vi.fn(async () => 'final_invoice_exists' as const);
    const deps = { listInvoices: () => [rechnung], pull: async () => ({ outcome: 'synced' as const, rows: [] }), push };
    let now = 0;
    await resyncLocalOnlyInvoicePayments({ ...deps, now: () => now });
    now += 60 * 60 * 1000;
    await resyncLocalOnlyInvoicePayments({ ...deps, now: () => now });
    expect(push.mock.calls.length).toBeGreaterThan(0);
    const ersterLauf = push.mock.calls.length;
    now += 60 * 60 * 1000;
    await resyncLocalOnlyInvoicePayments({ ...deps, now: () => now });
    expect(push.mock.calls.length).toBe(ersterLauf);
  });

  it('Z5: Texte in allen drei Sprachen', () => {
    for (const key of ['payment.finalInvoiceExists', 'payment.cloudFinalInvoiceExists', 'payment.cloudBlocked.final_invoice_exists'] as const) {
      expect(de[key]).toContain('Schlussrechnung');
      expect(tr[key]).toBeTruthy();
      expect(bg[key]).toBeTruthy();
    }
  });
});

describe('FC01A-P1 ZAH-04 — Bankabgleich auf einen ausgeglichenen Abschlag', () => {
  function bewegung(overrides: Partial<BankTransaction> = {}): BankTransaction {
    return {
      id: 'btx-1',
      accountKey: 'bacc-1',
      importId: 'i1',
      fileName: 'a.csv',
      importedAt: '2026-09-10T10:00:00.000Z',
      bookingDate: '2026-09-09',
      amountCents: 1000,
      counterparty: 'Muster GmbH',
      purpose: '2026-0017',
      fingerprint: 'f1',
      occurrence: 1,
      ...overrides,
    };
  }
  const kandidat: BankSuggestionCandidate = {
    targetType: 'invoice',
    targetId: 'inv-ab-1',
    documentNumber: '2026-0017',
    partyName: 'Muster GmbH',
    openCents: 1000,
    grade: 'passend',
    reasons: ['amount_matches_open'],
  };

  it('Z6a: der Plan bietet keine Zuordnung an — mit Skonto ist nichts mehr offen (wie der Server)', () => {
    hydrateInvoiceStore([{ invoice: abschlag(), vorgangId: null }]);
    expect(planBankConfirmation(bewegung(), kandidat).refusal).toBe('nothing_open');
  });

  it('Z6b: veraltete Zuordnung — der Server weist ab, lokal entsteht weder Zahlung noch Zuordnung', async () => {
    // Das Gerät kennt den Skontosatz nicht (alter Stand) und hält 10 für offen.
    hydrateInvoiceStore([{ invoice: abschlag({ skontoText: undefined }), vorgangId: null }]);
    const rpc = vi.fn(async () => ({ data: null, error: { code: 'P0001', message: 'Kein offener Betrag' } }));
    vi.spyOn(supabaseLib, 'getSupabaseClient').mockReturnValue({ rpc } as never);
    vi.spyOn(syncClientService, 'getSyncClient').mockReturnValue({ workspaceId: WS, serverWorkspaceId: WS } as never);

    const t1 = bewegung();
    expect(planBankConfirmation(t1, kandidat).refusal).toBeNull();
    expect(await confirmBankReconciliation(t1, kandidat)).toEqual({ ok: false, refusal: 'nothing_open' });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(findReconciliationForTransaction(t1.id)).toBeFalsy();
  });
});
