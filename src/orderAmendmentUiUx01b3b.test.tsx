import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppProvider } from './context/AppContext';
import { DEFAULT_SETUP } from './data/mockData';
import { VorgangDetailPage } from './pages/VorgangDetailPage';
import { t, type TranslationKey } from './i18n';
import {
  addOrderAmendmentDraftPosition,
  createOrderAmendmentDraft,
} from './services/orderAmendmentService';
import * as confirmOrchestrator from './services/orderAmendment/orderAmendmentCloudConfirmOrchestrator';
import * as invoiceService from './services/invoiceService';
import {
  formatPaymentCurrency,
  summarizeVorgangInvoicePayments,
} from './services/invoicePaymentService';
import { getVorgangById, hydrateVorgangStore } from './services/vorgangService';
import {
  createAbschlagInvoice,
  createOrderPosition,
  createTestVorgang,
} from './test/fixtures';
import { resetTestStores } from './test/resetStores';
import type {
  ConfirmedOrderAmendment,
  ContractConfirmationSnapshot,
  Vorgang,
} from './types/models';

function translate(key: TranslationKey): string {
  return t(key, 'de');
}

function snapshot(): ContractConfirmationSnapshot {
  return {
    id: 'snapshot-b3b1',
    confirmedAt: '2026-07-24T10:00:00.000Z',
    customer: 'Test Kunde',
    auftraggeber: 'Test Kunde',
    baustelle: 'Teststraße 1',
    title: 'Testvorgang',
    positions: [
      {
        id: 'op-test-1',
        description: 'Montage Heizkörper',
        plannedQuantity: 10,
        unit: 'Stunden',
        unitPrice: 65,
        category: 'arbeit',
        billable: true,
      },
    ],
    negotiation: {
      notes: [],
      generalHints: [],
      priceProposals: [],
      positionProposals: [],
      drafts: [],
    },
    immutable: true,
  };
}

function seedVorgang(extras: Partial<Vorgang> = {}) {
  hydrateVorgangStore([
    createTestVorgang({
      id: 'v-b3b1',
      status: 'beauftragt',
      contractConfirmation: snapshot(),
      orderPositions: [
        createOrderPosition({
          id: 'op-test-1',
          description: 'Montage Heizkörper',
          plannedQuantity: 10,
          unit: 'Stunden',
          unitPrice: 65,
        }),
      ],
      ...extras,
    }),
  ]);
  return getVorgangById('v-b3b1')!;
}

function confirmedAmendment(clientAmendmentId: string): ConfirmedOrderAmendment {
  return {
    cloudId: 'cloud-b3b1-1',
    clientAmendmentId,
    vorgangId: 'v-b3b1',
    sequenceNo: 1,
    status: 'bestaetigt',
    title: 'Bestätigter Nachtrag',
    positions: [
      {
        id: 'op-amendment-b3b1-1',
        changeType: 'add',
        description: 'Zusatz',
        plannedQuantity: 1,
        unit: 'Stück',
        unitPrice: 20,
      },
    ],
    contentFingerprint: 'fp-b3b1',
    confirmedAt: '2026-07-24T12:00:00.000Z',
    confirmedBy: 'tester',
    rowVersion: 1,
    createdAt: '2026-07-24T12:00:00.000Z',
    updatedAt: '2026-07-24T12:00:00.000Z',
  };
}

function renderPage(container: HTMLDivElement): Root {
  const root = createRoot(container);
  act(() => {
    root.render(
      createElement(
        MemoryRouter,
        { initialEntries: ['/vorgaenge/v-b3b1'] },
        createElement(
          AppProvider,
          { initialSetup: DEFAULT_SETUP },
          createElement(
            Routes,
            null,
            createElement(Route, {
              path: '/vorgaenge/:id',
              element: createElement(VorgangDetailPage),
            }),
          ),
        ),
      ),
    );
  });
  return root;
}

function openInvoicesSection(container: HTMLDivElement) {
  act(() => {
    (
      container.querySelector(
        '[data-testid="vorgang-section-tab-invoices"]',
      ) as HTMLButtonElement
    ).click();
  });
  expect(container.querySelector('[data-testid="vorgang-section-panel-invoices"]')?.hidden).toBe(
    false,
  );
}

describe('ORDER-AMENDMENT-UI-UX-01B3B1 Rechnungssegment', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    resetTestStores();
    vi.restoreAllMocks();
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  it('entfernt die Rechnungs-Primary aus der Übersicht und zeigt sie nur im Rechnungssegment', () => {
    seedVorgang();
    const buildSpy = vi.spyOn(invoiceService, 'buildRechnungDraft');
    const finalizeSpy = vi.spyOn(invoiceService, 'finalizeInvoiceDraft');
    const confirmSpy = vi.spyOn(confirmOrchestrator, 'confirmOrderAmendmentWithCloud');
    root = renderPage(container);

    const overview = container.querySelector(
      '[data-testid="vorgang-section-panel-overview"]',
    ) as HTMLElement;
    expect(overview.hidden).toBe(false);
    expect(overview.querySelector('[data-testid="vorgang-prepare-invoice"]')).toBeNull();
    expect(overview.textContent).not.toContain(translate('vorgang.prepareInvoice'));
    expect(overview.textContent).not.toContain(translate('detail.action.writeInvoice'));
    expect(overview.textContent).toContain(translate('detail.action.addPhoto'));
    expect(overview.textContent).toContain(translate('detail.action.writeMessage'));

    openInvoicesSection(container);

    const ctaLinks = container.querySelectorAll('[data-testid="vorgang-prepare-invoice"]');
    expect(ctaLinks).toHaveLength(1);
    const cta = ctaLinks[0] as HTMLAnchorElement;
    expect(cta.getAttribute('href')).toBe('/vorgaenge/v-b3b1/rechnung?type=rechnung');
    expect(cta.textContent).toContain(translate('vorgang.prepareInvoice'));

    const invoicesSection = container.querySelector(
      '[data-testid="vorgang-invoices-section"]',
    ) as HTMLElement;
    expect(invoicesSection.querySelector('h2')?.textContent).toBe(translate('vorgang.invoices'));
    expect(invoicesSection.textContent).toContain(translate('vorgang.invoicesSectionIntro'));

    expect(buildSpy).not.toHaveBeenCalled();
    expect(finalizeSpy).not.toHaveBeenCalled();
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(getVorgangById('v-b3b1')!.invoices).toHaveLength(0);

    act(() => root.unmount());
  });

  it('zeigt ohne Auftragspositionen keinen CTA und erklärt die Voraussetzung', () => {
    // Without contract confirmation, hydrate must not repair positions from a snapshot.
    hydrateVorgangStore([
      createTestVorgang({
        id: 'v-b3b1',
        status: 'eingegangen',
        orderPositions: [],
        contractConfirmation: undefined,
        invoices: [],
      }),
    ]);
    expect(getVorgangById('v-b3b1')!.orderPositions).toHaveLength(0);

    const buildSpy = vi.spyOn(invoiceService, 'buildRechnungDraft');
    root = renderPage(container);
    openInvoicesSection(container);

    expect(container.querySelector('[data-testid="vorgang-prepare-invoice"]')).toBeNull();
    expect(container.textContent).toContain(translate('vorgang.invoicesEmptyNoPositions'));
    expect(container.textContent).not.toContain(
      translate('vorgang.invoicesEmptyWithPositions'),
    );
    expect(buildSpy).not.toHaveBeenCalled();

    act(() => root.unmount());
  });

  it('zeigt handlungsorientierten Leerzustand mit Positionen und einer CTA', () => {
    seedVorgang({ invoices: [] });
    root = renderPage(container);
    openInvoicesSection(container);

    expect(container.querySelector('[data-testid="vorgang-invoices-empty"]')).not.toBeNull();
    expect(container.textContent).toContain(translate('vorgang.invoicesEmptyWithPositions'));
    expect(container.textContent).toContain(
      translate('vorgang.invoicesEmptyWithPositionsHint'),
    );
    expect(container.querySelectorAll('[data-testid="vorgang-prepare-invoice"]')).toHaveLength(1);
    expect(container.querySelector('[data-testid="vorgang-invoice-summary"]')).toBeNull();
    expect(getVorgangById('v-b3b1')!.invoices).toHaveLength(0);

    act(() => root.unmount());
  });

  it('zeigt Summary und bestehende Rechnungskarten mit korrekten Totals', () => {
    const invoice = createAbschlagInvoice('op-test-1', 2, {
      id: 'inv-b3b1-1',
      number: '2026-0100',
      issueDate: '2026-06-01',
      paymentDueDate: '2099-06-15',
      amount: 154.7,
      subtotal: 130,
      payments: [
        {
          id: 'pay-b3b1-1',
          date: '2026-06-10',
          amount: 50,
          createdAt: '2026-06-10T10:00:00.000Z',
        },
      ],
    });
    seedVorgang({ invoices: [invoice] });
    const expected = summarizeVorgangInvoicePayments([invoice]);
    root = renderPage(container);
    openInvoicesSection(container);

    const summary = container.querySelector('[data-testid="vorgang-invoice-summary"]');
    expect(summary).not.toBeNull();
    expect(summary?.textContent).toContain(translate('vorgang.invoicesSummaryCount'));
    expect(summary?.textContent).toContain('1');
    expect(summary?.textContent).toContain(translate('vorgang.invoicesSummaryOpen'));
    expect(summary?.textContent).toContain(formatPaymentCurrency(expected.openTotal));
    expect(summary?.textContent).toContain(translate('vorgang.invoicesSummaryPaid'));
    expect(summary?.textContent).toContain(formatPaymentCurrency(expected.paidTotal));

    expect(container.textContent).toContain('2026-0100');
    expect(container.textContent).toContain(translate('invoice.open'));
    expect(container.textContent).toContain(translate('payment.recordShort'));
    expect(container.querySelector('[data-testid="vorgang-invoices-empty"]')).toBeNull();
    expect(container.querySelectorAll('[data-testid="vorgang-prepare-invoice"]')).toHaveLength(1);

    act(() => root.unmount());
  });

  it('zeigt ruhigen Draft-Hinweis ohne neues Gate und bestätigt den Draft nicht', () => {
    seedVorgang();
    const created = createOrderAmendmentDraft('v-b3b1', { title: 'Offener Entwurf' });
    expect(created.success).toBe(true);
    if (!created.success) return;
    expect(
      addOrderAmendmentDraftPosition('v-b3b1', created.amendment.id, {
        changeType: 'add',
        description: 'Zusatz',
        quantity: 1,
        unit: 'Stück',
        unitPrice: 10,
      }).success,
    ).toBe(true);

    const beforePositions = getVorgangById('v-b3b1')!.orderPositions.map((p) => p.id);
    const confirmSpy = vi.spyOn(confirmOrchestrator, 'confirmOrderAmendmentWithCloud');
    const buildSpy = vi.spyOn(invoiceService, 'buildRechnungDraft');
    root = renderPage(container);
    openInvoicesSection(container);

    expect(container.querySelector('[data-testid="vorgang-invoices-open-draft-hint"]')).not.toBeNull();
    expect(container.textContent).toContain(translate('vorgang.invoicesOpenDraftHint'));
    expect(container.querySelector('[data-testid="vorgang-prepare-invoice"]')).not.toBeNull();
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(buildSpy).not.toHaveBeenCalled();
    expect(getVorgangById('v-b3b1')!.orderAmendments?.[0]?.id).toBe(created.amendment.id);
    expect(getVorgangById('v-b3b1')!.orderPositions.map((p) => p.id)).toEqual(beforePositions);

    act(() => root.unmount());
  });

  it('zeigt bei bestätigtem Nachtrag keinen Draft-Hinweis und keine Sonder-CTA', () => {
    seedVorgang({
      orderAmendments: [],
      confirmedOrderAmendments: [confirmedAmendment('oam-b3b1')],
      orderPositions: [
        createOrderPosition({
          id: 'op-test-1',
          description: 'Montage Heizkörper',
          plannedQuantity: 10,
          unit: 'Stunden',
          unitPrice: 65,
        }),
        createOrderPosition({
          id: 'op-amendment-b3b1-1',
          description: 'Zusatz',
          plannedQuantity: 1,
          unit: 'Stück',
          unitPrice: 20,
        }),
      ],
    });
    root = renderPage(container);
    openInvoicesSection(container);

    expect(container.querySelector('[data-testid="vorgang-invoices-open-draft-hint"]')).toBeNull();
    expect(container.querySelectorAll('[data-testid="vorgang-prepare-invoice"]')).toHaveLength(1);
    expect(
      (container.querySelector('[data-testid="vorgang-prepare-invoice"]') as HTMLAnchorElement).href,
    ).toContain('/vorgaenge/v-b3b1/rechnung?type=rechnung');

    act(() => root.unmount());
  });
});
