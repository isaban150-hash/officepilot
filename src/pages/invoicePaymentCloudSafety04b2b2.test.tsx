/**
 * OFFICEPILOT-PAYMENT-CLOUD-SAFETY-04B2B2 — die drei letzten Lücken.
 *
 * 1. Eine erfolgreich abgefragte, leere Cloud ist ein vollständig bekannter
 *    Stand. Die historische Zahlung muss sofort als ungesichert erkennbar sein,
 *    ohne dass vorher irgendeine künstliche Testzahlung angelegt wird.
 * 2. Eine Zahlung darf lokal nur verschwinden, wenn geklärt ist, dass keine
 *    Cloud-Kopie zurückkommen kann. Fehlende Supabase-Konfiguration klärt nichts.
 * 3. Der Abgleich darf sich nicht selbst nachladen.
 *
 * Geprüft wird an der echten Seite gegen einen ersetzten Supabase-Client.
 * Neutrale Beispieldaten, kein Netzwerk.
 */
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { DEFAULT_COMPANY_PROFILE } from '../data/companyProfileDefaults';
import { DEFAULT_SETUP } from '../data/mockData';
import { AppProvider, useApp } from '../context/AppContext';
import { InvoiceDetailPage } from './InvoiceDetailPage';
import { resetTestStores } from '../test/resetStores';
import { createOrderPosition, createTestVorgang } from '../test/fixtures';
import { getVorgangInvoice, hydrateVorgangStore } from '../services/vorgangService';
import { hydrateWorkspaceStore } from '../services/workspace/workspaceStore';
import * as supabaseLib from '../lib/supabase';
import type { InvoicePayment, Vorgang, VorgangInvoice } from '../types/models';

const WORKSPACE = '00000000-0000-4000-8000-00000000b2b2';
const VORGANG_ID = 'v-pay-safety';
const INVOICE_ID = 'inv-pay-safety';
const LEGACY_ID = 'pay-123456789';
const PATH = `/vorgaenge/${VORGANG_ID}/rechnungen/${INVOICE_ID}`;

const setupComplete = { ...DEFAULT_SETUP, setupComplete: true };

const legacyPayment: InvoicePayment = {
  id: LEGACY_ID,
  date: '2026-08-25',
  amount: 10000,
  createdAt: '2026-08-25T09:00:00.000Z',
};

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
    paymentStatus: 'teilbezahlt',
    payments: [legacyPayment],
    legalNotices: [],
    previousAbschlagDeductions: [],
    customerSnapshot: {
      name: 'Beispiel Projektbau GmbH',
      contactPerson: '',
      street: 'Beispielweg 1',
      zip: '10000',
      city: 'Beispielstadt',
      email: '',
      phone: '',
    },
    companySnapshot: { ...DEFAULT_COMPANY_PROFILE, companyName: 'Muster GmbH' },
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
  hydrateWorkspaceStore({
    workspace: {
      id: WORKSPACE,
      name: 'Beispielbetrieb',
      ownerUserId: 'user-1',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      version: 1,
    },
  });
}

function stored(): VorgangInvoice {
  return getVorgangInvoice(VORGANG_ID, INVOICE_ID)!;
}

interface RpcLog {
  calls: string[];
  pulls(): number;
}

/** Ersetzt den Supabase-Client und protokolliert, welche RPCs wirklich liefen. */
function installClient(handler: (name: string, args: Record<string, unknown>) => unknown): RpcLog {
  const calls: string[] = [];
  vi.spyOn(supabaseLib, 'isSupabaseConfigured').mockReturnValue(true);
  vi.spyOn(supabaseLib, 'getSupabaseClient').mockReturnValue({
    rpc: async (name: string, args: Record<string, unknown>) => {
      calls.push(name);
      return { data: handler(name, args), error: null };
    },
  } as never);
  return {
    calls,
    pulls: () => calls.filter((name) => name === 'pull_workspace_invoice_payments').length,
  };
}

/**
 * Der Toast wird in der App vom Layout gerendert, nicht vom Provider. Diese
 * Sonde macht ihn im Seitentest sichtbar, ohne die Seite zu verändern.
 */
function ToastProbe() {
  const { toast } = useApp();
  return <div data-testid="toast-probe">{toast ?? ''}</div>;
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
        <AppProvider initialSetup={setupComplete}>
          <Routes>
            <Route path="/vorgaenge/:id/rechnungen/:invoiceId" element={element} />
          </Routes>
          <ToastProbe />
        </AppProvider>
      </MemoryRouter>,
    );
  });
  return { container, root };
}

/** Laesst alle offenen Microtasks der Cloud-Aufrufe durchlaufen. */
async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function expand(container: ParentNode): void {
  const toggle = container.querySelector(
    '[data-testid="invoice-detail-show-more"] button',
  ) as HTMLElement | null;
  if (toggle) act(() => toggle.click());
}

describe('OFFICEPILOT-PAYMENT-CLOUD-SAFETY-04B2B2', () => {
  let mounted: PageMount | null = null;

  beforeEach(() => {
    resetTestStores();
    seed();
  });

  afterEach(() => {
    if (mounted) {
      const { root, container } = mounted;
      act(() => root.unmount());
      container.remove();
      mounted = null;
    }
    vi.restoreAllMocks();
    resetTestStores();
  });

  it('B2-B: die leere Cloud macht die historische Zahlung sofort sichtbar ungesichert', async () => {
    const log = installClient(() => []);

    mounted = renderPage(<InvoiceDetailPage />);
    await settle();
    expand(mounted.container);

    expect(log.pulls()).toBeGreaterThan(0);
    const hint = mounted.container.querySelector(`[data-testid="payment-unsynced-${LEGACY_ID}"]`);
    expect(hint).not.toBeNull();
    expect(hint?.textContent).toContain('noch nicht in der Cloud gesichert');
    expect(
      mounted.container.querySelector(`[data-testid="payment-secure-${LEGACY_ID}"]`),
    ).not.toBeNull();

    // Kein Auto-Upload: gelesen wurde, geschrieben nicht.
    expect(log.calls).not.toContain('add_workspace_invoice_payment');
    expect(stored().payments).toHaveLength(1);
    expect(stored().payments?.[0].id).toBe(LEGACY_ID);
    expect(stored().payments?.[0].amount).toBe(10000);
  });

  it('B2-D: der eigene Merge löst keinen zweiten Pull aus', async () => {
    const log = installClient(() => []);

    mounted = renderPage(<InvoiceDetailPage />);
    await settle();
    await settle();
    await settle();

    expect(log.pulls()).toBe(1);
  });

  it('B2-E: eine ausdrückliche Sicherung darf gezielt neu abgleichen', async () => {
    const secured: string[] = [];
    const log = installClient((name, args) => {
      if (name === 'add_workspace_invoice_payment') {
        secured.push(String(args.p_client_payment_id));
        return [
          {
            id: 'row-1',
            workspace_id: WORKSPACE,
            client_invoice_id: INVOICE_ID,
            client_payment_id: LEGACY_ID,
            amount: 10000,
            paid_on: '2026-08-25',
            reference: null,
            note: null,
            created_at: '2026-08-25T09:00:00.000Z',
            updated_at: '2026-08-25T09:00:00.000Z',
            row_version: 1,
            reversed_at: null,
          },
        ];
      }
      // Nach der Sicherung kennt die Cloud die Zahlung.
      return secured.length
        ? [
            {
              id: 'row-1',
              workspace_id: WORKSPACE,
              client_invoice_id: INVOICE_ID,
              client_payment_id: LEGACY_ID,
              amount: 10000,
              paid_on: '2026-08-25',
              reference: null,
              note: null,
              created_at: '2026-08-25T09:00:00.000Z',
              updated_at: '2026-08-25T09:00:00.000Z',
              row_version: 1,
              reversed_at: null,
            },
          ]
        : [];
    });

    mounted = renderPage(<InvoiceDetailPage />);
    await settle();
    expand(mounted.container);

    const button = mounted.container.querySelector(
      `[data-testid="payment-secure-${LEGACY_ID}"]`,
    ) as HTMLElement;
    expect(button).not.toBeNull();
    const before = log.pulls();

    await act(async () => {
      button.click();
    });
    await settle();

    // Genau die vorhandene Kennung, kein zweites lokales Payment.
    expect(secured).toEqual([LEGACY_ID]);
    expect(stored().payments).toHaveLength(1);
    expect(stored().payments?.[0].id).toBe(LEGACY_ID);
    // Der ausdrückliche Erfolg darf neu abgleichen — und der Hinweis verschwindet.
    expect(log.pulls()).toBeGreaterThan(before);
    expect(
      mounted.container.querySelector(`[data-testid="payment-unsynced-${LEGACY_ID}"]`),
    ).toBeNull();
  });

  it('B2-C: ohne Supabase wird die Zahlung nicht lokal entfernt', async () => {
    vi.spyOn(supabaseLib, 'isSupabaseConfigured').mockReturnValue(false);
    vi.spyOn(supabaseLib, 'getSupabaseClient').mockReturnValue(null);
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);

    mounted = renderPage(<InvoiceDetailPage />);
    await settle();
    expand(mounted.container);

    const removeButton = [
      ...mounted.container.querySelectorAll('.invoice-payment-history button'),
    ].find((node) => node.textContent?.trim() === 'Entfernen') as HTMLElement | undefined;
    expect(removeButton).toBeDefined();

    await act(async () => {
      removeButton!.click();
    });
    await settle();

    expect(confirm).toHaveBeenCalled();
    // Die Zahlung bleibt — lokal wie in der Anzeige.
    expect(stored().payments).toHaveLength(1);
    expect(stored().payments?.[0].id).toBe(LEGACY_ID);
    expect(mounted.container.textContent).toContain('10.000,00');
    // Und der Nutzer erfaehrt den Grund — nicht bloss ein stilles Nichts.
    const toast = mounted.container.querySelector('[data-testid="toast-probe"]');
    expect(toast?.textContent).toBe(
      'Ohne Verbindung zur Cloud lässt sich nicht klären, ob diese Zahlung dort gesichert ist. Sie bleibt deshalb bestehen.',
    );
  });
});
