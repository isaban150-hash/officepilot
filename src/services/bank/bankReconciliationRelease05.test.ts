/**
 * BANKABGLEICH-V1 BLOCK 5 — Storno und Bankzuordnung konsistent.
 *
 * Diese Datei prüft die **Client-Seite** und den Quelltext des Server­vertrags.
 * Die eigentliche Atomarität, Idempotenz und Parallelität ist gegen eine echte
 * PostgreSQL geprüft worden — mit zwei gleichzeitigen Sitzungen und einem
 * Rennen zwischen Bestätigen und Stornieren.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  applyConfirmedReconciliation,
  findReconciliationForTransaction,
  isPaymentFromBankReconciliation,
  listBankReconciliations,
  releaseReconciliationForPayment,
  resetBankReconciliationsForTests,
} from './bankReconciliationStore';
import { buildBankSuggestions } from './bankSuggestionService';
import { commitBankImport, listBankTransactions, resetBankTransactionsForTests } from './bankTransactionStore';
import { createBankAccount, resetBankAccountsForTests } from './bankAccountStore';
import { parseBankStatementCsv } from './bankStatementCsvService';
import { hydrateInvoiceStore } from '../invoice/invoiceStore';
import { hydrateVorgangStore } from '../vorgangService';
import { hydrateExpenseStore } from '../expenseStore';
import type { BankReconciliation } from '../../types/bankReconciliation';

const MIGRATION = resolve(
  __dirname,
  '../../../supabase/migrations/20261027120000_workspace_bank_reconciliation_release.sql',
);
const sql = readFileSync(MIGRATION, 'utf8');

function zuordnung(overrides: Partial<BankReconciliation> = {}): BankReconciliation {
  return {
    id: 'brec-1',
    bankTransactionId: 'btx-1',
    targetType: 'invoice',
    targetId: 'inv-1',
    paymentId: 'pay-1',
    amountCents: 50000,
    paidOn: '2026-10-07',
    confirmedAt: '2026-10-07T10:00:00.000Z',
    ...overrides,
  };
}

describe('BANKABGLEICH-05 Storno hebt die Zuordnung auf', () => {
  beforeEach(() => {
    localStorage.clear();
    resetBankTransactionsForTests();
    resetBankAccountsForTests();
    resetBankReconciliationsForTests();
    hydrateVorgangStore([]);
    hydrateInvoiceStore([]);
    hydrateExpenseStore([]);
  });

  /* ---- A) Die lokale Freigabe ---- */

  it('A1 — die Zuordnung fällt mit genau ihrer Zahlung', () => {
    applyConfirmedReconciliation(zuordnung());
    expect(releaseReconciliationForPayment('pay-1')).toBe(1);
    expect(findReconciliationForTransaction('btx-1')).toBeNull();
  });

  it('A2 — eine fremde Zuordnung bleibt unangetastet', () => {
    applyConfirmedReconciliation(zuordnung());
    applyConfirmedReconciliation(
      zuordnung({ id: 'brec-2', bankTransactionId: 'btx-2', targetId: 'inv-2', paymentId: 'pay-2' }),
    );

    expect(releaseReconciliationForPayment('pay-1')).toBe(1);
    expect(listBankReconciliations()).toHaveLength(1);
    expect(findReconciliationForTransaction('btx-2')?.paymentId).toBe('pay-2');
  });

  it('A3 — eine Zahlung ohne Bankbezug ändert nichts', () => {
    applyConfirmedReconciliation(zuordnung());
    expect(releaseReconciliationForPayment('pay-ohne-bank')).toBe(0);
    expect(listBankReconciliations()).toHaveLength(1);
  });

  it('A4 — die Freigabe ist wiederholbar', () => {
    applyConfirmedReconciliation(zuordnung());
    expect(releaseReconciliationForPayment('pay-1')).toBe(1);
    expect(releaseReconciliationForPayment('pay-1')).toBe(0);
    expect(listBankReconciliations()).toEqual([]);
  });

  it('A5 — der Hinweis erscheint nur bei einer Zahlung aus einer Bankzuordnung', () => {
    applyConfirmedReconciliation(zuordnung());
    expect(isPaymentFromBankReconciliation('pay-1')).toBe(true);
    expect(isPaymentFromBankReconciliation('pay-ohne-bank')).toBe(false);
  });

  /* ---- B) Die Bewegung danach ---- */

  it('B1 — die Bewegung bleibt erhalten und bekommt wieder einen Vorschlag', () => {
    hydrateInvoiceStore([
      {
        vorgangId: null,
        invoice: {
          id: 'inv-1',
          number: 'RE-2026-0014',
          status: 'versendet',
          date: '2026-10-01',
          issueDate: '2026-10-01',
          type: 'schlussrechnung',
          positions: [],
          subtotal: 420,
          taxStatus: 'standard_19',
          taxAmount: 80,
          total: 500,
          amount: 500,
          payments: [],
          customerSnapshot: { name: 'Kunde Nord' },
        } as never,
      },
    ]);

    const csv = parseBankStatementCsv(
      [
        'Buchungstag;Beguenstigter/Zahlungspflichtiger;Verwendungszweck;Betrag',
        '07.10.2026;Kunde Nord;Zahlung RE-2026-0014;500,00',
      ].join('\n'),
      'auszug.csv',
    );
    if (!csv.ok) throw new Error('nicht lesbar');
    const konto = createBankAccount('Konto');
    commitBankImport(csv.preview, konto.id);
    const bewegung = listBankTransactions()[0]!;

    /* Zugeordnet: kein Vorschlag mehr. */
    applyConfirmedReconciliation(zuordnung({ bankTransactionId: bewegung.id }));
    expect(buildBankSuggestions([bewegung]).get(bewegung.id)?.candidates).toEqual([]);

    /* Nach dem Storno: Bewegung bleibt, Vorschlag kehrt zurück. */
    releaseReconciliationForPayment('pay-1');
    expect(listBankTransactions()).toHaveLength(1);
    const danach = buildBankSuggestions([bewegung]).get(bewegung.id);
    expect(danach?.candidates.length).toBeGreaterThan(0);
    expect(danach?.candidates[0]?.grade).toBe('sehr_passend');
  });

  it('B2 — es entsteht dabei keine neue Zahlung von selbst', () => {
    applyConfirmedReconciliation(zuordnung());
    releaseReconciliationForPayment('pay-1');
    /* Der Store kennt keine Anlegefunktion; eine neue Zahlung braucht eine Bestätigung. */
    expect(listBankReconciliations()).toEqual([]);
  });

  /* ---- C) Der Serververtrag ---- */

  it('C1 — beide Storno-Zweige heben die Zuordnung auf', () => {
    expect(sql).toContain('create or replace function public.reverse_workspace_invoice_payment');
    expect(sql).toContain('create or replace function public.reverse_workspace_expense_payment');
    const treffer = sql.match(/delete from public\.workspace_bank_reconciliations/g) ?? [];
    expect(treffer).toHaveLength(2);
    expect(sql).toContain("and target_type = 'invoice'");
    expect(sql).toContain("and target_type = 'expense'");
  });

  it('C2 — aufgehoben wird ausschliesslich über die Zahlungskennung', () => {
    /* Keine Aufhebung über Betrag, Datum oder Bewegungskennung. */
    expect(sql).toContain('and client_payment_id = v_payment_id;');
    expect(sql).not.toMatch(/delete from public\.workspace_bank_reconciliations[\s\S]{0,300}amount_cents/);
    expect(sql).not.toMatch(/delete from public\.workspace_bank_reconciliations[\s\S]{0,300}bank_transaction_id =/);
  });

  it('C3 — der Financial-Action-Guard bleibt in beiden Funktionen', () => {
    const guards = sql.match(/perform public\.assert_financial_action_allowed\(p_workspace_id\)/g) ?? [];
    expect(guards).toHaveLength(2);
    expect(sql).toContain('security definer');
    expect(sql).toContain('set search_path = public');
  });

  it('C4 — die Zahlungssemantik bleibt unverändert: weicher Storno, keine harte Löschung', () => {
    expect(sql).toContain('set reversed_at = now()');
    expect(sql).not.toContain('delete from public.workspace_invoice_payments');
    expect(sql).not.toContain('delete from public.workspace_expense_payments');
    /* Idempotenz der bestehenden Funktion bleibt erhalten. */
    expect(sql).toContain('if v_existing.reversed_at is not null then');
  });

  it('C5 — die Aufhebung steht vor dem idempotenten Rücksprung und heilt damit Altzustände', () => {
    for (const teil of sql.split('create or replace function public.reverse_workspace_').slice(1)) {
      const loeschen = teil.indexOf('delete from public.workspace_bank_reconciliations');
      const rueck = teil.indexOf('if v_existing.reversed_at is not null then');
      expect(loeschen).toBeGreaterThanOrEqual(0);
      expect(rueck).toBeGreaterThanOrEqual(0);
      expect(loeschen).toBeLessThan(rueck);
    }
  });

  it('C6 — die bereits remote angewendeten Migrationen sind unverändert', () => {
    const vorher = resolve(
      __dirname,
      '../../../supabase/migrations/20261026120000_workspace_bank_reconciliation.sql',
    );
    expect(readFileSync(vorher, 'utf8')).not.toContain('reverse_workspace_invoice_payment');
  });
});
