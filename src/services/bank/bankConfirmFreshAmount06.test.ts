/**
 * WEISS-NACHARBEIT O1/O2 — die Bestätigungsgrundlage ist aktuell.
 *
 * O1: Der Dialog zeigte den offenen Betrag aus dem Augenblick, in dem die
 * Vorschläge berechnet wurden. Nach einer ersten Bankzuordnung stand dort
 * weiter der alte Rest, und eine Zahlung, die ihn vollständig deckte, hiess
 * „Teilzahlung". Gebucht wurde trotzdem richtig — falsch war nur, was der
 * Nutzer vor seiner Entscheidung las.
 *
 * O2: Die Startseite nannte offene Übergabeschritte „Belege".
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { planBankConfirmation } from './bankReconciliationService';
import { projectBankReconciliationPayment } from './bankPaymentProjection';
import { buildBankSuggestions } from './bankSuggestionService';
import { resetBankReconciliationsForTests } from './bankReconciliationStore';
import { hydrateExpenseStore, getExpenseFromStoreById } from '../expenseStore';
import { hydrateVorgangStore } from '../vorgangService';
import { hydrateInvoiceStore } from '../invoice/invoiceStore';
import type { Expense } from '../../types/expense';
import type { BankSuggestionCandidate } from '../../types/bankSuggestion';
import type { BankTransaction } from '../../types/bankTransaction';
import type { BankReconciliation } from '../../types/bankReconciliation';

/** 11,90 € brutto, davon 7,90 € bereits bezahlt — der WEISS-Aufbau. */
function ausgabe(overrides: Partial<Expense> = {}): Expense {
  return {
    id: 'exp-o1',
    status: 'gebucht',
    category: 'material',
    supplierName: 'AZ Testbau GmbH',
    invoiceNumber: 'L-O1',
    title: 'Material',
    description: '',
    issueDate: '2026-10-01',
    paymentDueDate: null,
    taxStatus: 'standard_19',
    netAmount: 10,
    taxAmount: 1.9,
    grossAmount: 11.9,
    currency: 'EUR',
    paymentStatus: 'teilbezahlt',
    payments: [{ id: 'pay-alt', date: '2026-10-01', amount: 7.9, method: 'cash', createdAt: 'x' }],
    positions: [],
    allocations: [],
    isCreditNote: false,
    dedupeKey: 'az|l-o1',
    tags: [],
    digitalFolder: { id: 'dig', name: 'Ausgaben', path: '/Ausgaben/' },
    paperFolder: { folderId: 'f', register: 'A', label: 'x' },
    createdAt: '2026-10-01T08:00:00.000Z',
    updatedAt: '2026-10-01T08:00:00.000Z',
    ...overrides,
  };
}

function bewegung(id: string, cents: number): BankTransaction {
  return {
    id,
    accountKey: 'bacc-1',
    importId: 'imp-1',
    fileName: 'a.csv',
    importedAt: '2026-10-05T08:00:00.000Z',
    bookingDate: '2026-10-05',
    amountCents: cents,
    currency: 'EUR',
    counterparty: 'AZ Testbau GmbH',
    purpose: 'Zahlung L-O1',
    fingerprint: `f-${id}`,
    occurrence: 1,
  } as BankTransaction;
}

/** Ein Kandidat mit absichtlich **veraltetem** offenem Betrag (400 Cent). */
function veralteterKandidat(openCents = 400): BankSuggestionCandidate {
  return {
    targetType: 'expense',
    targetId: 'exp-o1',
    documentNumber: 'L-O1',
    partyName: 'AZ Testbau GmbH',
    openCents,
    grade: 'sehr_passend',
    reasons: [],
  } as BankSuggestionCandidate;
}

function zuordnung(paymentId: string, cents: number): BankReconciliation {
  return {
    id: `brec-${paymentId}`,
    bankTransactionId: `btx-${paymentId}`,
    targetType: 'expense',
    targetId: 'exp-o1',
    paymentId,
    amountCents: cents,
    paidOn: '2026-10-05',
    confirmedAt: '2026-10-05T09:00:00.000Z',
  };
}

describe('O1 — die Bestätigung rechnet mit dem aktuellen Rest', () => {
  beforeEach(() => {
    localStorage.clear();
    resetBankReconciliationsForTests();
    hydrateVorgangStore([]);
    hydrateInvoiceStore([]);
    hydrateExpenseStore([ausgabe()]);
  });

  it('A1 — Ausgangslage: 11,90 € gesamt, 7,90 € bezahlt, 4,00 € offen', () => {
    const plan = planBankConfirmation(bewegung('btx-1', -200), veralteterKandidat());
    expect(plan.openCents).toBe(400);
    expect(plan.amountCents).toBe(200);
    expect(plan.partial).toBe(true);
    expect(plan.refusal).toBeNull();
  });

  it('A2 — die erste Teilzahlung verändert den Restbetrag', () => {
    projectBankReconciliationPayment(zuordnung('pay-1', 200));
    const expense = getExpenseFromStoreById('exp-o1')!;
    expect((expense.payments ?? []).map((p) => p.id)).toContain('pay-1');
    expect(expense.paymentStatus).toBe('teilbezahlt');
  });

  it('A3 — die zweite Zuordnung nutzt den aktualisierten Rest, nicht den Schnappschuss', () => {
    projectBankReconciliationPayment(zuordnung('pay-1', 200));
    /* Derselbe veraltete Kandidat wie zuvor — 400 Cent. */
    const plan = planBankConfirmation(bewegung('btx-2', -200), veralteterKandidat(400));
    expect(plan.openCents).toBe(200);
  });

  it('A4 — eine Zahlung in Höhe des aktuellen Restes ist keine Teilzahlung', () => {
    projectBankReconciliationPayment(zuordnung('pay-1', 200));
    const plan = planBankConfirmation(bewegung('btx-2', -200), veralteterKandidat(400));
    expect(plan.partial).toBe(false);
    expect(plan.refusal).toBeNull();
  });

  it('A5 — kleiner als der aktuelle Rest bleibt Teilzahlung', () => {
    const plan = planBankConfirmation(bewegung('btx-2', -150), veralteterKandidat(400));
    expect(plan.openCents).toBe(400);
    expect(plan.partial).toBe(true);
  });

  it('A6 — eine bereits voll bezahlte Ausgabe wird nicht mehr angeboten', () => {
    projectBankReconciliationPayment(zuordnung('pay-1', 400));
    const plan = planBankConfirmation(bewegung('btx-2', -200), veralteterKandidat(400));
    expect(plan.openCents).toBe(0);
    expect(plan.refusal).toBe('nothing_open');
  });

  it('A7 — keine Überzahlung durch einen veralteten Zustand', () => {
    projectBankReconciliationPayment(zuordnung('pay-1', 200));
    /* 3,00 € gegen einen tatsächlichen Rest von 2,00 €. */
    const plan = planBankConfirmation(bewegung('btx-2', -300), veralteterKandidat(400));
    expect(plan.openCents).toBe(200);
    expect(plan.refusal).toBe('amount_exceeds_open');
  });

  it('A8 — ohne auffindbares Ziel bleibt der Wert aus dem Vorschlag stehen', () => {
    hydrateExpenseStore([]);
    const plan = planBankConfirmation(bewegung('btx-2', -200), veralteterKandidat(400));
    expect(plan.openCents).toBe(400);
  });

  it('A9 — auch der Vorschlagsdienst sieht den neuen Stand', () => {
    projectBankReconciliationPayment(zuordnung('pay-1', 200));
    const ergebnis = buildBankSuggestions([bewegung('btx-2', -200)]).get('btx-2');
    const kandidat = ergebnis?.candidates.find((c) => c.targetId === 'exp-o1');
    expect(kandidat?.openCents).toBe(200);
  });
});

describe('O1 — die Projektion erfindet nichts', () => {
  beforeEach(() => {
    localStorage.clear();
    resetBankReconciliationsForTests();
    hydrateVorgangStore([]);
    hydrateInvoiceStore([]);
    hydrateExpenseStore([ausgabe()]);
  });

  it('B1 — übernommen werden genau die vier Angaben des Servers', () => {
    projectBankReconciliationPayment(zuordnung('pay-1', 200));
    const payment = (getExpenseFromStoreById('exp-o1')?.payments ?? []).find((p) => p.id === 'pay-1');
    expect(payment).toMatchObject({ id: 'pay-1', date: '2026-10-05', amount: 2, method: 'bank' });
  });

  it('B2 — zweimal dieselbe Zuordnung ändert nichts', () => {
    expect(projectBankReconciliationPayment(zuordnung('pay-1', 200)).applied).toBe(true);
    const zweiter = projectBankReconciliationPayment(zuordnung('pay-1', 200));
    expect(zweiter.applied).toBe(false);
    expect(zweiter.reason).toBe('already_present');
    expect(getExpenseFromStoreById('exp-o1')?.payments).toHaveLength(2);
  });

  it('B3 — ein unbekanntes Ziel wird gemeldet, nicht erfunden', () => {
    const ergebnis = projectBankReconciliationPayment({ ...zuordnung('pay-x', 200), targetId: 'exp-gibtsnicht' });
    expect(ergebnis.applied).toBe(false);
    expect(ergebnis.reason).toBe('target_missing');
  });

  it('B4 — die bestehende Zahlung bleibt unangetastet', () => {
    projectBankReconciliationPayment(zuordnung('pay-1', 200));
    const alt = (getExpenseFromStoreById('exp-o1')?.payments ?? []).find((p) => p.id === 'pay-alt');
    expect(alt).toMatchObject({ amount: 7.9, method: 'cash' });
  });

  it('B5 — der Zahlungsdienst wird nicht importiert: die Geldwirkung bleibt serverseitig', async () => {
    const quelle = await import('node:fs').then((fs) =>
      fs.readFileSync('src/services/bank/bankReconciliationService.ts', 'utf8'),
    );
    for (const verboten of ['recordPayment', 'recordExpensePayment', 'expensePaymentService']) {
      expect(quelle, `darf nicht vorkommen: ${verboten}`).not.toContain(verboten);
    }
  });
});

describe('O2 — die Startseite nennt Schritte, nicht Belege', () => {
  it('C1 — der Text zur offenen Monatsmappe spricht nicht von Belegen', async () => {
    const quelle = await import('node:fs').then((fs) => fs.readFileSync('src/i18n/index.ts', 'utf8'));
    const zeile = quelle
      .split('\n')
      .find((l) => l.includes("'heute.pilot.folderOpenOne'"));
    expect(zeile).toBeDefined();
    expect(zeile).not.toMatch(/Beleg/);
    expect(zeile).toMatch(/Schritt/);
  });

  it('C2 — dieselbe Aussage in der Mehrzahl', async () => {
    const quelle = await import('node:fs').then((fs) => fs.readFileSync('src/i18n/index.ts', 'utf8'));
    const zeile = quelle.split('\n').find((l) => l.includes("'heute.pilot.folderOpen'"));
    expect(zeile).not.toMatch(/Belege/);
    expect(zeile).toMatch(/Schritte/);
  });

  it('C3 — Heute und Steuerberater lesen dieselbe Quelle', async () => {
    const quelle = await import('node:fs').then((fs) =>
      fs.readFileSync('src/components/home/HomeMonatsmappe.tsx', 'utf8'),
    );
    /* Keine zweite Zählung: dieselbe Funktion wie die Steuerberater-Seite. */
    expect(quelle).toContain('getSteuerberaterMonthOverview');
    expect(quelle).not.toMatch(/buildMonatsmappeModel|documentCount\s*\+/);
  });
});
