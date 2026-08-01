import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { AppProvider } from './context/AppContext';
import { DEFAULT_SETUP } from './data/mockData';
import { VorgangOrderAmendmentPanel } from './components/vorgang/VorgangOrderAmendmentPanel';
import { VorgangDetailPage } from './pages/VorgangDetailPage';
import { t, type TranslationKey } from './i18n';
import * as orderAmendmentService from './services/orderAmendmentService';
import {
  addOrderAmendmentDraftPosition,
  createOrderAmendmentDraft,
} from './services/orderAmendmentService';
import {
  applyConfirmedOrderAmendmentLocally,
} from './services/orderAmendment/orderAmendmentLocalApplyService';
import * as confirmOrchestrator from './services/orderAmendment/orderAmendmentCloudConfirmOrchestrator';
import {
  resetOrderAmendmentConfirmIntentsForTests,
  seedOrderAmendmentConfirmIntentForTests,
  updateOrderAmendmentConfirmIntentState,
} from './services/orderAmendment/orderAmendmentConfirmIntentService';
import { getVorgangById, hydrateVorgangStore } from './services/vorgangService';
import { createOrderPosition, createTestVorgang } from './test/fixtures';
import type {
  ConfirmedOrderAmendment,
  ContractConfirmationSnapshot,
  OrderAmendment,
  Vorgang,
} from './types/models';

function translate(key: TranslationKey): string {
  return t(key, 'de');
}

function snapshot(): ContractConfirmationSnapshot {
  return {
    id: 'snapshot-ux-1',
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

function seedConfirmed(extras: Partial<Vorgang> = {}) {
  hydrateVorgangStore([
    createTestVorgang({
      id: 'v-ux-1',
      status: 'beauftragt',
      contractConfirmation: snapshot(),
      orderPositions: [createOrderPosition({ id: 'op-test-1', description: 'Montage Heizkörper' })],
      ...extras,
    }),
  ]);
  return getVorgangById('v-ux-1')!;
}

function seedDraft(title = 'UI Nachtrag') {
  seedConfirmed();
  const created = createOrderAmendmentDraft('v-ux-1', { title });
  expect(created.success).toBe(true);
  if (!created.success) throw new Error('draft failed');
  expect(
    addOrderAmendmentDraftPosition('v-ux-1', created.amendment.id, {
      changeType: 'add',
      description: 'Zusatz',
      quantity: 2,
      unit: 'Stück',
      unitPrice: 25,
    }).success,
  ).toBe(true);
  return created.amendment.id;
}

function confirmed(clientAmendmentId: string, sequenceNo = 1): ConfirmedOrderAmendment {
  return {
    cloudId: `cloud-ux-${sequenceNo}`,
    clientAmendmentId,
    vorgangId: 'v-ux-1',
    sequenceNo,
    status: 'bestaetigt',
    title: `Bestätigter Nachtrag ${sequenceNo}`,
    reason: 'Mehrbedarf',
    positions: [
      {
        id: `op-amendment-ux-${sequenceNo}`,
        changeType: sequenceNo === 2 ? 'quantity_increase' : 'add',
        description: sequenceNo === 2 ? 'Mehr Stunden' : 'Zusatz',
        plannedQuantity: 1,
        unit: 'Stück',
        unitPrice: 10,
        parentPositionId: sequenceNo === 2 ? 'op-test-1' : undefined,
      },
    ],
    contentFingerprint: `fp-${sequenceNo}`,
    confirmedAt: `2026-07-24T1${sequenceNo}:00:00.000Z`,
    confirmedBy: 'user-ux',
    rowVersion: 1,
    createdAt: `2026-07-24T1${sequenceNo}:00:00.000Z`,
    updatedAt: `2026-07-24T1${sequenceNo}:00:00.000Z`,
  };
}

function renderPage(container: HTMLDivElement, vorgangId = 'v-ux-1'): Root {
  const root = createRoot(container);
  act(() => {
    root.render(
      createElement(
        MemoryRouter,
        { initialEntries: [`/vorgaenge/${vorgangId}`] },
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

function renderPanel(container: HTMLDivElement): { root: Root; rerender: () => void } {
  const root = createRoot(container);
  const rerender = () => {
    root.render(
      createElement(VorgangOrderAmendmentPanel, {
        vorgang: getVorgangById('v-ux-1')!,
        translate,
        onUpdated: rerender,
        onToast: vi.fn(),
      }),
    );
  };
  act(rerender);
  return { root, rerender };
}

describe('ORDER-AMENDMENT-UI-UX-01B1', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {    resetOrderAmendmentConfirmIntentsForTests();
    vi.restoreAllMocks();
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  it('zeigt vier Segmente und startet in Übersicht', () => {
    seedConfirmed();
    root = renderPage(container);

    expect(container.querySelector('[data-testid="vorgang-section-nav"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="vorgang-section-tab-overview"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="vorgang-section-tab-order"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="vorgang-section-tab-amendments"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="vorgang-section-tab-invoices"]')).not.toBeNull();

    expect(
      container.querySelector('[data-testid="vorgang-section-tab-overview"]')?.getAttribute('aria-selected'),
    ).toBe('true');
    expect(container.querySelector('[data-testid="vorgang-section-panel-overview"]')?.hidden).toBe(
      false,
    );
    expect(container.querySelector('[data-testid="vorgang-section-panel-amendments"]')?.hidden).toBe(
      true,
    );
    expect(container.querySelector('[data-testid="order-summary-panel"]')).not.toBeNull();

    act(() => root.unmount());
  });

  it('wechselt Segmente ohne Reload und hält Nachtrag außerhalb von Mehr anzeigen', () => {
    seedConfirmed();
    root = renderPage(container);

    const showMoreContent = () =>
      container.querySelector('[data-testid="show-more-content"]');
    expect(showMoreContent()).toBeNull();

    const amendmentInShowMore = () =>
      showMoreContent()?.querySelector('[data-testid="vorgang-order-amendment-panel"]');

    act(() => {
      (
        container.querySelector(
          '[data-testid="vorgang-section-tab-amendments"]',
        ) as HTMLButtonElement
      ).click();
    });
    expect(
      container.querySelector('[data-testid="vorgang-section-panel-amendments"]')?.hidden,
    ).toBe(false);
    expect(container.querySelector('[data-testid="vorgang-order-amendment-panel"]')).not.toBeNull();
    expect(amendmentInShowMore()).toBeUndefined();

    act(() => {
      (
        container.querySelector('[data-testid="vorgang-section-tab-order"]') as HTMLButtonElement
      ).click();
    });
    expect(container.querySelector('[data-testid="vorgang-section-panel-order"]')?.hidden).toBe(
      false,
    );

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

    act(() => {
      (container.querySelector('[data-testid="show-more-toggle"]') as HTMLButtonElement).click();
    });
    expect(container.querySelector('[data-testid="vorgang-ai-panel"]')).not.toBeNull();
    expect(container.textContent).toContain(translate('vorgang.documents'));

    act(() => root.unmount());
  });

  it('zeigt leeren Nachtragszustand und Hinweis ohne Auftragsbestätigung', () => {
    seedConfirmed();
    const emptyHtml = renderToStaticMarkup(
      createElement(VorgangOrderAmendmentPanel, {
        vorgang: getVorgangById('v-ux-1')!,
        translate,
        onUpdated: vi.fn(),
        onToast: vi.fn(),
      }),
    );
    expect(emptyHtml).toContain('data-testid="order-amendment-empty"');
    expect(emptyHtml).toContain(translate('orderAmendment.emptyBody'));
    expect(emptyHtml).toContain(translate('orderAmendment.prepare'));
    expect(emptyHtml).not.toMatch(/clientAmendmentId|contentFingerprint|outcome_unknown/);

    hydrateVorgangStore([createTestVorgang({ id: 'v-open', status: 'eingegangen' })]);
    const openHtml = renderToStaticMarkup(
      createElement(VorgangOrderAmendmentPanel, {
        vorgang: getVorgangById('v-open')!,
        translate,
        onUpdated: vi.fn(),
        onToast: vi.fn(),
      }),
    );
    expect(openHtml).toContain('data-testid="order-amendment-unavailable"');
    expect(openHtml).toContain(translate('orderAmendment.requiresConfirmation'));
  });

  it('stellt Entwurf mit Badge, Summe und Aktionshierarchie dar', () => {
    seedDraft();
    const html = renderToStaticMarkup(
      createElement(VorgangOrderAmendmentPanel, {
        vorgang: getVorgangById('v-ux-1')!,
        translate,
        onUpdated: vi.fn(),
        onToast: vi.fn(),
      }),
    );
    expect(html).toContain('data-testid="order-amendment-draft-badge"');
    expect(html).toContain(translate('orderAmendment.draftBadge'));
    expect(html).toContain('data-testid="order-amendment-totals"');
    expect(html).toContain('50,00 €');
    expect(html).toContain('data-testid="order-amendment-confirm"');
    expect(html).toContain('data-testid="order-amendment-edit-draft"');
    expect(html).toContain('data-testid="order-amendment-add-position"');
    expect(html).toContain('data-testid="order-amendment-delete-draft"');
    expect(html).toContain(translate('orderAmendment.changeType.add'));
  });

  it('übersetzt Bestätigungszustände und nutzt aria-live', () => {
    const draftId = seedDraft();
    const now = '2026-07-24T12:00:00.000Z';
    seedOrderAmendmentConfirmIntentForTests({
      workspaceId: 'ws-test',
      vorgangId: 'v-ux-1',
      draftId,
      clientAmendmentId: 'oam-ux-1',
      contentFingerprint: 'fp',
      rpcInput: {
        title: 'UI Nachtrag',
        positions: [],
      },
      state: 'outcome_unknown',
      createdAt: now,
      updatedAt: now,
    });

    let html = renderToStaticMarkup(
      createElement(VorgangOrderAmendmentPanel, {
        vorgang: getVorgangById('v-ux-1')!,
        translate,
        onUpdated: vi.fn(),
        onToast: vi.fn(),
      }),
    );
    expect(html).toContain('data-testid="order-amendment-status-banner"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain(translate('orderAmendment.status.outcomeUnknownTitle'));
    expect(html).toContain(translate('orderAmendment.status.retryCheck'));
    expect(html).not.toContain('outcome_unknown');
    expect(html).not.toContain('local_apply_pending');

    updateOrderAmendmentConfirmIntentState('v-ux-1', draftId, 'local_apply_pending');
    html = renderToStaticMarkup(
      createElement(VorgangOrderAmendmentPanel, {
        vorgang: getVorgangById('v-ux-1')!,
        translate,
        onUpdated: vi.fn(),
        onToast: vi.fn(),
      }),
    );
    expect(html).toContain(translate('orderAmendment.status.localApplyTitle'));
    expect(html).toContain(translate('orderAmendment.status.retryLocalApply'));
  });

  it('zeigt bestätigte Nachträge kompakt, sortiert und aufklappbar ohne technische IDs', () => {
    seedConfirmed({
      confirmedOrderAmendments: [confirmed('oam-2', 2), confirmed('oam-1', 1)],
      orderAmendments: [],
    });
    ({ root } = renderPanel(container));

    const items = Array.from(
      container.querySelectorAll('[data-testid^="order-amendment-confirmed-"]'),
    ).filter((node) => /^order-amendment-confirmed-\d+$/.test(node.getAttribute('data-testid') ?? ''));
    expect(items.map((node) => node.getAttribute('data-testid'))).toEqual([
      'order-amendment-confirmed-1',
      'order-amendment-confirmed-2',
    ]);
    expect(container.textContent).toContain('Nachtrag 1');
    expect(container.textContent).toContain('Nachtrag 2');
    expect(container.textContent).not.toContain('cloud-ux-1');
    expect(container.textContent).not.toContain('oam-1');
    expect(container.textContent).not.toContain('contentFingerprint');
    expect(container.querySelector('[data-testid="order-amendment-edit-draft"]')).toBeNull();
    expect(container.querySelector('[data-testid="order-amendment-delete-draft"]')).toBeNull();

    const toggle = container.querySelector(
      '[data-testid="order-amendment-confirmed-toggle-2"]',
    ) as HTMLButtonElement;
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    const controlsId = toggle.getAttribute('aria-controls');
    expect(controlsId).toBeTruthy();

    act(() => {
      toggle.click();
    });
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    const details = container.querySelector(
      '[data-testid="order-amendment-confirmed-details-2"]',
    );
    expect(details).not.toBeNull();
    expect(details?.id).toBe(controlsId);
    expect(container.textContent).toContain(translate('orderAmendment.changeType.quantity_increase'));
    expect(container.textContent).toContain('Bezug: Montage Heizkörper');
    expect(container.textContent).not.toContain('op-test-1');

    act(() => {
      toggle.click();
    });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(
      container.querySelector('[data-testid="order-amendment-confirmed-details-2"]'),
    ).toBeNull();
    expect(container.querySelector('[data-testid="order-amendment-edit-draft"]')).toBeNull();
    expect(container.querySelector('[data-testid="order-amendment-delete-draft"]')).toBeNull();

    act(() => root.unmount());
  });

  async function flushFrame() {
    await act(async () => {
      await new Promise<void>((resolve) => {
        queueMicrotask(() => {
          window.requestAnimationFrame(() => resolve());
        });
      });
    });
  }

  it('Escape schließt Verwerfen-Dialog ohne Delete und stellt Fokus wieder her', async () => {
    seedDraft();
    const deleteSpy = vi.spyOn(orderAmendmentService, 'deleteOrderAmendmentDraft');
    ({ root } = renderPanel(container));

    const trigger = container.querySelector(
      '[data-testid="order-amendment-delete-draft"]',
    ) as HTMLButtonElement;
    await act(async () => {
      trigger.focus();
      trigger.click();
    });
    await flushFrame();
    expect(container.querySelector('[data-testid="order-amendment-discard-dialog"]')).not.toBeNull();
    expect(document.activeElement).toBe(
      container.querySelector('[data-testid="order-amendment-discard-cancel"]'),
    );

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    await flushFrame();
    expect(container.querySelector('[data-testid="order-amendment-discard-dialog"]')).toBeNull();
    expect(deleteSpy).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(
      container.querySelector('[data-testid="order-amendment-delete-draft"]'),
    );

    act(() => root.unmount());
  });

  it('Abbrechen schließt Verwerfen-Dialog mit Fokus-Restore ohne Delete', async () => {
    seedDraft();
    const deleteSpy = vi.spyOn(orderAmendmentService, 'deleteOrderAmendmentDraft');
    ({ root } = renderPanel(container));

    const trigger = container.querySelector(
      '[data-testid="order-amendment-delete-draft"]',
    ) as HTMLButtonElement;
    await act(async () => {
      trigger.focus();
      trigger.click();
    });
    await flushFrame();
    expect(
      container.querySelector('[data-testid="order-amendment-discard-dialog"]'),
    ).not.toBeNull();
    expect(document.activeElement).toBe(
      container.querySelector('[data-testid="order-amendment-discard-cancel"]'),
    );

    await act(async () => {
      (
        container.querySelector(
          '[data-testid="order-amendment-discard-cancel"]',
        ) as HTMLButtonElement
      ).click();
    });
    await flushFrame();
    expect(container.querySelector('[data-testid="order-amendment-discard-dialog"]')).toBeNull();
    expect(deleteSpy).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(
      container.querySelector('[data-testid="order-amendment-delete-draft"]'),
    );

    act(() => root.unmount());
  });

  it('verhindert Mehrfachklick auf Verwerfen-Confirm während laufendem Delete', async () => {
    seedDraft();
    let resolveDelete!: (
      value: ReturnType<typeof orderAmendmentService.deleteOrderAmendmentDraft>,
    ) => void;
    const deleteSpy = vi
      .spyOn(orderAmendmentService, 'deleteOrderAmendmentDraft')
      .mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveDelete = resolve;
          }) as unknown as ReturnType<typeof orderAmendmentService.deleteOrderAmendmentDraft>,
      );

    ({ root } = renderPanel(container));
    act(() => {
      (
        container.querySelector('[data-testid="order-amendment-delete-draft"]') as HTMLButtonElement
      ).click();
    });

    const confirmBtn = () =>
      container.querySelector(
        '[data-testid="order-amendment-discard-confirm"]',
      ) as HTMLButtonElement;

    await act(async () => {
      confirmBtn().click();
    });
    expect(deleteSpy).toHaveBeenCalledTimes(1);
    expect(confirmBtn().disabled).toBe(true);
    expect(confirmBtn().getAttribute('aria-busy')).toBe('true');

    await act(async () => {
      confirmBtn().click();
    });
    expect(deleteSpy).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveDelete({
        success: true,
        vorgang: {
          ...getVorgangById('v-ux-1')!,
          orderAmendments: [],
        },
      });
      await Promise.resolve();
    });
    expect(deleteSpy).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-testid="order-amendment-discard-dialog"]')).toBeNull();

    act(() => root.unmount());
  });

  it('lässt Verwerfen-Dialog bei Delete-Fehler geöffnet und erlaubt erneuten Versuch', async () => {
    seedDraft();
    const deleteSpy = vi
      .spyOn(orderAmendmentService, 'deleteOrderAmendmentDraft')
      .mockReturnValue({
        success: false,
        errorKey: 'order_amendment_not_found',
      });

    ({ root } = renderPanel(container));
    act(() => {
      (
        container.querySelector('[data-testid="order-amendment-delete-draft"]') as HTMLButtonElement
      ).click();
    });

    await act(async () => {
      (
        container.querySelector(
          '[data-testid="order-amendment-discard-confirm"]',
        ) as HTMLButtonElement
      ).click();
    });

    expect(container.querySelector('[data-testid="order-amendment-discard-dialog"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="simple-confirm-error"]')?.textContent).toContain(
      translate('orderAmendment.discardFailed'),
    );
    expect(container.textContent).not.toContain('order_amendment_not_found');
    expect(container.querySelector('[data-testid="order-amendment-draft-card"]')).not.toBeNull();
    expect(
      (container.querySelector(
        '[data-testid="order-amendment-discard-confirm"]',
      ) as HTMLButtonElement).disabled,
    ).toBe(false);

    deleteSpy.mockReturnValue({
      success: true,
      vorgang: {
        ...getVorgangById('v-ux-1')!,
        orderAmendments: [],
      },
    });

    await act(async () => {
      (
        container.querySelector(
          '[data-testid="order-amendment-discard-confirm"]',
        ) as HTMLButtonElement
      ).click();
    });
    expect(container.querySelector('[data-testid="order-amendment-discard-dialog"]')).toBeNull();
    expect(deleteSpy).toHaveBeenCalledTimes(2);

    act(() => root.unmount());
  });

  it('öffnet Verwerfen-Dialog und löscht erst nach Bestätigung', async () => {
    const draftId = seedDraft();
    const deleteSpy = vi.spyOn(orderAmendmentService, 'deleteOrderAmendmentDraft');
    ({ root } = renderPanel(container));

    act(() => {
      (
        container.querySelector('[data-testid="order-amendment-delete-draft"]') as HTMLButtonElement
      ).click();
    });
    expect(container.querySelector('[data-testid="order-amendment-discard-dialog"]')).not.toBeNull();
    expect(getVorgangById('v-ux-1')!.orderAmendments?.[0]?.id).toBe(draftId);

    act(() => {
      (
        container.querySelector('[data-testid="order-amendment-discard-cancel"]') as HTMLButtonElement
      ).click();
    });
    expect(container.querySelector('[data-testid="order-amendment-discard-dialog"]')).toBeNull();
    expect(getVorgangById('v-ux-1')!.orderAmendments?.[0]?.id).toBe(draftId);
    expect(deleteSpy).not.toHaveBeenCalled();

    act(() => {
      (
        container.querySelector('[data-testid="order-amendment-delete-draft"]') as HTMLButtonElement
      ).click();
    });
    await act(async () => {
      (
        container.querySelector(
          '[data-testid="order-amendment-discard-confirm"]',
        ) as HTMLButtonElement
      ).click();
    });
    expect(deleteSpy).toHaveBeenCalledTimes(1);
    expect(getVorgangById('v-ux-1')!.orderAmendments ?? []).toHaveLength(0);

    act(() => root.unmount());
  });

  it('Segment-Tastatur: Pfeile, Home und End mit Fokus und aria-selected', async () => {
    seedConfirmed();
    root = renderPage(container);

    const overview = () =>
      container.querySelector(
        '[data-testid="vorgang-section-tab-overview"]',
      ) as HTMLButtonElement;
    const order = () =>
      container.querySelector('[data-testid="vorgang-section-tab-order"]') as HTMLButtonElement;
    const invoices = () =>
      container.querySelector(
        '[data-testid="vorgang-section-tab-invoices"]',
      ) as HTMLButtonElement;

    expect(overview().getAttribute('aria-selected')).toBe('true');
    expect(overview().tabIndex).toBe(0);
    expect(order().tabIndex).toBe(-1);

    await act(async () => {
      overview().focus();
      overview().dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }),
      );
    });
    await flushFrame();
    expect(order().getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(order());
    expect(order().tabIndex).toBe(0);
    expect(overview().tabIndex).toBe(-1);

    await act(async () => {
      order().dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true }),
      );
    });
    await flushFrame();
    expect(overview().getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(overview());

    await act(async () => {
      overview().dispatchEvent(
        new KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true }),
      );
    });
    await flushFrame();
    expect(invoices().getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(invoices());

    await act(async () => {
      invoices().dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Home', bubbles: true, cancelable: true }),
      );
    });
    await flushFrame();
    expect(overview().getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(overview());

    const selectedTabs = Array.from(
      container.querySelectorAll('[role="tab"][aria-selected="true"]'),
    );
    expect(selectedTabs).toHaveLength(1);
    const focusableTabs = Array.from(container.querySelectorAll('[role="tab"]')).filter(
      (tab) => (tab as HTMLButtonElement).tabIndex === 0,
    );
    expect(focusableTabs).toHaveLength(1);

    act(() => root.unmount());
  });

  it('bewahrt lokalen Editorzustand beim Segmentwechsel', () => {
    seedDraft();
    root = renderPage(container);

    act(() => {
      (
        container.querySelector(
          '[data-testid="vorgang-section-tab-amendments"]',
        ) as HTMLButtonElement
      ).click();
    });

    act(() => {
      (
        container.querySelector('[data-testid="order-amendment-edit-draft"]') as HTMLButtonElement
      ).click();
    });

    const titleInput = () =>
      container.querySelector('[data-testid="order-amendment-title"]') as HTMLInputElement;
    expect(titleInput()).not.toBeNull();

    act(() => {
      const input = titleInput();
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(input, 'Ungespeicherter Titel');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(titleInput().value).toBe('Ungespeicherter Titel');

    act(() => {
      (
        container.querySelector('[data-testid="vorgang-section-tab-order"]') as HTMLButtonElement
      ).click();
    });
    expect(container.querySelector('[data-testid="vorgang-section-panel-order"]')?.hidden).toBe(
      false,
    );
    expect(container.querySelector('[data-testid="vorgang-section-panel-amendments"]')?.hidden).toBe(
      true,
    );
    expect(titleInput()).not.toBeNull();
    expect(titleInput().value).toBe('Ungespeicherter Titel');

    act(() => {
      (
        container.querySelector(
          '[data-testid="vorgang-section-tab-amendments"]',
        ) as HTMLButtonElement
      ).click();
    });
    expect(titleInput().value).toBe('Ungespeicherter Titel');

    act(() => root.unmount());
  });

  it('zeigt sicheren Text für unbekannte Positionstypen', () => {
    seedDraft();
    const vorgang = getVorgangById('v-ux-1')!;
    const draft = vorgang.orderAmendments![0]!;
    hydrateVorgangStore([
      {
        ...vorgang,
        orderAmendments: [
          {
            ...draft,
            positions: [
              {
                ...draft.positions[0]!,
                changeType: 'future_type' as typeof draft.positions[0]['changeType'],
              },
            ],
          },
        ],
      },
    ]);

    const html = renderToStaticMarkup(
      createElement(VorgangOrderAmendmentPanel, {
        vorgang: getVorgangById('v-ux-1')!,
        translate,
        onUpdated: vi.fn(),
        onToast: vi.fn(),
      }),
    );
    expect(html).toContain(translate('orderAmendment.changeType.unknown'));
    expect(html).not.toContain('future_type');
    expect(html).not.toContain('orderAmendment.changeType.future_type');
  });

  it('hält Confirm-Pfad unverändert', async () => {
    const draftId = seedDraft();
    ({ root } = renderPanel(container));
    const cloud = vi
      .spyOn(confirmOrchestrator, 'confirmOrderAmendmentWithCloud')
      .mockImplementation(async () => {
        const applied = applyConfirmedOrderAmendmentLocally({
          vorgangId: 'v-ux-1',
          draftId,
          confirmed: confirmed('oam-ux-1'),
        });
        if (!applied.ok) throw new Error('apply failed');
        return {
          ok: true,
          vorgang: applied.vorgang,
          confirmed: confirmed('oam-ux-1'),
          idempotentReplay: false,
        };
      });

    await act(async () => {
      (
        container.querySelector('[data-testid="order-amendment-confirm"]') as HTMLButtonElement
      ).click();
    });
    expect(container.querySelector('[data-testid="order-amendment-confirm-dialog"]')).not.toBeNull();
    expect(cloud).not.toHaveBeenCalled();

    await act(async () => {
      (
        container.querySelector(
          '[data-testid="order-amendment-confirm-dialog-confirm"]',
        ) as HTMLButtonElement
      ).click();
    });
    expect(cloud).toHaveBeenCalledWith('v-ux-1', draftId);
    expect(container.querySelector('[data-testid="order-amendment-confirmed-badge"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="order-amendment-draft-card"]')).toBeNull();

    act(() => root.unmount());
  });
});

describe('ORDER-AMENDMENT-UI-UX-01B1 multi-draft note', () => {
  it('zeigt Hinweis bei zusätzlichen Entwürfen, ohne sie zu löschen', () => {
    seedConfirmed();
    const first = createOrderAmendmentDraft('v-ux-1', { title: 'Erster' });
    expect(first.success).toBe(true);
    if (!first.success) return;
    const vorgang = getVorgangById('v-ux-1')!;
    const second: OrderAmendment = {
      ...first.amendment,
      id: 'draft-extra-2',
      title: 'Zweiter',
      createdAt: '2026-07-24T11:00:00.000Z',
      updatedAt: '2026-07-24T11:00:00.000Z',
    };
    hydrateVorgangStore([
      {
        ...vorgang,
        orderAmendments: [first.amendment, second],
      },
    ]);

    const html = renderToStaticMarkup(
      createElement(VorgangOrderAmendmentPanel, {
        vorgang: getVorgangById('v-ux-1')!,
        translate,
        onUpdated: vi.fn(),
        onToast: vi.fn(),
      }),
    );
    expect(html).toContain('data-testid="order-amendment-extra-drafts"');
    expect(getVorgangById('v-ux-1')!.orderAmendments).toHaveLength(2);
  });
});
