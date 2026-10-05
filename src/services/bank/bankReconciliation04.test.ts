/**
 * BANKABGLEICH-V1 BLOCK 4 — die Prüfung vor der Bestätigung.
 *
 * Diese Datei prüft die **Client-Seite**: was die Oberfläche überhaupt
 * anbieten darf. Die eigentliche Entscheidung — offener Betrag, Richtung,
 * Doppelzuordnung, Parallelität — fällt serverseitig in
 * `confirm_workspace_bank_reconciliation` und ist dort gegen eine echte
 * PostgreSQL geprüft worden; diese Tests ersetzen das nicht, sie ergänzen es.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { planBankConfirmation } from './bankReconciliationService';
import {
  applyConfirmedReconciliation,
  findReconciliationForTransaction,
  getBankReconciliationStoreSnapshot,
  hydrateBankReconciliations,
  listBankReconciliations,
  resetBankReconciliationsForTests,
} from './bankReconciliationStore';
import { buildBankSuggestions } from './bankSuggestionService';
import { resetBankTransactionsForTests } from './bankTransactionStore';
import { resetBankAccountsForTests } from './bankAccountStore';
import { hydrateInvoiceStore } from '../invoice/invoiceStore';
import { hydrateVorgangStore } from '../vorgangService';
import { hydrateExpenseStore } from '../expenseStore';
import type { BankSuggestionCandidate } from '../../types/bankSuggestion';
import type { BankTransaction } from '../../types/bankTransaction';
import type { BankReconciliation } from '../../types/bankReconciliation';

function bewegung(overrides: Partial<BankTransaction> = {}): BankTransaction {
  return {
    id: 'btx-1',
    accountKey: 'bacc-1',
    importId: 'i1',
    fileName: 'a.csv',
    importedAt: '2026-10-06T10:00:00.000Z',
    bookingDate: '2026-10-06',
    valueDate: '2026-10-08',
    amountCents: 50000,
    counterparty: 'Kunde Nord',
    purpose: 'Zahlung RE-1',
    fingerprint: 'f1',
    occurrence: 1,
    ...overrides,
  };
}

function kandidat(overrides: Partial<BankSuggestionCandidate> = {}): BankSuggestionCandidate {
  return {
    targetType: 'invoice',
    targetId: 'inv-1',
    documentNumber: 'RE-1',
    partyName: 'Kunde Nord',
    openCents: 50000,
    grade: 'sehr_passend',
    reasons: ['invoice_number_in_purpose', 'amount_matches_open'],
    ...overrides,
  };
}

function zuordnung(overrides: Partial<BankReconciliation> = {}): BankReconciliation {
  return {
    id: 'brec-1',
    bankTransactionId: 'btx-1',
    targetType: 'invoice',
    targetId: 'inv-1',
    paymentId: 'pay-1',
    amountCents: 50000,
    paidOn: '2026-10-06',
    confirmedAt: '2026-10-06T11:00:00.000Z',
    ...overrides,
  };
}

describe('BANKABGLEICH-04 Bestätigung', () => {
  beforeEach(() => {
    localStorage.clear();
    resetBankTransactionsForTests();
    resetBankAccountsForTests();
    resetBankReconciliationsForTests();
    hydrateVorgangStore([]);
    hydrateInvoiceStore([]);
    hydrateExpenseStore([]);
  });

  /* ---- A) Was angeboten werden darf ---- */

  it('A1 — exakter Treffer darf bestätigt werden', () => {
    const plan = planBankConfirmation(bewegung(), kandidat());
    expect(plan.refusal).toBeNull();
    expect(plan.amountCents).toBe(50000);
    expect(plan.partial).toBe(false);
  });

  it('A2 — das Zahlungsdatum ist der Buchungstag, nicht die Wertstellung und nicht heute', () => {
    const plan = planBankConfirmation(bewegung(), kandidat());
    expect(plan.paidOn).toBe('2026-10-06');
    expect(plan.paidOn).not.toBe('2026-10-08');
  });

  it('A3 — eine Teilzahlung ist erlaubt und wird benannt', () => {
    const plan = planBankConfirmation(bewegung({ amountCents: 20000 }), kandidat());
    expect(plan.refusal).toBeNull();
    expect(plan.partial).toBe(true);
    expect(plan.amountCents).toBe(20000);
  });

  it('A4 — Überzahlung wird blockiert, nicht gekürzt', () => {
    const plan = planBankConfirmation(bewegung({ amountCents: 90000 }), kandidat());
    expect(plan.refusal).toBe('amount_exceeds_open');
    /* Der Betrag bleibt der der Bank — es wird nichts abgeschnitten. */
    expect(plan.amountCents).toBe(90000);
  });

  it('A5 — eine falsche Richtung wird abgelehnt', () => {
    expect(planBankConfirmation(bewegung({ amountCents: -50000 }), kandidat()).refusal).toBe(
      'wrong_direction',
    );
    expect(
      planBankConfirmation(bewegung(), kandidat({ targetType: 'expense', targetId: 'exp-1' })).refusal,
    ).toBe('wrong_direction');
  });

  it('A6 — ein Ausgang auf eine Ausgabe ist richtig herum', () => {
    const plan = planBankConfirmation(
      bewegung({ amountCents: -20000 }),
      kandidat({ targetType: 'expense', targetId: 'exp-1', openCents: 20000 }),
    );
    expect(plan.refusal).toBeNull();
    expect(plan.amountCents).toBe(20000);
  });

  it('A7 — ohne offenen Betrag gibt es nichts zu bestätigen', () => {
    expect(planBankConfirmation(bewegung(), kandidat({ openCents: 0 })).refusal).toBe('nothing_open');
  });

  it('A8 — eine bereits zugeordnete Bewegung wird nicht erneut angeboten', () => {
    applyConfirmedReconciliation(zuordnung());
    expect(planBankConfirmation(bewegung(), kandidat()).refusal).toBe('already_reconciled');
  });

  /* ---- B) Der Bestand ---- */

  it('B1 — eine Zuordnung ist je Bankbewegung eindeutig', () => {
    applyConfirmedReconciliation(zuordnung());
    applyConfirmedReconciliation(zuordnung({ id: 'brec-2', paymentId: 'pay-2' }));
    expect(listBankReconciliations()).toHaveLength(1);
    expect(findReconciliationForTransaction('btx-1')?.paymentId).toBe('pay-2');
  });

  it('B2 — der Bestand überlebt das Neuladen des Zustands', () => {
    applyConfirmedReconciliation(zuordnung());
    const schnappschuss = getBankReconciliationStoreSnapshot();
    resetBankReconciliationsForTests();
    expect(listBankReconciliations()).toHaveLength(0);
    hydrateBankReconciliations(schnappschuss);
    expect(findReconciliationForTransaction('btx-1')).toMatchObject({ paymentId: 'pay-1' });
  });

  it('B3 — die Zuordnung trägt die strukturierte Verbindung, nicht nur einen Text', () => {
    applyConfirmedReconciliation(zuordnung());
    const eintrag = findReconciliationForTransaction('btx-1')!;
    expect(eintrag.bankTransactionId).toBe('btx-1');
    expect(eintrag.targetType).toBe('invoice');
    expect(eintrag.targetId).toBe('inv-1');
    expect(eintrag.paymentId).toBe('pay-1');
  });

  /* ---- C) Keine zweite Zuordnung ---- */

  it('C1 — eine zugeordnete Bewegung bekommt keine neuen Vorschläge mehr', () => {
    hydrateInvoiceStore([
      {
        vorgangId: null,
        invoice: {
          id: 'inv-1',
          number: 'RE-1',
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
    const t = bewegung();

    /* Vorher gibt es einen Vorschlag … */
    expect(buildBankSuggestions([t]).get(t.id)?.candidates.length).toBeGreaterThan(0);

    applyConfirmedReconciliation(zuordnung());

    /* … danach keinen mehr. */
    expect(buildBankSuggestions([t]).get(t.id)?.candidates).toEqual([]);
  });

  /* ---- D) Keine Geldwirkung ohne Bestätigung ---- */

  it('D1 — die Planung allein ruft keine Zahlungsfunktion auf und speichert nichts', async () => {
    const invoicePayments = await import('../invoicePaymentService');
    const expensePayments = await import('../expensePaymentService');
    const recordPayment = vi.spyOn(invoicePayments, 'recordPayment');
    const recordExpensePayment = vi.spyOn(expensePayments, 'recordExpensePayment');

    planBankConfirmation(bewegung(), kandidat());
    planBankConfirmation(bewegung({ amountCents: 20000 }), kandidat());

    expect(recordPayment).not.toHaveBeenCalled();
    expect(recordExpensePayment).not.toHaveBeenCalled();
    expect(listBankReconciliations()).toEqual([]);
    vi.restoreAllMocks();
  });

  it('D2 — der Client bucht nicht selbst: keine lokale Zahlungsfunktion im Dienst', async () => {
    /*
     * Der Beleg dafür, dass die Geldwirkung ausschliesslich serverseitig
     * entsteht: Der Dienst importiert keinen Zahlungsdienst.
     */
    const quelle = await import('node:fs').then((fs) =>
      fs.readFileSync('src/services/bank/bankReconciliationService.ts', 'utf8'),
    );
    for (const verboten of [
      'invoicePaymentService',
      'expensePaymentService',
      'recordPayment',
      'recordExpensePayment',
    ]) {
      expect(quelle, `darf nicht vorkommen: ${verboten}`).not.toContain(verboten);
    }
    /* Stattdessen genau eine serverseitige Aktion. */
    expect(quelle).toContain('confirm_workspace_bank_reconciliation');
  });
});
