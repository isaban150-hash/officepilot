/**
 * MANUAL-INVOICE-UI-01B2 — globale Rechnungsdetailseite und Post-Finalize-Fluss.
 *
 * Eine Seite, zwei Routen: `/rechnungen/:invoiceId` (global, ohne Vorgang in
 * der URL) und `/vorgaenge/:id/rechnungen/:invoiceId` (bestehender Weg).
 * Geprüft wird an der echten `InvoiceDetailPage` mit echtem Speicher —
 * neutrale Beispieldaten, kein Netzwerk; die Cloud ist ein ersetzter Client.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { DEFAULT_COMPANY_PROFILE } from '../data/companyProfileDefaults';
import { DEFAULT_SETUP } from '../data/mockData';
import { AppProvider, useApp } from '../context/AppContext';
import { InvoiceDetailPage } from './InvoiceDetailPage';
import { InvoiceOverviewCard } from '../components/invoice/InvoiceOverviewCard';
import { resetTestStores } from '../test/resetStores';
import { createOrderPosition, createTestVorgang } from '../test/fixtures';
import { getVorgangInvoice, hydrateVorgangStore } from '../services/vorgangService';
import { hydrateInvoiceStore, getInvoiceStoreSnapshot } from '../services/invoice/invoiceStore';
import { hydrateWorkspaceStore } from '../services/workspace/workspaceStore';
import { findInvoiceLocatorById } from '../services/invoice/invoiceRegistryService';
import { resolveInvoiceDetailRoute } from '../services/invoice/invoiceDetailRouteResolver';
import {
  buildGlobalInvoiceDetailPath,
  buildInvoiceReachPath,
} from '../services/invoiceNavigation';
import { resolveManualInvoicePostFinalizePath } from '../services/invoice/manualInvoiceFlow';
import { getAllInvoiceOverview } from '../services/invoiceOverviewService';
import { recordPayment, removePayment, calculatePaymentSummary } from '../services/invoicePaymentService';
import { markInvoiceAsSent, readInvoiceSentStateFromCloud } from '../services/invoiceSentService';
import { confirmFinalizedInvoiceServicePeriod } from '../services/invoice/invoiceServicePeriodConfirmService';
import { buildPersistedStateSnapshot } from '../services/persistenceService';
import { validateFinalizedInvoiceForPdf } from '../services/invoiceValidationService';
import * as supabaseLib from '../lib/supabase';
import type { Vorgang, VorgangInvoice } from '../types/models';

const WORKSPACE = '00000000-0000-4000-8000-0000000001b2';
const VORGANG_ID = 'v-01b2';
const ORDER_INVOICE_ID = 'inv-order-01b2';
const FREE_INVOICE_ID = 'inv-free-01b2';
const CUSTOMER_ID = 'cust-01b2';
const ARCHIVE_DOC = 'doc-free-01b2';

const setupComplete = { ...DEFAULT_SETUP, setupComplete: true };

const CUSTOMER = {
  name: 'Beispiel Projektbau GmbH',
  contactPerson: '',
  street: 'Beispielweg 1',
  zip: '10000',
  city: 'Beispielstadt',
  email: '',
  phone: '',
};

function buildInvoice(overrides: Partial<VorgangInvoice> = {}): VorgangInvoice {
  return {
    id: ORDER_INVOICE_ID,
    number: '2026-0101',
    invoiceSequenceNumber: 101,
    type: 'rechnung',
    positions: [
      {
        id: 'line-1',
        description: 'Anfahrt',
        quantity: 2,
        unit: 'Std',
        unitPrice: 50,
        lineTotal: 100,
      },
    ],
    subtotal: 100,
    taxStatus: 'standard_19',
    amount: 119,
    status: 'vorbereitet',
    date: '2026-09-01',
    issueDate: '2026-09-01',
    createdAt: '2026-09-01T10:00:00.000Z',
    servicePeriodFrom: '2026-08-20',
    servicePeriodTo: '2026-08-28',
    servicePeriodConfirmed: true,
    paymentDueDate: '2099-12-31',
    paymentTermsText: '14 Tage netto',
    paymentStatus: 'offen',
    payments: [],
    legalNotices: [],
    previousAbschlagDeductions: [],
    customerSnapshot: CUSTOMER,
    companySnapshot: {
      ...DEFAULT_COMPANY_PROFILE,
      companyName: 'Muster GmbH',
      street: 'Musterstraße 3',
      zip: '20000',
      city: 'Musterstadt',
    },
    ...overrides,
  } as VorgangInvoice;
}

/** Die freie Rechnung: eigener Kunde, Archivdokument, kein Auftrag. */
function freeInvoice(overrides: Partial<VorgangInvoice> = {}): VorgangInvoice {
  return buildInvoice({
    id: FREE_INVOICE_ID,
    number: '2026-0102',
    invoiceSequenceNumber: 102,
    customerId: CUSTOMER_ID,
    archiveDocumentId: ARCHIVE_DOC,
    ...overrides,
  });
}

function seed(options: { free?: VorgangInvoice | null; order?: VorgangInvoice | null } = {}): void {
  const order = options.order === undefined ? buildInvoice() : options.order;
  const free = options.free === undefined ? freeInvoice() : options.free;
  hydrateVorgangStore([
    {
      ...createTestVorgang({
        id: VORGANG_ID,
        title: 'Dachsanierung Beispiel',
        status: 'beauftragt',
        customer: 'Beispiel Projektbau GmbH',
        baustelle: 'Beispielweg 1',
        orderPositions: [
          createOrderPosition({ id: 'op-1', unit: 'Std', plannedQuantity: 2, unitPrice: 50 }),
        ],
      }),
      invoices: order ? [{ ...order, vorgangTitle: 'Dachsanierung Beispiel', baustelle: 'Beispielweg 1' }] : [],
    } as Vorgang,
  ]);
  if (free) {
    hydrateInvoiceStore([
      ...getInvoiceStoreSnapshot(),
      { invoice: free, vorgangId: null },
    ]);
  }
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

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location" data-path={location.pathname} data-search={location.search} />;
}

function ToastProbe() {
  const { toast } = useApp();
  return <div data-testid="toast-probe">{toast ?? ''}</div>;
}

interface PageMount {
  container: HTMLDivElement;
  root: Root;
}

/** Spiegelt die Routenordnung aus `App.tsx` — statische Pfade vor `:invoiceId`. */
function renderAt(path: string, element: ReactElement = <InvoiceDetailPage />): PageMount {
  const container = document.createElement('div');
  document.body.appendChild(container);
  let root!: Root;
  act(() => {
    root = createRoot(container);
    root.render(
      <MemoryRouter initialEntries={[path]}>
        <AppProvider initialSetup={setupComplete}>
          <Routes>
            <Route path="/vorgaenge/:id" element={<div data-testid="page-vorgang" />} />
            <Route path="/vorgaenge/:id/rechnungen/:invoiceId" element={element} />
            <Route path="/rechnungen/offen" element={<div data-testid="page-offen" />} />
            <Route path="/rechnungen/neu" element={<div data-testid="page-neu" />} />
            <Route path="/rechnungen/:invoiceId" element={element} />
            <Route path="/dokumente/:id" element={<div data-testid="page-dokument" />} />
          </Routes>
          <LocationProbe />
          <ToastProbe />
        </AppProvider>
      </MemoryRouter>,
    );
  });
  return { container, root };
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function q(mount: PageMount, testId: string): HTMLElement | null {
  return mount.container.querySelector(`[data-testid="${testId}"]`);
}

function expand(mount: PageMount): void {
  const toggle = mount.container.querySelector(
    '[data-testid="invoice-detail-show-more"] button',
  ) as HTMLElement | null;
  if (toggle) act(() => toggle.click());
}

function pathOf(mount: PageMount): string {
  return q(mount, 'location')?.getAttribute('data-path') ?? '';
}

function installClient(handler: (name: string, args: Record<string, unknown>) => unknown): string[] {
  const calls: string[] = [];
  vi.spyOn(supabaseLib, 'isSupabaseConfigured').mockReturnValue(true);
  vi.spyOn(supabaseLib, 'getSupabaseClient').mockReturnValue({
    rpc: async (name: string, args: Record<string, unknown>) => {
      calls.push(name);
      return { data: handler(name, args), error: null };
    },
  } as never);
  return calls;
}

function paymentRow(paymentId: string, amount: number, reversed = false) {
  return {
    id: `row-${paymentId}`,
    workspace_id: WORKSPACE,
    client_invoice_id: FREE_INVOICE_ID,
    client_payment_id: paymentId,
    amount,
    paid_on: '2026-09-02',
    reference: null,
    note: null,
    created_at: '2026-09-02T09:00:00.000Z',
    updated_at: '2026-09-02T09:00:00.000Z',
    row_version: 1,
    reversed_at: reversed ? '2026-09-03T09:00:00.000Z' : null,
  };
}

describe('MANUAL-INVOICE-UI-01B2 — globale Rechnungsdetailseite', () => {
  let mounted: PageMount | null = null;

  beforeEach(() => {
    resetTestStores();
    vi.spyOn(supabaseLib, 'isSupabaseConfigured').mockReturnValue(false);
    vi.spyOn(supabaseLib, 'getSupabaseClient').mockReturnValue(null);
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

  /* ------------------------------------------------------------------ */
  /* A/O — Routing                                                        */
  /* ------------------------------------------------------------------ */

  it('P3/P4/O: /rechnungen/neu und /rechnungen/offen werden nie als invoiceId gelesen', async () => {
    mounted = renderAt('/rechnungen/neu');
    await settle();
    expect(q(mounted, 'page-neu')).not.toBeNull();
    expect(q(mounted, 'invoice-detail-page')).toBeNull();
    expect(q(mounted, 'invoice-detail-not-found')).toBeNull();
    act(() => mounted!.root.unmount());
    mounted.container.remove();

    mounted = renderAt('/rechnungen/offen');
    await settle();
    expect(q(mounted, 'page-offen')).not.toBeNull();
    expect(q(mounted, 'invoice-detail-page')).toBeNull();
    expect(q(mounted, 'invoice-detail-not-found')).toBeNull();
  });

  it('A: App.tsx deklariert die globale Route hinter den statischen Nachbarn und behält den Vorgangsweg', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/App.tsx'), 'utf8');
    const neu = source.indexOf('path="/rechnungen/neu"');
    const offen = source.indexOf('path="/rechnungen/offen"');
    const global = source.indexOf('path="/rechnungen/:invoiceId"');
    const vorgang = source.indexOf('path="/vorgaenge/:id/rechnungen/:invoiceId"');
    expect(neu).toBeGreaterThan(-1);
    expect(offen).toBeGreaterThan(-1);
    expect(global).toBeGreaterThan(-1);
    expect(vorgang).toBeGreaterThan(-1);
    expect(neu).toBeLessThan(global);
    expect(offen).toBeLessThan(global);
    expect(source).toContain('path="/rechnungen/:invoiceId" element={<InvoiceDetailPage />}');
  });

  it('P1/P13/P15: die globale Route zeigt die freie Rechnung — ohne Vorgang, ohne Projektplatzhalter', async () => {
    mounted = renderAt(buildGlobalInvoiceDetailPath(FREE_INVOICE_ID));
    await settle();

    expect(q(mounted, 'invoice-detail-page')).not.toBeNull();
    expect(q(mounted, 'invoice-detail-not-found')).toBeNull();
    const text = mounted.container.textContent ?? '';
    expect(text).toContain('2026-0102');
    expect(text).toContain('Beispiel Projektbau GmbH');
    // Kein Bauvorhaben-Block, kein Platzhalter.
    expect(mounted.container.querySelector('.invoice-project')).toBeNull();
    expect(text).not.toContain('Bauvorhaben');
    // Rechnungsinhalt: Positionen und Summen stehen im Dokument.
    expect(text).toContain('Anfahrt');
    expect(q(mounted, 'invoice-print-document')).not.toBeNull();
  });

  it('P2/P14: der bestehende Vorgangsweg zeigt weiterhin Titel und Projektblock', async () => {
    mounted = renderAt(`/vorgaenge/${VORGANG_ID}/rechnungen/${ORDER_INVOICE_ID}`);
    await settle();

    expect(q(mounted, 'invoice-detail-page')).not.toBeNull();
    const text = mounted.container.textContent ?? '';
    expect(text).toContain('2026-0101');
    expect(text).toContain('Dachsanierung Beispiel');
    expect(mounted.container.querySelector('.invoice-project')).not.toBeNull();
    // Kommunikation und Versandpanel bleiben auf dem Vorgangsweg erhalten.
    expect(text).toContain('Nachricht schreiben');
    expect(q(mounted, 'invoice-sent-panel')).not.toBeNull();
    expect(q(mounted, 'invoice-print')).not.toBeNull();
    expect(q(mounted, 'invoice-download-pdf')).not.toBeNull();
    expand(mounted);
    expect(q(mounted, 'invoice-communication')).not.toBeNull();
    expect(q(mounted, 'invoice-communication-unavailable')).toBeNull();
  });

  it('P6: die globale Route öffnet auch eine Vorgangsrechnung — mit ihrem echten Vorgang', async () => {
    mounted = renderAt(buildGlobalInvoiceDetailPath(ORDER_INVOICE_ID));
    await settle();

    expect(q(mounted, 'invoice-detail-page')).not.toBeNull();
    expect(mounted.container.textContent).toContain('Dachsanierung Beispiel');
    expect(mounted.container.querySelector('.invoice-project')).not.toBeNull();
    // Zurück führt zum echten Vorgang, nicht in die Übersicht.
    act(() => q(mounted!, 'invoice-detail-back')!.click());
    expect(pathOf(mounted)).toBe(`/vorgaenge/${VORGANG_ID}`);
  });

  it('P7: alte Route mit falschem Vorgang → fail closed, keine fremde Rechnung', async () => {
    hydrateVorgangStore([
      ...([] as Vorgang[]),
      {
        ...createTestVorgang({ id: 'v-other', title: 'Anderer Vorgang', status: 'beauftragt' }),
        invoices: [],
      } as Vorgang,
    ]);
    seed();
    expect(getVorgangInvoice(VORGANG_ID, ORDER_INVOICE_ID)).toBeDefined();

    mounted = renderAt(`/vorgaenge/v-other/rechnungen/${ORDER_INVOICE_ID}`);
    await settle();
    expect(q(mounted, 'invoice-detail-not-found')).not.toBeNull();
    expect(q(mounted, 'invoice-detail-page')).toBeNull();
    expect(mounted.container.textContent).not.toContain('2026-0101');

    // Und die freie Rechnung ist über keinen Vorgang erreichbar.
    act(() => mounted!.root.unmount());
    mounted.container.remove();
    mounted = renderAt(`/vorgaenge/${VORGANG_ID}/rechnungen/${FREE_INVOICE_ID}`);
    await settle();
    expect(q(mounted, 'invoice-detail-not-found')).not.toBeNull();
    expect(resolveInvoiceDetailRoute({ routeVorgangId: VORGANG_ID, invoiceId: FREE_INVOICE_ID })).toEqual({ kind: 'mismatch' });
  });

  it('O: /rechnungen/nicht-vorhanden → bestehendes Not-found-Verhalten, Zurück in die Übersicht', async () => {
    mounted = renderAt('/rechnungen/nicht-vorhanden');
    await settle();
    expect(q(mounted, 'invoice-detail-not-found')).not.toBeNull();
    expect(mounted.container.textContent).toContain('Rechnung nicht gefunden.');
    const back = mounted.container.querySelector('[data-testid="invoice-detail-not-found"] button') as HTMLElement;
    act(() => back.click());
    expect(pathOf(mounted)).toBe('/rechnungen/offen');
    expect(resolveInvoiceDetailRoute({ routeVorgangId: undefined, invoiceId: 'nicht-vorhanden' })).toEqual({ kind: 'not_found' });
  });

  it('P5: findInvoiceLocatorById liefert die freie Rechnung mit vorgangId null', () => {
    const entry = findInvoiceLocatorById(FREE_INVOICE_ID);
    expect(entry?.vorgangId).toBeNull();
    expect(entry?.invoice.customerId).toBe(CUSTOMER_ID);
    const resolved = resolveInvoiceDetailRoute({ routeVorgangId: undefined, invoiceId: FREE_INVOICE_ID });
    expect(resolved.kind).toBe('found');
    if (resolved.kind === 'found') expect(resolved.vorgangId).toBeNull();
  });

  /* ------------------------------------------------------------------ */
  /* D — Navigation                                                       */
  /* ------------------------------------------------------------------ */

  it('P8/P9: buildInvoiceReachPath — global für null, Vorgangsweg unverändert', () => {
    expect(buildInvoiceReachPath(null, FREE_INVOICE_ID)).toBe(`/rechnungen/${FREE_INVOICE_ID}`);
    expect(buildInvoiceReachPath(VORGANG_ID, ORDER_INVOICE_ID)).toBe(
      `/vorgaenge/${VORGANG_ID}/rechnungen/${ORDER_INVOICE_ID}`,
    );
    expect(buildInvoiceReachPath(null, FREE_INVOICE_ID)).not.toContain('null');
    expect(buildInvoiceReachPath(null, FREE_INVOICE_ID)).not.toBe('/rechnungen/offen');
  });

  it('P10/P11/P12: die Übersichtskarte bietet der freien Rechnung Öffnen, Druck und PDF — ohne Vorgangslink', async () => {
    const item = getAllInvoiceOverview('2026-09-05').find((entry) => entry.invoice.id === FREE_INVOICE_ID)!;
    expect(item.vorgangId).toBeNull();

    mounted = renderAt('/rechnungen/offen', <div />);
    act(() => {
      mounted!.root.render(
        <MemoryRouter initialEntries={['/rechnungen/offen']}>
          <Routes>
            <Route path="*" element={<><InvoiceOverviewCard item={item} translate={(k) => k} /><LocationProbe /></>} />
          </Routes>
        </MemoryRouter>,
      );
    });

    expect(mounted.container.querySelector(`a[href="/vorgaenge/${VORGANG_ID}"]`)).toBeNull();
    expect(mounted.container.querySelector('a[href^="/vorgaenge/"]')).toBeNull();
    const open = q(mounted, 'invoice-overview-card-open')!;
    expect(open).not.toBeNull();
    act(() => open.click());
    expect(pathOf(mounted)).toBe(`/rechnungen/${FREE_INVOICE_ID}`);
    expect(q(mounted, 'location')?.getAttribute('data-search')).toBe('?from=overview');

    const trigger = q(mounted, 'invoice-overview-card-more-trigger')!;
    act(() => trigger.click());
    act(() => q(mounted!, 'invoice-overview-card-print')!.click());
    expect(pathOf(mounted)).toBe(`/rechnungen/${FREE_INVOICE_ID}`);
    expect(q(mounted, 'location')?.getAttribute('data-search')).toBe('?auto=print');
    act(() => q(mounted!, 'invoice-overview-card-more-trigger')!.click());
    act(() => q(mounted!, 'invoice-overview-card-pdf')!.click());
    expect(q(mounted, 'location')?.getAttribute('data-search')).toBe('?auto=pdf');
  });

  /* ------------------------------------------------------------------ */
  /* F/G — Druck, PDF, Archiv                                             */
  /* ------------------------------------------------------------------ */

  it('F/P16: Druck, PDF und Archivlink sind auf der freien Detailseite erreichbar', async () => {
    mounted = renderAt(`${buildGlobalInvoiceDetailPath(FREE_INVOICE_ID)}?from=overview`);
    await settle();
    expect(q(mounted, 'invoice-print')).not.toBeNull();
    expect(q(mounted, 'invoice-download-pdf')).not.toBeNull();
    expand(mounted);
    const archive = q(mounted, 'invoice-detail-archive-link') as HTMLAnchorElement;
    expect(archive).not.toBeNull();
    expect(archive.getAttribute('href')).toBe(`/dokumente/${ARCHIVE_DOC}`);
    act(() => archive.click());
    expect(pathOf(mounted)).toBe(`/dokumente/${ARCHIVE_DOC}`);
  });

  it('F: ?auto=print läuft für die freie Rechnung durch denselben Druckweg', async () => {
    // Derselbe Validator wie für PDF — die freie Rechnung ist druckbar.
    expect(validateFinalizedInvoiceForPdf(freeInvoice()).blockingErrors).toEqual([]);
    const printSpy = vi.fn();
    Object.defineProperty(window, 'print', { value: printSpy, configurable: true, writable: true });
    mounted = renderAt(`${buildGlobalInvoiceDetailPath(FREE_INVOICE_ID)}?auto=print`);
    await settle();
    expect(printSpy).toHaveBeenCalled();
  });

  /* ------------------------------------------------------------------ */
  /* H — Zahlungen                                                        */
  /* ------------------------------------------------------------------ */

  it('P17/P18/P19: Zahlung erfassen mit null — Teilzahlung, weitere Teilzahlung, voll bezahlt', () => {
    // Bestehende Regel: eine noch nicht versendete Rechnung braucht die Bestätigung.
    const unconfirmed = recordPayment(null, FREE_INVOICE_ID, { date: '2026-09-02', amount: 50 });
    expect(unconfirmed.success).toBe(false);
    const first = recordPayment(null, FREE_INVOICE_ID, { date: '2026-09-02', amount: 50 }, { confirmUnsent: true });
    expect(first.success).toBe(true);
    let stored = getVorgangInvoice(null, FREE_INVOICE_ID)!;
    expect(calculatePaymentSummary(stored).status).toBe('teilbezahlt');
    expect(calculatePaymentSummary(stored).openAmount).toBeCloseTo(69, 2);

    const second = recordPayment(null, FREE_INVOICE_ID, { date: '2026-09-03', amount: 69 }, { confirmUnsent: true });
    expect(second.success).toBe(true);
    stored = getVorgangInvoice(null, FREE_INVOICE_ID)!;
    expect(stored.payments).toHaveLength(2);
    expect(calculatePaymentSummary(stored).status).toBe('bezahlt');
    expect(calculatePaymentSummary(stored).openAmount).toBeCloseTo(0, 2);
    // Die Rechnung bleibt eine freie Rechnung — kein Vorgang ist entstanden.
    expect(findInvoiceLocatorById(FREE_INVOICE_ID)?.vorgangId).toBeNull();
  });

  it('H: die Detailseite erfasst eine Teilzahlung über das bestehende Formular mit vorgangId null', async () => {
    mounted = renderAt(buildGlobalInvoiceDetailPath(FREE_INVOICE_ID));
    await settle();

    const record = [...mounted.container.querySelectorAll('button')].find(
      (node) => node.textContent?.trim() === 'Zahlung erfassen',
    ) as HTMLElement;
    expect(record).toBeDefined();
    act(() => record.click());

    const amount = mounted.container.querySelector('input[type="number"]') as HTMLInputElement;
    expect(amount).not.toBeNull();
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    act(() => {
      setter.call(amount, '40');
      amount.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const form = amount.closest('form') as HTMLFormElement;
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await settle();
    // Bestehende Regel: die noch nicht versendete Rechnung fragt erst nach — Confirm-first.
    const confirmSubmit = q(mounted, 'payment-confirm-submit') as HTMLElement;
    expect(confirmSubmit).not.toBeNull();
    await act(async () => confirmSubmit.click());
    await settle();

    const stored = getVorgangInvoice(null, FREE_INVOICE_ID)!;
    expect(stored.payments).toHaveLength(1);
    expect(stored.payments?.[0].amount).toBe(40);
    expect(calculatePaymentSummary(stored).status).toBe('teilbezahlt');
    expect(mounted.container.textContent).toContain('Teilbezahlt');
  });

  it('P20: Zahlung entfernen — bestätigt gegen die Cloud, dann lokal mit null', async () => {
    const paid = recordPayment(null, FREE_INVOICE_ID, { date: '2026-09-02', amount: 50 }, { confirmUnsent: true });
    expect(paid.success).toBe(true);
    const paymentId = paid.success ? paid.payment.id : '';
    let reversed = false;
    const calls = installClient((name) => {
      if (name === 'reverse_workspace_invoice_payment') {
        reversed = true;
        return [paymentRow(paymentId, 50, true)];
      }
      if (name === 'pull_workspace_invoice_payments') return [paymentRow(paymentId, 50, reversed)];
      if (name === 'get_workspace_invoice_sent') return { found: false };
      return null;
    });
    vi.spyOn(window, 'confirm').mockReturnValue(true);

    mounted = renderAt(buildGlobalInvoiceDetailPath(FREE_INVOICE_ID));
    await settle();
    expand(mounted);
    const removeButton = [
      ...mounted.container.querySelectorAll('.invoice-payment-history button'),
    ].find((node) => node.textContent?.trim() === 'Entfernen') as HTMLElement | undefined;
    expect(removeButton).toBeDefined();
    await act(async () => removeButton!.click());
    await settle();

    expect(calls).toContain('reverse_workspace_invoice_payment');
    expect(getVorgangInvoice(null, FREE_INVOICE_ID)!.payments ?? []).toHaveLength(0);
    expect(q(mounted, 'toast-probe')?.textContent).toBe('Zahlung entfernt.');
  });

  it('P20b: removePayment(null, …) auf Dienstebene — und ohne Cloud-Beweis bleibt die Zahlung stehen', async () => {
    const paid = recordPayment(null, FREE_INVOICE_ID, { date: '2026-09-02', amount: 50 }, { confirmUnsent: true });
    expect(paid.success).toBe(true);
    const paymentId = paid.success ? paid.payment.id : '';

    vi.spyOn(window, 'confirm').mockReturnValue(true);
    mounted = renderAt(buildGlobalInvoiceDetailPath(FREE_INVOICE_ID));
    await settle();
    expand(mounted);
    const removeButton = [
      ...mounted.container.querySelectorAll('.invoice-payment-history button'),
    ].find((node) => node.textContent?.trim() === 'Entfernen') as HTMLElement;
    await act(async () => removeButton.click());
    await settle();
    // Bestehende Regel: ohne Cloud-Beweis keine lokale Löschung.
    expect(getVorgangInvoice(null, FREE_INVOICE_ID)!.payments).toHaveLength(1);
    expect(q(mounted, 'toast-probe')?.textContent).toContain('Sie bleibt deshalb bestehen.');

    const removed = removePayment(null, FREE_INVOICE_ID, paymentId);
    expect(removed.success).toBe(true);
    expect(getVorgangInvoice(null, FREE_INVOICE_ID)!.payments ?? []).toHaveLength(0);
  });

  /* ------------------------------------------------------------------ */
  /* M — Reload / Durability                                              */
  /* ------------------------------------------------------------------ */

  it('P21/P22/P23: nach Persistenz und Neuaufbau bleiben Zahlungen, customerId und customerSnapshot erhalten', async () => {
    expect(recordPayment(null, FREE_INVOICE_ID, { date: '2026-09-02', amount: 30 }, { confirmUnsent: true }).success).toBe(true);
    const snapshotBefore = getVorgangInvoice(null, FREE_INVOICE_ID)!.customerSnapshot;

    // „Reload": der persistierte Stand wird neu in den Speicher geladen.
    const persisted = buildPersistedStateSnapshot();
    const entries = getInvoiceStoreSnapshot();
    hydrateInvoiceStore([]);
    expect(findInvoiceLocatorById(FREE_INVOICE_ID)).toBeUndefined();
    hydrateInvoiceStore(entries.map((entry) => ({ ...entry, invoice: JSON.parse(JSON.stringify(entry.invoice)) })));

    const entry = findInvoiceLocatorById(FREE_INVOICE_ID);
    expect(entry).toBeDefined();
    expect(entry!.vorgangId).toBeNull();
    expect(entry!.invoice.payments).toHaveLength(1);
    expect(entry!.invoice.customerId).toBe(CUSTOMER_ID);
    expect(entry!.invoice.customerSnapshot).toEqual(snapshotBefore);
    expect(entry!.invoice.archiveDocumentId).toBe(ARCHIVE_DOC);
    expect(JSON.stringify(persisted)).toContain(FREE_INVOICE_ID);

    mounted = renderAt(buildGlobalInvoiceDetailPath(FREE_INVOICE_ID));
    await settle();
    expect(q(mounted, 'invoice-detail-page')).not.toBeNull();
    expect(mounted.container.textContent).toContain('Teilbezahlt');
  });

  /* ------------------------------------------------------------------ */
  /* C — Post-Finalize-Navigation                                         */
  /* ------------------------------------------------------------------ */

  it('P24/P25/P26: Post-Finalize nur auf die belegte freie Rechnung, sonst Übersicht', () => {
    expect(
      resolveManualInvoicePostFinalizePath(FREE_INVOICE_ID, findInvoiceLocatorById(FREE_INVOICE_ID)),
    ).toBe(`/rechnungen/${FREE_INVOICE_ID}`);
    // Nicht belegt → keine Detailseite, die noch nicht sicher existiert.
    expect(resolveManualInvoicePostFinalizePath('inv-unknown', findInvoiceLocatorById('inv-unknown'))).toBe('/rechnungen/offen');
    // Eine Vorgangsrechnung ist keine freie Rechnung — der manuelle Weg landet nicht darauf.
    expect(resolveManualInvoicePostFinalizePath(ORDER_INVOICE_ID, findInvoiceLocatorById(ORDER_INVOICE_ID))).toBe('/rechnungen/offen');
    // Replay: dieselbe Kennung führt auf dieselbe Rechnung.
    expect(resolveManualInvoicePostFinalizePath(FREE_INVOICE_ID, findInvoiceLocatorById(FREE_INVOICE_ID))).toBe(
      resolveManualInvoicePostFinalizePath(FREE_INVOICE_ID, findInvoiceLocatorById(FREE_INVOICE_ID)),
    );
  });

  /* ------------------------------------------------------------------ */
  /* I/J/K — Versand, Kommunikation, Storno                               */
  /* ------------------------------------------------------------------ */

  it('P27: der Versandstand ist für die freie Rechnung lesbar und markierbar — ohne Fake-Vorgang', async () => {
    const calls = installClient((name) => {
      if (name === 'get_workspace_invoice_sent') return { found: true, invoice_status: 'vorbereitet', sent_at: null, sent_via: null, sent_note: null };
      if (name === 'pull_workspace_invoice_payments') return [];
      return null;
    });
    const state = await readInvoiceSentStateFromCloud(null, FREE_INVOICE_ID);
    expect(state.kind).toBe('synced');
    expect(calls).toContain('get_workspace_invoice_sent');

    const marked = markInvoiceAsSent(null, FREE_INVOICE_ID, { sentAt: '2026-09-04', sentVia: 'email' });
    expect(marked.ok).toBe(true);
    const stored = getVorgangInvoice(null, FREE_INVOICE_ID)!;
    expect(stored.status).toBe('versendet');
    expect(stored.sentAt).toBe('2026-09-04');
    expect(findInvoiceLocatorById(FREE_INVOICE_ID)?.vorgangId).toBeNull();

    mounted = renderAt(buildGlobalInvoiceDetailPath(FREE_INVOICE_ID));
    await settle();
    expect(q(mounted, 'invoice-sent-panel')).not.toBeNull();
    expect(q(mounted, 'invoice-sent-status')).not.toBeNull();
  });

  it('I: die Leistungszeitraum-Bestätigung schreibt für die freie Rechnung in den First-Class-Speicher', () => {
    seed({ free: freeInvoice({ servicePeriodConfirmed: false }) });
    const result = confirmFinalizedInvoiceServicePeriod(null, FREE_INVOICE_ID);
    expect(result.ok).toBe(true);
    expect(getVorgangInvoice(null, FREE_INVOICE_ID)!.servicePeriodConfirmed).toBe(true);
    expect(findInvoiceLocatorById(FREE_INVOICE_ID)?.vorgangId).toBeNull();
  });

  it('P28/K: ohne Vorgang keine Kommunikationsaktion mit Fake-ID; Storno seit NORMAL-INVOICE-CANCELLATION-01B erlaubt', async () => {
    mounted = renderAt(buildGlobalInvoiceDetailPath(FREE_INVOICE_ID));
    await settle();
    expect(mounted.container.textContent).not.toContain('Nachricht schreiben');
    expect(q(mounted, 'invoice-communication-unavailable')).not.toBeNull();
    // 01B — die normale freie Rechnung ist stornierbar (Server: vorgang_id null ⇒ rechnung).
    expect(q(mounted, 'invoice-cancel-action')).not.toBeNull();
    expand(mounted);
    expect(q(mounted, 'invoice-communication')).toBeNull();
    expect(mounted.container.innerHTML).not.toContain('vorgangId=null');
    expect(mounted.container.innerHTML).not.toContain('/vorgaenge/null');
  });

  it('E: Zurück von der freien Detailseite führt in die Rechnungsübersicht', async () => {
    mounted = renderAt(buildGlobalInvoiceDetailPath(FREE_INVOICE_ID));
    await settle();
    act(() => q(mounted!, 'invoice-detail-back')!.click());
    expect(pathOf(mounted)).toBe('/rechnungen/offen');
  });
});
