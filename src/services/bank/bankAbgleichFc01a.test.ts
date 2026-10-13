/**
 * FINANZ-CORE-01A — Bankabgleich (ZAH-03, ZAH-04, ZAH-18).
 *
 *  B3a  eine von Hand erfasste Zahlung über denselben Betrag wird erkannt — auch an einer voll bezahlten Rechnung
 *  B3b  nicht erkannt: anderer Betrag, mehr als zehn Tage entfernt, schon einer Bewegung zugeordnet, stornierte Rechnung
 *  B3c  der Bestätigungsplan warnt vor der Doppelbuchung (recordedMatch)
 *  B3d  Verknüpfen ruft link_workspace_bank_reconciliation mit der vorhandenen Zahlung und übernimmt die Zuordnung
 *  B4a  ein fristgerechter Skontobetrag ist ein Betragstreffer; der Plan ist keine Teilzahlung
 *  B4b  nach Ablauf der Skontofrist kein Skontotreffer, wieder „Teilzahlung"
 *  B18a eine Rollenablehnung heisst not_allowed, nicht offline
 *  B18b dieselbe Bestätigung schickt bei Wiederholung dieselben Kennungen (Replay statt „bereits zugeordnet")
 *
 * Synthetische Daten, kein Netz.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as supabaseLib from '../../lib/supabase';
import * as syncClientService from '../sync/syncClientService';
import { hydrateInvoiceStore } from '../invoice/invoiceStore';
import { hydrateVorgangStore } from '../vorgangService';
import { hydrateExpenseStore } from '../expenseStore';
import { resetBankTransactionsForTests } from './bankTransactionStore';
import { resetBankAccountsForTests } from './bankAccountStore';
import {
  applyConfirmedReconciliation,
  findReconciliationForTransaction,
  resetBankReconciliationsForTests,
} from './bankReconciliationStore';
import { buildBankSuggestions } from './bankSuggestionService';
import {
  confirmBankReconciliation,
  createBankConfirmIds,
  linkBankReconciliation,
  planBankConfirmation,
} from './bankReconciliationService';
import type { BankSuggestionCandidate } from '../../types/bankSuggestion';
import type { BankTransaction } from '../../types/bankTransaction';
import type { InvoicePayment, VorgangInvoice } from '../../types/models';

const WS = '00000000-0000-4000-8000-0000000fc0b1';

function rechnung(overrides: Partial<VorgangInvoice> = {}): VorgangInvoice {
  return {
    id: 'inv-1',
    number: 'RE-2026-0014',
    status: 'versendet',
    date: '2026-10-01',
    issueDate: '2026-10-01',
    type: 'rechnung',
    positions: [],
    subtotal: 840.34,
    taxStatus: 'standard_19',
    taxAmount: 159.66,
    total: 1000,
    amount: 1000,
    payments: [],
    customerSnapshot: { name: 'Westfalen Projektbau GmbH' },
    ...overrides,
  } as unknown as VorgangInvoice;
}

function zahlung(id: string, betrag: number, datum: string): InvoicePayment {
  return { id, amount: betrag, date: datum, method: 'transfer', createdAt: `${datum}T10:00:00.000Z` } as InvoicePayment;
}

function bewegung(overrides: Partial<BankTransaction> = {}): BankTransaction {
  return {
    id: 'btx-1',
    accountKey: 'bacc-1',
    importId: 'i1',
    fileName: 'a.csv',
    importedAt: '2026-10-08T10:00:00.000Z',
    bookingDate: '2026-10-06',
    amountCents: 40000,
    counterparty: 'Westfalen Projektbau GmbH',
    purpose: 'Zahlung',
    fingerprint: 'f1',
    occurrence: 1,
    ...overrides,
  };
}

function kandidat(overrides: Partial<BankSuggestionCandidate> = {}): BankSuggestionCandidate {
  return {
    targetType: 'invoice',
    targetId: 'inv-1',
    documentNumber: 'RE-2026-0014',
    partyName: 'Westfalen Projektbau GmbH',
    openCents: 60000,
    grade: 'passend',
    reasons: ['counterparty_matches', 'amount_differs'],
    ...overrides,
  };
}

function bestand(...invoices: VorgangInvoice[]): void {
  hydrateInvoiceStore(invoices.map((invoice) => ({ invoice, vorgangId: null })));
}

function cloud(rpc: (name: string, args: Record<string, unknown>) => unknown) {
  const spy = vi.fn(async (name: string, args: Record<string, unknown>) => rpc(name, args));
  vi.spyOn(supabaseLib, 'getSupabaseClient').mockReturnValue({ rpc: spy } as never);
  vi.spyOn(syncClientService, 'getSyncClient').mockReturnValue({ workspaceId: WS, serverWorkspaceId: WS } as never);
  return spy;
}

function serverZeile(args: Record<string, unknown>) {
  return {
    data: {
      reconciliation: {
        client_reconciliation_id: args.p_client_reconciliation_id,
        bank_transaction_id: args.p_bank_transaction_id,
        target_type: args.p_target_type,
        client_target_id: args.p_client_target_id,
        client_payment_id: args.p_client_payment_id,
        amount_cents: 40000,
        paid_on: '2026-10-06',
        confirmed_at: '2026-10-08T12:00:00.000Z',
      },
      replayed: false,
    },
    error: null,
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  resetBankTransactionsForTests();
  resetBankAccountsForTests();
  resetBankReconciliationsForTests();
  hydrateVorgangStore([]);
  hydrateInvoiceStore([]);
  hydrateExpenseStore([]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ZAH-03 — bereits erfasste Zahlung', () => {
  it('B3a: erkannt — auch an einer schon voll bezahlten Rechnung', () => {
    bestand(rechnung({ payments: [zahlung('pay-hand', 1000, '2026-10-05')], amount: 1000 }));
    const t = bewegung({ amountCents: 100000 });
    const ergebnis = buildBankSuggestions([t]).get(t.id)!;
    // Die Rechnung ist bezahlt — kein Kandidat zum Buchen, aber die erfasste Zahlung zum Verknüpfen.
    expect(ergebnis.candidates).toEqual([]);
    expect(ergebnis.alreadyRecorded).toEqual([
      {
        targetType: 'invoice',
        targetId: 'inv-1',
        documentNumber: 'RE-2026-0014',
        partyName: 'Westfalen Projektbau GmbH',
        paymentId: 'pay-hand',
        paymentDate: '2026-10-05',
        amountCents: 100000,
      },
    ]);
  });

  it('B3b: nicht erkannt bei anderem Betrag, grossem Abstand, vorhandener Zuordnung oder Storno', () => {
    bestand(
      rechnung({ id: 'inv-a', payments: [zahlung('pay-a', 399.99, '2026-10-05')] }),
      rechnung({ id: 'inv-b', number: 'RE-2026-0015', payments: [zahlung('pay-b', 400, '2026-09-20')] }),
      rechnung({ id: 'inv-c', number: 'RE-2026-0016', payments: [zahlung('pay-c', 400, '2026-10-05')] }),
      rechnung({
        id: 'inv-d',
        number: 'RE-2026-0017',
        cancelledAt: '2026-10-07T08:00:00.000Z',
        payments: [zahlung('pay-d', 400, '2026-10-05')],
      }),
    );
    applyConfirmedReconciliation({
      id: 'brec-alt',
      bankTransactionId: 'btx-alt',
      targetType: 'invoice',
      targetId: 'inv-c',
      paymentId: 'pay-c',
      amountCents: 40000,
      paidOn: '2026-10-05',
      confirmedAt: '2026-10-05T12:00:00.000Z',
    });
    const t = bewegung();
    expect(buildBankSuggestions([t]).get(t.id)!.alreadyRecorded).toEqual([]);
  });

  it('B3c: der Plan warnt vor der Doppelbuchung auf demselben Beleg', () => {
    bestand(rechnung({ payments: [zahlung('pay-hand', 400, '2026-10-04')] }));
    const plan = planBankConfirmation(bewegung(), kandidat());
    expect(plan.refusal).toBeNull();
    expect(plan.recordedMatch?.paymentId).toBe('pay-hand');
    // Ein anderer Beleg derselben Bewegung trägt keine Warnung.
    expect(planBankConfirmation(bewegung(), kandidat({ targetId: 'inv-x' })).recordedMatch).toBeNull();
  });

  it('B3d: Verknüpfen schickt die vorhandene Zahlung und legt keine neue an', async () => {
    bestand(rechnung({ payments: [zahlung('pay-hand', 400, '2026-10-04')] }));
    const rpc = cloud((name, args) => (name === 'link_workspace_bank_reconciliation' ? serverZeile(args) : { data: null, error: { message: 'unerwartet' } }));
    const t = bewegung();
    const treffer = buildBankSuggestions([t]).get(t.id)!.alreadyRecorded![0]!;
    const ergebnis = await linkBankReconciliation(t, treffer, 'brec-link-1');
    expect(ergebnis.ok).toBe(true);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc.mock.calls[0]![0]).toBe('link_workspace_bank_reconciliation');
    expect(rpc.mock.calls[0]![1]).toMatchObject({
      p_bank_transaction_id: 'btx-1',
      p_target_type: 'invoice',
      p_client_target_id: 'inv-1',
      p_client_payment_id: 'pay-hand',
      p_client_reconciliation_id: 'brec-link-1',
    });
    expect(findReconciliationForTransaction('btx-1')?.paymentId).toBe('pay-hand');
    // Danach gilt die Zahlung als zugeordnet und wird nicht noch einmal angeboten.
    expect(buildBankSuggestions([bewegung({ id: 'btx-2' })]).get('btx-2')!.alreadyRecorded).toEqual([]);
  });

  it('B3d: Ablehnungen des Servers werden benannt', async () => {
    bestand(rechnung({ payments: [zahlung('pay-hand', 400, '2026-10-04')] }));
    cloud(() => ({ data: null, error: { message: 'Zahlung bereits einer Bankbewegung zugeordnet' } }));
    const t = bewegung();
    const treffer = buildBankSuggestions([t]).get(t.id)!.alreadyRecorded![0]!;
    expect(await linkBankReconciliation(t, treffer)).toEqual({ ok: false, refusal: 'payment_already_linked' });
  });
});

describe('ZAH-04 — Skonto im Bankabgleich', () => {
  const skonto = { skontoText: 'Bei Zahlung innerhalb von 14 Tagen gewähren wir 2 % Skonto.' };

  it('B4a: der fristgerechte Skontobetrag ist ein Betragstreffer; der Plan ist keine Teilzahlung', () => {
    bestand(rechnung(skonto));
    const t = bewegung({ amountCents: 98000, bookingDate: '2026-10-10', purpose: 'RE-2026-0014' });
    const ergebnis = buildBankSuggestions([t]).get(t.id)!;
    expect(ergebnis.candidates[0]?.reasons).toContain('amount_matches_skonto');
    expect(ergebnis.candidates[0]?.reasons).not.toContain('amount_differs');
    expect(ergebnis.candidates[0]?.grade).toBe('sehr_passend');
    const plan = planBankConfirmation(t, ergebnis.candidates[0]!);
    expect(plan.refusal).toBeNull();
    expect(plan.skonto).toBe(true);
    expect(plan.partial).toBe(false);
  });

  it('B4b: nach Ablauf der Frist kein Skontotreffer', () => {
    bestand(rechnung(skonto));
    const t = bewegung({ amountCents: 98000, bookingDate: '2026-10-20', purpose: 'RE-2026-0014' });
    const ergebnis = buildBankSuggestions([t]).get(t.id)!;
    expect(ergebnis.candidates[0]?.reasons).not.toContain('amount_matches_skonto');
    const plan = planBankConfirmation(t, ergebnis.candidates[0]!);
    expect(plan.skonto).toBe(false);
    expect(plan.partial).toBe(true);
  });
});

describe('ZAH-18 — Meldungen und Kennungen', () => {
  it('B18a: eine Rollenablehnung heisst not_allowed', async () => {
    bestand(rechnung());
    cloud(() => ({ data: null, error: { message: 'finance_forbidden_role: Finanzaktion erfordert Inhaber- oder Verwaltungsrecht' } }));
    const ergebnis = await confirmBankReconciliation(bewegung(), kandidat({ openCents: 100000 }));
    expect(ergebnis).toEqual({ ok: false, refusal: 'not_allowed' });
  });

  it('B18b: dieselbe Bestätigung schickt bei Wiederholung dieselben Kennungen', async () => {
    bestand(rechnung());
    let versuch = 0;
    const rpc = cloud((_name, args) => {
      versuch += 1;
      // Der erste Versuch geht verloren (die Antwort kommt nie an), der zweite ist das Replay.
      return versuch === 1 ? { data: null, error: { message: 'Failed to fetch' } } : serverZeile(args);
    });
    const ids = createBankConfirmIds();
    expect((await confirmBankReconciliation(bewegung(), kandidat({ openCents: 100000 }), ids)).ok).toBe(false);
    expect((await confirmBankReconciliation(bewegung(), kandidat({ openCents: 100000 }), ids)).ok).toBe(true);
    const [erst, zweit] = rpc.mock.calls.map((call) => call[1]);
    expect(zweit!.p_client_payment_id).toBe(erst!.p_client_payment_id);
    expect(zweit!.p_client_reconciliation_id).toBe(erst!.p_client_reconciliation_id);
  });
});
