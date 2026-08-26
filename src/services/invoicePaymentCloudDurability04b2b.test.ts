/**
 * OFFICEPILOT-PAYMENT-CLOUD-DURABILITY-04B2B — Geld überlebt den Browser.
 *
 * Zahlungen lebten bisher ausschließlich im lokalen Speicher einer Origin. Auf
 * einer frischen Adresse kamen Rechnung und Versandstatus aus Supabase zurück,
 * die Zahlung fehlte — bezahlt 0,00 €, offen der volle Betrag.
 *
 * Anders als beim Versandstatus ist hier nichts monoton: Zwei Geräte erfassen
 * unabhängig, dieselbe Zahlung darf nie doppelt entstehen, und eine gelöschte
 * Zahlung muss als Grabstein reisen — sonst belebt ein Gerät mit alter Kopie
 * sie wieder.
 *
 * Geprüft wird der Vertrag, nicht der Transport: Der Supabase-Client wird
 * ersetzt. Neutrale Beispieldaten, kein Netzwerk.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetTestStores } from '../test/resetStores';
import { createOrderPosition, createTestVorgang } from '../test/fixtures';
import {
  addInvoicePaymentToCloud,
  isInvoicePaymentCloudSilent,
  parseWorkspaceInvoicePaymentRow,
  pullInvoicePaymentsFromCloud,
  reverseInvoicePaymentInCloud,
} from './invoice/workspaceInvoicePaymentCloudService';
import {
  calculatePaymentSummary,
  findLocallyOnlyPayments,
  isInvoicePaymentCloudSynced,
  recordPayment,
  syncInvoicePaymentToCloud,
} from './invoicePaymentService';
import {
  getVorgangInvoice,
  hydrateVorgangStore,
  mergeCloudPaymentsIntoInvoice,
  type CloudInvoicePaymentEntry,
} from './vorgangService';
import * as supabaseLib from '../lib/supabase';
import type { InvoicePayment, Vorgang, VorgangInvoice } from '../types/models';

const WORKSPACE = '00000000-0000-4000-8000-00000000b2b0';
const VORGANG_ID = 'v-pay-cloud';
const INVOICE_ID = 'inv-pay-cloud';
const LEGACY_ID = 'pay-123456789';

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

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

function stored(): VorgangInvoice {
  return getVorgangInvoice(VORGANG_ID, INVOICE_ID)!;
}

/** Eine Cloud-Zeile, wie `pull_workspace_invoice_payments` sie liefert. */
function cloudRow(options: {
  paymentId: string;
  amount: number;
  paidOn: string;
  reference?: string | null;
  note?: string | null;
  reversedAt?: string | null;
  invoiceId?: string;
}): Record<string, unknown> {
  return {
    id: `row-${options.paymentId}`,
    workspace_id: WORKSPACE,
    client_invoice_id: options.invoiceId ?? INVOICE_ID,
    client_payment_id: options.paymentId,
    amount: options.amount,
    paid_on: options.paidOn,
    reference: options.reference ?? null,
    note: options.note ?? null,
    created_at: '2026-08-25T10:00:00.000Z',
    updated_at: '2026-08-25T10:00:00.000Z',
    row_version: 1,
    reversed_at: options.reversedAt ?? null,
  };
}

function stubRpc(handler: (name: string, args: Record<string, unknown>) => unknown) {
  return {
    rpc: vi.fn(async (name: string, args: Record<string, unknown>) => ({
      data: handler(name, args),
      error: null,
    })),
  } as never;
}

function stubRpcError(message: string) {
  return {
    rpc: vi.fn(async () => ({ data: null, error: { message } })),
  } as never;
}

const override = { workspaceId: WORKSPACE };

function withClient(client: unknown) {
  return { ...override, client: client as never };
}

/** Cloud-Entry aus einer Zeile — wie der Merge sie erhält. */
function entry(row: Record<string, unknown>): CloudInvoicePaymentEntry {
  const parsed = parseWorkspaceInvoicePaymentRow(row)!;
  return {
    clientInvoiceId: parsed.clientInvoiceId,
    clientPaymentId: parsed.clientPaymentId,
    amount: parsed.amount,
    paidOn: parsed.paidOn,
    reference: parsed.reference,
    note: parsed.note,
    createdAt: parsed.createdAt,
    reversedAt: parsed.reversedAt,
  };
}

describe('OFFICEPILOT-PAYMENT-CLOUD-DURABILITY-04B2B', () => {
  beforeEach(() => {
    resetTestStores();
    seed();
    vi.spyOn(supabaseLib, 'isSupabaseConfigured').mockReturnValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetTestStores();
  });

  it('A: die erste Zahlung wird als eine Zeile gesichert', async () => {
    let received: Record<string, unknown> | null = null;
    const client = stubRpc((name, args) => {
      expect(name).toBe('add_workspace_invoice_payment');
      received = args;
      return [cloudRow({ paymentId: 'uuid-1', amount: 4000, paidOn: '2026-08-25' })];
    });

    const result = await addInvoicePaymentToCloud(
      { clientInvoiceId: INVOICE_ID, clientPaymentId: 'uuid-1', amount: 4000, paidOn: '2026-08-25' },
      withClient(client),
    );

    expect(result.outcome).toBe('synced');
    expect(received).toEqual({
      p_workspace_id: WORKSPACE,
      p_client_invoice_id: INVOICE_ID,
      p_client_payment_id: 'uuid-1',
      p_amount: 4000,
      p_paid_on: '2026-08-25',
      p_reference: null,
      p_note: null,
    });
  });

  it('B: zwei Teilzahlungen bleiben unabhängig', () => {
    const merged = mergeCloudPaymentsIntoInvoice(stored(), [
      entry(cloudRow({ paymentId: 'uuid-1', amount: 4000, paidOn: '2026-08-25' })),
      entry(cloudRow({ paymentId: 'uuid-2', amount: 1000, paidOn: '2026-08-26' })),
    ]);

    expect(merged.map((payment) => payment.id)).toEqual(['uuid-1', 'uuid-2']);
    expect(merged.reduce((sum, payment) => sum + payment.amount, 0)).toBe(5000);
  });

  it('C: derselbe Aufruf zweimal erzeugt keine zweite Zahlung', async () => {
    const client = stubRpc(() => [
      cloudRow({ paymentId: 'uuid-1', amount: 4000, paidOn: '2026-08-25' }),
    ]);
    const input = {
      clientInvoiceId: INVOICE_ID,
      clientPaymentId: 'uuid-1',
      amount: 4000,
      paidOn: '2026-08-25',
    };

    const first = await addInvoicePaymentToCloud(input, withClient(client));
    const second = await addInvoicePaymentToCloud(input, withClient(client));

    expect(first.outcome).toBe('synced');
    expect(second.outcome).toBe('synced');
    if (first.outcome !== 'synced' || second.outcome !== 'synced') return;
    expect(second.row.clientPaymentId).toBe(first.row.clientPaymentId);

    // Und der Merge macht daraus genau eine Zahlung.
    const merged = mergeCloudPaymentsIntoInvoice(stored(), [
      entry(cloudRow({ paymentId: 'uuid-1', amount: 4000, paidOn: '2026-08-25' })),
      entry(cloudRow({ paymentId: 'uuid-1', amount: 4000, paidOn: '2026-08-25' })),
    ]);
    expect(merged).toHaveLength(1);
  });

  it('D: dieselbe Kennung mit anderen Daten ist ein Konflikt, kein stiller Erfolg', async () => {
    const client = stubRpcError('Zahlungskonflikt: dieselbe Kennung mit abweichenden Daten');

    const result = await addInvoicePaymentToCloud(
      { clientInvoiceId: INVOICE_ID, clientPaymentId: 'uuid-1', amount: 9999, paidOn: '2026-08-25' },
      withClient(client),
    );

    expect(result.outcome).toBe('conflict');
    expect(isInvoicePaymentCloudSilent(result.outcome)).toBe(false);
  });

  it('E/F/G: eine frische Origin erhält alle Zahlungen und rechnet richtig', async () => {
    const client = stubRpc(() => [
      cloudRow({ paymentId: 'uuid-1', amount: 4000, paidOn: '2026-08-25' }),
      cloudRow({ paymentId: 'uuid-2', amount: 6000, paidOn: '2026-08-26' }),
    ]);

    const pulled = await pullInvoicePaymentsFromCloud(withClient(client));
    expect(pulled.outcome).toBe('synced');
    if (pulled.outcome !== 'synced') return;

    // Frische Origin: lokal ist nichts vorhanden.
    const merged = mergeCloudPaymentsIntoInvoice(
      stored(),
      pulled.rows.map((row) => ({
        clientInvoiceId: row.clientInvoiceId,
        clientPaymentId: row.clientPaymentId,
        amount: row.amount,
        paidOn: row.paidOn,
        reference: row.reference,
        note: row.note,
        createdAt: row.createdAt,
        reversedAt: row.reversedAt,
      })),
    );

    expect(merged).toHaveLength(2);

    const partial = calculatePaymentSummary({ ...stored(), payments: [merged[0]!] });
    expect(partial.paidAmount).toBe(4000);
    expect(partial.openAmount).toBe(6000);
    expect(partial.status).toBe('teilbezahlt');

    const full = calculatePaymentSummary({ ...stored(), payments: merged });
    expect(full.paidAmount).toBe(10000);
    expect(full.openAmount).toBe(0);
    expect(full.status).toBe('bezahlt');
  });

  it('H: gleicher Betrag am gleichen Tag bleibt zwei Zahlungen', () => {
    const merged = mergeCloudPaymentsIntoInvoice(stored(), [
      entry(cloudRow({ paymentId: 'uuid-1', amount: 5000, paidOn: '2026-08-25' })),
      entry(cloudRow({ paymentId: 'uuid-2', amount: 5000, paidOn: '2026-08-25' })),
    ]);

    // Niemals nach Betrag oder Datum deduplizieren.
    expect(merged).toHaveLength(2);
    expect(merged.reduce((sum, payment) => sum + payment.amount, 0)).toBe(10000);
  });

  it('I: ein Reversal lässt die Cloud-Zeile bestehen und zählt lokal nicht mehr', async () => {
    const client = stubRpc(() => [
      cloudRow({
        paymentId: 'uuid-1',
        amount: 4000,
        paidOn: '2026-08-25',
        reversedAt: '2026-08-27T10:00:00.000Z',
      }),
    ]);

    const result = await reverseInvoicePaymentInCloud(
      { clientInvoiceId: INVOICE_ID, clientPaymentId: 'uuid-1' },
      withClient(client),
    );
    expect(result.outcome).toBe('synced');
    if (result.outcome !== 'synced') return;
    // Der Grabstein bleibt — nur so erfährt ein anderes Gerät davon.
    expect(result.row.reversedAt).toBeTruthy();
  });

  it('J: ein Cloud-Grabstein belebt keine lokale Kopie wieder', () => {
    const localPayment: InvoicePayment = {
      id: 'uuid-1',
      date: '2026-08-25',
      amount: 4000,
      createdAt: '2026-08-25T10:00:00.000Z',
    };
    seed(buildInvoice({ payments: [localPayment], paymentStatus: 'teilbezahlt' }));

    const merged = mergeCloudPaymentsIntoInvoice(stored(), [
      entry(
        cloudRow({
          paymentId: 'uuid-1',
          amount: 4000,
          paidOn: '2026-08-25',
          reversedAt: '2026-08-27T10:00:00.000Z',
        }),
      ),
    ]);

    expect(merged).toHaveLength(0);
    expect(calculatePaymentSummary({ ...stored(), payments: merged }).status).toBe('offen');
  });

  it('K: ein Cloud-Fehler lässt den lokalen Stand bestehen und meldet keinen Erfolg', async () => {
    // Lokale Zahlung zuerst — sie bleibt in jedem Fall erhalten.
    const local = recordPayment(VORGANG_ID, INVOICE_ID, { date: '2026-08-25', amount: 4000 });
    expect(local.success).toBe(true);

    const client = stubRpcError('Netzwerk weg');
    const result = await addInvoicePaymentToCloud(
      { clientInvoiceId: INVOICE_ID, clientPaymentId: 'uuid-1', amount: 4000, paidOn: '2026-08-25' },
      withClient(client),
    );

    expect(result.outcome).toBe('failed');
    expect(isInvoicePaymentCloudSilent(result.outcome)).toBe(false);
    expect(stored().payments).toHaveLength(1);
  });

  it('L: ein fehlender Workspace bleibt nicht still', async () => {
    const result = await addInvoicePaymentToCloud(
      { clientInvoiceId: INVOICE_ID, clientPaymentId: 'uuid-1', amount: 4000, paidOn: '2026-08-25' },
      { client: stubRpc(() => []), workspaceId: '   ' },
    );

    expect(result.outcome).toBe('workspace_missing');
    expect(isInvoicePaymentCloudSilent(result.outcome)).toBe(false);
  });

  it('M: eine Antwort, die die Mutation nicht beweist, ist kein Erfolg', async () => {
    const input = {
      clientInvoiceId: INVOICE_ID,
      clientPaymentId: 'uuid-1',
      amount: 4000,
      paidOn: '2026-08-25',
    };

    const cases: unknown[] = [
      [],
      null,
      [cloudRow({ paymentId: 'uuid-1', amount: 4000, paidOn: '2026-08-25' }), cloudRow({ paymentId: 'uuid-2', amount: 1, paidOn: '2026-08-25' })],
      [cloudRow({ paymentId: 'uuid-anders', amount: 4000, paidOn: '2026-08-25' })],
      [cloudRow({ paymentId: 'uuid-1', amount: 3999, paidOn: '2026-08-25' })],
      [cloudRow({ paymentId: 'uuid-1', amount: 4000, paidOn: '2026-08-24' })],
      [cloudRow({ paymentId: 'uuid-1', amount: 4000, paidOn: '2026-08-25', invoiceId: 'inv-fremd' })],
      [
        cloudRow({
          paymentId: 'uuid-1',
          amount: 4000,
          paidOn: '2026-08-25',
          reversedAt: '2026-08-27T10:00:00.000Z',
        }),
      ],
    ];

    for (const data of cases) {
      const result = await addInvoicePaymentToCloud(input, withClient(stubRpc(() => data)));
      expect(result.outcome).toBe('failed');
    }
  });

  it('N: eine historische pay-Kennung wird akzeptiert und nicht umgeschrieben', async () => {
    let received: Record<string, unknown> | null = null;
    const client = stubRpc((_name, args) => {
      received = args;
      return [cloudRow({ paymentId: LEGACY_ID, amount: 10000, paidOn: '2026-08-25' })];
    });

    const result = await addInvoicePaymentToCloud(
      {
        clientInvoiceId: INVOICE_ID,
        clientPaymentId: LEGACY_ID,
        amount: 10000,
        paidOn: '2026-08-25',
      },
      withClient(client),
    );

    expect(result.outcome).toBe('synced');
    if (result.outcome !== 'synced') return;
    expect(result.row.clientPaymentId).toBe(LEGACY_ID);
    expect((received as unknown as Record<string, unknown>).p_client_payment_id).toBe(LEGACY_ID);
  });

  it('O: eine lokal-only-Zahlung wird erkannt, aber nicht von selbst übertragen', () => {
    const legacy: InvoicePayment = {
      id: LEGACY_ID,
      date: '2026-08-25',
      amount: 10000,
      createdAt: '2026-08-25T10:00:00.000Z',
    };
    seed(buildInvoice({ payments: [legacy], paymentStatus: 'teilbezahlt' }));

    // Die Cloud kennt diese Kennung nicht.
    const pending = findLocallyOnlyPayments(stored(), []);
    expect(pending.map((payment) => payment.id)).toEqual([LEGACY_ID]);

    // Nach erfolgreicher Übertragung verschwindet der Hinweis.
    expect(findLocallyOnlyPayments(stored(), [LEGACY_ID])).toHaveLength(0);

    // Und die lokale Zahlung wurde durch das Erkennen nicht verändert.
    expect(stored().payments?.[0]?.id).toBe(LEGACY_ID);
    expect(stored().payments?.[0]?.amount).toBe(10000);
  });

  /**
   * 04B2B1 — die Lücken, die der 04B2B-Bericht selbst benannt hat.
   */
  describe('04B2B1 — Recovery, Retry und Grabsteinvorrang', () => {
    const legacy: InvoicePayment = {
      id: LEGACY_ID,
      date: '2026-08-25',
      amount: 10000,
      createdAt: '2026-08-25T10:00:00.000Z',
    };

    it('B1-C: eine lokal-only-Zahlung wird nur nach erfolgreichem Pull erkannt', async () => {
      seed(buildInvoice({ payments: [legacy], paymentStatus: 'teilbezahlt' }));
      const client = stubRpc(() => []);

      const pulled = await pullInvoicePaymentsFromCloud(withClient(client));
      expect(pulled.outcome).toBe('synced');
      if (pulled.outcome !== 'synced') return;

      const pending = findLocallyOnlyPayments(
        stored(),
        pulled.rows.map((row) => row.clientPaymentId),
      );
      expect(pending.map((payment) => payment.id)).toEqual([LEGACY_ID]);

      // Erkennen ist kein Übertragen: der Speicher blieb unberührt.
      expect(stored().payments?.[0]?.amount).toBe(10000);
    });

    it('B1-H: ein Cloud-Grabstein macht die Zahlung nicht zum Recovery-Kandidaten', async () => {
      seed(buildInvoice({ payments: [legacy], paymentStatus: 'teilbezahlt' }));
      const client = stubRpc(() => [
        cloudRow({
          paymentId: LEGACY_ID,
          amount: 10000,
          paidOn: '2026-08-25',
          reversedAt: '2026-08-27T10:00:00.000Z',
        }),
      ]);

      const pulled = await pullInvoicePaymentsFromCloud(withClient(client));
      if (pulled.outcome !== 'synced') return;

      /*
       * Der Grabstein beweist gerade, dass die Kennung in der Cloud bekannt
       * ist. Sie als „noch nicht gesichert" anzubieten wäre falsch — und ein
       * Klick darauf würde eine stornierte Zahlung wiederbeleben.
       */
      const pending = findLocallyOnlyPayments(
        stored(),
        pulled.rows.map((row) => row.clientPaymentId),
      );
      expect(pending).toHaveLength(0);

      // Und der Merge entfernt die lokale Kopie.
      const merged = mergeCloudPaymentsIntoInvoice(
        stored(),
        pulled.rows.map((row) => ({
          clientInvoiceId: row.clientInvoiceId,
          clientPaymentId: row.clientPaymentId,
          amount: row.amount,
          paidOn: row.paidOn,
          createdAt: row.createdAt,
          reversedAt: row.reversedAt,
        })),
      );
      expect(merged).toHaveLength(0);
    });

    it('B1-D/E: die Recovery überträgt dieselbe Kennung und ist wiederholbar', async () => {
      seed(buildInvoice({ payments: [legacy], paymentStatus: 'teilbezahlt' }));
      const sent: unknown[] = [];
      const client = stubRpc((_name, args) => {
        sent.push(args.p_client_payment_id);
        return [cloudRow({ paymentId: LEGACY_ID, amount: 10000, paidOn: '2026-08-25' })];
      });

      const payment = stored().payments![0]!;
      const first = await addInvoicePaymentToCloud(
        {
          clientInvoiceId: INVOICE_ID,
          clientPaymentId: payment.id,
          amount: payment.amount,
          paidOn: payment.date,
        },
        withClient(client),
      );
      const second = await addInvoicePaymentToCloud(
        {
          clientInvoiceId: INVOICE_ID,
          clientPaymentId: payment.id,
          amount: payment.amount,
          paidOn: payment.date,
        },
        withClient(client),
      );

      expect(first.outcome).toBe('synced');
      expect(second.outcome).toBe('synced');
      // Zweimal exakt dieselbe historische Kennung — nie eine neue.
      expect(sent).toEqual([LEGACY_ID, LEGACY_ID]);

      // Lokal ist weiterhin genau eine Zahlung vorhanden.
      expect(stored().payments).toHaveLength(1);
      expect(stored().payments?.[0]?.id).toBe(LEGACY_ID);
    });

    it('B1-F/G: ohne beweisbaren Cloud-Stand gibt es keinen Recovery-Hinweis', async () => {
      seed(buildInvoice({ payments: [legacy], paymentStatus: 'teilbezahlt' }));

      const failed = await pullInvoicePaymentsFromCloud(
        withClient(stubRpcError('Cloud nicht erreichbar')),
      );
      const missing = await pullInvoicePaymentsFromCloud({
        client: stubRpc(() => []) as never,
        workspaceId: '',
      });

      expect(failed.outcome).toBe('failed');
      expect(missing.outcome).toBe('workspace_missing');
      // Keiner der beiden liefert Kennungen — der Hinweis ist gar nicht bildbar.
      expect(failed).not.toHaveProperty('rows');
      expect(missing).not.toHaveProperty('rows');
    });

    it('B1-B: ohne Supabase gilt eine Zahlung nicht als cloudgesichert', async () => {
      vi.spyOn(supabaseLib, 'isSupabaseConfigured').mockReturnValue(true);
      const outcome = await syncInvoicePaymentToCloud(INVOICE_ID, {
        id: 'uuid-1',
        date: '2026-08-25',
        amount: 4000,
        createdAt: '2026-08-25T10:00:00.000Z',
      });

      /*
       * Ohne echten Client scheitert der Aufruf — entscheidend ist, dass kein
       * Ausgang außer `synced` als vollständige Sicherung durchgeht.
       */
      expect(isInvoicePaymentCloudSynced(outcome)).toBe(false);
      expect(isInvoicePaymentCloudSynced('supabase_not_configured')).toBe(false);
      expect(isInvoicePaymentCloudSynced('workspace_missing')).toBe(false);
      expect(isInvoicePaymentCloudSynced('conflict')).toBe(false);
      expect(isInvoicePaymentCloudSynced('failed')).toBe(false);
      expect(isInvoicePaymentCloudSynced('synced')).toBe(true);
    });

    it('B1-I: nach erfolgreichem Reversal räumt der nächste Pull die lokale Kopie ab', async () => {
      const local: InvoicePayment = {
        id: 'uuid-1',
        date: '2026-08-25',
        amount: 4000,
        createdAt: '2026-08-25T10:00:00.000Z',
      };
      seed(buildInvoice({ payments: [local], paymentStatus: 'teilbezahlt' }));

      // Cloud-Reversal gelingt …
      const reversed = await reverseInvoicePaymentInCloud(
        { clientInvoiceId: INVOICE_ID, clientPaymentId: 'uuid-1' },
        withClient(
          stubRpc(() => [
            cloudRow({
              paymentId: 'uuid-1',
              amount: 4000,
              paidOn: '2026-08-25',
              reversedAt: '2026-08-27T10:00:00.000Z',
            }),
          ]),
        ),
      );
      expect(reversed.outcome).toBe('synced');

      // … der lokale Commit scheitert, die Zahlung bleibt also lokal stehen.
      expect(stored().payments).toHaveLength(1);

      // Der nächste Pull macht den Grabstein zur Wahrheit.
      const merged = mergeCloudPaymentsIntoInvoice(stored(), [
        entry(
          cloudRow({
            paymentId: 'uuid-1',
            amount: 4000,
            paidOn: '2026-08-25',
            reversedAt: '2026-08-27T10:00:00.000Z',
          }),
        ),
      ]);
      expect(merged).toHaveLength(0);
      expect(calculatePaymentSummary({ ...stored(), payments: merged }).status).toBe('offen');
    });
  });

  it('P: ohne erfolgreichen Pull wird keine Zahlung für ungesichert erklärt', async () => {
    const failed = await pullInvoicePaymentsFromCloud(
      withClient(stubRpcError('Cloud nicht erreichbar')),
    );
    expect(failed.outcome).toBe('failed');

    const missingWorkspace = await pullInvoicePaymentsFromCloud({
      client: stubRpc(() => []) as never,
      workspaceId: '',
    });
    expect(missingWorkspace.outcome).toBe('workspace_missing');

    vi.spyOn(supabaseLib, 'isSupabaseConfigured').mockReturnValue(false);
    const notConfigured = await pullInvoicePaymentsFromCloud();
    expect(notConfigured.outcome).toBe('supabase_not_configured');

    /*
     * Keiner dieser Ausgänge liefert eine Kennungsliste — `findLocallyOnlyPayments`
     * ist damit gar nicht erst aufrufbar. Unbekannt ist nicht ungesichert.
     */
    expect(failed).not.toHaveProperty('rows');
    expect(notConfigured).not.toHaveProperty('rows');
  });

  /**
   * 04B2B2-A — die frisch angelegte, leere Tabelle.
   *
   * Eine leere Cloud ist kein Sonderfall und kein Zwischenzustand: Sie ist ein
   * vollständig bekannter Stand. Wer erst eine künstliche Testzahlung anlegen
   * müsste, um die historische Zahlung zu sehen, hätte den Beweis verdorben,
   * den er führen will.
   */
  it('B2-A: ein erfolgreicher leerer Pull ist ein bekannter Stand', async () => {
    const invoice = buildInvoice({
      payments: [
        {
          id: LEGACY_ID,
          date: '2026-08-25',
          amount: 10000,
          createdAt: '2026-08-25T09:00:00.000Z',
        } as InvoicePayment,
      ],
    });
    seed(invoice);

    const pulled = await pullInvoicePaymentsFromCloud(withClient(stubRpc(() => [])));
    expect(pulled.outcome).toBe('synced');
    // Der Beweis: eine Liste, nicht das Fehlen einer Liste.
    expect(pulled).toHaveProperty('rows');
    const rows = pulled.outcome === 'synced' ? pulled.rows : null;
    expect(rows).toEqual([]);

    const candidates = findLocallyOnlyPayments(stored(), (rows ?? []).map((row) => row.clientPaymentId));
    expect(candidates.map((payment) => payment.id)).toEqual([LEGACY_ID]);
    // Die vorhandene Kennung bleibt unangetastet — kein Umschreiben, kein Ersatz.
    expect(candidates[0].amount).toBe(10000);
    expect(candidates[0].date).toBe('2026-08-25');
    // Kein Auto-Upload: Der Pull hat ausschließlich gelesen.
    expect(stored().payments).toHaveLength(1);
    expect(stored().payments?.[0].id).toBe(LEGACY_ID);
  });

  /**
   * 04B2B2-C — ohne Cloud-Verbindung ist eine Stornierung nicht beweisbar.
   *
   * `supabase_not_configured` heißt „ich kann nicht nachsehen", nicht „dort ist
   * nichts". Ein hartes lokales Löschen auf dieser Grundlage könnte die Zahlung
   * beim nächsten Abgleich zurückholen.
   */
  it('B2-C: ohne Supabase gilt ein Reversal nicht als bestätigt', async () => {
    vi.spyOn(supabaseLib, 'isSupabaseConfigured').mockReturnValue(false);
    const outcome = await reverseInvoicePaymentInCloud({
      clientInvoiceId: INVOICE_ID,
      clientPaymentId: LEGACY_ID,
    });
    expect(outcome.outcome).toBe('supabase_not_configured');
    expect(isInvoicePaymentCloudSynced(outcome.outcome)).toBe(false);
    // Der alte, zu nachsichtige Massstab hätte hier „still in Ordnung" gesagt.
    expect(isInvoicePaymentCloudSilent(outcome.outcome)).toBe(true);
  });
});
