/**
 * FINANZ-CORE-01A — ZAH-Reste (Paket A).
 *
 *  Z6   „Zahlung prüfen": nach dem Erledigen keine neue Aufgabe für dieselbe Fälligkeit; nach einer
 *       Rücknahme (newEpisode) wieder; eine neue Fälligkeit ist eine neue Episode
 *  Z7   Kontoauszug: TT.MM.JJ, Vorspannzeilen vor der Kopfzeile, Soll/Haben-Kennzeichen
 *  Z9   der Skontohinweis kommt nur aus dem Skontotext der Rechnung, nicht aus dem Vertrag
 *  Z10  Hinweis vor der Freigabe, wenn die Fälligkeit schon vorbei ist
 *  Z14  eine bestätigte Bankzahlung an einer Rechnung ohne Auftrag wird lokal übernommen
 *  Z17  ein gescheiterter Zahlungsabzug steht im Sync-Bericht
 *  Z19  „Rechnung storniert" ist endgültig; ein Storno mit erfasster Zahlung wird vorher abgewiesen
 *
 * Synthetische Daten, kein Netz.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createOrderPosition, createTestVorgang, testSetup } from '../../test/fixtures';
import { resetTestStores } from '../../test/resetStores';
import type { InvoicePayment, VorgangInvoice } from '../../types/models';
import { hydrateVorgangStore, getVorgangInvoice } from '../vorgangService';
import { hydrateInvoiceStore } from './invoiceStore';
import { setTaskStoreForTests, getAllTasksFromStore } from '../taskStore';
import { completeTask } from '../taskEngineService';
import { isTaskOpen } from '../taskNormalize';
import { reconcileInvoicePaymentTasks } from './invoicePaymentTaskSync';
import { parseBankStatementCsv } from '../bank/bankStatementCsvService';
import * as contractIntelligence from '../contractIntelligenceService';
import { analyzeInvoiceFinance } from '../brain/financeIntelligenceService';
import { buildInvoiceDraftForType } from '../invoiceService';
import { validateInvoiceDraftForApproval } from '../invoiceValidationService';
import { projectBankReconciliationPayment } from '../bank/bankPaymentProjection';
import { applyInvoicePullAfterVorgangMerge } from './invoiceCloudPullOrchestrator';
import { createEmptySyncSimulationReport } from '../sync/syncSimulationReportService';
import * as paymentCloud from './workspaceInvoicePaymentCloudService';
import { cancelFinalizedInvoice } from './invoiceCancellationService';

const VORGANG = 'v-zah-rest';
const INVOICE = 'inv-zah-rest';

function rechnung(overrides: Partial<VorgangInvoice> = {}): VorgangInvoice {
  return {
    id: INVOICE,
    number: 'RE-2026-0301',
    type: 'rechnung',
    positions: [{ id: 'l1', orderPositionId: 'op1', description: 'Leistung', quantity: 10, unit: 'Stunden', unitPrice: 100, lineTotal: 1000 }],
    subtotal: 1000,
    taxStatus: 'standard_19',
    amount: 1190,
    status: 'versendet',
    date: '2026-06-01',
    createdAt: '2026-06-01T10:00:00.000Z',
    issueDate: '2026-06-01',
    sentAt: '2026-06-01T12:00:00.000Z',
    paymentDueDate: '2026-06-15',
    customerSnapshot: { name: 'Beispiel Kunde', contactPerson: '', street: 'Weg 1', zip: '12345', city: 'Stadt', email: '', phone: '' },
    payments: [],
    ...overrides,
  } as VorgangInvoice;
}

const offeneAufgaben = () =>
  getAllTasksFromStore().filter((task) => task.taskKind === 'payment_overdue' && task.sourceId === INVOICE && isTaskOpen(task));

beforeEach(() => {
  resetTestStores();
  localStorage.clear();
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ZAH-06 — eine erledigte Aufgabe derselben Fälligkeit gilt', () => {
  beforeEach(() => {
    hydrateVorgangStore([createTestVorgang({ id: VORGANG, title: 'Bad Muster', invoices: [rechnung()] })]);
    setTaskStoreForTests([]);
  });

  it('Z6a: nach dem Erledigen kommt sie beim nächsten Abgleich nicht zurück', () => {
    expect(reconcileInvoicePaymentTasks({ today: '2026-09-01' }).created).toHaveLength(1);
    const aufgabe = offeneAufgaben()[0]!;
    expect(completeTask(aufgabe.id)).toBeTruthy();
    expect(reconcileInvoicePaymentTasks({ today: '2026-09-01' }).created).toHaveLength(0);
    expect(reconcileInvoicePaymentTasks({ today: '2026-09-02' }).created).toHaveLength(0);
    expect(offeneAufgaben()).toHaveLength(0);
  });

  it('Z6b: eine Rücknahme auf diesem Gerät beginnt eine neue Episode', () => {
    reconcileInvoicePaymentTasks({ today: '2026-09-01' });
    completeTask(offeneAufgaben()[0]!.id);
    expect(reconcileInvoicePaymentTasks({ invoiceId: INVOICE, today: '2026-09-01', newEpisode: true }).created).toHaveLength(1);
    expect(offeneAufgaben()).toHaveLength(1);
  });

  it('Z6c: eine neue Fälligkeit ist eine neue Episode', () => {
    reconcileInvoicePaymentTasks({ today: '2026-09-01' });
    completeTask(offeneAufgaben()[0]!.id);
    hydrateVorgangStore([
      createTestVorgang({ id: VORGANG, title: 'Bad Muster', invoices: [rechnung({ paymentDueDate: '2026-07-15' })] }),
    ]);
    expect(reconcileInvoicePaymentTasks({ today: '2026-09-01' }).created).toHaveLength(1);
  });
});

describe('ZAH-07 — Kontoauszugsformate', () => {
  it('Z7a: TT.MM.JJ (Sparkasse CSV-CAMT)', () => {
    const r = parseBankStatementCsv(
      ['Auftragskonto;Buchungstag;Valutadatum;Verwendungszweck;Beguenstigter/Zahlungspflichtiger;Betrag', 'DE01;04.10.26;06.10.26;RE-1;Kunde;100,00'].join('\n'),
      'camt.csv',
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.preview.rows[0]?.bookingDate).toBe('2026-10-04');
    expect(r.preview.rows[0]?.valueDate).toBe('2026-10-06');
  });

  it('Z7b: Vorspannzeilen vor der Kopfzeile (ING, DKB)', () => {
    const r = parseBankStatementCsv(
      [
        'Umsatzanzeige;Datei erstellt am: 12.10.2026',
        'Kontoinhaber;Muster GmbH',
        '',
        'Buchungsdatum;Wertstellung;Empfänger;Verwendungszweck;Betrag (€)',
        '04.10.2026;04.10.2026;Kunde Nord;RE-2;250,00',
        '05.10.2026;05.10.2026;Lieferant;Material;-80,50',
      ].join('\n'),
      'ing.csv',
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.preview.rows.map((row) => row.amountCents)).toEqual([25000, -8050]);
    expect(r.preview.issues).toEqual([]);
  });

  it('Z7c: Soll/Haben-Kennzeichen neben einem vorzeichenlosen Umsatz', () => {
    const r = parseBankStatementCsv(
      ['Buchungstag;Umsatz;Soll/Haben;Verwendungszweck', '04.10.2026;100,00;S;Miete', '05.10.2026;200,00;H;RE-3', '06.10.2026;50,00;?;Unklar'].join('\n'),
      'sh.csv',
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.preview.rows.map((row) => row.amountCents)).toEqual([-10000, 20000]);
    // Ein unlesbares Kennzeichen wird nicht geraten: Die Zeile wird gemeldet, nicht übernommen.
    expect(r.preview.issues.map((issue) => issue.problem)).toEqual(['amount_unreadable']);
  });
});

describe('ZAH-09 — eine Skontoquelle', () => {
  it('Z9: ohne Skontotext der Rechnung kein Skontohinweis, auch wenn der Vertrag Skonto nennt', () => {
    vi.spyOn(contractIntelligence, 'getContractSkontoOfferForVorgang').mockReturnValue({
      percent: 2,
      days: 14,
      text: 'Bei Zahlung innerhalb von 14 Tagen gewähren wir 2 % Skonto.',
    });
    hydrateVorgangStore([
      createTestVorgang({
        id: VORGANG,
        invoices: [rechnung({ issueDate: '2026-07-01', date: '2026-07-01', paymentDueDate: '2026-07-31', skontoText: '' })],
      }),
    ]);
    const analysis = analyzeInvoiceFinance(VORGANG, INVOICE, '2026-07-05');
    expect(analysis?.recommendations.some((r) => r.id === 'outgoing_skonto_customer')).toBe(false);
  });
});

describe('ZAH-10 — vergangene Fälligkeit vor der Freigabe', () => {
  it('Z10: Hinweis, kein Stopp', () => {
    hydrateVorgangStore([createTestVorgang({ orderPositions: [createOrderPosition({ id: 'op-test-1', plannedQuantity: 10, unitPrice: 65 })] })]);
    const base = buildInvoiceDraftForType('v-test-1', testSetup, 'rechnung')!;
    const draft = {
      ...base,
      issueDate: '2026-01-05',
      paymentDueDate: '2026-01-19',
      companySnapshot: { ...base.companySnapshot, companyName: 'Muster GmbH', street: 'Weg 5', zip: '30000', city: 'Stadt', taxNumber: '133/8150/8159' },
    };
    const ergebnis = validateInvoiceDraftForApproval(draft, draft.companySnapshot, undefined, { reverseCharge13bConfirmed: true });
    expect(ergebnis.warnings.map((w) => w.code)).toContain('payment_due_past');
    expect(ergebnis.blockingErrors.map((e) => e.code)).not.toContain('payment_due_past');
    const zukunft = { ...draft, paymentDueDate: '2099-01-19' };
    expect(
      validateInvoiceDraftForApproval(zukunft, zukunft.companySnapshot, undefined, {}).warnings.map((w) => w.code),
    ).not.toContain('payment_due_past');
  });
});

describe('ZAH-14 — Bankzahlung an einer Rechnung ohne Auftrag', () => {
  it('Z14: lokal übernommen, das Ergebnis zählt', () => {
    hydrateInvoiceStore([{ invoice: rechnung(), vorgangId: null }]);
    const ergebnis = projectBankReconciliationPayment({
      id: 'brec-1',
      bankTransactionId: 'btx-1',
      targetType: 'invoice',
      targetId: INVOICE,
      paymentId: 'pay-bank-1',
      amountCents: 119000,
      paidOn: '2026-06-10',
      confirmedAt: '2026-06-10T12:00:00.000Z',
    });
    expect(ergebnis).toEqual({ applied: true });
    expect(getVorgangInvoice(null, INVOICE)?.payments?.map((p: InvoicePayment) => p.id)).toEqual(['pay-bank-1']);
    // Ein zweiter Aufruf ändert nichts.
    expect(
      projectBankReconciliationPayment({
        id: 'brec-1',
        bankTransactionId: 'btx-1',
        targetType: 'invoice',
        targetId: INVOICE,
        paymentId: 'pay-bank-1',
        amountCents: 119000,
        paidOn: '2026-06-10',
        confirmedAt: '2026-06-10T12:00:00.000Z',
      }).applied,
    ).toBe(false);
  });
});

describe('ZAH-17 — Zahlungsabzug im Sync-Bericht', () => {
  it('Z17: ein gescheiterter Zahlungsabzug wird gemeldet; die Rechnungen bleiben', async () => {
    const client = {
      rpc: vi.fn(async (name: string) =>
        name === 'pull_workspace_invoices'
          ? { data: [], error: null }
          : { data: null, error: { message: 'Zahlungsabzug gescheitert' } },
      ),
    } as unknown as SupabaseClient;
    const report = createEmptySyncSimulationReport('2026-10-12T10:00:00.000Z');
    const r = await applyInvoicePullAfterVorgangMerge({
      workspaceId: '00000000-0000-4000-8000-0000000fc0b2',
      vorgaenge: [],
      report,
      client,
    });
    expect(r.invoiceRpcFailed).toBe(false);
    expect(report.errors).toEqual([{ outboxId: 'invoice-payment-pull', message: 'Zahlungsabzug gescheitert' }]);
    expect(report.errorCount).toBe(1);
  });
});

describe('ZAH-19 — Zahlung an einer inzwischen stornierten Rechnung', () => {
  it('Z19a: „Rechnung storniert" ist endgültig — kein „bitte erneut versuchen"', async () => {
    const client = {
      rpc: vi.fn(async () => ({ data: null, error: { message: 'Rechnung storniert' } })),
    } as unknown as SupabaseClient;
    const r = await paymentCloud.addInvoicePaymentToCloud(
      { clientInvoiceId: INVOICE, clientPaymentId: 'pay-1', amount: 100, paidOn: '2026-06-10' },
      { client, workspaceId: '00000000-0000-4000-8000-0000000fc0b3' },
    );
    expect(r.outcome).toBe('invoice_cancelled');
    expect(paymentCloud.isInvoicePaymentCloudSilent('invoice_cancelled')).toBe(false);
  });

  it('Z19b: ein Storno mit erfasster Zahlung wird vor dem Server abgewiesen', async () => {
    hydrateVorgangStore([
      createTestVorgang({ id: VORGANG, invoices: [rechnung({ status: 'vorbereitet', payments: [{ id: 'pay-1', amount: 100, date: '2026-06-10', createdAt: '2026-06-10T10:00:00.000Z' }] })] }),
    ]);
    const r = await cancelFinalizedInvoice({ vorgangId: VORGANG, invoiceId: INVOICE, reason: 'Fehler', actor: { userId: null, cloudConfigured: false } });
    expect(r).toEqual({ ok: false, reason: 'has_active_payments' });
  });
});
