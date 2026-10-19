/**
 * FINANZ-CORE-01A — Restnacharbeit nach WEISS-Bericht 18, END18-R3 an der echten Rechnungsseite: Weist der
 * Server eine neu erfasste Zahlung fachlich ab (hier: Sitzung A hat inzwischen bezahlt, die zweite Zahlung wäre
 * eine unbestätigte Überzahlung), zählt sie nirgends, steht aber sichtbar als abgewiesen da. Erst die bewusste
 * Entscheidung des Nutzers bestätigt sie als Überzahlung (gesendet mit Bestätigung) oder verwirft den Nachweis.
 *
 *  U1  Formular → Abweisung → nicht gebucht, Nachweis mit Bestätigen/Verwerfen, Summen ohne sie
 *  U2  Bestätigen → Rückfrage → gesendet mit p_overpayment_acknowledged, danach gebucht
 *  U3  Verwerfen → Nachweis weg, nichts gesendet, die angenommene Zahlung bleibt
 *
 * Neutrale Beispieldaten, ersetzter Supabase-Client, kein Netzwerk.
 */
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { DEFAULT_COMPANY_PROFILE } from '../data/companyProfileDefaults';
import { DEFAULT_SETUP } from '../data/mockData';
import { AppProvider } from '../context/AppContext';
import { InvoiceDetailPage } from './InvoiceDetailPage';
import { resetTestStores } from '../test/resetStores';
import { createOrderPosition, createTestVorgang } from '../test/fixtures';
import { getVorgangInvoice, hydrateVorgangStore } from '../services/vorgangService';
import { hydrateWorkspaceStore } from '../services/workspace/workspaceStore';
import * as supabaseLib from '../lib/supabase';
import type { InvoicePayment, RejectedInvoicePayment, Vorgang, VorgangInvoice } from '../types/models';
import { alsInhaber } from '../test/workspaceRoleTestUtils';
import { calculatePaymentSummary } from '../services/invoicePaymentService';
import { resetInvoicePaymentResyncForTests } from '../services/invoice/invoicePaymentCloudResyncService';

beforeEach(() => alsInhaber());

const WORKSPACE = '00000000-0000-4000-8000-0000000019a3';
const VORGANG_ID = 'v-b19-r3';
const INVOICE_ID = 'inv-b19-r3';
const PATH = `/vorgaenge/${VORGANG_ID}/rechnungen/${INVOICE_ID}`;

const zahlungA: InvoicePayment = { id: 'pay-A', date: '2026-08-25', amount: 10000, createdAt: '2026-08-25T09:00:00.000Z' };
const zahlungB: RejectedInvoicePayment = {
  id: 'pay-B',
  date: '2026-08-26',
  amount: 10000,
  createdAt: '2026-08-26T09:00:00.000Z',
  rejectedAt: '2026-08-26T09:00:01.000Z',
  reason: 'overpayment_unconfirmed',
};

function buildInvoice(overrides: Partial<VorgangInvoice> = {}): VorgangInvoice {
  return {
    id: INVOICE_ID,
    number: '2026-0901',
    invoiceSequenceNumber: 901,
    type: 'rechnung',
    positions: [
      { id: 'line-1', orderPositionId: 'op-1', description: 'Dachsanierung', quantity: 100, unit: 'm²', unitPrice: 100, lineTotal: 10000 },
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
    customerSnapshot: { name: 'Beispiel Projektbau GmbH', contactPerson: '', street: 'Beispielweg 1', zip: '10000', city: 'Beispielstadt', email: '', phone: '' },
    companySnapshot: { ...DEFAULT_COMPANY_PROFILE, companyName: 'Muster GmbH' },
    ...overrides,
  } as VorgangInvoice;
}

function seed(invoice: VorgangInvoice): void {
  hydrateVorgangStore([
    {
      ...createTestVorgang({
        id: VORGANG_ID,
        status: 'beauftragt',
        customer: 'Beispiel Projektbau GmbH',
        orderPositions: [createOrderPosition({ id: 'op-1', unit: 'm²', plannedQuantity: 100, unitPrice: 100 })],
      }),
      invoices: [invoice],
    } as Vorgang,
  ]);
  hydrateWorkspaceStore({
    workspace: { id: WORKSPACE, name: 'Beispielbetrieb', ownerUserId: 'user-1', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', version: 1 },
  });
}

function stored(): VorgangInvoice {
  return getVorgangInvoice(VORGANG_ID, INVOICE_ID)!;
}

function zeile(payment: InvoicePayment) {
  return {
    id: `row-${payment.id}`,
    workspace_id: WORKSPACE,
    client_invoice_id: INVOICE_ID,
    client_payment_id: payment.id,
    amount: payment.amount,
    paid_on: payment.date,
    reference: null,
    note: null,
    created_at: payment.createdAt,
    updated_at: payment.createdAt,
    row_version: 1,
    reversed_at: null,
  };
}

interface Cloud {
  rows: ReturnType<typeof zeile>[];
  sends: Record<string, unknown>[];
}

/** Die Cloud: Sitzung A hat schon bezahlt (wenn `mitA`); jede weitere Zahlung ohne Bestätigung ist eine Überzahlung. */
function installCloud(options: { mitA: boolean; pullZeigtA: boolean }): Cloud {
  const cloud: Cloud = { rows: options.mitA ? [zeile(zahlungA)] : [], sends: [] };
  vi.spyOn(supabaseLib, 'isSupabaseConfigured').mockReturnValue(true);
  vi.spyOn(supabaseLib, 'getSupabaseClient').mockReturnValue({
    rpc: async (name: string, args: Record<string, unknown>) => {
      if (name === 'add_workspace_invoice_payment') {
        cloud.sends.push(args);
        const bezahlt = cloud.rows.reduce((sum, row) => sum + Number(row.amount), 0);
        if (bezahlt >= 10000 && args.p_overpayment_acknowledged !== true) {
          return { data: null, error: { message: 'invoice_payment_overpayment_unconfirmed: offen 0.00', code: 'P0001' } };
        }
        const row = zeile({ id: String(args.p_client_payment_id), date: String(args.p_paid_on), amount: Number(args.p_amount), createdAt: '2026-08-26T09:00:00.000Z' });
        cloud.rows.push(row);
        return { data: [row], error: null };
      }
      if (name === 'pull_workspace_invoice_payments') return { data: options.pullZeigtA ? [...cloud.rows] : [], error: null };
      return { data: [], error: null };
    },
  } as never);
  return cloud;
}

interface PageMount {
  container: HTMLDivElement;
  root: Root;
}

function renderPage(element: ReactElement): PageMount {
  const container = document.createElement('div');
  document.body.appendChild(container);
  let root!: Root;
  act(() => {
    root = createRoot(container);
    root.render(
      <MemoryRouter initialEntries={[PATH]}>
        <AppProvider initialSetup={{ ...DEFAULT_SETUP, setupComplete: true }}>
          <Routes>
            <Route path="/vorgaenge/:id/rechnungen/:invoiceId" element={element} />
          </Routes>
        </AppProvider>
      </MemoryRouter>,
    );
  });
  return { container, root };
}

async function settle(runden = 6): Promise<void> {
  for (let runde = 0; runde < runden; runde += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

function expand(container: ParentNode): void {
  const toggle = container.querySelector('[data-testid="invoice-detail-show-more"] button') as HTMLElement | null;
  if (toggle) act(() => toggle.click());
}

describe('END18-R3 — fachlich abgewiesene Rechnungszahlung an der echten Seite', () => {
  let mounted: PageMount | null = null;

  beforeEach(() => {
    resetTestStores();
    resetInvoicePaymentResyncForTests();
  });

  afterEach(() => {
    if (mounted) {
      const { root, container } = mounted;
      act(() => root.unmount());
      container.remove();
      mounted = null;
    }
    vi.restoreAllMocks();
    resetInvoicePaymentResyncForTests();
    resetTestStores();
  });

  it('U1 Formular → Abweisung: nicht gebucht, sichtbar abgewiesen mit Bestätigen/Verwerfen, Summen ohne sie', async () => {
    seed(buildInvoice());
    // Dieses Gerät kennt die Zahlung von Sitzung A noch nicht (veraltet), der Server schon.
    const cloud = installCloud({ mitA: true, pullZeigtA: false });
    mounted = renderPage(<InvoiceDetailPage />);
    await settle();

    const open = [...mounted.container.querySelectorAll('button')].find((node) => node.textContent?.trim() === 'Zahlung erfassen') as HTMLElement | undefined;
    expect(open).toBeTruthy();
    await act(async () => open!.click());
    const save = document.querySelector('[data-testid="payment-save"]') as HTMLElement | null;
    expect(save).not.toBeNull();
    await act(async () => {
      (save!.closest('form') as HTMLFormElement).dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await settle();

    expect(cloud.sends).toHaveLength(1);
    const x = stored();
    expect(x.payments ?? []).toEqual([]);
    expect(x.rejectedPayments).toEqual([expect.objectContaining({ amount: 10000, reason: 'overpayment_unconfirmed' })]);
    expect(calculatePaymentSummary(x)).toMatchObject({ paidAmount: 0, openAmount: 10000 });
    const id = x.rejectedPayments![0].id;
    expect(cloud.rows.map((row) => row.client_payment_id)).toEqual(['pay-A']);

    expand(mounted.container);
    expect(mounted.container.querySelector(`[data-testid="payment-rejected-${id}"]`)).not.toBeNull();
    expect(mounted.container.querySelector(`[data-testid="payment-rejected-confirm-${id}"]`)).not.toBeNull();
    expect(mounted.container.querySelector(`[data-testid="payment-rejected-discard-${id}"]`)).not.toBeNull();
  });

  it('U2 bewusst als Überzahlung bestätigen: Rückfrage, gesendet mit Bestätigung, danach gebucht', async () => {
    seed(buildInvoice({ payments: [zahlungA], rejectedPayments: [zahlungB], paymentStatus: 'bezahlt' }));
    const cloud = installCloud({ mitA: true, pullZeigtA: true });
    mounted = renderPage(<InvoiceDetailPage />);
    await settle();
    expand(mounted.container);

    const confirm = mounted.container.querySelector('[data-testid="payment-rejected-confirm-pay-B"]') as HTMLElement;
    expect(confirm).not.toBeNull();
    await act(async () => confirm.click());
    expect(document.querySelector('[data-testid="payment-overpayment-dialog"]')).not.toBeNull();
    // Vor der Bestätigung im Dialog: nichts gesendet.
    expect(cloud.sends).toHaveLength(0);
    await act(async () => (document.querySelector('[data-testid="payment-overpayment-confirm"]') as HTMLElement).click());
    await settle();

    expect(cloud.sends).toEqual([expect.objectContaining({ p_client_payment_id: 'pay-B', p_overpayment_acknowledged: true })]);
    const x = stored();
    expect(x.payments!.map((p) => [p.id, p.overpaymentAcknowledged === true])).toEqual([
      ['pay-A', false],
      ['pay-B', true],
    ]);
    expect(x.rejectedPayments ?? []).toEqual([]);
    expect(mounted.container.querySelector('[data-testid="payment-rejected-pay-B"]')).toBeNull();
  });

  it('U3 bewusst verwerfen: Nachweis weg, nichts gesendet, die angenommene Zahlung bleibt', async () => {
    seed(buildInvoice({ payments: [zahlungA], rejectedPayments: [zahlungB], paymentStatus: 'bezahlt' }));
    const cloud = installCloud({ mitA: true, pullZeigtA: true });
    mounted = renderPage(<InvoiceDetailPage />);
    await settle();
    expand(mounted.container);

    await act(async () => (mounted!.container.querySelector('[data-testid="payment-rejected-discard-pay-B"]') as HTMLElement).click());
    await settle();

    expect(cloud.sends).toHaveLength(0);
    const x = stored();
    expect(x.payments!.map((p) => p.id)).toEqual(['pay-A']);
    expect(x.rejectedPayments ?? []).toEqual([]);
    expect(calculatePaymentSummary(x)).toMatchObject({ paidAmount: 10000, openAmount: 0, status: 'bezahlt' });
    expect(mounted.container.querySelector('[data-testid="payment-rejected-list"]')).toBeNull();
  });
});
